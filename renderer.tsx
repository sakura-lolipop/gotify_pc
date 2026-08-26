import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import { createRoot } from "react-dom/client";

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
  open: boolean;
  onClose: () => void;
  config: Config;
  appVersion: string;
  setConfig: Dispatch<SetStateAction<Config>>;
  onSave: () => void;
  onTest: () => void;
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
type GotifyAPI = {
  getAppVersion: () => Promise<string>;
  getConfig: () => Promise<Partial<Config>>;
  saveConfig: (config: Config) => Promise<Config>;
  testConnection: (payload: { serverUrl: string; clientToken: string }) => Promise<void>;
  toggleConnection: () => Promise<void>;
  getConnectionStatus: () => Promise<ConnectionStatus>;
  getMessages: () => Promise<MessageItem[]>;
  clearMessages: () => Promise<void>;
  onConnectionStatus: (cb: (payload: ConnectionStatus) => void) => () => void;
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

function SettingsModal({
  open,
  onClose,
  config,
  appVersion,
  setConfig,
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

  useEffect(() => {
    if (open) {
      window.gotifyAPI.getApplications().then((apps) => {
        setApplications(Array.isArray(apps) ? apps : []);
      });
    }
  }, [open]);

  const onServerUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, serverUrl: event.target.value }));
  };
  const onTokenChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, clientToken: event.target.value }));
  };
  const onShowCustomNotificationChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, showCustomNotification: event.target.checked }));
  };
  const onPlaySoundChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, playSound: event.target.checked }));
  };
  const onEnableReconnectChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, enableReconnect: event.target.checked }));
  };
  const onAutoHideChange = (event: ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    setConfig((prev) => ({ ...prev, notificationAutoHide: checked, notificationNeverClose: checked ? false : prev.notificationNeverClose }));
  };
  const onNeverCloseChange = (event: ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    setConfig((prev) => ({ ...prev, notificationNeverClose: checked, notificationAutoHide: checked ? false : prev.notificationAutoHide }));
  };
  const onDurationChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, notificationDuration: Number(event.target.value || 0) }));
  };
  const onArchiveExpiryChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, archiveExpiryMinutes: Number(event.target.value || 0) }));
  };
  const onCodeSmartExpiryChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, codeSmartExpiry: event.target.checked }));
  };
  const onMinimizeToTrayChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, minimizeToTray: event.target.checked }));
  };
  const onShowOnStartupChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, showMainWindowOnStartup: event.target.checked }));
  };
  const onAutoLaunchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, autoLaunch: event.target.checked }));
  };
  const onBarkUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({ ...prev, barkServerUrl: event.target.value }));
  };
  const onMutedNotificationAppToggle = (id: number) => {
    setConfig((prev) => {
      const current = Array.isArray(prev.mutedNotificationApps) ? prev.mutedNotificationApps : [];
      if (current.includes(id)) {
        return { ...prev, mutedNotificationApps: current.filter((x) => x !== id) };
      }
      return { ...prev, mutedNotificationApps: [...current, id] };
    });
  };
  const onBarkAppToggle = (id: number) => {
    setConfig((prev) => {
      const current = Array.isArray(prev.barkForwardApps) ? prev.barkForwardApps : [];
      if (current.includes(id)) {
        return { ...prev, barkForwardApps: current.filter((x) => x !== id) };
      }
      return { ...prev, barkForwardApps: [...current, id] };
    });
  };
  const onDraftStoragePathChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDraftStoragePath(event.target.value);
  };
  const onOpenStoragePath = async () => {
    try {
      await window.gotifyAPI.openStoragePath();
    } catch {
      // ignore
    }
  };
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
      <div className="absolute inset-0 bg-black/35" onClick={onClose}></div>
      <div className="relative flex w-[700px] max-h-[86vh] max-w-[92vw] flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="border-b px-5 py-3 text-[28px] font-bold text-slate-800">Gotify 客户端设置</div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-[14px]">
          <div className="flex items-center gap-3">
            <div className="w-32 text-[14px] font-bold whitespace-nowrap">服务器地址:</div>
            <input
              value={config.serverUrl}
              onChange={onServerUrlChange}
              placeholder="https://your-gotify.example.com"
              className="h-9 flex-1 rounded border px-3 text-[14px] outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="w-32 text-[14px] font-bold whitespace-nowrap">客户端令牌:</div>
            <input
              type={showToken ? "text" : "password"}
              value={config.clientToken}
              onChange={onTokenChange}
              placeholder="Client Token"
              className="h-9 flex-1 rounded border px-3 text-[14px] outline-none focus:border-blue-500"
            />
            <button onClick={() => setShowToken((v) => !v)} className="h-9 rounded border px-3 text-[13px]">
              {showToken ? "隐藏" : "显示"}
            </button>
          </div>
          <div className="rounded border bg-slate-50 p-3">
            <div className="mb-2 text-[15px] font-bold">通知设置</div>
            <div className="grid grid-cols-2 gap-y-2 text-[14px]">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.showCustomNotification} onChange={onShowCustomNotificationChange} />
                显示自定义弹窗通知
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.playSound} onChange={onPlaySoundChange} />
                播放提示音
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.enableReconnect} onChange={onEnableReconnectChange} />
                启用主动重连
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.notificationAutoHide} onChange={onAutoHideChange} />
                通知自动消失
              </label>
            </div>
            <div className="mt-2">
              <label className="flex items-center gap-2 text-red-600 text-[14px]">
                <input type="checkbox" checked={config.notificationNeverClose} onChange={onNeverCloseChange} />
                永不自动关闭
              </label>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[14px]">
              <div className="whitespace-nowrap">通知持续时间(毫秒):</div>
              <input
                type="number"
                value={config.notificationDuration}
                onChange={onDurationChange}
                min={1000}
                step={1000}
                disabled={!config.notificationAutoHide || config.notificationNeverClose}
                className="h-9 w-28 rounded border px-2 text-[14px] disabled:bg-slate-100"
              />
              <div className="text-slate-500 whitespace-nowrap">(仅在自动消失启用时)</div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[14px]">
              <div className="whitespace-nowrap">通知中心留档(分钟):</div>
              <input
                type="number"
                value={config.archiveExpiryMinutes}
                onChange={onArchiveExpiryChange}
                min={1}
                step={5}
                className="h-9 w-28 rounded border px-2 text-[14px]"
              />
              <div className="text-slate-500 whitespace-nowrap">(每条消息在系统通知中心的保留时长)</div>
            </div>
            <div className="mt-2">
              <label className="flex items-center gap-2 text-[14px]">
                <input type="checkbox" checked={config.codeSmartExpiry} onChange={onCodeSmartExpiryChange} />
                验证码按短信有效期留档
              </label>
              <div className="mt-1 text-[12px] text-slate-400">勾选后验证码消息按短信中的「N分钟」留档，识别不到时回落到上方时长</div>
            </div>
            <div className="mt-3">
              <div className="mb-1 text-[12px] font-semibold text-slate-600">屏蔽弹窗分组:</div>
              <div className="max-h-24 overflow-y-auto rounded border bg-white p-2">
                {applications.length === 0 ? (
                  <div className="text-[12px] text-slate-400">暂无应用分组，请先连接服务器</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {applications.map((app) => (
                      <label key={app.id} className="flex items-center gap-2 text-[12px] text-slate-700">
                        <input
                          type="checkbox"
                          checked={config.mutedNotificationApps?.includes(app.id)}
                          onChange={() => onMutedNotificationAppToggle(app.id)}
                        />
                        {app.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-1 text-[12px] text-slate-400">选中的分组将不再显示弹窗提醒</div>
            </div>
          </div>
          <div className="rounded border bg-slate-50 p-3">
            <div className="mb-2 text-[15px] font-bold">Bark 消息转发</div>
            <div className="space-y-2">
              <div className="text-[13px] text-slate-600">将收到的消息转发到 iOS Bark App</div>
              <input
                value={config.barkServerUrl || ""}
                onChange={onBarkUrlChange}
                placeholder="https://api.day.app/YOUR_KEY"
                className="h-9 w-full rounded border px-2 text-[13px] outline-none focus:border-blue-500"
              />
              <div className="text-[12px] font-semibold text-slate-600">选择要转发的应用分组:</div>
              <div className="max-h-24 overflow-y-auto rounded border bg-white p-2">
                {applications.length === 0 ? (
                  <div className="text-[12px] text-slate-400">暂无应用分组，请先连接服务器</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {applications.map((app) => (
                      <label key={app.id} className="flex items-center gap-2 text-[12px] text-slate-700">
                        <input
                          type="checkbox"
                          checked={config.barkForwardApps?.includes(app.id)}
                          onChange={() => onBarkAppToggle(app.id)}
                        />
                        {app.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="rounded border bg-slate-50 p-3">
            <div className="mb-2 text-[15px] font-bold">数据存储</div>
            <div className="space-y-2">
              <div className="text-[13px] text-slate-600">当前数据存储路径</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded border bg-white px-2 py-1.5 text-[12px] text-slate-600 break-all">
                  {storagePath || "-"}
                </div>
                <button
                  onClick={onOpenStoragePath}
                  disabled={!storagePath}
                  className="h-8 whitespace-nowrap rounded border border-blue-500 px-3 text-[12px] text-blue-600 hover:bg-blue-50 disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  打开目录
                </button>
              </div>
              <div className="text-[12px] text-slate-400">如需迁移数据，请手动复制文件到新目录</div>
            </div>
          </div>
          <div className="rounded border bg-slate-50 p-3">
            <div className="mb-2 text-[15px] font-bold">其他设置</div>
            <div className="space-y-1.5 text-[14px]">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.minimizeToTray} onChange={onMinimizeToTrayChange} />
                最小化到系统托盘
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.autoLaunch} onChange={onAutoLaunchChange} />
                开机自动启动
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.showMainWindowOnStartup} onChange={onShowOnStartupChange} />
                启动时显示主界面
              </label>
            </div>
            <div className="mt-3 border-t border-slate-200 pt-2 text-[13px] text-slate-500">
              版本号: <span className="font-mono text-slate-700">{appVersion || "-"}</span>
            </div>
          </div>
        </div>
        <div className="shrink-0 flex items-center justify-between gap-3 border-t bg-slate-50 px-5 py-3">
          <div className={`flex-1 min-w-0 break-words text-[14px] font-semibold leading-tight ${notice?.type === "error" ? "text-red-600" : "text-green-600"}`}>
            {notice?.text || ""}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button onClick={onTest} disabled={testing} className="h-9 whitespace-nowrap rounded border px-3 text-[13px] disabled:opacity-50">
              {testing ? "测试中..." : "测试连接"}
            </button>
            <button onClick={onSave} disabled={saving} className="h-9 whitespace-nowrap rounded bg-blue-600 px-3 text-[13px] text-white disabled:opacity-50">
              {saving ? "保存中..." : "保存"}
            </button>
            <button onClick={onClose} className="h-9 whitespace-nowrap rounded border px-3 text-[13px]">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageCard({ item, appLabel, onToggleFavorite }: { item: MessageItem; appLabel?: string; onToggleFavorite: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const priorityColor = item.priority >= 8 ? "bg-red-500" : item.priority >= 4 ? "bg-blue-500" : "bg-green-500";
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
  return (
    <div className="flex gap-3 border-b bg-white px-4 py-3 hover:bg-blue-50">
      <div className={`w-1 rounded-full ${priorityColor}`}></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="truncate text-[20px] font-bold text-slate-800">{item.title || "无标题"}</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => item.id && onToggleFavorite(item.id)}
              className="text-slate-400 hover:text-amber-400 focus:outline-none"
              title={item.favorite ? "取消收藏" : "收藏"}
            >
              {item.favorite ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-amber-400">
                  <path
                    fillRule="evenodd"
                    d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.563.044.793.745.362 1.116l-4.208 3.527a.562.562 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.208-3.527c-.433-.371-.202-1.072.362-1.116l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
                  />
                </svg>
              )}
            </button>
            <div className="whitespace-nowrap text-[14px] text-slate-400">{formatDate(item.date)}</div>
          </div>
        </div>
        <div className="mt-1 text-[14px] text-slate-500">{appLabel || `应用 #${item.appid || 0}`}</div>
        <div className="mt-1 text-[16px] text-slate-700 whitespace-pre-wrap break-words">{visibleMessage}</div>
        {canCollapse ? (
          <button onClick={() => setExpanded((prev) => !prev)} className="mt-1 text-[13px] text-blue-600 hover:text-blue-700">
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

  const statusColor = useMemo(() => {
    if (status.connected) return "text-green-600";
    if (status.status.includes("重连")) return "text-amber-500";
    return "text-red-500";
  }, [status]);

  const dotColor = status.connected
    ? "bg-green-500 ring-green-200"
    : status.status.includes("重连")
      ? "bg-amber-500 ring-amber-200"
      : "bg-red-500 ring-red-200";

  const onSave = async () => {
    setSaving(true);
    try {
      const saved = await window.gotifyAPI.saveConfig(config);
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

  const onTest = async () => {
    setTesting(true);
    try {
      await window.gotifyAPI.testConnection({
        serverUrl: config.serverUrl,
        clientToken: config.clientToken,
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

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        <div className="text-[20px]">加载中...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between bg-white px-3 py-2 shadow-sm">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowFavorites(false)}
            className={`text-[16px] font-bold ${!showFavorites ? "text-slate-700" : "text-slate-400 hover:text-slate-600"}`}
          >
            历史消息
          </button>
          <button
            onClick={() => setShowFavorites(true)}
            className={`text-[16px] font-bold ${showFavorites ? "text-slate-700" : "text-slate-400 hover:text-slate-600"}`}
          >
            我的收藏
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <input
              value={searchText}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setSearchText(event.target.value)}
              placeholder="搜索消息..."
              className="h-8 w-40 rounded border border-slate-200 bg-white pl-2 pr-7 text-[12px] text-slate-600 outline-none focus:border-blue-500"
            />
            {searchText ? (
              <button onClick={() => setSearchText("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            ) : null}
          </div>
          <select
            value={selectedAppId}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setSelectedAppId(event.target.value)}
            className="h-8 rounded border border-slate-200 bg-white px-2 text-[12px] text-slate-600"
          >
            {applicationOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="text-[14px] text-slate-500">{visibleMessages.length} 条消息</div>
        </div>
      </div>
      {banner ? <div className="bg-blue-50 px-3 py-2 text-[14px] text-blue-700">{banner}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col p-3 pt-0">
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded border bg-white">
          {visibleMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-slate-400">暂无消息</div>
          ) : (
            visibleMessages.map((item) => (
              <MessageCard
                key={`${item.id}-${item.date}`}
                item={item}
                appLabel={getAppLabel(item.appid)}
                onToggleFavorite={onToggleFavorite}
              />
            ))
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ring-2 ${dotColor}`}></div>
            <div className={`text-[14px] font-semibold ${statusColor}`}>{status.status || "未连接"}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onToggleConnection} className="h-10 rounded border border-slate-200 px-4 text-[14px] text-slate-700">
              {status.connected ? "断开" : "连接"}
            </button>
            <button onClick={() => setSettingsOpen(true)} className="h-10 rounded border border-slate-200 px-4 text-[14px] text-slate-700">
              设置
            </button>
            <button
              onClick={onClearMessages}
              disabled={visibleMessages.length === 0 || clearing}
              className="h-10 rounded border border-red-400 px-4 text-[14px] text-red-500 disabled:opacity-40"
            >
              {clearing ? "清空中..." : "清空消息"}
            </button>
          </div>
        </div>
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        appVersion={appVersion}
        setConfig={setConfig}
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
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
