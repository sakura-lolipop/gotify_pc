const EventEmitter = require("node:events");
const { WebSocket } = require("ws");

class GotifyClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.reconnectTimer = null;
    this.connected = false;
    this.hasConnectedOnce = false;
    this.config = null;
    this.reconnectDelay = 5000;
    this.intentionalDisconnect = false;
    this.lastErrorMessage = "";
    this.seenMessageIds = new Set();
    this.seenMessageKeys = new Map();
    this.duplicateWindowMs = 1500;
    this.debugEnabled = false;
    this.socketSerial = 0;
    this.localIdSeq = 0;
    this.heartbeatTimer = null;
    this.pongTimeout = null;
  }

  start(config) {
    this.clearReconnect();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.config = {
      ...config,
      serverUrl: String(config?.serverUrl || "").trim(),
      clientToken: String(config?.clientToken || "").trim()
    };
    this.debugEnabled = Boolean(config?.debugLogs) || String(process.env.GOTIFY_DEBUG_WS || "").trim() === "1";
    this.intentionalDisconnect = false;
    this.lastErrorMessage = "";
    this.hasConnectedOnce = false;
    this.debug("info", "start", { server: this.maskServer(this.config.serverUrl) });
    this.connect();
  }

  stop() {
    this.intentionalDisconnect = true;
    this.clearReconnect();
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
    }
    this.ws = null;
    this.debug("info", "stop");
    this.setConnected(false, "已断开连接");
  }

  connect() {
    if (!this.config?.serverUrl || !this.config?.clientToken) {
      this.setConnected(false, "未配置服务器地址或客户端令牌");
      return;
    }
    const wsUrl = this.buildWsUrl(this.config.serverUrl, this.config.clientToken);
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    this.setConnected(false, "正在连接...");
    try {
      const socketId = ++this.socketSerial;
      this.debug("info", "connect", { socketId, wsUrl: this.maskWsUrl(wsUrl) });
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      socket.on("open", () => {
        if (this.ws !== socket) {
          return;
        }
        this.debug("info", "open", { socketId });
        const isReconnect = this.hasConnectedOnce;
        this.hasConnectedOnce = true;
        this.setConnected(true, "已连接");
        if (isReconnect) {
          this.emit("reconnected");
        }
        this.reconnectDelay = 5000;
        this.lastErrorMessage = "";
        this.startHeartbeat();
      });
      socket.on("pong", () => {
        this.onPong();
      });
      socket.on("message", (payload) => {
        try {
          const data = JSON.parse(String(payload));
          if (typeof data === "object" && data) {
            const normalized = this.normalizeMessage(data);
            if (this.isDuplicate(normalized)) {
              this.debug("warn", "duplicate_drop", { socketId, id: normalized.id, appid: normalized.appid });
              return;
            }
            this.debug("info", "message", { socketId, id: normalized.id, appid: normalized.appid, title: normalized.title });
            this.emit("message", normalized);
          }
        } catch {}
      });
      socket.on("error", (error) => {
        if (this.ws !== socket) {
          return;
        }
        this.lastErrorMessage = error?.message ? String(error.message) : "未知错误";
        this.debug("error", "error", { socketId, message: this.lastErrorMessage });
        this.setConnected(false, `连接异常: ${this.lastErrorMessage}`);
      });
      socket.on("close", (code, reasonBuffer) => {
        this.stopHeartbeat();
        if (this.ws === socket) {
          this.ws = null;
        }
        const reason = String(reasonBuffer || "");
        this.debug("warn", "close", { socketId, code, reason, intentional: this.intentionalDisconnect });
        const closeText = reason ? `连接已断开: ${code} ${reason}` : `连接已断开: ${code}`;
        const statusText = this.lastErrorMessage ? `${closeText} (${this.lastErrorMessage})` : closeText;
        this.setConnected(false, statusText);
        if (!this.intentionalDisconnect && this.config?.enableReconnect) {
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      const message = error?.message ? String(error.message) : "未知错误";
      this.debug("error", "connect_fail", { message });
      this.setConnected(false, `连接失败: ${message}`);
      if (!this.intentionalDisconnect && this.config?.enableReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  buildWsUrl(serverUrl, token) {
    const normalized = serverUrl.trim().replace(/\/+$/, "");
    if (normalized.startsWith("https://")) {
      return `${normalized.replace("https://", "wss://")}/stream?token=${encodeURIComponent(token)}`;
    }
    if (normalized.startsWith("http://")) {
      return `${normalized.replace("http://", "ws://")}/stream?token=${encodeURIComponent(token)}`;
    }
    return `ws://${normalized}/stream?token=${encodeURIComponent(token)}`;
  }

  // REST catch-up source (design borrowed from gotify-tray). GET /message
  // with X-Gotify-Key auth returns {"paging": ..., "messages": [...]} in
  // newest-first order; callers filter/replay what they missed.
  async fetchRecentMessages(limit = 50) {
    const normalized = this.config.serverUrl.trim().replace(/\/+$/, "");
    const url = `${normalized}/message?limit=${limit}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Gotify-Key": this.config.clientToken
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  // Re-entry point for catch-up messages: runs the same normalize → dedup →
  // emit pipeline as WS pushes, so a message delivered over WS while the
  // catch-up fetch was in flight is dropped here instead of duplicating the
  // notification card.
  processRestMessage(message) {
    const normalized = this.normalizeMessage(message);
    if (this.isDuplicate(normalized)) {
      this.debug("warn", "duplicate_drop", { source: "rest", id: normalized.id });
      return false;
    }
    this.debug("info", "message", { source: "rest", id: normalized.id, title: normalized.title });
    this.emit("message", normalized);
    return true;
  }

  setConnected(next, status) {
    this.connected = next;
    this.emit("status", { connected: next, status });
  }

  scheduleReconnect() {
    this.clearReconnect();
    this.debug("warn", "schedule_reconnect", { delayMs: this.reconnectDelay });
    this.emit("status", { connected: false, status: `重连中，${Math.floor(this.reconnectDelay / 1000)} 秒后重试` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay + 1000, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Client-initiated ping/pong heartbeat. A half-open socket (sleep / network
  // change / NAT drop, no close frame delivered) never emits 'close', so the
  // reconnect logic above would never fire and the client would stay "已连接"
  // while receiving nothing. Pinging every 30s and terminating when no pong
  // returns forces a 'close' → the existing scheduleReconnect() resumes.
  // Standard ws-library heartbeat pattern; server (gorilla) auto-replies pong.
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {}
        this.pongTimeout = setTimeout(() => {
          // No pong within 15s → treat as half-open and force-close so the
          // existing close→reconnect path runs.
          try {
            this.ws.terminate();
          } catch {}
        }, 15000);
      }
    }, 30000);
  }

  onPong() {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  normalizeMessage(message) {
    const now = new Date().toISOString();
    // Server ids are positive integers. Deliveries without one used to fall
    // back to Date.now() — an astronomical number that polluted history and
    // inflated the getMaxId() watermark, permanently blinding REST catch-up
    // (its "id > lastId" filter would exclude everything after it). Malformed
    // deliveries now get a local string id from a monotonic counter: it can
    // never enter the watermark or the numeric dedup set (L3).
    const rawId = Number(message?.id);
    const id = Number.isInteger(rawId) && rawId > 0 ? rawId : `local-${++this.localIdSeq}`;
    return {
      id,
      appid: Number(message.appid || 0),
      title: String(message.title || "新通知"),
      message: String(message.message || ""),
      priority: Number(message.priority || 0),
      date: message.date || now,
      // extras 透传：Hotify 媒体消息的下载/图片 URL 在 client::notification
      // （click.url / bigImageUrl），与 gotify 官方安卓客户端同一数据源；
      // 之前整包丢弃导致媒体消息"URL 不识别"
      extras: message?.extras && typeof message.extras === "object" ? message.extras : undefined
    };
  }

  isDuplicate(message) {
    const now = Date.now();
    if (Number.isFinite(message.id) && message.id > 0) {
      if (this.seenMessageIds.has(message.id)) {
        return true;
      }
      this.seenMessageIds.add(message.id);
      if (this.seenMessageIds.size > 5000) {
        this.seenMessageIds.clear();
        this.seenMessageIds.add(message.id);
      }
    }
    const key = `${message.appid}|${message.title}|${message.message}`;
    const previousTime = this.seenMessageKeys.get(key);
    this.seenMessageKeys.set(key, now);
    if (this.seenMessageKeys.size > 500) {
      for (const [k, time] of this.seenMessageKeys) {
        if (now - time > this.duplicateWindowMs) {
          this.seenMessageKeys.delete(k);
        }
      }
    }
    return Boolean(previousTime && now - previousTime < this.duplicateWindowMs);
  }

  debug(level, event, meta = {}) {
    if (!this.debugEnabled) {
      return;
    }
    const ts = new Date().toISOString();
    const data = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    const line = `[GotifyWS][${level.toUpperCase()}][${ts}] ${event}${data}`;
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  maskServer(serverUrl) {
    const url = String(serverUrl || "");
    return url.replace(/(https?:\/\/)([^/]+)/, "$1***");
  }

  maskWsUrl(wsUrl) {
    return String(wsUrl || "").replace(/token=[^&]+/i, "token=***");
  }
}

async function testConnection(serverUrl, clientToken) {
  const normalized = serverUrl.trim().replace(/\/+$/, "");
  const token = String(clientToken || "").trim();
  const url = `${normalized}/application?token=${encodeURIComponent(token)}`;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return true;
}

module.exports = {
  GotifyClient,
  testConnection
};
