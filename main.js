const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { listUsbDrives } = require('./backend/usb-detect');
const { writeIso, cancelWrite } = require('./backend/iso-writer');
const { formatDrive } = require('./backend/formatter');
const { calculateHashes } = require('./backend/hash-calc');
const { checkTools, deviceSizeBytes } = require('./backend/shell');
const wtg = require('./backend/windows-to-go');
const fs = require('fs');

let mainWindow;
let pollInterval;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

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
      send('usb-drives-updated', drives);
    } catch (err) {
      console.error('USB poll error:', err);
    }
  }, 2000);

  // Initial scan
  setTimeout(async () => {
    try {
      const drives = await listUsbDrives();
      send('usb-drives-updated', drives);
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
  // options: { isoPath, devicePath, bootSelection, imageOption, partitionScheme,
  //            fileSystem, volumeLabel, clusterSize, quickFormat, wtgImage }
  const progress = (payload) => send('flash-progress', payload);

  try {
    if (options.imageOption === 'windows-to-go') {
      // Real Windows To Go: apply the Enterprise/Education image and build a
      // boot configuration that boots winload from the USB stick.
      await wtg.createWindowsToGo({
        isoPath: options.isoPath,
        devicePath: options.devicePath,
        image: options.wtgImage,
        volumeLabel: 'WINDOWS TO GO',
        locale: options.wtgLocale
      }, progress);
    } else if (options.bootSelection === 'non-bootable') {
      await formatDrive(options, progress);
    } else {
      await writeIso(options, progress);
    }
    return { success: true };
  } catch (err) {
    console.error('start-flash error:', err);
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

// Report which helper programs are available, so the UI can explain what to
// install before an operation fails halfway through.
ipcMain.handle('check-tools', async () => {
  const base = checkTools();
  const windowsToGo = checkTools(wtg.REQUIRED_TOOLS);
  return {
    missing: base.missing,
    windowsToGo: { missing: windowsToGo.missing }
  };
});

// Read the Windows image and report what Windows To Go would install.
ipcMain.handle('inspect-windows-to-go', async (event, { isoPath, devicePath }) => {
  try {
    const targetSizeBytes = await deviceSizeBytes(devicePath);
    const plan = await wtg.inspectWindowsToGo({ isoPath, devicePath, targetSizeBytes });
    return { success: true, ...plan, targetSizeBytes };
  } catch (err) {
    console.error('inspect-windows-to-go error:', err);
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
    const isWindows = /windows|win(7|8|10|11|server)/i.test(name);
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
