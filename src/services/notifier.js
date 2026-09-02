const { app, shell, BrowserWindow, Notification, clipboard, screen, ipcMain, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { extractMessageUrls, hostOf } = require("./message-urls");

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

// 弹卡提示音：assets/sounds/<品牌>/<文件>.ogg（asar 内 fs 透明读取）→ data URI
// 嵌进卡 HTML。校验与 main 的 sounds:read 同一形态；读不到回落无声（弹卡不因
// 音频缺位失败）。
function readSoundDataUri(value) {
  const match = /^([\w-]+)\/([\w .-]+\.ogg)$/.exec(String(value || ""));
  if (!match) {
    return "";
  }
  try {
    const buffer = fs.readFileSync(path.join(app.getAppPath(), "assets", "sounds", match[1], match[2]));
    return `data:audio/ogg;base64,${buffer.toString("base64")}`;
  } catch {
    return "";
  }
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
  // 空参=关全部。统一路径：先移出列表并重排（退场卡淡出的 160ms 里下方卡
  // 已上移，同 Win11 系统行为），renderer 收 closing 叠淡出，之后真关窗。
  const targets = windowId ? activeNotifications.filter((n) => n.id === windowId) : activeNotifications.slice();
  if (targets.length === 0) {
    return;
  }
  activeNotifications = activeNotifications.filter((n) => !targets.includes(n));
  targets.forEach((n) => {
    if (n.timer) clearTimeout(n.timer);
    if (n.window && !n.window.isDestroyed()) {
      try {
        n.window.webContents.send("custom-notification-closing");
      } catch {}
      const window = n.window;
      // 退场可见性单点=窗级 setOpacity：CSS opacity 淡不掉材质背景（玻璃是
      // 窗实体），旧淡出期残窗叠在底部=「越测底下的卡越大」。三步窗级渐隐
      // (~150ms)→close→400ms destroy 兜底。
      setTimeout(() => window.isDestroyed() || window.setOpacity(0.5), 50);
      setTimeout(() => window.isDestroyed() || window.setOpacity(0.15), 100);
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setOpacity(0);
          window.close();
          setTimeout(() => {
            if (!window.isDestroyed()) {
              window.destroy();
            }
          }, 400);
        }
      }, 150);
    }
  });
  repositionNotifications();
}

// 动态窗高（S4）后固定 96 常量排位失真：高卡（≤140）按 96+10 栈距排会相互
// 重叠、底卡 resize 时从左上角锚定向下扩探进任务栏。自底向上按各窗实际
// 高度累计排位；resize/close 后重排全体。
function repositionNotifications() {
  const workArea = screen.getPrimaryDisplay().workArea;
  // 出屏防御（三轮）：高卡（≤190）×5 的栈总高可能超过屏幕——最上卡会被排
  // 到 workArea 之上。栈超高时淘汰最旧一张再重排（close 内部递归重排，这里
  // 直接返回交给那次）；保底留 1 张不淘。
  let total = -NOTIFICATION_GAP;
  activeNotifications.forEach((n) => {
    total += NOTIFICATION_GAP + (n.window && !n.window.isDestroyed() ? n.window.getBounds().height : NOTIFICATION_HEIGHT);
  });
  if (activeNotifications.length > 1 && total > workArea.height) {
    closeCustomNotificationWindow(activeNotifications[0].id);
    return;
  }
  let bottomEdge = workArea.y + workArea.height - 6;
  activeNotifications.forEach((n) => {
    if (n.window && !n.window.isDestroyed()) {
      // 尺寸单一真相=自有账本 entry.height（上报时记）。台账实证：44 上
      // frameless 窗每次 setPosition 尺寸取整漂移 +1（getBounds 被污染），
      // 旧实现用 getBounds 排位=污染回灌→全体滚雪球变大。改 setBounds
      // 显式钉回 360×真高，每轮归零漂移。
      const height = n.height || (n.window ? n.window.getBounds().height : NOTIFICATION_HEIGHT);
      const newY = bottomEdge - height;
      n.window.setBounds({ x: workArea.x + workArea.width - NOTIFICATION_WIDTH - 16, y: newY, width: NOTIFICATION_WIDTH, height });
      bottomEdge = newY - NOTIFICATION_GAP;
    }
  });
}

// 通知卡配色（CP7 落地）：Acrylic 窗体上叠半透明面色透出磨砂桌面。三轮
// （2026-09-02）面色进主题工坊（config.cardGlass，浅深各 tint+alpha）：
// 面色/hover 由 face 动态生成（hover=alpha+0.1 派生）；文字族按底色亮度
// 自动选深/浅（防浅色卡调成深底后字不可见）。此处只剩文字/交互色。
const CARD_FACE_DEFAULTS = {
  light: { alpha: 0.5, tint: "#ffffff" },
  dark: { alpha: 0.6, tint: "#101c2c" }
};
const CARD_TEXT_PALETTE = {
  dark: {
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

function rgbaFromHex(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) {
    return `rgba(255, 255, 255, ${alpha})`;
  }
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function faceLuma(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) {
    return 1;
  }
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

// 解析面色：override（工坊测试按草稿直弹）> config.cardGlass > 默认
function resolveCardFace(config, faceOverride) {
  const mode = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  const face = faceOverride || config?.cardGlass?.[mode] || CARD_FACE_DEFAULTS[mode];
  return {
    tint: face.tint,
    alpha: face.alpha,
    card: rgbaFromHex(face.tint, face.alpha),
    cardHover: rgbaFromHex(face.tint, Math.min(face.alpha + 0.1, 1)),
    // 亮底用深字族，暗底用浅字族
    text: faceLuma(face.tint) > 0.5 ? CARD_TEXT_PALETTE.light : CARD_TEXT_PALETTE.dark
  };
}

function buildCustomNotificationHtml({ title, subtitle, body, id, verificationCode, soundDataUri, urls, face }) {
  const escapeHtml = (text) =>
    String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const code = verificationCode || "";
  const c = face.text;
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
    .card { width: ${NOTIFICATION_WIDTH}px; border-radius: 8px; background: ${face.card}; color: ${c.title}; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; animation: popup .28s cubic-bezier(0.16, 1, 0.3, 1); cursor: pointer; transition: background 0.2s; }
    .card:hover { background: ${face.cardHover}; }
    /* 三轮：进场 0.28s expo-out 上浮 28px（对齐 Win11 toast 浮入手感）；
       退场由主进程先发 closing 再延迟关窗，这里只做 0.15s 淡出。 */
    .card.closing { opacity: 0; transition: opacity .15s ease-in; animation: none; }
    @keyframes popup { from { transform: translateY(28px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .meta { display: flex; align-items: center; gap: 8px; }
    .app-name { font-size: 12px; color: ${c.app}; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .time { font-size: 11px; color: ${c.close}; font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .close { border: none; background: transparent; color: ${c.close}; width: 28px; height: 28px; margin: -8px -8px 0 0; cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .close:hover { background: ${c.closeHoverBg}; color: ${c.closeHover}; }
    .close svg { width: 12px; height: 12px; }
    .title { font-size: 14px; font-weight: 600; color: ${c.title}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .body { font-size: 13px; line-height: 1.4; color: ${c.body}; white-space: pre-line; max-height: 72px; overflow: hidden; }
    .code { font-family: "Cascadia Mono", Consolas, monospace; font-variant-numeric: tabular-nums; color: ${c.code}; background: ${c.codeBg}; border-radius: 4px; padding: 0 5px; }
    .code.ok { color: #ffffff; background: #22c55e; }
    /* 三轮：弹卡 URL 按钮（用户拍板「弹卡也带按钮」）——与列表按钮同一
       提取源（message-urls 单一真相），点击走 IPC 开系统浏览器 */
    .urls { display: ${urls.length ? "flex" : "none"}; flex-wrap: wrap; gap: 6px; }
    .url-btn { border: 1px solid rgba(128, 128, 128, 0.3); background: rgba(128, 128, 128, 0.12); color: inherit; font-size: 12px; padding: 2px 8px; border-radius: 4px; cursor: pointer; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .url-btn:hover { border-color: ${c.act}; color: ${c.act}; }
    .actions { display: ${code ? "flex" : "none"}; gap: 14px; margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(128, 128, 128, 0.22); }
    .act { background: none; border: none; padding: 2px 4px; font-size: 12px; color: ${c.act}; cursor: pointer; border-radius: 4px; }
    .act:hover { background: ${c.closeHoverBg}; }
  </style>
</head>
<body>
  ${soundDataUri ? `<audio autoplay src="${soundDataUri}"></audio>` : ""}
  <div id="card" class="card">
    <div class="meta">
      <div class="app-name">${escapeHtml(subtitle)}</div>
      <div class="time" id="time"></div>
      <button id="close" class="close" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 18L18 6M6 6l12 12"/></svg></button>
    </div>
    <div class="title">${escapeHtml(title)}</div>
    <div class="body" id="body"></div>
    <div class="urls">
      ${urls.map((u) => `<button class="url-btn" data-url="${escapeHtml(u)}" title="${escapeHtml(u)}">🔗 ${escapeHtml(hostOf(u))}</button>`).join("")}
    </div>
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

    // 退场：主进程关窗前 160ms 通知到位，这里只叠淡出 class
    ipcRenderer.on("custom-notification-closing", () => {
      card.classList.add("closing");
    });

    document.querySelectorAll(".url-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        ipcRenderer.send("custom-notification-open-url", btn.dataset.url);
      });
    });

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

    // 三轮定稿:高度单源单报+同数三消费——h 算一次,同一数字分发:
    // ①上报主进程 setContentSize(窗) ②body 锁高(布局) ③卡随 body。
    // 旧病:窗高(测量值)与卡高(CSS 自然高)两个计算源靠隐式契约对齐,
    // 测量后字体晚到/重排/取整任一环抖 1px 就是「双层缝」。
    const reportHeight = () => {
      // 上限 190:正文(≤72)+URL 按钮行(24)+验证码 actions 的最坏叠加 ~216,
      // 190 覆盖「长文+按钮」(~176),极端叠加仍让位窗缘
      const h = Math.min(190, Math.max(64, Math.ceil(document.body.scrollHeight)));
      document.body.style.height = h + "px";
      document.body.style.overflow = "hidden";
      ipcRenderer.send("custom-notification-resize", { id: "${id}", height: h });
    };
    window.addEventListener("load", () => {
      setTimeout(reportHeight, 250);
    });
  </script>
</body>`;
}

// 首露面=终态（单一真相，reveal 单点）：弹卡观感由 DWM 材质 attach/CSS
// 面色/入场动画/动态 resize 四路异步写入，show 早于 resize 到位会出现
// 「先透明后收回」的竞争窗口。首露面压到稳态之后；auto-hide 计时同挪到
// 露面时刻（可见时长不被暗中耗时吃掉）。
function revealNotification(entry) {
  if (!entry || entry.shown || !entry.window || entry.window.isDestroyed()) {
    return;
  }
  entry.shown = true;
  entry.window.showInactive();
  const config = getConfig();
  if (!config.notificationNeverClose && config.notificationAutoHide) {
    const duration = Math.max(1000, Number(config.notificationDuration) || 5000);
    entry.timer = setTimeout(() => closeCustomNotificationWindow(entry.id), duration);
  }
}

function showCustomNotification(message, config, faceOverride, acrylicOverride) {
  if (activeNotifications.length >= MAX_NOTIFICATIONS) {
    // 淘汰最旧也走统一 close（含淡出与重排），不再手抄一份关窗逻辑
    const oldest = activeNotifications[0];
    if (oldest) {
      closeCustomNotificationWindow(oldest.id);
    }
  }

  const workArea = screen.getPrimaryDisplay().workArea;
  // 旧 Math.random().toString(36).substring(7) 短尾时可产生空/短 id——resize
  // IPC find 错卡（A 的尺寸设到 B 上）。UUID 杜绝碰撞。
  const id = require("node:crypto").randomUUID();

  const title = message.title || "Gotify 消息";
  const subtitle = message.appname || `应用 #${message.appid || 0}`;
  const body = formatNotificationBody(message.message);

  const verificationCode = extractVerificationCode(title, message.message);
  const soundDataUri = config.playSound ? readSoundDataUri(config.notificationSound) : "";
  const urls = extractMessageUrls(message);
  const face = resolveCardFace(config, faceOverride);
  // 磨砂底=accent 路线（玻璃即面色,CSS 无底）；关=transparent 裸透（CSS 面色）
  const wantsAcrylic = acrylicOverride !== false && config?.cardAcrylic !== false && process.platform === "win32";

  const html = buildCustomNotificationHtml({ title, subtitle, body, id, verificationCode, appid: message.appid, soundDataUri, urls, face });

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
    // 三轮终判（accent-probe 实证）：磨砂底=主窗同款路线——非 transparent
    // + backgroundMaterial:acrylic + CSS 面色（44 已修客户区材质，主窗即活
    // 证；accent 对 Electron 透明窗 hr=0 但不渲染，纯 transparent 死路）。
    // 裸透（磨砂底关）= transparent。
    ...(wantsAcrylic ? { backgroundMaterial: "acrylic" } : { transparent: true }),
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
    timer: null,
    shown: false
  };

    // 首露面=终态（三轮定稿）：高度真相单源=渲染端 DOM。快路径=渲染端 250ms
  // 自报；兜底路径=320ms 仍未露面时主进程**主动拉取**（executeJavaScript 量
  // scrollHeight）→resize→重排→露。旧兜底按 96 常量假高直接揭幕，被真实
  // 上报追上时可见「上移+露底」——兜底用谎言值是非单一真相的残留。
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 系统圆角（成则卡恢复 8px 圆角与 DWM luminosity 边吻合）
  applySystemRoundedCorners(notificationWindow);
  notificationWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  notificationWindow.once("ready-to-show", () => {
    setTimeout(async () => {
      if (notificationData.shown || notificationWindow.isDestroyed()) {
        return;
      }
      try {
        const measured = Number(await notificationWindow.webContents.executeJavaScript("Math.ceil(document.body.scrollHeight)"));
        notificationData.height = Math.max(64, Math.min(190, measured || 96));
        notificationWindow.setContentSize(NOTIFICATION_WIDTH, notificationData.height);
      } catch {}
      repositionNotifications();
      revealNotification(notificationData);
    }, 320);
  });

  activeNotifications.push(notificationData);
  // 入栈即重排：既有卡已是动态高度，固定常量估的初始 y 会被立即纠正
  repositionNotifications();
}

// 二轮 M4 优雅圆角：DWMWA_WINDOW_CORNER_PREFERENCE(33)=DWMWCP_ROUND(2) 给
// frameless+transparent 窗系统圆角（Win11 自动圆角不覆盖此类窗，electron.md E2）。
// koffi(FFI, N-API) 从 dwmapi.dll 直调；加载失败静默回退方角（无 crash 面）。
// 生产 asar 需 --unpack-dir node_modules/koffi（.node 不能从 asar 内加载）。
let dwmApi = null;
function loadDwmApi() {
  if (dwmApi !== null) {
    return dwmApi;
  }
  if (process.platform !== "win32") {
    return (dwmApi = false);
  }
  try {
    const koffi = require("koffi");
    const dwm = koffi.load("dwmapi.dll");
    const MARGINS = koffi.struct("MARGINS", {
      cxLeftWidth: "int32",
      cxRightWidth: "int32",
      cyTopHeight: "int32",
      cyBottomHeight: "int32"
    });
    dwmApi = {
      setAttr: dwm.func("long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attr, void* pv, uint32_t cb)"),
      extend: dwm.func("long __stdcall DwmExtendFrameIntoClientArea(intptr_t hwnd, MARGINS *margins)"),
      MARGINS
    };
  } catch (error) {
    console.error("[Notify] koffi/dwmapi 不可用，弹卡回退方角:", error?.message || error);
    dwmApi = false;
  }
  return dwmApi;
}

function windowHwnd(window) {
  const handle = window.getNativeWindowHandle();
  return process.arch === "x64" ? handle.readBigInt64LE(0) : BigInt(handle.readInt32LE(0));
}

function applySystemRoundedCorners(window) {
  const api = loadDwmApi();
  if (!api || !window || window.isDestroyed()) {
    return;
  }
  try {
    const preference = Buffer.alloc(4);
    preference.writeInt32LE(2, 0); // DWMWCP_ROUND（系统 8px）
    const hr = api.setAttr(windowHwnd(window), 33, preference, 4);
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
  // 弹卡 URL 按钮：开系统默认浏览器（只放行 http/https，与列表按钮同规则）
  ipcMain.on("custom-notification-open-url", (_, url) => {
    if (/^https?:\/\//i.test(String(url || ""))) {
      shell.openExternal(String(url));
    }
  });
  // 三轮定稿:单报流水——渲染端 250ms 唯一一次上报(度量终值),主进程
  // 一次 resize → 重排(y 就位)→ 露面。顺序铁律不变。
  ipcMain.on("custom-notification-resize", (_, { id, height } = {}) => {
    const notification = activeNotifications.find((n) => n.id === id);
    if (notification?.window && !notification.window.isDestroyed()) {
      try {
        const clamped = Math.max(64, Math.min(190, Number(height) || 96));
        notification.height = clamped;
        notification.window.setContentSize(NOTIFICATION_WIDTH, clamped);
        repositionNotifications();
        revealNotification(notification);
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

// 工坊测试弹卡：按草稿面色直弹（不走 notify 分流——不归档、不受屏蔽，
// 面色 override 未保存也生效），真实 config 管时长/声音
function testNotification(faceOverride, acrylicOverride) {
  showCustomNotification(
    {
      id: `test-${Date.now()}`,
      title: "测试弹卡",
      message: "主题工坊参数预览：面色与磨砂底都按当前草稿生效（未保存也行）。\n第二行——顺便预览多行正文裁剪。",
      appid: 0,
      appname: "主题工坊"
    },
    getConfig(),
    faceOverride,
    acrylicOverride
  );
}

module.exports = {
  APP_USER_MODEL_ID,
  initNotifier,
  notify,
  extractVerificationCode,
  testNotification,
  closeAllNotifications: () => closeCustomNotificationWindow(),
  flushArchivalToasts,
  reconcileArchivalToasts
};
