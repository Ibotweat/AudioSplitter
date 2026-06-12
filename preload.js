const { contextBridge, ipcRenderer } = require('electron');

window.electron = {
  getSources: () => ipcRenderer.invoke('get-sources'),
  installDriver: () => ipcRenderer.invoke('install-driver'),
  uninstallDriver: () => ipcRenderer.invoke('uninstall-driver'),
  saveConfigFile: (data) => ipcRenderer.invoke('save-config-file', data),
  loadConfigFile: () => ipcRenderer.invoke('load-config-file'),
  onLoadConfig: (callback) => ipcRenderer.on('load-config-trigger', (e, ...args) => callback(...args)),
  onExportConfig: (callback) => ipcRenderer.on('export-config-trigger', (e, ...args) => callback(...args)),
  installExtension: (filePath) => ipcRenderer.invoke('install-extension', filePath),
  loadExtensions: () => ipcRenderer.invoke('load-extensions'),
  deleteExtension: (slug) => ipcRenderer.invoke('delete-extension', slug),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadAndInstallUpdate: (url) => ipcRenderer.invoke('download-and-install-update', url),
  getCPUUsage: () => ipcRenderer.invoke('get-cpu-usage')
};

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  };

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});
