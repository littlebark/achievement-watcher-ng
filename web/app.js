// aw2 面板前端：游戏库 / 成就详情 / 设置（无框架，纯 DOM）
const state = { lib: null, sort: "recent", q: "" };

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");
const modal = $("#modal");
const modalBody = $("#modal-body");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function fmtTime(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

async function api(url, opt) {
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- 游戏库 ----------
async function loadLibrary(refresh = false) {
  $("#loading").classList.remove("hidden");
  $("#empty").classList.add("hidden");
  grid.innerHTML = "";
  try {
    state.lib = await api(`/api/library${refresh ? "?refresh=1" : ""}`);
    renderProfile();
    renderGrid();
  } catch (e) {
    $("#empty").classList.remove("hidden");
    $("#empty").textContent = `读取失败：${e.message}`;
  } finally {
    $("#loading").classList.add("hidden");
  }
}

function renderProfile() {
  const p = state.lib.profile;
  $("#pname").textContent = p.name;
  $("#stat-ach").textContent = p.totalUnlocked;
  $("#stat-perfect").textContent = p.perfect;
  $("#stat-avg").textContent = `${p.avgCompletion}%`;
  $("#stat-games").textContent = p.gameCount;
}

function sortedGames() {
  const list = [...state.lib.games];
  const q = state.q.trim().toLowerCase();
  const filtered = q ? list.filter((g) => (g.name || "").toLowerCase().includes(q) || String(g.appid).includes(q)) : list;

  switch (state.sort) {
    case "percent-desc": return filtered.sort((a, b) => b.percent - a.percent || b.unlocked - a.unlocked);
    case "percent-asc": return filtered.sort((a, b) => a.percent - b.percent || a.unlocked - b.unlocked);
    case "name": return filtered.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh"));
    default: return filtered.sort((a, b) => (b.lastUnlock || 0) - (a.lastUnlock || 0));
  }
}

function renderGrid() {
  const games = sortedGames();
  grid.innerHTML = "";
  if (!games.length) {
    $("#empty").classList.remove("hidden");
    return;
  }
  $("#empty").classList.add("hidden");

  for (const g of games) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.appid = g.appid;
    const done = g.total > 0 && g.unlocked >= g.total;

    card.innerHTML = `
      <div class="cover">
        ${g.header ? `<img src="${esc(g.header)}" alt="" loading="lazy"
             onerror="this.style.display='none'; this.nextElementSibling.style.display='grid'">` : ""}
        <div class="fallback" style="display:${g.header ? "none" : "grid"}">${esc((g.name || g.appid).slice(0, 12))}</div>
      </div>
      <div class="card-body">
        <div class="card-title" title="${esc(g.name)}">${esc(g.name)}</div>
        <div class="bar ${done ? "done" : ""}"><i style="width:${g.percent}%"></i></div>
        <div class="card-meta">
          <span>${g.error ? `<span class="tag err" title="${esc(g.error)}">数据异常</span>` : `<b>${g.unlocked}</b> / ${g.total}${g.offline ? ` <span class="tag warn" title="${esc(g.offlineReason || "未取到 Steam 成就数据，仅显示本地存档")}">离线</span>` : ""}`}</span>
          <span>${g.noSave ? `<span class="tag">无存档</span> ` : ""}<b>${g.percent}%</b></span>
        </div>
      </div>`;

    card.addEventListener("click", () => { location.hash = `game/${g.appid}`; });
    grid.appendChild(card);
  }
}

// ---------- 成就详情 ----------
async function openDetail(appid) {
  modal.classList.remove("hidden");
  modalBody.innerHTML = `<p class="empty">正在加载成就…</p>`;
  try {
    const g = await api(`/api/game/${appid}`);
    const pct = g.total ? Math.round((g.unlocked / g.total) * 100) : 0;

    modalBody.innerHTML = `
      <div class="detail-banner">
        ${g.header ? `<img src="${esc(g.header)}" alt="">` : ""}
        <div class="head">
          <h2>${esc(g.name)}</h2>
          <div class="sub">${g.unlocked} / ${g.total} 已解锁 · ${pct}% · ${esc(g.source)}</div>
        </div>
      </div>
      <div class="detail-list">
        ${g.achievements.length ? g.achievements.map((a) => `
          <div class="ach ${a.achieved ? "" : "locked"}">
            ${(a.achieved ? a.icon : a.icongray || a.icon)
              ? `<img src="${esc(a.achieved ? a.icon : a.icongray || a.icon)}" alt="">`
              : `<div class="icon-ph"></div>`}
            <div>
              <div class="ach-name">${esc(a.displayName)}</div>
              <div class="ach-desc">${esc(a.hidden && !a.achieved ? "隐藏成就" : a.description || "—")}</div>
            </div>
            <div class="ach-right">
              ${a.achieved
                ? `<span class="ok">✔ 已解锁</span><br>${fmtTime(a.unlockTime)}`
                : (a.max > 0 ? `${a.cur} / ${a.max}` : "未解锁")}
            </div>
          </div>`).join("") : `
          <p class="empty">
            这个游戏的成就清单还没下载（离线状态）。<br><br>
            <button class="btn" id="d-prefetch">⬇ 下载这个游戏的成就数据</button>
          </p>`}
      </div>`;
    const dp = $("#d-prefetch");
    if (dp) {
      dp.addEventListener("click", async () => {
        dp.disabled = true;
        dp.textContent = "下载中…";
        try {
          const r = await api("/api/schema/prefetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appids: [String(appid)] }),
          });
          if (r.ok?.length) { toast("下载完成"); openDetail(appid); }
          else throw new Error(r.failed?.[0]?.error || "下载失败");
        } catch (e) {
          dp.disabled = false;
          dp.textContent = "⬇ 重试下载";
          toast(`下载失败：${e.message}`);
        }
      });
    }
  } catch (e) {
    modalBody.innerHTML = `<p class="empty">加载失败：${esc(e.message)}</p>`;
  }
}

// ---------- 成就预下载（不懒加载） ----------
async function prefetchAchievements(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "下载中…";
  toast("开始下载成就数据，网络慢时会久一点…");
  try {
    const r = await api("/api/schema/prefetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
    });
    if (r.alreadyRunning) {
      toast("已有下载任务正在进行");
      return;
    }
    const failed = r.failed?.length || 0;
    const scannedNote = r.scanned?.length ? `，新发现 ${r.scanned.length} 个未运行的游戏` : "";
    toast(`下载完成：新增 ${r.ok.length} 个，已缓存 ${r.cached.length} 个${scannedNote}${failed ? `，失败 ${failed} 个` : ""}`);
    if (r.ok.length) await loadLibrary(true);
  } catch (e) {
    toast(`下载失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- 打补丁（选目录 → emu-gen + emu-apply） ----------
async function openPatchDialog() {
  modal.classList.remove("hidden");
  await renderPatchPicker("");
}

async function renderPatchPicker(dir) {
  modalBody.innerHTML = `<p class="empty">正在读取目录…</p>`;
  let d;
  try {
    d = await api(`/api/fs/list${dir ? `?path=${encodeURIComponent(dir)}` : ""}`);
  } catch (e) {
    modalBody.innerHTML = `<p class="empty">读取目录失败：${esc(e.message)}</p>`;
    return;
  }

  let status = d.isGame
    ? `✅ 看起来是游戏目录${d.appid ? `，AppID = <b>${esc(d.appid)}</b>` : "（缺 steam_appid.txt，可能识别不到 AppID）"}`
    : "继续往下选到游戏目录";
  if (d.isGame && d.patch) {
    const bits = [];
    if (d.patch.backup) bits.push("已被 aw2 打过补丁（存在 .aw2bak 备份）");
    else if (d.patch.goldbergDll) bits.push("DLL 疑似已是 Goldberg/gbe_fork 系模拟器");
    if (d.patch.achConfig) bits.push("成就清单已生成（steam_settings/achievements.json）");
    if (bits.length) {
      status += `<br>⚠ 已检测到：${bits.join("；")}。<b>一般无需重复打补丁</b>；重复执行也不会丢原文件（首次备份会保留），但会刷新成就清单。`;
    }
  }

  modalBody.innerHTML = `
    <div class="settings">
      <h2>打 Goldberg 补丁</h2>
      <p class="hint">选择游戏根目录（能看到游戏 exe 或 steam_api64.dll 的那一层）。会自动识别 AppID、生成成就清单、备份并替换模拟器 DLL。打完会顺带把这个游戏的成就数据下载到本地缓存。</p>
      ${d.path && d.wallSet === false ? `<div class="hint" style="color:#d8b168">提示：成就墙当前已关闭。打补丁和成就下载不受影响，但解锁成就不会同步到成就墙——可在 ⚙ 设置 里重新开启。</div>` : ""}

      <div class="field">
        <label>当前目录</label>
        <div class="path-row">
          <input id="p-dir" type="text" value="${esc(d.path)}" placeholder="选一个盘符开始">
          <button id="p-go" class="btn btn-ghost">打开</button>
          ${d.parent !== null ? `<button id="p-up" class="btn btn-ghost">↑ 上一级</button>` : ""}
        </div>
        <div class="hint">${status}</div>
      </div>

      <div class="field">
        <label>子目录</label>
        <div class="picker">${d.dirs.length
          ? d.dirs.map((x) => `<div class="pick" data-path="${esc(x.path)}">📁 ${esc(x.name)}</div>`).join("")
          : "<div class='hint'>（没有子目录）</div>"}</div>
      </div>

      <div class="row">
        <button id="p-apply" class="btn" ${d.path ? "" : "disabled"}>开始打补丁</button>
        <span id="p-msg" class="hint"></span>
      </div>
    </div>`;

  modalBody.querySelectorAll(".pick").forEach((el) =>
    el.addEventListener("click", () => renderPatchPicker(el.dataset.path))
  );
  $("#p-go").addEventListener("click", () => renderPatchPicker($("#p-dir").value.trim()));
  if ($("#p-up")) $("#p-up").addEventListener("click", () => renderPatchPicker(d.parent));
  $("#p-apply").addEventListener("click", () => applyPatch(d.path));
}

async function applyPatch(dir) {
  const btn = $("#p-apply");
  const msg = $("#p-msg");
  btn.disabled = true;
  msg.textContent = "处理中：拉取成就清单 → 下载图标 → 备份原 DLL → 替换…（可能 1-2 分钟）";
  try {
    const r = await api("/api/emu/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, withIcons: true }),
    });
    modalBody.innerHTML = `
      <div class="settings">
        <h2>✅ 补丁完成</h2>
        <div class="dirlist">
          <div>AppID：<b>${esc(r.appid)}</b></div>
          <div>游戏目录：${esc(r.exeDir || r.gameDir)}</div>
          <div>替换文件 ${r.replaced} 个（原文件备份为 <code>.aw2bak</code>），写入配置 ${r.written} 个</div>
          ${r.detectedBefore && (r.detectedBefore.goldbergDll || r.detectedBefore.achConfig || r.detectedBefore.backup)
            ? `<div>打补丁前检测：${[
                r.detectedBefore.goldbergDll && "已有 Goldberg 系 DLL",
                r.detectedBefore.achConfig && "已有成就清单（本次已刷新）",
                r.detectedBefore.backup && "已有 .aw2bak 备份（保留首次备份）",
              ].filter(Boolean).join("；")}</div>`
            : ""}
          <div>成就清单：${r.settingsDirs.map((s) => `${esc(s.dir)} → ${s.total} 条${s.icons ? `，图标 ${s.icons.ok} 张` : ""}`).join("<br>")}</div>
          <div>Steam 成就数据：${r.schema === "downloaded" ? "已下载到本地" : r.schema === "cached" ? "已有缓存" : `下载失败（${esc(r.schemaError || "网络问题")}）`}</div>
        </div>
        <p class="hint">现在可以直接启动游戏。想撤销就在命令行运行 <code>node src\\cli.js emu-restore ${esc(r.appid)}</code>。</p>
        <div class="row"><button class="btn" id="p-done">知道了</button></div>
      </div>`;
    $("#p-done").addEventListener("click", () => { closeModal(); loadLibrary(true); });
    toast("补丁已应用");
  } catch (e) {
    msg.textContent = `失败：${e.message}`;
    btn.disabled = false;
    // 没设置成就墙目录时，给一个直达设置的入口
    if (/成就墙/.test(e.message) && !$("#p-goset")) {
      const b = document.createElement("button");
      b.id = "p-goset";
      b.className = "btn btn-ghost";
      b.textContent = "去设置成就墙目录 →";
      b.addEventListener("click", () => { location.hash = "settings"; });
      msg.after(b);
    }
  }
}

// ---------- 设置 ----------
async function openSettings() {
  modal.classList.remove("hidden");
  modalBody.innerHTML = `<p class="empty">正在读取设置…</p>`;
  try {
    const s = await api("/api/settings");
    modalBody.innerHTML = `
      <div class="settings">
        <h2>设置</h2>

        <div class="field">
          <label>显示名（面板顶部的名字）</label>
          <input id="s-pname" type="text" maxlength="32" value="${esc(s.profileName || "")}" placeholder="${esc(s.defaultProfileName || "Player")}（默认取 Windows 账户名）">
          <div class="hint">只影响面板显示，与游戏内的模拟器账户名无关。留空则显示 Windows 账户名。</div>
        </div>

        <div class="field">
          <label>Steam Web API Key</label>
          <input id="s-key" type="password" placeholder="${s.hasKey ? `已设置：${esc(s.keyMasked)}（留空则不修改）` : "未设置，粘贴你的 key"}">
          <div class="hint">在 <a href="https://steamcommunity.com/dev/apikey" target="_blank" style="color:var(--accent)">steamcommunity.com/dev/apikey</a> 免费申请，用于拉取成就名称/图标/描述。</div>
        </div>

        <div class="field">
          <label>备用 Key（主 Key 失效时自动尝试）</label>
          <input id="s-key2" type="password" placeholder="${s.hasFallbackKey ? `已设置：${esc(s.fallbackKeyMasked)}` : "可选"}">
        </div>

        <div class="row">
          <div class="field">
            <label>手动添加游戏（Steam AppID）</label>
            <div style="display:flex;gap:8px">
              <input id="s-addappid" type="text" inputmode="numeric" placeholder="例如 2288630" style="flex:1">
              <button class="btn btn-ghost" id="s-addgame">下载成就数据</button>
            </div>
            <div class="hint">给「已打补丁但还没运行过」的游戏预下载成就清单：填 AppID 下载后它就会出现在库里（0/N，标记无存档），运行游戏解锁后自动更新。</div>
            <div class="hint" id="s-addresult"></div>
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label>成就语言</label>
            <select id="s-lang">
              ${["schinese", "tchinese", "english", "japanese", "koreana", "russian"]
                .map((l) => `<option value="${l}" ${s.lang === l ? "selected" : ""}>${l}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>旧成就判定阈值（秒）</label>
            <input id="s-threshold" type="number" min="0" value="${s.timeThreshold}">
            <div class="hint">解锁时间早于「现在 − 阈值」的成就不弹通知，避免打开旧存档时刷屏。</div>
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label>通知冷却（毫秒）</label>
            <input id="s-tick" type="number" min="0" value="${s.tick}">
          </div>
          <div class="field">
            <label>WebSocket 端口</label>
            <input id="s-wsport" type="number" min="1" max="65535" value="${s.websocket?.port || 8082}">
          </div>
        </div>

        <div class="field">
          <label class="check"><input id="s-notify" type="checkbox" ${s.notify ? "checked" : ""}> 解锁时弹出 Windows 通知</label>
          <label class="check" style="margin-top:8px"><input id="s-prefetch" type="checkbox" ${s.iconPrefetch ? "checked" : ""}> 预下载成就图标（通知里显示图片）</label>
          <label class="check" style="margin-top:8px"><input id="s-ws" type="checkbox" ${s.websocket?.enabled ? "checked" : ""}> 启用 WebSocket 广播（给直播/悬浮窗用）</label>
          <div class="hint" style="margin-top:12px">稀有成就音效（Xbox 钻石成就式）：全球解锁率 ≤ 阈值即视为稀有，全成就达成也按稀有处理。音效支持 mp3/wav；相对路径以数据目录为基准，默认读取 <code>sounds/normal.mp3</code> 与 <code>sounds/rare.mp3</code>（即 <code>${esc(s.soundsDir || "data/sounds")}</code>）。文件不存在时回落系统默认声；也可填 system:Notification.IM 等系统音。</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
            <div style="flex:1;min-width:120px">
              <label>稀有判定阈值（%）</label>
              <input id="s-rareth" type="number" min="0" max="100" value="${s.sound?.rareThreshold ?? 10}">
            </div>
            <div style="flex:2;min-width:200px">
              <label>普通成就音效</label>
              <input id="s-sndnormal" type="text" value="${esc(s.sound?.normal ?? "")}" placeholder="sounds/normal.mp3">
            </div>
            <div style="flex:2;min-width:200px">
              <label>稀有成就音效 / 全成就音效</label>
              <input id="s-sndrare" type="text" value="${esc(s.sound?.rare ?? "")}" placeholder="sounds/rare.mp3">
            </div>
          </div>
        </div>

        <div class="field">
          <label>面板端口（0 = 默认 5179；改完保存并重启面板生效）</label>
          <input id="s-uiport" type="number" min="0" max="65535" value="${s.uiPort || 0}" style="max-width:180px">
        </div>

        <div class="field">
          <label>数据目录</label>
          <div class="dirlist">${esc(s.dataRoot)}</div>
        </div>

        <div class="field">
          <label class="check"><input id="s-wall-on" type="checkbox" ${s.wall?.enabled !== false ? "checked" : ""}> 启用成就墙（解锁实时同步）</label>
          <div style="margin-top:8px">
            <label>成就墙导出目录（留空 = 默认 数据目录\AchievementWall，随项目文件夹走）</label>
            <input id="s-wall" type="text" value="${esc(s.wall?.dir || "")}" placeholder="留空 = 默认 数据目录\AchievementWall">
            <div class="hint">默认导出到 <code>${esc(s.wall?.effective || "数据目录\\AchievementWall")}</code>；整个项目文件夹删掉即全部清空，不留垃圾。</div>
          </div>
        </div>

        <div class="field">
          <label>Goldberg 模拟器源根目录（每行一个，按顺序优先${s.pathsCustom?.emuRoots ? "" : "，当前为内置默认"})</label>
          <textarea id="s-emuroots" rows="2">${esc((s.paths?.emuRoots || []).join("\n"))}</textarea>
          <div class="hint">emu-source 安装到这里，emu-apply 从这里取 steam_api*.dll；留空恢复内置默认。</div>
        </div>

        <div class="field">
          <label>额外 emu 源搜索目录（每行一个，只读借用不安装）</label>
          <textarea id="s-emusrc" rows="2">${esc((s.paths?.emuExtraSources || []).join("\n"))}</textarea>
        </div>

        <div class="field">
          <label>游戏搜索根目录（每行一个，emu-gen / emu-apply 自动找游戏用）</label>
          <textarea id="s-gamedirs" rows="2">${esc((s.paths?.gameSearchDirs || []).join("\n"))}</textarea>
        </div>

        <div class="field">
          <label>监视的成就目录（自动发现）</label>
          <div class="dirlist">${(state.lib?.games || []).map((g) => `<div>${esc(g.name)} — ${esc(g.dir)}</div>`).join("") || "<div>（暂无）</div>"}</div>
        </div>

        <div class="actions">
          <button class="btn-primary" id="s-save">保存设置</button>
          <button class="btn" id="s-cancel">取消</button>
        </div>
        <div class="hint" style="margin-top:12px">通知相关设置需要重启 watchdog 才生效；成就语言变更后刷新即可看到新语言。</div>
      </div>`;

    $("#s-cancel").addEventListener("click", closeModal);
    $("#s-addgame").addEventListener("click", async () => {
      const out = $("#s-addresult");
      const id = ($("#s-addappid").value || "").trim();
      if (!/^\d+$/.test(id)) {
        out.textContent = "请填写纯数字的 Steam AppID";
        return;
      }
      out.textContent = `正在下载 ${id} 的成就数据…`;
      try {
        const r = await api("/api/schema/prefetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appids: [id], force: false }),
        });
        if (r.ok?.length) out.textContent = `✅ ${id} 已下载，关掉设置后就能在库里看到它了`;
        else if (r.cached?.length) out.textContent = `✅ ${id} 已有缓存，关掉设置即可看到`;
        else out.textContent = `❌ 下载失败：${r.failed?.[0]?.error || "未知错误"}`;
        await loadLibrary(true);
      } catch (e) {
        out.textContent = `❌ ${e.message}`;
      }
    });
    $("#s-save").addEventListener("click", async () => {
      try {
        const body = {
          profileName: $("#s-pname").value,
          lang: $("#s-lang").value,
          timeThreshold: +$("#s-threshold").value,
          tick: +$("#s-tick").value,
          notify: $("#s-notify").checked,
          iconPrefetch: $("#s-prefetch").checked,
          websocket: { enabled: $("#s-ws").checked, port: +$("#s-wsport").value },
          sound: {
            rareThreshold: +$("#s-rareth").value,
            normal: $("#s-sndnormal").value,
            rare: $("#s-sndrare").value,
          },
          ui: { port: +$("#s-uiport").value || 0 },
          steamApiKey: $("#s-key").value,
          steamApiFallbackKey: $("#s-key2").value,
          wall: { dir: $("#s-wall").value, enabled: $("#s-wall-on").checked },
          paths: {
            emuRoots: $("#s-emuroots").value.split(/\r?\n/),
            emuExtraSources: $("#s-emusrc").value.split(/\r?\n/),
            gameSearchDirs: $("#s-gamedirs").value.split(/\r?\n/),
          },
        };
        await api("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        closeModal();
        toast("设置已保存");
        loadLibrary(true);
      } catch (e) {
        toast(`保存失败：${e.message}`);
      }
    });
  } catch (e) {
    modalBody.innerHTML = `<p class="empty">读取设置失败：${esc(e.message)}</p>`;
  }
}

function hideModal() {
  modal.classList.add("hidden");
  modalBody.innerHTML = "";
}

function closeModal() {
  if (location.hash) {
    location.hash = "";
    hideModal();
  } else {
    hideModal();
  }
}

// 路由：#game/<appid> 详情、#settings 设置（支持直接分享/刷新保持）
function route() {
  const h = location.hash.replace(/^#/, "");
  const m = h.match(/^game\/(\d+)$/);
  if (m) return openDetail(m[1]);
  if (h === "settings") return openSettings();
  return hideModal();
}

// ---------- 事件绑定 ----------
$("#search").addEventListener("input", (e) => {
  state.q = e.target.value;
  if (state.lib) renderGrid();
});
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  if (state.lib) renderGrid();
});
$("#refresh").addEventListener("click", () => loadLibrary(true));
$("#prefetch").addEventListener("click", (e) => prefetchAchievements(e.currentTarget));
$("#patch").addEventListener("click", openPatchDialog);
$("#settings").addEventListener("click", () => { location.hash = "settings"; });
$("#modal-close").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
});
window.addEventListener("hashchange", route);

loadLibrary().then(route);
