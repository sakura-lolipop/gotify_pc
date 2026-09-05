const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  serverUrl: "",
  clientToken: "",
  showCustomNotification: true,
  playSound: true,
  notificationSound: "huawei/Dew.ogg",
  notificationAutoHide: true,
  notificationNeverClose: false,
  notificationDuration: 5000,
  archiveExpiryMinutes: 60,
  codeSmartExpiry: true,
  // 验证码静默自动复制（用户拍板：无任何提示）：消息到达即写剪贴板
  autoCopyVerificationCode: true,
  theme: "system",
  // 主窗 DWM 材质：mica=壁纸静态采样（默认，省电）/ acrylic=实时磨砂桌面内容
  windowMaterial: "mica",
  // 设置弹窗玻璃自定义（用户拍板「全自定义+拉杆即时预览」）：浅/深各一套。
  // 默认=2026-09-02 定稿值（浅 A 版 0.35/12px/冷白，深 0.55/24px/原深蓝）。
  glass: {
    light: { alpha: 0.35, blur: 12, tint: "#f4f8ff" },
    dark: { alpha: 0.55, blur: 24, tint: "#101c2c" }
  },
  // 右下通知弹卡面色（工坊第五块）：文字色按底色亮度自动选深/浅族，
  // hover 由 alpha+0.1 派生。默认=CP7 调参真值。
  cardGlass: {
    light: { alpha: 0.5, tint: "#ffffff" },
    dark: { alpha: 0.6, tint: "#101c2c" }
  },
  // 弹卡窗底材质：true=Acrylic 磨砂 / false=transparent 裸透（清晰透传桌面，
  // 圆角降级为 CSS 卡角+透明方块）
  cardAcrylic: true,
  // 主题工坊（用户拍板「全 UI 分块自定义颜色+透明度」）：浅/深各一套。
  // 背景层单一映射（tailwind.css 顶部表同源）：bg=窗口底（根容器，默认 α0
  // 直透 Mica=现状）、list=列表底（--layer，默认=CP6 现值）、input=输入底。
  // card 系不进工坊（弹窗内部专用，非主窗背景层——错配源头已裁）。
  themeCustom: {
    light: { bg: { tint: "#f6fbff", alpha: 0 }, list: { tint: "#ffffff", alpha: 0.75 }, input: { tint: "#ffffff", alpha: 1 } },
    dark: { bg: { tint: "#07111f", alpha: 0 }, list: { tint: "#ffffff", alpha: 0.045 }, input: { tint: "#0f1826", alpha: 1 } }
  },
  minimizeToTray: true,
  showMainWindowOnStartup: true,
  autoLaunch: false,
  enableReconnect: true,
  autoRefreshInterval: 10000,
  barkServerUrl: "",
  barkForwardApps: [], // Array of app IDs to forward, empty means none (or all? let's make it explicit selection)
  mutedNotificationApps: [], // Array of app IDs to mute popup notifications
  // 跨设备剪贴板同步（docs/clipboard.md §7，CP-C2）：主开关默认关（侵入性功能）。
  // 四上限以 MB/个为单位存（UI 自然单位）；接收目录空=默认 Downloads\HotifyClipboard。
  // 图片/文件档与 imagePromotion/receiveDir 由 C3/C4 消费（设置先行落地）。
  clipboardSync: {
    enabled: false,
    paused: false, // 托盘暂停（持久——重启不静默恢复）
    types: { text: true, image: true, file: true }, // PC 三档全开（§7 2026-09-05 钉）
    imagePromotion: true, // 单个图片文件升格为图片同步（学 SyncClipboard）
    maxItemMB: 50,
    maxGroupMB: 100,
    maxItems: 32,
    maxTextKB: 1024, // KB 单位（2026-09-05 用户真机验收：MB 粒度下只能设 1=没得调；
    // server JSON 腿硬顶 1MB，KB 才能在顶内自选。旧键 maxTextMB 忽略（无实际存量）
    receiveDir: ""
  }
};

// glass/themeCustom 的「浅/深 → 块」两层合并:存量块逐个补默认,缺的键
// (如键改名后的新键)由默认补齐,存量的未知旧键保留不丢
function mergeModeSections(defaults, saved) {
  const out = { ...defaults };
  if (!saved || typeof saved !== "object") {
    return out;
  }
  for (const mode of Object.keys(defaults)) {
    out[mode] = { ...defaults[mode], ...(saved[mode] && typeof saved[mode] === "object" ? saved[mode] : {}) };
  }
  return out;
}

// clipboardSync 两层合并（顶层键 + types 子对象逐键补默认）：渲染层草稿或旧
// 存量缺新键时由默认补齐（未来 C3/C4 加键不破老配置）
function mergeClipboardSync(defaults, saved) {
  const out = { ...defaults, ...(saved && typeof saved === "object" ? saved : {}) };
  out.types = { ...defaults.types, ...(saved?.types && typeof saved.types === "object" ? saved.types : {}) };
  return out;
}

class ConfigStore {
  constructor(userDataPath) {
    this.configPath = path.join(userDataPath, "config.json");
    this.config = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.configPath)) {
        return { ...DEFAULT_CONFIG };
      }
      const raw = fs.readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(raw);
      const merged = { ...DEFAULT_CONFIG, ...parsed };
      // 嵌套配置逐层合并:顶层浅合并会让存量的旧结构整体覆盖新默认(工坊
      // card→list 键改名时 section.list=undefined 崩过启动);两层结构
      // (glass/themeCustom 的浅/深→块)按层补齐,多余旧键残留无害
      for (const key of ["glass", "themeCustom", "cardGlass"]) {
        merged[key] = mergeModeSections(DEFAULT_CONFIG[key], parsed?.[key]);
      }
      merged.clipboardSync = mergeClipboardSync(DEFAULT_CONFIG.clipboardSync, parsed?.clipboardSync);
      return merged;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  get() {
    return { ...this.config };
  }

  save(nextConfig) {
    this.config = { ...DEFAULT_CONFIG, ...nextConfig };
    this.config.clipboardSync = mergeClipboardSync(DEFAULT_CONFIG.clipboardSync, nextConfig?.clipboardSync);
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
    return this.get();
  }
}

module.exports = {
  ConfigStore,
  DEFAULT_CONFIG
};
