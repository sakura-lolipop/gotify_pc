; 2026-09-04 根治（layer-scan-2026-08-26 W4）：此前 customInstall 用裸
; CreateShortCut 重建开始菜单/桌面 .lnk，覆盖掉 electron-builder 自带
; AUMID 属性的快捷方式（build.appId=com.gotify.client.desktop），导致每次
; Setup 升级后归档 toast 退坑（横幅弹、通知中心无痕），需要手动重跑
; AumidShortcutFlags.ps1 重设。builder 配置已含 createDesktopShortcut/
; createStartMenuShortcut: true，此处不再自建，快捷方式全权交还 builder。
