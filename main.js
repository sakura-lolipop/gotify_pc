const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, nativeImage, screen, dialog } = require("electron");
const { ConfigStore } = require("./src/services/config-store");
const { HistoryStore } = require("./src/services/history-store");
const { GotifyClient, testConnection } = require("./src/services/gotify-client");

let mainWindow = null;
let tray = null;
let configStore = null;
let historyStore = null;
let gotifyClient = null;
let appIcon = null;
let currentConnectionStatus = { connected: false, status: "未连接" };
let customNotificationWindow = null;
let customNotificationTimer = null;
let storageDirPath = "";
let applicationMap = new Map();
let applicationList = [];
let lastApplicationsFetchedAt = 0;
// 是否以"隐藏到托盘"方式启动（开机自启或带 --hidden 参数时为 true）
let startHiddenAtLaunch = false;
const APP_NAME = "Gotify 客户端";
const APP_USER_MODEL_ID = "com.gotify.client.desktop";

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
Menu.setApplicationMenu(null);

function resolveStorageDir() {
  const ensureWritable = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  };
  const getPreferencePath = () => path.join(app.getPath("userData"), "storage-preferences.json");
  const readPreferredDir = () => {
    try {
      const prefPath = getPreferencePath();
      if (!fs.existsSync(prefPath)) {
        return "";
      }
      const raw = fs.readFileSync(prefPath, "utf8");
      const parsed = JSON.parse(raw);
      return String(parsed?.storageDir || "").trim();
    } catch {
      return "";
    }
  };
  const candidates = [];
  const envPath = String(process.env.GOTIFY_DATA_DIR || "").trim();
  if (envPath) {
    candidates.push(envPath);
  }
  if (app.isPackaged) {
    // Check if we have a preferred path stored in userData
    const preferredPath = readPreferredDir();
    if (preferredPath) {
      candidates.push(preferredPath);
    }
    // Portable mode check: if config.json exists in exe dir, prioritize it
    const exeDir = path.dirname(process.execPath);
    if (fs.existsSync(path.join(exeDir, "config.json"))) {
      candidates.push(exeDir);
    }

    // Default to userData for persistence across updates
    candidates.push(app.getPath("userData"));
  } else {
    candidates.push(__dirname);
  }
  candidates.push(app.getPath("userData"));
  for (const dir of candidates) {
    try {
      return ensureWritable(dir);
    } catch {}
  }
  return app.getPath("userData");
}

function getStoragePreferencePath() {
  return path.join(app.getPath("userData"), "storage-preferences.json");
}

function savePreferredStorageDir(nextPath) {
  const prefPath = getStoragePreferencePath();
  fs.mkdirSync(path.dirname(prefPath), { recursive: true });
  fs.writeFileSync(prefPath, JSON.stringify({ storageDir: nextPath }, null, 2), "utf8");
}

function ensureWritableDir(nextPath) {
  fs.mkdirSync(nextPath, { recursive: true });
  fs.accessSync(nextPath, fs.constants.W_OK);
}

function copyDataFiles(sourceDir, targetDir) {
  const fileNames = ["config.json", "message_history.json"];
  for (const fileName of fileNames) {
    const source = path.join(sourceDir, fileName);
    const target = path.join(targetDir, fileName);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
}

function createGotifyIcon() {
  const runtimeIconPath = path.resolve(__dirname, "defaultapp.png");
  if (fs.existsSync(runtimeIconPath)) {
    const runtimeIcon = nativeImage.createFromPath(runtimeIconPath);
    if (!runtimeIcon.isEmpty()) {
      return runtimeIcon;
    }
  }
  const officialIconPath = path.resolve(__dirname, "..", "GotifyClient", "gotify.ico");
  if (fs.existsSync(officialIconPath)) {
    const officialIcon = nativeImage.createFromPath(officialIconPath);
    if (!officialIcon.isEmpty()) {
      return officialIcon;
    }
  }
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = 0xd2;
      data[i + 1] = 0x76;
      data[i + 2] = 0x19;
      data[i + 3] = 0xff;
      const dx = x - 32;
      const dy = y - 26;
      const body = dx * dx + dy * dy <= 15 * 15 && dy >= -7;
      const top = dx * dx + (y - 14) * (y - 14) <= 5 * 5;
      const bellGap = dx * dx + (y - 26) * (y - 26) <= 7 * 7;
      if (body || top) {
        data[i] = 0xff;
        data[i + 1] = 0xff;
        data[i + 2] = 0xff;
        data[i + 3] = 0xff;
      }
      if (bellGap) {
        data[i] = 0xd2;
        data[i + 1] = 0x76;
        data[i + 2] = 0x19;
        data[i + 3] = 0xff;
      }
      const dot = dx * dx + (y - 44) * (y - 44) <= 5 * 5;
      if (dot) {
        data[i] = 0xff;
        data[i + 1] = 0xff;
        data[i + 2] = 0xff;
        data[i + 3] = 0xff;
      }
    }
  }
  const icon = nativeImage.createFromBitmap(data, { width: size, height: size, scaleFactor: 1 });
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

async function refreshApplications(config, force = false) {
  const serverUrl = String(config?.serverUrl || "").trim();
  const clientToken = String(config?.clientToken || "").trim();
  if (!serverUrl || !clientToken) {
    applicationMap = new Map();
    applicationList = [];
    lastApplicationsFetchedAt = 0;
    return applicationList;
  }
  if (!force && lastApplicationsFetchedAt && Date.now() - lastApplicationsFetchedAt < 15000) {
    return applicationList;
  }
  const normalized = serverUrl.replace(/\/+$/, "");
  const url = `${normalized}/application?token=${encodeURIComponent(clientToken)}`;
  try {
    const response = await fetch(url, { 
      method: "GET",
      headers: {
        "X-Gotify-Key": clientToken
      }
    });
    if (!response.ok) {
      return applicationList;
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      return applicationList;
    }
    applicationList = data
      .map((item) => ({ id: Number(item.id || 0), name: String(item.name || "").trim() }))
      .filter((item) => item.id > 0 && item.name);
    applicationMap = new Map(applicationList.map((item) => [item.id, item.name]));
    lastApplicationsFetchedAt = Date.now();
    return applicationList;
  } catch {
    return applicationList;
  }
}

function getAppNameById(appid) {
  const id = Number(appid || 0);
  return applicationMap.get(id) || "";
}

function createWindow() {
  const config = configStore.get();
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    icon: appIcon,
    backgroundColor: "#f7fafc",
    // 开机自启（或带 --hidden）时不显示主窗口，仅驻留托盘；手动双击正常显示
    show: Boolean(config.showMainWindowOnStartup) && !startHiddenAtLaunch,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.on("before-input-event", (_, input) => {
    if (input.key === "F12" || (input.control && input.shift && input.key.toUpperCase() === "I")) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: "detach" });
      }
    }
  });
  mainWindow.on("close", (event) => {
    if (!app.isQuiting && configStore.get().minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const trayIcon = appIcon.resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    { label: "显示主界面", click: () => mainWindow?.show() },
    { label: "设置", click: () => mainWindow?.webContents.send("open-settings") },
    { type: "separator" },
    { label: "退出", click: () => quitApp() }
  ]);
  tray.setToolTip("Gotify 客户端");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => mainWindow?.show());
}

const NOTIFICATION_WIDTH = 360;
const NOTIFICATION_HEIGHT = 96;
const NOTIFICATION_GAP = 10;
const MAX_NOTIFICATIONS = 5;

let activeNotifications = [];

function closeCustomNotificationWindow(windowId) {
  if (!windowId) {
    // Close all
    activeNotifications.forEach((n) => {
      if (n.timer) clearTimeout(n.timer);
      if (n.window && !n.window.isDestroyed()) n.window.close();
    });
    activeNotifications = [];
    return;
  }

  const index = activeNotifications.findIndex((n) => n.id === windowId);
  if (index !== -1) {
    const notification = activeNotifications[index];
    if (notification.timer) clearTimeout(notification.timer);
    if (notification.window && !notification.window.isDestroyed()) {
      notification.window.close();
    }
    activeNotifications.splice(index, 1);
    repositionNotifications();
  }
}

function repositionNotifications() {
  const workArea = screen.getPrimaryDisplay().workArea;
  activeNotifications.forEach((n, i) => {
    if (n.window && !n.window.isDestroyed()) {
      const newY = workArea.y + workArea.height - (NOTIFICATION_HEIGHT + NOTIFICATION_GAP) * (i + 1) - 6;
      n.window.setPosition(workArea.x + workArea.width - NOTIFICATION_WIDTH - 16, newY, true);
    }
  });
}

function buildCustomNotificationHtml({ iconDataUrl, title, subtitle, body, id, verificationCode }) {
  const escapeHtml = (text) =>
    String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const code = verificationCode || "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; overflow: hidden; background: transparent; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    .card { width: ${NOTIFICATION_WIDTH}px; min-height: ${NOTIFICATION_HEIGHT}px; border-radius: 14px; background: linear-gradient(180deg, #1c2737 0%, #131c29 100%); color: #f1f5f9; padding: 12px; display: flex; gap: 10px; box-shadow: 0 14px 30px rgba(0,0,0,0.35); border: 1px solid rgba(148,163,184,0.22); animation: popup .18s ease-out; cursor: pointer; transition: background 0.2s; }
    .card:hover { background: linear-gradient(180deg, #253347 0%, #1a2535 100%); }
    @keyframes popup { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .avatar { width: 36px; height: 36px; border-radius: 8px; background: transparent; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
    .avatar img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .main { min-width: 0; flex: 1; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .title { font-size: 15px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
    .app-name { font-size: 13px; color: #93c5fd; font-weight: 400; margin-left: 4px; }
    .close { border: none; background: transparent; color: #94a3b8; font-size: 14px; width: 22px; height: 22px; cursor: pointer; border-radius: 6px; line-height: 22px; flex-shrink: 0; }
    .close:hover { background: rgba(148,163,184,0.18); color: #e2e8f0; }
    .body { margin-top: 6px; font-size: 13px; line-height: 1.35; color: #e2e8f0; white-space: pre-line; max-height: 54px; overflow: hidden; }
    .code-hint { display: ${code ? "inline-block" : "none"}; font-size: 11px; color: #4ade80; background: rgba(74, 222, 128, 0.15); padding: 1px 6px; border-radius: 4px; margin-left: 8px; vertical-align: middle; flex-shrink: 0; }
  </style>
</head>
<body>
  <div id="card" class="card">
    <div class="avatar"><img src="${iconDataUrl}" alt="icon" /></div>
    <div class="main">
      <div class="top">
        <div class="title-container" style="display:flex;align-items:center;min-width:0;flex:1;margin-right:4px">
          <div class="title">${escapeHtml(title)}<span class="app-name">(${escapeHtml(subtitle)})</span></div>
          <div class="code-hint">点击复制验证码</div>
        </div>
        <button id="close" class="close">✕</button>
      </div>
      <div class="body">${escapeHtml(body)}</div>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require("electron");
    const closeButton = document.getElementById("close");
    const card = document.getElementById("card");
    const verificationCode = "${code}";
    
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      ipcRenderer.send("custom-notification-close", "${id}");
    });
    
    card.addEventListener("click", () => {
      if (verificationCode) {
        ipcRenderer.send("custom-notification-copy-code", { id: "${id}", code: verificationCode });
        const hint = document.querySelector(".code-hint");
        if (hint) {
          hint.innerText = "复制成功";
          hint.style.color = "#ffffff";
          hint.style.background = "#22c55e";
        }
        setTimeout(() => {
          ipcRenderer.send("custom-notification-close", "${id}");
        }, 1500);
      } else {
        ipcRenderer.send("custom-notification-open-main", "${id}");
      }
    });
    
    card.addEventListener("mouseenter", () => {
      ipcRenderer.send("custom-notification-pause-timer", "${id}");
    });
    
    card.addEventListener("mouseleave", () => {
      ipcRenderer.send("custom-notification-resume-timer", "${id}");
    });
  </script>
</body>
</html>`;
}

function showCustomNotification(message, config) {
  if (activeNotifications.length >= MAX_NOTIFICATIONS) {
    const oldest = activeNotifications.shift();
    if (oldest) {
      if (oldest.timer) clearTimeout(oldest.timer);
      if (oldest.window && !oldest.window.isDestroyed()) oldest.window.close();
    }
  }

  const workArea = screen.getPrimaryDisplay().workArea;
  const id = Math.random().toString(36).substring(7);
  
  const title = message.title || "Gotify 消息";
  const subtitle = message.appname || `应用 #${message.appid || 0}`;
  const body = formatNotificationBody(message.message);
  
  let verificationCode = extractVerificationCode(title, message.message);

  const iconDataUrl = appIcon.resize({ width: 64, height: 64 }).toDataURL();
  const html = buildCustomNotificationHtml({ iconDataUrl, title, subtitle, body, id, verificationCode });
  
  const notificationWindow = new BrowserWindow({
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
    x: workArea.x + workArea.width - NOTIFICATION_WIDTH - 16,
    y: workArea.y + workArea.height - (NOTIFICATION_HEIGHT + NOTIFICATION_GAP) * (activeNotifications.length + 1) - 6,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    transparent: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const notificationData = {
    id,
    window: notificationWindow,
    timer: null
  };

  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notificationWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  notificationWindow.once("ready-to-show", () => notificationWindow?.showInactive());
  
  if (!config.notificationNeverClose && config.notificationAutoHide) {
    const duration = Math.max(1000, Number(config.notificationDuration) || 5000);
    notificationData.timer = setTimeout(() => closeCustomNotificationWindow(id), duration);
  }

  activeNotifications.push(notificationData);
}

function extractVerificationCode(title, message) {
  const titleText = String(title || "");
  const msgContent = String(message || "");
  if ((titleText.includes("验证码") || msgContent.includes("验证码")) && /\d{4,8}/.test(msgContent)) {
    const match = msgContent.match(/\d{4,8}/);
    if (match) {
      return match[0];
    }
  }
  return "";
}

// SMS validity window stated in the message body, e.g. "10分钟内有效".
// Returns 0 when nothing parseable; the caller falls back to the manual
// setting. Sanity-clamped so garbage parses cannot pin a toast forever.
function parseStatedExpiryMinutes(message) {
  const match = String(message || "").match(/(\d{1,3})\s*分钟/);
  if (!match) {
    return 0;
  }
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }
  return Math.min(minutes, 120);
}

let archivalToastLoading = null;

// Silent archival twin of the custom card: "卡片管当下，中心管回看"。
// Every message that pops a card also drops a banner-suppressed (hide:true)
// native toast into the Windows notification center. Verification-code
// toasts carry a copy button whose label embeds the code and expire when
// the code would be dead anyway (10 min); everything else expires after
// 1 h so the center never accumulates corpses. Requires the Start Menu
// shortcut to carry APP_USER_MODEL_ID; degrades silently to card-only if
// the toast stack is unavailable.
async function sendArchivalToast(message, config) {
  try {
    if (!archivalToastLoading) {
      // powertoast v3 is ESM-only with top-level await; dynamic import
      // keeps this CJS main process loadable.
      archivalToastLoading = import("powertoast");
    }
    const { Toast, remove } = await archivalToastLoading;
    const code = extractVerificationCode(message.title, message.message);
    // Retention: manual setting by default; when a verification code's SMS
    // states its own validity window ("N分钟") and smart expiry is on, the
    // stated window wins (falling back to manual when unparseable).
    const manualMs = Math.max(1, Number(config?.archiveExpiryMinutes) || 60) * 60 * 1000;
    let expiryMs = manualMs;
    if (code && config?.codeSmartExpiry) {
      const statedMinutes = parseStatedExpiryMinutes(message.message);
      if (statedMinutes > 0) {
        expiryMs = statedMinutes * 60 * 1000;
      }
    }
    const uniqueID = `gotify-${message.id}`;
    const toast = new Toast({
      aumid: APP_USER_MODEL_ID,
      uniqueID,
      title: message.title || "Gotify 消息",
      message: formatNotificationBody(message.message),
      attribution: message.appname || undefined,
      hide: true,
      silent: true
      // NB: no `button` — event callbacks only work on the pwsh ≥7.1
      // harness, and toasts raised through that harness never reach the
      // notification center on this Windows build (26200): banner shows,
      // nothing archived. The Windows PowerShell 5.1 harness (forced via
      // disablePowershellCore below) archives reliably but has no event
      // feedback, so center buttons would be inert — the custom card
      // remains the only copy interaction.
      // NB: no `expiration` — powertoast 3.0.0 emits `$toast.expiration`
      // which PowerShell rejects (real property is ExpirationTime);
      // expiry is scheduled via remove() below instead.
    });
    setTimeout(() => {
      remove(APP_USER_MODEL_ID, uniqueID).catch(() => {});
    }, expiryMs).unref();
    await toast.show({ disablePowershellCore: true });
  } catch (error) {
    console.error("[ArchivalToast] failed:", error?.message || error);
    archivalToastLoading = null;
  }
}

function formatNotificationBody(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return "收到一条新消息";
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6);
  const merged = lines.join("\n");
  return merged.length > 200 ? `${merged.slice(0, 200)}...` : merged;
}

function isPopupMutedForApp(config, appid) {
  const id = Number(appid || 0);
  if (!id) {
    return false;
  }
  const mutedApps = Array.isArray(config?.mutedNotificationApps) ? config.mutedNotificationApps : [];
  return mutedApps.includes(id);
}

async function forwardToBark(message, config) {
  const barkUrl = config.barkServerUrl;
  if (!barkUrl) return;

  const appid = Number(message.appid || 0);
  const allowedApps = Array.isArray(config.barkForwardApps) ? config.barkForwardApps : [];
  
  // Check if forwarding is enabled for this app (if list is not empty)
  // If list is empty, we assume NO forwarding by default (user must select apps)
  if (allowedApps.length > 0 && !allowedApps.includes(appid)) {
    return;
  }
  if (allowedApps.length === 0) {
    return;
  }

  const title = encodeURIComponent(message.title || "Gotify 消息");
  const body = encodeURIComponent(message.message || "");
  const group = encodeURIComponent(message.appname || "Gotify");
  // Simple Bark URL format: server/push_key/title/body?group=xxx
  // Assuming user provides full URL like https://api.day.app/KEY/
  
  let target = barkUrl.replace(/\/+$/, "");
  // If user pasted full url with key, append content
  // If user pasted just server, we can't do much without key. 
  // Let's assume user provides "https://api.day.app/YOUR_KEY"
  
  const url = `${target}/${title}/${body}?group=${group}`;
  
  try {
    await fetch(url, { method: "GET" });
  } catch (e) {
    console.error("Bark forwarding failed:", e);
  }
}

let catchUpRunning = false;

// Missed-message catch-up (design borrowed from gotify-tray): after a WS
// reconnect, pull recent messages via REST and replay any with id greater
// than the newest one already in local history through the normal message
// pipeline. Complements the WS heartbeat: the heartbeat detects a dead
// socket fast, this recovers whatever was pushed while it was dead.
// First connect after start() intentionally skips (launch-time history is
// loaded elsewhere and would flood the replay).
async function catchUpMissedMessages() {
  if (catchUpRunning) {
    return;
  }
  catchUpRunning = true;
  try {
    const lastId = historyStore.getMaxId();
    const recent = await gotifyClient.fetchRecentMessages(50);
    const missed = recent.filter((m) => Number(m?.id || 0) > lastId);
    if (missed.length === 0) {
      return;
    }
    missed.reverse(); // server returns newest first; replay oldest first
    console.log(`[CatchUp] replaying ${missed.length} missed message(s) after id ${lastId}`);
    for (const message of missed) {
      gotifyClient.processRestMessage(message);
    }
    if (missed.length >= 50) {
      console.warn("[CatchUp] hit the 50-message fetch limit; older missed messages were not replayed");
    }
  } catch (error) {
    console.error("[CatchUp] failed:", error?.message || error);
  } finally {
    catchUpRunning = false;
  }
}

function bindGotifyEvents() {
  gotifyClient.on("reconnected", () => {
    catchUpMissedMessages();
  });
  gotifyClient.on("status", (payload) => {
    currentConnectionStatus = payload;
    mainWindow?.webContents.send("connection-status", payload);
  });
  gotifyClient.on("message", async (message) => {
    // Refresh apps if we see a new appid or if app name is missing
    const appid = Number(message.appid || 0);
    let appName = getAppNameById(appid);
    
    if (appid && !appName) {
      await refreshApplications(configStore.get(), true);
      appName = getAppNameById(appid);
    }
    
    const enriched = appName ? { ...message, appname: appName } : message;
    historyStore.add(enriched);
    mainWindow?.webContents.send("new-message", enriched);
    const config = configStore.get();
    
    // Bark Forwarding
    forwardToBark(enriched, config);

    if (isPopupMutedForApp(config, enriched.appid)) {
      return;
    }

    if (config.showCustomNotification) {
      showCustomNotification(enriched, config);
      sendArchivalToast(enriched, config);
    } else {
      const verificationCode = extractVerificationCode(enriched.title, enriched.message);

      const notification = new Notification({
        title: enriched.title || "Gotify 消息",
        body: formatNotificationBody(enriched.message) + (verificationCode ? " [点击复制验证码]" : ""),
        icon: appIcon.resize({ width: 64, height: 64 }),
        silent: !config.playSound
      });
      notification.on("click", () => {
        if (verificationCode) {
          const { clipboard } = require("electron");
          clipboard.writeText(verificationCode);
        }
        mainWindow?.show();
      });
      notification.show();
    }
  });
}

function setupIpc() {
  ipcMain.handle("app:getVersion", () => `v${app.getVersion()}`);
  ipcMain.handle("config:get", () => configStore.get());
  ipcMain.handle("config:save", async (_, nextConfig) => {
    const saved = configStore.save(nextConfig);
    
    // Handle auto-launch
    const loginSettings = app.getLoginItemSettings();
    if (loginSettings.openAtLogin !== saved.autoLaunch) {
      app.setLoginItemSettings({
        openAtLogin: saved.autoLaunch,
        path: process.execPath,
        // 开机自启时带 --hidden，启动时据此最小化到托盘；关闭自启时不带参数
        args: saved.autoLaunch ? ["--hidden"] : []
      });
    }

    gotifyClient.stop();
    if (saved.serverUrl && saved.clientToken) {
      gotifyClient.start(saved);
      await refreshApplications(saved, true);
    }
    return saved;
  });
  ipcMain.handle("messages:get", () => historyStore.getAll());
  ipcMain.handle("messages:clear", () => {
    try {
      historyStore.clear();
      mainWindow?.webContents.send("messages-cleared");
      return true;
    } catch (error) {
      return false;
    }
  });
  ipcMain.handle("messages:toggleFavorite", (_, id) => {
    return historyStore.toggleFavorite(id);
  });
  ipcMain.handle("connection:test", async (_, payload) => {
    await testConnection(payload.serverUrl, payload.clientToken);
    return true;
  });
  ipcMain.handle("connection:toggle", () => {
    const config = configStore.get();
    if (gotifyClient.connected) {
      gotifyClient.stop();
      return { connected: false };
    }
    gotifyClient.start(config);
    refreshApplications(config, true);
    return { connected: true };
  });
  ipcMain.handle("connection:getStatus", () => currentConnectionStatus);
  ipcMain.handle("applications:get", async () => {
    const config = configStore.get();
    return refreshApplications(config, false);
  });
  ipcMain.handle("storage:getPath", () => ({
    path: storageDirPath,
    lockedByEnv: Boolean(String(process.env.GOTIFY_DATA_DIR || "").trim())
  }));
  ipcMain.handle("storage:open", () => {
    if (storageDirPath) {
      require("electron").shell.openPath(storageDirPath);
    }
  });
  ipcMain.handle("storage:pickPath", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths?.length) {
      return "";
    }
    return result.filePaths[0];
  });
  ipcMain.handle("storage:setPath", (_, nextPath) => {
    const envPath = String(process.env.GOTIFY_DATA_DIR || "").trim();
    if (envPath) {
      throw new Error("检测到 GOTIFY_DATA_DIR 已设置，无法在界面修改路径");
    }
    const normalized = path.resolve(String(nextPath || "").trim());
    if (!normalized) {
      throw new Error("存储路径不能为空");
    }
    ensureWritableDir(normalized);
    copyDataFiles(storageDirPath, normalized);
    savePreferredStorageDir(normalized);
    const changed = normalized !== storageDirPath;
    storageDirPath = normalized;
    return { changed, path: normalized, restartRequired: changed };
  });
  ipcMain.on("custom-notification-open-main", (_, windowId) => {
    closeCustomNotificationWindow(windowId);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  ipcMain.on("custom-notification-close", (_, windowId) => {
    closeCustomNotificationWindow(windowId);
  });
  ipcMain.on("custom-notification-copy-code", (_, { id, code }) => {
    if (code) {
      const { clipboard } = require("electron");
      clipboard.writeText(code);
    }
  });
  ipcMain.on("custom-notification-pause-timer", (_, windowId) => {
    const notification = activeNotifications.find((n) => n.id === windowId);
    if (notification && notification.timer) {
      clearTimeout(notification.timer);
      notification.timer = null;
    }
  });
  ipcMain.on("custom-notification-resume-timer", (_, windowId) => {
    const notification = activeNotifications.find((n) => n.id === windowId);
    const config = configStore.get();
    if (notification && !config.notificationNeverClose && config.notificationAutoHide) {
      if (notification.timer) clearTimeout(notification.timer);
      const duration = Math.max(1000, Number(config.notificationDuration) || 5000);
      notification.timer = setTimeout(() => closeCustomNotificationWindow(windowId), duration);
    }
  });
}

function quitApp() {
  app.isQuiting = true;
  closeCustomNotificationWindow();
  gotifyClient?.stop();
  tray?.destroy();
  app.quit();
}

app.whenReady().then(() => {
  appIcon = createGotifyIcon();
  storageDirPath = resolveStorageDir();
  configStore = new ConfigStore(storageDirPath);
  historyStore = new HistoryStore(storageDirPath);
  gotifyClient = new GotifyClient();
  bindGotifyEvents();
  setupIpc();
  // 判断本次是否为开机自启（wasOpenedAtLogin）或带 --hidden 参数启动，
  // 命中则将主窗口隐藏到托盘
  const loginSettings = app.getLoginItemSettings();
  startHiddenAtLaunch =
    Boolean(loginSettings.wasOpenedAtLogin) || process.argv.includes("--hidden");
  createWindow();
  createTray();
  mainWindow?.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.send("connection-status", currentConnectionStatus);
  });
  const config = configStore.get();
  if (config.serverUrl && config.clientToken) {
    gotifyClient.start(config);
    refreshApplications(config, true);
  } else {
    mainWindow?.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.send("connection-status", { connected: false, status: "未连接" });
    });
  }
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("activate", () => {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
