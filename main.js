const remoteMain = require('@electron/remote/main')
const { app, BrowserWindow, ipcMain, screen, shell, dialog, Tray, Menu, session} = require('electron')
const { clipboard, nativeImage, desktopCapturer  } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const { spawn, exec } = require('child_process')
const { download } = require('electron-dl')
const fs = require('fs')
const os = require('os')
const net = require('net')
const dgram = require('dgram')
const osc = require('osc')

// ★ VMC：UDP 收发资源
let vmcUdpPort = null;          
let vmcReceiverActive = false;  
let vrmWindows = []; 
let shotOverlay = null;
let isMac = process.platform === 'darwin';
const vmcSendSocket = dgram.createSocket('udp4'); 
const MAX_LOG_LINES = 2000; 
let logBuffer = []; 
let activeDownloads = new Map(); 

function appendLogToBuffer(source, data) {
  const timestamp = new Date().toLocaleTimeString();
  const lines = data.toString().split(/\r?\n/);
  lines.forEach(line => {
    if (line.trim()) logBuffer.push(`[${timestamp}] [${source}] ${line}`);
  });
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer = logBuffer.slice(logBuffer.length - MAX_LOG_LINES);
  }
}

async function cropDesktop(rect) {
  if (!rect || typeof rect.x !== 'number' || typeof rect.y !== 'number' ||
      typeof rect.width !== 'number' || typeof rect.height !== 'number') {
    throw new Error('cropDesktop 需要 {x,y,width,height} 且均为数字')
  }
  const { width, height } = screen.getPrimaryDisplay().bounds
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  if (!sources.length) throw new Error('无法获取屏幕源')
  const pngBuffer = sources[0].thumbnail.toPNG()
  const img  = nativeImage.createFromBuffer(pngBuffer)
  const cropped = img.crop({
    x: Math.floor(rect.x), y: Math.floor(rect.y),
    width: Math.floor(rect.width), height: Math.floor(rect.height)
  })
  return cropped.toPNG()
}

function startVMCReceiver(cfg) {
  if (vmcReceiverActive) return;
  vmcUdpPort = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: cfg.receive.port, metadata: true });
  vmcUdpPort.open();
  vmcUdpPort.on('message', (oscMsg) => {
    if (oscMsg.address === '/VMC/Ext/Bone/Pos') {
      if (!Array.isArray(oscMsg.args) || oscMsg.args.length < 8) return;
      const [boneName, x, y, z, qx, qy, qz, qw] = oscMsg.args.map(v => v.value ?? v);
      if (typeof boneName !== 'string') return;
      vrmWindows.forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('vmc-bone', { boneName, position:{x,y,z}, rotation:{x:qx,y:qy,z:qz,w:qw} });
          w.webContents.send('vmc-osc-raw', oscMsg);
        }
      });
      return;
    }
    if (oscMsg.address === '/VMC/Ext/Blend/Val' || oscMsg.address === '/VMC/Ext/Blend/Apply') {
      vrmWindows.forEach(w => { if (!w.isDestroyed()) w.webContents.send('vmc-osc-raw', oscMsg); });
    }
  });
  vmcReceiverActive = true;
  console.log(`[VMC] 接收已启动 @ ${cfg.receive.port}`);
}

function stopVMCReceiver() {
  if (!vmcReceiverActive) return;
  vmcUdpPort.close(); vmcUdpPort = null; vmcReceiverActive = false;
  console.log('[VMC] 接收已停止');
}

let pythonExec;
let isQuitting = false;
if (os.platform() === 'win32') pythonExec = path.join('.venv', 'Scripts', 'python.exe');
else pythonExec = path.join('.venv', 'bin', 'python3');

function getCleanUserAgent() {
  const chromeVersion = '124.0.0.0'; 
  const baseUA = `Mozilla/5.0 ({os_info}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  let osInfo = '';
  switch (process.platform) {
    case 'darwin': osInfo = 'Macintosh; Intel Mac OS X 10_15_7'; break;
    case 'win32': osInfo = 'Windows NT 10.0; Win64; x64'; break;
    case 'linux': osInfo = 'X11; Linux x86_64'; break;
    default: osInfo = 'Windows NT 10.0; Win64; x64';
  }
  return baseUA.replace('{os_info}', osInfo);
}

const REAL_CHROME_UA = getCleanUserAgent();

let mainWindow
let loadingWindow
let tray = null
let updateAvailable = false
let backendProcess = null
const HOST = '127.0.0.1'
let PORT = 3456 
const DEFAULT_PORT = 3456 
const isDev = process.env.NODE_ENV === 'development'

const locales = {
  'zh-CN': {
    show: '显示窗口', exit: '退出', cut: '剪切', copy: '复制', paste: '粘贴',
    copyImage: '复制图片', copyImageLink: '复制图片链接', saveImageAs: '图片另存为...',
    supportedFiles: '支持的文件', allFiles: '所有文件', supportedimages: '支持的图片',
    openNewTab: '在新标签页打开', copyLink: '复制链接地址', copyLinkText: '复制链接文本',
    selectAll: '全选', inspect: '检查元素'
  },
  'en-US': {
    show: 'Show Window', exit: 'Exit', cut: 'Cut', copy: 'Copy', paste: 'Paste',
    copyImage: 'Copy Image', copyImageLink: 'Copy Image Link', saveImageAs: 'Save Image As...',
    supportedFiles: 'Supported Files', allFiles: 'All Files', supportedimages: 'Supported Images',
    openNewTab: 'Open in new tab', copyLink: 'Copy link address', copyLinkText: 'Copy link text',
    selectAll: 'Select All', inspect: 'Inspect'
  }
};

const ALLOWED_EXTENSIONS = [
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf', 'pages', 'numbers', 'key', 'rtf', 'odt', 'epub',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'swift', 'kt', 'dart', 'rb', 'php', 'html', 'css', 'scss', 'less',
  'vue', 'svelte', 'jsx', 'tsx', 'json', 'xml', 'yml', 'yaml', 'sql', 'sh',
  'csv', 'tsv', 'txt', 'md', 'log', 'conf', 'ini', 'env', 'toml'
];
const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
let currentLanguage = 'zh-CN';
let menu;

const logDir = path.join(app.getPath('userData'), 'logs')
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

function getConfigPath() { return path.join(app.getPath('userData'), 'config.json'); }

function loadEnvVariables() {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      for (const key in config) {
        if (typeof config[key] === 'string' || typeof config[key] === 'number') process.env[key] = config[key];
      }
      return config; 
    } catch (e) { console.error('加载配置失败:', e); }
  }
  return {};
}

function saveEnvVariable(key, value) {
  const configPath = getConfigPath();
  let config = {};
  try { if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
  config[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (typeof value === 'string' || typeof value === 'number') process.env[key] = value;
}

const globalConfig = loadEnvVariables();

let SESSION_CDP_PORT = 0; 
let IS_INTERNAL_MODE_ACTIVE = false;

if (globalConfig?.chromeMCPSettings?.type === 'internal' && globalConfig?.chromeMCPSettings?.enabled) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-allow-origins', '*');
  IS_INTERNAL_MODE_ACTIVE = true;
}

function createSkeletonWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: width, height: height, frame: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 10, y: 12 },
    show: true, icon: 'static/source/icon.png',
    webPreferences: {
      preload: path.join(__dirname, 'static/js/preload.js'),
      nodeIntegration: false, sandbox: false, contextIsolation: true,
      enableRemoteModule: false, webSecurity: false, devTools: isDev,
      partition: 'persist:main-session', webviewTag: true,
    }
  })
  remoteMain.enable(mainWindow.webContents)
  mainWindow.loadFile(path.join(__dirname, 'static/skeleton.html'))
  setupAutoUpdater()
  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', 'maximized'))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', 'normal'))
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) { event.preventDefault(); mainWindow.hide(); return false; }
    return true
  })
}

function handleDownloadItem(event, item, webContents) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  const downloadId = Date.now().toString();
  activeDownloads.set(downloadId, item);
  win.webContents.send('download-started', { id: downloadId, filename: item.getFilename(), totalBytes: item.getTotalBytes(), path: item.getSavePath() });

  item.on('updated', (event, state) => {
      if (state === 'interrupted') win.webContents.send('download-updated', { id: downloadId, state: 'interrupted' });
      else if (state === 'progressing') {
          if (item.isPaused()) win.webContents.send('download-updated', { id: downloadId, state: 'paused' });
          else win.webContents.send('download-updated', {
              id: downloadId, state: 'progressing', receivedBytes: item.getReceivedBytes(),
              totalBytes: item.getTotalBytes(), progress: item.getTotalBytes() > 0 ? item.getReceivedBytes() / item.getTotalBytes() : 0
          });
      }
  });

  item.once('done', (event, state) => {
      win.webContents.send('download-done', { id: downloadId, state: state, path: item.getSavePath() });
      activeDownloads.delete(downloadId);
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false; 
  if (isDev) autoUpdater.on('error', (err) => mainWindow.webContents.send('update-error', err.message));
  autoUpdater.on('update-available', (info) => {
    updateAvailable = true;
    mainWindow.webContents.send('update-available', info);
    autoUpdater.downloadUpdate(); 
  });
  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow.webContents.send('download-progress', {
      percent: progressObj.percent.toFixed(1), transferred: (progressObj.transferred / 1024 / 1024).toFixed(2), total: (progressObj.total / 1024 / 1024).toFixed(2)
    });
  });
  autoUpdater.on('update-downloaded', () => mainWindow.webContents.send('update-downloaded'));
}

const PROTOCOL = 'sap';
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return; 
}

let pendingExtensionUrl = null;
const startUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
if (startUrl) pendingExtensionUrl = startUrl;

app.on('second-instance', (event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
  const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`));
  handleProtocolUrl(url);
});

if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else app.setAsDefaultProtocolClient(PROTOCOL);

function handleProtocolUrl(url) {
  if (!url) return;
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname === 'install') {
      const type = urlObj.searchParams.get('type'); 
      const repo = urlObj.searchParams.get('repo');
      const mcpType = urlObj.searchParams.get('mcpType'); 
      const config = urlObj.searchParams.get('config'); 
      if (repo || config) {
        const payload = { type, repo, mcpType, config };
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) mainWindow.webContents.send('remote-install-any', payload); 
        else pendingExtensionUrl = url; 
      }
    }
  } catch (e) { console.error('协议解析失败:', e); }
}

app.on('open-url', (event, url) => { event.preventDefault(); handleProtocolUrl(url); });
const CHROME_VERSION = '124.0.0.0';
const CHROME_MAJOR = '124';
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-features', 'NetworkService,NetworkServiceInProcess');
app.commandLine.appendSwitch('disable-features', 'CrossOriginOpenerPolicy,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,LogAds');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// ★★★ 核心生命周期开始 ★★★
app.whenReady().then(async () => {
  try {
    const partySession = session.fromPartition('persist:party-browser-session');
    partySession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
        const headers = details.requestHeaders;
        headers['User-Agent'] = REAL_CHROME_UA;
        const brand = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not-A.Brand";v="99"`;
        headers['Sec-Ch-Ua'] = brand; headers['Sec-Ch-Ua-Mobile'] = '?0'; headers['Sec-Ch-Ua-Full-Version'] = `"${CHROME_VERSION}"`; headers['Sec-Ch-Ua-Full-Version-List'] = brand;
        let platform = 'Windows';
        if (process.platform === 'darwin') platform = 'macOS';
        else if (process.platform === 'linux') platform = 'Linux';
        headers['Sec-Ch-Ua-Platform'] = `"${platform}"`;
        delete headers['Sec-Ch-Ua-Model']; delete headers['Electron-Major-Version']; delete headers['X-Electron-App-Name'];
        callback({ requestHeaders: headers });
    });

    app.on('session-created', (sess) => { sess.on('will-download', (event, item, webContents) => handleDownloadItem(event, item, webContents)); });
    session.defaultSession.on('will-download', (event, item, webContents) => handleDownloadItem(event, item, webContents));    

    global.vmcCfg = { receive: { enable: false, port: 39539, syncExpression: false }, send: { enable: false, host: '127.0.0.1', port: 39540 } };
    
    // 1. 创建骨架屏
    createSkeletonWindow()
    if (global.vmcCfg.receive.enable) startVMCReceiver(global.vmcCfg);

    // 2. 尝试启动本地后端（如果文件不存在会直接忽略）
    const startBackend = () => new Promise((resolve) => {
      const execPath = isDev ? path.resolve(pythonExec) : path.join(process.resourcesPath || path.join(process.execPath, '..', 'resources'), 'server', process.platform === 'win32' ? 'server.exe' : 'server');
      if (!fs.existsSync(execPath)) {
        console.log(`ℹ️ [Lite模式] 未找到本地后端 ${execPath}，作为纯客户端运行...`);
        return resolve();
      }
      backendProcess = spawn(execPath, ['--host', '127.0.0.1', '--port', '3456'], { stdio: ['pipe', 'pipe', 'pipe'] });
      backendProcess.stdout.on('data', (data) => {
        appendLogToBuffer('BACKEND', data);
        if (data.toString().includes('REAL_PORT_FOUND:')) resolve();
      });
      backendProcess.on('error', () => resolve());
      setTimeout(resolve, 30000); // 最多等30秒
    });
    
    // ★ 提前注册基础 IPC handlers，确保骨架屏阶段就可用
    ipcMain.handle('get-app-path', () => app.getAppPath());
    ipcMain.handle('get-server-info', () => ({ port: PORT, defaultPort: DEFAULT_PORT, isDefaultPort: PORT === DEFAULT_PORT }));
    ipcMain.handle('get-vmc-config', () => { global.vmcCfg.receive.syncExpression ??= false; return global.vmcCfg; });
    ipcMain.handle('get-backend-logs', () => logBuffer.join('\n'));
    ipcMain.handle('get-internal-cdp-info', () => ({ active: IS_INTERNAL_MODE_ACTIVE, port: SESSION_CDP_PORT }));
    ipcMain.handle('set-env', async (event, arg) => saveEnvVariable(arg.key, arg.value));
    ipcMain.handle('restart-app', () => { app.relaunch(); app.exit(); });
    ipcMain.handle('window-action', (_, action) => {
      switch (action) { case 'show': mainWindow.show(); break; case 'hide': mainWindow.hide(); break; case 'minimize': mainWindow.minimize(); break; case 'maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break; case 'close': mainWindow.close(); break; }
    });

    await startBackend();

    // 3. 智能等待后端连通（只检测本地默认端口，不使用缓存的远程地址）
    // 缓存的 backendUrl 由骨架屏前端的 localStorage 管理，让用户自主选择是否连接
    const targetUrl = `http://127.0.0.1:${PORT}`;
    let isBackendReady = false;
    
    const smartWaitForBackend = async () => {
      const MAX_RETRIES = backendProcess ? 40 : 4; // 有本地进程多等会儿，没有只测2秒
      for(let i=0; i<MAX_RETRIES; i++) {
        try {
          const res = await fetch(`${targetUrl}/health`);
          if (res.ok) return true;
        } catch (e) { await new Promise(r => setTimeout(r, 500)); }
      }
      return false;
    };

    isBackendReady = await smartWaitForBackend();

    // 4. 根据连通性决定：加载UI，还是停留在骨架屏等待用户输入
    if (isBackendReady) {
      console.log(`✅ 后端已连通，加载页面: ${targetUrl}`);
      try { await mainWindow.loadURL(targetUrl); } catch(e) { console.warn('页面加载被拒绝'); }
    } else {
      console.warn(`⚠️ 无法连接到 ${targetUrl}，将停留在引导页等待用户输入远端地址...`);
      // 什么都不做，mainWindow 保持显示 skeleton.html
    }

    // 5. 注册骨架屏发送过来的连接请求
    ipcMain.handle('connect-to-backend', async (event, url) => {
      try {
        console.log(`[Lite] 用户请求连接到外部 URL: ${url}`);
        saveEnvVariable('backendUrl', url);
        await mainWindow.loadURL(url);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // --- 以下是原有的各种 IPC 注册 ---
    if (IS_INTERNAL_MODE_ACTIVE) {
        try {
            const portFile = path.join(app.getPath('userData'), 'DevToolsActivePort');
            if (fs.existsSync(portFile)) SESSION_CDP_PORT = parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10);
        } catch (e) {}
    }

    ipcMain.handle('save-chrome-config', async (event, settings) => { saveEnvVariable('chromeMCPSettings', settings); return true; });

    ipcMain.handle('save-screenshot-direct', async (event, { buffer }) => {
      const uploadDir = path.join(app.getPath('userData'),'Super-Agent-Party', 'uploaded_files');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const filename = `screenshot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`;
      fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(buffer));
      return filename;
    });

    ipcMain.handle('open-extension-window', async (_, { url, extension }) => {
      const windowConfig = {
        width: extension.width || 800, height: extension.height || 600,
        webPreferences: { contextIsolation: true, nodeIntegration: false, webviewTag: true, preload: path.join(__dirname, 'static/js/preload.js') }
      };
      if (extension.transparent) Object.assign(windowConfig, { frame: false, transparent: true, alwaysOnTop: true, backgroundColor: 'rgba(0, 0, 0, 0)' });
      const extensionWindow = new BrowserWindow(windowConfig);
      remoteMain.enable(extensionWindow.webContents);
      await extensionWindow.loadURL(url);
      return extensionWindow.id;
    });

    ipcMain.handle('start-vrm-window', async (_, windowConfig = {}) => {
      const vrmWindow = new BrowserWindow({
        width: windowConfig.width || 540, height: windowConfig.height || 960,
        x: windowConfig.x !== undefined ? windowConfig.x : screen.getPrimaryDisplay().workAreaSize.width - (windowConfig.width || 540) - 40,
        y: windowConfig.y !== undefined ? windowConfig.y : 0,
        transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, backgroundColor: 'rgba(0, 0, 0, 0)',
        webPreferences: { contextIsolation: true, nodeIntegration: true, enableRemoteModule: true, webgl: true, preload: path.join(__dirname, 'static/js/preload.js') }
      });
      await vrmWindow.loadURL(`${targetUrl}/vrm.html`);
      vrmWindows.push(vrmWindow);
      vrmWindow.on('closed', () => { vrmWindows = vrmWindows.filter(w => w !== vrmWindow); });
      return vrmWindow.id;  
    });

    ipcMain.handle('capture-desktop', async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
      return sources[0].thumbnail.toPNG() 
    });
    ipcMain.handle('crop-desktop', async (e, { rect }) => {
      const png = await cropDesktop(rect)          
      return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
    });

    ipcMain.handle('show-screenshot-overlay', async (_, { hideWindow = true } = {}) => {
      if (hideWindow && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
      const { width, height } = screen.getPrimaryDisplay().bounds
      shotOverlay = new BrowserWindow({
        x: 0, y: 0, width, height, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, enableLargerThanScreen: true,
        webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'static/js/shotPreload.js') }
      })
      shotOverlay.loadFile(path.join(__dirname, 'static/shotOverlay.html'))
      return new Promise((resolve) => {
        ipcMain.once('screenshot-selected', (e, rect) => { shotOverlay.close(); shotOverlay = null; resolve(rect); })
      })
    })

    ipcMain.handle('cancel-screenshot-overlay', () => { if (shotOverlay && !shotOverlay.isDestroyed()) { shotOverlay.close(); shotOverlay = null; } })
    ipcMain.handle('set-ignore-mouse-events', (event, ignore, options) => BrowserWindow.fromWebContents(event.sender).setIgnoreMouseEvents(ignore, options));
    ipcMain.handle('dialog:openDirectory', async () => require('electron').dialog.showOpenDialog({ properties: ['openDirectory'] }));
    ipcMain.handle('get-ignore-mouse-status', (event) => BrowserWindow.fromWebContents(event.sender).isIgnoreMouseEvents());
    ipcMain.handle('stop-vrm-window', (_, windowId) => {
      if (windowId !== undefined) {
        const win = vrmWindows.find(w => w.id === windowId);
        if (win && !win.isDestroyed()) win.close();
        vrmWindows = vrmWindows.filter(w => w.id !== windowId);
      } else {
        vrmWindows.forEach(win => { if (!win.isDestroyed()) win.close(); }); vrmWindows = [];
      }
    });

    ipcMain.handle('download-file', async (event, payload) => {
      const dlItem = await download(mainWindow, payload.url, { filename: payload.filename, saveAs: true, openFolderWhenDone: true });
      return { success: true, savePath: dlItem.getSavePath() };
    });
    
    ipcMain.handle('check-for-updates', async () => {
      if (isDev) return { updateAvailable: false }
      try {
        const result = await autoUpdater.checkForUpdates()
        return { updateAvailable: updateAvailable, updateInfo: result ? { version: result.updateInfo.version, releaseDate: result.updateInfo.releaseDate } : null }
      } catch (error) { return { updateAvailable: false, error: error.message } }
    })

    ipcMain.handle('download-update', () => { if (updateAvailable) return autoUpdater.downloadUpdate() })
    ipcMain.handle('quit-and-install', () => { setTimeout(() => autoUpdater.quitAndInstall(), 500); });
    ipcMain.handle('check-pending-install', () => {
      if (pendingExtensionUrl) {
        try {
          const urlObj = new URL(pendingExtensionUrl);
          const res = { type: urlObj.searchParams.get('type'), repo: urlObj.searchParams.get('repo'), config: urlObj.searchParams.get('config'), mcpType: urlObj.searchParams.get('mcpType') };
          pendingExtensionUrl = null; return res;
        } catch (e) { return null; }
      }
      return null;
    });
    ipcMain.handle('get-window-size', (event) => BrowserWindow.fromWebContents(event.sender).getSize());
    ipcMain.handle('download-control', (event, { id, action }) => {
      const item = activeDownloads.get(id);
      if (!item) return;
      if (action === 'pause' && !item.isPaused()) item.pause();
      else if (action === 'resume' && item.canResume()) item.resume();
      else if (action === 'cancel') item.cancel();
    });
    ipcMain.handle('show-item-in-folder', (event, filePath) => { if(filePath) shell.showItemInFolder(filePath); });

    ipcMain.on('set-language', (_, lang) => {
      currentLanguage = (lang === 'auto') ? (app.getLocale().split('-')[0] === 'zh' ? 'zh-CN' : 'en-US') : lang;
      updateTrayMenu(); updatecontextMenu();
    });

    createTray(); updatecontextMenu();

    ipcMain.handle('set-vmc-config', async (_, cfg) => {
      if (cfg.receive.enable) {
        if (!vmcReceiverActive || cfg.receive.port !== global.vmcCfg?.receive.port) { if (vmcReceiverActive) stopVMCReceiver(); startVMCReceiver(cfg); }
      } else stopVMCReceiver();
      global.vmcCfg = cfg;
      BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send('vmc-config-changed', cfg); });
      return { success: true };
    });

    ipcMain.handle('send-vmc-frame', (event, frameData) => {
      if (!global.vmcCfg?.send.enable) return;
      const { host, port } = global.vmcCfg.send;
      const packets = [{ address: '/VMC/Ext/Root/Pos', args: [{ type: 's', value: 'root' }, { type: 'f', value: 0 }, { type: 'f', value: 0 }, { type: 'f', value: 0 }, { type: 'f', value: 0 }, { type: 'f', value: 0 }, { type: 'f', value: 0 }, { type: 'f', value: 1 }] }];
      frameData.bones.forEach(b => {
        if (b.name === 'root') return;
        packets.push({ address: '/VMC/Ext/Bone/Pos', args: [{ type: 's', value: b.name.charAt(0).toUpperCase() + b.name.slice(1) }, { type: 'f', value: b.pos.x }, { type: 'f', value: b.pos.y }, { type: 'f', value: b.pos.z }, { type: 'f', value: b.rot.x }, { type: 'f', value: b.rot.y }, { type: 'f', value: b.rot.z }, { type: 'f', value: b.rot.w }] });
      });
      frameData.blends.forEach(blend => packets.push({ address: '/VMC/Ext/Blend/Val', args: [ { type: 's', value: blend.name }, { type: 'f', value: blend.weight } ] }));
      if (frameData.blends.length > 0) packets.push({ address: '/VMC/Ext/Blend/Apply', args: [] });
      packets.push({ address: '/VMC/Ext/OK', args: [{ type: 'i', value: 1 }] });
      try { vmcSendSocket.send(osc.writePacket({ timeTag: osc.timeTag(0), packets: packets }), port, host); } catch (e) {}
    });

    ipcMain.handle('toggle-window-size', async (event, { width, height }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win.isMaximized()) {
        win.unmaximize();
        for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 50)); if (!win.isMaximized()) break; }
        win.setSize(width, height, true);
      } else {
        if (isMac) win.maximize(); else win.setSize(width, height, true);
      }
    });

    ipcMain.handle('set-always-on-top', (e, flag) => BrowserWindow.fromWebContents(e.sender).setAlwaysOnTop(flag, 'screen-saver'));

    ipcMain.handle('show-context-menu', async (event, { menuType, data }) => {
      let menuTemplate = []; const win = BrowserWindow.fromWebContents(event.sender); const lang = locales[currentLanguage]; 
      if (menuType === 'image') {
        menuTemplate = [ { label: lang.openNewTab, click: () => win.webContents.send('create-tab', data.src) }, { type: 'separator' }, { label: lang.copyImageLink, click: () => clipboard.writeText(data.src) }, { label: lang.copyImage, click: async () => { try { if (data.src.startsWith('data:')) clipboard.writeImage(nativeImage.createFromDataURL(data.src)); else if (data.src.startsWith('http')) { const blob = await (await fetch(data.src)).blob(); clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()))); } else clipboard.writeImage(nativeImage.createFromPath(data.src)); } catch (e) {} } } ];
      } else if (menuType === 'link') {
        menuTemplate = [ { label: lang.openNewTab, click: () => win.webContents.send('create-tab', data.url) }, { type: 'separator' }, { label: lang.copyLink, click: () => clipboard.writeText(data.url) } ];
      } else if (menuType === 'text') {
        menuTemplate = [ { label: lang.copy, role: 'copy' }, { label: `Search`, click: () => win.webContents.send('trigger-search', `Search "${data.text}"`) }, { type: 'separator' }, { label: lang.selectAll, role: 'selectAll' } ];
      } else {
        menuTemplate = [ { label: lang.cut, role: 'cut' }, { label: lang.copy, role: 'copy' }, { label: lang.paste, role: 'paste' }, { type: 'separator' }, { label: lang.selectAll, role: 'selectAll' } ];
      }
      if (isDev) { menuTemplate.push({ type: 'separator' }); menuTemplate.push({ label: lang.inspect, click: () => win.webContents.openDevTools({ mode: 'detach' }) }); }
      menu = Menu.buildFromTemplate(menuTemplate); menu.popup({ window: win });
    });

    const stopBots = async (method) => { const win = BrowserWindow.getAllWindows()[0]; if (win && !win.isDestroyed()) await win.webContents.executeJavaScript(`window.${method} && window.${method}()`); };
    ipcMain.handle('request-stop-qqbot', () => stopBots('stopQQBotHandler'));
    ipcMain.handle('request-stop-feishubot', () => stopBots('stopFeishuBotHandler'));
    ipcMain.handle('request-stop-dingtalk', () => stopBots('stopDingtalkBotHandler'));
    ipcMain.handle('request-stop-telegrambot', () => stopBots('stopTelegramBotHandler'));
    ipcMain.handle('request-stop-discordbot', () => stopBots('stopDiscordBotHandler'));
    ipcMain.handle('request-stop-slackbot', () => stopBots('stopSlackBotHandler'));

    ipcMain.handle('exec-command', (event, command) => new Promise((resolve, reject) => exec(command, (error, stdout) => error ? reject(error) : resolve(stdout))));
    ipcMain.on('open-external', (event, url) => shell.openExternal(url));
    ipcMain.handle('readFile', async (_, path) => fs.promises.readFile(path));
    ipcMain.handle('open-file-dialog', async () => dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [ { name: locales[currentLanguage].supportedFiles, extensions: [...ALLOWED_EXTENSIONS, ...ALLOWED_IMAGE_EXTENSIONS] }, { name: locales[currentLanguage].allFiles, extensions: ['*'] } ] }));
    ipcMain.handle('open-image-dialog', async () => dialog.showOpenDialog({ properties: ['openFile'], filters: [ { name: locales[currentLanguage].supportedimages, extensions: ALLOWED_IMAGE_EXTENSIONS }, { name: locales[currentLanguage].allFiles, extensions: ['*'] } ] }));
    ipcMain.handle('check-path-exists', (_, path) => fs.existsSync(path));

  } catch (err) {
    console.error('启动失败:', err)
    if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close()
    dialog.showErrorBox('启动失败', `服务启动失败: ${err.message}`)
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      await win.webContents.executeJavaScript(`if(window.stopQQBotHandler) window.stopQQBotHandler(); if(window.stopDingtalkBotHandler) window.stopDingtalkBotHandler();`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (backendProcess) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', backendProcess.pid, '/f', '/t']);
      else backendProcess.kill('SIGKILL');
      backendProcess = null;
    }
  } catch (error) {} finally { app.exit(0); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('render-process-gone', (event, webContents, details) => { console.error('渲染进程崩溃:', details); dialog.showErrorBox('应用崩溃', `渲染进程异常: ${details.reason}`) })
process.on('uncaughtException', (err) => { console.error('未捕获异常:', err); if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close(); dialog.showErrorBox('致命错误', `未捕获异常: ${err.message}`); app.quit(); })

function createTray() {
  const iconPath = path.join(__dirname, 'static/source/icon_tray.png');
  if (!tray) {
    tray = new Tray(iconPath);
    tray.setToolTip('Super Agent Party');
    tray.on('click', () => { if (mainWindow) { if (mainWindow.isVisible()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } else { mainWindow.show(); } } });
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([ { label: locales[currentLanguage].show, click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } }, { type: 'separator' }, { label: locales[currentLanguage].exit, click: () => { app.isQuitting = true; app.quit(); } } ]));
}
function updatecontextMenu() { menu = Menu.buildFromTemplate([ { label: locales[currentLanguage].cut, role: 'cut' }, { label: locales[currentLanguage].copy, role: 'copy' }, { label: locales[currentLanguage].paste, role: 'paste' } ]); }

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler((details) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('create-tab', details.url); return { action: 'deny' }; });
  contents.on('input-event', (_ev, input) => { if (input.type === 'mouseDown' && (input.button === 3 || input.button === 4)) contents.stopNavigation(); });
  contents.on('before-input-event', (_ev, input) => { if (input.alt && (input.key === 'Left' || input.key === 'Right')) input.preventDefault = true; });
});
app.commandLine.appendSwitch('disable-http-cache');