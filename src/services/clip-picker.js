// C6 拾取器（客户端半收官，v1.1.1 发版前最后一块）：热键弹列表窗 + 托盘速取子菜单 +
// 可配置热键（按录改键 + 试注册冲突检测）。
//
// 形态（2026-09-05 用户拍板「推荐+可配置全选」）：
//   - 全局热键默认 Control+Alt+V（避开 Win+V=系统剪贴板历史独占、Ctrl+Shift+V=系统纯文本
//     粘贴两个系统位）；设置里按录改键，保存时**试注册**验冲突——Electron 无枚举系统热键
//     API（VS Code 同款限制），试注册是标准路径：被占=当场红字，比枚举更准。
//   - 热键弹独立小窗：20 条 + ↑↓ 选 + Enter 取 + 输入即过滤；失焦/Esc 关。
//   - 托盘「最近复制」子菜单：历史缓存前 6 条速取（缓存由 getHistory 拉取喂）+「打开历史列表」。
//   - 重放走 sync.replayHistoryEntry（既有：写回剪贴板→清内容门→tick 链重新上位→全设备生效，
//     §10 C6 契约「广播式重新复制」）。
//
// 装配同 initClipboardSync 惯例（接线事实不散进 main）：main 只传生命周期挂点。
// globalShortcut 面 gotify_pc 独占（接入前 grep 过零用途），unregisterAll 安全。

"use strict";

const path = require("path");

// 默认热键：冷位（见头注系统位避让）。
const DEFAULT_PICKER_HOTKEY = "Control+Alt+V";
// 托盘速取条数（全量 20 在热键窗）。
const TRAY_QUICK_COUNT = 6;

function initClipPicker({ electron, sync, getConfig, onMenuRefresh }) {
  const { globalShortcut, BrowserWindow, ipcMain } = electron;
  let pickerWin = null;

  // ── 热键注册（config 变化/启动时重挂；同步未启用不占键）──

  function hotkeyOf() {
    const custom = String(getConfig()?.clipboardSync?.pickerHotkey || "").trim();
    return custom || DEFAULT_PICKER_HOTKEY;
  }

  function syncActive() {
    const cfg = getConfig();
    return Boolean(cfg?.clipboardSync?.enabled && !cfg?.clipboardSync?.paused && cfg?.serverUrl && cfg?.clientToken);
  }

  function registerHotkey() {
    globalShortcut.unregisterAll(); // 本面独占（头注），干净重挂
    if (!syncActive()) {
      return;
    }
    try {
      const ok = globalShortcut.register(hotkeyOf(), openPicker);
      if (!ok) {
        // 被其他程序占用：不炸（设置段试注册时有红字提示路径），托盘入口仍在
        sync.rateLimitedBalloon?.("hotkey", "剪贴板拾取器", `热键 ${hotkeyOf()} 注册失败（可能被其他程序占用），可在设置中更换`);
      }
    } catch {}
  }

  // ── 拾取器窗（按需创建/复用；失焦即关——剪贴板工具惯例）──
  // 弹出定位（用户要求「Win+V 同款」+裁定**永远跟光标不记位**）：鼠标光标处弹（Electron
  // 拿不到全局插入点 caret，光标近似=微软同路）+屏幕边界 clamp；顶栏可拖（当次挪开用，
  // 下次仍跟光标——不落盘）。
  function placePicker(win) {
    const [w, h] = win.getSize();
    const cur = electron.screen.getCursorScreenPoint();
    const display = electron.screen.getDisplayNearestPoint(cur);
    const area = display.workArea; // 任务栏安全区
    let x = cur.x - Math.round(w / 2); // 光标居窗中（Win+V 观感），下方略偏
    let y = cur.y + 20;
    x = Math.min(Math.max(x, area.x), area.x + area.width - w);
    y = Math.min(Math.max(y, area.y), area.y + area.height - h);
    win.setPosition(x, y, false);
  }

  function openPicker() {
    if (pickerWin) {
      pickerWin.show();
      pickerWin.focus();
      return;
    }
    pickerWin = new BrowserWindow({
      width: 460,
      height: 480,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 主题/材质=app 单一真相：不设 backgroundColor（窗口底交给 DWM，同主窗配方），
      // 构造后 setBackgroundMaterial(同 config.windowMaterial 单源)；picker.html body
      // transparent + CSS 变量族（assets/tailwind.css）+ html.dark 跟 nativeTheme。
      webPreferences: {
        preload: path.join(__dirname, "..", "..", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    if (process.platform === "win32") {
      try {
        pickerWin.setBackgroundMaterial(getConfig()?.windowMaterial === "acrylic" ? "acrylic" : "mica");
      } catch {}
    }
    pickerWin.loadFile(path.join(__dirname, "..", "..", "picker.html"));
    pickerWin.once("ready-to-show", () => {
      placePicker(pickerWin);
      pickerWin.show();
      pickerWin.focus();
    });
    pickerWin.on("blur", () => closePicker());
    pickerWin.on("closed", () => {
      pickerWin = null;
    });
  }

  function closePicker() {
    pickerWin?.close();
    pickerWin = null;
  }

  // ── IPC：热键试注册（冲突检测）+ 保存 + 拾取器关闭 ──

  // 录制期开关（修「录制被自身全局键拦截」：录制时当前生效键被 OS 层 globalShortcut 吞掉、
  // 渲染进程收不到 keydown——进入录制即注销，录完（成功/取消/组件卸载）重挂）。
  ipcMain.handle("picker:beginRecording", () => {
    globalShortcut.unregisterAll();
    return { ok: true };
  });
  ipcMain.handle("picker:endRecording", () => {
    registerHotkey();
    return { ok: true };
  });

  // 试注册：立刻试一次、验完即还原（真实注册只发生在 registerHotkey 的正式路径）。
  // 判定：ok=false + reason=occupied=组合被系统里其他程序占用；invalid=Electron 不认。
  // 注：录制期全局键已注销，按当前生效键也能完整捕获（=保留现键的录制路径）。
  ipcMain.handle("picker:tryAccelerator", (_ev, accelerator) => {
    const acc = String(accelerator || "").trim();
    if (!acc) {
      return { ok: false, reason: "empty" };
    }
    if (acc === hotkeyOf()) {
      return { ok: true }; // 当前生效键自身=无冲突
    }
    try {
      const got = globalShortcut.register(acc, () => {});
      if (!got) {
        return { ok: false, reason: "occupied" };
      }
      globalShortcut.unregister(acc);
      return { ok: true };
    } catch {
      return { ok: false, reason: "invalid" };
    }
  });

  // 保存热键：先试注册（冲突拒落盘），成功后落 config + 正式重挂。
  // saveConfig 由 main 注入（config-store 单一保存链）。
  ipcMain.handle("picker:setHotkey", async (_ev, accelerator) => {
    const acc = String(accelerator || "").trim() || DEFAULT_PICKER_HOTKEY;
    const config = getConfig();
    config.clipboardSync = { ...config.clipboardSync, pickerHotkey: acc };
    // 保存链走 main applyConfigChange（source=ui：paused 由盘上现值保——与 UI 保存路径同语义）
    await electron.saveConfigForPicker(config);
    registerHotkey();
    return { ok: true, hotkey: hotkeyOf() };
  });

  // 恢复默认热键。
  ipcMain.handle("picker:resetHotkey", async () => {
    const config = getConfig();
    config.clipboardSync = { ...config.clipboardSync, pickerHotkey: "" };
    await electron.saveConfigForPicker(config);
    registerHotkey();
    return { ok: true, hotkey: hotkeyOf() };
  });

  // 拾取器窗内「取这条并关闭」：重放走既有 replayHistoryEntry（写回+重新上位）。
  ipcMain.handle("picker:replay", async (_ev, entry) => {
    closePicker();
    return sync.replayHistoryEntry(entry);
  });

  // ── 托盘速取子菜单（读 sync.historyCache——getHistory 拉取时喂；空=只显示打开入口）──

  function traySubmenu() {
    if (!syncActive()) {
      return [];
    }
    const items = [];
    const cache = Array.isArray(sync.historyCache) ? sync.historyCache : [];
    for (const entry of cache.slice(0, TRAY_QUICK_COUNT)) {
      const summary = summarizeEntry(entry);
      if (!summary) {
        continue;
      }
      items.push({
        label: summary,
        click: () => {
          sync.replayHistoryEntry(entry).catch(() => {});
        }
      });
    }
    items.push({ label: "打开历史列表（热键）", click: () => openPicker() });
    return items;
  }

  return { registerHotkey, openPicker, traySubmenu, DEFAULT_PICKER_HOTKEY };
}

// 条目摘要（托盘 label 单行）：文本前 40 字 / 文件·图片数·组摘要。与 clip-history-panel
// 的展示语义一致（复用维度分类），此处为菜单单行形态。
function summarizeEntry(entry) {
  const items = Array.isArray(entry?.slot?.items) ? entry.slot.items : [];
  if (items.length === 0) {
    return "";
  }
  const texts = items.filter((it) => it?.kind === "text").map((it) => String(it.text || ""));
  const files = items.filter((it) => it?.kind === "file");
  const images = items.filter((it) => it?.kind === "image");
  if (files.length + images.length === 0) {
    const joined = texts.join(" ").replace(/\s+/g, " ").trim();
    return joined ? joined.slice(0, 40) + (joined.length > 40 ? "…" : "") : "";
  }
  if (images.length === 1 && files.length === 0) {
    return `🖼 图片（${new Date(entry.slot.ts).toLocaleString()}）`;
  }
  if (files.length === 1 && files[0]?.name) {
    return `📄 ${String(files[0].name).slice(0, 36)}`;
  }
  return `📦 ${images.length + files.length} 个文件`;
}

module.exports = { initClipPicker, DEFAULT_PICKER_HOTKEY };
