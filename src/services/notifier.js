const { BrowserWindow, Notification, clipboard, screen, ipcMain } = require("electron");

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

  const iconDataUrl = getAppIcon().resize({ width: 64, height: 64 }).toDataURL();
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

function registerCardIpc() {
  ipcMain.on("custom-notification-close", (_, windowId) => {
    closeCustomNotificationWindow(windowId);
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

// Silent archival twin of the custom card: "卡片管当下，中心管回看"。
// Every message that pops a card also drops a banner-suppressed (hide:true)
// native toast into the Windows notification center, then removes it from
// the center when it expires. Retention is configurable (minutes, settings
// page) and verification-code messages can follow the validity window
// stated in the SMS itself when smart expiry is enabled. Requires the Start
// Menu shortcut to carry APP_USER_MODEL_ID; degrades silently to card-only
// if the toast stack is unavailable.
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

module.exports = {
  APP_USER_MODEL_ID,
  initNotifier,
  notify,
  closeAllNotifications: () => closeCustomNotificationWindow()
};
