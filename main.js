const remoteMain = require('@electron/remote/main')
const { app, BrowserWindow, ipcMain, screen, shell, dialog, Tray, Menu } = require('electron')
const { clipboard, nativeImage, desktopCapturer } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const { exec } = require('child_process'); // 仅保留 exec 用于命令执行，移除 spawn
const { download } = require('electron-dl');
const fs = require('fs')
const os = require('os')
const dgram = require('dgram');
const osc = require('osc');

// ==========================================
// 全局变量与配置
// ==========================================

// ★ VMC：UDP 收发资源
let vmcUdpPort = null;          
let vmcReceiverActive = false;  
let vrmWindows = []; 
let shotOverlay = null
let isMac = process.platform === 'darwin';
const vmcSendSocket = dgram.createSocket('udp4'); 
const MAX_LOG_LINES = 2000; 
let logBuffer = []; 

// ★ 核心：存储当前连接的后端地址 (默认为空，等待骨架屏连接)
let currentBackendUrl = ''; 

// 窗口引用
let mainWindow
let loadingWindow
let tray = null
let updateAvailable = false

const isDev = process.env.NODE_ENV === 'development'

// 多语言配置
const locales = {
  'zh-CN': {
    show: '显示窗口',
    exit: '退出',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    copyImage: '复制图片',
    copyImageLink: '复制图片链接',
    saveImageAs: '图片另存为...',
    supportedFiles: '支持的文件',
    allFiles: '所有文件',
    supportedimages: '支持的图片',
  },
  'en-US': {
    show: 'Show Window',
    exit: 'Exit',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    copyImage: 'Copy Image',
    copyImageLink: 'Copy Image Link',
    saveImageAs: 'Save Image As...',
    supportedFiles: 'Supported Files',
    allFiles: 'All Files',
    supportedimages: 'Supported Images',
  }
};
let currentLanguage = 'zh-CN';
let menu; // 上下文菜单引用

const ALLOWED_EXTENSIONS = [
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf', 'pages', 
  'numbers', 'key', 'rtf', 'odt', 'epub',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs',
  'swift', 'kt', 'dart', 'rb', 'php', 'html', 'css', 'scss', 'less',
  'vue', 'svelte', 'jsx', 'tsx', 'json', 'xml', 'yml', 'yaml', 
  'sql', 'sh',
  'csv', 'tsv', 'txt', 'md', 'log', 'conf', 'ini', 'env', 'toml'
];
const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// ==========================================
// 辅助函数
// ==========================================

// 日志记录
function appendLogToBuffer(source, data) {
  const timestamp = new Date().toLocaleTimeString();
  const lines = data.toString().split(/\r?\n/);
  lines.forEach(line => {
    if (line.trim()) {
      logBuffer.push(`[${timestamp}] [${source}] ${line}`);
    }
  });
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer = logBuffer.slice(logBuffer.length - MAX_LOG_LINES);
  }
}

// 桌面裁切
async function cropDesktop(rect) {
  if (!rect || typeof rect.x !== 'number' || typeof rect.y !== 'number' ||
      typeof rect.width !== 'number' || typeof rect.height !== 'number') {
    throw new Error('cropDesktop 需要 {x,y,width,height} 且均为数字')
  }
  const { width, height } = screen.getPrimaryDisplay().bounds
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  if (!sources.length) throw new Error('无法获取屏幕源')

  const pngBuffer = sources[0].thumbnail.toPNG()
  const img  = nativeImage.createFromBuffer(pngBuffer)
  const cropped = img.crop({
    x: Math.floor(rect.x), y: Math.floor(rect.y),
    width: Math.floor(rect.width), height: Math.floor(rect.height)
  })
  return cropped.toPNG()
}

// 配置文件路径
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 加载/保存环境变量
function loadEnvVariables() {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath);
    const config = JSON.parse(rawData);
    for (const key in config) {
      process.env[key] = config[key];
    }
  }
}
function saveEnvVariable(key, value) {
  const configPath = getConfigPath();
  let config = {};
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath);
    config = JSON.parse(rawData);
  }
  config[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  process.env[key] = value;
}

// 日志目录
const logDir = path.join(app.getPath('userData'), 'logs')
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}
loadEnvVariables();

// ==========================================
// VMC / OSC 逻辑
// ==========================================

function startVMCReceiver(cfg) {
  if (vmcReceiverActive) return;
  vmcUdpPort = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: cfg.receive.port,
    metadata: true,
  });
  vmcUdpPort.open();
  vmcUdpPort.on('message', (oscMsg) => {
    // 1. 骨骼
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
    // 2. 表情 / Apply
    if (oscMsg.address === '/VMC/Ext/Blend/Val' || oscMsg.address === '/VMC/Ext/Blend/Apply') {
      vrmWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('vmc-osc-raw', oscMsg);
      });
    }
  });
  vmcReceiverActive = true;
  console.log(`[VMC] 接收已启动 @ ${cfg.receive.port}`);
}

function stopVMCReceiver() {
  if (!vmcReceiverActive) return;
  vmcUdpPort.close();
  vmcUdpPort = null;
  vmcReceiverActive = false;
  console.log('[VMC] 接收已停止');
}

function sendVMCBoneMain(data) {
  if (!data || !global.vmcCfg?.send) return;
  const { boneName, position, rotation } = data;
  const { host, port } = global.vmcCfg.send;
  const oscMsg = osc.writePacket({
    address: `/VMC/Ext/Bone/Pos`,
    args: [
      { type: 's', value: boneName },
      { type: 'f', value: position.x || 0 }, { type: 'f', value: position.y || 0 }, { type: 'f', value: position.z || 0 },
      { type: 'f', value: rotation.x || 0 }, { type: 'f', value: rotation.y || 0 }, { type: 'f', value: rotation.z || 0 }, { type: 'f', value: rotation.w || 1 },
    ],
  });
  vmcSendSocket.send(oscMsg, port, host, (err) => { if (err) console.error('VMC send error:', err); });
}

function sendVMCBlendMain(data) {
  if (!data || !global.vmcCfg?.send) return;
  const { blendName, weight } = data;
  const { host, port } = global.vmcCfg.send;
  const oscMsg = osc.writePacket({
    address: '/VMC/Ext/Blend/Val',
    args: [
      { type: 's', value: blendName },
      { type: 'f', value: Math.max(0, Math.min(1, weight)) },
    ],
  });
  vmcSendSocket.send(oscMsg, port, host);
}

function sendVMCBlendApplyMain() {
  if (!global.vmcCfg?.send) return;
  const { host, port } = global.vmcCfg.send;
  const oscMsg = osc.writePacket({ address: '/VMC/Ext/Blend/Apply', args: [] });
  vmcSendSocket.send(oscMsg, port, host);
}

// ==========================================
// 窗口管理
// ==========================================

function createSkeletonWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 10, y: 12 },
    show: true,
    icon: 'static/source/icon.png',
    webPreferences: {
      preload: path.join(__dirname, 'static/js/preload.js'),
      sandbox: false, 
      nodeIntegration: false,
      contextIsolation: true, // 必须开启以配合 contextBridge
      webSecurity: false,     // 允许跨域检测后端
      devTools: isDev,
      partition: 'persist:main-session',
    }
  })

  remoteMain.enable(mainWindow.webContents)
  
  // 加载骨架屏页面
  mainWindow.loadFile(path.join(__dirname, 'static/skeleton.html'))
  
  setupAutoUpdater()
  
  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', 'maximized'))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', 'normal'))
  mainWindow.on('resize', () => mainWindow.webContents.send('window-resized', mainWindow.getSize()));
  
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
      return false
    }
    return true
  })
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  if (isDev) {
    autoUpdater.on('error', (err) => {
      if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-error', err.message);
    });
  }
  autoUpdater.on('update-available', (info) => {
    updateAvailable = true;
    if(mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info);
      autoUpdater.downloadUpdate();
    }
  });
  autoUpdater.on('download-progress', (progressObj) => {
    if(mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', {
        percent: progressObj.percent.toFixed(1),
        transferred: (progressObj.transferred / 1024 / 1024).toFixed(2),
        total: (progressObj.total / 1024 / 1024).toFixed(2)
      });
    }
  });
  autoUpdater.on('update-downloaded', () => {
    if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-downloaded');
  });
}

// ==========================================
// 启动流程
// ==========================================

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  setTimeout(() => app.quit(), 0)
} else {
  
  // 处理第二个实例
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      // 1. 初始化 VMC 配置
      global.vmcCfg = {
        receive: { enable: false, port: 39539, syncExpression: false },
        send:    { enable: false, host: '127.0.0.1', port: 39540 }
      };

      // 2. 注册核心 IPC：连接后端
      // 骨架屏 Skeleton.html 检测到服务后，会调用此接口
      ipcMain.handle('connect-to-backend', async (event, targetUrl) => {
        console.log(`[Main] 正在连接到后端: ${targetUrl}`);
        try {
          currentBackendUrl = targetUrl; // 保存后端地址，供 VRM 等功能使用
          await mainWindow.loadURL(targetUrl);
          return { success: true };
        } catch (err) {
          console.error('加载页面失败:', err);
          return { success: false, error: err.message };
        }
      });

      // 3. 注册其他功能 IPC
      registerAllIpcHandlers();

      // 4. 创建窗口
      createSkeletonWindow()
      
      // 5. 启动 VMC 接收
      if (global.vmcCfg.receive.enable) startVMCReceiver(global.vmcCfg);

    } catch (err) {
      console.error('启动失败:', err)
      dialog.showErrorBox('启动失败', `服务启动失败: ${err.message}`)
      app.quit()
    }
  })
}

// ==========================================
// IPC 处理器注册
// ==========================================

function registerAllIpcHandlers() {
  
  // --- 系统与配置 ---
  ipcMain.handle('get-window-size', (event) => BrowserWindow.fromWebContents(event.sender).getSize());
  
  ipcMain.handle('get-vmc-config', () => {
    global.vmcCfg.receive.syncExpression ??= false;
    return global.vmcCfg;
  });

  ipcMain.handle('set-env', async (event, arg) => saveEnvVariable(arg.key, arg.value));
  
  ipcMain.handle('restart-app', () => {
    app.relaunch();
    app.exit();
  });

  ipcMain.handle('get-server-info', () => {
    return {
      port: 3456, // 这里返回默认端口仅作 UI 参考，实际连接由 currentBackendUrl 决定
      defaultPort: 3456,
      isDefaultPort: true
    }
  });

  ipcMain.handle('get-backend-logs', () => logBuffer.join('\n'));

  // --- VMC 配置更新 ---
  ipcMain.handle('set-vmc-config', async (_, cfg) => {
    if (cfg.receive.enable) {
      if (!vmcReceiverActive || cfg.receive.port !== global.vmcCfg?.receive.port) {
        if (vmcReceiverActive) stopVMCReceiver();
        startVMCReceiver(cfg);
      }
    } else {
      stopVMCReceiver();
    }
    global.vmcCfg = cfg;
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('vmc-config-changed', cfg);
    });
    return { success: true };
  });

  // --- VMC 发送 ---
  ['send-vmc-bone','send-vmc-blend','send-vmc-blend-apply'].forEach(method => {
    ipcMain.handle(method, (e, data) => {
      if (!global.vmcCfg?.send.enable) return;
      switch (method) {
        case 'send-vmc-bone': return sendVMCBoneMain(data);
        case 'send-vmc-blend': return sendVMCBlendMain(data);
        case 'send-vmc-blend-apply': return sendVMCBlendApplyMain();
      }
    });
  });

  // --- VRM 窗口 (关键修改：使用 currentBackendUrl) ---
  ipcMain.handle('start-vrm-window', async (_, windowConfig = {}) => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const windowWidth = windowConfig.width || 540;
    const windowHeight = windowConfig.height || 960;
    const x = windowConfig.x !== undefined ? windowConfig.x : width - windowWidth - 40;
    const y = windowConfig.y !== undefined ? windowConfig.y : 0;

    const vrmWindow = new BrowserWindow({
      width: windowWidth, height: windowHeight,
      x, y,
      transparent: true, frame: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      backgroundColor: 'rgba(0, 0, 0, 0)',
      webPreferences: {
        contextIsolation: true,
        sandbox: false, 
        nodeIntegration: false, // 保持安全
        preload: path.join(__dirname, 'static/js/preload.js'),
        webgl: true,
        webAudio: true
      }
    });
    remoteMain.enable(vrmWindow.webContents);

    // ★ 拼接 URL：如果还没连上后端，默认 fallback 到 localhost:3456
    let targetBase = currentBackendUrl || 'http://127.0.0.1:3456';
    // 去除末尾斜杠
    targetBase = targetBase.replace(/\/$/, '');
    
    await vrmWindow.loadURL(`${targetBase}/vrm.html`);
    vrmWindow.setIgnoreMouseEvents(false);
    vrmWindows.push(vrmWindow);

    vrmWindow.on('closed', () => {
      vrmWindows = vrmWindows.filter(w => w !== vrmWindow);
    });
    return vrmWindow.id;
  });

  ipcMain.handle('stop-vrm-window', (_, windowId) => {
    if (windowId !== undefined) {
      const win = vrmWindows.find(w => w.id === windowId);
      if (win) win.close();
    } else {
      vrmWindows.forEach(win => !win.isDestroyed() && win.close());
      vrmWindows = [];
    }
  });

  // --- 扩展窗口 ---
  ipcMain.handle('open-extension-window', async (_, { url, extension }) => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const windowConfig = {
      width: extension.width || 800, height: extension.height || 600,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false,
        preload: path.join(__dirname, 'static/js/preload.js')
      }
    };
    if (extension.transparent) {
      Object.assign(windowConfig, { frame: false, transparent: true, alwaysOnTop: true, backgroundColor: 'rgba(0,0,0,0)' });
    } else {
      Object.assign(windowConfig, { frame: true, icon: 'static/source/icon.png', titleBarStyle: isMac ? 'hiddenInset' : 'default' });
    }
    const extensionWindow = new BrowserWindow(windowConfig);
    remoteMain.enable(extensionWindow.webContents);
    await extensionWindow.loadURL(url);
    return extensionWindow.id;
  });

  // --- 截图与媒体 ---
  ipcMain.handle('capture-desktop', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
    return sources[0].thumbnail.toPNG()
  })

  ipcMain.handle('crop-desktop', async (e, { rect }) => {
    const png = await cropDesktop(rect)
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
  })

  ipcMain.handle('show-screenshot-overlay', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
    const { width, height } = screen.getPrimaryDisplay().bounds
    shotOverlay = new BrowserWindow({
      x: 0, y: 0, width, height,
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'static/js/shotPreload.js')
      }
    })
    shotOverlay.loadFile(path.join(__dirname, 'static/shotOverlay.html'))
    shotOverlay.setVisibleOnAllWorkspaces(true)
    return new Promise((resolve) => {
      ipcMain.once('screenshot-selected', (e, rect) => {
        if(shotOverlay) shotOverlay.close(); shotOverlay = null;
        resolve(rect)
      })
    })
  })

  ipcMain.handle('cancel-screenshot-overlay', () => {
    if (shotOverlay) { shotOverlay.close(); shotOverlay = null; }
  })

  // --- 文件与下载 ---
  ipcMain.handle('download-file', async (event, payload) => {
    const dlItem = await download(mainWindow, payload.url, {
      filename: payload.filename, saveAs: true, openFolderWhenDone: true
    });
    return { success: true, savePath: dlItem.getSavePath() };
  });

  ipcMain.handle('open-file-dialog', async () => {
    return dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Supported', extensions: ALLOWED_EXTENSIONS }] })
  });
  
  ipcMain.handle('open-image-dialog', async () => {
    return dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Images', extensions: ALLOWED_IMAGE_EXTENSIONS }] })
  });
  
  ipcMain.handle('dialog:openDirectory', async () => {
    return dialog.showOpenDialog({ properties: ['openDirectory'] });
  });

  ipcMain.handle('readFile', async (_, path) => fs.promises.readFile(path));
  ipcMain.handle('check-path-exists', (_, path) => fs.existsSync(path));

  // --- 窗口交互 ---
  ipcMain.handle('window-action', (_, action) => {
    switch (action) {
      case 'show': mainWindow.show(); break;
      case 'hide': mainWindow.hide(); break;
      case 'minimize': mainWindow.minimize(); break;
      case 'maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break;
      case 'close': mainWindow.close(); break;
    }
  });

  ipcMain.handle('toggle-window-size', async (event, { width, height }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win.isMaximized()) {
      win.unmaximize();
      // 等待动画
      await new Promise(r => setTimeout(r, 100));
      win.setSize(width, height, true);
    } else {
      isMac ? win.maximize() : win.setSize(width, height, true);
    }
  });

  ipcMain.handle('set-always-on-top', (e, flag) => BrowserWindow.fromWebContents(e.sender).setAlwaysOnTop(flag, 'screen-saver'));
  
  ipcMain.handle('set-ignore-mouse-events', (event, ignore, options) => {
    BrowserWindow.fromWebContents(event.sender).setIgnoreMouseEvents(ignore, options);
  });
  
  ipcMain.handle('get-ignore-mouse-status', (event) => BrowserWindow.fromWebContents(event.sender).isIgnoreMouseEvents());

  // --- 右键菜单 ---
  ipcMain.handle('show-context-menu', async (event, { menuType, data }) => {
    let menuTemplate = [];
    if (menuType === 'image') {
      menuTemplate = [
        { label: locales[currentLanguage].copyImageLink, click: () => clipboard.writeText(data.src) },
        { label: locales[currentLanguage].copyImage, click: async () => {
           // 简化图片复制逻辑
           try {
             const image = data.src.startsWith('data:') 
               ? nativeImage.createFromDataURL(data.src)
               : nativeImage.createFromBuffer(await (await fetch(data.src)).arrayBuffer());
             clipboard.writeImage(image);
           } catch(e) { console.error(e) }
        }},
        { label: locales[currentLanguage].saveImageAs, click: async () => {
          const win = BrowserWindow.fromWebContents(event.sender);
          const { filePath } = await dialog.showSaveDialog(win, { defaultPath: `image_${Date.now()}.png` });
          if(filePath) {
             const buf = data.src.startsWith('data:') 
               ? nativeImage.createFromDataURL(data.src).toPNG()
               : Buffer.from(await (await fetch(data.src)).arrayBuffer());
             fs.writeFileSync(filePath, buf);
          }
        }}
      ];
    } else {
      menuTemplate = [{role: 'cut'}, {role: 'copy'}, {role: 'paste'}];
    }
    Menu.buildFromTemplate(menuTemplate).popup(BrowserWindow.fromWebContents(event.sender));
  });

  // --- 机器人停止请求 ---
  ['qq','feishu','telegram','discord'].forEach(bot => {
    ipcMain.handle(`request-stop-${bot}bot`, async () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        const handlerName = `stop${bot.charAt(0).toUpperCase() + bot.slice(1)}BotHandler`;
        await win.webContents.executeJavaScript(`window.${handlerName} && window.${handlerName}()`).catch(() => {});
      }
    });
  });

  // --- 其他杂项 ---
  ipcMain.handle('exec-command', (event, command) => {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
  });

  ipcMain.handle('check-for-updates', async () => {
    if(isDev) return { updateAvailable: false };
    try {
      const res = await autoUpdater.checkForUpdates();
      return { updateAvailable, updateInfo: res ? res.updateInfo : null };
    } catch(e) { return { updateAvailable: false, error: e.message }; }
  });
  
  ipcMain.handle('download-update', () => updateAvailable && autoUpdater.downloadUpdate());
  ipcMain.handle('quit-and-install', () => autoUpdater.quitAndInstall());
  
  ipcMain.on('set-language', (_, lang) => {
    if (lang === 'auto') lang = app.getLocale().startsWith('zh') ? 'zh-CN' : 'en-US';
    currentLanguage = lang;
    createTray(); // 刷新托盘菜单语言
  });

  ipcMain.on('open-external', (e, url) => shell.openExternal(url));
}

// ==========================================
// 退出处理
// ==========================================

app.on('before-quit', async () => {
  // 尝试清理机器人连接
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0 && !wins[0].isDestroyed()) {
     try {
       await wins[0].webContents.executeJavaScript(`
         window.stopQQBotHandler && window.stopQQBotHandler();
         window.stopFeishuBotHandler && window.stopFeishuBotHandler();
         window.stopDiscordBotHandler && window.stopDiscordBotHandler();
       `).catch(() => {});
     } catch(e) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('render-process-gone', (event, webContents, details) => {
  console.error('渲染进程崩溃:', details)
})

process.on('uncaughtException', (err) => {
  console.error('未捕获异常:', err)
})

// ==========================================
// UI 组件
// ==========================================

function createTray() {
  const iconPath = path.join(__dirname, 'static/source/icon_tray.png');
  if (!tray) {
    tray = new Tray(iconPath);
    tray.setToolTip('Super Agent Party');
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
      }
    });
  }
  const contextMenu = Menu.buildFromTemplate([
    { label: locales[currentLanguage].show, click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: locales[currentLanguage].exit, click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

// 禁用浏览器默认导航键
app.on('web-contents-created', (e, webContents) => {
  webContents.on('new-window', (event, url) => { event.preventDefault(); shell.openExternal(url); });
  webContents.on('input-event', (_ev, input) => {
    if (input.type === 'mouseDown' && (input.button === 3 || input.button === 4)) webContents.stopNavigation();
  });
  webContents.on('before-input-event', (_ev, input) => {
    if (input.alt && (input.key === 'Left' || input.key === 'Right')) input.preventDefault = true;
  });
});

app.commandLine.appendSwitch('disable-http-cache');