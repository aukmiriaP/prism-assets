const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('prism', {
  connection: () => ipcRenderer.invoke('connection'),
  api: (route, method, body) => ipcRenderer.invoke('api', route, method, body),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  chooseImage: () => ipcRenderer.invoke('choose-image'),
  chooseMaterial: () => ipcRenderer.invoke('choose-material'),
  exportMaterial: id => ipcRenderer.invoke('export-material', id),
  reveal: path => ipcRenderer.invoke('reveal', path),
  openFile: id => ipcRenderer.invoke('open-file', id),
  copy: text => ipcRenderer.invoke('copy', text),
  restart: () => ipcRenderer.invoke('restart'),
  confirmDetach: name => ipcRenderer.invoke('confirm-detach', name),
  filePath: file => webUtils.getPathForFile(file),
  onServiceError: callback => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('service-error', listener);
    return () => ipcRenderer.removeListener('service-error', listener);
  }
});
