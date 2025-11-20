const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { firefox } = require('playwright');
const os = require('os');

// ===================================================================================
// 认证源管理模块 (保持原版逻辑以支持仪表盘)
// ===================================================================================
class AuthSource {
  constructor(logger) {
    this.logger = logger;
    this.authMode = 'file';
    this.initialIndices = [];
    this.runtimeAuths = new Map();

    if (process.env.AUTH_JSON_1) {
      this.authMode = 'env';
      this.logger.info('[认证] 检测到环境变量认证模式。');
    } else {
      this.logger.info('[认证] 使用文件认证模式。');
    }
    this._discoverAvailableIndices();
  }

  _discoverAvailableIndices() {
    let indices = [];
    if (this.authMode === 'env') {
      for (const key in process.env) {
        const match = key.match(/^AUTH_JSON_(\d+)$/);
        if (match && match[1]) indices.push(parseInt(match[1], 10));
      }
    } else {
      const authDir = path.join(__dirname, 'auth');
      if (fs.existsSync(authDir)) {
        try {
          const files = fs.readdirSync(authDir);
          indices = files.filter(f => /^auth-\d+\.json$/.test(f))
                         .map(f => parseInt(f.match(/^auth-(\d+)\.json$/)[1], 10));
        } catch (e) {}
      }
    }
    this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    this.logger.info(`[认证] 检测到 ${this.initialIndices.length} 个初始认证源。`);
  }

  getAvailableIndices() {
    return [...new Set([...this.initialIndices, ...this.runtimeAuths.keys()])].sort((a, b) => a - b);
  }

  getAccountDetails() {
    return this.getAvailableIndices().map(index => ({
      index,
      source: this.runtimeAuths.has(index) ? 'temporary' : this.authMode
    }));
  }

  getFirstAvailableIndex() {
    const indices = this.getAvailableIndices();
    return indices.length > 0 ? indices[0] : null;
  }

  getAuth(index) {
    if (this.runtimeAuths.has(index)) return this.runtimeAuths.get(index);
    let jsonString;
    if (this.authMode === 'env') {
      jsonString = process.env[`AUTH_JSON_${index}`];
    } else {
      const p = path.join(__dirname, 'auth', `auth-${index}.json`);
      if (fs.existsSync(p)) jsonString = fs.readFileSync(p, 'utf-8');
    }
    try { return jsonString ? JSON.parse(jsonString) : null; } catch (e) { return null; }
  }

  addAccount(index, authData) {
    if (this.initialIndices.includes(index)) return { success: false, message: "索引冲突" };
    this.runtimeAuths.set(index, authData);
    return { success: true, message: "添加成功" };
  }

  removeAccount(index) {
    if (!this.runtimeAuths.has(index)) return { success: false, message: "无法移除非临时账号" };
    this.runtimeAuths.delete(index);
    return { success: true, message: "移除成功" };
  }
}

// ===================================================================================
// 浏览器管理模块 (保留了原版健壮的启动逻辑)
// ===================================================================================
class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = 'dark-browser.js';

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
    } else {
      this.browserExecutablePath = os.platform() === 'win32'
        ? path.join(__dirname, 'camoufox', 'camoufox.exe')
        : path.join(__dirname, 'camoufox-linux', 'camoufox');
    }
  }

  async launchBrowser(authIndex) {
    if (this.browser) return;

    this.logger.info(`🚀 [浏览器] 启动中 (账号 #${authIndex})...`);
    const storageState = this.authSource.getAuth(authIndex);
    if (!storageState) throw new Error(`无法加载账号 ${authIndex}`);

    // 自动修正 Cookie
    if (storageState.cookies) {
      storageState.cookies.forEach(c => { if (!['Lax', 'Strict', 'None'].includes(c.sameSite)) c.sameSite = 'None'; });
    }

    // 读取注入脚本
    let scriptContent = "console.log('Script missing');";
    try {
      const scriptPath = path.join(__dirname, this.scriptFileName);
      if (fs.existsSync(scriptPath)) scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    } catch (e) { this.logger.error("读取脚本失败"); }

    try {
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
        args: ['--disable-blink-features=AutomationControlled']
      });

      this.browser.on('disconnected', () => {
        this.logger.error('❌ [浏览器] 意外断开');
        this.browser = null; this.context = null; this.page = null;
      });

      this.context = await this.browser.newContext({ storageState, viewport: { width: 1280, height: 720 } });
      this.page = await this.context.newPage();

      this.logger.info('[浏览器] 访问 AI Studio...');
      await this.page.goto('https://aistudio.google.com/u/0/apps/bundled/blank?showAssistant=true&showCode=true', { timeout: 60000, waitUntil: 'networkidle' });

      // === 原版健壮的启动逻辑 ===
      this.logger.info('[浏览器] 等待页面稳定...');
      await this.page.waitForTimeout(5000);
      try { await this.page.mouse.click(100, 100); } catch(e){}

      this.logger.info('[浏览器] 寻找 Code 按钮...');
      const codeButton = this.page.getByRole('button', { name: 'Code' });
      await codeButton.waitFor({ state: 'visible', timeout: 30000 });
      
      const editorContainer = this.page.locator('div.monaco-editor').first();
      let editorVisible = false;
      let clicks = 0;
      
      // 死磕 Code 按钮直到编辑器出现
      while (!editorVisible && clicks < 60) {
        try {
           if (await editorContainer.isVisible()) { editorVisible = true; break; }
           await codeButton.click({ force: true });
           clicks++;
           await this.page.waitForTimeout(500);
        } catch (e) {
           await this.page.waitForTimeout(1000);
        }
      }
      
      if (!editorVisible) throw new Error("无法打开代码编辑器");

      this.logger.info('[浏览器] 注入代理脚本...');
      await this.page.waitForTimeout(2000);
      await editorContainer.click({ force: true });
      await this.page.evaluate(text => navigator.clipboard.writeText(text), scriptContent);
      
      const pasteKey = os.platform() === 'darwin' ? 'Meta+V' : 'Control+V';
      await this.page.keyboard.press(pasteKey);
      
      this.logger.info('[浏览器] 切换到预览模式...');
      await this.page.waitForTimeout(1000);
      await this.page.getByRole('button', { name: 'Preview' }).click();

      this.currentAuthIndex = authIndex;
      this.logger.info(`✅ [浏览器] 账号 ${authIndex} 就绪`);

    } catch (error) {
      this.logger.error(`❌ [浏览器] 启动失败: ${error.message}`);
      if (this.browser) await this.browser.close();
      this.browser = null;
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async switchAccount(newIndex) {
    await this.closeBrowser();
    await this.launchBrowser(newIndex);
  }
}

// ===================================================================================
// 日志与队列
// ===================================================================================
class LoggingService {
  constructor(name) { this.name = name; }
  _t() { return new Date().toLocaleTimeString('en-GB'); }
  info(m) { console.log(`${this._t()} [${this.name}] ${m}`); }
  error(m) { console.error(`${this._t()} [${this.name}] ERROR: ${m}`); }
  warn(m) { console.warn(`${this._t()} [${this.name}] WARN: ${m}`); }
  debug(m) { console.debug(`${this._t()} [${this.name}] DEBUG: ${m}`); }
}

class MessageQueue extends EventEmitter {
  constructor() { super(); this.q = []; this.waiters = []; this.closed = false; }
  enqueue(msg) {
    if (this.closed) return;
    if (this.waiters.length) this.waiters.shift().resolve(msg);
    else this.q.push(msg);
  }
  async dequeue(timeout = 1200000) {
    if (this.closed) throw new Error('Queue closed');
    if (this.q.length) return this.q.shift();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== wrapper);
        reject(new Error('Timeout'));
      }, timeout);
      const wrapper = { resolve: (m) => { clearTimeout(t); resolve(m); }, reject };
      this.waiters.push(wrapper);
    });
  }
  close() {
    this.closed = true;
    this.waiters.forEach(w => w.reject(new Error('Queue closed')));
    this.waiters = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.queues = new Map();
  }
  addConnection(ws, info) {
    this.connections.add(ws);
    this.logger.info(`客户端连接: ${info.address}`);
    ws.on('message', d => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.request_id && this.queues.has(msg.request_id)) {
          const q = this.queues.get(msg.request_id);
          if (msg.event_type === 'stream_close') q.enqueue({ type: 'STREAM_END' });
          else q.enqueue(msg);
        }
      } catch (e) {}
    });
    ws.on('close', () => { this.connections.delete(ws); });
  }
  getFirstConnection() { return this.connections.values().next().value; }
  createQueue(id) { const q = new MessageQueue(); this.queues.set(id, q); return q; }
  removeQueue(id) { if (this.queues.has(id)) { this.queues.get(id).close(); this.queues.delete(id); } }
  hasActive() { return this.connections.size > 0; }
}

// ===================================================================================
// 请求处理器 (优化版：兼容 OpenAI 格式心跳)
// ===================================================================================
class RequestHandler {
  constructor(system, registry, logger, browserMgr) {
    this.system = system;
    this.registry = registry;
    this.logger = logger;
    this.browserMgr = browserMgr;
    this.failureCount = 0;
  }

  get config() { return this.system.config; }

  async processRequest(req, res) {
    if (this.config.apiKeys.length > 0 && req.query.key && !this.config.apiKeys.includes(req.query.key)) {
      delete req.query.key;
    }

    this.system.stats.totalCalls++;
    const currentAuth = this.browserMgr.currentAuthIndex;
    if (!this.system.stats.accountCalls[currentAuth]) this.system.stats.accountCalls[currentAuth] = { total: 0, models: {} };
    this.system.stats.accountCalls[currentAuth].total++;

    if (!this.registry.hasActive()) return res.status(503).send('No browser connected');

    const requestId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const queue = this.registry.createQueue(requestId);

    let bodyStr = '';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const proxyReq = {
      path: req.path, method: req.method, headers: req.headers, query_params: req.query,
      request_id: requestId, streaming_mode: this.system.streamingMode, body: bodyStr
    };

    try {
      if (this.system.streamingMode === 'fake') {
        await this._handlePseudoStream(proxyReq, queue, req, res);
      } else {
        await this._handleRealStream(proxyReq, queue, res);
      }
    } catch (e) {
      this.logger.error(`Request failed: ${e.message}`);
      if (!res.headersSent) res.status(500).send(e.message);
    } finally {
      this.registry.removeQueue(requestId);
    }
  }

  _forward(req) {
    const ws = this.registry.getFirstConnection();
    if (ws) ws.send(JSON.stringify(req));
    else throw new Error('WS Disconnected');
  }

  // ✅ 核心优化：OpenAI 兼容格式心跳，防止 NextChat 等客户端报错
  _getKeepAliveChunk(req) {
    const common = { created: Math.floor(Date.now() / 1000) };
    if (req.path.includes('chat/completions')) {
      return `data: ${JSON.stringify({ ...common, id: "chatcmpl-keepalive", object: "chat.completion.chunk", model: "gpt-4", choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`;
    }
    if (req.path.includes('generateContent')) {
      return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: null, index: 0 }] })}\n\n`;
    }
    return 'data: {}\n\n';
  }

  async _handlePseudoStream(proxyReq, queue, req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    // 发送心跳防止超时
    const keepAlive = setInterval(() => res.write(this._getKeepAliveChunk(req)), 2000);

    try {
      let lastErr;
      for (let i = 0; i < this.config.maxRetries; i++) {
        this._forward(proxyReq);
        const msg = await queue.dequeue(); 
        if (msg.event_type === 'error') {
          lastErr = msg;
          await new Promise(r => setTimeout(r, this.config.retryDelay));
          continue;
        }
        
        clearInterval(keepAlive);
        this.failureCount = 0;
        
        // Fake 模式下，浏览器发回一个完整的大包
        const dataMsg = await queue.dequeue(); 
        if (msg.data) res.write(`data: ${msg.data}\n\n`);
        if (dataMsg && dataMsg.data) res.write(`data: ${dataMsg.data}\n\n`);
        
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      throw new Error(lastErr?.message || "Max retries reached");
    } catch (e) {
      clearInterval(keepAlive);
      this._handleFailure(e, res, true);
    }
  }

  async _handleRealStream(proxyReq, queue, res) {
    try {
      this._forward(proxyReq);
      const head = await queue.dequeue();
      if (head.event_type === 'error') throw new Error(head.message);

      res.status(head.status || 200);
      if (head.headers) Object.entries(head.headers).forEach(([k, v]) => { if (k !== 'content-length') res.set(k, v); });

      this.failureCount = 0;
      while (true) {
        const msg = await queue.dequeue(30000);
        if (msg.type === 'STREAM_END') break;
        if (msg.data) res.write(msg.data);
      }
      res.end();
    } catch (e) {
      this._handleFailure(e, res, false);
    }
  }

  async _handleFailure(e, res, isStream) {
    this.logger.error(e.message);
    this.failureCount++;
    if (this.config.failureThreshold > 0 && this.failureCount >= this.config.failureThreshold) {
      this.logger.warn('达到失败阈值，切换账号...');
      try {
        await this.browserMgr.switchAccount(this._getNextAuthIndex());
        this.failureCount = 0;
      } catch (err) { this.logger.error('切换失败'); }
    }
    if (isStream) {
      res.write(`data: {"error": {"message": "Proxy Error: ${e.message}"}}\n\n`);
      res.end();
    } else if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }

  _getNextAuthIndex() {
    const indices = this.system.authSource.getAvailableIndices();
    const curr = indices.indexOf(this.browserMgr.currentAuthIndex);
    return indices[(curr + 1) % indices.length];
  }
}

// ===================================================================================
// 系统主类 (保留仪表盘API支持)
// ===================================================================================
class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService('System');
    this.config = this._loadConfig();
    this.streamingMode = this.config.streamingMode;
    this.stats = { totalCalls: 0, accountCalls: {} };

    this.authSource = new AuthSource(this.logger);
    this.browserMgr = new BrowserManager(this.logger, this.config, this.authSource);
    this.registry = new ConnectionRegistry(this.logger);
    this.handler = new RequestHandler(this, this.registry, this.logger, this.browserMgr);
  }

  _loadConfig() {
    let conf = {
      httpPort: 8889, host: '0.0.0.0', wsPort: 9998, streamingMode: 'real',
      failureThreshold: 0, maxRetries: 3, retryDelay: 2000, apiKeys: [], debugMode: false
    };
    try {
      if (fs.existsSync('config.json')) Object.assign(conf, JSON.parse(fs.readFileSync('config.json')));
    } catch (e) {}
    if (process.env.PORT) conf.httpPort = parseInt(process.env.PORT);
    if (process.env.STREAMING_MODE) conf.streamingMode = process.env.STREAMING_MODE;
    if (process.env.API_KEYS) conf.apiKeys = process.env.API_KEYS.split(',');
    return conf;
  }

  async start() {
    const index = this.config.initialAuthIndex || this.authSource.getFirstAvailableIndex();
    await this.browserMgr.launchBrowser(index);

    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(express.raw({ type: '*/*', limit: '50mb' }));

    // === 仪表盘 API 支持 ===
    app.get('/', (req, res) => res.redirect('/dashboard'));
    app.get('/dashboard', (req, res) => res.send(this._getDashboardHtml()));
    
    // 仪表盘数据接口
    app.get('/dashboard/data', (req, res) => {
      res.json({
        status: { uptime: process.uptime(), connected: !!this.browserMgr.browser, streamingMode: this.streamingMode },
        auth: { currentAuthIndex: this.browserMgr.currentAuthIndex, accounts: this.authSource.getAccountDetails() },
        stats: this.stats,
        config: this.config
      });
    });

    // 动态切换接口
    app.post('/switch', async (req, res) => {
      try {
         await this.browserMgr.switchAccount(this.handler._getNextAuthIndex());
         res.send("Switched");
      } catch(e) { res.status(500).send(e.message); }
    });

    // 动态配置接口
    app.post('/dashboard/config', (req, res) => {
        if(req.body.streamingMode) {
            this.config.streamingMode = req.body.streamingMode;
            this.streamingMode = req.body.streamingMode;
        }
        res.json({success: true});
    });

    // 代理所有流量
    app.all('*', (req, res, next) => {
      if (req.path.startsWith('/dashboard') || req.path.startsWith('/switch')) return next();
      this.handler.processRequest(req, res);
    });

    this.httpServer = http.createServer(app).listen(this.config.httpPort, this.config.host);
    this.wsServer = new WebSocket.Server({ port: this.config.wsPort, host: this.config.host });
    this.wsServer.on('connection', (ws, req) => this.registry.addConnection(ws, { address: req.socket.remoteAddress }));

    this.logger.info(`系统启动完成: http://${this.config.host}:${this.config.httpPort}`);
  }

  _getDashboardHtml() {
    // 返回简化但功能完整的仪表盘 HTML
    return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>Proxy Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@1/css/pico.min.css">
    <style>body{padding:20px;max-width:800px;margin:0 auto} .card{padding:20px;margin-bottom:20px;border:1px solid #333;border-radius:8px}</style>
    </head><body>
    <nav><ul><li><strong>🐢 Proxy Dashboard</strong></li></ul></nav>
    <div class="grid">
      <article>
        <header>状态</header>
        <div id="status">加载中...</div>
      </article>
      <article>
        <header>控制</header>
        <button onclick="switchAccount()">🔄 切换账号</button>
        <label>
          流式模式
          <select id="modeSelect" onchange="changeMode(this.value)">
            <option value="real">Real (真流式)</option>
            <option value="fake">Fake (假流式/防超时)</option>
          </select>
        </label>
      </article>
    </div>
    <article>
      <header>账号池</header>
      <div id="accounts"></div>
    </article>
    <script>
      async function refresh() {
        const res = await fetch('/dashboard/data');
        const data = await res.json();
        document.getElementById('status').innerHTML = 
          '运行时间: ' + Math.floor(data.status.uptime) + 's<br>' +
          '浏览器: ' + (data.status.connected ? '✅ 已连接' : '❌ 断开') + '<br>' +
          '当前账号: ' + data.auth.currentAuthIndex + '<br>' + 
          '总调用: ' + data.stats.totalCalls;
        
        document.getElementById('modeSelect').value = data.config.streamingMode;
        
        const accHtml = data.auth.accounts.map(a => 
            '<mark>' + a.index + ' (' + a.source + ')</mark>'
        ).join(' ');
        document.getElementById('accounts').innerHTML = accHtml;
      }
      async function switchAccount() {
        await fetch('/switch', {method:'POST'});
        setTimeout(refresh, 1000);
      }
      async function changeMode(mode) {
        await fetch('/dashboard/config', {
            method:'POST', 
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({streamingMode: mode})
        });
        refresh();
      }
      setInterval(refresh, 2000);
      refresh();
    </script>
    </body></html>`;
  }
}

if (require.main === module) new ProxyServerSystem().start();
module.exports = { ProxyServerSystem };
