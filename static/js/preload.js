const { contextBridge, shell, ipcRenderer } = require('electron');
const path = require('path');
const { remote } = require('@electron/remote/main')


// 缓存最后一次 VMC 配置（默认关闭）
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
// 暴露基本的ipcRenderer给骨架屏页面使用
contextBridge.exposeInMainWorld('electron', {
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  invoke: (channel, ...args) => {
    // 处于安全考虑，只放行 connect-to-backend 请求
    if (channel === 'connect-to-backend') {
      return ipcRenderer.invoke(channel, ...args);
    }
  },

  ipcRenderer: {
    on: (channel, func) => {
      // 只允许特定的通道
      const validChannels = ['backend-ready', 'trigger-search']; 
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    }
  },
  // 暴露服务器配置
  server: {
    host: HOST,
    port: PORT
  },
  requestStopQQBot: () => ipcRenderer.invoke('request-stop-qqbot'),
  requestStopFeishuBot : () => ipcRenderer.invoke('request-stop-feishubot'),
  requestStopDingtalkBot : () => ipcRenderer.invoke('request-stop-dingtalk'),
  requestStopDiscordBot : () => ipcRenderer.invoke('request-stop-discordbot'),
  requestStopTelegramBot : () => ipcRenderer.invoke('request-stop-telegrambot'),
  requestStopSlackBot : () => ipcRenderer.invoke('request-stop-slackbot'), 
});

// 暴露安全接口
contextBridge.exposeInMainWorld('electronAPI', {
  onNewTab: (callback) => ipcRenderer.on('create-tab', (_, url) => callback(url)),
  saveScreenshotDirect: (buffer) => ipcRenderer.invoke('save-screenshot-direct', { buffer }),
  // 系统功能
  openExternal: (url) => shell.openExternal(url),
  openPath: (filePath) => shell.openPath(filePath),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  getPath: () => remote.app.getPath('downloads'),
  // 窗口控制
  windowAction: (action) => ipcRenderer.invoke('window-action', action),
  onWindowState: (callback) => ipcRenderer.on('window-state', callback),

  // 文件对话框
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('readFile', filePath),
  // 路径处理
  pathJoin: (...args) => path.join(...args),
  sendLanguage: (lang) => ipcRenderer.send('set-language', lang),
  // 环境检测
  isElectron: true,

  // 自动更新
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update-not-available', callback),
  onUpdateError: (callback) => ipcRenderer.on('update-error', callback),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', callback),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  showContextMenu: (menuType, data) => ipcRenderer.invoke('show-context-menu', { menuType, data }),
  //保存环境变量
  setNetworkVisibility: (visible) => ipcRenderer.invoke('set-env', { key: 'networkVisible', value: visible }), 
  
  saveChromeSettings: (settings) => ipcRenderer.invoke('save-chrome-config', settings),
  getInternalCDPInfo: () => ipcRenderer.invoke('get-internal-cdp-info'),
  //重启app
  restartApp: () => ipcRenderer.invoke('restart-app'),
  startVRMWindow: (windowConfig) => ipcRenderer.invoke('start-vrm-window', windowConfig),
  stopVRMWindow: () => ipcRenderer.invoke('stop-vrm-window'),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.invoke('set-ignore-mouse-events', ignore, options),
  getIgnoreMouseStatus: () => ipcRenderer.invoke('get-ignore-mouse-status'),
  downloadFile: (payload) => ipcRenderer.invoke('download-file', payload),
  // 修改：添加回调参数
  getWindowConfig: (callback) => {
      if (windowConfig.windowName !== "default") {
          // 如果配置已更新，直接返回
          callback(windowConfig);
      } else {
          // 如果配置未更新，监听更新事件
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
  captureDesktop: () => ipcRenderer.invoke('capture-desktop'), // 👈 桌面截图
  toggleWindowSize: (width, height) => ipcRenderer.invoke('toggle-window-size', { width, height }),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('set-always-on-top', flag),
  showScreenshotOverlay: (hideWindow) => ipcRenderer.invoke('show-screenshot-overlay', { hideWindow }),
  cropDesktop:        (opts) => ipcRenderer.invoke('crop-desktop', opts),
  cancelScreenshotOverlay: () => ipcRenderer.invoke('cancel-screenshot-overlay'),
  openDirectoryDialog: async () => {
    return ipcRenderer.invoke('dialog:openDirectory');
  },
  execCommand: (command) => ipcRenderer.invoke('exec-command', command),
  getPlatform: () => process.platform,
  openExtensionWindow: (url, extension) => ipcRenderer.invoke('open-extension-window', { url, extension }),
  getBackendLogs: () => ipcRenderer.invoke('get-backend-logs'),

  onRemoteInstall: (callback) => ipcRenderer.on('remote-install-any', (_, payload) => callback(payload)),
  checkPendingInstall: () => ipcRenderer.invoke('check-pending-install'),

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
  },
  sendVMCFrame: (data) => ipcRenderer.invoke('send-vmc-frame', data),
});

contextBridge.exposeInMainWorld('downloadAPI', {
    // 监听下载事件
    onDownloadStarted: (cb) => ipcRenderer.on('download-started', (_, data) => cb(data)),
    onDownloadUpdated: (cb) => ipcRenderer.on('download-updated', (_, data) => cb(data)),
    onDownloadDone: (cb) => ipcRenderer.on('download-done', (_, data) => cb(data)),
    
    // 发送控制指令
    controlDownload: (id, action) => ipcRenderer.invoke('download-control', { id, action }),
    showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path)
});

// 在文件末尾添加以下代码来接收主进程传递的配置
ipcRenderer.on('set-window-config', (event, config) => {
    Object.assign(windowConfig, config);
    console.log('收到窗口配置:', windowConfig);
    
    // 添加：配置更新后发送事件通知页面
    window.dispatchEvent(new CustomEvent('window-config-updated', {
        detail: windowConfig
    }));
});