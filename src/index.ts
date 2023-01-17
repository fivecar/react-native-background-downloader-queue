import AsyncStorage from "@react-native-async-storage/async-storage";
import KeyValueFileSystem from "key-value-file-system";
import {
  checkForExistingDownloads,
  download,
  DownloadTask,
} from "react-native-background-downloader";
import RNFS from "react-native-fs";
import uuid from "react-uuid";

interface Spec {
  id: string;
  url: string;
  path: string;
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

  constructor(handlers?: DownloadQueueHandlers, domain = "main") {
    this.domain = domain;
    this.specs = [];
    this.tasks = [];
    this.inited = false;
    this.kvfs = new KeyValueFileSystem(AsyncStorage, "DownloadQueue");
    this.handlers = handlers;
  }

  /**
   * Reconsistutes state from storage and reconciles it with downloads that
   * might have completed in the background. Always call this before using the
   * rest of the class.
   */
  async init(): Promise<void> {
    if (this.inited) {
      throw new Error("DownloadQueue already initialized");
    }

    const [specData, existingTasks, dirFilenames] = await Promise.all([
      this.kvfs.readMulti<Spec>(`${this.keyFromId("")}*`),
      checkForExistingDownloads(),
      RNFS.readdir(`${basePath()}/${this.domain}`),
    ]);

    this.specs = specData.map(spec => spec.value as Spec);

    // First revive tasks that were working in the background
    existingTasks.forEach(task => {
      const spec = this.specs.find(spec => spec.id === task.id);
      if (spec) {
        this.addTask(spec.url, task);
        task.resume(); // Assuming checkForExistingDownloads() hasn't already
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

    // Finally, delete any files that don't have a spec
    const orphanedFiles = dirFilenames.filter(
      filename => !this.specs.some(spec => spec.id === filename)
    );
    if (orphanedFiles.length) {
      await Promise.all(
        orphanedFiles.map(filename => RNFS.unlink(this.pathFromId(filename)))
      );
    }

    this.inited = true;
  }

  async addUrl(url: string): Promise<void> {
    this.verifyInitialized();

    if (this.specs.some(spec => spec.url === url)) {
      return;
    }

    const id = uuid();
    const spec: Spec = {
      id,
      url,
      path: this.pathFromId(id),
    };

    // Do this first, before starting the download, so that we don't leave any
    // orphans (e.g. if we start a download first but then error on writing the
    // spec).
    await this.kvfs.write(this.keyFromId(id), spec);
    this.specs.push(spec);
    this.start(spec);
  }

  async removeUrl(url: string): Promise<void> {
    this.verifyInitialized();

    const index = this.specs.findIndex(spec => spec.url === url);

    if (index < 0) {
      return;
    }

    const spec = this.specs[index];

    try {
      const task = this.removeTask(spec.id);

      if (task) {
        task.stop();
      }

      // Run serially because we definitely want to delete the spec from
      // storage, but unlink could (acceptably) throw if the file doesn't exist.
      await this.kvfs.rm(this.keyFromId(spec.id));
      this.specs.splice(index, 1);

      await RNFS.unlink(spec.path);
    } catch {
      // Expected for missing files
    }
  }

  async setQueue(urls: string[]): Promise<void> {
    this.verifyInitialized();

    const existingUrls = this.specs.map(spec => spec.url);
    const urlsToAdd = urls.filter(url => !existingUrls.includes(url));
    const specsToRemove = this.specs.filter(spec => !urls.includes(spec.url));

    // We could call all the adds and removes serially, but this is faster. It
    // requires that we keep the logic in sync between the individual
    // adds/removes and here.
    if (urlsToAdd.length) {
      const newSpecs = urlsToAdd.map(url => {
        const id = uuid();
        return {
          id,
          url,
          path: this.pathFromId(id),
        };
      });
      await this.kvfs.writeMulti(
        undefined,
        newSpecs.map(spec => ({ path: this.keyFromId(spec.id), value: spec }))
      );
      this.specs.push(...newSpecs);
      newSpecs.forEach(spec => this.start(spec));
    }

    if (specsToRemove.length) {
      specsToRemove.forEach(spec => {
        const task = this.removeTask(spec.id);

        if (task) {
          task.stop();
        }
      });

      await this.kvfs.rmMulti(
        specsToRemove.map(spec => this.keyFromId(spec.id))
      );
      this.specs = this.specs.filter(
        spec => !specsToRemove.some(rem => rem.url === spec.url)
      );

      // Serialize this after the spec removals, intentionally, so that we don't
      // ever remove a file from disk while keeping the spec.
      await Promise.all(
        specsToRemove.map(async spec => {
          try {
            await RNFS.unlink(spec.path);
          } catch {
            // throws expected when file doesn't exist
          }
        })
      );
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
      })
      .error(error => {
        this.removeTask(task.id);
        this.handlers?.onError?.(url, error);
      });
    this.tasks.push(task);
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
