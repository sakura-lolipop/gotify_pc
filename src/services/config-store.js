const fs = require("node:fs");
const path = require("node:path");

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
  theme: "system",
  minimizeToTray: true,
  showMainWindowOnStartup: true,
  autoLaunch: false,
  enableReconnect: true,
  autoRefreshInterval: 10000,
  barkServerUrl: "",
  barkForwardApps: [], // Array of app IDs to forward, empty means none (or all? let's make it explicit selection)
  mutedNotificationApps: [] // Array of app IDs to mute popup notifications
};

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
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  get() {
    return { ...this.config };
  }

  save(nextConfig) {
    this.config = { ...DEFAULT_CONFIG, ...nextConfig };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
    return this.get();
  }
}

module.exports = {
  ConfigStore,
  DEFAULT_CONFIG
};
