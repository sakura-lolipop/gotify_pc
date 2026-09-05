// CP-C2~C4 剪贴板同步 host-side 单测（node --test test/，显式文件列表——E14 工法坑②）：
// ① hash 公式四端契约——向量照抄 server clipboard_hash_test.go 钉死（任何端漂移联调即爆）
// ② 回环判定纯函数——decideRemoteApply/decideLocalUpload 全分支（C3/C4 泛化为组口径）
// ③ 必测回归场景（clipboard.md §10 CP-C2 行）：开机截图占位→远端旧槽不得落地
// ④ C3/C4 新面：classifySlotItems 分派/单文件升格/同名(1) 落盘/图片固定名一致性
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  textItemHash,
  binaryItemHash,
  groupHashOf,
  decideRemoteApply,
  decideLocalUpload,
  classifySlotItems,
  isImagePath,
  resolveCollision
} = require("../src/services/clipboard-sync");

// ── ① hash 向量（server clipboard_hash_test.go 同值钉死）──

test("textItemHash：向量与 server 端一致", () => {
  assert.strictEqual(textItemHash("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.strictEqual(textItemHash("中文剪贴板"), "b7ab6988149dff095e71b33ac5eb3130dcb36ce04a86321b6418c74ee9ce041f");
});

test("binaryItemHash：file 向量与 server 端一致（sha256(utf8(name+\"|\")+bytes)）", () => {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(binaryItemHash("a.png", pngMagic), "2a86892d99f081e1509605892853077278c121b78aa585273d4263a2f3a6d69f");
  // image/file 同公式（升格档与文件档同 name 同字节=同指纹——跨档去重语义）
  assert.strictEqual(binaryItemHash("clipboard.png", Buffer.alloc(0)), binaryItemHash("clipboard.png", Buffer.alloc(0)));
  // 同字节不同名=不同 hash（server 注释钉死的前缀语义）
  assert.notStrictEqual(binaryItemHash("a.png", pngMagic), binaryItemHash("b.png", pngMagic));
});

test("groupHashOf：向量+顺序无关+不改入参", () => {
  // 两 itemHash 来自 server 向量（text "hello" + file "a.png"+PNG magic）
  const a = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const b = "2a86892d99f081e1509605892853077278c121b78aa585273d4263a2f3a6d69f";
  assert.strictEqual(groupHashOf([a, b]), "b9e97cea4c75bc73b45d5cb436520920b5c9b7001ade4269ab7b439ff7c0999a");
  assert.strictEqual(groupHashOf([b, a]), groupHashOf([a, b]), "乱序输入同指纹");
  const input = [b, a];
  groupHashOf(input);
  assert.deepStrictEqual(input, [b, a], "不得改入参顺序");
});

// ── ② 回环判定（clipboard.md §5 四件套的②③④侧；C3/C4 泛化=组口径）──

const HASH_HELLO = groupHashOf([textItemHash("hello")]);
const HASH_WORLD = groupHashOf([textItemHash("world")]);
const HASH_IMAGE = groupHashOf([binaryItemHash("clipboard.png", Buffer.from([0x89, 0x50]))]);
const HASH_FILES = groupHashOf([
  binaryItemHash("a.txt", Buffer.from("aaa")),
  binaryItemHash("b.txt", Buffer.from("bbb"))
]);

test("decideRemoteApply：内容已等值→noop（重连 ack 不重写）", () => {
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_HELLO, localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_HELLO }),
    "noop"
  );
});

test("decideRemoteApply：本机空→adopt（启动对齐·本地空=采纳）", () => {
  assert.strictEqual(
    decideRemoteApply({ localGroup: "", localEmpty: true, lastSyncHash: "", slotGroupHash: HASH_WORLD }),
    "adopt"
  );
});

test("decideRemoteApply：本机干净（=上次同步点）→adopt（远端新值上位）", () => {
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_HELLO, localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_WORLD }),
    "adopt"
  );
});

test("decideRemoteApply：本机脏→cache（只进缓存不碰剪贴板）", () => {
  assert.strictEqual(
    decideRemoteApply({ localGroup: groupHashOf([textItemHash("local-edit")]), localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_WORLD }),
    "cache"
  );
});

test("decideRemoteApply：必测回归——开机截图占位（非文本非空）→远端旧槽不落地", () => {
  // localEmpty=false（截图占位）+ localGroup=""（无文本组）：只看文本会误判「空」→采纳，
  // 截图被旧文本顶掉=SyncClipboard 冷启动病。localEmpty 由格式探测（Files/Image/Text）供数。
  assert.strictEqual(
    decideRemoteApply({ localGroup: "", localEmpty: false, lastSyncHash: "", slotGroupHash: HASH_WORLD }),
    "cache"
  );
});

test("decideRemoteApply：启动对齐特例——lastSyncHash 空+本地有内容=脏=不采纳", () => {
  assert.strictEqual(
    decideRemoteApply({ localGroup: groupHashOf([textItemHash("开机前存量")]), localEmpty: false, lastSyncHash: "", slotGroupHash: HASH_WORLD }),
    "cache"
  );
});

test("decideRemoteApply：图片/文件组口径（C3/C4 泛化）——本机图等值 noop/干净 adopt/脏 cache", () => {
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_IMAGE, localEmpty: false, lastSyncHash: HASH_IMAGE, slotGroupHash: HASH_IMAGE }),
    "noop"
  );
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_IMAGE, localEmpty: false, lastSyncHash: HASH_IMAGE, slotGroupHash: HASH_FILES }),
    "adopt"
  );
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_FILES, localEmpty: false, lastSyncHash: HASH_IMAGE, slotGroupHash: HASH_WORLD }),
    "cache"
  );
});

test("decideRemoteApply：粘性脏防线（P1-1）——板=最近同步写入值（contentBaseline）→adopt 非本地编辑", () => {
  // 升格图/同名(1) 形态：本机读回组（contentBaseline）永远≠远端槽组（lastSyncHash 之后的
  // 新槽）——单看 lastSyncHash=粘性脏，后续远端更新全 cache 静默丢（对抗审 P1-1 探针 RED）
  const HASH_LANDED = groupHashOf([binaryItemHash("clipboard.png", Buffer.from([9, 9]))]);
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_LANDED, localEmpty: false, lastSyncHash: HASH_LANDED, slotGroupHash: HASH_WORLD, contentBaseline: HASH_LANDED }),
    "adopt"
  );
  // contentBaseline 与板不等（用户本地编辑过）→照旧 cache
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_FILES, localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_WORLD, contentBaseline: HASH_LANDED }),
    "cache"
  );
  // contentBaseline 空（启动/重连清空）→不触发该分支
  assert.strictEqual(
    decideRemoteApply({ localGroup: HASH_LANDED, localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_WORLD, contentBaseline: "" }),
    "cache"
  );
});

test("decideLocalUpload：与已知远端同指纹→不上传（②回声丢=③上传前比对，同一谓词）", () => {
  assert.strictEqual(decideLocalUpload({ groupHash: HASH_HELLO, lastSyncHash: HASH_HELLO }), false);
  assert.strictEqual(decideLocalUpload({ groupHash: HASH_HELLO, lastSyncHash: HASH_WORLD }), true);
  assert.strictEqual(decideLocalUpload({ groupHash: HASH_HELLO, lastSyncHash: "" }), true);
});

// ── ④ C3/C4 新面 ──

test("classifySlotItems：全 text→text/单 image→image/含 file→files（混合组取 file 部分）", () => {
  const textSlot = classifySlotItems([{ kind: "text", text: "hi", hash: "a" }]);
  assert.strictEqual(textSlot.kind, "text");
  const imageSlot = classifySlotItems([{ kind: "image", hash: "h", name: "a.png", size: 1 }]);
  assert.strictEqual(imageSlot.kind, "image");
  const fileSlot = classifySlotItems([
    { kind: "file", hash: "h1", name: "a.txt", size: 1 },
    { kind: "file", hash: "h2", name: "b.txt", size: 1 }
  ]);
  assert.strictEqual(fileSlot.kind, "files");
  assert.strictEqual(fileSlot.fileItems.length, 2);
  // 混合组（他端未来版本/恶意构造）：按 file 降级，text 忽略
  const mixed = classifySlotItems([
    { kind: "text", text: "x", hash: "t" },
    { kind: "file", hash: "h1", name: "a.txt", size: 1 }
  ]);
  assert.strictEqual(mixed.kind, "files");
  assert.strictEqual(mixed.fileItems.length, 1);
  // 畸形：空/未知 kind
  assert.strictEqual(classifySlotItems([]).kind, "empty");
  assert.strictEqual(classifySlotItems([{ kind: "wat" }]).kind, "unknown");
});

test("isImagePath：单文件升格判定（扩展名族+大小写）", () => {
  assert.strictEqual(isImagePath("C:\\a\\b\\photo.JPG"), true);
  assert.strictEqual(isImagePath("/x/y/截图.png"), true);
  assert.strictEqual(isImagePath("a.jpeg"), true);
  assert.strictEqual(isImagePath("a.gif"), true);
  assert.strictEqual(isImagePath("a.webp"), true);
  assert.strictEqual(isImagePath("a.txt"), false);
  assert.strictEqual(isImagePath("a.zip"), false);
  assert.strictEqual(isImagePath("noext"), false);
  assert.strictEqual(isImagePath("png"), false); // 无点不认
});

test("resolveCollision：同名冲突 (1) 递增不覆盖+空档直用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-collision-"));
  try {
    const first = resolveCollision(dir, "a.txt");
    assert.strictEqual(path.basename(first), "a.txt"); // 空档直用
    fs.writeFileSync(first, "one");
    const second = resolveCollision(dir, "a.txt");
    assert.strictEqual(path.basename(second), "a (1).txt");
    fs.writeFileSync(second, "two");
    const third = resolveCollision(dir, "a.txt");
    assert.strictEqual(path.basename(third), "a (2).txt");
    // 无扩展名 stem 处理
    fs.writeFileSync(path.join(dir, "README"), "x");
    assert.strictEqual(path.basename(resolveCollision(dir, "README")), "README (1)");
    // 路径穿越防护：只取 basename
    assert.strictEqual(path.basename(resolveCollision(dir, "..\\..\\evil.txt")), "evil.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
