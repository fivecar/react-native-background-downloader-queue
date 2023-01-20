import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addEventListener,
  NetInfoState,
  NetInfoSubscription,
} from "@react-native-community/netinfo";
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
  // `finished` is true iff the download completed (via `done()`). Files can
  // exist at path even during the middle of a download, so you need a separate
  // flag to know you're done. Finally, don't always count on this to tell you
  // that the file still exists on disk; there are times, at least in the
  // simulator, when files on the virtual disk get flushed (e.g. on new build
  // installs).
  finished: boolean;
}

const ERROR_RETRY_DELAY_MS = 60 * 1000;

export interface DownloadQueueStatus {
  url: string;
  path: string; // Path to the file on disk
  complete: boolean;
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

export interface DownloadQueueOptions {
  domain?: string;
  handlers?: DownloadQueueHandlers;
  netInfoAddEventListener?: typeof addEventListener;
  startActive?: boolean;
}

export default class DownloadQueue {
  private domain = "main";
  private specs: Spec[] = [];
  private tasks: DownloadTask[] = [];
  private inited = false;
  private kvfs: KeyValueFileSystem = new KeyValueFileSystem(
    AsyncStorage,
    "DownloadQueue"
  );
  private handlers?: DownloadQueueHandlers = undefined;
  private active = true;
  private erroredIds = new Set<string>();
  private errorTimer: NodeJS.Timeout | null = null;
  private netInfoUnsubscriber?: NetInfoSubscription;
  private isConnected = true;
  private isPausedByUser = false; // Whether the client called pauseAll()

  /**
   * Gets everything started (e.g. reconstitutes state from storage and
   * reconciles it with downloads that might have completed in the background,
   * subscribes to events, etc). You must call this first.
   *
   * @param options (optional) Configuration for the queue
   * @param options.handlers (optional) Callbacks for events
   * @param options.domain (optional) By default, AsyncStorage keys and RNFS
   * filenames are prefixed with "DownloadQueue/main". If you want to use
   * something other than "main", pass it here. This is commonly used to
   * manage different queues for different users (e.g. you can use userId
   * as the domain).
   * @param options.startActive (optional) Whether to start the queue in an
   * active state where downloads will be started. If false, no downloads will
   * begin until you call resumeAll().
   * @param options.netInfoAddEventListener (optional) If you'd like
   * DownloadQueue to pause downloads when the device is offline, pass this.
   * Usually easiest to literally pass `NetInfo.addEventListener`.
   */
  async init({
    domain = "main",
    handlers = undefined,
    netInfoAddEventListener = undefined,
    startActive = true,
  }: DownloadQueueOptions = {}): Promise<void> {
    if (this.inited) {
      throw new Error("DownloadQueue already initialized");
    }

    this.domain = domain;
    this.handlers = handlers;

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

    // Now start downloads for specs that haven't finished
    const specsToDownload = this.specs.filter(
      spec => !existingTasks.some(task => task.id === spec.id) && !spec.finished
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
        orphanedFiles.map(filename => {
          try {
            return RNFS.unlink(this.pathFromId(filename));
          } catch {
            // Ignore errors
          }
        })
      );
    }

    this.scheduleDeletions(
      this.specs.filter(spec => -spec.createTime > now),
      now
    );

    this.isConnected = true; // Assume this until we're told differently.
    this.netInfoUnsubscriber = netInfoAddEventListener?.(state => {
      this.onNetInfoChanged(state);
    });

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
    this.erroredIds.clear();
    if (this.errorTimer) {
      clearInterval(this.errorTimer);
      this.errorTimer = null;
    }
    if (this.netInfoUnsubscriber) {
      this.netInfoUnsubscriber();
      this.netInfoUnsubscriber = undefined;
    }
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
        if (!curSpec.finished || !fileExists) {
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
      finished: false,
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
    const specsToRemove = this.specs.filter(
      spec => !urlSet.has(spec.url) && spec.createTime > 0
    );
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
   * Returns the status of all urls in the queue, excluding urls marked for lazy
   * deletion.
   *
   * @returns urls, paths to local files, and whether the file has been
   *    completely downloaded. If `!complete`, the file may be only partially
   *    downloaded.
   */
  async getQueueStatus(): Promise<DownloadQueueStatus[]> {
    this.verifyInitialized();

    const liveSpecs = this.specs.filter(spec => spec.createTime > 0);

    return await Promise.all(
      liveSpecs.map(async (spec: Spec): Promise<DownloadQueueStatus> => {
        // Not all files on disk are necessarily complete (they could be
        // partially downloaded). So filter by `finished`. But you also can't
        // trust that completely because sometimes the disk files are flushed
        // (e.g. on iOS simulator when installing a new build). So we
        // double-check that the file actually exists.
        const complete = spec.finished && (await RNFS.exists(spec.path));
        return {
          url: spec.url,
          path: spec.path,
          complete,
        };
      })
    );
  }

  /**
   * Pauses all active downloads. Most used to implement wifi-only downloads,
   * by pausing when NetInfo reports a non-wifi connection.
   */
  pauseAll(): void {
    this.verifyInitialized();

    this.isPausedByUser = true;
    this.pauseAllInternal();
  }

  private pauseAllInternal(): void {
    this.active = false;
    this.tasks.forEach(task => void task.pause());

    if (this.errorTimer) {
      clearInterval(this.errorTimer);
      this.errorTimer = null;
    }
  }

  /**
   * Resumes all active downloads that were previously paused. If you init()
   * with startActive === false, you'll want to call this at some point or else
   * downloads will never happen.
   */
  resumeAll(): void {
    this.verifyInitialized();

    this.isPausedByUser = false;
    this.resumeAllInternal();
  }

  private resumeAllInternal() {
    this.active = true;
    this.tasks.forEach(task => void task.resume());

    if (this.erroredIds.size > 0) {
      this.ensureErrorTimerOn();
    }
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

    if (!spec || !spec.finished) {
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

    this.erroredIds.delete(id);
    if (this.erroredIds.size === 0 && this.errorTimer) {
      clearInterval(this.errorTimer);
      this.errorTimer = null;
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
      .done(async () => {
        const spec = this.specs.find(spec => spec.url === url);

        if (!spec) {
          // This in theory shouldn't ever happen -- basically the downloader
          // telling us it's completed the download of a spec we've never heard
          // about. But we're being extra careful here not to crash the client
          // app if this ever happens.
          return;
        }

        this.removeTask(task.id);
        spec.finished = true;
        await this.kvfs.write(this.keyFromId(spec.id), spec);

        if (Platform.OS === "ios") {
          completeHandler(task.id);
        }

        // Only notify the client once everything has completed successfully and
        // our internal state is consistent.
        this.handlers?.onDone?.(url);
      })
      .error(error => {
        this.removeTask(task.id);
        this.handlers?.onError?.(url, error);

        this.erroredIds.add(task.id);
        this.ensureErrorTimerOn();
      });
    this.tasks.push(task);
  }

  private ensureErrorTimerOn() {
    if (!this.errorTimer) {
      this.errorTimer = setInterval(() => {
        this.retryErroredTasks();
      }, ERROR_RETRY_DELAY_MS);
    }
  }

  private retryErroredTasks() {
    this.erroredIds.forEach(id => {
      const task = this.tasks.find(task => task.id === id);
      const spec = this.specs.find(spec => spec.id === id);

      // If we've written our code correctly, spec should always be present
      // if we have an errorId. But we're being extra paranoid here.
      if (!task && spec && !spec.finished && spec.createTime > 0) {
        this.start(spec);
      }
    });
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

  private onNetInfoChanged(state: NetInfoState) {
    if (!!state.isConnected === this.isConnected) {
      return;
    }

    this.isConnected = !!state.isConnected;

    // We only ever pause/resume when the user hasn't themselves explicitly
    // asked us to pause. If they have, we leave their wishes alone.
    if (!this.isPausedByUser) {
      if (this.isConnected) {
        this.resumeAllInternal();
      } else {
        this.pauseAllInternal();
      }
    }
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

function basePath() {
  return `${RNFS.DocumentDirectoryPath}/DownloadQueue`;
}