const fs = require("node:fs");
const path = require("node:path");

class HistoryStore {
  constructor(userDataPath, maxMessages = 1000) {
    this.historyPath = path.join(userDataPath, "message_history.json");
    this.maxMessages = maxMessages;
    this.messages = this.load();
    this.persist();
  }

  load() {
    try {
      if (!fs.existsSync(this.historyPath)) {
        return [];
      }
      const raw = fs.readFileSync(this.historyPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return this.deduplicateMessages(parsed);
    } catch {
      return [];
    }
  }

  getAll() {
    return [...this.messages];
  }

  getMaxId() {
    // Watermark for REST catch-up: server ids only. Local-namespace ids are
    // strings and non-integer numbers cannot come from the server pipeline —
    // neither may ever raise the watermark or catch-up goes blind (L3).
    let max = 0;
    for (const item of this.messages) {
      const id = Number(item?.id);
      if (Number.isInteger(id) && id > max) {
        max = id;
      }
    }
    return max;
  }

  add(message) {
    const exists = this.messages.some((item) => Number(item.id) === Number(message.id) && Number(message.id) > 0);
    if (exists) {
      return;
    }
    this.messages.unshift(message);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(0, this.maxMessages);
    }
    this.persist();
  }

  clear() {
    this.messages = [];
    this.persist();
  }

  toggleFavorite(id) {
    const targetId = Number(id);
    const message = this.messages.find((m) => Number(m.id) === targetId);
    if (message) {
      message.favorite = !message.favorite;
      this.persist();
      return message.favorite;
    }
    return false;
  }

  persist() {
    try {
      fs.writeFileSync(this.historyPath, JSON.stringify(this.messages, null, 2), "utf8");
    } catch (error) {
      console.error("Failed to save message history:", error);
    }
  }

  deduplicateMessages(messages) {
    const deduped = [];
    const seenIds = new Set();
    for (const item of messages) {
      const id = Number(item?.id);
      if (Number.isFinite(id) && id > 0) {
        if (seenIds.has(id)) {
          continue;
        }
        seenIds.add(id);
      }
      deduped.push(item);
    }
    if (deduped.length > this.maxMessages) {
      return deduped.slice(0, this.maxMessages);
    }
    return deduped;
  }
}

module.exports = {
  HistoryStore
};
