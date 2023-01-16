"use strict";

module.exports = jest.mock("react-native-background-downloader", () => ({
  checkForExistingDownloads: jest.fn(),
  download: jest.fn(),
}));
