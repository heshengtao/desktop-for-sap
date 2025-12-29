const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  finishShot: (rect) => ipcRenderer.send('screenshot-selected', rect),
  cancelShot:  () => ipcRenderer.send('screenshot-selected', null)
})
