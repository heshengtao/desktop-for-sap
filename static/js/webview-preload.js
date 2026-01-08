// --- START OF FILE webview-preload.js ---

// static/js/webview-preload.js
const { ipcRenderer, webFrame } = require('electron');

const stealthScript = `
(() => {
    // 0. 防重复注入标记
    const INJECT_KEY = '__stealth_injected_' + Math.random().toString(36).slice(2);
    if (window[INJECT_KEY]) return;
    window[INJECT_KEY] = true;

    // 1. 定义核心伪装函数
    const spoof = (win) => {
        // 防止对已经伪装过的窗口重复操作
        if (!win || win.__spoofed_v2) return;
        
        // 标记已处理
        try {
            Object.defineProperty(win, '__spoofed_v2', { value: true, enumerable: false });
        } catch(e) {}

        // --- A. 彻底抹除 navigator.webdriver (关键修复) ---
        try {
            // 1. 删除 navigator 实例上的 webdriver 属性
            // Electron 可能会在实例上定义它，必须删掉，否则会被检测到“属性位置不对”
            if (win.navigator.hasOwnProperty('webdriver')) {
                delete win.navigator.webdriver;
            }

            // 2. 获取 Navigator 原型链
            const navProto = win.Navigator.prototype;

            // 3. 删除原型链上可能存在的原生 getter
            delete navProto.webdriver;

            // 4. 在原型链上重新定义 webdriver，使其返回 false
            // 这样 Object.getPrototypeOf(navigator).webdriver === false (符合原生)
            // 而 navigator.hasOwnProperty('webdriver') === false (符合原生)
            Object.defineProperty(navProto, 'webdriver', {
                get: () => false, // 返回 false 比 undefined 更像原生非自动化环境
                enumerable: true,
                configurable: true
            });
        } catch (e) { console.error('Spoof webdriver failed', e); }

        // --- B. 伪造 window.chrome (关键修复) ---
        try {
            // 只有当主窗口有 chrome 或者为了通过检测必须有时才添加
            // Headless Chrome 检测通常看 iframe 里有没有 chrome
            if (!win.chrome) {
                const makeFake = (name) => {
                    const Fake = function() {};
                    Object.defineProperty(Fake, 'name', { value: name });
                    const inst = new Fake();
                    // 某些检测会检查 constructor.name
                    Object.defineProperty(inst.constructor, 'name', { value: name });
                    return inst;
                };
                
                const mock = {
                    app: makeFake('App'),
                    runtime: makeFake('Runtime'),
                    csi: () => {},
                    loadTimes: () => {}
                };
                
                mock.app.isInstalled = false;
                mock.app.InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
                mock.app.RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
                
                mock.runtime.OnInstalledReason = { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' };
                mock.runtime.connect = () => {};
                mock.runtime.sendMessage = () => {};
                mock.runtime.id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 随便给个 ID

                Object.defineProperty(win, 'chrome', { value: mock, writable: true, configurable: true });
            }
        } catch (e) { console.error('Spoof chrome failed', e); }

        // --- C. 伪造 Plugins (SannySoft 检查点) ---
        try {
            if (!win.navigator.plugins || win.navigator.plugins.length === 0) {
                 const pdfDesc = {
                     name: 'Chrome PDF Viewer',
                     filename: 'internal-pdf-viewer',
                     description: 'Portable Document Format'
                 };
                 
                 const makePlugin = () => {
                     const p = {}; 
                     p.name = pdfDesc.name;
                     p.filename = pdfDesc.filename;
                     p.description = pdfDesc.description;
                     p.length = 1;
                     return p;
                 };
                 
                 const pdfPlugin = makePlugin();
                 const plugins = [pdfPlugin, pdfPlugin, pdfPlugin, pdfPlugin, pdfPlugin];
                 
                 // 模拟 PluginArray 行为
                 plugins.item = function(i) { return this[i]; };
                 plugins.namedItem = function(name) { return this.find(p => p.name === name) || null; };
                 plugins.refresh = () => {};

                 Object.defineProperty(win.navigator, 'plugins', {
                     get: () => plugins,
                     enumerable: true,
                     configurable: true
                 });
                 
                 const mime = { type: 'application/pdf', suffixes: 'pdf', enabledPlugin: pdfPlugin };
                 const mimes = [mime];
                 mimes.item = function(i) { return this[i]; };
                 mimes.namedItem = function(name) { return this.find(m => m.type === name) || null; };
                 
                 Object.defineProperty(win.navigator, 'mimeTypes', {
                     get: () => mimes,
                     enumerable: true,
                     configurable: true
                 });
            }
        } catch (e) {}

        // --- D. 修正 UserAgent (一致性检查) ---
        // Iframe 可能会回退到默认 UA，导致 HEADCHR_IFRAME 里的 UA 检查失败
        try {
            if (win.navigator.userAgent !== window.navigator.userAgent) {
                const userAgent = window.navigator.userAgent;
                Object.defineProperty(win.navigator, 'userAgent', {
                    get: () => userAgent,
                    configurable: true
                });
            }
        } catch (e) {}
    };

    // 2. 立即把主窗口洗白
    spoof(window);

    // 3. ★★★ 解决 HEADCHR_IFRAME 的核武器 ★★★
    try {
        const iframeProto = window.HTMLIFrameElement.prototype;
        const rawContentWindowGetter = Object.getOwnPropertyDescriptor(iframeProto, 'contentWindow').get;

        Object.defineProperty(iframeProto, 'contentWindow', {
            get: function() {
                const win = rawContentWindowGetter.apply(this);
                // 只要一获取，立马伪装
                if (win) {
                    spoof(win);
                }
                return win;
            },
            enumerable: true,
            configurable: true
        });
        
        // 同样处理 contentDocument，防止通过 doc.defaultView 获取 window
        const rawContentDocumentGetter = Object.getOwnPropertyDescriptor(iframeProto, 'contentDocument').get;
        Object.defineProperty(iframeProto, 'contentDocument', {
            get: function() {
                const doc = rawContentDocumentGetter.apply(this);
                if (doc && doc.defaultView) {
                    spoof(doc.defaultView);
                }
                return doc;
            },
            enumerable: true,
            configurable: true
        });

    } catch(e) { 
        console.error('Failed to hook iframe prototype', e); 
    }

    // 4. 劫持 createElement (辅助防御)
    // 有些脚本创建 iframe 后不插入 DOM 直接操作，这时候 contentWindow 可能是 null，
    // 但一旦插入 DOM，上面的 contentWindow getter 就会生效。
    // 为了保险，我们还是监控 appendChild
    const rawAppend = window.Element.prototype.appendChild;
    window.Element.prototype.appendChild = function(node) {
        const res = rawAppend.apply(this, arguments);
        if (node && (node.tagName === 'IFRAME' || node.tagName === 'FRAME')) {
            try {
                if (node.contentWindow) spoof(node.contentWindow);
                if (node.contentDocument && node.contentDocument.defaultView) spoof(node.contentDocument.defaultView);
            } catch(e) {}
        }
        return res;
    };

})();
`;

// -----------------------------------------------------------------------
// 立即注入到主世界
// -----------------------------------------------------------------------
try {
    webFrame.executeJavaScript(stealthScript);
} catch (e) {
    console.error('Stealth injection failed:', e);
}

// 默认文本
let i18n = {
    translate: 'Translate',
    askAI: 'Ask AI',
    read: 'Read',
    copy: 'Copy',
    close: 'Close',
    loading: 'Generating...'
};

let toolbar = null;
let resultBox = null;
let currentSelection = '';

// 初始化 DOM
function initToolbar() {
    if (document.getElementById('sap-ai-toolbar')) return;

    // 1. 注入样式
    const style = document.createElement('style');
    style.textContent = `
        #sap-ai-toolbar {
            position: fixed;
            z-index: 2147483647;
            background: #222;
            color: #fff;
            border-radius: 8px;
            padding: 6px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            display: none;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            user-select: none;
            flex-direction: column;
            align-items: flex-start;
            transition: opacity 0.2s, top 0.2s, left 0.2s;
            pointer-events: auto;
            max-width: 380px;
            width: auto;
            box-sizing: border-box;
        }
        
        .sap-btn-row {
            display: flex;
            align-items: center;
            gap: 4px;
            width: 100%;
            padding: 0 2px;
            box-sizing: border-box;
        }

        #sap-ai-toolbar button {
            background: none;
            border: none;
            color: #ccc;
            padding: 5px 8px;
            cursor: pointer;
            display: inline-block;
            font-size: 12px;
            font-weight: 500;
            border-radius: 4px;
            transition: all 0.2s;
            outline: none;
            line-height: 1;
            white-space: nowrap;
        }
        #sap-ai-toolbar button:hover {
            background: rgba(255,255,255,0.2);
            color: #fff;
        }
        #sap-ai-toolbar .divider {
            width: 1px;
            background: #444;
            height: 14px;
            margin: 0 2px;
        }

        #sap-ai-result {
            display: none;
            width: 100%;
            min-width: 240px;
            max-height: 300px;
            overflow-y: auto;
            box-sizing: border-box;
            padding: 10px 12px;
            margin-top: 8px;
            background-color: rgba(255, 255, 255, 0.05);
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 13px;
            line-height: 1.6;
            color: #e0e0e0;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            word-break: break-word;
            user-select: text;
        }
        
        #sap-ai-result::-webkit-scrollbar {
            width: 6px;
        }
        #sap-ai-result::-webkit-scrollbar-thumb {
            background: #555;
            border-radius: 3px;
        }
        #sap-ai-result::-webkit-scrollbar-track {
            background: transparent;
        }

        #sap-ai-result.active {
            display: block;
            animation: sap-fade-in 0.2s ease-out;
        }
        
        @keyframes sap-fade-in {
            from { opacity: 0; transform: translateY(-5px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .result-close-btn {
            float: right;
            color: #888;
            cursor: pointer;
            margin-left: 8px;
            margin-bottom: 4px;
            font-size: 16px;
            line-height: 14px;
            font-weight: bold;
            transition: color 0.2s;
        }
        .result-close-btn:hover { color: #fff; }
    `;
    document.head.appendChild(style);

    // 2. 创建工具栏容器
    toolbar = document.createElement('div');
    toolbar.id = 'sap-ai-toolbar';
    document.body.appendChild(toolbar);
    
    // 渲染内部结构
    renderToolbarUI();

    // 3. 绑定 Webview 内部的交互事件
    bindEvents();
}

function renderToolbarUI() {
    if (!toolbar) return;
    
    toolbar.innerHTML = `
        <div class="sap-btn-row" id="sap-btns">
            <button id="ai-btn-trans">${i18n.translate}</button>
            <div class="divider"></div>
            <button id="ai-btn-ask">${i18n.askAI}</button>
            <div class="divider"></div>
            <button id="ai-btn-read">${i18n.read}</button>
            <div class="divider"></div>
            <button id="ai-btn-copy">${i18n.copy}</button>
        </div>
        <div id="sap-ai-result"></div>
    `;

    resultBox = document.getElementById('sap-ai-result');

    document.getElementById('ai-btn-trans').onclick = () => sendAction('translate');
    document.getElementById('ai-btn-ask').onclick = () => sendAction('ask');
    document.getElementById('ai-btn-read').onclick = () => sendAction('read');
    document.getElementById('ai-btn-copy').onclick = () => {
        document.execCommand('copy');
        hideToolbar();
    };
}

function sendAction(action) {
    if (currentSelection) {
        ipcRenderer.sendToHost('ai-toolbar-action', { action, text: currentSelection });
        if (action === 'translate') {
            showLoadingState();
        } else if (action === 'read') {
            // read action
        } else {
            hideToolbar();
        }
    }
}

function showLoadingState() {
    if (!resultBox) return;
    resultBox.classList.add('active');
    resultBox.innerHTML = `<span style="color:#888;">${i18n.loading}...</span>`;
}

function hideToolbar() {
    if (toolbar) {
        toolbar.style.display = 'none';
        if (resultBox) {
            resultBox.classList.remove('active');
            resultBox.innerHTML = '';
        }
    }
}

function bindEvents() {
    document.addEventListener('mouseup', (e) => {
        setTimeout(() => {
            const sel = window.getSelection();
            const text = sel.toString().trim();

            if (toolbar && toolbar.contains(e.target)) return;

            if (text && text.length > 0) {
                currentSelection = text;
                const range = sel.getRangeAt(0);
                const rect = range.getBoundingClientRect();

                if (toolbar) {
                    if (resultBox && resultBox.classList.contains('active')) {
                        resultBox.classList.remove('active');
                    }

                    let top = rect.top - 40;
                    let left = rect.left + (rect.width / 2) - (toolbar.offsetWidth / 2);

                    if (top < 10) top = rect.bottom + 10;
                    if (left < 10) left = 10;
                    if (left + toolbar.offsetWidth > window.innerWidth) left = window.innerWidth - toolbar.offsetWidth - 10;

                    toolbar.style.top = top + 'px';
                    toolbar.style.left = left + 'px';
                    toolbar.style.display = 'flex';
                }
            } else {
                hideToolbar();
            }
        }, 100);
    });

    document.addEventListener('mousedown', (e) => {
        if (toolbar && !toolbar.contains(e.target)) {
            hideToolbar();
        }
    });

    document.addEventListener('scroll', hideToolbar, { passive: true, capture: true });
}

window.addEventListener('DOMContentLoaded', () => {
    initToolbar();
});

ipcRenderer.on('set-i18n', (event, data) => {
    if (data) {
        i18n = { ...i18n, ...data };
        renderToolbarUI();
    }
});

ipcRenderer.on('ai-stream-start', () => {
    if (resultBox) {
        resultBox.innerHTML = '';
        const closeBtn = document.createElement('span');
        closeBtn.className = 'result-close-btn';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = (e) => { e.stopPropagation(); hideToolbar(); };
        resultBox.appendChild(closeBtn);
        
        const contentSpan = document.createElement('span');
        contentSpan.id = 'sap-stream-content';
        resultBox.appendChild(contentSpan);
    }
});

ipcRenderer.on('ai-stream-chunk', (event, text) => {
    const contentSpan = document.getElementById('sap-stream-content');
    if (contentSpan) {
        contentSpan.innerText += text;
        if (resultBox) resultBox.scrollTop = resultBox.scrollHeight;
    }
});

ipcRenderer.on('ai-stream-end', () => {
});