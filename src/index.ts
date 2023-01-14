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

const BASE_PATH_LENGTH = basePath().length + 1; // +1 for the slash

export default class DownloadQueue {
  private domain: string;
  private specs: Spec[];
  private tasks: DownloadTask[];
  private inited;
  private kvfs: KeyValueFileSystem;

  constructor(domain = "main") {
    this.domain = domain;
    this.specs = [];
    this.tasks = [];
    this.inited = false;
    this.kvfs = new KeyValueFileSystem(AsyncStorage);
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
      this.kvfs.readMulti<Spec>(`/${this.domain}/*`),
      checkForExistingDownloads(),
      RNFS.readdir(`${basePath()}/${this.domain}`),
    ]);
    const specIds = specData.map(spec => spec.path.slice(BASE_PATH_LENGTH));

    this.specs = specData.map(spec => spec.value as Spec);
    console.log("Spec Ids loaded", specIds);

    // First revive tasks that were working in the background
    existingTasks.forEach(task => {
      if (specIds.includes(task.id)) {
        console.log("Found existing task", task.id);
        this.addTask(task);
      } else {
        console.log(
          "Found existing task not in saved specs -- stoping download",
          task.id
        );
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
      console.log(
        `Found ${specsToDownload.length} specs that need to be downloaded`
      );

      specsToDownload.forEach(spec => this.start(spec));
    }

    // Finally, delete any files that don't have a spec
    const orphanedFiles = dirFilenames.filter(
      filename => !this.specs.some(spec => spec.id === filename)
    );
    if (orphanedFiles.length) {
      console.log("Deleting orphaned files", orphanedFiles);
      await Promise.all(
        orphanedFiles.map(filename => RNFS.unlink(this.pathFromId(filename)))
      );
    }

    this.inited = true;
  }

  async addUrl(url: string): Promise<void> {
    this.verifyInitialized();

    if (this.specs.some(spec => spec.url === url)) {
      console.log("Already downloading url, so ignoring add:", url);
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
    await this.kvfs.write(`/${this.domain}/${id}`, spec);
    this.start(spec);
    this.specs.push(spec);
  }

  async removeUrl(url: string): Promise<void> {
    this.verifyInitialized();

    const index = this.specs.findIndex(spec => spec.url === url);

    if (index < 0) {
      console.log("Url to remove already not in list", url);
      return;
    }

    const spec = this.specs[index];

    try {
      const task = this.removeTask(spec.id);

      if (task) {
        console.log("Stopping download", spec.id);
        task.stop();
      }

      // Run serially because we definitely want to delete the spec from
      // storae, but unlink could (acceptably) throw if the file doesn't exist.
      await this.kvfs.rm(`/${this.domain}/${spec.id}`);
      await RNFS.unlink(spec.path);
    } finally {
      this.specs.splice(index, 1);
    }
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
    console.log("Starting download", spec);
    const task = download({
      id: spec.id,
      url: spec.url,
      destination: spec.path,
    });

    this.addTask(task);
  }

  private addTask(task: DownloadTask) {
    task
      .begin(data => {
        console.log(`Live going to download ${data.expectedBytes} bytes!`);
      })
      .progress(percent => {
        console.log(`Live downloaded: ${percent * 100}%`);
      })
      .done(() => {
        console.log("Live download is done!");
        this.removeTask(task.id);
      })
      .error(error => {
        console.log("Live download canceled due to error: ", error);
        this.removeTask(task.id);
      });
    this.tasks.push(task);
  }

  private pathFromId(id: string) {
    return `${basePath()}/${this.domain}/${id}`;
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
