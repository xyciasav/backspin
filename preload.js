"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("backspinDesktop", {
  chooseMusicFolder: () => ipcRenderer.invoke("music:choose-folder"),
  chooseMusicFiles: () => ipcRenderer.invoke("music:choose-files"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.send("updates:install"),
  onUpdateStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
  platform: process.platform
});
