import AsyncStorage from "@react-native-async-storage/async-storage";
import KeyValueFileSystem from "key-value-file-system";
import { Platform } from "react-native";
import {
  checkForExistingDownloads,
  completeHandler,
  download,
  DownloadTask,
} from "react-native-background-downloader";
import RNFS from "react-native-fs";
import uuid from "react-uuid";

interface Spec {
  id: string;
  url: string;
  path: string;
  /**
   * Creation time in timestamp millis. Zero if spec should be deleted on next
   * launch. If negative, the absolute value is the time it should be deleted.
   */
  createTime: number;
}

function basePath() {
  return `${RNFS.DocumentDirectoryPath}/DownloadQueue`;
}

export interface DownloadQueueHandlers {
  onBegin?: (url: string, totalBytes: number) => void;
  onProgress?: (
    url: string,
    fractionWritten: number,
    bytesWritten: number,
    totalBytes: number
  ) => void;
  onDone?: (url: string) => void;
  onError?: (url: string, error: any) => void;
}

export default class DownloadQueue {
  private domain: string;
  private specs: Spec[];
  private tasks: DownloadTask[];
  private inited;
  private kvfs: KeyValueFileSystem;
  private handlers?: DownloadQueueHandlers;
  private active: boolean;

  /**
   * Creates a new instance of DownloadQueue. You must call init after this,
   * before calling any other functions.
   *
   * @param handlers (optional) Callbacks for events
   * @param domain (optional) By default, AsyncStorage keys and RNFS
   *      filenames are prefixed with "DownloadQueue/main". If you want to use
   *      something other than "main", pass it here. This is commonly used to
   *      manage different queues for different users (e.g. you can use userId
   *      as the domain).
   */
  constructor(handlers?: DownloadQueueHandlers, domain = "main") {
    this.domain = domain;
    this.specs = [];
    this.tasks = [];
    this.inited = false;
    this.kvfs = new KeyValueFileSystem(AsyncStorage, "DownloadQueue");
    this.handlers = handlers;
    this.active = false;
  }

  /**
   * Reconstitutes state from storage and reconciles it with downloads that
   * might have completed in the background. Always call this before using the
   * rest of the class.
   *
   * @param startActive Whether to start the queue in an active state where
   * downloads will be started. If false, no downloads will begin until you
   * call resumeAll().
   */
  async init(startActive = true): Promise<void> {
    if (this.inited) {
      throw new Error("DownloadQueue already initialized");
    }

    const [specData, existingTasks, dirFilenames] = await Promise.all([
      this.kvfs.readMulti<Spec>(`${this.keyFromId("")}*`),
      checkForExistingDownloads(),
      this.getDirFilenames(),
    ]);
    const now = Date.now();
    const loadedSpecs = specData.map(spec => spec.value as Spec);
    const deletes = loadedSpecs.filter(
      spec =>
        spec.createTime === 0 ||
        (spec.createTime < 0 && -spec.createTime <= now)
    );
    const deleteIds = new Set(deletes.map(spec => spec.id));

    // Process deletions before all other things. Simplifies logic around all
    // the logic below (e.g. tasks to revive/etc) if deletions have happened
    // already.
    await Promise.all(
      deletes.map(spec => this.kvfs.rm(this.keyFromId(spec.id)))
    );

    this.specs = loadedSpecs.filter(spec => !deleteIds.has(spec.id));
    this.active = startActive;

    // First revive tasks that were working in the background
    existingTasks.forEach(task => {
      const spec = this.specs.find(spec => spec.id === task.id);
      if (spec) {
        this.addTask(spec.url, task);
        if (this.active) {
          task.resume(); // Assuming checkForExistingDownloads() hasn't already
        } else {
          task.pause();
        }
      } else {
        task.stop();
      }
    });

    // Now start downloads for specs that don't have a task or a file already
    const specsToDownload = this.specs.filter(
      spec =>
        !existingTasks.some(task => task.id === spec.id) &&
        !dirFilenames.includes(spec.id)
    );
    if (specsToDownload.length) {
      specsToDownload.forEach(spec => this.start(spec));
    }

    // Delete any files that don't have a spec
    const orphanedFiles = dirFilenames.filter(
      filename => !this.specs.some(spec => spec.id === filename)
    );
    if (orphanedFiles.length) {
      await Promise.all(
        orphanedFiles.map(filename => RNFS.unlink(this.pathFromId(filename)))
      );
    }

    this.scheduleDeletions(
      this.specs.filter(spec => -spec.createTime > now),
      now
    );

    this.inited = true;
  }

  /**
   * Terminates all pending downloads and stops all activity, including
   * processing lazy-deletes. You can re-init() if you'd like -- but in most
   * cases where you plan to re-init, pause() might be what you really meant.
   */
  terminate(): void {
    this.active = false;
    this.tasks.forEach(task => void task.stop());
    this.tasks = [];
    this.specs = [];
    this.handlers = undefined;
    this.inited = false;
  }

  /**
   * Downloads a url to the local documents directory. Safe to call if it's
   * already been added before. If it's been lazy-deleted, it'll be revived.
   *
   * @param url Remote url to download
   */
  async addUrl(url: string): Promise<void> {
    this.verifyInitialized();

    const curSpec = this.specs.find(spec => spec.url === url);
    if (curSpec) {
      // Revive lazy-deletion cases
      if (curSpec.createTime <= 0) {
        curSpec.createTime = Date.now();

        const [fileExists] = await Promise.all([
          RNFS.exists(this.pathFromId(curSpec.id)),
          this.kvfs.write(this.keyFromId(curSpec.id), curSpec),
        ]);
        if (!fileExists) {
          this.start(curSpec);
        }
      }
      return;
    }

    const id = uuid();
    const spec: Spec = {
      id,
      url,
      path: this.pathFromId(id),
      createTime: Date.now(),
    };

    // Do this first, before starting the download, so that we don't leave any
    // orphans (e.g. if we start a download first but then error on writing the
    // spec).
    await this.kvfs.write(this.keyFromId(id), spec);
    this.specs.push(spec);
    this.start(spec);
  }

  /**
   * Removes a url record and any associated file that's been downloaded. Can
   * optionally be a lazy delete.
   *
   * @param url Url to remove, including the downloaded file associated with it
   * @param deleteTime (optional) The timestamp beyond which the file associated
   * with the url should be deleted, or zero if it should be deleted the next
   * time DownloadQueue is initialized. The record of the url, in the meantime,
   * won't be acknowledged via DownloadQueue's API.
   */
  async removeUrl(url: string, deleteTime = -1): Promise<void> {
    this.verifyInitialized();

    return await this.removeUrlInternal(url, deleteTime);
  }

  private async removeUrlInternal(
    url: string,
    deleteTime: number,
    scheduleDeletion = true
  ): Promise<void> {
    const index = this.specs.findIndex(spec => spec.url === url);

    if (index < 0) {
      return;
    }

    const spec = this.specs[index];
    const task = this.removeTask(spec.id);

    if (task) {
      task.stop();
    }

    // If it's a lazy delete, just update the spec but don't mess with files.
    if (deleteTime >= 0) {
      spec.createTime = -deleteTime; // Negative zero also ok for us.
      await this.kvfs.write(this.keyFromId(spec.id), spec);
      if (scheduleDeletion && deleteTime > 0) {
        this.scheduleDeletions([spec], Date.now());
      }
    } else {
      // Run serially because we definitely want to delete the spec from
      // storage, but unlink could (acceptably) throw if the file doesn't exist.
      await this.kvfs.rm(this.keyFromId(spec.id));
      this.specs.splice(index, 1);

      try {
        await RNFS.unlink(spec.path);
      } catch {
        // Expected for missing files
      }
    }
  }

  /**
   * Sets the sum total of urls to keep in the queue. If previously-added urls
   * don't show up here, they'll be removed. New urls will be added.
   *
   * @param deleteTime (optional) The timestamp beyond which files associated
   * with removed urls should be deleted, or zero if they should be deleted the
   * next time DownloadQueue is initialized. The record of those urls, in the
   * meantime, won't be acknowledged via DownloadQueue's API.
   */
  async setQueue(urls: string[], deleteTime = -1): Promise<void> {
    this.verifyInitialized();

    const urlSet = new Set(urls);
    const liveUrls = new Set(
      this.specs.filter(spec => spec.createTime > 0).map(spec => spec.url)
    );
    const urlsToAdd = urls.filter(url => !liveUrls.has(url));
    const specsToRemove = this.specs.filter(spec => !urlSet.has(spec.url));
    const urlsToRemove = specsToRemove.map(spec => spec.url);

    // We could create logic that's more efficient than this (e.g. by bundling
    // bulk operations on this.kvfs/etc), but it requires that we keep the lazy-
    // delete logic consistent with add/removeUrl. The risk of bugs is not worth
    // the performance boost if you assume most people aren't massively churning
    // their queues.
    for (const url of urlsToRemove) {
      await this.removeUrlInternal(url, deleteTime, false);
    }
    this.scheduleDeletions(specsToRemove, Date.now());
    for (const url of urlsToAdd) {
      await this.addUrl(url);
    }
  }

  /**
   * Pauses all active downloads. Most used to implement wifi-only downloads,
   * by pausing when NetInfo reports a non-wifi connection.
   */
  pauseAll(): void {
    this.verifyInitialized();

    this.active = false;
    this.tasks.forEach(task => void task.pause());
  }

  /**
   * Resumes all active downloads that were previously paused. If you init()
   * with startActive === false, you'll want to call this at some point or else
   * downloads will never happen.
   */
  resumeAll(): void {
    this.verifyInitialized();

    this.active = true;
    this.tasks.forEach(task => void task.resume());
  }

  /**
   * Gets a remote or local url, preferring to the local path when possible. If
   * the local file hasn't yet been downloaded, returns the remote url.
   * @param url The remote URL to check for local availability
   * @returns A local file path if the URL has already been downloaded, else url
   */
  async getAvailableUrl(url: string): Promise<string> {
    this.verifyInitialized();

    const spec = this.specs.find(spec => spec.url === url);

    if (!spec) {
      return url;
    }

    const fileExists = await RNFS.exists(spec.path);
    return fileExists ? spec.path : url;
  }

  private removeTask(id: string): DownloadTask | undefined {
    const taskIndex = this.tasks.findIndex(task => task.id === id);
    let task: DownloadTask | undefined;

    if (taskIndex >= 0) {
      task = this.tasks[taskIndex];
      this.tasks.splice(taskIndex, 1);
    }
    return task;
  }

  private start(spec: Spec) {
    const task = download({
      id: spec.id,
      url: spec.url,
      destination: spec.path,
    });

    this.addTask(spec.url, task);
    if (!this.active) {
      task.pause();
    }
  }

  private addTask(url: string, task: DownloadTask) {
    task
      .begin(data => {
        this.handlers?.onBegin?.(url, data.expectedBytes);
      })
      .progress((percent, bytes, total) => {
        this.handlers?.onProgress?.(url, percent, bytes, total);
      })
      .done(() => {
        this.removeTask(task.id);
        this.handlers?.onDone?.(url);
        if (Platform.OS === "ios") {
          completeHandler(task.id);
        }
      })
      .error(error => {
        this.removeTask(task.id);
        this.handlers?.onError?.(url, error);
      });
    this.tasks.push(task);
  }

  private scheduleDeletions(toDelete: Spec[], basisTimestamp: number) {
    const wakeUpTimes = new Set(
      toDelete.map(spec => roundToNextMinute(-spec.createTime))
    );

    // We chunk the wakeup times into whole minutes in case someone's managing a
    // huge cache of files that all need deletion.
    for (const wakeUpTime of wakeUpTimes) {
      const timeout = wakeUpTime - basisTimestamp;
      setTimeout(() => {
        void this.deleteExpiredSpecs(wakeUpTime);
      }, timeout);
    }
  }

  /**
   * Doesn't handle createTime === 0 cases, which are deleted during init()
   * @param basisTimestamp The timestamp to use as the basis for deletion
   */
  private async deleteExpiredSpecs(basisTimestamp: number) {
    const toDelete = this.specs.filter(
      spec => spec.createTime < 0 && -spec.createTime <= basisTimestamp
    );
    const delIds = new Set(toDelete.map(spec => spec.id));

    await Promise.all(
      toDelete.map(async spec => {
        await this.kvfs.rm(this.keyFromId(spec.id));
        try {
          await RNFS.unlink(spec.path);
        } catch {
          // Expected for missing files
        }
      })
    );
    this.specs = this.specs.filter(spec => !delIds.has(spec.id));
  }

  private async getDirFilenames() {
    try {
      return await RNFS.readdir(`${basePath()}/${this.domain}`);
    } catch {
      // expected error when the directory doesn't exist
    }
    return [];
  }

  private pathFromId(id: string) {
    return `${basePath()}/${this.domain}/${id}`;
  }

  private keyFromId(id: string) {
    return `/${this.domain}/${id}`;
  }

  /**
   * Should be run on every public method
   */
  private verifyInitialized() {
    if (!this.inited) {
      throw new Error("DownloadQueue not initialized");
    }
  }
}

function roundToNextMinute(timestamp: number) {
  return Math.ceil(timestamp / 60000) * 60000;
}