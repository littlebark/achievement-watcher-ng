// 成就文件内容 → 统一模型
// 统一模型: { name, Achieved, CurProgress, MaxProgress, UnlockTime, crc? }
// 移植自原版 monitor.parse / steam.getAchievementsFromFile（含各家模拟器特判）
import path from "node:path";
import * as ini from "../../shared/ini.js";
import { readSSEBin } from "./sse-bin.js";

const FILTER = ["SteamAchievements", "Steam64", "Steam"];

function hexToUint32LE(hexStr) {
  return new DataView(new Uint8Array(Buffer.from(String(hexStr), "hex")).buffer).getUint32(0, true);
}

// root: 解析后的原始对象 → 统一 entries
function unify(local) {
  let result = {};

  if (local.AchievementsUnlockTimes && local.Achievements) {
    // Hoodlum / DARKSiDERS：两个 section 拼合
    for (const i of Object.keys(local.Achievements)) {
      if (local.Achievements[i] == 1) {
        result[i] = { Achieved: "1", UnlockTime: local.AchievementsUnlockTimes[i] || null };
      }
    }
  } else if (local.State && local.Time) {
    // 3DM：State=0101 + Time 为 hex 的 uint32 小端
    for (const i of Object.keys(local.State)) {
      if (local.State[i] == "0101") {
        result[i] = { Achieved: "1", UnlockTime: hexToUint32LE(local.Time[i]) || null };
      }
    }
  } else {
    result = local.ACHIEVE_DATA || local;
    for (const k of FILTER) delete result[k];
  }

  const entries = [];
  for (const key of Object.keys(result)) {
    try {
      const raw = result[key];
      if (typeof raw !== "object" || raw === null) {
        if (raw === "1" || raw === 1) entries.push({ name: key, Achieved: true, CurProgress: 0, MaxProgress: 0, UnlockTime: 0 });
        continue;
      }

      // RLD!：hex 字段 uint32 小端
      if (raw.State !== undefined && typeof raw.State === "string" && /^[0-9a-f]+$/i.test(raw.State) && raw.State.length >= 8) {
        try {
          raw.State = hexToUint32LE(raw.State);
          raw.CurProgress = hexToUint32LE(raw.CurProgress);
          raw.MaxProgress = hexToUint32LE(raw.MaxProgress);
          raw.Time = hexToUint32LE(raw.Time);
        } catch { /* ignore */ }
      } else if (raw.unlocktime && String(raw.unlocktime).length === 7) {
        // CreamAPI：时间戳残缺，补毫秒位
        raw.unlocktime = +raw.unlocktime * 1000;
      }

      // 数字字段统一为 number（INI 里全是字符串）
      const num = (v) => (v === undefined || v === null || v === "" || isNaN(+v) ? 0 : +v);

      const entry = {
        name: raw.id || raw.apiname || raw.name || key,
        Achieved: (raw.Achieved == 1 || raw.achieved == 1 || raw.State == 1 ||
                   raw.HaveAchieved == 1 || raw.Unlocked == 1 || raw.earned === true || raw === "1") ? true : false,
        CurProgress: num(raw.CurProgress ?? raw.progress),
        MaxProgress: num(raw.MaxProgress ?? raw.max_progress),
        UnlockTime: num(raw.UnlockTime ?? raw.unlocktime ?? raw.unlock_time ?? raw.HaveAchievedTime ??
                    raw.HaveHaveAchievedTime ?? raw.Time ?? raw.earned_time),
      };

      // CODEX Gears5 (2019-09) / Gears Tactics (2020-05)：进度满即视为解锁
      if (!entry.Achieved && entry.MaxProgress != 0 && entry.CurProgress != 0 && entry.MaxProgress == entry.CurProgress) {
        entry.Achieved = true;
      }

      if (raw.crc) entry.crc = raw.crc;
      entries.push(entry);
    } catch { /* 跳过坏条目 */ }
  }

  entries.sort((a, b) => b.UnlockTime - a.UnlockTime);
  return entries;
}

// filePath: 成就文件绝对路径（achievements.ini / achievements.json / stats.bin ...）
export async function parseAchievementFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  let local;

  if (base === "achievements.json") {
    local = JSON.parse(await (await import("node:fs/promises")).readFile(filePath, "utf8"));
  } else if (base === "stats.bin") {
    return readSSEBin(await (await import("node:fs/promises")).readFile(filePath));
  } else if (base.endsWith(".bin") || base.endsWith(".dat")) {
    local = ini.parse((await (await import("node:fs/promises")).readFile(filePath, "utf8")).toString());
  } else {
    local = ini.parse(await (await import("node:fs/promises")).readFile(filePath, "utf8"));
  }

  return unify(local);
}

export { unify };
