const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { startSidecar, stopSidecar } = require('./sidecar');

const isDev = process.env.NODE_ENV === 'development';
let mainWindow = null;
let backend = null;

async function createWindow() {
  backend = await startSidecar({ isDev });

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#f4f5f7',
    title: 'Calibration Workbench',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('backend:info', () => backend ? { port: backend.port, baseUrl: `http://127.0.0.1:${backend.port}` } : null);

ipcMain.handle('dialog:pickFolder', async (_evt, defaultPath) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select calibration dataset folder',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:pickSaveFile', async (_evt, { defaultPath, filters } = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save calibration',
    defaultPath: defaultPath || 'calibration.yaml',
    filters: filters || [
      { name: 'Calibration (YAML / JSON)', extensions: ['yaml', 'yml', 'json'] },
      { name: 'YAML', extensions: ['yaml', 'yml'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('shell:openPath', async (_evt, p) => {
  if (!p) return 'no path';
  return shell.openPath(p);  // returns '' on success, error string otherwise
});

ipcMain.handle('dialog:pickOpenFile', async (_evt, { defaultPath, filters } = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Load calibration',
    defaultPath: defaultPath || undefined,
    properties: ['openFile'],
    filters: filters || [
      { name: 'Calibration (YAML / JSON)', extensions: ['yaml', 'yml', 'json'] },
      { name: 'YAML', extensions: ['yaml', 'yml'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopSidecar();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', stopSidecar);
