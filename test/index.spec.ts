import DownloadQueue from "../src";

describe("DownloadQueue", () => {
  describe("Basics", () => {
    it("should throw when uninitialized", async () => {
      const queue = new DownloadQueue();

      await expect(() => queue.addUrl("whatevs")).rejects.toThrow();
      await expect(() => queue.removeUrl("whatevs")).rejects.toThrow();
    });

    it("initializes properly", async () => {
      const queue = new DownloadQueue();

      await expect(queue.init()).resolves.not.toThrow();
    });
  });
});
