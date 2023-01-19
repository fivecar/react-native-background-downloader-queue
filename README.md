# react-native-background-download-queue

[![npm package][npm-img]][npm-url]
[![Build Status][build-img]][build-url]
[![Downloads][downloads-img]][downloads-url]
[![Issues][issues-img]][issues-url]
[![Code Coverage][codecov-img]][codecov-url]
[![Commitizen Friendly][commitizen-img]][commitizen-url]
[![Semantic Release][semantic-release-img]][semantic-release-url]

Automatically download files from urls, even in the background, and keep them locally cached with little headache or babysitting.
* Enhances `downloadFile` from `react-native-fs` by supporting background downloads on iOS (i.e. downloads will continue even if you close your app) by using `react-native-background-downloader`.
* Automatically resumes suspended downloads when you next launch your app.
* Reconciles all your cached/downloaded files with a set of URLs you can change at any time. This way, you can just manage the list of URLs you want at any time, and everything else is taken care of for you.
* Supports lazy deletion.
* Automation-tested with 100% code coverage.

## Install

First install peer dependencies:
* [react-native-background-downloader](https://github.com/kesha-antonov/react-native-background-downloader#readme)
* [react-native-fs](https://github.com/itinance/react-native-fs#readme)
* [@react-native-async-storage/async-storage](https://github.com/react-native-async-storage/async-storage#readme)

Once those are done, install this package:

```bash
npm install react-native-background-download-queue
```
or
```bash
yarn add react-native-background-download-queue
```

## Example

```Typescript
import DownloadQueue from "react-native-background-download-queue";

new DownloadQueue({
  onBegin: (url, bytes) => console.log("Download started", url, bytes),
  onDone: url => console.log("Download finished", url),
  onError: (url, error) => console.log("Download error", url, error),
  onProgress: (url, fraction, bytes, totalBytes) => console.log("Download progress", url, fraction, bytes, totalBytes)
);

await downloader.init();
await downloader.addUrl("https://example.com/boo.mp3");

...
// This path will either be a local path if the file has been 
// downloaded. If not, you'll get the remote url.
const localOrRemotePath = await downloader.getAvailableUrl("https://example.com/boo.mp3");

// ... use localOrRemotePath in <Image> or a media playing API
```

## API

For full documentation, see the javaDoc style comments in the package which automatically come up in VS Code when you use this library.

### `constructor(handlers?: DownloadQueueHandlers, domain = "main")`

Creates a new instance of DownloadQueue. You must call init before actually using it.

### `async init(startActive = true): Promise<void>`

Reconstitutes state from storage and reconciles it with downloads that might have completed in the background. Always call this before using the rest of the class.

### `terminate(): void`

Terminates all pending downloads and stops all activity, including
processing lazy-deletes. You can re-init() if you'd like -- but in most cases where you plan to re-init, `pause()` might be what you really meant.

### `async addUrl(url: string): Promise<void>`

Downloads a url to the local documents directory. Safe to call if it's already been added before. If it's been lazy-deleted, it'll be revived.

### `async removeUrl(url: string, deleteTime = -1): Promise<void>`

Removes a url record and any associated file that's been downloaded. Can optionally be a lazy delete if you pass a `deleteTime` timestamp.

### `async setQueue(urls: string[], deleteTime = -1): Promise<void>`

Sets the sum total of urls to keep in the queue. If previously-added urls don't show up here, they'll be removed. New urls will be added.

### `pauseAll(): void`

Pauses all active downloads. Most used to implement wifi-only downloads, by pausing when NetInfo reports a non-wifi connection.

### `resumeAll(): void`

Resumes all active downloads that were previously paused. If you `init()` with `startActive === false`, you'll want to call this at some point or else downloads will never happen.

### `async getAvailableUrl(url: string): Promise<string>`

Gets a remote or local url, preferring to the local path when possible. If the local file hasn't yet been downloaded, returns the remote url.


[build-img]:https://github.com/fivecar/react-native-background-download-queue/actions/workflows/release.yml/badge.svg
[build-url]:https://github.com/fivecar/react-native-background-download-queue/actions/workflows/release.yml
[downloads-img]:https://img.shields.io/npm/dt/react-native-background-download-queue
[downloads-url]:https://www.npmtrends.com/react-native-background-download-queue
[npm-img]:https://img.shields.io/npm/v/react-native-background-download-queue
[npm-url]:https://www.npmjs.com/package/react-native-background-download-queue
[issues-img]:https://img.shields.io/github/issues/fivecar/react-native-background-download-queue
[issues-url]:https://github.com/fivecar/react-native-background-download-queue/issues
[codecov-img]:https://codecov.io/gh/fivecar/react-native-background-download-queue/branch/main/graph/badge.svg
[codecov-url]:https://codecov.io/gh/fivecar/react-native-background-download-queue
[semantic-release-img]:https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg
[semantic-release-url]:https://github.com/semantic-release/semantic-release
[commitizen-img]:https://img.shields.io/badge/commitizen-friendly-brightgreen.svg
[commitizen-url]:http://commitizen.github.io/cz-cli/
