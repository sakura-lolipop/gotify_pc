// 跨设备剪贴板同步（CP-C2 文本腿 + CP-C3 图片腿 + CP-C4 文件腿，docs/clipboard.md §5 权威契约）。
// LWW 单槽寄存器：本地复制=写意图（事件驱动），远端更新=读侧落地（带脏守卫）。
// 回环四件套：①落地置 suppress 100ms ②lastSyncHash 回声丢 ③上传前比对 ④本机脏不落地。
// 图片读写全走 Electron 44 新 API（read/ClipboardItem/write——2026-09-05 探针定案路 A，
// round-trip PNG 逐字节保真+写后四格式自动补齐，koffi DIB 管线路 B 弃）；文件读写走 koffi
// CF_HDROP（44 已砍 writeFiles）；剪切判定=koffi 读 Preferred DropEffect 位与（TOP1）。
// 主进程隔离：环路任何异常=记日志+停同步+托盘标灰（emit fatal），不碰主进程（E1 纪律）。
const EventEmitter = require("node:events");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

// ── hash 公式（clipboard.md §3.2，四端契约；测试向量钉 test/clipboard-sync.test.js）──

// itemHash(text) = sha256(utf8 bytes)
function textItemHash(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

// itemHash(image|file) = sha256(utf8(name + "|") + rawBytes)——对齐 server 端
// ClipFileHashPrefix（流式前缀喂 hash writer 的客户端镜像；name 进前缀故两端 name 必须一致）。
function binaryItemHash(name, bytes) {
  const h = crypto.createHash("sha256");
  h.update(String(name || "") + "|", "utf8");
  h.update(bytes);
  return h.digest("hex");
}

// groupHash = sha256(join("\n", sorted(itemHash hex)))。拷贝排序防改入参（对齐 server 端）。
function groupHashOf(itemHashes) {
  const sorted = [...itemHashes].sort();
  return crypto.createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

// ── 回环判定（纯函数，host-side 单测锚）──

// 远端槽落地决策：noop=已等值｜adopt=写入本机｜cache=本机脏只进缓存不碰剪贴板（§5 ④）。
// localGroup=本机当前组 groupHash（文本/图片/文件统一口径；空板=""）。
// localEmpty 含启动对齐特例（lastSyncHash 空时本地非空=脏=不采纳——冷启动病防线）。
// contentBaseline=最近同步动作（上传/落地）写进板的内容指纹：localGroup 等于它=板上是
// 同步写入值而非本地编辑=干净（对抗审 P1-1：升格图名不对称/同名(1) 改名形态下
// localGroup 永远≠lastSyncHash，单看 lastSyncHash=粘性脏，远端更新全静默丢）。
function decideRemoteApply({ localGroup, localEmpty, lastSyncHash, slotGroupHash, contentBaseline }) {
  if (localGroup !== "" && localGroup === slotGroupHash) {
    return "noop"; // 内容已等值（重连 ack / 他端 no-op 广播）
  }
  if (localEmpty) {
    return "adopt"; // 本机空：无损失，采纳（含启动对齐）
  }
  if (lastSyncHash !== "" && localGroup === lastSyncHash) {
    return "adopt"; // 本机干净（上次同步点后没动过）：远端新值上位
  }
  if (contentBaseline !== "" && localGroup === contentBaseline) {
    return "adopt"; // 板=最近同步写入值（图/文件写读不对称形态）：非本地编辑，远端新值上位
  }
  return "cache"; // 本机脏（本地动过/启动存量）：只进缓存
}

// 上传决策：与已知远端 groupHash 相同即跳过（②回声丢与③上传前比对是同一谓词，
// lastSyncHash 同时承担两个角色；server 同 groupHash no-op 是兜底非第一道闸）。
function decideLocalUpload({ groupHash, lastSyncHash }) {
  return groupHash !== lastSyncHash;
}

// 组内容分派（接收端）：客户端上传只发单类型组（本机板一次只有一种主导格式，
// 探测优先级 Files>Image>Text），混合组=他端未来版本/恶意构造——按主导 kind 降级处理。
function classifySlotItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { kind: "empty" };
  }
  if (items.every((it) => it?.kind === "text")) {
    return { kind: "text", textItem: items[0] }; // 全 text=文本组（多条取首条，上传端只发单条）
  }
  if (items.length === 1 && items[0]?.kind === "image") {
    return { kind: "image", imageItem: items[0] };
  }
  const hasFile = items.some((it) => it?.kind === "file");
  if (hasFile) {
    const files = items.filter((it) => it?.kind === "file");
    return { kind: "files", fileItems: files }; // 混合组的 file 部分（text 忽略，钉死不猜语义）
  }
  if (items.length === 1 && items[0]?.kind === "image") {
    return { kind: "image", imageItem: items[0] };
  }
  return { kind: "unknown" };
}

// 单文件升格判定（§7「单个图片文件升格为图片同步」默认开）：单文件+图片扩展名。
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".tif"]);
function isImagePath(p) {
  return IMAGE_EXTS.has(path.extname(String(p || "")).toLowerCase());
}

// 接收目录落盘路径：同名冲突加 " (1)" 递增不覆盖（§5 文件接收）。
function resolveCollision(dir, name) {
  const base = path.basename(String(name || "file"));
  let target = path.join(dir, base);
  if (!fs.existsSync(target)) {
    return target;
  }
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 1; i < 10000; i++) {
    target = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(target)) {
      return target;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

// ── Windows 原生探测与读写（koffi；加载失败静默降级 Electron 路径，无 crash 面）──
// GetClipboardSequenceNumber：500ms tick 变化才读内容（大图 decode 抖动防线）。
// IsClipboardFormatAvailable：零拷贝探格式（Files>Image>Text 优先级 + 本地空判定）。
// CF_HDROP 读写/Preferred DropEffect：Electron 44 已砍 writeFiles/readFiles，文件面全 koffi。
const CF_UNICODETEXT = 13;
const CF_BITMAP = 2;
const CF_DIB = 8;
const CF_DIBV5 = 17;
const CF_HDROP = 15;
const GMEM_MOVEABLE = 0x0002;

let user32Api = null;
let koffiMod = null; // loadUser32 时赋值——readHGlobal/hGlobalFromBytes 的 encode/decode 用
function loadUser32() {
  if (user32Api !== null) {
    return user32Api;
  }
  if (process.platform !== "win32") {
    return (user32Api = false);
  }
  try {
    const koffi = require("koffi");
    koffiMod = koffi;
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    user32Api = {
      seq: user32.func("uint32 __stdcall GetClipboardSequenceNumber()"),
      hasFormat: user32.func("int __stdcall IsClipboardFormatAvailable(uint32 format)"),
      // ExcludeForSync 兜底路：RegisterClipboardFormatW 同名=系统级同 id（单例语义），
      // 注册即拿 id 再查可用性——比枚举全格式表更稳（Electron 44 已砍 availableFormats）。
      registerFormat: user32.func("uint32 __stdcall RegisterClipboardFormatW(str16 name)"),
      open: user32.func("int __stdcall OpenClipboard(intptr_t hwnd)"),
      close: user32.func("int __stdcall CloseClipboard()"),
      empty: user32.func("int __stdcall EmptyClipboard()"),
      getData: user32.func("intptr_t __stdcall GetClipboardData(uint32 format)"),
      setData: user32.func("int __stdcall SetClipboardData(uint32 format, intptr_t data)"),
      globalAlloc: kernel32.func("intptr_t __stdcall GlobalAlloc(uint32 flags, uintptr_t bytes)"),
      globalLock: kernel32.func("intptr_t __stdcall GlobalLock(intptr_t h)"),
      globalUnlock: kernel32.func("int __stdcall GlobalUnlock(intptr_t h)"),
      globalSize: kernel32.func("uintptr_t __stdcall GlobalSize(intptr_t h)")
    };
  } catch (error) {
    console.error("[ClipSync] koffi/user32 不可用，回退内容比对探测:", error?.message || error);
    user32Api = false;
  }
  return user32Api;
}

// koffi 读整块 HGLOBAL → Buffer（uint8 decode——E14 探针工法钉死形态：不用 "uint16 *" 错位路）。
function readHGlobal(api, h) {
  const ptr = api.globalLock(h);
  if (!ptr || !koffiMod) {
    return null;
  }
  try {
    const size = Number(api.globalSize(h));
    return Buffer.from(koffiMod.decode(ptr, koffiMod.array("uint8", size)));
  } finally {
    api.globalUnlock(h);
  }
}

// Buffer → HGLOBAL（GMEM_MOVEABLE；SetClipboardData 接管所有权，勿 GlobalFree）。
function hGlobalFromBytes(api, bytes) {
  const h = api.globalAlloc(GMEM_MOVEABLE, bytes.length);
  if (!h || !koffiMod) {
    return 0;
  }
  const ptr = api.globalLock(h);
  koffiMod.encode(ptr, koffiMod.array("uint8", bytes.length), Array.from(bytes));
  api.globalUnlock(h);
  return h;
}

// 密码管理器排除标记（§5）：koffi 单路，三格式族任一在板即排除（2026-09-05 C3 探针一次验三）。
// 格式名自 SyncClipboard ClipboardFactory.cs 抄（E14-3 教训：外部常量名对权威源码抄，
// ForMonitorProcessing 初版凭记忆写错名=探针假绿）。
// ExcludeClipboardContentForMonitorProcessing：密码管理器对监听处理的 opt-out（主标记）。
// CanIncludeInClipboardHistory=0 / CanUploadToCloudClipboard=0：密码管理器对 Win10+ 历史/云
// 剪贴板的 opt-out 顺带覆盖（DWORD 语义是「值=0 才排除」，但存在性检查保守判=同向误报可接受）。
function excludedMarkerNative() {
  const api = loadUser32();
  if (!api) {
    return false;
  }
  try {
    for (const name of [
      "ExcludeClipboardContentForMonitorProcessing",
      "CanIncludeInClipboardHistory",
      "CanUploadToCloudClipboard"
    ]) {
      const fmt = api.registerFormat(name);
      if (fmt !== 0 && api.hasFormat(fmt) !== 0) {
        return true;
      }
    }
  } catch {}
  return false;
}

// CF_HDROP 读：DROPFILES{20B,pFiles 偏移+fWide}+双 NUL 终结宽串路径列表。
// 格式在但列表空=null（延迟渲染未兑现态——不消费基线，下轮重读，TOP2 读路径三件套①）。
function readHdropNative(api) {
  if (!api.open(0)) {
    return undefined; // 锁冲突=瞬态
  }
  try {
    const h = api.getData(CF_HDROP);
    if (!h) {
      return null;
    }
    const buf = readHGlobal(api, h);
    if (!buf || buf.length < 20) {
      return null;
    }
    const pFiles = buf.readUInt32LE(0);
    const fWide = buf.readUInt32LE(16) !== 0;
    if (pFiles > buf.length) {
      return null;
    }
    const list = buf.subarray(pFiles);
    const s = fWide ? list.toString("utf16le") : list.toString("latin1");
    const paths = s.split("\0").filter((p) => p !== "");
    return paths.length > 0 ? paths : null;
  } finally {
    api.close();
  }
}

// CF_HDROP 写（接收端落地）：EmptyClipboard+HDROP+Preferred DropEffect=Copy(1)。
// DropEffect 写 Copy 明确语义（源文件留原机），防下游按 Move 误判剪切删源。
function writeHdropNative(api, paths) {
  const parts = paths.map((p) => Buffer.from(String(p) + "\0", "utf16le"));
  const hdr = Buffer.alloc(20);
  hdr.writeUInt32LE(20, 0); // pFiles=结构体大小=文件列表偏移
  hdr.writeUInt32LE(1, 16); // fWide=TRUE
  const payload = Buffer.concat([hdr, ...parts, Buffer.from("\0", "utf16le")]);
  const effect = Buffer.alloc(4);
  effect.writeUInt32LE(1, 0); // DROPEFFECT_COPY
  if (!api.open(0)) {
    return false;
  }
  try {
    api.empty();
    const okDrop = api.setData(CF_HDROP, hGlobalFromBytes(api, payload)) !== 0;
    let okEffect = true;
    const fmt = api.registerFormat("Preferred DropEffect");
    if (fmt !== 0) {
      okEffect = api.setData(fmt, hGlobalFromBytes(api, effect)) !== 0;
    }
    return okDrop && okEffect;
  } finally {
    api.close();
  }
}

// Preferred DropEffect 读：4 字节 DWORD，(v & 2) != 0 = Move=剪切不上传（§5.1 TOP1；
// 位与判定对齐 SyncClipboard UploadService.cs:232 `(Effects & Move) == Move`——explorer
// 剪切真值可能写 2(Move) 或 3(Copy|Move) 兼容形态，位与通吃）。格式缺席=null=非剪切
//（PS Set-Clipboard -Path 不写该格式——探针实证；缺席≠剪切）。
function dropEffectIsMoveNative(api) {
  if (!api.open(0)) {
    return false;
  }
  try {
    const fmt = api.registerFormat("Preferred DropEffect");
    if (fmt === 0) {
      return false;
    }
    const h = api.getData(fmt);
    if (!h) {
      return false;
    }
    const buf = readHGlobal(api, h);
    return Boolean(buf && buf.length >= 1 && (buf.readUInt32LE(0) & 2) !== 0);
  } finally {
    api.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 同步主体 ──

class ClipboardSync extends EventEmitter {
  // deps：getConfig() 返全量 config；sendFrame(obj) 发 WS 控制帧（clip_sub/unsub）；
  // balloon(title, body) 托盘气泡（超限提示，每类限频）；saveConfig(next) 配置落盘
  // 单入口（托盘暂停切换用，经 main 的 applyConfigChange 走同一应用链）；
  // openReceiveDir() 托盘「打开接收文件夹」（shell.openPath——main 注入）；
  // defaultReceiveDir 接收目录默认值（app.getPath("downloads")/HotifyClipboard——main 注入）。
  constructor({ getConfig, sendFrame, balloon, saveConfig, openReceiveDir, defaultReceiveDir }) {
    super();
    this.getConfig = getConfig;
    this.sendFrame = sendFrame || (() => false);
    this.balloon = balloon || (() => {});
    this.saveConfig = saveConfig || (() => {});
    this.openReceiveDir = openReceiveDir || (() => {});
    this.defaultReceiveDir = defaultReceiveDir || "";
    this.timer = null;
    this.lastSeq = null; // sequence 基线（start 时采，启动存量不算事件）
    this.lastProbedText = ""; // 无 koffi 时的内容比对回退
    this.lastSyncHash = ""; // 已同步远端 groupHash（②③共用；每启动重置——不持久化）
    this.lastServerTs = 0; // 已知最新槽的 server 时间戳（乱序旧帧丢弃）
    this.historyCache = []; // 历史环缓存（fetchHistory 拉取时喂；托盘速取子菜单数据源——C6 拾取器）
    this.historyCacheAt = 0; // 缓存龄（ms；getHistory stale-while-revalidate 判据）
    this.suppressUntil = 0; // ①落地抑制窗（吸收系统写入延迟）
    this.uploadAbort = null; // 超车：队列深度=1，新复制掐断在途
    this.fatalMessage = null;
    this.balloonLastAt = new Map(); // 超限提示限频（每类）
    this.textBaselineReady = false; // 无 koffi 形态的内容基线就绪门（启动防误传）
    this.clipboard = null; // electron clipboard 延迟注入（main 侧 setElectronClipboard）
    this.ClipboardItemCtor = null; // electron.ClipboardItem 延迟注入（同上）
    this.nativeImage = null; // electron nativeImage 延迟注入（非 png 字节转 png 写板）
    this.cachedLocalGroup = { seq: -1, group: "" }; // 本机组 hash 缓存（脏判定读全字节，seq 门控）
    this.contentBaseline = ""; // 本机内容基线（图/文件腿）：落地/上传认领的板上组 hash——
    // 内容未变不重传（文本腿 lastProbedText 的泛化位；双基线分离：它防「落地自翻」，
    // lastSyncHash 防「回声」——图/文件写读不对称[板上 Chromium 重编码字节≠槽外源字节]，
    // 单靠 lastSyncHash 会把刚落地内容当新变化重传翻转槽，e2e G2 抓的回归）。
    this.landedGroups = []; // 已落盘 groupHash 环（防重写文件；cap 20 对齐服务端历史环）
    this.uploadFailStreak = 0; // 网络错连击（TOP4：连续超限=熔断 fatal）
    this.clipChain = null; // 远端帧串行链（P2-4：背靠背帧保序防 LWW 破坏）
  }

  setElectronClipboard(clipboard, ClipboardItemCtor, nativeImageMod) {
    this.clipboard = clipboard;
    this.ClipboardItemCtor = ClipboardItemCtor || null;
    this.nativeImage = nativeImageMod || null;
  }

  active(config) {
    if (this.fatalMessage) {
      return false;
    }
    const cfg = (config || this.getConfig())?.clipboardSync;
    if (!cfg?.enabled || cfg.paused) {
      return false;
    }
    const full = config || this.getConfig();
    return Boolean(full.serverUrl && full.clientToken);
  }

  // 设置保存/托盘暂停切换的单一入口：开关、暂停、fatal 复位都在这里消化。
  // fatal 态下保存无关配置（active→active）不重臂——「停同步」语义只有关→开才解锁。
  onConfigChanged(previous, saved) {
    const wasActive = syncActiveOf(previous);
    const isActive = syncActiveOf(saved);
    if (!wasActive && isActive) {
      this.fatalMessage = null; // 重新启用=给重试机会
      this.lastSyncHash = "";
      this.contentBaseline = "";
      this.lastServerTs = 0;
      this.uploadFailStreak = 0;
    }
    if (this.fatalMessage) {
      return; // F2：fatal 保持停摆（托盘仍标灰），不重发 sub 不重臂 tick
    }
    if (isActive) {
      this.start();
      this.sendFrame({ type: "clip_sub" }); // 开关打开即刻 sub（连接已开时）
    } else {
      this.sendFrame({ type: "clip_unsub" });
      this.stop();
    }
  }

  start() {
    this.stop();
    const api = loadUser32();
    this.lastSeq = api ? api.seq() : null; // 基线：启动存量不触发上传（防开机推旧值）
    this.contentBaseline = ""; // 启动存量不算「已同步内容」（对齐 lastProbedText 重置）
    // 无 koffi 形态的内容基线（async readText；就绪前 tick 不走内容门——防启动存量误传）
    this.textBaselineReady = false;
    this.lastProbedText = "";
    Promise.resolve(this.clipboard?.readText?.())
      .catch(() => "")
      .then((text) => {
        this.lastProbedText = String(text || "");
        this.textBaselineReady = true;
      });
    this.timer = setInterval(() => this.safeTick(), 500);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // try 边界：环路任何异常=fatal（记日志+停同步+托盘标灰），不外溢（§5 主进程隔离）。
  // tick 是 async（Electron 44 clipboard API 已 async 化）——promise 链的异常也归 fatal。
  safeTick() {
    try {
      this.tick().catch((error) => this.fatal(`同步环路异常: ${error?.message || error}`));
    } catch (error) {
      this.fatal(`同步环路异常: ${error?.message || error}`);
    }
  }

  fatal(message) {
    console.error("[ClipSync] fatal:", message);
    this.fatalMessage = String(message);
    this.stop();
    this.emit("fatal", this.fatalMessage);
  }

  // 500ms tick：suppress 窗口不消费 sequence（窗内真实复制在窗后仍会被读到）；
  // sequence 没变=一个字节都不读。async——Electron 44 起 clipboard 读侧全 Promise。
  async tick() {
    const config = this.getConfig();
    if (!this.active(config)) {
      return;
    }
    const cfg = config.clipboardSync;
    const now = Date.now();
    if (now < this.suppressUntil) {
      return; // ①抑制窗：跳过整轮，lastSeq 不前移
    }
    const api = loadUser32();
    const seqBefore = api ? api.seq() : null; // 读前 sequence：读中变化留给下一轮（不吞竞态）
    if (seqBefore !== null && seqBefore === this.lastSeq) {
      return;
    }
    if (seqBefore === null && !this.textBaselineReady) {
      return; // 无 koffi 形态：内容基线未就绪（防启动存量误传）
    }
    if (await this.isExcluded()) {
      this.consumeProbe(seqBefore);
      return; // 密码管理器标记：不读不传
    }
    const fmt = await this.probeFormats();
    if (fmt.files && cfg.types?.file) {
      await this.handleLocalFiles(seqBefore, cfg);
      return;
    }
    if (fmt.image && cfg.types?.image) {
      await this.handleLocalImage(seqBefore, cfg);
      return;
    }
    if (fmt.files || fmt.image) {
      this.consumeProbe(seqBefore); // 图/文件在板但类型档关：消费基线（不上传不重读）
      return;
    }
    if (!fmt.text || !cfg.types?.text) {
      this.consumeProbe(seqBefore);
      return;
    }
    const text = String((await this.clipboard?.readText?.()) || "");
    if (fmt.text && text === "") {
      return; // 有文本格式却读空=瞬态锁（他进程持板）——不消费基线，下轮重读
    }
    if (text === this.lastProbedText) {
      this.consumeProbe(seqBefore, text);
      return; // 内容未变（含网络失败后同文本不重试——离线写丢失=LWW 语义）
    }
    this.consumeProbe(seqBefore, text);
    if (!text) {
      return;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    // 生效上限=min(用户设置, 1024KB)：server JSON 腿被 maxIngestBodyLen=1MB 硬顶
    //（§4「server 只做绝对护栏」的物理实现），调大设置也只按 1MB 生效不炸 413。
    // KB 单位（2026-09-05 真机验收：MB 粒度只能设 1=没得调）。
    const maxTextKB = Math.min(Number(cfg.maxTextKB) || 1024, 1024);
    const maxTextBytes = maxTextKB * 1024;
    if (bytes > maxTextBytes) {
      this.rateLimitedBalloon("text-oversize", "剪贴板同步", `文本超过 ${maxTextKB}KB 上限，本条未同步`);
      return; // 超用户上限→整组跳过+提示一次（§7）
    }
    const group = groupHashOf([textItemHash(text)]);
    if (!decideLocalUpload({ groupHash: group, lastSyncHash: this.lastSyncHash })) {
      return; // ②③回声/等值：不上传
    }
    await this.uploadText(text);
  }

  // 文件腿 tick 分支（§5 Files 最高优先级）。剪切不上传（TOP1）+文件夹混入整组跳过+
  // 单文件图片升格 image 档（§7 默认开，name=真文件名原字节——接收端写板时非 png 转 png）。
  async handleLocalFiles(seq, cfg) {
    const api = loadUser32();
    if (!api) {
      this.consumeProbe(seq);
      return;
    }
    if (dropEffectIsMoveNative(api)) {
      this.consumeProbe(seq);
      return; // 剪切（Preferred DropEffect 含 Move 位）：不上传（TOP1）
    }
    const paths = readHdropNative(api);
    if (paths === null || paths === undefined) {
      return; // 延迟渲染未兑现/锁冲突：不消费基线，下轮重读（TOP2 ①）
    }
    this.consumeProbe(seq);
    if (paths.length === 1 && cfg.imagePromotion !== false && isImagePath(paths[0])) {
      await this.uploadFileAsImage(paths[0], cfg);
      return;
    }
    await this.uploadFileGroup(paths, cfg);
  }

  // 图片腿 tick 分支：Electron 44 新 API 读 PNG 字节（路 A，2026-09-05 探针定案）。
  async handleLocalImage(seq, cfg) {
    const bytes = await this.readImagePng();
    if (!bytes) {
      return; // 图片格式在但读不出=瞬态（延迟渲染/锁）：不消费基线，下轮重读（TOP2 ①）
    }
    this.consumeProbe(seq);
    const maxItemBytes = (Number(cfg.maxItemMB) || 50) * 1024 * 1024;
    if (bytes.length > maxItemBytes) {
      this.rateLimitedBalloon("image-oversize", "剪贴板同步", `图片超过 ${cfg.maxItemMB || 50}MB 上限，本条未同步`);
      return;
    }
    const name = "clipboard.png"; // 本机截图无名字：固定名保证两端重算一致（hash 前缀契约）
    const itemHash = binaryItemHash(name, bytes);
    const group = groupHashOf([itemHash]);
    if (group === this.contentBaseline) {
      return; // 内容未变（落地后回读/同图重读）：不重传（防落地自翻，见 contentBaseline 注释）
    }
    if (!decideLocalUpload({ groupHash: group, lastSyncHash: this.lastSyncHash })) {
      return;
    }
    await this.uploadGroup(
      [{ kind: "image", hash: itemHash, name, size: bytes.length }],
      [bytes],
      group
    );
  }

  // 板上图片 → PNG 字节。types 无 image/png=瞬态返回 null（不消费基线）。
  async readImagePng() {
    try {
      const items = await this.clipboard?.read?.();
      const item = items?.[0];
      const types = Array.isArray(item?.types) ? item.types : null;
      if (!types || !types.includes("image/png")) {
        return null;
      }
      const blob = await item.getType("image/png");
      return Buffer.from(await blob.arrayBuffer());
    } catch (error) {
      console.error("[ClipSync] readImage failed:", error?.message || error);
      return null;
    }
  }

  // 上传前组预检+读字节+发 multipart（§7 四上限；文件夹混入=整组跳过）。
  async uploadFileGroup(paths, cfg) {
    const maxItems = Number(cfg.maxItems) || 32;
    const maxItemBytes = (Number(cfg.maxItemMB) || 50) * 1024 * 1024;
    const maxGroupBytes = (Number(cfg.maxGroupMB) || 100) * 1024 * 1024;
    if (paths.length > maxItems) {
      this.rateLimitedBalloon("files-count", "剪贴板同步", `超过单组 ${maxItems} 个文件上限，本组未同步`);
      return;
    }
    let total = 0;
    const metas = [];
    for (const p of paths) {
      let stat;
      try {
        stat = fs.statSync(p);
      } catch {
        return; // 文件消失/网络盘抖动：整组放弃（不消费什么——基线已推进，等下次复制）
      }
      if (stat.isDirectory()) {
        this.rateLimitedBalloon("files-folder", "剪贴板同步", "包含文件夹，本组未同步（文件夹传输暂不支持）");
        return;
      }
      if (stat.size > maxItemBytes) {
        this.rateLimitedBalloon("files-oversize", "剪贴板同步", `文件超过 ${cfg.maxItemMB || 50}MB 上限，本组未同步`);
        return;
      }
      total += stat.size;
      metas.push({ path: p, name: path.basename(p), size: stat.size });
    }
    if (total > maxGroupBytes) {
      this.rateLimitedBalloon("group-oversize", "剪贴板同步", `整组超过 ${cfg.maxGroupMB || 100}MB 上限，本组未同步`);
      return;
    }
    const buffers = [];
    const items = [];
    for (const meta of metas) {
      let bytes;
      try {
        bytes = await fs.promises.readFile(meta.path); // async（P2-3）：同步 readFileSync 大组卡主进程
      } catch {
        return; // 读失败（占用/权限）：整组放弃
      }
      buffers.push(bytes);
      items.push({ kind: "file", hash: binaryItemHash(meta.name, bytes), name: meta.name, size: bytes.length });
    }
    const group = groupHashOf(items.map((it) => it.hash));
    if (group === this.contentBaseline) {
      return; // 内容未变（落地后回读）：不重传（防落地自翻）
    }
    if (!decideLocalUpload({ groupHash: group, lastSyncHash: this.lastSyncHash })) {
      return;
    }
    await this.uploadGroup(items, buffers, group);
  }

  // 单图片文件升格 image 档（原字节原文件名——hash 前缀契约与接收端一致）。
  async uploadFileAsImage(filePath, cfg) {
    const maxItemBytes = (Number(cfg.maxItemMB) || 50) * 1024 * 1024;
    let stat;
    let bytes;
    try {
      stat = fs.statSync(filePath);
      if (stat.size > maxItemBytes) {
        this.rateLimitedBalloon("image-oversize", "剪贴板同步", `图片文件超过 ${cfg.maxItemMB || 50}MB 上限，本条未同步`);
        return;
      }
      bytes = await fs.promises.readFile(filePath); // async（P2-3）
    } catch {
      return;
    }
    const name = path.basename(filePath);
    const itemHash = binaryItemHash(name, bytes);
    const group = groupHashOf([itemHash]);
    if (group === this.contentBaseline) {
      return; // 内容未变（落地后回读）：不重传（防落地自翻）
    }
    if (!decideLocalUpload({ groupHash: group, lastSyncHash: this.lastSyncHash })) {
      return;
    }
    await this.uploadGroup([{ kind: "image", hash: itemHash, name, size: bytes.length }], [bytes], group);
  }

  // 探测后基线推进：sequence 用读前值（读中竞态变化下一轮可见）；
  // lastProbedText 是无 koffi 形态的内容基线（变更门+失败不重试）。
  consumeProbe(seq, text) {
    if (seq !== null && seq !== undefined) {
      this.lastSeq = seq;
      // 板内容已变=本机组缓存作废（group 清空，下次 localGroupHash 重算）——只推 seq
      // 不清 group 会让「seq 相等即用缓存」判定恰好吃进旧内容的组 hash（F2 误判脏的根因）
      this.cachedLocalGroup = { seq: -1, group: "" };
    }
    if (typeof text === "string") {
      this.lastProbedText = text;
    }
  }

  // 密码管理器排除标记（§5）：三格式族 koffi 单路（红探针实证 Electron has() 看不见
  // 自定义格式，该路已摘除不留双保险；非 win32=无探测能力，目标平台 koffi 必在）。
  async isExcluded() {
    return excludedMarkerNative();
  }

  // Files > Image > Text 优先级（§5）。koffi=同步多格式；缺席回退 Electron async
  //（readImage 已被 44 砍——image/files 探测降级 false，win32 目标平台必有 koffi）。
  async probeFormats() {
    const api = loadUser32();
    if (api) {
      const has = (fmt) => {
        try {
          return api.hasFormat(fmt) !== 0;
        } catch {
          return false;
        }
      };
      return {
        files: has(CF_HDROP),
        image: has(CF_BITMAP) || has(CF_DIB) || has(CF_DIBV5),
        text: has(CF_UNICODETEXT)
      };
    }
    let text = "";
    try {
      text = String((await this.clipboard?.readText?.()) || "");
    } catch {}
    return { files: false, image: false, text: text !== "" };
  }

  // 本机当前组 groupHash（脏判定输入）：按板内容分派计算，带 seq 缓存（读文件字节贵，
  // 远端帧到达时才算——频率低）。空板=""。
  async localGroupHash() {
    const api = loadUser32();
    const seq = api ? api.seq() : null;
    if (seq !== null && this.cachedLocalGroup.seq === seq && this.cachedLocalGroup.group !== "") {
      return this.cachedLocalGroup.group; // seq 未变=板没动，缓存直出
    }
    let group = "";
    try {
      const fmt = await this.probeFormats();
      if (fmt.files) {
        const paths = readHdropNative(api);
        if (paths) {
          const hashes = [];
          for (const p of paths) {
            // async（P2-3）：远端帧到达即触发本函数，同步读 50MB×N 组=主进程秒级卡顿；
            // 读失败=异常上抛→调用方按脏处理外层 catch
            const bytes = await fs.promises.readFile(p);
            hashes.push(binaryItemHash(path.basename(p), bytes));
          }
          group = groupHashOf(hashes);
        }
      } else if (fmt.image) {
        const bytes = await this.readImagePng();
        if (bytes) {
          group = groupHashOf([binaryItemHash("clipboard.png", bytes)]);
        }
      } else if (fmt.text) {
        const text = String((await this.clipboard?.readText?.()) || "");
        if (text) {
          group = groupHashOf([textItemHash(text)]);
        }
      }
    } catch {
      return ""; // 读失败（锁/文件消失）按空处理→decideRemote 走 empty/脏分支
    }
    if (seq !== null) {
      this.cachedLocalGroup = { seq, group };
    }
    return group;
  }

  // 本地空判定：三档格式全缺席+Outlook 附件族（FileGroupDescriptorW 无 HDROP 无
  // 文本——只探四标准格式会把它误判空，远端旧槽落地顶掉待粘贴附件=冷启动病变体）。
  async localClipboardEmpty() {
    const fmt = await this.probeFormats();
    if (fmt.files || fmt.image || fmt.text) {
      return false;
    }
    try {
      const api = loadUser32();
      if (api) {
        const fgw = api.registerFormat("FileGroupDescriptorW");
        if (fgw !== 0 && api.hasFormat(fgw) !== 0) {
          return false;
        }
      }
    } catch {}
    return true;
  }

  // ── 上传腿（TOP4 失败策略：网络错重试 3×3s；服务明确报错不重试；连续 5 次网络
  // 全败=熔断 fatal 停同步标灰；multipart 上传 100s 超时对齐大文件慢网）──

  restUrl() {
    const config = this.getConfig();
    const base = String(config.serverUrl || "").trim().replace(/\/+$/, "");
    return `${base}/api/v1/clipboard?token=${encodeURIComponent(String(config.clientToken || "").trim())}`;
  }

  // 网络错误分类（TOP4）：fetch 网络层失败（TypeError/超时 abort）=可重试；HTTP 有响应
  // 的「服务明确报错不重试」不在此判——fetch 对 4xx/5xx 不抛异常（!response.ok 早退），
  // 走进 catch 的只有网络层/超时（可重试）与被超车 abort（上层判自家 ac 静默放弃）。
  // 故恒 retryable:true；「HTTP 不重试」的物理实现=响应层 return（对抗审 P3 死码清理）。
  classifyUploadError() {
    return { retryable: true };
  }

  noteUploadOutcome(ok, retryable) {
    if (ok) {
      this.uploadFailStreak = 0;
      return;
    }
    if (!retryable) {
      return; // 服务明确报错不计熔断（不是网络病）
    }
    this.uploadFailStreak += 1;
    if (this.uploadFailStreak >= 5) {
      this.fatal(`连续 ${this.uploadFailStreak} 次上传失败（网络不可达），已停止同步`);
    }
  }

  // 自家 ac 必传（P2-1）：查 this.uploadAbort 的是**最新** controller——超车后它指向新
  // 请求（未 abort），老 fetch 的 AbortError 被误判「可重试」→已 abort 的 signal 重试秒败
  // ×2（~6s 僵尸）+假失败连击。判自家 ac.signal.aborted 才是真「被超车」。
  async uploadWithRetry(doFetch, ac) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await doFetch();
        this.noteUploadOutcome(true);
        return response;
      } catch (error) {
        if (ac?.signal?.aborted) {
          return null; // 自家被超车掐断：静默放弃（不重试不计失败）
        }
        lastError = error;
        const { retryable } = this.classifyUploadError(error);
        if (!retryable) {
          this.noteUploadOutcome(false, false);
          throw error;
        }
        if (attempt < 2) {
          await sleep(3000);
        }
      }
    }
    this.noteUploadOutcome(false, true);
    throw lastError;
  }

  // 上传（超车：新调用 abort 在途）。网络错=保持脏（lastSyncHash 不动），下次事件再试；
  // 离线复制丢失合法（LWW：没送达的写=没写）。
  async uploadText(text) {
    this.uploadAbort?.abort("superseded");
    const ac = new AbortController();
    this.uploadAbort = ac;
    const itemHash = textItemHash(text);
    const group = groupHashOf([itemHash]);
    try {
      const response = await this.uploadWithRetry(() =>
        fetch(this.restUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ v: 1, items: [{ kind: "text", hash: itemHash, text }], groupHash: group }),
          // 超车 signal 组合 30s 硬超时（JSON 腿小包；undici 默认头超时 ~300s 太长）
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)])
        }), ac
      );
      if (!response) {
        return; // 被超车
      }
      if (response.status === 404) {
        this.fatal("服务器不支持剪贴板同步（404），请升级服务器");
        return;
      }
      if (!response.ok) {
        console.error(`[ClipSync] put failed: HTTP ${response.status}`);
        return;
      }
      const data = await response.json();
      if (data?.slot?.groupHash) {
        this.lastSyncHash = String(data.slot.groupHash); // 响应=最终 slot（§3.3）
        this.lastServerTs = Number(data.slot.ts) || 0;
        this.contentBaseline = group; // 上传成功认领内容基线（同内容重读不重传）
        this.scheduleHistoryRefresh(); // 上传成功=环头变了（本地写者不产生 WS 帧——自己触发刷新）
      }
    } catch (error) {
      console.error("[ClipSync] put error:", error?.message || error);
    }
  }

  // 图片/文件组上传（multipart：meta part 先+file part 按下标对应——server 契约 meta
  // 必须先于 file，clipboard.go 注释钉死）。100s 超时（50MB 慢网余量，TOP4）。
  async uploadGroup(items, buffers, group) {
    this.uploadAbort?.abort("superseded");
    const ac = new AbortController();
    this.uploadAbort = ac;
    const form = new FormData();
    form.append(
      "meta",
      new Blob([JSON.stringify({ v: 1, items, groupHash: group })], { type: "application/json" })
    );
    items.forEach((it, i) => {
      form.append("file", new Blob([buffers[i]]), it.name || `item-${i}`);
    });
    try {
      const response = await this.uploadWithRetry(() =>
        fetch(this.restUrl(), {
          method: "POST",
          body: form,
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(100_000)])
        }), ac
      );
      if (!response) {
        return; // 被超车
      }
      if (response.status === 404) {
        this.fatal("服务器不支持剪贴板同步（404），请升级服务器");
        return;
      }
      if (response.status === 413) {
        this.rateLimitedBalloon("server-limit", "剪贴板同步", "服务器拒绝：内容超过上限（413），本组未同步");
        return;
      }
      if (!response.ok) {
        console.error(`[ClipSync] put group failed: HTTP ${response.status}`);
        return;
      }
      const data = await response.json();
      if (data?.slot?.groupHash) {
        this.lastSyncHash = String(data.slot.groupHash);
        this.lastServerTs = Number(data.slot.ts) || 0;
        this.contentBaseline = group; // 上传成功认领内容基线（同内容重读不重传）
        this.scheduleHistoryRefresh(); // 上传成功=环头变了（本地写者不产生 WS 帧——自己触发刷新）
      }
    } catch (error) {
      console.error("[ClipSync] put group error:", error?.message || error);
    }
  }

  // blob 拉取（接收端）：100s 超时（大文件慢网）。404=槽已换/已过期（寄存器语义可接受）。
  async fetchBlob(itemHash) {
    const config = this.getConfig();
    const base = String(config.serverUrl || "").trim().replace(/\/+$/, "");
    const url = `${base}/api/v1/clipboard/blob/${encodeURIComponent(itemHash)}?token=${encodeURIComponent(String(config.clientToken || "").trim())}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(100_000) });
    if (!response.ok) {
      throw new Error(`blob ${itemHash.slice(0, 8)} HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  // WS 每次open重发 clip_sub（CP-C2 契约：重连须重发；ack=当前槽天然替代补投）。
  // TOP4 重连强制重比：清本机内容基线——断线窗口本机动过的内容（上传失败保持脏）
  // 重连后被 tick 重新评估上传；ack 更新 lastSyncHash 后 decideLocalUpload 自然分诊。
  onTransportOpen() {
    if (this.active()) {
      this.lastProbedText = ""; // 强制下轮重读（断线窗口变更不丢）
      this.contentBaseline = ""; // 内容基线同清：重连=重新评估本机板（TOP4 强制重比）
      this.cachedLocalGroup = { seq: -1, group: "" };
      this.sendFrame({ type: "clip_sub" });
      this.scheduleHistoryRefresh(); // 启动/重连预热历史缓存（拾取器首开零延迟——冷启动缓存空=直拉的洞）
    }
  }

  // clip_ack/clip_update 处理（gotify-client 按 type 分流后转发）。
  // 串行链（P2-4）：fire-and-forget 下两帧背靠背（X 大组 fetchBlob 慢、Y 小快）→X 后完成
  // 覆写 Y 已落的板+基线回退=LWW 破坏。promise 链保序，ts 乱序闸在 decide 前已挡旧帧。
  onClipFrame(frame) {
    this.clipChain = (this.clipChain || Promise.resolve())
      .then(() => this.handleClipFrame(frame))
      .then(() => this.scheduleHistoryRefresh()) // 远端落地=环头变了,事件驱动刷缓存（拾取器预读,零轮询）
      .catch((error) => this.fatal(`处理远端帧异常: ${error?.message || error}`));
  }

  // 历史缓存事件驱动刷新（拾取器预读：WS clip_update/上传成功点挂此,节流 3s;开窗缓存优先
  // 显示零延迟,数据最终新鲜——stale-while-revalidate）。拉取同时喂托盘速取（historyCache 同源）。
  scheduleHistoryRefresh() {
    const now = Date.now();
    if (this._histRefreshAt && now - this._histRefreshAt < 3000) {
      return;
    }
    this._histRefreshAt = now;
    this.fetchHistory(20)
      .then(() => this.refreshMenu?.())
      .catch(() => {});
  }

  async handleClipFrame(frame) {
    if (frame?.type !== "clip_ack" && frame?.type !== "clip_update") {
      return;
    }
    if (!this.active()) {
      return;
    }
    const cfg = this.getConfig().clipboardSync;
    const slot = frame.slot;
    if (!slot || !Array.isArray(slot.items) || slot.items.length === 0) {
      if (frame.type === "clip_ack") {
        this.lastSyncHash = ""; // 空槽/过期同形：重置基线（本地不推存量，规则同启动）
        this.lastServerTs = 0;
      }
      return;
    }
    const ts = Number(slot.ts) || 0;
    if (ts && this.lastServerTs && ts < this.lastServerTs) {
      return; // 乱序旧帧（sub ack 晚于 PUT 回执竞态）：丢弃
    }
    if (Number(slot.v) !== 1) {
      return; // additive-only 纪律（§9）：不认的契约版本整帧忽略
    }
    const classified = classifySlotItems(slot.items);
    if (classified.kind === "unknown") {
      return; // 畸形 items（空 kind/未知 kind）：整帧忽略（slot sanity）
    }
    if (classified.kind === "text" && !cfg.types?.text) {
      return; // 文本 filter 关闭：不动
    }
    if (classified.kind === "image" && !cfg.types?.image) {
      return; // 图片 filter 关闭：不动
    }
    if (classified.kind === "files" && !cfg.types?.file) {
      return; // 文件 filter 关闭：不动
    }
    const decision = await this.decideForSlot(slot);
    if (decision === "noop") {
      // 等值也要认领基线：重连 ack 命中本机同值时 lastSyncHash 可能仍空（启动对齐
      // 特例的 sibling）——不认领=本机永远假脏，后续远端更新全进缓存不落地。
      this.lastSyncHash = String(slot.groupHash || "");
      this.lastServerTs = ts;
      return;
    }
    if (decision === "adopt") {
      await this.applyRemoteSlot(classified, slot);
    }
  }

  // 落地决策（拉取本机组+空判定）。
  async decideForSlot(slot) {
    return decideRemoteApply({
      localGroup: await this.localGroupHash(),
      localEmpty: await this.localClipboardEmpty(),
      lastSyncHash: this.lastSyncHash,
      slotGroupHash: String(slot.groupHash || ""),
      contentBaseline: this.contentBaseline
    });
  }

  // 落地远端槽：写剪贴板（Electron 44 async）+置抑制窗+基线推进（②兜回声）。
  // 写失败（剪贴板被他程序锁住等瞬态）=50ms×3 快重试（TOP2 ③），仍败=不认领基线
  //（本机仍是旧值，保持脏——server register 语义无重播，该槽的真实出口=下次远端新值/
  // 托盘取最新/本地新事件）。
  async applyRemoteSlot(classified, slot) {
    let ok = false;
    let remember = null;
    try {
      if (classified.kind === "text") {
        const text = String(classified.textItem?.text || "");
        if (!text) {
          return; // 畸形 slot（kind=text 而 text 缺席）：adopt 空串=清空本机剪贴板，拒
        }
        remember = async () => {
          this.lastProbedText = text;
        };
        ok = await this.writeWithRetry(() => this.clipboard?.writeText?.(text));
      } else if (classified.kind === "image") {
        ok = await this.applyRemoteImage(classified.imageItem, slot);
      } else if (classified.kind === "files") {
        ok = await this.applyRemoteFiles(classified.fileItems, slot);
      }
    } catch (error) {
      console.error("[ClipSync] apply remote failed:", error?.message || error);
      return;
    }
    if (!ok) {
      console.error("[ClipSync] write clipboard failed after retries");
      return;
    }
    // 落地保护窗（P2-2）：写板成功→基线认领完成之间 localGroupHash（大图读回可 >100ms）
    // 未完成前抑制不能到期——否则窗内 tick 见「新内容+旧基线」幽灵上传翻转槽。
    // 认领完成后压回正常 100ms（吸收系统写入延迟）。
    this.suppressUntil = Number.MAX_SAFE_INTEGER;
    this.lastSyncHash = String(slot.groupHash || "");
    this.lastServerTs = Number(slot.ts) || 0;
    if (remember) {
      await remember();
    }
    // 落地认领内容基线（本机板视角的组 hash）：图/文件写读不对称（板上重编码字节/
    // 同名(1) 后的路径），读回才算「本机当前内容」——不认领=落地后首 tick 把它当
    // 新变化重传翻转槽（e2e G2 抓的回归）。读失败=""=无保护（罕见，可自愈）。
    this.cachedLocalGroup = { seq: -1, group: "" }; // 先失效缓存（板已换内容）
    this.contentBaseline = await this.localGroupHash();
    this.suppressUntil = Date.now() + 100; // ①100ms 吸收系统写入延迟
  }

  // 写动作 50ms×3 快重试（TOP2 ③：写回失败重读——SyncClipboard ClipboardFactory 实审）。
  async writeWithRetry(doWrite) {
    for (let i = 0; i < 3; i++) {
      try {
        await doWrite();
        return true;
      } catch (error) {
        if (i === 2) {
          console.error("[ClipSync] write retry exhausted:", error?.message || error);
          return false;
        }
        await sleep(50);
      }
    }
    return false;
  }

  // 落地远端图片：拉 blob→写板。blob=上传端原字节（png=直写；jpg 等升格源=nativeImage
  // 转 png——ClipboardItem 写 "image/png" 最稳，内容保真牺牲原编码）。
  async applyRemoteImage(item, slot) {
    if (!item?.hash || !item?.name) {
      return false; // slot sanity：hash/name 缺席无法拉取
    }
    let bytes;
    try {
      bytes = await this.fetchBlob(item.hash);
    } catch (error) {
      console.error("[ClipSync] fetch blob failed:", error?.message || error);
      return false;
    }
    let payload = bytes;
    let mime = "image/png";
    const name = String(item.name || "");
    const ext = path.extname(name).toLowerCase();
    if (ext && ext !== ".png" && this.nativeImage) {
      try {
        const img = this.nativeImage.createFromBuffer(bytes);
        if (!img.isEmpty()) {
          payload = img.toPNG();
        }
      } catch {
        // 转码失败原字节直写（mime 标真实型——Chromium 不认则下轮粘贴降级，可接受）
        payload = bytes;
        mime = "application/octet-stream";
      }
    }
    if (!this.ClipboardItemCtor || !this.clipboard?.write) {
      return false; // 路 A 依赖缺席（非 win32 老环境）：图片落地不可用
    }
    return this.writeWithRetry(async () => {
      const clipItem = new this.ClipboardItemCtor({ [mime]: new Blob([payload], { type: mime }) });
      await this.clipboard.write([clipItem]);
    });
  }

  // 落地远端文件组：逐个拉 blob→接收目录（同名(1) 不覆盖+同 groupHash 不重写）→
  // koffi 写 CF_HDROP（+DropEffect=Copy）→粘贴可用。
  async applyRemoteFiles(items, slot) {
    const groupHash = String(slot.groupHash || "");
    const alreadyLanded = this.landedGroups.includes(groupHash);
    const dir = this.receiveDir();
    const written = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (alreadyLanded) {
        // 同 groupHash 已落盘：不重写文件（重连 ack 重复帧/重放），但板上路径要重新指
        //（板可能已被覆盖）——按 name 直接拼（落盘时的最终名与 name 一致或已 (N)，重放
        // 查找尽力：name 在先、找不到再拉）。
        for (const it of items) {
          const direct = path.join(dir, path.basename(String(it?.name || "")));
          if (fs.existsSync(direct)) {
            written.push(direct);
          }
        }
        if (written.length === items.length) {
          return this.writeFilesToClipboard(written);
        }
        // 有文件已不在（用户清了目录）：走全量重落（below fallthrough）
      }
      for (const it of items) {
        if (!it?.hash || !it?.name) {
          return false; // slot sanity
        }
        const bytes = await this.fetchBlob(it.hash);
        const target = resolveCollision(dir, it.name);
        fs.writeFileSync(target, bytes);
        written.push(target);
      }
    } catch (error) {
      console.error("[ClipSync] land files failed:", error?.message || error);
      return false;
    }
    this.rememberLanded(groupHash);
    return this.writeFilesToClipboard(written);
  }

  // 文件组写板（koffi CF_HDROP——Electron 44 已砍 writeFiles）。
  writeFilesToClipboard(paths) {
    const api = loadUser32();
    if (!api) {
      return false;
    }
    return this.writeWithRetry(async () => {
      if (!writeHdropNative(api, paths)) {
        throw new Error("SetClipboardData(CF_HDROP) failed");
      }
    });
  }

  rememberLanded(groupHash) {
    if (!groupHash) {
      return;
    }
    this.landedGroups.push(groupHash);
    while (this.landedGroups.length > 20) {
      this.landedGroups.shift(); // 对齐服务端历史环 cap（防无界增长）
    }
  }

  // 接收目录：设置值优先，空=默认 Downloads\HotifyClipboard（§7）。
  receiveDir() {
    const cfg = this.getConfig()?.clipboardSync;
    const custom = String(cfg?.receiveDir || "").trim();
    if (custom) {
      return custom;
    }
    return this.defaultReceiveDir || path.join(process.env.USERPROFILE || "", "Downloads", "HotifyClipboard");
  }

  // 托盘「取最新」/历史重放共用：显式用户意图，强制落地（覆盖脏守卫——用户点名要远端值）。
  async adoptSlotByForce(slot) {
    const classified = classifySlotItems(slot?.items || []);
    if (classified.kind === "unknown" || classified.kind === "empty") {
      return { ok: false, reason: "empty" };
    }
    await this.applyRemoteSlot(classified, slot);
    return { ok: true, reason: "" };
  }

  async pullLatest() {
    try {
      const response = await fetch(this.restUrl(), { method: "GET", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const slot = data?.slot;
      if (!slot || !Array.isArray(slot.items) || slot.items.length === 0) {
        return;
      }
      const result = await this.adoptSlotByForce(slot);
      if (!result.ok) {
        return;
      }
    } catch (error) {
      console.error("[ClipSync] pull error:", error?.message || error);
    }
  }

  // ── 历史找回环（C6 服务端半已落：GET /history 拉 20 条；本批=条目渲染+重放分支，
  // C6 客户端半剩拾取器骨架[托盘子菜单/热键]）──

  // 拉历史列表（新→旧）。渲染用元数据全在 slot 里（不拉 blob）。每次拉取喂 historyCache
  // （托盘速取子菜单数据源——C6 拾取器：缓存最坏滞后到上次开窗，速取场景够用）。
  async fetchHistory(limit = 20) {
    const config = this.getConfig();
    const base = String(config.serverUrl || "").trim().replace(/\/+$/, "");
    const url = `${base}/api/v1/clipboard/history?token=${encodeURIComponent(String(config.clientToken || "").trim())}&limit=${limit}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    this.historyCache = entries;
    this.historyCacheAt = Date.now();
    return entries;
  }

  // 点选历史条目=重放：写本地剪贴板→正常同步链重新上位当前槽→全设备生效（C6 契约：
  // 广播式重新复制，设计行为非副作用）。
  async replayHistoryEntry(entry) {
    const slot = entry?.slot;
    if (!slot || !Array.isArray(slot.items) || slot.items.length === 0) {
      return { ok: false, reason: "empty" };
    }
    const preHash = this.lastSyncHash;
    const result = await this.adoptSlotByForce(slot);
    if (result.ok) {
      // 重新上位（P1-2，两段修）：①回滚槽认领——applyRemoteSlot 把 lastSyncHash 认领成
      // 重放条目自己的组，tick 的 decideLocalUpload(本机组 vs lastSyncHash) 恒 false=零上传
      // （本地-only 违约）；回滚到 replay 前值=「板载旧条目而槽仍是新值」的正确态。
      // ②清内容门（文本 lastProbedText/图/文件 contentBaseline）——tick 视作本机新内容，
      // 走上传链翻槽+广播（suppress 放行后 1-2 个 tick 内完成）。
      this.lastSyncHash = preHash;
      this.suppressUntil = 0;
      this.lastProbedText = "";
      this.contentBaseline = "";
      this.cachedLocalGroup = { seq: -1, group: "" };
    }
    return result;
  }

  rateLimitedBalloon(category, title, body) {
    const now = Date.now();
    const last = this.balloonLastAt.get(category) || 0;
    if (now - last < 10 * 60 * 1000) {
      return; // 每类 10 分钟限频，不刷屏（§7）
    }
    this.balloonLastAt.set(category, now);
    this.balloon(title, body);
  }

  // 托盘菜单状态描述（main 据此重建菜单：运行中/暂停/标灰）。
  describe() {
    const cfg = this.getConfig()?.clipboardSync;
    if (!cfg) {
      return { enabled: false };
    }
    return {
      enabled: Boolean(cfg.enabled),
      paused: Boolean(cfg.paused),
      fatal: this.fatalMessage
    };
  }

  // 命令面（TOP5 命令面统一）：托盘/热键/CLI 共用一个 action 表——本批托盘起步，
  // C6 拾取器（热键/CLI 遥控 second-instance 转发）从同一表接。label=托盘文案。
  trayActions() {
    return {
      "toggle-pause": {
        label: "暂停剪贴板同步",
        run: () => {
          const config = this.getConfig();
          config.clipboardSync = { ...config.clipboardSync, paused: !config.clipboardSync?.paused };
          this.saveConfig(config);
        }
      },
      "pull-latest": {
        label: "取最新剪贴板",
        run: () => this.pullLatest()
      },
      "open-receive-dir": {
        label: "打开接收文件夹",
        run: () => {
          const dir = this.receiveDir();
          try {
            fs.mkdirSync(dir, { recursive: true });
          } catch {}
          this.openReceiveDir(dir);
        }
      }
    };
  }

  // 托盘菜单剪贴板段（main 的 buildTrayTemplate spread 进去）：本段内容是本模块
  // 的事实（label/enabled/click 全在这），main 只持骨架条目。未启用=[]（菜单零变化）。
  traySection() {
    const state = this.describe();
    if (!state.enabled) {
      return [];
    }
    const items = [{ type: "separator" }];
    if (state.fatal) {
      // 主进程隔离（§5）：环路异常=停同步+标灰，菜单项只展示不响应
      items.push({ label: `剪贴板同步已停止：${state.fatal}`, enabled: false });
      return items;
    }
    const actions = this.trayActions();
    const paused = Boolean(state.paused);
    // C6 拾取器：「最近复制」子菜单（速取条目由 picker 注入的 submenuProvider 提供——
    // 本模块只持槽位事实，速取交互归 clip-picker）。懒加载自收敛：缓存空且未在拉→
    // fire-and-forget 拉一次，拉完 onMenuRefresh 重建（缓存非空不再拉）。
    if (!paused && this.pickerSubmenu) {
      const submenu = this.pickerSubmenu();
      if (submenu.length > 0) {
        items.push({ label: "最近复制", submenu });
      }
      if (!this.historyCache.length && !this._historyFetching) {
        this._historyFetching = true;
        this.fetchHistory(20)
          .catch(() => {})
          .finally(() => {
            this._historyFetching = false;
            this.refreshMenu?.();
          });
      }
    }
    items.push({
      label: paused ? "恢复剪贴板同步" : "暂停剪贴板同步",
      click: actions["toggle-pause"].run
    });
    items.push({
      label: actions["pull-latest"].label,
      enabled: !paused,
      click: actions["pull-latest"].run
    });
    items.push({
      label: actions["open-receive-dir"].label,
      enabled: !paused,
      click: actions["open-receive-dir"].run
    });
    return items;
  }
}

function syncActiveOf(config) {
  const cfg = config?.clipboardSync;
  return Boolean(cfg?.enabled && !cfg.paused && config?.serverUrl && config?.clientToken);
}

// 能力探测（交付策略 2026-09-05）：开关开时 GET /api/v1/clipboard——404=server 太老，
// 设置段显示「需要升级服务器」（优雅降级已有，静默空转换明确告知）。
async function probeClipboardCapability(serverUrl, clientToken) {
  const base = String(serverUrl || "").trim().replace(/\/+$/, "");
  const token = String(clientToken || "").trim();
  if (!base || !token) {
    return { supported: null, status: 0, reason: "未配置服务器" };
  }
  const url = `${base}/api/v1/clipboard?token=${encodeURIComponent(token)}`;
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) {
      return { supported: false, status: 404, reason: "服务器不支持，需要升级服务器" };
    }
    if (response.ok) {
      return { supported: true, status: response.status };
    }
    // 401/5xx/代理假响应归「未知」：只把「确定路由不存在」判负，「确定正常」判正
    return { supported: null, status: response.status, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { supported: null, status: 0, reason: error?.message || String(error) };
  }
}

// 装配单入口（notifier initNotifier 同款先例）：事件转发/IPC 注册/依赖注入全在
// 这——main.js 只剩生命周期挂点（init/start/onConfigChanged/traySection/stop），
// 接线事实不散进 main（防 main 屎山，2026-09-05 用户裁定）。
// deps：electron={clipboard, ipcMain, getTray, shell, nativeImage}；client=GotifyClient
// 实例；saveConfig=main applyConfigChange（保存链单入口）；onMenuRefresh=托盘重建回调。
function initClipboardSync({ electron, getConfig, client, saveConfig, onMenuRefresh }) {
  const defaultReceiveDir = electron.defaultReceiveDir || "";
  const sync = new ClipboardSync({
    getConfig,
    sendFrame: (frame) => client.sendClipFrame(frame),
    balloon: (title, body) => {
      try {
        electron.getTray?.()?.displayBalloon({ title, content: body, icon: "info" });
      } catch {}
    },
    openReceiveDir: (dir) => {
      try {
        electron.shell?.openPath(dir);
      } catch {}
    },
    defaultReceiveDir,
    // 托盘暂停切换：source=tray 携带翻转后真值直落（applyConfigChange 的 UI 路
    // 会用盘上现值保 paused——对托盘路径即回滚，故必须走 tray 源）
    saveConfig: (next) => saveConfig(next, "tray")
  });
  sync.setElectronClipboard(electron.clipboard, electron.ClipboardItem, electron.nativeImage);
  // 每次 WS open 重发 clip_sub（订阅是 per-conn 状态，重连不补发=静默失联）
  client.on("open", () => sync.onTransportOpen());
  client.on("clip-frame", (frame) => sync.onClipFrame(frame));
  // 能力探测（交付策略 2026-09-05）：开关开时设置段验 server 是否支持剪贴板
  //（404=太老→显示「需要升级服务器」，静默空转换明确告知）
  electron.ipcMain.handle("clipboard:probeCapability", async (_, payload) =>
    probeClipboardCapability(payload?.serverUrl, payload?.clientToken)
  );
  // 历史列表（C6 拾取器预读·stale-while-revalidate）：缓存新鲜（<10s）即时返；缓存陈旧/空
  // 返缓存并同时后台刷新（拾取器开窗零延迟——事件驱动刷新点见 scheduleHistoryRefresh 头注）
  electron.ipcMain.handle("clipboard:getHistory", async () => {
    const fresh = sync.historyCacheAt && Date.now() - sync.historyCacheAt < 10_000;
    if (fresh) {
      return { ok: true, entries: sync.historyCache };
    }
    sync.scheduleHistoryRefresh(); // 后台刷（陈旧缓存也先返,下次开窗即新）
    if (sync.historyCache.length > 0) {
      return { ok: true, entries: sync.historyCache, stale: true };
    }
    try {
      const entries = await sync.fetchHistory(20);
      return { ok: true, entries };
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }
  });
  // 历史重放（显式用户意图强制落地+重新上位）
  electron.ipcMain.handle("clipboard:replay", async (_, entry) => {
    try {
      return await sync.replayHistoryEntry(entry);
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }
  });
  // fatal → 托盘标灰（菜单重建由 main 持有托盘骨架）
  sync.on("fatal", () => onMenuRefresh?.());
  return sync;
}

module.exports = {
  ClipboardSync,
  initClipboardSync,
  probeClipboardCapability,
  textItemHash,
  binaryItemHash,
  groupHashOf,
  decideRemoteApply,
  decideLocalUpload,
  classifySlotItems,
  isImagePath,
  resolveCollision
};
