const { contextBridge, shell, ipcRenderer } = require('electron');
const path = require('path');

// 缓存最后一次 VMC 配置
let vmcCfg = { receive:{enable:false,port:39539,syncExpression: false}, send:{enable:false,host:'127.0.0.1',port:39540} };

// 主进程推送最新配置
ipcRenderer.on('vmc-config-changed', (_, cfg) => { vmcCfg = cfg; });

// 与 main.js 保持一致的服务器配置
const HOST = '127.0.0.1'
const PORT = 3456
// 获取从主进程传递的配置数据
const windowConfig = {
    windowName: "default",
};

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  ipcRenderer: {
    on: (channel, func) => {
      const validChannels = ['backend-ready'];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    }
  },
  server: {
    host: HOST,
    port: PORT
  },
  requestStopQQBot: () => ipcRenderer.invoke('request-stop-qqbot'),
  requestStopFeishuBot : () => ipcRenderer.invoke('request-stop-feishubot'),
  requestStopDiscordBot : () => ipcRenderer.invoke('request-stop-discordbot'),
  requestStopTelegramBot : () => ipcRenderer.invoke('request-stop-telegrambot'),
});

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url) => shell.openExternal(url),
  openPath: (filePath) => shell.openPath(filePath),
  
  // ★ 修改：通过 IPC 获取路径，而不是直接用 remote (这样更稳定)
  // 这里的 getAppPath 和 getPath 需要在 main.js 里注册对应的 handler，或者如果不想动 main.js，
  // 确保 main.js 加上了 sandbox: false 后，可以使用下面的 remote 写法：
  // getAppPath: () => require('@electron/remote').app.getAppPath(),
  // getPath: () => require('@electron/remote').app.getPath('downloads'),
  
  // 既然我们在 main.js 关了 sandbox，这里就可以用 require('electron').remote 或者 @electron/remote
  getAppPath: () => {
    try { return require('@electron/remote').app.getAppPath(); } catch(e) { return ''; }
  },
  getPath: () => {
    try { return require('@electron/remote').app.getPath('downloads'); } catch(e) { return ''; }
  },

  windowAction: (action) => ipcRenderer.invoke('window-action', action),
  onWindowState: (callback) => ipcRenderer.on('window-state', callback),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('readFile', filePath),
  pathJoin: (...args) => path.join(...args), // sandbox: false 后，这里就不会报错了
  sendLanguage: (lang) => ipcRenderer.send('set-language', lang),
  isElectron: true,
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update-not-available', callback),
  onUpdateError: (callback) => ipcRenderer.on('update-error', callback),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', callback),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  showContextMenu: (menuType, data) => ipcRenderer.invoke('show-context-menu', { menuType, data }),
  setNetworkVisibility: (visible) => ipcRenderer.invoke('set-env', { key: 'networkVisible', value: visible }), 
  restartApp: () => ipcRenderer.invoke('restart-app'),
  startVRMWindow: (windowConfig) => ipcRenderer.invoke('start-vrm-window', windowConfig),
  stopVRMWindow: () => ipcRenderer.invoke('stop-vrm-window'),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.invoke('set-ignore-mouse-events', ignore, options),
  getIgnoreMouseStatus: () => ipcRenderer.invoke('get-ignore-mouse-status'),
  downloadFile: (payload) => ipcRenderer.invoke('download-file', payload),
  getWindowConfig: (callback) => {
      if (windowConfig.windowName !== "default") {
          callback(windowConfig);
      } else {
          const handler = (event) => {
              callback(event.detail);
              window.removeEventListener('window-config-updated', handler);
          };
          window.addEventListener('window-config-updated', handler);
      }
  },
  setVMCConfig: (cfg) => ipcRenderer.invoke('set-vmc-config', cfg),
  getVMCConfig: () => ipcRenderer.invoke('get-vmc-config'),
  onVMCConfigChanged: (cb) => ipcRenderer.on('vmc-config-changed', (_, cfg) => cb(cfg)),
  captureDesktop: () => ipcRenderer.invoke('capture-desktop'),
  toggleWindowSize: (width, height) => ipcRenderer.invoke('toggle-window-size', { width, height }),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('set-always-on-top', flag),
  showScreenshotOverlay: () => ipcRenderer.invoke('show-screenshot-overlay'),
  cropDesktop: (opts) => ipcRenderer.invoke('crop-desktop', opts),
  cancelScreenshotOverlay: () => ipcRenderer.invoke('cancel-screenshot-overlay'),
  openDirectoryDialog: async () => {
    return ipcRenderer.invoke('dialog:openDirectory');
  },
  execCommand: (command) => ipcRenderer.invoke('exec-command', command),
  getPlatform: () => process.platform,
  openExtensionWindow: (url, extension) => ipcRenderer.invoke('open-extension-window', { url, extension }),
  getBackendLogs: () => ipcRenderer.invoke('get-backend-logs'),
});

contextBridge.exposeInMainWorld('vmcAPI', {
  onVMCBone: (callback) => ipcRenderer.on('vmc-bone', (_, data) => callback(data)),
  onVMCOscRaw: (cb) => ipcRenderer.on('vmc-osc-raw', (_, oscMsg) => cb(oscMsg)),
  sendVMCBone: (data) => {
    if (!vmcCfg.send.enable) return;
    return ipcRenderer.invoke('send-vmc-bone', data);
  },
  sendVMCBlend: (data) => {
    if (!vmcCfg.send.enable) return;
    return ipcRenderer.invoke('send-vmc-blend', data);
  },
  sendVMCBlendApply: () => {
    if (!vmcCfg.send.enable) return;
    return ipcRenderer.invoke('send-vmc-blend-apply');
  }
});

ipcRenderer.on('set-window-config', (event, config) => {
    Object.assign(windowConfig, config);
    window.dispatchEvent(new CustomEvent('window-config-updated', {
        detail: windowConfig
    }));
});