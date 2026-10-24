// 面板窗口 preload：仅暴露原生目录选择（浏览器里没有的能力）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aw2Panel", {
  pickFolder: (current) => ipcRenderer.invoke("aw2:pick-folder", current),
});
