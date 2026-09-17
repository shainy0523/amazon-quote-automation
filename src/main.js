'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { readExcelFile } = require('./excel/excelReader');
const { exportSuccessfulItems } = require('./excel/excelExporter');
const LocalBridge = require('./server/localBridge');
const logger = require('./utils/logger');

let mainWindow = null;
let bridge = null;

// In-memory session state only — no database, no persistence beyond export.
let currentRecords = [];
let successfulItems = [];
let failedItems = [];
let selectedFilePath = null;
let bridgeStartError = null;

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

function getUserDataPaths() {
  const base = app.getPath('userData');
  return {
    logDir: path.join(base, 'failure-logs'),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();

  const { logDir } = getUserDataPaths();
  bridge = new LocalBridge({
    logDir,
    onLog: (line) => logger.log(line),
    onProgress: (data) => {
      if (mainWindow) mainWindow.webContents.send('automation:progress', data);
    },
    onStatus: (data) => {
      if (mainWindow) mainWindow.webContents.send('automation:status', data);
    },
    onComplete: (data) => {
      successfulItems = data.successfulItems || [];
      failedItems = data.failedItems || [];
    },
  });

  try {
    const port = await bridge.start(47654);
    logger.log(`Local bridge listening on port ${port} — waiting for browser extension`);
  } catch (err) {
    bridgeStartError = err.message;
    logger.log(`Could not start local bridge server: ${err.message}`);
    dialog.showErrorBox(
      'Local bridge server failed to start',
      `The app could not start its local server on port 47654, so the browser extension will never be able to receive a job.\n\nReason: ${err.message}\n\nThis usually means another program is already using port 47654, or antivirus/firewall software is blocking this app from opening a network port. Close whatever's using that port, or allow this app through your antivirus/firewall, then restart the app.`
    );
  }
});

app.on('window-all-closed', () => {
  if (bridge) bridge.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ---- Forward logger entries to renderer ----
logger.onLog((line) => {
  if (mainWindow) mainWindow.webContents.send('automation:log', line);
});

// ---- IPC handlers (only the specific APIs exposed via preload) ----

ipcMain.handle('automation:selectExcel', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Excel File',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  selectedFilePath = result.filePaths[0];
  return { canceled: false, filePath: selectedFilePath };
});

ipcMain.handle('automation:previewExcel', async () => {
  if (!selectedFilePath) {
    return { valid: false, errors: ['No file selected.'], records: [] };
  }

  try {
    const result = readExcelFile(selectedFilePath);
    currentRecords = result.records;
    logger.log(`Excel loaded: ${selectedFilePath}`);
    if (result.valid) {
      logger.log(`${result.records.length} records detected`);
    } else {
      logger.log(`Validation failed: ${result.errors.length} error(s)`);
    }
    return result;
  } catch (err) {
    logger.log(`Failed to read Excel file: ${err.message}`);
    return { valid: false, errors: [err.message], records: [] };
  }
});

ipcMain.handle('automation:start', async (_event, browserTarget) => {
  if (currentRecords.length === 0) {
    return { started: false, error: 'No valid records to process.' };
  }
  if (!bridge || bridgeStartError) {
    return {
      started: false,
      error: bridgeStartError
        ? `Local bridge server failed to start: ${bridgeStartError}`
        : 'Local bridge server is not running.',
    };
  }
  if (browserTarget !== 'chrome' && browserTarget !== 'firefox') {
    return { started: false, error: 'Select a browser (Chrome or Firefox) before starting.' };
  }

  const config = loadConfig();
  successfulItems = [];
  failedItems = [];

  bridge.createJob({
    quoteUrl: config.quoteUrl,
    records: currentRecords,
    maxRetries: config.maxRetries,
    actionTimeoutMs: config.actionTimeoutMs,
    targetBrowser: browserTarget,
  });

  logger.log(`Job queued for ${browserTarget} — waiting for its extension to pick it up`);
  if (mainWindow) mainWindow.webContents.send('automation:status', { state: 'WAITING_FOR_EXTENSION' });

  return { started: true };
});

ipcMain.handle('automation:stop', async () => {
  if (bridge && bridge.currentJob) {
    bridge.requestStop();
    logger.log('Stop requested by user');
    return { stopped: true };
  }
  return { stopped: false, error: 'Automation not running.' };
});

ipcMain.handle('automation:downloadSuccessfulItems', async () => {
  if (successfulItems.length === 0) {
    return { saved: false, error: 'No successful items to export.' };
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Download Successful Items',
    defaultPath: 'successful_items.xlsx',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }],
  });

  if (result.canceled || !result.filePath) {
    return { saved: false, canceled: true };
  }

  try {
    exportSuccessfulItems(successfulItems, result.filePath);
    logger.log(`Successful items exported to ${result.filePath}`);
    return { saved: true, filePath: result.filePath };
  } catch (err) {
    logger.log(`Export failed: ${err.message}`);
    return { saved: false, error: err.message };
  }
});
