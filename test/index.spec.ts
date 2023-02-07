import {
  BeginHandler,
  checkForExistingDownloads,
  DoneHandler,
  download,
  DownloadTask,
  ensureDownloadsAreRunning,
  ErrorHandler,
  ProgressHandler
} from "@kesha-antonov/react-native-background-downloader";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addEventListener,
  fetch,
  NetInfoState,
  NetInfoStateType
} from "@react-native-community/netinfo";
import { mock } from "jest-mock-extended";
import KVFS from "key-value-file-system";
import { Platform } from "react-native";
import RNFS, { exists, readdir, stat, unlink } from "react-native-fs";
import DownloadQueue, { DownloadQueueHandlers } from "../src";

jest.mock("@react-native-async-storage/async-storage", () => {
  const store: { [key: string]: string } = {};
  return {
    getItem: jest.fn((key: string) => Promise.resolve(store[key])),
    getAllKeys: jest.fn(() => Promise.resolve(Object.keys(store))),
    multiGet: jest.fn((keys: string[]) =>
      Promise.resolve(keys.map(key => [key, store[key]]))
    ),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value;
    }),
    multiSet: jest.fn((keyValuePairs: string[][]) => {
      keyValuePairs.forEach(([key, value]) => (store[key] = value));
    }),
    multiRemove: jest.fn((keys: string[]) => {
      keys.forEach(key => delete store[key]);
    }),
  };
});

// Not sure why putting this in /__mocks__ doesn't work, when things like
// react-native-fs do. Spent too long researching it.
jest.mock("@kesha-antonov/react-native-background-downloader", () => {
  return {
    checkForExistingDownloads: jest.fn(() => []),
    ensureDownloadsAreRunning: jest.fn(() => []),
    download: jest.fn(() => ({})),
    completeHandler: jest.fn(),
    DownloadTaskState: {
      DOWNLOADING: "DOWNLOADING",
      PAUSED: "PAUSED",
      DONE: "DONE",
      FAILED: "FAILED",
      STOPPED: "STOPPED",
    },
  };
});

jest.mock("react-native-fs", () => {
  return {
    mkdir: jest.fn(),
    moveFile: jest.fn(),
    copyFile: jest.fn(),
    pathForBundle: jest.fn(),
    pathForGroup: jest.fn(),
    getFSInfo: jest.fn(),
    getAllExternalFilesDirs: jest.fn(),
    unlink: jest.fn(),
    exists: jest.fn(() => false),
    stopDownload: jest.fn(),
    resumeDownload: jest.fn(),
    isResumable: jest.fn(),
    stopUpload: jest.fn(),
    completeHandlerIOS: jest.fn(),
    readDir: jest.fn(),
    readDirAssets: jest.fn(),
    existsAssets: jest.fn(),
    readdir: jest.fn(() => []),
    setReadable: jest.fn(),
    stat: jest.fn(),
    readFile: jest.fn(),
    read: jest.fn(),
    readFileAssets: jest.fn(),
    hash: jest.fn(),
    copyFileAssets: jest.fn(),
    copyFileAssetsIOS: jest.fn(),
    copyAssetsVideoIOS: jest.fn(),
    writeFile: jest.fn(),
    appendFile: jest.fn(),
    write: jest.fn(),
    downloadFile: jest.fn(),
    uploadFiles: jest.fn(),
    touch: jest.fn(),
    MainBundlePath: jest.fn(),
    CachesDirectoryPath: jest.fn(),
    DocumentDirectoryPath: "/usr/fake/myDocs",
    ExternalDirectoryPath: jest.fn(),
    ExternalStorageDirectoryPath: jest.fn(),
    TemporaryDirectoryPath: jest.fn(),
    LibraryDirectoryPath: jest.fn(),
    PicturesDirectoryPath: jest.fn(),
    RNFSFileTypeRegular: jest.fn(),
  };
});

jest.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

jest.useFakeTimers();
jest.spyOn(global, "setTimeout");

jest.setTimeout(12341234);

interface TaskWithHandlers extends DownloadTask {
  _begin?: BeginHandler;
  _progress?: ProgressHandler;
  _done?: DoneHandler;
  _error?: ErrorHandler;
}

const kvfs = new KVFS(AsyncStorage, "DownloadQueue");

// When jest advances fake timers, the async pending queue isn't flushed. Thus
// your expects will run before the async code that's executed by any timer
// actually finishes. Await this function to ensure that all async code fired
// by timers actually is flushed.
// https://github.com/facebook/jest/issues/2157#issuecomment-1272503136
async function advanceThroughNextTimersAndPromises() {
  jest.advanceTimersToNextTimer();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  await new Promise(jest.requireActual("timers").setImmediate);
}

function createBasicTask(): TaskWithHandlers {
  const baseTask = mock<TaskWithHandlers>();
  return Object.assign(baseTask, {
    id: "foo",
    begin: jest.fn(() => baseTask),
    progress: jest.fn(() => baseTask),
    done: jest.fn(() => baseTask),
    error: jest.fn(() => baseTask),
    resume: jest.fn(() => baseTask),
    pause: jest.fn(() => baseTask),
    stop: jest.fn(() => baseTask),
  });
}

let task = createBasicTask();

async function expectPublicsToFail(queue: DownloadQueue) {
  await expect(queue.addUrl("whatevs")).rejects.toThrow();
  await expect(queue.removeUrl("whatevs")).rejects.toThrow();
  await expect(queue.setQueue([])).rejects.toThrow();
  await expect(queue.getQueueStatus()).rejects.toThrow();
  expect(() => queue.pauseAll()).toThrow();
  expect(() => queue.resumeAll()).toThrow();
  await expect(queue.getAvailableUrl("whatevs")).rejects.toThrow();
  await expect(queue.getStatus("whatevs")).rejects.toThrow();
  await expect(queue.setActiveNetworkTypes(["boo"])).rejects.toThrow();
}

let netInfoHandler: (state: NetInfoState) => void;

jest.mock("@react-native-community/netinfo", () => ({
  addEventListener: jest.fn(handler => {
    netInfoHandler = handler;
    return jest.fn();
  }),
  fetch: jest.fn(() => Promise.resolve({ isConnected: true, type: "wifi" })),
}));

function urlToPath(url: string): string {
  return new URL(url).pathname;
}

describe("DownloadQueue", () => {
  beforeEach(() => {
    // restore a few commonly-used functions between tests to avoid unexpected
    // side effects
    task = createBasicTask();

    (exists as jest.Mock).mockReturnValue(false);
    (readdir as jest.Mock).mockReturnValue([]);
    (unlink as jest.Mock).mockImplementation(() => Promise.resolve());
    (stat as jest.Mock).mockReturnValue({ size: 8675309 });

    (download as jest.Mock).mockReturnValue(task);
    (checkForExistingDownloads as jest.Mock).mockReturnValue([]);
    (ensureDownloadsAreRunning as jest.Mock).mockReturnValue(undefined);
  });

  afterEach(async () => {
    await kvfs.rmAllForce();
    jest.clearAllTimers();
    jest.clearAllMocks();
  });

  describe("Initialization", () => {
    it("should throw when uninitialized", async () => {
      await expectPublicsToFail(new DownloadQueue());
    });

    it("initializes when nothing's going on", async () => {
      const queue = new DownloadQueue();

      await expect(queue.init({ domain: "mydomain" })).resolves.not.toThrow();
    });

    it("should initialize with defaults", async () => {
      const queue = new DownloadQueue();

      await queue.init();
    });

    it("doesn't double-initialize", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await expect(queue.init({ domain: "mydomain" })).rejects.toThrow();
    });

    it("initializes ok without download dir", async () => {
      // The first time a user runs, readdir will throw because our download
      // directory hasn't been created. We should handle that.
      (readdir as jest.Mock).mockImplementation(() => {
        throw new Error("dir not found!");
      });

      const queue = new DownloadQueue();

      await expect(queue.init({ domain: "mydomain" })).resolves.not.toThrow();
    });

    it("deletes files without specs and extensions upon init", async () => {
      const queue = new DownloadQueue();

      (readdir as jest.Mock).mockImplementation(() => ["foo", "bar"]);
      await queue.init({ domain: "mydomain" });
      expect(unlink).toHaveBeenNthCalledWith(
        1,
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`
      );
      expect(unlink).toHaveBeenNthCalledWith(
        2,
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/bar`
      );
      expect(unlink).toHaveBeenCalledTimes(2);
    });

    it("deletes files without specs but with extensions upon init", async () => {
      const queue = new DownloadQueue();

      (readdir as jest.Mock).mockImplementation(() => ["foo.mp3", "bar.dat"]);
      await queue.init({ domain: "mydomain" });
      expect(unlink).toHaveBeenNthCalledWith(
        1,
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo.mp3`
      );
      expect(unlink).toHaveBeenNthCalledWith(
        2,
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/bar.dat`
      );
      expect(unlink).toHaveBeenCalledTimes(2);
    });

    it("doesn't delete files without extensions that have specs on init", async () => {
      const queue = new DownloadQueue();

      (readdir as jest.Mock).mockImplementation(() => ["foo", "bar"]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/bar`
        )
      );
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it("doesn't delete files with extensions that have specs on init", async () => {
      const queue = new DownloadQueue();

      (readdir as jest.Mock).mockImplementation(() => ["foo.mp3", "bar.mp3"]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo.mp3`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/bar.mp3`
        )
      );
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it("revives still-downloading specs from previous launches", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
      };

      task.state = "DOWNLOADING";
      task.totalBytes = 8675309;
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);
      (ensureDownloadsAreRunning as jest.Mock).mockImplementationOnce(() => {
        // This is exactly what the actual implementation does, to work around
        // some bug in the library.
        task.pause();
        task.resume();
      });

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", handlers });

      expect(task.resume).toHaveBeenCalledTimes(1);
      expect(handlers.onBegin).toHaveBeenCalledWith(
        "http://foo.com/a.mp3",
        task.totalBytes
      );
      expect(download).not.toHaveBeenCalled();
    });

    it("revives paused specs from previous launches", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
      };

      task.state = "PAUSED";
      task.totalBytes = 8675309;
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);
      (ensureDownloadsAreRunning as jest.Mock).mockImplementationOnce(() => {
        // This is exactly what the actual implementation does, to work around
        // some bug in the library.
        task.pause();
        task.resume();
      });

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", handlers });

      expect(task.resume).toHaveBeenCalledTimes(1);
      expect(handlers.onBegin).toHaveBeenCalledWith(
        "http://foo.com/a.mp3",
        task.totalBytes
      );
      expect(download).not.toHaveBeenCalled();
    });

    it("revives done specs from previous launches", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
        onDone: jest.fn(),
      };

      task.state = "DONE";
      task.totalBytes = 8675309;
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);
      (exists as jest.Mock).mockReturnValue(true);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", handlers });

      // Because it's done downloading, we don't expect resume()
      expect(task.resume).not.toHaveBeenCalled();
      expect(handlers.onBegin).toHaveBeenCalledWith(
        "http://foo.com/a.mp3",
        task.totalBytes
      );
      expect(handlers.onDone).toHaveBeenCalledWith(
        "http://foo.com/a.mp3",
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`
      );
      expect(download).not.toHaveBeenCalled();
    });

    it("revives done specs from previous launches with missing files", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
        onDone: jest.fn(),
      };

      task.state = "DONE";
      task.totalBytes = 8675309;
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);
      (exists as jest.Mock).mockReturnValue(false);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", handlers });

      // Because it's done downloading, we don't expect resume()
      expect(task.resume).not.toHaveBeenCalled();
      expect(handlers.onBegin).not.toHaveBeenCalled();
      expect(handlers.onDone).not.toHaveBeenCalled();
      expect(download).toHaveBeenCalledTimes(1);
    });

    it("restarts stopped specs from previous launches", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
        onDone: jest.fn(),
      };

      task.state = "STOPPED";
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", handlers });

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();
      expect(handlers.onDone).not.toHaveBeenCalled();
    });

    it("restarts failed specs from previous launches", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onDone: jest.fn(),
        onError: jest.fn(),
      };

      task.state = "FAILED";
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });

      expect(jest.getTimerCount()).toEqual(0);
      await queue.init({ domain: "mydomain", handlers });
      expect(jest.getTimerCount()).toEqual(1); // error retry timer

      await advanceThroughNextTimersAndPromises();
      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();
      expect(handlers.onDone).not.toHaveBeenCalled();
      expect(handlers.onError).toHaveBeenCalledTimes(1);
    });

    it("stops tasks from previous launches without specs if they're still going", async () => {
      const queue = new DownloadQueue();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await queue.init({ domain: "mydomain" });
      expect(task.stop).not.toHaveBeenCalled();

      queue.terminate();
      task.state = "PAUSED";
      await queue.init({ domain: "mydomain" });
      expect(task.stop).toHaveBeenCalledTimes(1);

      queue.terminate();
      task.state = "DOWNLOADING";
      await queue.init({ domain: "mydomain" });
      expect(task.stop).toHaveBeenCalledTimes(2);
    });

    it("stops lazy-deleted tasks from previous launches", async () => {
      const queue = new DownloadQueue();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);
      await kvfs.write("/mydomain/foo", {
        id: task.id,
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: -(Date.now() + 300000), // simulate lazy-delete
      });

      task.state = "DOWNLOADING";
      await queue.init({ domain: "mydomain" });

      expect(task.stop).toHaveBeenCalledTimes(1);
      // Should also delete partially-downloaded file
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it("starts downloads for unfinished specs without tasks", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      expect(task.resume).not.toHaveBeenCalled();

      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ id: "foo" })
      );
    });

    // This can happen in cases of TestFlight / XCode installs, somehow, where
    // the disk no longer holds files, and yet your specs load just fine (as
    // "finished").
    it("starts downloads for 'finished' specs without tasks and files", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
        finished: true,
      });
      await queue.init({ domain: "mydomain" });
      expect(task.resume).not.toHaveBeenCalled();

      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ id: "foo" })
      );
    });

    it("doesn't start downloads for 'finished' specs", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);
      (exists as jest.Mock).mockImplementation(() => true);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
        finished: true,
      });
      await queue.init({ domain: "mydomain" });

      // This test protects against a regression. We used to restart downloads
      // even for finished specs.
      expect(task.resume).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    });

    it("doesn't start downloads for lazy-deleted specs", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);
      (exists as jest.Mock).mockImplementation(() => true);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: -(Date.now() + 1000), // Delete one second into future
        finished: false, // Force the issue by simulating a half-downloaded file
      });
      await queue.init({ domain: "mydomain" });

      // This test protects against a regression. We used to restart downloads
      // even for finished specs.
      expect(task.resume).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    });

    it("enforces netInfo callbacks when activeNetworkTypes is passed", async () => {
      const queue = new DownloadQueue();

      await expect(
        queue.init({ domain: "mydomain", activeNetworkTypes: ["wifi"] })
      ).rejects.toThrow();
    });

    it("enforces netInfoFetchState when netInfoAddEventListener is passed", async () => {
      const queue = new DownloadQueue();

      await expect(
        queue.init({
          domain: "mydomain",
          netInfoAddEventListener: addEventListener,
        })
      ).rejects.toThrow();
    });
  });

  describe("Termination", () => {
    it("should stop all active tasks", async () => {
      const queue = new DownloadQueue();

      task.state = "DOWNLOADING";
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      // We assume that the downloader won't need to be resumed on a task that
      // it already says is downloading.
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.stop).not.toHaveBeenCalled();

      queue.terminate();
      expect(task.stop).toHaveBeenCalled();
    });

    it("should restart tasks after terminate/re-init", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
      };

      task.state = "DOWNLOADING";
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", handlers });
      expect(handlers.onBegin).toHaveBeenCalledTimes(1);

      queue.terminate();
      expect(task.stop).toHaveBeenCalled();

      await queue.init({ domain: "mydomain", handlers });
      expect(handlers.onBegin).toHaveBeenCalledTimes(2);
    });

    it("should refuse to work without re-init", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      queue.terminate();

      await expectPublicsToFail(queue);

      await queue.init({ domain: "mydomain" });
      await expect(queue.addUrl("http://foo.com/a.mp3")).resolves.not.toThrow();
    });
  });

  describe("Adding", () => {
    it("should add a url while preserving its extension", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation((spec: { id: string }) =>
        Object.assign(task, {
          id: spec.id,
        })
      );

      await queue.init({ domain: "mydomain", urlToPath });
      await queue.addUrl("http://foo.com/a.mp3");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://foo.com/a.mp3",
          destination: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}.mp3`,
        })
      );
    });

    it("should add a url without an extension", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation((spec: { id: string }) =>
        Object.assign(task, {
          id: spec.id,
        })
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://foo.com/a",
          destination: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}`,
        })
      );

      queue.terminate();
      await queue.init({ domain: "mydomain", urlToPath });
      (download as jest.Mock).mockClear(); // Clear out revival of prev url
      await queue.addUrl("http://foo.com/a.mp3");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://foo.com/a.mp3",
          destination: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}.mp3`,
        })
      );
      (download as jest.Mock).mockClear();
      // This tests whether paths/extensions are dealt with properly when a url
      // ends in a slash.
      await queue.addUrl("http://foo.com/abc/");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://foo.com/abc/",
          destination: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}`,
        })
      );
      (download as jest.Mock).mockClear();
      // Tests whether paths/extensions with terminating periods are handled
      await queue.addUrl("http://foo.com/a/bc.");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://foo.com/a/bc.",
          destination: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}`,
        })
      );
      (download as jest.Mock).mockClear();
      // Tests whether paths with no extensions are handled when urlToPath is
      // given by caller
      await queue.addUrl("http://foo.com/a/bc");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://foo.com/a/bc",
          destination: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}`,
        })
      );

      // Now make sure termination clears out the urlPath callback
      queue.terminate();
      await queue.init({ domain: "mydomain" });
      (download as jest.Mock).mockClear(); // Clear out revival of prev url
      await queue.addUrl("http://foo.com/b.mp3");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://foo.com/b.mp3",
          destination: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}`,
        })
      );
    });

    it("shouldn't add the same url twice", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://foo.com/a.mp3");
      expect(download).toHaveBeenCalledTimes(1);
    });

    it("should revive added url upon relaunch", async () => {
      const queue = new DownloadQueue();
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        assignedId = spec.id;
        return task;
      });
      (ensureDownloadsAreRunning as jest.Mock).mockImplementation(() => {
        // This is exactly what the actual implementation does, to work around
        // some bug in the library.
        task.pause();
        task.resume();
      });

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([
        Object.assign(task, {
          id: assignedId,
        }),
      ]);

      task.state = "PAUSED";

      // Pretend app got launched again by using another queue
      const relaunchQueue = new DownloadQueue();

      await relaunchQueue.init({ domain: "mydomain" });
      expect(task.resume).toHaveBeenCalledTimes(1);
    });

    it("shouldn't re-download revived spec if file already downloaded", async () => {
      const queue = new DownloadQueue();
      let doner: DoneHandler | undefined;

      (download as jest.Mock).mockImplementation(
        (spec: { id: string }): TaskWithHandlers => {
          return Object.assign(task, {
            id: spec.id,
            done: (handler: DoneHandler) => {
              doner = handler;
              return task;
            },
          });
        }
      );
      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      (exists as jest.Mock).mockImplementation(() => true);

      await queue.removeUrl("http://foo.com/a.mp3", 0);
      await queue.addUrl("http://foo.com/a.mp3");

      expect(exists).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledTimes(2); // Because it hadn't finished

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await doner!();
      await queue.removeUrl("http://foo.com/a.mp3", 0);
      await queue.addUrl("http://foo.com/a.mp3");

      // Now that it's been downloaded, removing it for next launch and
      // re-adding it shouldn't retrigger a download.
      expect(download).toHaveBeenCalledTimes(2);
    });

    it("shouldn't re-download revived spec on relaunch if file already downloaded", async () => {
      const queue = new DownloadQueue();
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        assignedId = spec.id;
        return task;
      });
      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      await queue.removeUrl("http://foo.com/a.mp3");

      (checkForExistingDownloads as jest.Mock).mockReturnValue([
        {
          ...task,
          id: assignedId,
        },
      ]);
      (readdir as jest.Mock).mockReturnValue([assignedId]);

      // Pretend app got launched again by using another queue
      const relaunchQueue = new DownloadQueue();

      await relaunchQueue.init({ domain: "mydomain" });
      expect(download).toHaveBeenCalledTimes(1); // Just the first time only
    });
  });

  describe("Removing", () => {
    it("should remove a url", async () => {
      const queue = new DownloadQueue();
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        assignedId = spec.id;
        return {
          ...task,
          id: assignedId,
        };
      });

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "DownloadQueue/mydomain/" + assignedId,
        expect.anything()
      );

      await queue.removeUrl("http://foo.com/a.mp3");
      expect(unlink).toHaveBeenCalledTimes(1);

      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        "DownloadQueue/mydomain/" + assignedId,
      ]);
    });

    it("should double-remove a url without side effects", async () => {
      const queue = new DownloadQueue();
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        assignedId = spec.id;
        return {
          ...task,
          id: assignedId,
        };
      });

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "DownloadQueue/mydomain/" + assignedId,
        expect.anything()
      );

      await queue.removeUrl("http://foo.com/a.mp3");
      await queue.removeUrl("http://foo.com/a.mp3");
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(task.stop).toHaveBeenCalledTimes(1);

      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        "DownloadQueue/mydomain/" + assignedId,
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
    });
  });

  describe("setQueue", () => {
    it("should update a queue with deletion and insertion", async () => {
      const queue = new DownloadQueue();
      const idMap: { [key: string]: string } = {};

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          idMap[spec.url] = spec.id;
          return {
            ...task,
            id: spec.id,
          };
        }
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://boo.com/a.mp3");
      await queue.addUrl("http://moo.com/a.mp3");

      await queue.setQueue([
        "http://foo.com/a.mp3",
        "http://moo.com/a.mp3",
        "http://shoo.com/a.mp3",
      ]);

      expect(unlink).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        "DownloadQueue/mydomain/" + idMap["http://boo.com/a.mp3"],
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://shoo.com/a.mp3" })
      );
      expect(download).toHaveBeenCalledTimes(4);
    });
  });

  describe("Getting queue status", () => {
    it("should return status on a single file", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }): Partial<TaskWithHandlers> =>
          spec.url === "http://boo.com/a.mp3"
            ? Object.assign(task, {
                ...task,
                id: spec.id,
                done: jest.fn((handler: DoneHandler) => {
                  task._done = handler;
                  return task;
                }),
              })
            : task
      );
      (exists as jest.Mock).mockReturnValue(true);

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://boo.com/a.mp3");

      const res = await queue.getStatus("http://foo.com/a.mp3");
      expect(res).toEqual(
        expect.objectContaining({
          url: "http://foo.com/a.mp3",
          complete: false,
        })
      );

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();
      const resBoo = await queue.getStatus("http://boo.com/a.mp3");
      expect(resBoo).toEqual(
        expect.objectContaining({ url: "http://boo.com/a.mp3", complete: true })
      );
    });

    it("should return the same status as a single or a group", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      const res = await queue.getStatus("http://foo.com/a.mp3");
      expect(res).toEqual(
        expect.objectContaining({
          url: "http://foo.com/a.mp3",
          complete: false,
        })
      );

      const arrRes = await queue.getQueueStatus();
      expect(arrRes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://foo.com/a.mp3",
            complete: false,
          }),
        ])
      );
    });

    it("should not return status on a single lazy-deleted file", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.removeUrl("http://foo.com/a.mp3", Date.now() + 3000);

      const res = await queue.getStatus("http://foo.com/a.mp3");
      expect(res).toEqual(null);
    });

    it("should return yet-to-be downloaded files", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.setQueue([
        "http://foo.com/a.mp3",
        "http://moo.com/a.mp3",
        "http://boo.com/a.mp3",
      ]);
      const res = await queue.getQueueStatus();
      expect(res).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://foo.com/a.mp3",
            complete: false,
          }),
          expect.objectContaining({
            url: "http://boo.com/a.mp3",
            complete: false,
          }),
          expect.objectContaining({
            url: "http://moo.com/a.mp3",
            complete: false,
          }),
        ])
      );
      expect(res.length).toEqual(3);
    });

    it("should return downloaded files", async () => {
      const queue = new DownloadQueue();
      const idMap: { [url: string]: TaskWithHandlers } = {};

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }): Partial<TaskWithHandlers> => {
          const baseTask = mock<TaskWithHandlers>();

          idMap[spec.url] = Object.assign(baseTask, {
            ...baseTask,
            id: spec.id,
            begin: jest.fn(() => baseTask),
            progress: jest.fn(() => baseTask),
            done: jest.fn((handler: DoneHandler) => {
              baseTask._done = handler;
              return baseTask;
            }),
            error: jest.fn(() => baseTask),
          });
          return idMap[spec.url];
        }
      );
      (exists as jest.Mock).mockReturnValue(true);

      await queue.init({ domain: "mydomain" });
      await queue.setQueue([
        "http://foo.com/a.mp3",
        "http://moo.com/a.mp3",
        "http://boo.com/a.mp3",
      ]);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://foo.com/a.mp3"]._done!();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://boo.com/a.mp3"]._done!();

      const res = await queue.getQueueStatus();
      expect(res).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://foo.com/a.mp3",
            complete: true,
          }),
          expect.objectContaining({
            url: "http://boo.com/a.mp3",
            complete: true,
          }),
          expect.objectContaining({
            url: "http://moo.com/a.mp3",
            complete: false,
          }),
        ])
      );
      expect(res.length).toEqual(3);
    });

    it("should not return lazy-deleted files", async () => {
      const queue = new DownloadQueue();
      const idMap: { [url: string]: TaskWithHandlers } = {};

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }): Partial<TaskWithHandlers> => {
          const baseTask = mock<TaskWithHandlers>();

          idMap[spec.url] = Object.assign(baseTask, {
            ...baseTask,
            id: spec.id,
            begin: jest.fn(() => baseTask),
            progress: jest.fn(() => baseTask),
            done: jest.fn((handler: DoneHandler) => {
              baseTask._done = handler;
              return baseTask;
            }),
            error: jest.fn(() => baseTask),
          });
          return idMap[spec.url];
        }
      );
      (exists as jest.Mock).mockReturnValue(true);

      await queue.init({ domain: "mydomain" });
      await queue.setQueue([
        "http://foo.com/a.mp3",
        "http://moo.com/a.mp3",
        "http://boo.com/a.mp3",
      ]);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://foo.com/a.mp3"]._done!();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://boo.com/a.mp3"]._done!();
      await queue.removeUrl("http://boo.com/a.mp3");

      const res = await queue.getQueueStatus();
      expect(res).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://foo.com/a.mp3",
            complete: true,
          }),
          expect.objectContaining({
            url: "http://moo.com/a.mp3",
            complete: false,
          }),
        ])
      );
      expect(res.length).toEqual(2);
    });
  });

  describe("Lazy deletion", () => {
    it("should not immediately delete lazy-deletions", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.removeUrl("http://foo.com/a.mp3", 0);

      expect(unlink).toHaveBeenCalledTimes(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(0);
    });

    it("should delete only next-init lazy deletions during init", async () => {
      const queue = new DownloadQueue();
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          if (spec.url === "http://foo.com/a.mp3") {
            assignedId = spec.id;
          }
          return {
            ...task,
            id: spec.id,
          };
        }
      );
      expect(jest.getTimerCount()).toEqual(0);

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://boo.com/a.mp3");
      await queue.removeUrl("http://foo.com/a.mp3", 0);
      await queue.removeUrl("http://boo.com/a.mp3", Date.now() + 30000);

      const nextLaunchQueue = new DownloadQueue();

      await nextLaunchQueue.init({ domain: "mydomain" });
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${assignedId}`,
      ]);

      jest.runAllTimers(); // Or else the test hangs on boo!
    });

    it("should delete lazy deletions on time", async () => {
      const queue = new DownloadQueue();
      const urlsToIds: { [url: string]: string } = {
        "http://foo.com/a.mp3": "foo",
        "http://boo.com/a.mp3": "boo",
        "http://moo.com/a.mp3": "moo",
      };

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          urlsToIds[spec.url] = spec.id;
          return {
            ...task,
            id: spec.id,
          };
        }
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://boo.com/a.mp3");
      await queue.addUrl("http://moo.com/a.mp3");

      await queue.removeUrl("http://foo.com/a.mp3", 0);
      expect(jest.getTimerCount()).toEqual(0);

      await queue.removeUrl("http://boo.com/a.mp3", Date.now() + 30000);
      await queue.removeUrl("http://moo.com/a.mp3", Date.now() + 180000);

      expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toEqual(2);

      await advanceThroughNextTimersAndPromises();
      expect(jest.getTimerCount()).toEqual(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${urlsToIds["http://boo.com/a.mp3"]}`,
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${urlsToIds["http://boo.com/a.mp3"]}`
        )
      );
      expect(jest.getTimerCount()).toEqual(1);

      await advanceThroughNextTimersAndPromises();
      expect(jest.getTimerCount()).toEqual(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(2);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${urlsToIds["http://moo.com/a.mp3"]}`,
      ]);
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${urlsToIds["http://moo.com/a.mp3"]}`
        )
      );
    });

    it("should revive re-added lazy-deletions", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(download).toHaveBeenCalledTimes(1);

      await queue.removeUrl("http://foo.com/a.mp3", 0);

      expect(unlink).toHaveBeenCalledTimes(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(0);

      await queue.addUrl("http://foo.com/a.mp3");
      expect(download).toHaveBeenCalledTimes(2);
    });

    it("should send notifications for revived lazy-deletions", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
        onDone: jest.fn(),
      };

      Object.assign(task, {
        id: "foo",
        begin: jest.fn(handler => {
          task._begin = handler;
          return task;
        }),
        done: jest.fn(handler => {
          task._done = handler;
          return task;
        }),
      });

      (exists as jest.Mock).mockResolvedValue(true);

      await queue.init({ domain: "mydomain", handlers });
      await queue.addUrl("http://foo.com/a.mp3");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._begin!({ expectedBytes: 42, headers: {} });
      expect(handlers.onBegin).toHaveBeenCalledTimes(1);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();
      expect(handlers.onDone).toHaveBeenCalledTimes(1);

      await queue.removeUrl("http://foo.com/a.mp3", 0);
      await queue.addUrl("http://foo.com/a.mp3");

      // When we re-add a lazy-deleted download that was already downloaded,
      // we expect to get notifications for begin/done again.
      expect(handlers.onBegin).toHaveBeenCalledTimes(2);
      expect(handlers.onDone).toHaveBeenCalledTimes(2);
    });
  });

  describe("Pause / resume", () => {
    it("should start paused if requested on background downloading task", async () => {
      const queue = new DownloadQueue();

      task.state = "DOWNLOADING";
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", startActive: false });
      expect(task.resume).not.toHaveBeenCalled();
      // We expect pause TWO times because, according to downloader docs, we
      // should explicitly pause before reattaching handlers; we then pause
      // gain because we specified !startActive.
      expect(task.pause).toHaveBeenCalledTimes(2);
      expect(download).not.toHaveBeenCalled();

      (download as jest.Mock).mockReturnValue(task);

      await queue.addUrl("http://boo.com/a.mp3");
      expect(task.pause).toHaveBeenCalledTimes(3); // for the added download
    });

    it("should start paused if requested on paused background task", async () => {
      const queue = new DownloadQueue();

      task.state = "PAUSED";
      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com/a.mp3",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", startActive: false });
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(1);
      expect(download).not.toHaveBeenCalled();

      (download as jest.Mock).mockReturnValue(task);

      await queue.addUrl("http://boo.com/a.mp3");
      expect(task.pause).toHaveBeenCalledTimes(2); // for the added download
    });

    it("should pause/resume everything when asked", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://boo.com/a.mp3");
      await queue.addUrl("http://moo.com/a.mp3");

      expect(download).toHaveBeenCalledTimes(3);
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).not.toHaveBeenCalled();

      queue.pauseAll();

      expect(download).toHaveBeenCalledTimes(3); // no change expected here
      expect(task.pause).toHaveBeenCalledTimes(3);
      expect(task.resume).not.toHaveBeenCalled();

      queue.resumeAll();

      expect(download).toHaveBeenCalledTimes(3); // no change expected here
      expect(task.pause).toHaveBeenCalledTimes(3); // no change here either
      expect(task.resume).toHaveBeenCalledTimes(3);
    });
  });

  describe("Responding to network connectivity changes", () => {
    function createNetState(isConnected: boolean): NetInfoState {
      return isConnected
        ? {
            ...mock<NetInfoState>(),
            isConnected,
            isInternetReachable: true,
            details: { isConnectionExpensive: false },
            type: "other" as NetInfoStateType.other,
          }
        : {
            ...mock<NetInfoState>(),
            isConnected: false,
            type: "none" as NetInfoStateType.none,
            isInternetReachable: false,
            details: null,
          };
    }

    it("should ignore network state when unasked", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).not.toHaveBeenCalled();
    });

    it("should pause/resume based on network state when asked", async () => {
      const queue = new DownloadQueue();
      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });
      await queue.addUrl("http://foo.com/a.mp3");
      expect(task.resume).not.toHaveBeenCalled();

      netInfoHandler(createNetState(false));
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(1);

      netInfoHandler(createNetState(true));
      expect(task.resume).toHaveBeenCalledTimes(1);
      expect(task.pause).toHaveBeenCalledTimes(1);
    });

    it("should accept undefined activeNetworksTypes as []", async () => {
      const queue = new DownloadQueue();
      const state = createNetState(true);

      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
        activeNetworkTypes: undefined,
      });
      await queue.addUrl("http://foo.com/a.mp3");
      expect(task.resume).not.toHaveBeenCalled();

      state.type = "cellular" as NetInfoStateType.cellular;
      netInfoHandler(state);
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).not.toHaveBeenCalled();
    });

    it("should respect the user's pause when before/after network change", async () => {
      const queue = new DownloadQueue();
      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });
      await queue.addUrl("http://foo.com/a.mp3");

      queue.pauseAll();
      expect(task.pause).toHaveBeenCalledTimes(1);

      netInfoHandler(createNetState(false));
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(1); // no change!

      netInfoHandler(createNetState(true));
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(1);

      queue.resumeAll();
      expect(task.resume).toHaveBeenCalledTimes(1);
      expect(task.pause).toHaveBeenCalledTimes(1);
    });

    it("should respect the user's pause when interlaced with network change", async () => {
      const queue = new DownloadQueue();
      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });
      await queue.addUrl("http://foo.com/a.mp3");

      netInfoHandler(createNetState(false));
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(1);

      queue.pauseAll();
      expect(task.pause).toHaveBeenCalledTimes(2);

      netInfoHandler(createNetState(true));
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(2);

      queue.resumeAll();
      expect(task.resume).toHaveBeenCalledTimes(1);
      expect(task.pause).toHaveBeenCalledTimes(2);
    });

    it("should respect the user's !startActive during network change", async () => {
      const queue = new DownloadQueue();
      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
        startActive: false,
      });
      await queue.addUrl("http://foo.com/a.mp3");
      expect(task.pause).toHaveBeenCalledTimes(1);

      netInfoHandler(createNetState(false));
      netInfoHandler(createNetState(true));
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(1); // no change!

      queue.resumeAll();
      expect(task.resume).toHaveBeenCalledTimes(1);
      expect(task.pause).toHaveBeenCalledTimes(1); // no change!
    });

    it("should unsubscribe when terminated", async () => {
      const queue = new DownloadQueue();
      const unsubscriber = jest.fn();
      const customAdder = jest.fn().mockImplementation(handler => {
        netInfoHandler = handler;
        return unsubscriber;
      });

      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: customAdder,
        netInfoFetchState: fetch,
      });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(customAdder).toHaveBeenCalledTimes(1);
      expect(unsubscriber).not.toHaveBeenCalled();

      queue.terminate();
      expect(unsubscriber).toHaveBeenCalledTimes(1);
    });

    it("should ignore connection states that don't change", async () => {
      const queue = new DownloadQueue();

      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(addEventListener).toHaveBeenCalledTimes(1);

      netInfoHandler(createNetState(false));
      expect(task.pause).toHaveBeenCalledTimes(1);
      netInfoHandler(createNetState(false));
      expect(task.pause).toHaveBeenCalledTimes(1); // Should be unchanged
    });

    it("should respect activeNetworkTypes", async () => {
      const queue = new DownloadQueue();

      await queue.init({
        domain: "mydomain",
        activeNetworkTypes: ["wifi", "ethernet"],
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });
      await queue.addUrl("http://foo.com/a.mp3");
      expect(task.pause).not.toHaveBeenCalled();

      const state = createNetState(true);

      state.type = "wifi" as NetInfoStateType.wifi;
      netInfoHandler(state);
      expect(task.pause).not.toHaveBeenCalled();

      state.type = "cellular" as NetInfoStateType.cellular;
      netInfoHandler(state);
      expect(task.pause).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      state.type = "ethernet" as NetInfoStateType.ethernet;
      netInfoHandler(state);
      expect(task.pause).toHaveBeenCalledTimes(1);
      expect(task.resume).toHaveBeenCalledTimes(1);
    });

    it("should not resume when activeNetworkTypes forbids it", async () => {
      const queue = new DownloadQueue();
      const state = createNetState(true);

      await queue.init({
        domain: "mydomain",
        activeNetworkTypes: ["wifi", "ethernet"],
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });
      await queue.addUrl("http://foo.com/a.mp3");

      state.type = "cellular" as NetInfoStateType.cellular;
      netInfoHandler(state);
      expect(task.pause).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      queue.pauseAll();
      expect(task.pause).toHaveBeenCalledTimes(2);
      expect(task.resume).not.toHaveBeenCalled();

      queue.resumeAll();
      expect(task.pause).toHaveBeenCalledTimes(2);
      expect(task.resume).not.toHaveBeenCalled();

      state.type = "ethernet" as NetInfoStateType.ethernet;
      netInfoHandler(state);
      expect(task.pause).toHaveBeenCalledTimes(2);
      expect(task.resume).toHaveBeenCalledTimes(1);
    });

    it("should refuse to set active network types without netInfoFetchState", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await expect(queue.setActiveNetworkTypes(["wifi"])).rejects.toThrow();
    });

    it("should do nothing when setting same active network types", async () => {
      const queue = new DownloadQueue();

      await queue.init({
        domain: "mydomain",
        activeNetworkTypes: ["wifi", "ethernet"],
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });
      expect(addEventListener).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);

      await queue.setActiveNetworkTypes(["ethernet", "wifi"]);
      expect(fetch).toHaveBeenCalledTimes(1); // no change

      await queue.setActiveNetworkTypes(["ethernet", "wifi", "cellular"]);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("should update activeNetworkTypes to current conditions", async () => {
      const queue = new DownloadQueue();
      const state = createNetState(true);

      await queue.init({
        domain: "mydomain",
        activeNetworkTypes: ["wifi", "ethernet"],
        netInfoAddEventListener: addEventListener,
        netInfoFetchState: fetch,
      });

      await queue.addUrl("http://foo.com/a.mp3");
      expect(task.pause).not.toHaveBeenCalled();

      state.type = "cellular" as NetInfoStateType.cellular;
      netInfoHandler(state);
      expect(task.pause).toHaveBeenCalledTimes(1);

      // It should resume now that active network types have changed
      (fetch as jest.Mock).mockResolvedValueOnce(state);
      await queue.setActiveNetworkTypes(["bebop", "cellular"]);
      expect(task.pause).toHaveBeenCalledTimes(1);
      expect(task.resume).toHaveBeenCalledTimes(1);

      // It should have no effect now that we're back to wifi
      await queue.setActiveNetworkTypes(["ethernet", "wifi"]);
      expect(task.pause).toHaveBeenCalledTimes(1);
      expect(task.resume).toHaveBeenCalledTimes(1);
    });
  });

  describe("Retrying errored downloads", () => {
    it("should retry errored downloads", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation((spec: { id: string }) =>
        Object.assign(task, {
          id: spec.id,
          done: jest.fn((handler: DoneHandler) => {
            task._done = handler;
            return task;
          }),
          error: (handler: ErrorHandler) => {
            task._error = handler;
            return task;
          },
        })
      );
      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      expect(download).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._error!("something went wrong", "500");
      expect(jest.getTimerCount()).toBe(1); // The interval should be set

      await advanceThroughNextTimersAndPromises();
      expect(download).toHaveBeenCalledTimes(2); // Should have tried again

      await advanceThroughNextTimersAndPromises();
      // Previous task should still be active, so no more download() calls
      expect(download).toHaveBeenCalledTimes(2);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();
      // The interval should be cleared on successful downloads
      expect(jest.getTimerCount()).toBe(0);
    });

    it("should only use one interval despite several errors", async () => {
      const queue = new DownloadQueue();
      const doneMap: { [id: string]: DoneHandler } = {};
      const errMap: { [id: string]: ErrorHandler } = {};

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        // You need local copies to maintain different ids per object
        const localTask = createBasicTask();
        return Object.assign(localTask, {
          id: spec.id,
          done: jest.fn((handler: DoneHandler) => {
            doneMap[spec.id] = handler;
            return localTask;
          }),
          error: (handler: ErrorHandler) => {
            errMap[spec.id] = handler;
            return localTask;
          },
        });
      });
      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://moo.com/a.mp3");

      expect(jest.getTimerCount()).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Object.values(errMap)[0]!("something went wrong", "500");
      expect(jest.getTimerCount()).toBe(1); // The interval should be set

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Object.values(errMap)[1]!("something else went wrong", "403");
      expect(jest.getTimerCount()).toBe(1);

      // Get downloads scheduled
      await advanceThroughNextTimersAndPromises();

      // Now pretend to finish one successfully.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Object.values(doneMap)[0]!();
      expect(jest.getTimerCount()).toBe(1); // Still need an interval the other.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Object.values(doneMap)[1]!();
      expect(jest.getTimerCount()).toBe(0); // Now finally done
    });

    it("should not be retrying while paused", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation((spec: { id: string }) =>
        Object.assign(task, {
          id: spec.id,
          error: (handler: ErrorHandler) => {
            task._error = handler;
            return task;
          },
        })
      );
      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._error!("something went wrong", "500");
      expect(jest.getTimerCount()).toBe(1); // The interval should be set

      queue.pauseAll();
      expect(jest.getTimerCount()).toBe(0);

      queue.resumeAll();
      expect(jest.getTimerCount()).toBe(1);

      queue.terminate(); // Don't leave timers floating after this test
    });

    it("should cancel retries when terminated", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation((spec: { id: string }) =>
        Object.assign(task, {
          id: spec.id,
          error: (handler: ErrorHandler) => {
            task._error = handler;
            return task;
          },
        })
      );
      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._error!("something went wrong", "500");
      expect(jest.getTimerCount()).toBe(1); // The interval should be set

      queue.terminate();
      expect(jest.getTimerCount()).toBe(0); // The interval should be set
    });
  });

  describe("Utility functions", () => {
    it("should give you back a url you never added explicitly", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      const url = await queue.getAvailableUrl("http://foo.com/a.mp3");

      expect(url).toBe("http://foo.com/a.mp3");
    });

    it("should handle a case where spec is finished but file is missing", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation(() =>
        Object.assign(task, {
          done: jest.fn((handler: DoneHandler) => {
            task._done = handler;
            return task;
          }),
        })
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      // Mark it finished... but RNFS will say the file's not there.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();

      const url = await queue.getAvailableUrl("http://foo.com/a.mp3");
      expect(url).toBe("http://foo.com/a.mp3");
    });

    it("should download correctly on Android as well", async () => {
      Platform.OS = "android";
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation(() =>
        Object.assign(task, {
          done: jest.fn((handler: DoneHandler) => {
            task._done = handler;
            return task;
          }),
        })
      );
      (exists as jest.Mock).mockReturnValue(true);

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();

      const statuses = await queue.getQueueStatus();
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://foo.com/a.mp3",
            complete: true,
          }),
        ])
      );
      Platform.OS = "ios";
    });

    it("should give the right URL depending on download status", async () => {
      const queue = new DownloadQueue();
      const fooTask = createBasicTask();
      let fooPath = "tbd";

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string; destination: string }) => {
          if (spec.url === "http://foo.com/a.mp3") {
            fooPath = spec.destination;
            return Object.assign(fooTask, {
              done: jest.fn((handler: DoneHandler) => {
                fooTask._done = handler;
                return fooTask;
              }),
            });
          }
          return {
            ...task,
            id: spec.id,
            path: spec.destination,
          };
        }
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://boo.com/a.mp3");

      // Pretend we've downloaded only foo
      (exists as jest.Mock).mockImplementation(path => path === fooPath);

      const unfinishedUrl = await queue.getAvailableUrl("http://foo.com/a.mp3");

      expect(unfinishedUrl).toBe("http://foo.com/a.mp3");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await fooTask._done!();

      const [fooU, booU] = await Promise.all([
        queue.getAvailableUrl("http://foo.com/a.mp3"),
        queue.getAvailableUrl("http://boo.com/a.mp3"),
      ]);

      expect(fooU).toBe(fooPath);
      expect(booU).toBe("http://boo.com/a.mp3");

      const restartedQueue = new DownloadQueue();

      await restartedQueue.init({ domain: "mydomain" });
      const [fooUR, statuses] = await Promise.all([
        restartedQueue.getAvailableUrl("http://foo.com/a.mp3"),
        restartedQueue.getQueueStatus(),
      ]);

      // Make sure the finished status is persisted
      expect(fooUR).toBe(fooPath);
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://foo.com/a.mp3",
            complete: true,
          }),
        ])
      );
    });

    it("should give you back the remote url when spec is lazy-deleted", async () => {
      const queue = new DownloadQueue();
      const fooTask = createBasicTask();
      let fooPath = "tbd";

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string; destination: string }) => {
          if (spec.url === "http://foo.com/a.mp3") {
            fooPath = spec.destination;
            return Object.assign(fooTask, {
              done: jest.fn((handler: DoneHandler) => {
                fooTask._done = handler;
                return fooTask;
              }),
            });
          }
          return {
            ...task,
            id: spec.id,
            path: spec.destination,
          };
        }
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.addUrl("http://boo.com/a.mp3");

      // Pretend we've downloaded only foo
      (exists as jest.Mock).mockImplementation(path => path === fooPath);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await fooTask._done!();
      await queue.removeUrl("http://foo.com/a.mp3", Date.now() + 50000);

      const [fooU, booU] = await Promise.all([
        queue.getAvailableUrl("http://foo.com/a.mp3"),
        queue.getAvailableUrl("http://boo.com/a.mp3"),
      ]);

      expect(fooU).toBe("http://foo.com/a.mp3"); // Should give us remote URL
      expect(booU).toBe("http://boo.com/a.mp3");

      const restartedQueue = new DownloadQueue();

      await restartedQueue.init({ domain: "mydomain" });
      const [fooUR, statuses] = await Promise.all([
        restartedQueue.getAvailableUrl("http://foo.com/a.mp3"),
        restartedQueue.getQueueStatus(),
      ]);

      // We should be sure that the lazy-deleted status is reported as !complete
      expect(fooUR).toBe("http://foo.com/a.mp3"); // Should give us remote URL
      expect(statuses.length).toBe(1); // only boo should be left
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "http://boo.com/a.mp3",
            complete: false,
          }),
        ])
      );
    });

    it("should call handlers for all cases", async () => {
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
        onProgress: jest.fn(),
        onDone: jest.fn(),
        onError: jest.fn(),
      };
      const queue = new DownloadQueue();

      Object.assign(task, {
        id: "foo",
        begin: jest.fn(handler => {
          task._begin = handler;
          return task;
        }),
        progress: jest.fn(handler => {
          task._progress = handler;
          return task;
        }),
        done: jest.fn(handler => {
          task._done = handler;
          return task;
        }),
        error: jest.fn(handler => {
          task._error = handler;
          return task;
        }),
      });

      await queue.init({ domain: "mydomain", handlers });
      await queue.addUrl("http://foo.com/a.mp3");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._begin!({ expectedBytes: 300, headers: {} });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._progress!(0.5, 500, 1000);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._error!("foo", 500);

      expect(handlers.onBegin).toHaveBeenCalledTimes(1);
      expect(handlers.onProgress).toHaveBeenCalledTimes(1);
      expect(handlers.onDone).toHaveBeenCalledTimes(1);
      expect(handlers.onError).toHaveBeenCalledTimes(1);
    });

    it("should call done handler with local path when finished", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onDone: jest.fn(),
      };

      let doner: DoneHandler | undefined;

      (download as jest.Mock).mockImplementation(
        (spec: { id: string }): TaskWithHandlers => {
          return Object.assign(task, {
            id: spec.id,
            done: (handler: DoneHandler) => {
              doner = handler;
              return task;
            },
          });
        }
      );
      await queue.init({ domain: "mydomain", handlers, urlToPath });
      await queue.addUrl("http://foo.com/a.mp3");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await doner!();

      expect(handlers.onDone).toHaveBeenCalledWith(
        "http://foo.com/a.mp3",
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}.mp3`
      );
    });

    it("should limp along with an invalid download url", async () => {
      const queue = new DownloadQueue();
      const handlers: DownloadQueueHandlers = {
        onDone: jest.fn(),
      };

      (download as jest.Mock).mockImplementation(
        (spec: { id: string }): TaskWithHandlers => {
          return Object.assign(task, {
            id: spec.id,
            done: (handler: DoneHandler) => {
              task._done = handler;
              return task;
            },
          });
        }
      );

      await queue.init({ domain: "mydomain", handlers });
      await queue.addUrl("http:invalid.url");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();

      expect(handlers.onDone).toHaveBeenCalledWith(
        "http:invalid.url",
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${task.id}`
      );
    });

    it("should throw when a rogue task gets done", async () => {
      const handlers: DownloadQueueHandlers = {
        onDone: jest.fn(),
      };
      const queue = new DownloadQueue();
      let doner: DoneHandler;

      Object.assign(task, {
        id: "foo",
        done: jest.fn(handler => {
          doner = handler;
          return task;
        }),
      });

      await queue.init({ domain: "mydomain", handlers });
      await queue.addUrl("http://foo.com/a.mp3");
      await queue.removeUrl("http://foo.com/a.mp3");

      // Normally, done() shouldn't be called by the framework after a url has
      // been removed (because removeUrl calls stop()). But we want to be extra
      // careful not to crash or falsely say it's done.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await expect(doner!()).resolves.not.toThrow();
      expect(handlers.onDone).not.toHaveBeenCalled();
    });
  });
});
