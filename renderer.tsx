import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { IconGear, IconMore, IconStarOutline, IconStarFilled, IconClearText, IconInbox, IconSearch } from "./renderer-icons";
import { avatarColor, avatarLabel } from "./src/services/app-avatar";

const DEFAULT_CONFIG = {
  serverUrl: "",
  clientToken: "",
  showCustomNotification: true,
  playSound: true,
  notificationAutoHide: true,
  notificationNeverClose: false,
  notificationDuration: 5000,
  archiveExpiryMinutes: 60,
  codeSmartExpiry: true,
  theme: "system" as "system" | "light" | "dark",
  minimizeToTray: true,
  showMainWindowOnStartup: true,
  autoLaunch: false,
  enableReconnect: true,
  autoRefreshInterval: 10000,
  barkServerUrl: "",
  barkForwardApps: [] as number[],
  mutedNotificationApps: [] as number[],
};

type Config = typeof DEFAULT_CONFIG;
type ApplicationInfo = { id: number; name: string };
type MessageItem = {
  id?: number;
  date?: string | number;
  appid?: number;
  appname?: string;
  priority?: number;
  title?: string;
  message?: string;
  favorite?: boolean;
};
type StorageMeta = { path?: string; lockedByEnv?: boolean };
type ConnectionStatus = { connected?: boolean; status?: string };
type SettingsNotice = { text: string; type: "info" | "error" };
type SettingsModalProps = {
  onClose: () => void;
  initialConfig: Config;
  appVersion: string;
  onSave: (draft: Config) => void;
  onTest: (draft: Config) => void;
  testing: boolean;
  saving: boolean;
  notice: SettingsNotice;
  storagePath: string;
  draftStoragePath: string;
  setDraftStoragePath: Dispatch<SetStateAction<string>>;
  onPickStoragePath: () => void;
  onApplyStoragePath: () => void;
  applyingStoragePath: boolean;
  storageLockedByEnv: boolean;
};

// 手写 Switch（CP5 S2：约 30 行，不引组件库）。currentColor 走 token。
function Switch({ checked, onChange, disabled = false, danger = false }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none disabled:opacity-40 ${checked ? (danger ? "bg-danger-text" : "bg-primary") : "bg-text-disabled"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${active ? "border-primary bg-primary text-white" : "border-border bg-input text-text-soft hover:bg-card-hover"}`}
    >
      {label}
    </button>
  );
}

// 设置行布局：标签左（13px），控件右，注释下行
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  // 二轮 M5：控件列定宽齐右——开关/滑杆/数值右缘对齐，扫读线不跳
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[13px] text-text">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] leading-snug text-text-muted">{hint}</div> : null}
      </div>
      <div className="flex w-44 shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}
type GotifyAPI = {
  getAppVersion: () => Promise<string>;
  getThemeState: () => Promise<{ dark?: boolean }>;
  extractCodes: (items: { title?: string; message?: string }[]) => Promise<string[]>;
  writeClipboard: (text: string) => Promise<boolean>;
  getConfig: () => Promise<Partial<Config>>;
  saveConfig: (config: Config) => Promise<Config>;
  testConnection: (payload: { serverUrl: string; clientToken: string }) => Promise<void>;
  toggleConnection: () => Promise<void>;
  getConnectionStatus: () => Promise<ConnectionStatus>;
  getMessages: () => Promise<MessageItem[]>;
  clearMessages: () => Promise<void>;
  onConnectionStatus: (cb: (payload: ConnectionStatus) => void) => () => void;
  onThemeUpdated: (cb: (payload: { dark?: boolean }) => void) => () => void;
  onNewMessage: (cb: (payload: MessageItem) => void) => () => void;
  onOpenSettings: (cb: () => void) => () => void;
  onMessagesCleared: (cb: () => void) => () => void;
  getStoragePath: () => Promise<StorageMeta>;
  pickStoragePath: () => Promise<string>;
  setStoragePath: (path: string) => Promise<{ path?: string; restartRequired?: boolean }>;
  openStoragePath: () => Promise<void>;
  getApplications: () => Promise<ApplicationInfo[]>;
  toggleFavorite: (id: number) => Promise<boolean>;
};

declare global {
  interface Window {
    gotifyAPI: GotifyAPI;
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// 二轮 S3：时间三档人性化——今天只给钟点、昨天带「昨天」、更早给日期。
// 分组头与行内时间共用这两个函数（单一事实）。
function dateGroupLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timeText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86400000);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hm}`;
}

function SettingsModal({
  onClose,
  initialConfig,
  appVersion,
  onSave,
  onTest,
  testing,
  saving,
  notice,
  storagePath,
  draftStoragePath,
  setDraftStoragePath,
  onPickStoragePath,
  onApplyStoragePath,
  applyingStoragePath,
  storageLockedByEnv,
}: SettingsModalProps) {
  const [showToken, setShowToken] = useState(false);
  const [applications, setApplications] = useState<ApplicationInfo[]>([]);
  // S10 根治：draft 模型。所有编辑落本地 draft，保存才提交；取消=关闭即弃
  // （父组件条件挂载保证下次打开从真实 config 重建）。旧实现直接改 App 的
  // config state，取消后脏值残留。
  const [draft, setDraft] = useState<Config>({ ...initialConfig });
  // 二轮 S5：脏稿两击确认关闭 + Esc（静默弃稿是 draft 模型的最后一块拼图）
  const [armedClose, setArmedClose] = useState(false);
  const draftDirty = JSON.stringify(draft) !== JSON.stringify(initialConfig);
  const requestClose = () => {
    if (draftDirty && !armedClose) {
      setArmedClose(true);
      return;
    }
    onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    window.gotifyAPI.getApplications().then((apps) => {
      setApplications(Array.isArray(apps) ? apps : []);
    });
  }, []);

  const patch = (partial: Partial<Config>) => setDraft((prev) => ({ ...prev, ...partial }));
  const onServerUrlChange = (event: ChangeEvent<HTMLInputElement>) => patch({ serverUrl: event.target.value });
  const onTokenChange = (event: ChangeEvent<HTMLInputElement>) => patch({ clientToken: event.target.value });
  const onBarkUrlChange = (event: ChangeEvent<HTMLInputElement>) => patch({ barkServerUrl: event.target.value });
  const onAutoHideChange = (checked: boolean) =>
    patch({ notificationAutoHide: checked, notificationNeverClose: checked ? false : draft.notificationNeverClose });
  const onNeverCloseChange = (checked: boolean) =>
    patch({ notificationNeverClose: checked, notificationAutoHide: checked ? false : draft.notificationAutoHide });
  const onDurationSecondsChange = (event: ChangeEvent<HTMLInputElement>) =>
    patch({ notificationDuration: Math.round(Number(event.target.value || 1)) * 1000 });
  const onArchiveMinutesChange = (event: ChangeEvent<HTMLInputElement>) =>
    patch({ archiveExpiryMinutes: Number(event.target.value || 5) });
  const toggleIdIn = (key: "mutedNotificationApps" | "barkForwardApps", id: number) =>
    setDraft((prev) => {
      const current = Array.isArray(prev[key]) ? prev[key] : [];
      return { ...prev, [key]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] };
    });

  const onOpenStoragePath = async () => {
    try {
      await window.gotifyAPI.openStoragePath();
    } catch {
      // ignore
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[3px] dark:bg-black/60" onClick={requestClose}></div>
      <div className="relative flex w-[640px] max-h-[86vh] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-black/[0.06] bg-panel shadow-2xl dark:border-white/[0.08]">
        <div className="border-b border-border-light px-5 py-3 text-[18px] font-semibold text-text">设置</div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-[13px]">
          <div className="rounded border border-border-light bg-card-hover-alt p-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-muted">服务器</div>
            <div className="flex items-center gap-3 py-1.5">
              <div className="w-24 text-[13px] text-text shrink-0">服务器地址</div>
              <input
                value={draft.serverUrl}
                onChange={onServerUrlChange}
                placeholder="https://your-gotify.example.com"
                className="h-8 flex-1 rounded border border-border bg-input text-text px-3 text-[13px] outline-none focus:border-primary"
              />
            </div>
            <div className="flex items-center gap-3 py-1.5">
              <div className="w-24 text-[13px] text-text shrink-0">客户端令牌</div>
              <input
                type={showToken ? "text" : "password"}
                value={draft.clientToken}
                onChange={onTokenChange}
                placeholder="Client Token"
                className="h-8 flex-1 rounded border border-border bg-input text-text px-3 text-[13px] outline-none focus:border-primary"
              />
              <button onClick={() => setShowToken((v) => !v)} className="h-8 rounded border border-border bg-card px-3 text-[12px] text-text-soft hover:bg-card-hover">
                {showToken ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
          <div className="rounded border border-border-light bg-card-hover-alt p-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-muted">通知</div>
            <SettingRow label="显示自定义弹窗通知">
              <Switch checked={draft.showCustomNotification} onChange={(v) => patch({ showCustomNotification: v })} />
            </SettingRow>
            <SettingRow label="播放提示音">
              <Switch checked={draft.playSound} onChange={(v) => patch({ playSound: v })} />
            </SettingRow>
            <SettingRow label="启用主动重连">
              <Switch checked={draft.enableReconnect} onChange={(v) => patch({ enableReconnect: v })} />
            </SettingRow>
            <SettingRow label="通知自动消失">
              <Switch checked={draft.notificationAutoHide} onChange={onAutoHideChange} />
            </SettingRow>
            <SettingRow label="通知持续时间" hint="仅在自动消失启用时生效">
              <input
                type="range"
                min={1}
                max={60}
                step={1}
                value={Math.max(1, Math.round(draft.notificationDuration / 1000))}
                onChange={onDurationSecondsChange}
                disabled={!draft.notificationAutoHide || draft.notificationNeverClose}
                className="w-40 accent-primary disabled:opacity-40"
              />
              <span className="w-12 text-right text-[12px] tabular-nums text-text-soft">{Math.max(1, Math.round(draft.notificationDuration / 1000))} 秒</span>
            </SettingRow>
            <SettingRow label="永不自动关闭" hint="与「自动消失」互斥">
              <Switch danger checked={draft.notificationNeverClose} onChange={onNeverCloseChange} />
            </SettingRow>
            <SettingRow label="通知中心存档时长" hint="每条消息在系统通知中心的保留时间">
              <input
                type="range"
                min={5}
                max={240}
                step={5}
                value={Math.max(5, draft.archiveExpiryMinutes)}
                onChange={onArchiveMinutesChange}
                className="w-40 accent-primary"
              />
              <span className="w-14 text-right text-[12px] tabular-nums text-text-soft">{Math.max(5, draft.archiveExpiryMinutes)} 分钟</span>
            </SettingRow>
            <SettingRow label="验证码按短信有效期存档" hint="按短信中的「N分钟」存档，识别不到时回落到上方时长">
              <Switch checked={draft.codeSmartExpiry} onChange={(v) => patch({ codeSmartExpiry: v })} />
            </SettingRow>
            <div className="border-t border-border-light pt-2">
              <div className="mb-1.5 text-[13px] text-text">屏蔽弹窗分组</div>
              {applications.length === 0 ? (
                <div className="text-[12px] text-text-muted">暂无应用分组，请先连接服务器</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {applications.map((app) => (
                    <Chip key={app.id} label={app.name} active={draft.mutedNotificationApps?.includes(app.id)} onClick={() => toggleIdIn("mutedNotificationApps", app.id)} />
                  ))}
                </div>
              )}
              <div className="mt-1 text-[11px] text-text-muted">选中的分组将不再显示弹窗提醒</div>
            </div>
          </div>
          <div className="rounded border border-border-light bg-card-hover-alt p-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-muted">Bark 消息转发</div>
            <div className="space-y-2">
              <input
                value={draft.barkServerUrl || ""}
                onChange={onBarkUrlChange}
                placeholder="https://api.day.app/YOUR_KEY"
                className="h-8 w-full rounded border border-border bg-input text-text px-2 text-[13px] outline-none focus:border-primary"
              />
              <div>
                <div className="mb-1.5 text-[13px] text-text">要转发的应用分组</div>
                {applications.length === 0 ? (
                  <div className="text-[12px] text-text-muted">暂无应用分组，请先连接服务器</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {applications.map((app) => (
                      <Chip key={app.id} label={app.name} active={draft.barkForwardApps?.includes(app.id)} onClick={() => toggleIdIn("barkForwardApps", app.id)} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="rounded border border-border-light bg-card-hover-alt p-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-muted">外观</div>
            <SettingRow label="主题" hint="跟随系统或手动指定，窗口材质同步深浅">
              <div className="flex rounded border border-border bg-input p-0.5">
                {([["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => patch({ theme: value })}
                    className={`rounded px-3 py-1 text-[12px] transition-colors ${(draft.theme || "system") === value ? "bg-primary text-white" : "text-text-soft hover:bg-card-hover"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </SettingRow>
          </div>
          <div className="rounded border border-border-light bg-card-hover-alt p-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-muted">数据存储</div>
            <div className="flex items-center gap-2 py-1">
              <div className="flex-1 rounded border border-border bg-input px-2 py-1.5 text-[12px] text-text-soft break-all">
                {storagePath || "-"}
              </div>
              <button
                onClick={onOpenStoragePath}
                disabled={!storagePath}
                className="h-8 whitespace-nowrap rounded border border-primary px-3 text-[12px] text-primary hover:bg-card-hover disabled:opacity-50 disabled:hover:bg-transparent"
              >
                打开目录
              </button>
            </div>
            <div className="mt-1 text-[11px] text-text-muted">如需迁移数据，请手动复制文件到新目录</div>
          </div>
          <div className="rounded border border-border-light bg-card-hover-alt p-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-text-muted">通用</div>
            <SettingRow label="最小化到系统托盘">
              <Switch checked={draft.minimizeToTray} onChange={(v) => patch({ minimizeToTray: v })} />
            </SettingRow>
            <SettingRow label="开机自动启动">
              <Switch checked={draft.autoLaunch} onChange={(v) => patch({ autoLaunch: v })} />
            </SettingRow>
            <SettingRow label="启动时显示主界面">
              <Switch checked={draft.showMainWindowOnStartup} onChange={(v) => patch({ showMainWindowOnStartup: v })} />
            </SettingRow>
            <div className="mt-2 border-t border-border-light pt-2 text-[12px] text-text-muted">
              版本 <span className="font-mono text-text-soft">{appVersion || "-"}</span>
            </div>
          </div>
        </div>
        <div className="shrink-0 flex items-center justify-between gap-3 border-t border-border-light bg-card-hover-alt px-5 py-3">
          <div className={`flex-1 min-w-0 break-words text-[13px] font-semibold leading-tight ${notice?.type === "error" ? "text-danger-text" : "text-success-text"}`}>
            {armedClose ? "有未保存的修改，再点一次关闭" : notice?.text || ""}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button onClick={requestClose} className="h-9 whitespace-nowrap rounded border border-border bg-card px-4 text-[13px] text-text-soft hover:bg-card-hover">
              取消
            </button>
            <button onClick={() => onTest(draft)} disabled={testing} className="h-9 whitespace-nowrap rounded border border-border bg-card px-3 text-[13px] text-text-soft hover:bg-card-hover disabled:opacity-50">
              {testing ? "测试中..." : "测试连接"}
            </button>
            <button onClick={() => onSave(draft)} disabled={saving} className="h-9 whitespace-nowrap rounded bg-primary px-4 text-[13px] text-white hover:bg-primary-hover disabled:opacity-50">
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageCard({ item, appLabel, onToggleFavorite, verificationCode }: { item: MessageItem; appLabel?: string; onToggleFavorite: (id: number) => void; verificationCode?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  // 二轮 S2：优先级条 token 色；默认不画条
  const priority = Number(item.priority || 0);
  const priorityColor = priority >= 8 ? "bg-danger-text" : priority >= 4 ? "bg-primary" : "";
  const rawMessage = String(item.message || "");
  const lines = rawMessage.split("\n");
  const maxLines = 4;
  const maxChars = 220;
  const overLineLimit = lines.length > maxLines;
  const overCharLimit = rawMessage.length > maxChars;
  const canCollapse = overLineLimit || overCharLimit;
  const collapsedText = useMemo(() => {
    const merged = lines.slice(0, maxLines).join("\n");
    if (merged.length <= maxChars) {
      return overLineLimit ? `${merged}...` : merged;
    }
    return `${merged.slice(0, maxChars)}...`;
  }, [rawMessage, overLineLimit]);
  const visibleMessage = expanded || !canCollapse ? rawMessage : collapsedText;
  // 二轮 S8：正文中的验证码段 mono 高亮+点码复制（码值来自主进程提取，单一真相）
  const onCopyCode = async () => {
    if (!verificationCode) return;
    try {
      await window.gotifyAPI.writeClipboard(verificationCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const bodyParts = useMemo(() => {
    if (!verificationCode || !visibleMessage.includes(verificationCode)) return [{ text: visibleMessage, code: false }];
    const parts = [];
    let rest = visibleMessage;
    while (verificationCode && rest.includes(verificationCode)) {
      const idx = rest.indexOf(verificationCode);
      if (idx > 0) parts.push({ text: rest.slice(0, idx), code: false });
      parts.push({ text: verificationCode, code: true });
      rest = rest.slice(idx + verificationCode.length);
    }
    if (rest) parts.push({ text: rest, code: false });
    return parts;
  }, [visibleMessage, verificationCode]);
  return (
    <div className="group flex gap-3 px-4 py-2 hover:bg-layer-hover">
      {priorityColor ? <div className={`w-1 shrink-0 rounded-full ${priorityColor}`}></div> : null}
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
        style={{ backgroundColor: avatarColor(item.appid) }}
        title={appLabel || `应用 #${item.appid || 0}`}
      >
        {avatarLabel(appLabel, item.appid)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1 truncate">
            <span className="text-[15px] font-semibold text-text">{item.title || "无标题"}</span>
            <span className="ml-2 text-[12px] text-text-muted">{appLabel || `应用 #${item.appid || 0}`}</span>
          </div>
          <button
            onClick={() => item.id && onToggleFavorite(item.id)}
            className={`self-center rounded p-0.5 text-text-muted hover:text-star focus:outline-none ${item.favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
            title={item.favorite ? "取消收藏" : "收藏"}
          >
            {item.favorite ? <IconStarFilled className="h-4 w-4 text-star" /> : <IconStarOutline className="h-4 w-4" />}
          </button>
          <div className="self-center whitespace-nowrap text-[12px] tabular-nums text-text-muted">{timeText(item.date)}</div>
        </div>
        <div className="mt-0.5 text-[13px] text-text-soft whitespace-pre-wrap break-words">
          {bodyParts.map((part, index) =>
            part.code ? (
              <button
                key={index}
                onClick={onCopyCode}
                title={copied ? "已复制" : "点击复制验证码"}
                className="mx-0.5 rounded bg-black/[0.05] px-1.5 py-px font-mono text-[13px] tabular-nums text-text hover:bg-black/[0.09] dark:bg-white/[0.08] dark:hover:bg-white/[0.14]"
              >
                {copied ? "已复制 ✓" : part.text}
              </button>
            ) : (
              <span key={index}>{part.text}</span>
            )
          )}
        </div>
        {canCollapse ? (
          <button onClick={() => setExpanded((prev) => !prev)} className="mt-0.5 text-[12px] text-primary hover:text-primary-hover">
            {expanded ? "收起" : "展开"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function App() {
  const [config, setConfig] = useState<Config>({ ...DEFAULT_CONFIG });
  const [appVersion, setAppVersion] = useState("-");
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>({ connected: false, status: "未连接" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [banner, setBanner] = useState("");
  const [settingsNotice, setSettingsNotice] = useState<SettingsNotice>({ text: "", type: "info" });
  const [storagePath, setStoragePath] = useState("");
  const [draftStoragePath, setDraftStoragePath] = useState("");
  const [applyingStoragePath, setApplyingStoragePath] = useState(false);
  const [storageLockedByEnv, setStorageLockedByEnv] = useState(false);
  const [applications, setApplications] = useState<ApplicationInfo[]>([]);
  const [selectedAppId, setSelectedAppId] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [showFavorites, setShowFavorites] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirmClearArmed, setConfirmClearArmed] = useState(false);
  const [codeMap, setCodeMap] = useState<Map<string, string>>(new Map());
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  // 二轮 M3：宽窗两列（断点 JS 驱动，≥1000px），布局吃空间不放大字号
  const [wide, setWide] = useState(() => (typeof window !== "undefined" ? window.innerWidth >= 1000 : false));
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1000);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    // CP6：.dark 类的挂/摘只听 nativeTheme 下推（单一事实，含手动覆盖的解析结果）
    const apply = (dark: boolean) => document.documentElement.classList.toggle("dark", Boolean(dark));
    let unsubTheme: (() => void) | null = null;
    window.gotifyAPI.getThemeState().then((state) => apply(Boolean(state?.dark))).catch(() => {});
    unsubTheme = window.gotifyAPI.onThemeUpdated((payload) => apply(Boolean(payload?.dark)));
    return () => {
      if (typeof unsubTheme === "function") unsubTheme();
    };
  }, []);

  useEffect(() => {
    let unsubStatus = null;
    let unsubMessage = null;
    let unsubOpenSettings = null;
    let unsubMessagesCleared = null;
    const run = async () => {
      try {
        const [cfg, history, storageMeta, apps, version] = await Promise.all([
          window.gotifyAPI.getConfig(),
          window.gotifyAPI.getMessages(),
          window.gotifyAPI.getStoragePath(),
          window.gotifyAPI.getApplications(),
          window.gotifyAPI.getAppVersion(),
        ]);
        setAppVersion(String(version || "-"));
        setConfig({ ...DEFAULT_CONFIG, ...cfg });
        setMessages(Array.isArray(history) ? history : []);
        const nextStoragePath = String(storageMeta?.path || "");
        setStoragePath(nextStoragePath);
        setDraftStoragePath(nextStoragePath);
        setStorageLockedByEnv(Boolean(storageMeta?.lockedByEnv));
        setApplications(Array.isArray(apps) ? apps : []);
        unsubStatus = window.gotifyAPI.onConnectionStatus((payload) => setStatus(payload));
        unsubMessage = window.gotifyAPI.onNewMessage((payload) => setMessages((prev) => [payload, ...prev]));
        unsubOpenSettings = window.gotifyAPI.onOpenSettings(() => setSettingsOpen(true));
        unsubMessagesCleared = window.gotifyAPI.onMessagesCleared(() => setMessages([]));
        const latestStatus = await window.gotifyAPI.getConnectionStatus();
        if (latestStatus && typeof latestStatus === "object") {
          setStatus(latestStatus);
        }
      } catch (error) {
        setBanner(`初始化失败: ${error.message || "未知错误"}`);
      } finally {
        setLoading(false);
      }
    };
    run();
    return () => {
      if (typeof unsubStatus === "function") unsubStatus();
      if (typeof unsubMessage === "function") unsubMessage();
      if (typeof unsubOpenSettings === "function") unsubOpenSettings();
      if (typeof unsubMessagesCleared === "function") unsubMessagesCleared();
    };
  }, []);

  useEffect(() => {
    if (loading) {
      return;
    }
    const boot = document.getElementById("boot-screen");
    if (boot) {
      boot.remove();
    }
  }, [loading]);

  useEffect(() => {
    if (!banner) {
      return undefined;
    }
    const timer = setTimeout(() => setBanner(""), 2500);
    return () => clearTimeout(timer);
  }, [banner]);

  const dotColor = status.connected
    ? "bg-success"
    : status.status.includes("重连")
      ? "bg-warn"
      : "bg-danger-text";

  const onSave = async (draft: Config) => {
    setSaving(true);
    try {
      const saved = await window.gotifyAPI.saveConfig(draft);
      setConfig(saved);
      setSettingsNotice({ text: "设置已保存，正在尝试重连", type: "info" });
      const apps = await window.gotifyAPI.getApplications();
      setApplications(Array.isArray(apps) ? apps : []);
      setSettingsOpen(false);
    } catch (error) {
      const text = `保存失败: ${error.message || "未知错误"}`;
      setSettingsNotice({ text, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const onTest = async (draft: Config) => {
    setTesting(true);
    try {
      await window.gotifyAPI.testConnection({
        serverUrl: draft.serverUrl,
        clientToken: draft.clientToken,
      });
      setSettingsNotice({ text: "连接测试成功", type: "info" });
    } catch (error) {
      const text = `连接测试失败: ${error.message || "未知错误"}`;
      setSettingsNotice({ text, type: "error" });
    } finally {
      setTesting(false);
    }
  };

  const onToggleConnection = async () => {
    try {
      await window.gotifyAPI.toggleConnection();
      const apps = await window.gotifyAPI.getApplications();
      setApplications(Array.isArray(apps) ? apps : []);
    } catch (error) {
      setBanner(`操作失败: ${error.message || "未知错误"}`);
    }
  };

  const onClearMessages = async () => {
    const previousMessages = messages;
    setMessages([]);
    setClearing(true);
    try {
      await window.gotifyAPI.clearMessages();
      setBanner("消息已清空");
    } catch {
      setMessages(previousMessages);
      setBanner("清空失败，请重试");
    } finally {
      setClearing(false);
    }
  };

  const onPickStoragePath = async () => {
    try {
      const selected = await window.gotifyAPI.pickStoragePath();
      if (selected) {
        setDraftStoragePath(selected);
      }
    } catch (error) {
      setSettingsNotice({ text: `选择路径失败: ${error.message || "未知错误"}`, type: "error" });
    }
  };

  const onApplyStoragePath = async () => {
    setApplyingStoragePath(true);
    try {
      const result = await window.gotifyAPI.setStoragePath(draftStoragePath);
      const nextPath = String(result?.path || draftStoragePath);
      setStoragePath(nextPath);
      setDraftStoragePath(nextPath);
      const text = result?.restartRequired ? "存储路径已更新，重启应用后生效" : "存储路径未变化";
      setSettingsNotice({ text, type: "info" });
      setBanner(text);
    } catch (error) {
      const text = `更新存储路径失败: ${error.message || "未知错误"}`;
      setSettingsNotice({ text, type: "error" });
      setBanner(text);
    } finally {
      setApplyingStoragePath(false);
    }
  };

  const onToggleFavorite = async (id: number) => {
    try {
      const newStatus = await window.gotifyAPI.toggleFavorite(id);
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id === id) {
            return { ...msg, favorite: newStatus };
          }
          return msg;
        })
      );
    } catch (error) {
      setBanner("操作失败，请重试");
    }
  };

  const appIdSet = useMemo(() => new Set(messages.map((item) => Number(item.appid || 0)).filter((id) => id > 0)), [messages]);
  const applicationOptions = useMemo(() => {
    const knownIds = new Set(applications.map((item) => item.id));
    const dynamicOptions = Array.from(appIdSet)
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id: String(id), name: `应用 #${id}` }));
    return [{ id: "all", name: "全部分组" }, ...applications.map((item) => ({ id: String(item.id), name: item.name })), ...dynamicOptions];
  }, [applications, appIdSet]);
  const getAppLabel = (appid) => {
    const id = Number(appid || 0);
    if (!id) return "应用";
    const matched = applications.find((item) => item.id === id);
    return matched?.name || `应用 #${id}`;
  };
  const visibleMessages = useMemo(() => {
    let result = messages;
    if (showFavorites) {
      result = result.filter((item) => item.favorite);
    }
    if (selectedAppId !== "all") {
      result = result.filter((item) => String(item.appid) === selectedAppId);
    }
    const keyword = searchText.trim().toLowerCase();
    if (keyword) {
      result = result.filter(
        (item) =>
          (item.title && item.title.toLowerCase().includes(keyword)) ||
          (item.message && item.message.toLowerCase().includes(keyword))
      );
    }
    return result;
  }, [messages, selectedAppId, searchText, showFavorites]);

  // 二轮 S3：日期分组（今天/昨天/更早），列表按组渲染粘性头
  const groupedMessages = useMemo(() => {
    const groups: { label: string; items: MessageItem[] }[] = [];
    for (const item of visibleMessages) {
      const label = dateGroupLabel(item.date);
      if (groups.length && groups[groups.length - 1].label === label) {
        groups[groups.length - 1].items.push(item);
      } else {
        groups.push({ label, items: [item] });
      }
    }
    return groups;
  }, [visibleMessages]);

  // 二轮 S8：验证码提取走主进程单一真相（批量幂等，取前 100 条足够）
  useEffect(() => {
    if (!messages.length) {
      return;
    }
    const batch = messages.slice(0, 100).map((m) => ({ id: String(m.id), title: m.title, message: m.message }));
    window.gotifyAPI
      .extractCodes(batch.map(({ title, message }) => ({ title, message })))
      .then((codes) => {
        const next = new Map<string, string>();
        batch.forEach((b, i) => {
          if (codes[i]) {
            next.set(b.id, codes[i]);
          }
        });
        setCodeMap(next);
      })
      .catch(() => {});
  }, [messages]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        <div className="text-[20px]">加载中...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 二轮 S1/S6：工具栏直透 Mica；分段控件；齿轮/⋯ 上移；删自恋计数 */}
      <div className="flex items-center gap-2 px-4 py-2.5">
        <div className="flex rounded-md bg-black/[0.05] p-0.5 dark:bg-white/[0.06]">
          <button
            onClick={() => setShowFavorites(false)}
            className={`rounded px-3 py-1 text-[12px] transition-colors ${!showFavorites ? "bg-card text-text shadow-sm" : "text-text-muted hover:text-text-soft"}`}
          >
            全部
          </button>
          <button
            onClick={() => setShowFavorites(true)}
            className={`rounded px-3 py-1 text-[12px] transition-colors ${showFavorites ? "bg-card text-text shadow-sm" : "text-text-muted hover:text-text-soft"}`}
          >
            收藏
          </button>
        </div>
        <div className="relative w-44">
          <IconSearch className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <input
            value={searchText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setSearchText(event.target.value)}
            placeholder="搜索"
            className="h-8 w-full rounded-md border border-border bg-input pl-7 pr-6 text-[12px] text-text-soft outline-none focus:border-primary"
          />
          {searchText ? (
            <button onClick={() => setSearchText("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-soft">
              <IconClearText className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {/* 二轮 M1：分组下拉自绘（裸 select 深色下是全场最丑元素） */}
        <div className="relative">
          <button
            onClick={() => setGroupMenuOpen((prev) => !prev)}
            className="flex h-8 items-center gap-1 rounded-md border border-border bg-input px-2.5 text-[12px] text-text-soft hover:border-primary focus:outline-none"
          >
            <span className="max-w-[120px] truncate">{applicationOptions.find((o) => String(o.id) === selectedAppId)?.name || "全部分组"}</span>
            <IconMore className="h-3 w-3 rotate-90 text-text-muted" />
          </button>
          {groupMenuOpen ? (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setGroupMenuOpen(false)} />
              <div className="scroll-thin absolute left-0 top-full z-50 mt-1.5 max-h-64 min-w-[150px] overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-lg">
                {applicationOptions.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelectedAppId(String(item.id));
                      setGroupMenuOpen(false);
                    }}
                    className={`block w-full px-4 py-1.5 text-left text-[13px] hover:bg-card-hover ${String(item.id) === selectedAppId ? "font-semibold text-primary" : "text-text-soft"}`}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setSettingsOpen(true)}
          title="设置"
          className="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-black/[0.05] hover:text-text-soft focus:outline-none dark:hover:bg-white/[0.06]"
        >
          <IconGear className="h-4 w-4" />
        </button>
        <div className="relative">
          <button
            onClick={() => {
              setOverflowOpen((prev) => !prev);
              setConfirmClearArmed(false);
            }}
            title="更多"
            className="flex h-8 w-8 items-center justify-center rounded text-text-muted hover:bg-black/[0.05] hover:text-text-soft focus:outline-none dark:hover:bg-white/[0.06]"
          >
            <IconMore className="h-4 w-4" />
          </button>
          {overflowOpen ? (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => {
                  setOverflowOpen(false);
                  setConfirmClearArmed(false);
                }}
              />
              <div className="absolute right-0 top-full z-50 mt-1.5 min-w-[170px] rounded-md border border-border bg-panel py-1 shadow-lg">
                <button
                  onClick={() => {
                    setOverflowOpen(false);
                    onToggleConnection();
                  }}
                  className="block w-full px-4 py-2 text-left text-[13px] text-text-soft hover:bg-card-hover"
                >
                  {status.connected ? "断开连接" : "连接服务器"}
                </button>
                <div className="my-1 border-t border-border-light" />
                <button
                  onClick={() => {
                    if (!confirmClearArmed) {
                      setConfirmClearArmed(true);
                      return;
                    }
                    setConfirmClearArmed(false);
                    setOverflowOpen(false);
                    onClearMessages();
                  }}
                  disabled={visibleMessages.length === 0 || clearing}
                  className={`block w-full px-4 py-2 text-left text-[13px] hover:bg-danger-bg disabled:opacity-40 ${confirmClearArmed ? "font-semibold text-danger-text" : "text-danger-text"}`}
                >
                  {clearing ? "清空中..." : confirmClearArmed ? "再点一次确认清空" : "清空消息"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {banner ? <div className="bg-banner-bg px-4 py-1.5 text-[12px] text-banner-text">{banner}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-1">
        {/* 二轮 S1：列表容器=静态 layer 叠层露 Mica，去 border；行透明+hover 填充 */}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded-lg bg-layer">
          {visibleMessages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-text-muted">
              <IconInbox className="h-10 w-10 text-text-disabled" />
              <div className="text-[14px]">
                {showFavorites ? "暂无收藏消息" : searchText ? `没有匹配「${searchText}」的消息` : "暂无消息"}
              </div>
              <div className="text-[12px] text-text-disabled">
                {showFavorites ? "点击消息右侧星标即可收藏" : searchText ? "试试清空搜索词或切换分组" : "连接服务器后，推送的消息会显示在这里"}
              </div>
            </div>
          ) : (
            groupedMessages.map((group) => (
              <div key={group.label}>
                <div className="sticky top-0 z-10 bg-layer px-4 py-1 text-[11px] text-text-muted backdrop-blur-sm">{group.label}</div>
                <div className={wide ? "grid grid-cols-2 gap-x-2" : ""}>
                  {group.items.map((item) => (
                    <MessageCard
                      key={`${item.id}-${item.date}`}
                      item={item}
                      appLabel={getAppLabel(item.appid)}
                      onToggleFavorite={onToggleFavorite}
                      verificationCode={codeMap.get(String(item.id))}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      {/* 二轮 S6：底部只留状态（12px muted+彩点，报警器常开的日子结束了） */}
      <div className="flex items-center gap-2 px-4 pb-2.5 pt-1">
        <div className={`h-2 w-2 rounded-full ${dotColor}`}></div>
        <div className="text-[12px] text-text-muted">{status.status || "未连接"}</div>
      </div>
      {settingsOpen ? (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          initialConfig={config}
          appVersion={appVersion}
          onSave={onSave}
          onTest={onTest}
          testing={testing}
          saving={saving}
          notice={settingsNotice}
          storagePath={storagePath}
          draftStoragePath={draftStoragePath}
          setDraftStoragePath={setDraftStoragePath}
          onPickStoragePath={onPickStoragePath}
          onApplyStoragePath={onApplyStoragePath}
          applyingStoragePath={applyingStoragePath}
          storageLockedByEnv={storageLockedByEnv}
        />
      ) : null}
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
