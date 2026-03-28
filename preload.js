const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rufus', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // USB devices
  listDevices: () => ipcRenderer.invoke('list-devices'),
  onDrivesUpdated: (callback) => {
    ipcRenderer.on('usb-drives-updated', (event, drives) => callback(drives));
  },

  // ISO operations
  selectIso: () => ipcRenderer.invoke('select-iso'),
  getIsoInfo: (filePath) => ipcRenderer.invoke('get-iso-info', filePath),

  // Flash operations
  startFlash: (options) => ipcRenderer.invoke('start-flash', options),
  cancelFlash: () => ipcRenderer.invoke('cancel-flash'),
  onFlashProgress: (callback) => {
    ipcRenderer.on('flash-progress', (event, progress) => callback(progress));
  },

  // Hash calculation
  calculateHashes: (filePath) => ipcRenderer.invoke('calculate-hashes', filePath),
  onHashProgress: (callback) => {
    ipcRenderer.on('hash-progress', (event, progress) => callback(progress));
  }
});
