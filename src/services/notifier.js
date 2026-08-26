const { BrowserWindow, Notification, clipboard, screen, ipcMain, nativeTheme } = require("electron");
const { avatarColor, avatarLabel } = require("./app-avatar");

// Single home of the app identity used for Windows notifications. The
// Start Menu shortcut must carry this exact AUMID as its
// System.AppUserModel.ID property or toasts never persist in the
// notification center (main.js re-exports it for app.setAppUserModelId).
const APP_USER_MODEL_ID = "com.gotify.client.desktop";

// Injected from main.js at startup (notifier must not own window lifetime
// or config storage; resume-timer reads config live, matching the
// pre-extraction behavior).
let getMainWindow = () => null;
let getAppIcon = () => null;
let getConfig = () => ({});

function initNotifier({ getMainWindow: windowGetter, getAppIcon: iconGetter, getConfig: configGetter }) {
  getMainWindow = windowGetter || getMainWindow;
  getAppIcon = iconGetter || getAppIcon;
  getConfig = configGetter || getConfig;
  registerCardIpc();
}

// ---------------------------------------------------------------------------
// Shared message analysis
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Entry point: one message in, the right combination of surfaces out
// ---------------------------------------------------------------------------

// 卡片管当下，中心管回看。Muted apps surface nowhere (same as before the
// notifier extraction).
function notify(message, config) {
  if (isPopupMutedForApp(config, message.appid)) {
    return;
  }
  if (config.showCustomNotification) {
    showCustomNotification(message, config);
    sendArchivalToast(message, config);
  } else {
    showNativeNotification(message, config);
  }
}

// ---------------------------------------------------------------------------
// Custom card (foreground)
// ---------------------------------------------------------------------------

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

// 通知卡配色（CP7 落地，二轮 S4 调参）：Acrylic 窗体上叠半透明面色透出磨砂
// 桌面，随系统深浅取 CP6 token 同族色值；卡是生成时定色的短命表面。
// 二轮调参：fill 浅 0.5/深 0.6（0.66 会糊死 Acrylic）、圆角 8（系统制式）、
// 去实边框改投影（DWM acrylic 自带 luminosity 边）。
const CARD_PALETTE = {
  dark: {
    card: "rgba(16, 28, 44, 0.6)",
    cardHover: "rgba(30, 44, 65, 0.7)",
    title: "#e2e8f0",
    app: "#94a3b8",
    body: "#cbd5e1",
    close: "#64748b",
    closeHoverBg: "rgba(100, 116, 139, 0.22)",
    closeHover: "#e2e8f0",
    code: "#6ee7b7",
    codeBg: "rgba(34, 197, 94, 0.18)",
    act: "#93c5fd"
  },
  light: {
    card: "rgba(255, 255, 255, 0.5)",
    cardHover: "rgba(250, 250, 250, 0.62)",
    title: "#333333",
    app: "#555555",
    body: "#555555",
    close: "#888888",
    closeHoverBg: "rgba(136, 136, 136, 0.16)",
    closeHover: "#333333",
    code: "#157347",
    codeBg: "rgba(34, 197, 94, 0.16)",
    act: "#1d4ed8"
  }
};

function buildCustomNotificationHtml({ title, subtitle, body, id, verificationCode, appid }) {
  const escapeHtml = (text) =>
    String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const code = verificationCode || "";
  const c = nativeTheme.shouldUseDarkColors ? CARD_PALETTE.dark : CARD_PALETTE.light;
  const avColor = avatarColor(appid);
  const avLabel = escapeHtml(avatarLabel(subtitle, appid));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; overflow: hidden; background: transparent; font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei", sans-serif; }
    /* 二轮 S4 修正+M4 优雅版：applySystemRoundedCorners 给窗 DWM 8px 圆角后，
       卡面恢复 8px 圆角与窗角重合（koffi 失败时窗为方角，卡圆角会在四角露出
       材质方块——可接受降级）。仍禁 CSS 投影（窗缘裁切直角圈，electron.md E2）。 */
    .card { width: ${NOTIFICATION_WIDTH}px; border-radius: 8px; background: ${c.card}; color: ${c.title}; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; animation: popup .18s ease-out; cursor: pointer; transition: background 0.2s; }
    .card:hover { background: ${c.cardHover}; }
    @keyframes popup { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .meta { display: flex; align-items: center; gap: 8px; }
    .avatar { width: 22px; height: 22px; border-radius: 6px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #ffffff; }
    .app-name { font-size: 12px; color: ${c.app}; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .time { font-size: 11px; color: ${c.close}; font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .close { border: none; background: transparent; color: ${c.close}; width: 28px; height: 28px; margin: -8px -8px 0 0; cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .close:hover { background: ${c.closeHoverBg}; color: ${c.closeHover}; }
    .close svg { width: 12px; height: 12px; }
    .title { font-size: 14px; font-weight: 600; color: ${c.title}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .body { font-size: 13px; line-height: 1.4; color: ${c.body}; white-space: pre-line; max-height: 72px; overflow: hidden; }
    .code { font-family: Consolas, "Cascadia Mono", monospace; font-variant-numeric: tabular-nums; color: ${c.code}; background: ${c.codeBg}; border-radius: 4px; padding: 0 5px; }
    .code.ok { color: #ffffff; background: #22c55e; }
    .actions { display: ${code ? "flex" : "none"}; gap: 14px; margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(128, 128, 128, 0.22); }
    .act { background: none; border: none; padding: 2px 4px; font-size: 12px; color: ${c.act}; cursor: pointer; border-radius: 4px; }
    .act:hover { background: ${c.closeHoverBg}; }
  </style>
</head>
<body>
  <div id="card" class="card">
    <div class="meta">
      <div class="avatar" style="background:${avColor}">${avLabel}</div>
      <div class="app-name">${escapeHtml(subtitle)}</div>
      <div class="time" id="time"></div>
      <button id="close" class="close" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 18L18 6M6 6l12 12"/></svg></button>
    </div>
    <div class="title">${escapeHtml(title)}</div>
    <div class="body" id="body"></div>
    <div class="actions">
      <button class="act" id="act-copy">复制验证码</button>
      <button class="act" id="act-open">打开消息列表</button>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require("electron");
    const closeButton = document.getElementById("close");
    const card = document.getElementById("card");
    const bodyEl = document.getElementById("body");
    const verificationCode = "${code}";

    document.getElementById("time").innerText = new Date().toTimeString().slice(0, 5);
    // 正文渲染：验证码段 mono 高亮（点击整卡复制的交互不变）
    const raw = ${JSON.stringify(body)};
    if (verificationCode && raw.includes(verificationCode)) {
      let rest = raw;
      while (verificationCode && rest.includes(verificationCode)) {
        const idx = rest.indexOf(verificationCode);
        if (idx > 0) bodyEl.appendChild(document.createTextNode(rest.slice(0, idx)));
        const chip = document.createElement("span");
        chip.className = "code";
        chip.innerText = verificationCode;
        bodyEl.appendChild(chip);
        rest = rest.slice(idx + verificationCode.length);
      }
      if (rest) bodyEl.appendChild(document.createTextNode(rest));
    } else {
      bodyEl.innerText = raw;
    }

    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      ipcRenderer.send("custom-notification-close", "${id}");
    });

    card.addEventListener("click", () => {
      if (verificationCode) {
        copyCodeWithFeedback();
      } else {
        ipcRenderer.send("custom-notification-open-main", "${id}");
      }
    });

    // 二轮 M4：action 行显式按钮（点卡=复制，按钮=精确意图）
    const copyCodeWithFeedback = () => {
      ipcRenderer.send("custom-notification-copy-code", { id: "${id}", code: verificationCode });
      document.querySelectorAll(".code").forEach((chip) => {
        chip.innerText = "已复制";
        chip.classList.add("ok");
      });
      const actCopy = document.getElementById("act-copy");
      if (actCopy) actCopy.innerText = "已复制";
      setTimeout(() => {
        ipcRenderer.send("custom-notification-close", "${id}");
      }, 1500);
    };
    const actCopyBtn = document.getElementById("act-copy");
    if (actCopyBtn) {
      actCopyBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        copyCodeWithFeedback();
      });
    }
    const actOpenBtn = document.getElementById("act-open");
    if (actOpenBtn) {
      actOpenBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        ipcRenderer.send("custom-notification-open-main", "${id}");
      });
    }

    card.addEventListener("mouseenter", () => {
      ipcRenderer.send("custom-notification-pause-timer", "${id}");
    });

    card.addEventListener("mouseleave", () => {
      ipcRenderer.send("custom-notification-resume-timer", "${id}");
    });

    // 二轮 S4：动态窗高——load 后多段稳态测量（首帧字体度量未稳会量出假高）
    const reportHeight = () => {
      const h = Math.min(140, Math.max(64, Math.ceil(document.body.scrollHeight) + 2));
      ipcRenderer.send("custom-notification-resize", { id: "${id}", height: h });
    };
    window.addEventListener("load", () => {
      setTimeout(reportHeight, 50);
      setTimeout(reportHeight, 250);
    });
  </script>
</body>`;
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

  const verificationCode = extractVerificationCode(title, message.message);

  const html = buildCustomNotificationHtml({ title, subtitle, body, id, verificationCode, appid: message.appid });

  const notificationWindow = new BrowserWindow({
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
    x: workArea.x + workArea.width - NOTIFICATION_WIDTH - 16,
    y: workArea.y + workArea.height - (NOTIFICATION_HEIGHT + NOTIFICATION_GAP) * (activeNotifications.length + 1) - 6,
    frame: false,
    // 二轮 S4：动态窗高需要（resizable:false 在 Win 上令 setContentSize 无声失效；
    // frameless+不可聚焦+无最大化钮，resizable 无用户可感知副作用）
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    transparent: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    // CP7 M2：Acrylic 窗体（叠桌面磨砂），半透明面色在 CSS 层
    ...(process.platform === "win32" ? { backgroundMaterial: "acrylic" } : {}),
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
  // 系统圆角（成则卡恢复 8px 圆角与 DWM luminosity 边吻合）
  applySystemRoundedCorners(notificationWindow);
  notificationWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  notificationWindow.once("ready-to-show", () => notificationWindow?.showInactive());

  if (!config.notificationNeverClose && config.notificationAutoHide) {
    const duration = Math.max(1000, Number(config.notificationDuration) || 5000);
    notificationData.timer = setTimeout(() => closeCustomNotificationWindow(id), duration);
  }

  activeNotifications.push(notificationData);
}

// 二轮 M4 优雅圆角：DWMWA_WINDOW_CORNER_PREFERENCE(33)=DWMWCP_ROUND(2) 给
// frameless+transparent 窗系统圆角（Win11 自动圆角不覆盖此类窗，electron.md E2）。
// koffi(FFI, N-API) 从 dwmapi.dll 直调；加载失败静默回退方角（无 crash 面）。
// 生产 asar 需 --unpack-dir node_modules/koffi（.node 不能从 asar 内加载）。
let dwmSetWindowAttribute = null;
function loadDwmApi() {
  if (dwmSetWindowAttribute !== null) {
    return dwmSetWindowAttribute;
  }
  if (process.platform !== "win32") {
    return (dwmSetWindowAttribute = false);
  }
  try {
    const koffi = require("koffi");
    const dwm = koffi.load("dwmapi.dll");
    dwmSetWindowAttribute = dwm.func("long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attr, void* pv, uint32_t cb)");
  } catch (error) {
    console.error("[Notify] koffi/dwmapi 不可用，弹卡回退方角:", error?.message || error);
    dwmSetWindowAttribute = false;
  }
  return dwmSetWindowAttribute;
}

function applySystemRoundedCorners(window) {
  const setAttr = loadDwmApi();
  if (!setAttr || !window || window.isDestroyed()) {
    return;
  }
  try {
    const handle = window.getNativeWindowHandle();
    const hwnd = process.arch === "x64" ? handle.readBigInt64LE(0) : BigInt(handle.readInt32LE(0));
    const preference = Buffer.alloc(4);
    preference.writeInt32LE(2, 0); // DWMWCP_ROUND（系统 8px）
    const hr = setAttr(hwnd, 33, preference, 4);
    if (hr !== 0) {
      console.error("[Notify] corner preference hr=0x" + (hr >>> 0).toString(16));
    }
  } catch (error) {
    console.error("[Notify] corner preference failed:", error?.message || error);
  }
}

function registerCardIpc() {
  ipcMain.on("custom-notification-close", (_, windowId) => {
    closeCustomNotificationWindow(windowId);
  });
  // 二轮 S4：卡片内容量完自报高度（钳 64-140），窗随内容不再固定 96
  ipcMain.on("custom-notification-resize", (_, { id, height } = {}) => {
    const notification = activeNotifications.find((n) => n.id === id);
    if (notification?.window && !notification.window.isDestroyed()) {
      try {
        notification.window.setContentSize(NOTIFICATION_WIDTH, Math.max(64, Math.min(140, Number(height) || 96)));
      } catch {}
    }
  });
  ipcMain.on("custom-notification-copy-code", (_, { id, code }) => {
    // Card closes itself 1.5s after showing the 复制成功 badge; closing
    // here would cut the feedback short.
    if (code) {
      clipboard.writeText(code);
    }
  });
  ipcMain.on("custom-notification-open-main", (_, windowId) => {
    closeCustomNotificationWindow(windowId);
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
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
    const config = getConfig();
    if (notification && !config.notificationNeverClose && config.notificationAutoHide) {
      if (notification.timer) clearTimeout(notification.timer);
      const duration = Math.max(1000, Number(config.notificationDuration) || 5000);
      notification.timer = setTimeout(() => closeCustomNotificationWindow(windowId), duration);
    }
  });
}

// ---------------------------------------------------------------------------
// Native fallback (Electron Notification; used when the card is disabled)
// ---------------------------------------------------------------------------

function showNativeNotification(message, config) {
  const verificationCode = extractVerificationCode(message.title, message.message);
  const notification = new Notification({
    title: message.title || "Gotify 消息",
    body: formatNotificationBody(message.message) + (verificationCode ? " [点击复制验证码]" : ""),
    icon: getAppIcon().resize({ width: 64, height: 64 }),
    silent: !config.playSound
  });
  notification.on("click", () => {
    if (verificationCode) {
      clipboard.writeText(verificationCode);
    }
    getMainWindow()?.show();
  });
  notification.show();
}

// ---------------------------------------------------------------------------
// Archival toast (notification center)
// ---------------------------------------------------------------------------

let archivalToastLoading = null;

function ensurePowertoast() {
  if (!archivalToastLoading) {
    // powertoast v3 is ESM-only with top-level await; dynamic import
    // keeps this CJS main process loadable.
    archivalToastLoading = import("powertoast");
  }
  return archivalToastLoading;
}

// L2 owner: every archival toast still meaningfully alive is registered
// here (uniqueID -> { expireAt, timer }). Timers handle in-process expiry;
// the quit flush and the startup reconciliation below guarantee no toast
// outlives the process even when its timer never gets to fire (quit,
// crash, kill -9, shutdown race).
const archivalLedger = new Map();

function removeArchivalToast(uniqueID) {
  ensurePowertoast()
    .then(({ remove }) => remove(APP_USER_MODEL_ID, uniqueID))
    .catch((error) => {
      // Not silent on purpose: a leaked toast stays in the center until
      // the next quit flush or startup reconciliation sweeps it.
      console.error(`[ArchivalToast] remove failed for ${uniqueID}:`, error?.message || error);
    });
}

function registerArchivalToast(uniqueID, expiryMs) {
  // Same message re-notified (duplicate delivery): retire the previous
  // registration instead of letting its timer fire over the new entry.
  unregisterArchivalToast(uniqueID);
  const entry = { expireAt: Date.now() + expiryMs, timer: null };
  entry.timer = setTimeout(() => {
    unregisterArchivalToast(uniqueID);
    removeArchivalToast(uniqueID);
  }, expiryMs);
  // Must not hold the process open: the quit flush owns exit-time cleanup.
  entry.timer.unref();
  archivalLedger.set(uniqueID, entry);
}

function unregisterArchivalToast(uniqueID) {
  const entry = archivalLedger.get(uniqueID);
  if (entry?.timer) {
    clearTimeout(entry.timer);
  }
  archivalLedger.delete(uniqueID);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref();
    })
  ]);
}

// Quit path (before-quit): sweep the whole center namespace with one
// Clear() instead of one PowerShell spawn per ledger entry. Best-effort
// with a timeout guard so a hung PowerShell cannot block quitting forever;
// anything missed here falls to the next startup reconciliation.
async function flushArchivalToasts() {
  if (archivalLedger.size === 0) {
    return;
  }
  const count = archivalLedger.size;
  for (const uniqueID of [...archivalLedger.keys()]) {
    unregisterArchivalToast(uniqueID);
  }
  try {
    const { remove } = await ensurePowertoast();
    await withTimeout(remove(APP_USER_MODEL_ID), 3000);
    console.log(`[ArchivalToast] quit flush removed ${count} toast(s)`);
  } catch (error) {
    console.error("[ArchivalToast] quit flush failed:", error?.message || error);
  }
}

// Startup path: a previous run that died without before-quit (crash,
// kill -9, OS shutdown race) leaves orphaned toasts in the center. The
// ledger died with that process, so anything under our AUMID at boot is
// residue by definition — sweep it.
async function reconcileArchivalToasts() {
  try {
    const { getHistory, remove } = await ensurePowertoast();
    const history = await withTimeout(getHistory(APP_USER_MODEL_ID), 5000);
    if (!Array.isArray(history) || history.length === 0) {
      return;
    }
    await withTimeout(remove(APP_USER_MODEL_ID), 5000);
    console.log(`[ArchivalToast] startup reconciliation cleared ${history.length} residue toast(s)`);
  } catch (error) {
    console.error("[ArchivalToast] startup reconciliation failed:", error?.message || error);
  }
}

// Silent archival twin of the custom card: "卡片管当下，中心管回看"。
// Every message that pops a card also drops a banner-suppressed (hide:true)
// native toast into the Windows notification center, then removes it from
// the center when it expires. Retention is configurable (minutes, settings
// page) and verification-code messages can follow the validity window
// stated in the SMS itself when smart expiry is enabled. Requires the Start
// Menu shortcut to carry APP_USER_MODEL_ID; degrades silently to card-only
// if the toast stack is unavailable.
async function sendArchivalToast(message, config) {
  const uniqueID = `gotify-${message.id}`;
  try {
    const { Toast } = await ensurePowertoast();
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
      // expiry is scheduled via the ledger timer instead.
    });
    // Register before show so a quit racing the PowerShell call still
    // flushes this toast.
    registerArchivalToast(uniqueID, expiryMs);
    await toast.show({ disablePowershellCore: true });
  } catch (error) {
    // Show failed: drop the registration (nothing to expire). If the toast
    // partially made it into the center anyway, the next startup
    // reconciliation is the backstop.
    unregisterArchivalToast(uniqueID);
    console.error("[ArchivalToast] failed:", error?.message || error);
    archivalToastLoading = null;
  }
}

module.exports = {
  APP_USER_MODEL_ID,
  initNotifier,
  notify,
  extractVerificationCode,
  closeAllNotifications: () => closeCustomNotificationWindow(),
  flushArchivalToasts,
  reconcileArchivalToasts
};
