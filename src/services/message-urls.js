// 消息 URL 提取单一真相:notifier 弹卡与 renderer 列表共用(两处消费,
// 之前各写一份三路合并=同逻辑两家的前兆)。
// 三路合并去重:extras client::notification.click.url(Hotify 媒体下载)、
// extras client::notification.bigImageUrl(单图大图,gotify 官方安卓同源
// 字段,Hotify gotifylite.go:306-311 注入)、正文裸 http(s) 兜底。
function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function extractMessageUrls(message) {
  const urls = [];
  const extras = message?.extras;
  if (extras && typeof extras === "object") {
    const notification = extras["client::notification"];
    if (notification && typeof notification === "object") {
      const click = notification.click;
      if (click && typeof click === "object" && isHttpUrl(click.url)) {
        urls.push(click.url);
      }
      if (isHttpUrl(notification.bigImageUrl)) {
        urls.push(notification.bigImageUrl);
      }
    }
  }
  const body = String(message?.message || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  urls.push(...body);
  return Array.from(new Set(urls)).slice(0, 5);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

module.exports = { extractMessageUrls, hostOf };
