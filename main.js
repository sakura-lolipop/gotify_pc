const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog } = require("electron");
const { ConfigStore } = require("./src/services/config-store");
const { HistoryStore } = require("./src/services/history-store");
const { GotifyClient, testConnection } = require("./src/services/gotify-client");
const {
  initNotifier,
  notify,
  closeAllNotifications,
  APP_USER_MODEL_ID,
  flushArchivalToasts,
  reconcileArchivalToasts
} = require("./src/services/notifier");

let mainWindow = null;
let tray = null;
let configStore = null;
let historyStore = null;
let gotifyClient = null;
let appIcon = null;
let currentConnectionStatus = { connected: false, status: "未连接" };
let storageDirPath = "";
let applicationMap = new Map();
let applicationList = [];
let lastApplicationsFetchedAt = 0;
// 是否以"隐藏到托盘"方式启动（开机自启或带 --hidden 参数时为 true）
let startHiddenAtLaunch = false;
const APP_NAME = "Gotify 客户端";

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
    // Win11 Mica（ui-scan M1 配方）：删自绘 backgroundColor，窗口底交给 DWM
    // 材质；网页侧 body 须透明才能透出（index.html 同步改）。低版本 Windows
    // 静默回退普通窗口，需 index.html 兜底色。
    ...(process.platform === "win32" ? { backgroundMaterial: "mica" } : {}),
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

    notify(enriched, config);
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
}

function quitApp() {
  app.isQuiting = true;
  closeAllNotifications();
  gotifyClient?.stop();
  tray?.destroy();
  app.quit();
}

app.whenReady().then(() => {
  appIcon = createGotifyIcon();
  storageDirPath = resolveStorageDir();
  configStore = new ConfigStore(storageDirPath);
  historyStore = new HistoryStore(storageDirPath);
  initNotifier({
    getMainWindow: () => mainWindow,
    getAppIcon: () => appIcon,
    getConfig: () => configStore.get()
  });
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
  // L2 backstop: sweep archival toasts orphaned by a previous run that died
  // without a clean quit (crash / kill -9 / shutdown race).
  reconcileArchivalToasts();
});

// L2: archival toasts must not outlive the process. Defer the actual quit
// until the notification-center flush finishes; the flag lets the re-issued
// app.quit() pass through.
let archivalFlushDone = false;
app.on("before-quit", (event) => {
  if (archivalFlushDone) {
    return;
  }
  event.preventDefault();
  archivalFlushDone = true;
  flushArchivalToasts().finally(() => app.quit());
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
