"use strict";

const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");
const { findAudioFiles, isAudioPath } = require("./library-scan");

protocol.registerSchemesAsPrivileged([{
  scheme: "backspin-media",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
}]);

const mediaFiles = new Map();

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#090a0e",
    title: "Backspin",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.loadFile("index.html");
  window.webContents.on("did-finish-load", () => {
    sendUpdateStatus(window, "checking", "Checking for updates…");
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(error => {
      sendUpdateStatus(window, "error", `Update check failed: ${error.message}`);
    });
    else sendUpdateStatus(window, "development", "Development build");
  });
  return window;
}

function sendUpdateStatus(window, state, message, extra = {}) {
  if (!window?.isDestroyed()) window.webContents.send("updates:status", { state, message, ...extra });
}

function configureUpdater(window) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => sendUpdateStatus(window, "checking", "Checking for updates…"));
  autoUpdater.on("update-available", info => sendUpdateStatus(window, "downloading", `Downloading Backspin ${info.version}…`, { version: info.version }));
  autoUpdater.on("update-not-available", () => sendUpdateStatus(window, "current", "Backspin is up to date"));
  autoUpdater.on("download-progress", progress => {
    sendUpdateStatus(window, "downloading", `Downloading update · ${Math.round(progress.percent)}%`, { percent: progress.percent });
  });
  autoUpdater.on("update-downloaded", info => {
    sendUpdateStatus(window, "ready", `Backspin ${info.version} is ready to install`, { version: info.version });
  });
  autoUpdater.on("error", error => sendUpdateStatus(window, "error", `Update error: ${error.message}`));
}

ipcMain.handle("music:choose-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a music folder",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return { files: [], skipped: 0, warnings: [] };

  const root = result.filePaths[0];
  const scan = await findAudioFiles(root);
  return readSelectedFiles(scan.paths, root, scan.warnings);
});

ipcMain.handle("music:choose-files", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose music files",
    properties: ["openFile", "multiSelections"],
    filters: [{
      name: "Music",
      extensions: ["mp3", "wav", "wave", "m4a", "mp4", "aac", "flac", "ogg", "oga", "opus", "aif", "aiff", "alac", "wma"]
    }]
  });
  if (result.canceled) return { files: [], skipped: 0, warnings: [] };
  return readSelectedFiles(result.filePaths.filter(isAudioPath), "", []);
});

ipcMain.handle("updates:check", async event => {
  if (!app.isPackaged) return { state: "development", message: "Updates work in installed builds" };
  const window = BrowserWindow.fromWebContents(event.sender);
  sendUpdateStatus(window, "checking", "Checking for updates…");
  await autoUpdater.checkForUpdates();
  return { state: "checking" };
});

ipcMain.on("updates:install", () => autoUpdater.quitAndInstall(false, true));

async function readSelectedFiles(paths, root, warnings) {
  const settled = await Promise.allSettled(paths.map(async filePath => {
    const stat = await fs.stat(filePath);
    const token = crypto.randomUUID();
    mediaFiles.set(token, filePath);
    return {
      name: path.basename(filePath),
      size: stat.size,
      relativePath: root ? path.relative(root, filePath) : path.basename(filePath),
      url: `backspin-media://track/${token}`
    };
  }));
  const files = settled.filter(item => item.status === "fulfilled").map(item => item.value);
  const failed = settled.filter(item => item.status === "rejected");
  return {
    files,
    skipped: failed.length,
    warnings: [...warnings, ...failed.slice(0, 20).map(item => ({ reason: item.reason?.code || item.reason?.message || "unreadable" }))]
  };
}

app.whenReady().then(() => {
  protocol.handle("backspin-media", request => {
    const url = new URL(request.url);
    const token = url.pathname.replace(/^\/+/, "");
    const filePath = mediaFiles.get(token);
    if (!filePath) return new Response("Track not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString(), {
      headers: request.headers
    });
  });
  const window = createWindow();
  configureUpdater(window);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
