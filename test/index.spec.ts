import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addEventListener,
  NetInfoState,
  NetInfoStateType,
} from "@react-native-community/netinfo";
import { mock } from "jest-mock-extended";
import KVFS from "key-value-file-system";
import { Platform } from "react-native";
import {
  BeginHandler,
  checkForExistingDownloads,
  DoneHandler,
  download,
  DownloadTask,
  ErrorHandler,
  ProgressHandler,
} from "react-native-background-downloader";
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
jest.mock("react-native-background-downloader", () => ({
  checkForExistingDownloads: jest.fn(() => []),
  download: jest.fn(() => ({})),
  completeHandler: jest.fn(),
}));

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
}

let netInfoHandler: (state: NetInfoState) => void;

jest.mock("@react-native-community/netinfo", () => ({
  addEventListener: jest.fn(handler => {
    netInfoHandler = handler;
    return jest.fn();
  }),
}));

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
  });

  afterEach(async () => {
    await kvfs.rmAllForce();
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

    it("deletes files without specs upon init", async () => {
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

    it("doesn't delete files that have specs on init", async () => {
      const queue = new DownloadQueue();

      (readdir as jest.Mock).mockImplementation(() => ["foo", "bar"]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
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

    it("revives specs from previous launches", async () => {
      const queue = new DownloadQueue();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      expect(task.resume).toHaveBeenCalledTimes(1);
    });

    it("stops tasks from previous launches without specs ", async () => {
      const queue = new DownloadQueue();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await queue.init({ domain: "mydomain" });
      expect(task.stop).toHaveBeenCalledTimes(1);
    });

    it("starts downloads for specs without tasks or files", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      expect(task.resume).not.toHaveBeenCalled();

      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ id: "foo" })
      );
    });
  });

  describe("Termination", () => {
    it("should stop all active tasks", async () => {
      const queue = new DownloadQueue();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      expect(task.resume).toHaveBeenCalled();

      queue.terminate();
      expect(task.stop).toHaveBeenCalled();
    });

    it("should restart tasks after terminate/re-init", async () => {
      const queue = new DownloadQueue();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain" });
      expect(task.resume).toHaveBeenCalled();

      queue.terminate();
      expect(task.stop).toHaveBeenCalled();

      await queue.init({ domain: "mydomain" });
      expect(task.resume).toHaveBeenCalledTimes(2);
    });

    it("should refuse to work without re-init", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      queue.terminate();

      await expectPublicsToFail(queue);

      await queue.init({ domain: "mydomain" });
      await expect(queue.addUrl("http://foo.com")).resolves.not.toThrow();
    });
  });

  describe("Adding", () => {
    it("should add a url", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://foo.com" })
      );
    });

    it("shouldn't add the same url twice", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockReturnValue(task);

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://foo.com");
      expect(download).toHaveBeenCalledTimes(1);
    });

    it("should revive added url upon relaunch", async () => {
      const queue = new DownloadQueue();
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        assignedId = spec.id;
        return task;
      });
      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([
        {
          ...task,
          id: assignedId,
        },
      ]);

      // Pretend app got launched again by using another queue
      const relaunchQueue = new DownloadQueue();

      await relaunchQueue.init({ domain: "mydomain" });
      expect(task.resume).toHaveBeenCalled();
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
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      (exists as jest.Mock).mockImplementation(() => true);

      await queue.removeUrl("http://foo.com", 0);
      await queue.addUrl("http://foo.com");

      expect(exists).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledTimes(2); // Because it hadn't finished

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await doner!();
      await queue.removeUrl("http://foo.com", 0);
      await queue.addUrl("http://foo.com");

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
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      await queue.removeUrl("http://foo.com");

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
      await queue.addUrl("http://foo.com");

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "DownloadQueue/mydomain/" + assignedId,
        expect.anything()
      );

      await queue.removeUrl("http://foo.com");
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
      await queue.addUrl("http://foo.com");

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "DownloadQueue/mydomain/" + assignedId,
        expect.anything()
      );

      await queue.removeUrl("http://foo.com");
      await queue.removeUrl("http://foo.com");
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
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.addUrl("http://moo.com");

      await queue.setQueue([
        "http://foo.com",
        "http://moo.com",
        "http://shoo.com",
      ]);

      expect(unlink).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        "DownloadQueue/mydomain/" + idMap["http://boo.com"],
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://shoo.com" })
      );
      expect(download).toHaveBeenCalledTimes(4);
    });
  });

  describe("Getting queue status", () => {
    it("it should return status on a single file", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }): Partial<TaskWithHandlers> =>
          spec.url === "http://boo.com"
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
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");

      const res = await queue.getStatus("http://foo.com");
      expect(res).toEqual(
        expect.objectContaining({ url: "http://foo.com", complete: false })
      );

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();
      const resBoo = await queue.getStatus("http://boo.com");
      expect(resBoo).toEqual(
        expect.objectContaining({ url: "http://boo.com", complete: true })
      );
    });

    it("it should return the same status as a single or a group", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");

      const res = await queue.getStatus("http://foo.com");
      expect(res).toEqual(
        expect.objectContaining({ url: "http://foo.com", complete: false })
      );

      const arrRes = await queue.getQueueStatus();
      expect(arrRes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: "http://foo.com", complete: false }),
        ])
      );
    });

    it("it should not return status on a single lazy-deleted file", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");
      await queue.removeUrl("http://foo.com", Date.now() + 3000);

      const res = await queue.getStatus("http://foo.com");
      expect(res).toEqual(null);
    });

    it("it should return yet-to-be downloaded files", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.setQueue([
        "http://foo.com",
        "http://moo.com",
        "http://boo.com",
      ]);
      const res = await queue.getQueueStatus();
      expect(res).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: "http://foo.com", complete: false }),
          expect.objectContaining({ url: "http://boo.com", complete: false }),
          expect.objectContaining({ url: "http://moo.com", complete: false }),
        ])
      );
      expect(res.length).toEqual(3);
    });

    it("it should return downloaded files", async () => {
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
        "http://foo.com",
        "http://moo.com",
        "http://boo.com",
      ]);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://foo.com"]._done!();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://boo.com"]._done!();

      const res = await queue.getQueueStatus();
      expect(res).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: "http://foo.com", complete: true }),
          expect.objectContaining({ url: "http://boo.com", complete: true }),
          expect.objectContaining({ url: "http://moo.com", complete: false }),
        ])
      );
      expect(res.length).toEqual(3);
    });

    it("it should not return lazy-deleted files", async () => {
      const queue = new DownloadQueue();
      const idMap: { [url: string]: TaskWithHandlers } = {};

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }): Partial<TaskWithHandlers> => {
          const baseTask = mock<TaskWithHandlers>();

          console.log(spec.id, spec.url);
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
        "http://foo.com",
        "http://moo.com",
        "http://boo.com",
      ]);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://foo.com"]._done!();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      idMap["http://boo.com"]._done!();
      await queue.removeUrl("http://boo.com");

      const res = await queue.getQueueStatus();
      expect(res).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: "http://foo.com", complete: true }),
          expect.objectContaining({ url: "http://moo.com", complete: false }),
        ])
      );
      expect(res.length).toEqual(2);
    });
  });

  describe("Lazy deletion", () => {
    it("should not immediately delete lazy-deletions", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");
      await queue.removeUrl("http://foo.com", 0);

      expect(unlink).toHaveBeenCalledTimes(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(0);
    });

    it("should delete only next-init lazy deletions during init", async () => {
      const queue = new DownloadQueue();
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          if (spec.url === "http://foo.com") {
            assignedId = spec.id;
          }
          return {
            ...task,
            id: spec.id,
          };
        }
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.removeUrl("http://foo.com", 0);
      await queue.removeUrl("http://boo.com", Date.now() + 30000);

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
        "http://foo.com": "foo",
        "http://boo.com": "boo",
        "http://moo.com": "moo",
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
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.addUrl("http://moo.com");

      await queue.removeUrl("http://foo.com", 0);
      expect(jest.getTimerCount()).toEqual(0);

      await queue.removeUrl("http://boo.com", Date.now() + 30000);
      await queue.removeUrl("http://moo.com", Date.now() + 180000);

      expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toEqual(2);

      await advanceThroughNextTimersAndPromises();
      expect(jest.getTimerCount()).toEqual(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${urlsToIds["http://boo.com"]}`,
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${urlsToIds["http://boo.com"]}`
        )
      );
      expect(jest.getTimerCount()).toEqual(1);

      await advanceThroughNextTimersAndPromises();
      expect(jest.getTimerCount()).toEqual(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(2);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${urlsToIds["http://moo.com"]}`,
      ]);
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${urlsToIds["http://moo.com"]}`
        )
      );
    });

    it("should revive re-added lazy-deletions", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);

      await queue.removeUrl("http://foo.com", 0);

      expect(unlink).toHaveBeenCalledTimes(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(0);

      await queue.addUrl("http://foo.com");
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
      await queue.addUrl("http://foo.com");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      task._begin!("http://foo.com");
      expect(handlers.onBegin).toHaveBeenCalledTimes(1);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();
      expect(handlers.onDone).toHaveBeenCalledTimes(1);

      await queue.removeUrl("http://foo.com", 0);
      await queue.addUrl("http://foo.com");

      // When we re-add a lazy-deleted download that was already downloaded,
      // we expect to get notifications for begin/done again.
      expect(handlers.onBegin).toHaveBeenCalledTimes(2);
      expect(handlers.onDone).toHaveBeenCalledTimes(2);
    });
  });

  describe("Pause / resume", () => {
    it("should start paused if requested", async () => {
      const queue = new DownloadQueue();

      (checkForExistingDownloads as jest.Mock).mockReturnValue([task]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init({ domain: "mydomain", startActive: false });
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).toHaveBeenCalledTimes(1); // for the revived download
      expect(download).not.toHaveBeenCalled();

      (download as jest.Mock).mockReturnValue(task);

      await queue.addUrl("http://boo.com");
      expect(task.pause).toHaveBeenCalledTimes(2); // for the added download
    });

    it("should pause/resume everything when asked", async () => {
      const queue = new DownloadQueue();

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.addUrl("http://moo.com");

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
      await queue.addUrl("http://foo.com");

      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).not.toHaveBeenCalled();
    });

    it("should pause/resume based on network state when asked", async () => {
      const queue = new DownloadQueue();
      await queue.init({
        domain: "mydomain",
        netInfoAddEventListener: addEventListener,
      });
      await queue.addUrl("http://foo.com");
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
        activeNetworkTypes: undefined,
      });
      await queue.addUrl("http://foo.com");
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
      });
      await queue.addUrl("http://foo.com");

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
      });
      await queue.addUrl("http://foo.com");

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
        startActive: false,
      });
      await queue.addUrl("http://foo.com");
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
      });
      await queue.addUrl("http://foo.com");

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
      });
      await queue.addUrl("http://foo.com");

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
      });
      await queue.addUrl("http://foo.com");
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
      });
      await queue.addUrl("http://foo.com");

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
      await queue.addUrl("http://foo.com");

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
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://moo.com");

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
      await queue.addUrl("http://foo.com");

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
      await queue.addUrl("http://foo.com");

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
      const url = await queue.getAvailableUrl("http://foo.com");

      expect(url).toBe("http://foo.com");
    });

    it("should handle a case where spec is finished but file is missing", async () => {
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation(_ =>
        Object.assign(task, {
          done: jest.fn((handler: DoneHandler) => {
            task._done = handler;
            return task;
          }),
        })
      );

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");

      // Mark it finished... but RNFS will say the file's not there.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();

      const url = await queue.getAvailableUrl("http://foo.com");
      expect(url).toBe("http://foo.com");
    });

    it("should download correctly on Android as well", async () => {
      Platform.OS = "android";
      const queue = new DownloadQueue();

      (download as jest.Mock).mockImplementation(_ =>
        Object.assign(task, {
          done: jest.fn((handler: DoneHandler) => {
            task._done = handler;
            return task;
          }),
        })
      );
      (exists as jest.Mock).mockReturnValue(true);

      await queue.init({ domain: "mydomain" });
      await queue.addUrl("http://foo.com");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await task._done!();

      const statuses = await queue.getQueueStatus();
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: "http://foo.com", complete: true }),
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
          if (spec.url === "http://foo.com") {
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
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");

      // Pretend we've downloaded only foo
      (exists as jest.Mock).mockImplementation(path => path === fooPath);

      const unfinishedUrl = await queue.getAvailableUrl("http://foo.com");

      expect(unfinishedUrl).toBe("http://foo.com");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await fooTask._done!();

      const [fooU, booU] = await Promise.all([
        queue.getAvailableUrl("http://foo.com"),
        queue.getAvailableUrl("http://boo.com"),
      ]);

      expect(fooU).toBe(fooPath);
      expect(booU).toBe("http://boo.com");

      const restartedQueue = new DownloadQueue();

      await restartedQueue.init({ domain: "mydomain" });
      const [fooUR, statuses] = await Promise.all([
        restartedQueue.getAvailableUrl("http://foo.com"),
        restartedQueue.getQueueStatus(),
      ]);

      // Make sure the finished status is persisted
      expect(fooUR).toBe(fooPath);
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: "http://foo.com", complete: true }),
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
      await queue.addUrl("http://foo.com");

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
      await queue.init({ domain: "mydomain", handlers });
      await queue.addUrl("http://foo.com");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await doner!();

      expect(handlers.onDone).toHaveBeenCalledWith(
        "http://foo.com",
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
      await queue.addUrl("http://foo.com");
      await queue.removeUrl("http://foo.com");

      // Normally, done() shouldn't be called by the framework after a url has
      // been removed (because removeUrl calls stop()). But we want to be extra
      // careful not to crash or falsely say it's done.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await expect(doner!()).resolves.not.toThrow();
      expect(handlers.onDone).not.toHaveBeenCalled();
    });
  });
});
