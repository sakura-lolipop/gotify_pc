const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gotifyAPI", {
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  getThemeState: () => ipcRenderer.invoke("theme:get"),
  extractCodes: (items) => ipcRenderer.invoke("code:extractBatch", items),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  probeClipboardCapability: (payload) => ipcRenderer.invoke("clipboard:probeCapability", payload),
  getClipboardHistory: () => ipcRenderer.invoke("clipboard:getHistory"),
  replayClipboardHistory: (entry) => ipcRenderer.invoke("clipboard:replay", entry),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getSoundList: () => ipcRenderer.invoke("sounds:list"),
  previewSound: (value) => ipcRenderer.invoke("sounds:read", value),
  uploadSound: () => ipcRenderer.invoke("sounds:upload"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  notifyTest: (face, acrylic) => ipcRenderer.invoke("notify:test", face, acrylic),
  setWindowMaterial: (material) => ipcRenderer.invoke("theme:setMaterial", material),
  getMessages: () => ipcRenderer.invoke("messages:get"),
  clearMessages: () => ipcRenderer.invoke("messages:clear"),
  toggleFavorite: (id) => ipcRenderer.invoke("messages:toggleFavorite", id),
  getApplications: () => ipcRenderer.invoke("applications:get"),
  testConnection: (payload) => ipcRenderer.invoke("connection:test", payload),
  toggleConnection: () => ipcRenderer.invoke("connection:toggle"),
  getConnectionStatus: () => ipcRenderer.invoke("connection:getStatus"),
  getStoragePath: () => ipcRenderer.invoke("storage:getPath"),
  openStoragePath: () => ipcRenderer.invoke("storage:open"),
  pickStoragePath: () => ipcRenderer.invoke("storage:pickPath"),
  setStoragePath: (nextPath) => ipcRenderer.invoke("storage:setPath", nextPath),
  onConnectionStatus: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on("connection-status", listener);
    return () => ipcRenderer.removeListener("connection-status", listener);
  },
  onThemeUpdated: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on("theme-updated", listener);
    return () => ipcRenderer.removeListener("theme-updated", listener);
  },
  onNewMessage: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on("new-message", listener);
    return () => ipcRenderer.removeListener("new-message", listener);
  },
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("open-settings", listener);
    return () => ipcRenderer.removeListener("open-settings", listener);
  },
  onMessagesCleared: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("messages-cleared", listener);
    return () => ipcRenderer.removeListener("messages-cleared", listener);
  }
});
