const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { listUsbDrives } = require('./backend/usb-detect');
const { writeIso, cancelWrite } = require('./backend/iso-writer');
const { formatDrive } = require('./backend/formatter');
const { calculateHashes } = require('./backend/hash-calc');
const fs = require('fs');

let mainWindow;
let pollInterval;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 750,
    minWidth: 460,
    minHeight: 750,
    resizable: true,
    frame: false,
    icon: path.join(__dirname, 'src', 'icons', 'rufus.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#f0f0f0'
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Remove menu bar
  Menu.setApplicationMenu(null);

  // Start USB polling
  pollInterval = setInterval(async () => {
    try {
      const drives = await listUsbDrives();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('usb-drives-updated', drives);
      }
    } catch (err) {
      console.error('USB poll error:', err);
    }
  }, 2000);

  // Initial scan
  setTimeout(async () => {
    try {
      const drives = await listUsbDrives();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('usb-drives-updated', drives);
      }
    } catch (err) {
      console.error('Initial USB scan error:', err);
    }
  }, 500);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pollInterval) clearInterval(pollInterval);
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (pollInterval) clearInterval(pollInterval);
  app.quit();
});

// IPC Handlers

// Window controls
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// Select ISO file
ipcMain.handle('select-iso', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open ISO Image',
    filters: [
      { name: 'ISO Images', extensions: ['iso', 'img'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  
  const filePath = result.filePaths[0];
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stats.size
  };
});

// List USB drives
ipcMain.handle('list-devices', async () => {
  try {
    return await listUsbDrives();
  } catch (err) {
    console.error('list-devices error:', err);
    return [];
  }
});

// Start flashing
ipcMain.handle('start-flash', async (event, options) => {
  // options: { isoPath, devicePath, bootSelection, partitionScheme, fileSystem, volumeLabel, clusterSize, quickFormat }
  try {
    if (options.bootSelection === 'non-bootable') {
      // Non-bootable format
      await formatDrive(options, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('flash-progress', progress);
        }
      });
    } else {
      // ISO flash
      await writeIso(options, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('flash-progress', progress);
        }
      });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Cancel flash
ipcMain.handle('cancel-flash', async () => {
  try {
    cancelWrite();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Calculate hashes
ipcMain.handle('calculate-hashes', async (event, filePath) => {
  try {
    const hashes = await calculateHashes(filePath, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hash-progress', progress);
      }
    });
    return hashes;
  } catch (err) {
    return { error: err.message };
  }
});

// Get ISO file info
ipcMain.handle('get-iso-info', async (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    const name = path.basename(filePath);
    // Try to determine if it's a Windows or Linux ISO from filename
    const isWindows = /win|windows/i.test(name);
    const isUbuntu = /ubuntu/i.test(name);
    const isDebian = /debian/i.test(name);
    const isFedora = /fedora/i.test(name);
    const isLinux = isUbuntu || isDebian || isFedora || /linux|mint|arch|manjaro|opensuse|centos/i.test(name);
    
    return {
      path: filePath,
      name: name,
      size: stats.size,
      isWindows,
      isLinux,
      label: name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').substring(0, 32)
    };
  } catch (err) {
    return null;
  }
});
