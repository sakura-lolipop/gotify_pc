module.exports = {
  content: ["./index.html", "./renderer.tsx", "./src/**/*.{js,ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // 语义 token（CP6 双肤）：值在 src/tailwind.css 的 :root/.dark 变量表，
        // 换肤=html 挂/摘 .dark，单一事实=nativeTheme（themeSource 已解析手动覆盖）
        // 二轮新增立面 layer/layer-hover/stroke + banner/warn/star 收编硬编码色
        bg: "var(--bg)",
        panel: "var(--panel)",
        card: "var(--card)",
        "card-hover": "var(--card-hover)",
        input: "var(--input)",
        chrome: "var(--chrome)",
        layer: "var(--layer)",
        "layer-hover": "var(--layer-hover)",
        stroke: "var(--stroke)",
        border: "var(--border)",
        "border-light": "var(--border-light)",
        text: "var(--text)",
        "text-soft": "var(--text-soft)",
        "text-muted": "var(--text-muted)",
        "text-disabled": "var(--text-disabled)",
        primary: "var(--primary)",
        "primary-hover": "var(--primary-hover)",
        "banner-bg": "var(--banner-bg)",
        "banner-text": "var(--banner-text)",
        warn: "var(--warn)",
        star: "var(--star)",
        success: "var(--success-color)",
        danger: "var(--danger-text)",
        "danger-border": "var(--danger-border)",
        "danger-bg": "var(--danger-bg)",
        "danger-text": "var(--danger-text)"
      }
    }
  },
  plugins: []
};
