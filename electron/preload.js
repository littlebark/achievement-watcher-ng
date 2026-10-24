// 安全桥：渲染进程只拿这三个能力，无 Node 权限
// 注意：preload 必须用 CommonJS（sandbox 渲染进程不支持 ESM import，.js 后缀按 CJS 解析）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aw2", {
  onAchievement: (cb) => ipcRenderer.on("aw2:achievement", (_e, data) => cb(data)),
  openPanel: () => ipcRenderer.invoke("aw2:openPanel"),
  setIgnore: (ignore) => ipcRenderer.send("aw2:set-ignore", ignore),
});
