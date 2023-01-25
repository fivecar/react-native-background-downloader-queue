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
  // `finished` is true iff the download completed (via `done()`). Files can
  // exist at path even during the middle of a download, so you need a separate
  // flag to know you're done. Finally, don't always count on this to tell you
  // that the file still exists on disk; there are times, at least in the
  // simulator, when files on the virtual disk get flushed (e.g. on new build
  // installs).
  finished: boolean;
}

const ERROR_RETRY_DELAY_MS = 60 * 1000;

/**
 * Derived directly from NetInfoState, but we don't want to force you to use
 * that package if you don't want. So we take just the subset of fields we
 * actually use.
 */
export interface DownloadQueueNetInfoState {
  /**
   * NetInfo's isConnected. They insist on accepting the null.
   */
  isConnected: boolean | null;
  /**
   * This should ideally be "unknown" | "none" | "wifi" | "cellular" |
   * "bluetooth" | "ethernet" | "wimax" | "vpn" | "other" | "mixed", to match
   * NetInfoStateType. However, by locking into that right now, this library
   * will break (Typescript-wise) if NetInfo adds new types of connections. So
   * we compromise and just accept "string". You should only use valid values,
   * though, if you want reasonable behavior from this library.
   */
  type: string;
}

export type DownloadQueueNetInfoUnsubscribe = () => void;
/**
 * A strict subset (in types) of NetInfo's addEventListener. Unless you
 * implement your own network detection, you should probably just pass
 * NetInfo.addEventListener.
 */
export type DownloadQueueAddEventListener = (
  listener: (state: DownloadQueueNetInfoState) => void
) => DownloadQueueNetInfoUnsubscribe;

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
  onDone?: (url: string, localPath: string) => void;
  /**
   * This is async because `removeUrl` (and also `setQueue`, when it needs to
   * remove some urls) will block until you return from this, giving you the
   * opportunity in your app to remove any dependencies on the local file before
   * it's deleted.
   */
  onWillRemove?: (url: string) => Promise<void>;
  onError?: (url: string, error: any) => void;
}

/**
 * Optional settings to pass to DownloadQueue.init()
 */
export interface DownloadQueueOptions {
  /**
   * By default, AsyncStorage keys and RNFS filenames are prefixed with
   * "DownloadQueue/main". If you want to use something other than "main", pass
   * it here. This is commonly used to manage different queues for different
   * users (e.g. you can use userId as the domain).
   */
  domain?: string;
  /**
   * Callbacks for events related to ongoing downloads
   */
  handlers?: DownloadQueueHandlers;
  /**
   * If you'd like DownloadQueue to pause downloads when the device is offline,
   * pass this. Usually easiest to literally pass `NetInfo.addEventListener`.
   */
  netInfoAddEventListener?: DownloadQueueAddEventListener;
  /**
   * Callback that gets the current network state. If you pass
   * `netInfoAddEventListener`, you must pass this as well. The easiest thing
   * is usually to pass `NetInfo.fetch`.
   */
  netInfoFetchState?: () => Promise<DownloadQueueNetInfoState>;
  /**
   * The NetInfoStateType values for which downloads will be allowed. Only works
   * if you also pass `netInfoAddEventListener`. If `activeNetworkTypes` is
   * undefined or [], downloads will happen on all connection types. A common
   * practice is to pass ["wifi", "ethernet"] if you want to help users avoid
   * cell data charges. As of @react-native-community/netinfo@9.3.7, valid
   * values are "unknown" | "none" | "wifi" | "cellular" | "bluetooth" |
   * "ethernet" | "wimax" | "vpn" | "other" | "mixed".
   */
  activeNetworkTypes?: string[];
  /**
   * Whether to start the queue in an active state where downloads will be
   * started. If false, no downloads will begin until you call resumeAll().
   */
  startActive?: boolean;
  /**
   * Callback used to get a pathname from a URL. By default, files are saved
   * without any particular extension. But if you need the server extension to
   * be preserved (e.g. you pass the file to a media player that uses the
   * extension to determine its data format), pass a function here that returns
   * a path given a URL (e.g. for `https://foo.com/baz/moo.mp3?q=song`, returns
   * `baz/moo.mp3`). The easiest way to implement this, if you already have
   * a React Native polyfill for URL, is:
   *
   * function urlToPath(url) {
   *  const parsed = new URL(url);
   *  return parsed.pathname;
   * }
   *
   * If you don't have a polyfill, you can use something like
   * https://www.npmjs.com/package/react-native-url-polyfill
   */
  urlToPath?: (url: string) => string;
}

/**
 * A queue for downloading files in the background. You should call init()
 * before using any other methods. A suggested practice is to have one queue
 * per userId, using that userId as the queue's `domain`, if you want downloads
 * several users to occur concurrently and not interfere with each other.
 */
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
  private urlToPath?: (url: string) => string = undefined;
  private erroredIds = new Set<string>();
  private errorTimer: NodeJS.Timeout | null = null;
  private netInfoUnsubscriber?: () => void;
  private netInfoFetchState?: () => Promise<DownloadQueueNetInfoState>;
  private activeNetworkTypes: string[] = [];
  private wouldAutoPause = false; // Whether we'd pause if the user didn't
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
   * @param options.netInfoFetchState (optional )Callback that gets the current
   * network state. If you pass `netInfoAddEventListener`, you must pass this as
   * well. The easiest thing is usually to pass `NetInfo.fetch`.
   * @param options.activeNetworkTypes (optional) The NetInfoStateType values
   * for which downloads will be allowed. Only works if you also pass
   * `netInfoAddEventListener`. If `activeNetworkTypes` is undefined or [],
   * downloads will happen on all connection types. A common practice is to pass
   * ["wifi", "ethernet"] if you want to help users avoid cell data charges. As
   * of @react-native-community/netinfo@9.3.7, valid values are "unknown" |
   * "none" | "wifi" | "cellular" | "bluetooth" | "ethernet" | "wimax" | "vpn" |
   * "other" | "mixed".
   */
  async init({
    domain = "main",
    handlers = undefined,
    netInfoAddEventListener = undefined,
    netInfoFetchState = undefined,
    activeNetworkTypes = [],
    startActive = true,
    urlToPath = undefined,
  }: DownloadQueueOptions = {}): Promise<void> {
    if (this.inited) {
      throw new Error("DownloadQueue already initialized");
    }

    this.domain = domain;
    this.handlers = handlers;
    this.urlToPath = urlToPath;

    // This is safe to call even if it already exists. It'll also create all
    // necessary parent directories.
    await RNFS.mkdir(this.getDomainedBasePath(), {
      NSURLIsExcludedFromBackupKey: true,
    });

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
    this.isPausedByUser = !startActive;

    // First revive tasks that were working in the background
    await Promise.all(existingTasks.map(task => this.reviveTask(task)));

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
            const parts = filename.split(".");

            if (parts.length > 1) {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              const extension = parts.pop()!;

              return RNFS.unlink(this.pathFromId(parts.join("."), extension));
            }
            return RNFS.unlink(this.pathFromId(filename, ""));
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

    this.wouldAutoPause = false;

    if (
      activeNetworkTypes.length > 0 &&
      (!netInfoAddEventListener || !netInfoFetchState)
    ) {
      throw new Error(
        "If you pass `activeNetworkTypes`, you must also pass both `netInfoAddEventListener` and `netInfoFetchState`"
      );
    }
    if (netInfoAddEventListener && !netInfoFetchState) {
      throw new Error(
        "If you pass `netInfoAddEventListener`, you must also pass `netInfoFetchState`"
      );
    }
    this.activeNetworkTypes = activeNetworkTypes;
    this.netInfoFetchState = netInfoFetchState;
    if (netInfoAddEventListener) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const state = await this.netInfoFetchState!();

      this.onNetInfoChanged(state);
      this.netInfoUnsubscriber = netInfoAddEventListener(
        (state: DownloadQueueNetInfoState) => {
          this.onNetInfoChanged(state);
        }
      );
    }

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
    this.urlToPath = undefined;
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
          RNFS.exists(
            this.pathFromId(curSpec.id, this.extensionFromUri(curSpec.url))
          ),
          this.kvfs.write(this.keyFromId(curSpec.id), curSpec),
        ]);
        if (!curSpec.finished || !fileExists) {
          this.start(curSpec);
        } else {
          // If we already have the file, and you're reviving it from deletion,
          // send "begin" and "done" notifications so that most clients can
          // treat it the same as a fresh download.
          const fileSpec = await RNFS.stat(curSpec.path);

          this.handlers?.onBegin?.(curSpec.url, fileSpec.size);
          this.handlers?.onDone?.(curSpec.url, curSpec.path);
        }
      }
      return;
    }

    const id = uuid();
    const spec: Spec = {
      id,
      url,
      path: this.pathFromId(id, this.extensionFromUri(url)),
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

    // Block here to give caller the chance to remove any UI elements that might
    // have depended on the local file being available.
    await this.handlers?.onWillRemove?.(spec.url);

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
   * Returns the status of all urls in the queue, excluding urls marked for
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
   * Returns the status of a single url in the queue, excluding urls marked for
   * deletion.
   */
  async getStatus(url: string): Promise<DownloadQueueStatus | null> {
    this.verifyInitialized();

    const spec = this.specs.find(
      spec => spec.url === url && spec.createTime > 0
    );
    if (!spec) {
      return null;
    }

    return {
      url: spec.url,
      path: spec.path,
      complete: spec.finished && (await RNFS.exists(spec.path)),
    };
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
   * downloads will never happen. Also, downloads will only proceed if the
   * network connection type passes the `activeNetworkTypes` filter (which by
   * default allows all connection types).
   */
  resumeAll(): void {
    this.verifyInitialized();

    this.isPausedByUser = false;
    if (!this.wouldAutoPause) {
      // We only resume downloads if we weren't told otherwise to auto-pause
      // based on network conditions.
      this.resumeAllInternal();
    }
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

  /**
   * Sets the types of networks which you want downloads to occur on.
   * @param types The network types to allow downloads on. These should come
   * from `NetInfo.NetInfoStateType`, e.g. `["wifi", "cellular"]`. If you pass
   * an empty array, downloads will happen under all network connection types.
   */
  async setActiveNetworkTypes(types: string[]): Promise<void> {
    this.verifyInitialized();

    this.activeNetworkTypes = types;
    if (this.netInfoFetchState) {
      const state = await this.netInfoFetchState();
      this.onNetInfoChanged(state);
    } else {
      throw new Error(
        "Can't `setActiveNetworkType` without having init'd with `netInfoFetchState`"
      );
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
        this.handlers?.onDone?.(url, spec.path);
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

  private onNetInfoChanged(state: DownloadQueueNetInfoState) {
    const shouldAutoPause =
      !state.isConnected ||
      (this.activeNetworkTypes.length > 0 &&
        !this.activeNetworkTypes.includes(state.type));

    if (shouldAutoPause === this.wouldAutoPause) {
      return;
    }
    this.wouldAutoPause = shouldAutoPause;

    // We only ever pause/resume when the user hasn't themselves explicitly
    // asked us to pause. If they have, we leave their wishes alone.
    if (!this.isPausedByUser) {
      if (shouldAutoPause) {
        this.pauseAllInternal();
      } else {
        this.resumeAllInternal();
      }
    }
  }

  private async reviveTask(task: DownloadTask) {
    const spec = this.specs.find(spec => spec.id === task.id);

    // Don't revive finished tasks or ones that already have lazy deletes in
    // progress.
    if (spec && !spec.finished && spec.createTime > 0) {
      let shouldAddTask = true;

      switch (task.state) {
        case "DOWNLOADING":
          // Since we're already downloading, make sure the client at least
          // gets a notification that it's started.
          this.handlers?.onBegin?.(spec.url, task.totalBytes);
          if (!this.active) {
            task.pause();
          }
          break;
        case "PAUSED":
          this.handlers?.onBegin?.(spec.url, task.totalBytes);
          if (this.active) {
            task.resume(); // Assuming checkForExistingDownloads() hasn't already
          }
          break;
        case "DONE":
          this.handlers?.onBegin?.(spec.url, task.totalBytes);
          this.handlers?.onDone?.(spec.url, spec.path);
          shouldAddTask = false;
          break;
        case "STOPPED":
          this.start(spec);
          shouldAddTask = false;
          break;
        case "FAILED":
        default:
          this.handlers?.onError?.(
            spec.url,
            "unknown error while backgrounded"
          );
          this.erroredIds.add(task.id);
          this.ensureErrorTimerOn();
          shouldAddTask = false;
          break;
      }

      if (shouldAddTask) {
        this.addTask(spec.url, task);
      }
    } else {
      if (["DOWNLOADING", "PAUSED"].includes(task.state)) {
        task.stop();

        if (spec && !spec.finished) {
          try {
            // There might be a partially downloaded file on disk. We need to
            // get rid of it in case a lazy-delete spec is revived, at which
            // point an existing file on disk will be taken to be a
            // successfully downloaded one.
            await RNFS.unlink(spec.path);
          } catch {
            // Expected for missing files
          }
        }
      }
    }
  }

  private extensionFromUri(uri: string) {
    const path = this.urlToPath?.(uri);

    if (path) {
      const filename = path.split("/").pop();

      if (filename) {
        const parts = filename.split(".");

        if (parts.length > 1) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          return parts.pop()!;
        }
      }
    }
    return "";
  }

  private async getDirFilenames() {
    try {
      return await RNFS.readdir(this.getDomainedBasePath());
    } catch {
      // expected error when the directory doesn't exist
    }
    return [];
  }

  private getDomainedBasePath(): string {
    return `${basePath()}/${this.domain}`;
  }

  private pathFromId(id: string, extension: string) {
    return (
      `${this.getDomainedBasePath()}/${id}` +
      (extension.length > 0 ? `.${extension}` : "")
    );
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

