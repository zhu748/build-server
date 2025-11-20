const Logger = {
  enabled: true,
  output(...messages) {
    if (!this.enabled) return;
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[ProxyClient] ${timestamp}`, ...messages);
  }
};

class ConnectionManager extends EventTarget {
  constructor(endpoint = 'ws://127.0.0.1:9998') {
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
  }
  
  async establish() {
    if (this.isConnected) return;
    Logger.output('连接服务器:', this.endpoint);
    
    return new Promise((resolve) => {
      this.socket = new WebSocket(this.endpoint);
      
      this.socket.addEventListener('open', () => {
        this.isConnected = true;
        Logger.output('✅ 连接成功');
        this.dispatchEvent(new CustomEvent('connected'));
        resolve();
      });
      
      this.socket.addEventListener('close', () => {
        this.isConnected = false;
        Logger.output('❌ 连接断开，5秒后重连...');
        this.dispatchEvent(new CustomEvent('disconnected'));
        setTimeout(() => this.establish(), this.reconnectDelay);
      });
      
      this.socket.addEventListener('message', (event) => {
        this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
      });
    });
  }
  
  transmit(data) {
    if (this.isConnected && this.socket) {
      this.socket.send(JSON.stringify(data));
    }
  }
}

class RequestProcessor {
  constructor() {
    this.targetDomain = 'generativelanguage.googleapis.com';
  }
  
  async execute(requestSpec) {
    Logger.output(`执行请求: ${requestSpec.method} ${requestSpec.path}`);
    
    const requestUrl = this._constructUrl(requestSpec);
    const config = this._buildRequestConfig(requestSpec);
    
    try {
      const response = await fetch(requestUrl, config);
      if (!response.ok) {
        const txt = await response.text();
        throw new Error(`HTTP ${response.status}: ${txt}`);
      }
      return response;
    } catch (error) {
      Logger.output('❌ 请求失败:', error.message);
      throw error;
    }
  }
  
  _constructUrl(requestSpec) {
    // 核心优化：处理 Fake 模式下的 URL 降级，这是防超时的关键
    let pathSegment = requestSpec.path.startsWith('/') ? requestSpec.path.substring(1) : requestSpec.path;
    const queryParams = new URLSearchParams(requestSpec.query_params);

    if (requestSpec.streaming_mode === 'fake') {
      Logger.output('🔧 [Fake模式] 正在修改 URL 参数以禁用原生流式...');
      
      // 1. 降级 API 路径：从流式接口改为普通接口
      if (pathSegment.includes(':streamGenerateContent')) {
        pathSegment = pathSegment.replace(':streamGenerateContent', ':generateContent');
      }
      
      // 2. 移除 SSE 标记
      if (queryParams.get('alt') === 'sse') {
        queryParams.delete('alt');
      }
    }
    
    const queryString = queryParams.toString();
    return `https://${this.targetDomain}/${pathSegment}${queryString ? '?' + queryString : ''}`;
  }

  _buildRequestConfig(requestSpec) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers)
    };
    
    if (['POST', 'PUT', 'PATCH'].includes(requestSpec.method) && requestSpec.body) {
      // 尝试解析并重新序列化 JSON，确保格式正确
      try {
        config.body = JSON.stringify(JSON.parse(requestSpec.body));
      } catch (e) {
        config.body = requestSpec.body;
      }
    }
    return config;
  }
  
  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    // 移除浏览器禁止手动设置的头，防止报错
    ['host', 'connection', 'content-length', 'origin', 'referer', 'user-agent', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest']
      .forEach(k => delete sanitized[k]);
    return sanitized;
  }
}

class ProxySystem {
  constructor() {
    this.connectionManager = new ConnectionManager();
    this.processor = new RequestProcessor();
    
    this.connectionManager.addEventListener('message', (e) => this.handleMessage(e.detail));
    this.connectionManager.addEventListener('disconnected', () => {}); // 可以添加额外的清理逻辑
    this.connectionManager.establish();
  }
  
  async handleMessage(jsonStr) {
    let req = {};
    try {
      req = JSON.parse(jsonStr);
      const opId = req.request_id;
      const mode = req.streaming_mode || 'fake';

      const response = await this.processor.execute(req);
      
      // 1. 发送响应头
      const headers = {};
      response.headers.forEach((v, k) => headers[k] = v);
      this.connectionManager.transmit({
        request_id: opId,
        event_type: 'response_headers',
        status: response.status,
        headers: headers
      });

      // 2. 处理响应体
      if (mode === 'real') {
        // 真流式：逐块读取并发送
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while(true) {
          const {done, value} = await reader.read();
          if(done) break;
          this.connectionManager.transmit({
            request_id: opId,
            event_type: 'chunk',
            data: decoder.decode(value, {stream: true})
          });
        }
      } else {
        // 假流式：一次性读取完整内容 (await text())，确保拿到完整数据后再发送
        // 这样浏览器端虽然等待时间略长，但不会因为网络波动导致流中断
        const text = await response.text();
        this.connectionManager.transmit({
          request_id: opId,
          event_type: 'chunk',
          data: text
        });
      }

      // 3. 发送结束信号
      this.connectionManager.transmit({ request_id: opId, event_type: 'stream_close' });
      Logger.output('✅ 任务完成');

    } catch (error) {
      if(req.request_id) {
        this.connectionManager.transmit({
            request_id: req.request_id,
            event_type: 'error',
            status: 500,
            message: error.message
        });
      }
    }
  }
}

// 启动系统
new ProxySystem();
