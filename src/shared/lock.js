// 单实例锁：防止重复启动导致多条通知、重复 Toast
import fs from "node:fs";
import path from "node:path";

function isAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 进程存在但无权限，仍视作存活
  }
}

/**
 * 获取单实例锁。返回 { release, pid } 表示成功；返回 null 表示已有实例在运行。
 * 僵尸锁（进程已退出但锁文件残留）会被自动清理。
 */
export function acquireSingleInstance(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx"); // 原子创建，已存在则 EEXIST
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);

      const release = () => {
        try {
          if (Number(fs.readFileSync(lockFile, "utf8")) === process.pid) fs.unlinkSync(lockFile);
        } catch { /* 已被清理，忽略 */ }
      };
      process.on("exit", release);
      return { release, pid: process.pid };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      let pid = 0;
      try { pid = Number(fs.readFileSync(lockFile, "utf8").trim()) || 0; } catch { /* 空文件 */ }
      if (isAlive(pid)) return null;

      try { fs.unlinkSync(lockFile); } catch { /* 竞态下可能已被别人删掉 */ }
    }
  }
  return null;
}
