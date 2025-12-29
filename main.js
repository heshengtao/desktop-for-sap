const remoteMain = require('@electron/remote/main')
const { app, BrowserWindow, ipcMain, screen, shell, dialog, Tray, Menu } = require('electron')
const { clipboard, nativeImage,desktopCapturer  } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const { spawn } = require('child_process')
const { exec } = require('child_process');
const { download } = require('electron-dl');
const fs = require('fs')
const os = require('os')
const net = require('net') // 添加 net 模块用于端口检测
const dgram = require('dgram');
const osc = require('osc');
// ★ VMC：UDP 收发资源
let vmcUdpPort = null;          // osc.UDPPort 实例
let vmcReceiverActive = false;  // 接收是否运行
let vrmWindows = []; 
let shotOverlay = null
let isMac = process.platform === 'darwin';
const vmcSendSocket = dgram.createSocket('udp4'); // 发送复用同一 socket
const MAX_LOG_LINES = 2000; // 保留最近2000行日志
let logBuffer = []; // 内存日志缓冲区

function appendLogToBuffer(source, data) {
  const timestamp = new Date().toLocaleTimeString();
  const lines = data.toString().split(/\r?\n/);
  
  lines.forEach(line => {
    if (line.trim()) {
      logBuffer.push(`[${timestamp}] [${source}] ${line}`);
    }
  });

  // 清理旧日志，防止内存无限增长
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
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  if (!sources.length) throw new Error('无法获取屏幕源')

  // 1. 拿到全屏 PNG 缓冲区
  const pngBuffer = sources[0].thumbnail.toPNG()

  // 2. 用 Electron 自带的 nativeImage 裁
  const img  = nativeImage.createFromBuffer(pngBuffer)
  const cropped = img.crop({
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.floor(rect.width),
    height: Math.floor(rect.height)
  })

  // 3. 直接返回 Buffer，下游无需改
  return cropped.toPNG()
}

// ★ 替换原来的 startVMCReceiver
function startVMCReceiver(cfg) {
  if (vmcReceiverActive) return;
  vmcUdpPort = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: cfg.receive.port,
    metadata: true,
  });
  vmcUdpPort.open();
  vmcUdpPort.on('message', (oscMsg) => {

    /* -------- 1. 骨骼 -------- */
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

    /* -------- 2. 表情 -------- */
    if (oscMsg.address === '/VMC/Ext/Blend/Val') {
      if (!Array.isArray(oscMsg.args) || oscMsg.args.length < 2) return;
      vrmWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('vmc-osc-raw', oscMsg);
      });
      return;
    }

    /* -------- 3. 表情 Apply -------- */
    if (oscMsg.address === '/VMC/Ext/Blend/Apply') {
      // Apply 不带参数，长度 0 也合法
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

// 发送 VMC Bone -------------------------------------------------
function sendVMCBoneMain(data) {
  if (!data) return;
  const { boneName, position, rotation } = data;
  if (!boneName || !position || !rotation) return;

  const { host, port } = global.vmcCfg.send;          // ← 面板配置
  const oscMsg = osc.writePacket({
    address: `/VMC/Ext/Bone/Pos`,
    args: [
      { type: 's', value: boneName },
      { type: 'f', value: position.x || 0 },
      { type: 'f', value: position.y || 0 },
      { type: 'f', value: position.z || 0 },
      { type: 'f', value: rotation.x || 0 },
      { type: 'f', value: rotation.y || 0 },
      { type: 'f', value: rotation.z || 0 },
      { type: 'f', value: rotation.w || 1 },
    ],
  });
  vmcSendSocket.send(oscMsg, port, host, (err) => {
    if (err) console.error('VMC send error:', err);
  });
}

// 发送 VMC Blend ------------------------------------------------
function sendVMCBlendMain(data) {
  if (!data) return;
  const { blendName, weight } = data;
  if (typeof blendName !== 'string' || typeof weight !== 'number') return;

  const { host, port } = global.vmcCfg.send;          // ← 面板配置
  const oscMsg = osc.writePacket({
    address: '/VMC/Ext/Blend/Val',
    args: [
      { type: 's', value: blendName },
      { type: 'f', value: Math.max(0, Math.min(1, weight)) },
    ],
  });
  vmcSendSocket.send(oscMsg, port, host, (err) => {
    if (err) console.error('VMC blend send error:', err);
  });
}

// 发送 VMC Blend Apply ------------------------------------------
function sendVMCBlendApplyMain() {
  const { host, port } = global.vmcCfg.send;          // ← 面板配置
  const oscMsg = osc.writePacket({
    address: '/VMC/Ext/Blend/Apply',
    args: [],
  });
  vmcSendSocket.send(oscMsg, port, host);
}

let pythonExec;
let isQuitting = false;

// 判断操作系统
if (os.platform() === 'win32') {
  // Windows
  pythonExec = path.join('.venv', 'Scripts', 'python.exe');
} else {
  // macOS / Linux
  pythonExec = path.join('.venv', 'bin', 'python3');
}

let mainWindow
let loadingWindow
let tray = null
let updateAvailable = false
let backendProcess = null
const HOST = '127.0.0.1'
let PORT = 3456 // 改为 let，允许修改
const DEFAULT_PORT = 3456 // 保存默认端口
const isDev = process.env.NODE_ENV === 'development'
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
const ALLOWED_EXTENSIONS = [
  // 办公文档
    'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf', 'pages', 
    'numbers', 'key', 'rtf', 'odt', 'epub',
  
  // 编程开发
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs',
  'swift', 'kt', 'dart', 'rb', 'php', 'html', 'css', 'scss', 'less',
  'vue', 'svelte', 'jsx', 'tsx', 'json', 'xml', 'yml', 'yaml', 
  'sql', 'sh',
  
  // 数据配置
  'csv', 'tsv', 'txt', 'md', 'log', 'conf', 'ini', 'env', 'toml'
  ];
const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
let currentLanguage = 'zh-CN';

// 构建菜单项
let menu;

// 配置日志文件路径
const logDir = path.join(app.getPath('userData'), 'logs')
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}

// 获取配置文件路径
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 加载环境变量
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

loadEnvVariables();

// 新增：检测端口是否可用
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(port, HOST, () => {
      server.once('close', () => resolve(true))
      server.close()
    })
    server.on('error', () => resolve(false))
  })
}

// 新增：查找可用端口
async function findAvailablePort(startPort = DEFAULT_PORT, maxAttempts = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(`无法找到可用端口，已尝试 ${startPort} 到 ${startPort + maxAttempts - 1}`)
}

const networkVisible = process.env.networkVisible === 'global';
const BACKEND_HOST = networkVisible ? '0.0.0.0' : HOST
// 保存环境变量
function saveEnvVariable(key, value) {
  const configPath = getConfigPath();
  let config = {};
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath);
    config = JSON.parse(rawData);
  }
  config[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // 更新当前进程中的环境变量
  process.env[key] = value;
}


// 创建骨架屏窗口
function createSkeletonWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    frame: false,
    titleBarStyle: 'hiddenInset', // macOS 特有：隐藏标题栏但仍显示原生按钮
    trafficLightPosition: { x: 10, y: 12 }, // 自定义按钮位置（可选）
    show: true,
    icon: 'static/source/icon.png',
    webPreferences: {
      preload: path.join(__dirname, 'static/js/preload.js'),
      nodeIntegration: false,
      sandbox: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: false,
      devTools: isDev,
      partition: 'persist:main-session',
    }
  })

  remoteMain.enable(mainWindow.webContents)
  
  // 加载骨架屏页面
  mainWindow.loadFile(path.join(__dirname, 'static/skeleton.html'))
  
  // 设置自动更新
  setupAutoUpdater()
  
  // 窗口状态同步
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state', 'maximized')
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state', 'normal')
  })
  
  // 窗口关闭事件处理 - 最小化到托盘而不是退出
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
      return false
    }
    return true
  })
}

// 修改后的启动后端函数
async function startBackend() {
  try {
    console.log('🔍 开始启动后端进程...')
    
    const availablePort = await findAvailablePort(DEFAULT_PORT)
    PORT = availablePort
    
    if (PORT !== DEFAULT_PORT) {
      console.log(`⚠️  默认端口 ${DEFAULT_PORT} 被占用，已切换到端口 ${PORT}`)
    }
    
    // ★ 关键修改：无论开发还是生产模式都使用 pipe
    const spawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],  // 统一使用 pipe
      shell: false,
      env: {
        ...process.env,
        NODE_ENV: isDev ? 'development' : 'production',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PYTHON_WARNINGS: 'ignore'
      }
    }

    if (process.platform === 'win32') {
      spawnOptions.windowsHide = !isDev
      spawnOptions.detached = false
      spawnOptions.windowsVerbatimArguments = false
    }

    const networkVisible = process.env.networkVisible === 'global'
    const BACKEND_HOST = networkVisible ? '0.0.0.0' : HOST

    if (isDev) {
      console.log(`🐍 Starting development mode backend: ${pythonExec}`)
      console.log(`🌐 Address: http://${BACKEND_HOST}:${PORT}`)
      
      backendProcess = spawn(pythonExec, [
        '-u',  // 无缓冲模式，确保输出实时性
        'server.py',
        '--port', PORT.toString(),
        '--host', BACKEND_HOST,
      ], spawnOptions)
    } else {
      // 生产模式代码...
      const serverExecutable = process.platform === 'win32' ? 'server.exe' : 'server'
      const resourcesPath = process.resourcesPath || path.join(process.execPath, '..', 'resources')
      const exePath = path.join(resourcesPath, 'server', serverExecutable)
      
      backendProcess = spawn(exePath, [
        '--port', PORT.toString(),
        '--host', BACKEND_HOST,
      ], {
        ...spawnOptions,
        cwd: path.dirname(exePath)
      })
    }

    // ★ 自定义日志处理 - 解决卡死问题的关键
    if (backendProcess.stdout) {
      backendProcess.stdout.setEncoding('utf8')
      backendProcess.stdout.on('data', (data) => {
        // [新增] 存入内存缓冲区 (Dev 和 Prod 都执行)
        appendLogToBuffer('INFO', data);

        // 开发模式：实时显示在控制台
        if (isDev) {
          const output = data.toString().replace(/\r?\n$/, '')
          if (output.trim()) {
            console.log(`[BACKEND] ${output}`)
          }
        }
      })
    }

    if (backendProcess.stderr) {
      backendProcess.stderr.setEncoding('utf8')
      backendProcess.stderr.on('data', (data) => {
        // [新增] 存入内存缓冲区 (Dev 和 Prod 都执行)
        appendLogToBuffer('ERROR', data);

        if (isDev) {
          const output = data.toString().replace(/\r?\n$/, '')
          if (output.trim()) {
            if (output.includes('WARNING') || output.includes('DeprecationWarning')) {
              console.warn(`[BACKEND] ${output}`)
            } else {
              console.error(`[BACKEND] ${output}`)
            }
          }
        }
      })
    }

    // 进程事件处理
    backendProcess.on('spawn', () => {
      console.log('✅ Backend process started successfully')
    })

    backendProcess.on('error', (err) => {
      console.error('❌ Backend process error:', err)
    })

    backendProcess.on('close', (code, signal) => {
    const message = signal
      ? `Backend process terminated by signal ${signal}`
      : `Backend process exited with code: ${code}`
      
      if (isDev || code !== 0) {
        console.log(`🔄 ${message}`)
      }
    })

    // 优雅关闭处理
    process.on('SIGINT', () => {
      if (backendProcess && !backendProcess.killed) {
        console.log('🛑 正在关闭后端进程...')
        backendProcess.kill('SIGTERM')
      }
    })

    process.on('SIGTERM', () => {
      if (backendProcess && !backendProcess.killed) {
        backendProcess.kill('SIGTERM')
      }
    })

    return PORT
  } catch (error) {
    console.error('❌ 启动后端服务失败:', error)
    throw error
  }
}




// 修改等待后端函数
async function waitForBackend() {
  const MAX_RETRIES = 200
  const RETRY_INTERVAL = 500
  let retries = 0

  while (retries < MAX_RETRIES) {
    try {
      const response = await fetch(`http://${HOST}:${PORT}/health`)
      if (response.ok) {
        // 后端服务准备就绪，通知骨架屏页面
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('backend-ready', { port: PORT })
        }
        return
      }
    } catch (err) {
      retries++
      await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL))
    }
  }
  throw new Error('Backend failed to start')
}

// 配置自动更新
function setupAutoUpdater() {
  autoUpdater.autoDownload = false; // 先禁用自动下载
  if (isDev) {
    autoUpdater.on('error', (err) => {
      mainWindow.webContents.send('update-error', err.message);
    });
  }
  autoUpdater.on('update-available', (info) => {
    updateAvailable = true;
    // 显示更新按钮并开始下载
    mainWindow.webContents.send('update-available', info);
    autoUpdater.downloadUpdate(); // 自动开始下载
  });
  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow.webContents.send('download-progress', {
      percent: progressObj.percent.toFixed(1),
      transferred: (progressObj.transferred / 1024 / 1024).toFixed(2),
      total: (progressObj.total / 1024 / 1024).toFixed(2)
    });
  });
  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('update-downloaded');
  });
}

// 确保只运行一个实例
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // 如果无法获得锁（说明已经有一个实例在运行），我们不应该显示错误
  // 因为第一个实例会处理显示窗口
  setTimeout(() => {
    app.quit()
  }, 0)
  return
}

// 监听第二个实例的启动
app.on('second-instance', (event, commandLine, workingDirectory) => {
  // 当运行第二个实例时，显示主窗口
  if (mainWindow) {
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  }
})
ipcMain.handle('get-window-size', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win.getSize();
});

// 只有在获得锁（第一个实例）时才执行初始化
app.whenReady().then(async () => {
  try {
      // 默认配置
    global.vmcCfg = {
      receive: { enable: false, port: 39539,syncExpression: false },
      send:    { enable: false, host: '127.0.0.1', port: 39540 }
    };
    ipcMain.handle('get-vmc-config', () => {
      // 保证字段存在，避免 undefined
      global.vmcCfg.receive.syncExpression ??= false;
      return global.vmcCfg;
    });
    // 创建骨架屏窗口
    createSkeletonWindow()
    if (global.vmcCfg.receive.enable) startVMCReceiver(global.vmcCfg);
    // 启动后端服务（现在会自动查找可用端口）
    const actualPort = await startBackend()
    ipcMain.handle('get-backend-logs', () => {
      return logBuffer.join('\n');
    });
    // 等待后端服务准备就绪
    await waitForBackend()
    
    // 后端服务准备就绪后，加载完整内容
    console.log(`Backend server is running at http://${HOST}:${PORT}`)

    // 添加获取端口信息的 IPC 处理
    ipcMain.handle('get-server-info', () => {
      return {
        port: PORT,
        defaultPort: DEFAULT_PORT,
        isDefaultPort: PORT === DEFAULT_PORT
      }
    })

    ipcMain.handle('set-env', async (event, arg) => {
      saveEnvVariable(arg.key, arg.value);
    });
    //重启应用
    ipcMain.handle('restart-app', () => {
      app.relaunch();
      app.exit();
    })

    // 在 main.js 的 app.whenReady().then(async () => { 中添加以下代码

    ipcMain.handle('open-extension-window', async (_, { url, extension }) => {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      
      // 根据扩展配置决定窗口属性
      const windowConfig = {
        width: extension.width || 800,
        height: extension.height || 600,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          webSecurity: false,
          devTools: isDev,
          preload: path.join(__dirname, 'static/js/preload.js')
        }
      };

      // 如果扩展需要透明和无边框
      if (extension.transparent) {
        Object.assign(windowConfig, {
          frame: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: false,
          hasShadow: false,
          backgroundColor: 'rgba(0, 0, 0, 0)',
        });
      } else {
        // 普通窗口配置
        Object.assign(windowConfig, {
          frame: true,
          transparent: false,
          titleBarStyle: isMac ? 'hiddenInset' : 'default',
          icon: 'static/source/icon.png'
        });
      }

      const extensionWindow = new BrowserWindow(windowConfig);
      
      // 启用远程模块
      remoteMain.enable(extensionWindow.webContents);
      
      // 加载URL
      await extensionWindow.loadURL(url);
      
      // 如果是透明窗口，设置一些特殊行为
      if (extension.transparent) {
        // 可以根据需要设置鼠标穿透等行为
        // extensionWindow.setIgnoreMouseEvents(false);
      }
      
      return extensionWindow.id;
    });


    ipcMain.handle('start-vrm-window', async (_, windowConfig = {}) => {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;

      // 使用传入的配置或默认值
      const windowWidth = windowConfig.width || 540;
      const windowHeight = windowConfig.height || 960;

      const x = windowConfig.x !== undefined ? windowConfig.x : width - windowWidth - 40;
      const y = windowConfig.y !== undefined ? windowConfig.y : 0;

      const vrmWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        x,
        y,
        transparent: true,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        acceptFirstMouse: true,
        backgroundColor: 'rgba(0, 0, 0, 0)',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: true,
          enableRemoteModule: true,
          sandbox: false,
          webgl: true,
          devTools: isDev,
          webAudio: true,
          autoplayPolicy: 'no-user-gesture-required',
          preload: path.join(__dirname, 'static/js/preload.js')
        }
      });

      // 加载页面
      await vrmWindow.loadURL(`http://${HOST}:${PORT}/vrm.html`);
      // 默认设置（不穿透，可以交互）
      vrmWindow.setIgnoreMouseEvents(false);
      vrmWindow.setAlwaysOnTop(true);
      // 保存窗口引用
      vrmWindows.push(vrmWindow);

      // 窗口关闭处理
      vrmWindow.on('closed', () => {
        vrmWindows = vrmWindows.filter(w => w !== vrmWindow);
      });

      return vrmWindow.id;  // 可选：返回窗口 ID 用于后续操作
    });
    // 👈 桌面截图
    ipcMain.handle('capture-desktop', async () => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 } // 可按需改
      })
      if (!sources.length) throw new Error('无法获取屏幕源')
      const pngBuffer = sources[0].thumbnail.toPNG() // 返回原生 Buffer
      return pngBuffer // 给渲染进程
    })

    ipcMain.handle('crop-desktop', async (e, { rect }) => {
      const png = await cropDesktop(rect)          // 不管是 sharp 还是 nativeImage
      return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
    })

    ipcMain.handle('show-screenshot-overlay', async () => {
      // 1. 隐藏主窗口
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()

      // 2. 创建全屏无框透明窗口
      const { width, height } = screen.getPrimaryDisplay().bounds
      shotOverlay = new BrowserWindow({
        x: 0, y: 0, width, height,
        frame: false, transparent: true, alwaysOnTop: true,
        skipTaskbar: true, resizable: false, movable: false,
        enableLargerThanScreen: true,
        webPreferences: {
          contextIsolation: true,
          preload: path.join(__dirname, 'static/js/shotPreload.js')
        }
      })
      shotOverlay.setIgnoreMouseEvents(false)
      shotOverlay.loadFile(path.join(__dirname, 'static/shotOverlay.html'))
      shotOverlay.setVisibleOnAllWorkspaces(true)

      return new Promise((resolve) => {
        // 等待渲染进程把选区传回来
        ipcMain.once('screenshot-selected', (e, rect) => {
          shotOverlay.close()
          shotOverlay = null
          resolve(rect)   // {x,y,width,height}
        })
      })
    })

    ipcMain.handle('cancel-screenshot-overlay', () => {
      if (shotOverlay && !shotOverlay.isDestroyed()) {
        shotOverlay.close()
        shotOverlay = null
      }
    })


    // 添加IPC处理器
    ipcMain.handle('set-ignore-mouse-events', (event, ignore, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win.setIgnoreMouseEvents(ignore, options);
    });
    ipcMain.handle('dialog:openDirectory', async () => {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
      });
      return result;
    });
    // 添加新的IPC处理器
    ipcMain.handle('get-ignore-mouse-status', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win.isIgnoreMouseEvents();
    });
    ipcMain.handle('stop-vrm-window', (_, windowId) => {
      if (windowId !== undefined) {
        const win = vrmWindows.find(w => w.id === windowId);
        if (win && !win.isDestroyed()) {
          win.close();
        }
        vrmWindows = vrmWindows.filter(w => w.id !== windowId);
      } else {
        // 关闭所有窗口
        vrmWindows.forEach(win => {
          if (!win.isDestroyed()) {
            win.close();
          }
        });
        vrmWindows = [];
      }
    });
    // 统一处理下载
    ipcMain.handle('download-file', async (event, payload) => {

      const { url, filename } = payload;   // 这里再解构即可
      const dlItem = await download(mainWindow, url, {
        filename,
        saveAs: true,
        openFolderWhenDone: true
      });
      return { success: true, savePath: dlItem.getSavePath() };
    });
    // 检查更新IPC
    ipcMain.handle('check-for-updates', async () => {
      if (isDev) {
        console.log('Auto updates are disabled in development mode.')
        return { updateAvailable: false }
      }
      try {
        const result = await autoUpdater.checkForUpdates()
        // 只返回必要的可序列化数据
        return {
          updateAvailable: updateAvailable,
          updateInfo: result ? {
            version: result.updateInfo.version,
            releaseDate: result.updateInfo.releaseDate
          } : null
        }
      } catch (error) {
        console.error('检查更新出错:', error)
        return { 
          updateAvailable: false, 
          error: error.message 
        }
      }
    })

    // 下载更新IPC
    ipcMain.handle('download-update', () => {
      if (updateAvailable) {
        return autoUpdater.downloadUpdate()
      }
    })

    // 安装更新IPC
    ipcMain.handle('quit-and-install', () => {
      setTimeout(() => autoUpdater.quitAndInstall(), 500);
    });
            
    // 加载主页面
    await mainWindow.loadURL(`http://${HOST}:${PORT}`)
    ipcMain.on('set-language', (_, lang) => {
      if (lang === 'auto') {
        // 获取系统设置，默认是'en-US'，如果系统语言是中文，则设置为'zh-CN'
        const systemLang = app.getLocale().split('-')[0];
        lang = systemLang === 'zh' ? 'zh-CN' : 'en-US';
      }
      currentLanguage = lang;
      updateTrayMenu();
      updatecontextMenu();
    });
    // 创建系统托盘
    createTray();
    updatecontextMenu();
    // ★ 下面这段就是你要放的「主进程 IPC + 默认配置」
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

    ['send-vmc-bone','send-vmc-blend','send-vmc-blend-apply'].forEach(method => {
      ipcMain.removeHandler(method);          // 清掉旧注册
      ipcMain.handle(method, (e, data) => {
        if (!global.vmcCfg?.send.enable) return;   // 总开关
        // 下面就是原来的实现（直接写，或抽成函数调用都可）
        switch (method) {
          case 'send-vmc-bone':
            return sendVMCBoneMain(data);      // 你自己已有的实现
          case 'send-vmc-blend':
            return sendVMCBlendMain(data);
          case 'send-vmc-blend-apply':
            return sendVMCBlendApplyMain();
        }
      });
    });

    // 窗口控制事件
    ipcMain.handle('window-action', (_, action) => {
      switch (action) {
        case 'show':
          mainWindow.show()
          break
        case 'hide':
          mainWindow.hide()
          break
        case 'minimize':
          mainWindow.minimize()
          break
        case 'maximize':
          mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
          break
        case 'close':
          mainWindow.close()
          break
      }
    })
    ipcMain.handle('toggle-window-size', async (event, { width, height }) => {
      const win = BrowserWindow.fromWebContents(event.sender);

      if (win.isMaximized()) {
        // 1. 开始还原
        win.unmaximize();

        if (isMac){
          // 2. 等到连续 50 ms 内尺寸不再变化，才算“真正还原完成”
          let last = win.getNormalBounds();
          for (let i = 0; i < 10; i++) {          // 最多 500 ms
            await new Promise(r => setTimeout(r, 50));
            const curr = win.getNormalBounds();
            if (curr.width === last.width && curr.height === last.height) break;
            last = curr;
          }
        }else {
          // 2. 等窗口“彻底”变成普通状态
          for (let i = 0; i < 20; i++) {          // 最多 1 s
            await new Promise(r => setTimeout(r, 50));
            if (!win.isMaximized()) break;        // 真正退出后即可跳出
          }
        }


        // 3. 现在再改助手尺寸，系统不会再覆盖
        win.setSize(width, height, true);
      } else {
        if (isMac) {
            win.maximize();
        }else{
            win.setSize(width, height, true);
        }
      }
    });

    ipcMain.handle('set-always-on-top', (e, flag) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      win.setAlwaysOnTop(flag, 'screen-saver');
    });
    // 窗口状态同步
    mainWindow.on('maximize', () => {
      mainWindow.webContents.send('window-state', 'maximized')
    })
    mainWindow.on('unmaximize', () => {
      mainWindow.webContents.send('window-state', 'normal')
    })
    
    // 窗口关闭事件处理 - 最小化到托盘而不是退出
    mainWindow.on('close', (event) => {
      if (!app.isQuitting) {
        event.preventDefault()
        mainWindow.hide()
        return false
      }
      return true
    })
    mainWindow.on('resize', () => {
      const size = mainWindow.getSize();
      mainWindow.webContents.send('window-resized', size);
    });

    // ★ 新增：增强型复制函数（同时支持粘贴为图片和粘贴为文件）
    function copyImageToClipboardWithFile(image) {
      try {
        // 1. 保存图片到临时目录
        const tempDir = os.tmpdir();
        // 生成带时间戳的文件名，避免冲突
        const fileName = `image_${Date.now()}.png`;
        const filePath = path.join(tempDir, fileName);
        
        // 将 nativeImage 转换为 buffer 并写入磁盘
        const buffer = image.toPNG();
        fs.writeFileSync(filePath, buffer);

        // 2. 准备剪贴板数据对象
        const clipboardData = {
          image: image, // 写入位图数据 (用于粘贴到聊天框/PS)
        };

        // 3. 根据系统添加文件路径数据 (用于粘贴到文件夹)
        if (process.platform === 'win32') {
          // --- Windows (CF_HDROP) ---
          // 构造 DROPFILES 结构体
          // 结构: offset(4) + pt(8) + fNC(4) + fWide(4) + path(UTF16) + double-null
          const pathBuffer = Buffer.from(filePath, 'ucs2');
          const dropFiles = Buffer.alloc(20 + pathBuffer.length + 4);
          
          dropFiles.writeUInt32LE(20, 0); // pFiles (offset)
          dropFiles.writeUInt32LE(1, 16); // fWide (Unicode flag)
          pathBuffer.copy(dropFiles, 20); // 写入路径
          dropFiles.writeUInt32LE(0, 20 + pathBuffer.length); // 结尾的双 null

          clipboardData['CF_HDROP'] = dropFiles;
          
        } else if (process.platform === 'darwin') {
          // --- macOS (NSFilenamesPboardType) ---
          // 写入 Property List XML
          const plist = `
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
              <array>
                <string>${filePath}</string>
              </array>
            </plist>
          `;
          clipboardData['NSFilenamesPboardType'] = plist;
        }
        // Linux 通常支持 text/uri-list，这里暂从略，如有需要可补充

        // 4. 一次性写入所有格式
        clipboard.write(clipboardData);
        
        console.log(`已复制图片及文件路径: ${filePath}`);

      } catch (err) {
        console.error('增强复制失败，回退到普通复制:', err);
        // 如果出错，至少尝试写入纯图片
        clipboard.writeImage(image);
      }
    }

    // 修改 show-context-menu 的 IPC 处理
    ipcMain.handle('show-context-menu', async (event, { menuType, data }) => {
      let menuTemplate;
      
    if (menuType === 'image') {
        menuTemplate = [
          {
            label: locales[currentLanguage].copyImageLink,
            click: () => clipboard.writeText(data.src)
          },
          {
            label: locales[currentLanguage].copyImage,
            click: async () => {
              // 恢复为最基础、最稳定的图片复制（仅像素数据）
              // 解决之前写入文件路径导致的兼容性问题
              try {
                if (data.src.startsWith('data:')) {
                  const image = nativeImage.createFromDataURL(data.src);
                  clipboard.writeImage(image);
                } else if (data.src.startsWith('http')) {
                  const response = await fetch(data.src);
                  const blob = await response.blob();
                  const buffer = await blob.arrayBuffer();
                  const image = nativeImage.createFromBuffer(Buffer.from(buffer));
                  clipboard.writeImage(image);
                } else {
                  const image = nativeImage.createFromPath(data.src);
                  clipboard.writeImage(image);
                }
              } catch (error) {
                console.error('复制图片失败:', error);
              }
            }
          },
          // ★ 新增：图片另存为功能
          {
            label: locales[currentLanguage].saveImageAs,
            click: async () => {
              try {
                const win = BrowserWindow.fromWebContents(event.sender);
                let buffer = null;
                let defaultExtension = 'png';

                // 1. 获取图片数据 Buffer
                if (data.src.startsWith('data:')) {
                  // 处理 Base64
                  const image = nativeImage.createFromDataURL(data.src);
                  buffer = image.toPNG();
                  defaultExtension = 'png';
                } else if (data.src.startsWith('http')) {
                  // 处理网络图片
                  const response = await fetch(data.src);
                  const blob = await response.blob();
                  buffer = Buffer.from(await blob.arrayBuffer());
                  // 简单猜测扩展名，默认 png
                  if (data.src.toLowerCase().endsWith('.jpg') || data.src.toLowerCase().endsWith('.jpeg')) {
                    defaultExtension = 'jpg';
                  } else if (data.src.toLowerCase().endsWith('.gif')) {
                    defaultExtension = 'gif';
                  } else if (data.src.toLowerCase().endsWith('.webp')) {
                    defaultExtension = 'webp';
                  }
                } else {
                  // 处理本地文件
                  buffer = fs.readFileSync(data.src);
                  defaultExtension = path.extname(data.src).replace('.', '') || 'png';
                }

                // 2. 弹出保存对话框
                const { filePath } = await dialog.showSaveDialog(win, {
                  title: locales[currentLanguage].saveImageAs,
                  defaultPath: `image_${Date.now()}.${defaultExtension}`,
                  filters: [
                    { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
                    { name: 'All Files', extensions: ['*'] }
                  ]
                });

                // 3. 写入文件
                if (filePath) {
                  fs.writeFileSync(filePath, buffer);
                  // 可选：提示保存成功，或者不做打扰
                  // console.log('图片已保存至:', filePath);
                }
              } catch (error) {
                console.error('图片另存为失败:', error);
                dialog.showErrorBox('保存失败', '无法保存该图片: ' + error.message);
              }
            }
          }
        ];
      } else {
        // 原有基础菜单
        menuTemplate = [
          { label: locales[currentLanguage].cut, role: 'cut' },
          { label: locales[currentLanguage].copy, role: 'copy' },
          { label: locales[currentLanguage].paste, role: 'paste' }
        ];
      }

      menu = Menu.buildFromTemplate(menuTemplate);
      menu.popup(BrowserWindow.fromWebContents(event.sender));
    });
    // 监听关闭事件
    ipcMain.handle('request-stop-qqbot', async (event) => {
      const win = BrowserWindow.getAllWindows()[0]; // 获取主窗口
      if (win && !win.isDestroyed()) {
        // 通过webContents执行渲染进程方法
        await win.webContents.executeJavaScript(`
          window.stopQQBotHandler && window.stopQQBotHandler()
        `);
      }
    });
    ipcMain.handle('request-stop-feishubot', async (event) => {
      const win = BrowserWindow.getAllWindows()[0]; // 获取主窗口
      if (win && !win.isDestroyed()) {
        // 通过webContents执行渲染进程方法
        await win.webContents.executeJavaScript(`
          window.stopFeishuBotHandler && window.stopFeishuBotHandler()
        `);
      }
    });
    ipcMain.handle('request-stop-telegrambot', async (event) => {
      const win = BrowserWindow.getAllWindows()[0]; // 获取主窗口
      if (win && !win.isDestroyed()) {
        // 通过webContents执行渲染进程方法
        await win.webContents.executeJavaScript(`
          window.stopTelegramBotHandler && window.stopTelegramBotHandler()
        `);
      }
    });
    ipcMain.handle('request-stop-discordbot', async (event) => {
      const win = BrowserWindow.getAllWindows()[0]; // 获取主窗口
      if (win && !win.isDestroyed()) {
        // 通过webContents执行渲染进程方法
        await win.webContents.executeJavaScript(`
          window.stopDiscordBotHandler && window.stopDiscordBotHandler()
        `);
      }
    });
    ipcMain.handle('exec-command', (event, command) => {
      return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
    });
    // 其他IPC处理...
    ipcMain.on('open-external', (event, url) => {
      shell.openExternal(url)
        .then(() => console.log(`Opened ${url} in the default browser.`))
        .catch(err => console.error(`Error opening ${url}:`, err))
    })
    ipcMain.handle('readFile', async (_, path) => {
      return fs.promises.readFile(path);
    });
    // 文件对话框处理器
    ipcMain.handle('open-file-dialog', async (options) => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: locales[currentLanguage].supportedFiles, extensions: ALLOWED_EXTENSIONS },
          { name: locales[currentLanguage].allFiles, extensions: ['*'] }
        ]
      })
      return result
    })
    ipcMain.handle('open-image-dialog', async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: locales[currentLanguage].supportedimages, extensions: ALLOWED_IMAGE_EXTENSIONS },
          { name: locales[currentLanguage].allFiles, extensions: ['*'] }
        ]
      })
      // 返回包含文件名和路径的对象数组
      return result
    });
    ipcMain.handle('check-path-exists', (_, path) => {
      return fs.existsSync(path)
    })

  } catch (err) {
    console.error('启动失败:', err)
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.close()
    }
    dialog.showErrorBox('启动失败', `服务启动失败: ${err.message}`)
    app.quit()
  }
})



// 应用退出处理
app.on('before-quit', async (event) => {
  // 防止重复处理退出事件
  if (isQuitting) return;
  
  // 标记退出状态并阻止默认退出行为
  isQuitting = true;
  event.preventDefault();
  
  try {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    
    // 1. 尝试停止QQ机器人
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.executeJavaScript(`
        if (window.stopQQBotHandler) {
          window.stopQQBotHandler();
        }
      `);
      
      await mainWindow.webContents.executeJavaScript(`
        if (window.stopFeishuBotHandler) {
          window.stopFeishuBotHandler();
        }
      `);
      await mainWindow.webContents.executeJavaScript(`
        if (window.stopDiscordBotHandler) {
          window.stopDiscordBotHandler();
        }
      `);

      // 等待机器人停止（最多1秒）
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // 2. 停止后端进程
    if (backendProcess) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', backendProcess.pid, '/f', '/t']);
      } else {
        backendProcess.kill('SIGKILL');
      }
      backendProcess = null;
    }
  } catch (error) {
    console.error('退出时发生错误:', error);
  } finally {
    // 3. 最终退出应用
    app.exit(0);
  }
});

// 自动退出处理
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 处理渲染进程崩溃
app.on('render-process-gone', (event, webContents, details) => {
  console.error('渲染进程崩溃:', details)
  dialog.showErrorBox('应用崩溃', `渲染进程异常: ${details.reason}`)
})

// 处理主进程未捕获异常
process.on('uncaughtException', (err) => {
  console.error('未捕获异常:', err)
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.close()
  }
  dialog.showErrorBox('致命错误', `未捕获异常: ${err.message}`)
  app.quit()
})

function createTray() {
  const iconPath = path.join(__dirname, 'static/source/icon_tray.png');
  if (!tray) {
    tray = new Tray(iconPath);
    tray.setToolTip('Super Agent Party');
    tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        } else {
          mainWindow.show();
        }
      }
    });
  }
  updateTrayMenu();
}
function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: locales[currentLanguage].show,
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: locales[currentLanguage].exit,
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])
  
  tray.setContextMenu(contextMenu);
}

function updatecontextMenu() {
  menu = Menu.buildFromTemplate([
    {
      label: locales[currentLanguage].cut,
      role: 'cut'
    },
    {
      label: locales[currentLanguage].copy,
      role: 'copy'
    },
    {
      label: locales[currentLanguage].paste,
      role: 'paste'
    }
  ]);
}

app.on('web-contents-created', (e, webContents) => {
  webContents.on('new-window', (event, url) => {
  event.preventDefault();
  shell.openExternal(url);
  });
});

// 禁用所有 WebContents 的前进/后退
app.on('web-contents-created', (_event, wc) => {
  // 1. 拦截鼠标侧键 / 触摸板手势
  wc.on('input-event', (_ev, input) => {
    // 浏览器侧键对应的 button 是 3（后退）和 4（前进）
    if (input.type === 'mouseDown' && (input.button === 3 || input.button === 4)) {
      // 阻止默认行为（相当于把事件吃掉）
      wc.stopNavigation();
      return;
    }
  });

  // 2. 拦截 Alt+Left / Alt+Right 快捷键
  wc.on('before-input-event', (_ev, input) => {
    const { alt, key } = input;
    if (alt && (key === 'Left' || key === 'Right')) {
      // 标记为已处理，Electron 就不会再分发
      input.preventDefault = true;
    }
  });
});

app.commandLine.appendSwitch('disable-http-cache');