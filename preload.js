// why is there so much boiler player just to send some data smh
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  sendData: (callback) => ipcRenderer.on('sendData', (_event, value) => callback(value))
})
