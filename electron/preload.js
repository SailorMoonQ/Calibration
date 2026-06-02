const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calib', {
  getBackend: () => ipcRenderer.invoke('backend:info'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
  pickSaveFile: (opts) => ipcRenderer.invoke('dialog:pickSaveFile', opts),
  pickOpenFile: (opts) => ipcRenderer.invoke('dialog:pickOpenFile', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  platform: process.platform,
});
