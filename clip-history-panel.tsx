// 剪贴板历史面板（CP-C3/C4 批顺手位：C6 客户端半的条目渲染+重放分支；拾取器骨架
// [托盘子菜单/热键] 留 C6）。renderer 侧组件与 renderer-icons.tsx 同层惯例（根目录）。
// 自持 state（拉取/渲染/重放），SettingsModal 只插一行——历史列表不再内联进 SettingsModal
// 巨石（2026-09-05 用户裁定拆分：自成一卡的功能不进 renderer.tsx）。
import { useState } from "react";

// 历史条目（server GET /api/v1/clipboard/history 回执形状：{hlc, slot}）
export type ClipHistoryEntry = {
  hlc?: string;
  slot?: {
    v?: number;
    groupHash?: string;
    ts?: number;
    items?: { kind: string; text?: string; name?: string; size?: number; hash?: string }[];
  };
};

// 条目摘要（渲染用纯函数）：kind 徽标 + 预览文本。混合组按 file 部分降级（与
// clipboard-sync classifySlotItems 同裁定——客户端上传只发单类型组，混合=异常输入）。
function entrySummary(entry: ClipHistoryEntry): { kind: string; preview: string } {
  const items = entry?.slot?.items || [];
  const first = items[0];
  if (items.length > 0 && items.every((it) => it?.kind === "text")) {
    const text = String(first?.text || "").replace(/\s+/g, " ").trim();
    return { kind: "文本", preview: text.slice(0, 36) || "（空）" };
  }
  if (items.length === 1 && first?.kind === "image") {
    const kb = Math.max(1, ((first?.size || 0) / 1024) | 0);
    return { kind: "图片", preview: `${first?.name || "image"} · ${kb}KB` };
  }
  const files = items.filter((it) => it?.kind === "file");
  if (files.length > 0) {
    const names = files.slice(0, 2).map((it) => it?.name).join("、");
    return { kind: "文件", preview: `${files.length} 个文件：${names}${files.length > 2 ? "…" : ""}` };
  }
  return { kind: "未知", preview: "" };
}

// deps：formatTime 时间格式化注入（formatDate 由 renderer.tsx 供——时间格式单一真相
// 不复制；window.gotifyAPI 由 preload 暴露，declare global 在 renderer.tsx）。
export function ClipHistoryPanel({ formatTime }: { formatTime: (ts: number) => string }) {
  const [entries, setEntries] = useState<ClipHistoryEntry[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error" | "empty">("idle");
  const [replayNote, setReplayNote] = useState<string | null>(null);

  const load = () => {
    setState("loading");
    window.gotifyAPI
      .getClipboardHistory()
      .then((result) => {
        if (result?.ok && Array.isArray(result.entries)) {
          setEntries(result.entries);
          setState(result.entries.length > 0 ? "idle" : "empty");
        } else {
          setState("error");
        }
      })
      .catch(() => setState("error"));
  };

  const replay = (entry: ClipHistoryEntry) => {
    setReplayNote("正在重放…");
    window.gotifyAPI
      .replayClipboardHistory(entry)
      .then((r) => setReplayNote(r?.ok ? "已重放到本机剪贴板（自动重新同步）" : `重放失败：${r?.reason || "内容不可用（可能已过期）"}`))
      .catch(() => setReplayNote("重放失败"));
  };

  return (
    <div className="mt-2 border-t border-border-light pt-2">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-[13px] text-text">剪贴板历史</div>
        <button
          type="button"
          onClick={load}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-text-soft transition-colors hover:bg-card-hover"
        >
          {state === "loading" ? "拉取中…" : "刷新"}
        </button>
      </div>
      {replayNote ? <div className="mb-1.5 text-[11px] text-text-muted">{replayNote}</div> : null}
      {state === "empty" ? <div className="text-[11px] text-text-muted">暂无历史（服务端找回环最多 20 条）</div> : null}
      {state === "error" ? <div className="text-[11px] text-danger-text">拉取失败（服务器不可达或版本过旧）</div> : null}
      {entries && entries.length > 0 ? (
        <div className="max-h-40 overflow-y-auto">
          {entries.map((entry, index) => {
            const { kind, preview } = entrySummary(entry);
            return (
              <button
                key={entry?.hlc || index}
                type="button"
                title="重放到本机剪贴板（重新同步到所有设备）"
                onClick={() => replay(entry)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-card-hover"
              >
                <span className="shrink-0 rounded bg-card-hover px-1.5 py-0.5 text-[10px] text-text-muted">{kind}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-soft">{preview}</span>
                <span className="shrink-0 text-[10px] text-text-muted">{formatTime(entry?.slot?.ts || 0)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {state === "idle" && !entries ? (
        <div className="text-[11px] text-text-muted">点「刷新」拉取最近 20 条；点条目=重放到本机剪贴板并重新同步</div>
      ) : null}
    </div>
  );
}
