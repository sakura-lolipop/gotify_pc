// CP2 水位免疫（L3）不变量测试：兜底 id 不抬高水位、不入数字去重集。
// 运行：node --test test/ （node --test 会自动发现 test/ 目录）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GotifyClient } = require("../src/services/gotify-client");
const { HistoryStore } = require("../src/services/history-store");

test("normalizeMessage：无 id 兜底走 local-<seq> 命名空间且单调唯一", () => {
  const client = new GotifyClient();
  const a = client.normalizeMessage({ appid: 1, title: "t", message: "m" });
  const b = client.normalizeMessage({ appid: 1, title: "t", message: "m" });
  assert.match(String(a.id), /^local-\d+$/, "兜底 id 应为 local-<seq> 字符串");
  assert.notEqual(a.id, b.id, "两条无 id 消息的兜底 id 必须不同");
});

test("normalizeMessage：非正整数 id 一律视为非服务器 id", () => {
  const client = new GotifyClient();
  assert.strictEqual(client.normalizeMessage({ id: 42 }).id, 42);
  assert.strictEqual(client.normalizeMessage({ id: 0 }).id, "local-1");
  assert.strictEqual(client.normalizeMessage({ id: -3 }).id, "local-2");
  assert.strictEqual(client.normalizeMessage({ id: 3.5 }).id, "local-3");
  assert.strictEqual(client.normalizeMessage({ id: "abc" }).id, "local-4");
});

test("isDuplicate：local id 不入数字去重集（防占位挤兑 5000 上限）", () => {
  const client = new GotifyClient();
  client.isDuplicate(client.normalizeMessage({ appid: 1, title: "t", message: "a" }));
  client.isDuplicate(client.normalizeMessage({ appid: 2, title: "t", message: "b" }));
  assert.strictEqual(client.seenMessageIds.size, 0);
});

test("水位不变量：兜底 id 永不抬高 getMaxId（L3 核心）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gotify-cp2-"));
  const store = new HistoryStore(dir);
  store.add({ id: 5, appid: 1, title: "server", message: "s" });
  store.add({ id: "local-1", appid: 1, title: "malformed-1", message: "m" });
  store.add({ id: "local-2", appid: 1, title: "malformed-2", message: "m" });
  assert.strictEqual(store.getMaxId(), 5, "local 命名空间不得进水位");
});

test("水位不变量：历史中的小数 id（脏数据）不抬高 getMaxId", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gotify-cp2-"));
  const store = new HistoryStore(dir);
  store.add({ id: 7, appid: 1, title: "server", message: "s" });
  store.add({ id: 1e13 + 0.5, appid: 1, title: "dirty-float", message: "d" });
  assert.strictEqual(store.getMaxId(), 7);
});

test("add：local id 消息正常入库展示（不因 NaN 被丢）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gotify-cp2-"));
  const store = new HistoryStore(dir);
  store.add({ id: "local-1", appid: 1, title: "t", message: "m" });
  assert.strictEqual(store.getAll().length, 1);
});
