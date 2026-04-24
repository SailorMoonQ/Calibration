const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calib', {
  getBackend: () => ipcRenderer.invoke('backend:info'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
  pickSaveFile: (opts) => ipcRenderer.invoke('dialog:pickSaveFile', opts),
  pickOpenFile: (opts) => ipcRenderer.invoke('dialog:pickOpenFile', opts),
  platform: process.platform,
});
