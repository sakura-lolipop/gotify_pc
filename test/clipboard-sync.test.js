// CP-C2 剪贴板同步 host-side 单测（node --test test/）：
// ① hash 公式四端契约——向量照抄 server clipboard_hash_test.go 钉死（任何端漂移联调即爆）
// ② 回环判定纯函数——decideRemoteApply/decideLocalUpload 全分支
// ③ 必测回归场景（clipboard.md §10 CP-C2 行）：开机截图占位→远端旧槽不得落地
const test = require("node:test");
const assert = require("node:assert");
const { textItemHash, groupHashOf, decideRemoteApply, decideLocalUpload } = require("../src/services/clipboard-sync");

// ── ① hash 向量（server clipboard_hash_test.go 同值钉死）──

test("textItemHash：向量与 server 端一致", () => {
  assert.strictEqual(textItemHash("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.strictEqual(textItemHash("中文剪贴板"), "b7ab6988149dff095e71b33ac5eb3130dcb36ce04a86321b6418c74ee9ce041f");
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

// ── ② 回环判定（clipboard.md §5 四件套的②③④侧）──

const HASH_HELLO = groupHashOf([textItemHash("hello")]);
const HASH_WORLD = groupHashOf([textItemHash("world")]);

test("decideRemoteApply：内容已等值→noop（重连 ack 不重写）", () => {
  assert.strictEqual(
    decideRemoteApply({ localText: "hello", localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_HELLO }),
    "noop"
  );
});

test("decideRemoteApply：本机空→adopt（启动对齐·本地空=采纳）", () => {
  assert.strictEqual(
    decideRemoteApply({ localText: "", localEmpty: true, lastSyncHash: "", slotGroupHash: HASH_WORLD }),
    "adopt"
  );
});

test("decideRemoteApply：本机干净（=上次同步点）→adopt（远端新值上位）", () => {
  assert.strictEqual(
    decideRemoteApply({ localText: "hello", localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_WORLD }),
    "adopt"
  );
});

test("decideRemoteApply：本机脏→cache（只进缓存不碰剪贴板）", () => {
  assert.strictEqual(
    decideRemoteApply({ localText: "local-edit", localEmpty: false, lastSyncHash: HASH_HELLO, slotGroupHash: HASH_WORLD }),
    "cache"
  );
});

test("decideRemoteApply：必测回归——开机截图占位（非文本非空）→远端旧槽不落地", () => {
  // localEmpty=false（截图占位）+ localText=""（无文本）：只看文本会误判「空」→采纳，
  // 截图被旧文本顶掉=SyncClipboard 冷启动病。localEmpty 由格式探测（Files/Image/Text）供数。
  assert.strictEqual(
    decideRemoteApply({ localText: "", localEmpty: false, lastSyncHash: "", slotGroupHash: HASH_WORLD }),
    "cache"
  );
});

test("decideRemoteApply：启动对齐特例——lastSyncHash 空+本地有文本=脏=不采纳", () => {
  assert.strictEqual(
    decideRemoteApply({ localText: "开机前存量", localEmpty: false, lastSyncHash: "", slotGroupHash: HASH_WORLD }),
    "cache"
  );
});

test("decideLocalUpload：与已知远端同指纹→不上传（②回声丢=③上传前比对，同一谓词）", () => {
  assert.strictEqual(decideLocalUpload({ groupHash: HASH_HELLO, lastSyncHash: HASH_HELLO }), false);
  assert.strictEqual(decideLocalUpload({ groupHash: HASH_HELLO, lastSyncHash: HASH_WORLD }), true);
  assert.strictEqual(decideLocalUpload({ groupHash: HASH_HELLO, lastSyncHash: "" }), true);
});
