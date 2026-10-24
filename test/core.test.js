// 核心解析/匹配单测（node:test，无外部依赖）
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/shared/ini.js";
import { unify, parseAchievementFile } from "../src/core/normalize/file-parsers.js";
import { readSSEBin } from "../src/core/normalize/sse-bin.js";
import { matchAchievements } from "../src/core/match.js";
import { crc32hex } from "../src/shared/crc32.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------- ini ----------
test("ini.parse 基本行为", () => {
  const obj = parse("[NEW_ACHIEVEMENT_1_1]\r\nAchieved=1\r\nCurProgress=0\r\nUnlockTime=1600000000\r\n[SteamAchievements]\r\n00000=NEW_ACHIEVEMENT_1_1\r\nCount=1\r\n");
  assert.equal(obj.NEW_ACHIEVEMENT_1_1.Achieved, "1");
  assert.equal(obj.SteamAchievements.Count, "1");
});

// ---------- 通用 ini（Goldberg/CODEX 风格）----------
test("goldberg achievements.ini 解析", () => {
  const local = parse(`
[ACH_WIN_ONE_GAME]
Achieved=1
CurProgress=0
MaxProgress=0
UnlockTime=1700000000
[ACH_TRADE]
Achieved=0
Achieved2=0
[SteamAchievements]
Count=1
`);
  const entries = unify(local);
  const win = entries.find((e) => e.name === "ACH_WIN_ONE_GAME");
  assert.equal(win.Achieved, true);
  assert.equal(win.UnlockTime, 1700000000);
  assert.equal(entries.find((e) => e.name === "ACH_TRADE").Achieved, false);
});

// ---------- goldberg json ----------
test("goldberg achievements.json 解析", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aw2-"));
  const file = path.join(dir, "achievements.json");
  await writeFile(file, JSON.stringify([
    { name: "ACH1", achieved: 1, unlock_time: 1700000000 },
    { name: "ACH2", achieved: 0, unlock_time: 0 },
  ]));
  const entries = await parseAchievementFile(file);
  assert.equal(entries[0].name, "ACH1");
  assert.equal(entries[0].Achieved, true);
  assert.equal(entries[0].UnlockTime, 1700000000);
});

// ---------- Hoodlum：Achievements + AchievementsUnlockTimes ----------
test("hoodlum 双 section 拼合", () => {
  const local = parse(`
[Achievements]
ACH_A=1
ACH_B=0
[AchievementsUnlockTimes]
ACH_A=1650000000
`);
  const entries = unify(local);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "ACH_A");
  assert.equal(entries[0].UnlockTime, 1650000000);
});

// ---------- 3DM：State=0101 + hex 时间 ----------
test("3DM State/Time hex 解析", () => {
  const ts = 1700000000;
  const hex = Buffer.from(new Uint32Array([ts]).buffer).toString("hex"); // LE
  const local = parse(`
[State]
ACH_X=0101
ACH_Y=0000
[Time]
ACH_X=${hex}
ACH_Y=${hex}
`);
  const entries = unify(local);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].Achieved, true);
  assert.equal(entries[0].UnlockTime, ts);
});

// ---------- CODEX：进度满 = 解锁 ----------
test("CODEX progress==max 视为解锁", () => {
  const local = parse(`
[ACH_P]
Achieved=0
CurProgress=10
MaxProgress=10
UnlockTime=0
`);
  const entries = unify(local);
  assert.equal(entries[0].Achieved, true);
});

// ---------- SSE stats.bin ----------
test("SSE stats.bin 二进制解析 + crc 匹配", () => {
  const count = 2;
  const header = Buffer.alloc(4);
  header.writeInt32LE(count);

  function entry(name, achieved, unlockTime) {
    const b = Buffer.alloc(24);
    b.write(name.slice(0, 4), 0);          // 前 4 字节：api_name 的 crc 原始字节（测试用名字模拟）
    b.writeInt32LE(0, 4);
    b.writeInt32LE(unlockTime, 8);
    b.writeInt32LE(achieved, 20);
    return b;
  }

  const buf = Buffer.concat([header, entry("abcd", 1, 1700000000), entry("efgh", 0, 0)]);
  const result = readSSEBin(buf);
  assert.equal(result.length, 2);
  assert.equal(result[0].Achieved, 1);
  assert.equal(result[0].UnlockTime, 1700000000);

  // crc 字段与 schema 匹配：schema 的 apiname 为 "TEST"，其 crc32hex 应被包含
  const schemaName = "TEST";
  const crcOfTest = crc32hex(Buffer.from(schemaName));
  const local = [{ crc: crcOfTest, Achieved: 1, UnlockTime: 1700000000 }];
  const pairs = matchAchievements([{ name: schemaName, displayName: "Test Ach" }], local);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].schemaAchievement.name, "TEST");
});

// ---------- 匹配：大小写不敏感 ----------
test("name 匹配大小写不敏感", () => {
  const pairs = matchAchievements(
    [{ name: "ACH_WIN_ONE_GAME", displayName: "Winner" }],
    [{ name: "ach_win_one_game", Achieved: true, CurProgress: 0, MaxProgress: 0, UnlockTime: 1 }]
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].schemaAchievement.displayName, "Winner");
});

// ---- wall.normalizeProgress ----
const { normalizeProgress } = await import("../src/core/wall.js");

test("wall: 归一化为 Steam 成就字段标准", () => {
  const schemaList = [
    { name: "ACH_A", displayName: "A" },
    { name: "ACH_B", displayName: "B" },
    { name: "ACH_C", displayName: "进度型" },
  ];
  const pairs = [
    { schemaAchievement: schemaList[0], local: { Achieved: true, CurProgress: 0, MaxProgress: 0, UnlockTime: 1700000000 } },
    { schemaAchievement: schemaList[2], local: { Achieved: false, CurProgress: 12, MaxProgress: 20, UnlockTime: 0 } },
  ];
  const previous = [{ name: "ACH_B", Achieved: true, CurProgress: 0, MaxProgress: 0, UnlockTime: 1690000000 }];
  const out = normalizeProgress(schemaList, pairs, previous);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { name: "ACH_A", achieved: 1, unlockTime: 1700000000, curProgress: 0, maxProgress: 0 });
  // 文件里没有、track 缓存里有 → 用缓存
  assert.deepEqual(out[1], { name: "ACH_B", achieved: 1, unlockTime: 1690000000, curProgress: 0, maxProgress: 0 });
  // 进度型
  assert.equal(out[2].achieved, 0);
  assert.equal(out[2].curProgress, 12);
  assert.equal(out[2].maxProgress, 20);
});

test("wall: schema 与缓存都缺时回退为未解锁", () => {
  const out = normalizeProgress([{ name: "X" }], [], []);
  assert.deepEqual(out, [{ name: "X", achieved: 0, unlockTime: 0, curProgress: 0, maxProgress: 0 }]);
});

test("config.resolveSound: 音效配置解析", async () => {
  const { resolveSound } = await import("../src/core/config.js");
  assert.deepEqual(resolveSound(null), { kind: "default" });
  assert.deepEqual(resolveSound(""), { kind: "default" });
  assert.deepEqual(resolveSound("silent"), { kind: "silent" });
  assert.deepEqual(resolveSound("system:Notification.IM"), { kind: "system", name: "Notification.IM" });
  assert.deepEqual(resolveSound("D://snd//x.wav"), { kind: "wav", path: "D://snd//x.wav" });
  assert.deepEqual(resolveSound({ wav: "a.mp3" }), { kind: "wav", path: "a.mp3" });
  assert.deepEqual(resolveSound({ system: "Notification.Mail" }), { kind: "system", name: "Notification.Mail" });
  assert.deepEqual(resolveSound("garbage-without-ext"), { kind: "default" });
});
