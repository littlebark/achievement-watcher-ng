// 安全桥：渲染进程只拿这三个能力，无 Node 权限
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aw2", {
  onAchievement: (cb) => ipcRenderer.on("aw2:achievement", (_e, data) => cb(data)),
  openPanel: () => ipcRenderer.invoke("aw2:openPanel"),
  setIgnore: (ignore) => ipcRenderer.send("aw2:set-ignore", ignore),
});
