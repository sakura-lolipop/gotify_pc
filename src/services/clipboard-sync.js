// 跨设备剪贴板同步（CP-C2 文本腿，docs/clipboard.md §5 权威契约）。
// LWW 单槽寄存器：本地复制=写意图（事件驱动），远端更新=读侧落地（带脏守卫）。
// 回环四件套：①落地置 suppress 100ms ②lastSyncHash 回声丢 ③上传前比对 ④本机脏不落地。
// 主进程隔离：环路任何异常=记日志+停同步+托盘标灰（emit fatal），不碰主进程（E1 纪律）。
const EventEmitter = require("node:events");
const crypto = require("node:crypto");

// ── hash 公式（clipboard.md §3.2，四端契约；测试向量钉 test/clipboard-sync.test.js）──

// itemHash(text) = sha256(utf8 bytes)
function textItemHash(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

// groupHash = sha256(join("\n", sorted(itemHash hex)))。拷贝排序防改入参（对齐 server 端）。
function groupHashOf(itemHashes) {
  const sorted = [...itemHashes].sort();
  return crypto.createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

// ── 回环判定（纯函数，host-side 单测锚）──

// 远端槽落地决策：noop=已等值｜adopt=写入本机｜cache=本机脏只进缓存不碰剪贴板（§5 ④）。
// localEmpty 含启动对齐特例（lastSyncHash 空时本地非空=脏=不采纳——冷启动病防线）。
function decideRemoteApply({ localText, localEmpty, lastSyncHash, slotGroupHash }) {
  const localGroup = localText !== "" ? groupHashOf([textItemHash(localText)]) : "";
  if (localGroup !== "" && localGroup === slotGroupHash) {
    return "noop"; // 内容已等值（重连 ack / 他端 no-op 广播）
  }
  if (localEmpty) {
    return "adopt"; // 本机空：无损失，采纳（含启动对齐）
  }
  if (lastSyncHash !== "" && localGroup === lastSyncHash) {
    return "adopt"; // 本机干净（上次同步点后没动过）：远端新值上位
  }
  return "cache"; // 本机脏（本地动过/图片占位/启动存量）：只进缓存
}

// 上传决策：与已知远端 groupHash 相同即跳过（②回声丢与③上传前比对是同一谓词，
// lastSyncHash 同时承担两个角色；server 同 groupHash no-op 是兜底非第一道闸）。
function decideLocalUpload({ groupHash, lastSyncHash }) {
  return groupHash !== lastSyncHash;
}

// ── Windows 原生探测（koffi；加载失败静默降级 Electron 路径，无 crash 面）──
// GetClipboardSequenceNumber：500ms tick 变化才读内容（大图 decode 抖动防线）。
// IsClipboardFormatAvailable：零拷贝探格式（Files>Image>Text 优先级 + 本地空判定）。
const CF_UNICODETEXT = 13;
const CF_BITMAP = 2;
const CF_DIB = 8;
const CF_HDROP = 15;

let user32Api = null;
function loadUser32() {
  if (user32Api !== null) {
    return user32Api;
  }
  if (process.platform !== "win32") {
    return (user32Api = false);
  }
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    user32Api = {
      seq: user32.func("uint32 __stdcall GetClipboardSequenceNumber()"),
      hasFormat: user32.func("int __stdcall IsClipboardFormatAvailable(uint32 format)"),
      // ExcludeForSync 兜底路：RegisterClipboardFormatW 同名=系统级同 id（单例语义），
      // 注册即拿 id 再查可用性——比枚举全格式表更稳（Electron 44 已砍 availableFormats）。
      registerFormat: user32.func("uint32 __stdcall RegisterClipboardFormatW(str16 name)")
    };
  } catch (error) {
    console.error("[ClipSync] koffi/user32 不可用，回退内容比对探测:", error?.message || error);
    user32Api = false;
  }
  return user32Api;
}

// koffi 路 Exclude 标记存在性（同步单路，Electron has 探针判负已摘——见 isExcluded 注释）。
// 格式名以 SyncClipboard 客户端实审修正为准（clipboard.md §5，2026-09-05）：
// ExcludeClipboardContentForMonitorProcessing（初版误写 FromTrackProcessingProcesses——
// 探针自洽但探不到真实密码管理器标记=假绿）。CanIncludeInClipboardHistory/
// CanUploadToCloudClipboard 两 DWORD 族=C3 红探针一次验三格式再并入。
function excludedMarkerNative() {
  const api = loadUser32();
  if (!api) {
    return false;
  }
  try {
    const fmt = api.registerFormat("ExcludeClipboardContentForMonitorProcessing");
    return fmt !== 0 && api.hasFormat(fmt) !== 0;
  } catch {
    return false;
  }
}

// ── 同步主体 ──

class ClipboardSync extends EventEmitter {
  // deps：getConfig() 返全量 config；sendFrame(obj) 发 WS 控制帧（clip_sub/unsub）；
  // balloon(title, body) 托盘气泡（超限提示，每类限频）；saveConfig(next) 配置落盘
  // 单入口（托盘暂停切换用，经 main 的 applyConfigChange 走同一应用链）。
  constructor({ getConfig, sendFrame, balloon, saveConfig }) {
    super();
    this.getConfig = getConfig;
    this.sendFrame = sendFrame || (() => false);
    this.balloon = balloon || (() => {});
    this.saveConfig = saveConfig || (() => {});
    this.timer = null;
    this.lastSeq = null; // sequence 基线（start 时采，启动存量不算事件）
    this.lastProbedText = ""; // 无 koffi 时的内容比对回退
    this.lastSyncHash = ""; // 已同步远端 groupHash（②③共用；每启动重置——不持久化）
    this.lastServerTs = 0; // 已知最新槽的 server 时间戳（乱序旧帧丢弃）
    this.suppressUntil = 0; // ①落地抑制窗（吸收系统写入延迟）
    this.uploadAbort = null; // 超车：队列深度=1，新复制掐断在途
    this.fatalMessage = null;
    this.balloonLastAt = new Map(); // 超限提示限频（每类）
    this.textBaselineReady = false; // 无 koffi 形态的内容基线就绪门（启动防误传）
    this.clipboard = null; // electron clipboard 延迟注入（main 侧 setElectronClipboard）
  }

  setElectronClipboard(clipboard) {
    this.clipboard = clipboard;
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
      this.lastServerTs = 0;
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
  // sequence 没变=一个字节都不读。async——Electron 44 起 clipboard 读侧全 Promise
  //（探针实证：readText()/has() 返 Promise、readImage/availableFormats 已砍）。
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
    if (fmt.files || fmt.image) {
      this.consumeProbe(seqBefore);
      return; // 图片/文件：C3/C4 领地，C2 不碰
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
    // 生效上限=min(用户设置, 1MB)：server JSON 腿被 maxIngestBodyLen=1MB 硬顶
    //（§4「server 只做绝对护栏」的物理实现），调大设置也只按 1MB 生效不炸 413。
    const maxTextMB = Math.min(Number(cfg.maxTextMB) || 1, 1);
    const maxTextBytes = maxTextMB * 1024 * 1024;
    if (bytes > maxTextBytes) {
      this.rateLimitedBalloon("text-oversize", "剪贴板同步", `文本超过 ${maxTextMB}MB 上限，本条未同步`);
      return; // 超用户上限→整组跳过+提示一次（§7）
    }
    const group = groupHashOf([textItemHash(text)]);
    if (!decideLocalUpload({ groupHash: group, lastSyncHash: this.lastSyncHash })) {
      return; // ②③回声/等值：不上传
    }
    this.uploadText(text);
  }

  // 探测后基线推进：sequence 用读前值（读中竞态变化下一轮可见）；
  // lastProbedText 是无 koffi 形态的内容基线（变更门+失败不重试）。
  consumeProbe(seq, text) {
    if (seq !== null && seq !== undefined) {
      this.lastSeq = seq;
    }
    if (typeof text === "string") {
      this.lastProbedText = text;
    }
  }

  // 密码管理器排除标记（§5）：koffi 单路。红探针实证（2026-09-05）：Electron 44
  // has() 返 Promise（同步误用恒 truthy=全部误判排除），且置真 marker 后 await has()
  // 仍 false=看不见自定义格式（探针判负→该路摘除不留双保险）；koffi
  // RegisterClipboardFormatW（同名单例 id）+IsClipboardFormatAvailable 双向验过
  //（有标记=1/还原=0；格式名 2026-09-05 实审订正为 ForMonitorProcessing）。
  // 非 win32=无探测能力（本 app 目标平台 win32，koffi 必在）。
  async isExcluded() {
    return excludedMarkerNative();
  }

  // Files > Image > Text 优先级（§5）。koffi=同步三格式；缺席回退 Electron async
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
      return { files: has(CF_HDROP), image: has(CF_BITMAP) || has(CF_DIB), text: has(CF_UNICODETEXT) };
    }
    let text = "";
    try {
      text = String((await this.clipboard?.readText?.()) || "");
    } catch {}
    return { files: false, image: false, text: text !== "" };
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

  // 上传（超车：新调用 abort 在途）。网络错=保持脏（lastSyncHash 不动），下次事件再试；
  // 离线复制丢失合法（LWW：没送达的写=没写）。
  async uploadText(text) {
    this.uploadAbort?.abort("superseded");
    const ac = new AbortController();
    this.uploadAbort = ac;
    const config = this.getConfig();
    const itemHash = textItemHash(text);
    const group = groupHashOf([itemHash]);
    const base = String(config.serverUrl || "").trim().replace(/\/+$/, "");
    const url = `${base}/api/v1/clipboard?token=${encodeURIComponent(String(config.clientToken || "").trim())}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, items: [{ kind: "text", hash: itemHash, text }], groupHash: group }),
        // 超车 signal 组合 30s 硬超时（挂死 server 不悬置写；undici 默认头超时 ~300s 太长）
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)])
      });
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
      }
    } catch (error) {
      if (ac.signal.aborted) {
        return;
      }
      console.error("[ClipSync] put error:", error?.message || error);
    }
  }

  // WS 每次open重发 clip_sub（CP-C2 契约：重连须重发；ack=当前槽天然替代补投）。
  onTransportOpen() {
    if (this.active()) {
      this.sendFrame({ type: "clip_sub" });
    }
  }

  // clip_ack/clip_update 处理（gotify-client 按 type 分流后转发）。
  onClipFrame(frame) {
    try {
      this.handleClipFrame(frame).catch((error) => this.fatal(`处理远端帧异常: ${error?.message || error}`));
    } catch (error) {
      this.fatal(`处理远端帧异常: ${error?.message || error}`);
    }
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
    const textItem = slot.items.length === 1 && slot.items[0]?.kind === "text" ? slot.items[0] : null;
    if (!textItem || !cfg.types?.text) {
      return; // 图/文件/多条目：C3/C4 落地；文本 filter 关闭：不动
    }
    if (!textItem.text) {
      return; // 畸形 slot（kind=text 而 text 缺席）：adopt 空串=清空本机剪贴板，拒
    }
    const decision = decideRemoteApply({
      localText: String((await this.clipboard?.readText?.()) || ""),
      localEmpty: await this.localClipboardEmpty(),
      lastSyncHash: this.lastSyncHash,
      slotGroupHash: String(slot.groupHash || "")
    });
    if (decision === "noop") {
      // 等值也要认领基线：重连 ack 命中本机同值时 lastSyncHash 可能仍空（启动对齐
      // 特例的 sibling）——不认领=本机永远假脏，后续远端更新全进缓存不落地。
      this.lastSyncHash = String(slot.groupHash || "");
      this.lastServerTs = ts;
      return;
    }
    if (decision === "adopt") {
      await this.applyRemoteText(String(textItem.text || ""), slot);
    }
  }

  // 落地远端文本：写剪贴板（Electron 44 async）+置抑制窗+基线推进（②兜回声）。
  // 写失败（剪贴板被他程序锁住等瞬态）=不认领基线（本机仍是旧值，保持脏——
  // server register 语义无重播，该槽的真实出口=下次远端新值/托盘取最新/本地新事件）。
  async applyRemoteText(text, slot) {
    const value = String(text || "");
    try {
      await this.clipboard?.writeText?.(value);
    } catch (error) {
      console.error("[ClipSync] write clipboard failed:", error?.message || error);
      return;
    }
    this.suppressUntil = Date.now() + 100; // ①100ms 吸收系统写入延迟
    this.lastSyncHash = String(slot.groupHash || "");
    this.lastServerTs = Number(slot.ts) || 0;
    this.lastProbedText = value;
  }

  // 托盘「取最新」：显式用户意图，强制落地（覆盖脏守卫——用户点名要远端值）。
  async pullLatest() {
    const config = this.getConfig();
    const base = String(config.serverUrl || "").trim().replace(/\/+$/, "");
    const url = `${base}/api/v1/clipboard?token=${encodeURIComponent(String(config.clientToken || "").trim())}`;
    try {
      const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const slot = data?.slot;
      if (!slot || !Array.isArray(slot.items) || slot.items.length === 0) {
        return;
      }
      const textItem = slot.items.length === 1 && slot.items[0]?.kind === "text" ? slot.items[0] : null;
      if (!textItem) {
        this.rateLimitedBalloon("pull-non-text", "剪贴板同步", "最新内容为图片或文件，当前版本仅支持文本");
        return;
      }
      await this.applyRemoteText(String(textItem.text || ""), slot);
    } catch (error) {
      console.error("[ClipSync] pull error:", error?.message || error);
    }
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
    items.push({
      label: state.paused ? "恢复剪贴板同步" : "暂停剪贴板同步",
      click: () => {
        const config = this.getConfig();
        config.clipboardSync = { ...config.clipboardSync, paused: !state.paused };
        this.saveConfig(config);
      }
    });
    items.push({
      label: "取最新剪贴板",
      enabled: !state.paused,
      click: () => this.pullLatest()
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
// deps：electron={clipboard, ipcMain, getTray}；client=GotifyClient 实例；
// saveConfig=main applyConfigChange（保存链单入口）；onMenuRefresh=托盘重建回调。
function initClipboardSync({ electron, getConfig, client, saveConfig, onMenuRefresh }) {
  const sync = new ClipboardSync({
    getConfig,
    sendFrame: (frame) => client.sendClipFrame(frame),
    balloon: (title, body) => {
      try {
        electron.getTray?.()?.displayBalloon({ title, content: body, icon: "info" });
      } catch {}
    },
    // 托盘暂停切换：source=tray 携带翻转后真值直落（applyConfigChange 的 UI 路
    // 会用盘上现值保 paused——对托盘路径即回滚，故必须走 tray 源）
    saveConfig: (next) => saveConfig(next, "tray")
  });
  sync.setElectronClipboard(electron.clipboard);
  // 每次 WS open 重发 clip_sub（订阅是 per-conn 状态，重连不补发=静默失联）
  client.on("open", () => sync.onTransportOpen());
  client.on("clip-frame", (frame) => sync.onClipFrame(frame));
  // 能力探测（交付策略 2026-09-05）：开关开时设置段验 server 是否支持剪贴板
  //（404=太老→显示「需要升级服务器」，静默空转换明确告知）
  electron.ipcMain.handle("clipboard:probeCapability", async (_, payload) =>
    probeClipboardCapability(payload?.serverUrl, payload?.clientToken)
  );
  // fatal → 托盘标灰（菜单重建由 main 持有托盘骨架）
  sync.on("fatal", () => onMenuRefresh?.());
  return sync;
}

module.exports = {
  ClipboardSync,
  initClipboardSync,
  probeClipboardCapability,
  textItemHash,
  groupHashOf,
  decideRemoteApply,
  decideLocalUpload
};
