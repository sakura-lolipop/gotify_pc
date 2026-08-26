// 确定性应用头像（二轮 M2）：appid 哈希到 8 色相盘取底色 + 应用名首字。
// 不连网拉远程图标（离线/延迟复杂化）；主进程通知卡与渲染层列表共用此模块
// （单一真相，两侧不许各自重写配色）。

const AVATAR_PALETTE = ["#e11d48", "#ea580c", "#d97706", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777"];

function avatarColor(appid) {
  const id = Number(appid || 0);
  // Knuth 乘法哈希取正模，同一应用永远同色
  const hashed = Math.abs(Math.imul(id, 2654435761) >>> 0);
  return AVATAR_PALETTE[hashed % AVATAR_PALETTE.length];
}

function avatarLabel(name, appid) {
  const trimmed = String(name || "").trim();
  if (trimmed) {
    return trimmed[0];
  }
  return appid ? String(appid) : "?";
}

module.exports = { avatarColor, avatarLabel };
