// Windows 原生小工具：注册表读取（reg.exe）、进程检查（tasklist.exe）—— 替代 regodit / win-tasklist
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// 读取 REG_SZ/REG_DWORD 值；返回字符串或 null
export async function regQuery(root, keyPath, valueName) {
  const key = `${root}\\${keyPath.replace(/\//g, "\\")}`;
  try {
    const args = valueName ? [key, "/v", valueName] : [key, "/ve"];
    const { stdout } = await run("reg.exe", args, { timeout: 5000, windowsHide: true });
    // 输出形如 "    Personal    REG_EXPAND_SZ    C:\Users\xxx\Documents"
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.*)$/i);
      if (m) {
        let val = m[1].trim();
        const hex = val.match(/^0x([0-9a-f]+)$/i);
        if (hex) return String(parseInt(hex[1], 16));
        return val;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// 枚举某 key 下所有子键名
export async function regSubKeys(root, keyPath) {
  const key = `${root}\\${keyPath.replace(/\//g, "\\")}`;
  try {
    const { stdout } = await run("reg.exe", [key, "query"], { timeout: 5000, windowsHide: true });
    const prefix = key.replace(/\\/g, "\\") + "\\";
    const keys = [];
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("HKEY_") && t.toLowerCase().startsWith(key.toLowerCase() + "\\")) {
        keys.push(t.slice(key.length + 1));
      }
    }
    return keys;
  } catch {
    return null;
  }
}

// 枚举某 key 下所有值名
export async function regValueNames(root, keyPath) {
  const key = `${root}\\${keyPath.replace(/\//g, "\\")}`;
  try {
    const { stdout } = await run("reg.exe", [key], { timeout: 5000, windowsHide: true });
    const names = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s{4}(.+?)\s+REG_/);
      if (m && m[1] !== "(默认)" && m[1] !== "(Default)") names.push(m[1].trim());
    }
    return names;
  } catch {
    return null;
  }
}

export async function isProcessRunning(binaryName) {
  try {
    const { stdout } = await run("tasklist.exe", ["/FI", `IMAGENAME eq ${binaryName}`, "/NH"], { timeout: 8000, windowsHide: true });
    return stdout.toLowerCase().includes(binaryName.toLowerCase());
  } catch {
    return false;
  }
}

// 用户"文档"目录（经 Shell Folders 注册表，处理重定向）
export async function getMyDocuments() {
  const p = await regQuery("HKCU", "Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders", "Personal");
  if (p) return p.replace(/%USERPROFILE%/gi, process.env.USERPROFILE || "");
  return path_join_documents_fallback();
}

function path_join_documents_fallback() {
  return `${process.env.USERPROFILE}\\Documents`;
}
