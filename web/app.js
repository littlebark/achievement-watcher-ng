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
          <span>${g.error ? `<span class="tag err" title="${esc(g.error)}">数据异常</span>` : `<b>${g.unlocked}</b> / ${g.total}`}</span>
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
        ${g.achievements.map((a) => `
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
          </div>`).join("")}
      </div>`;
  } catch (e) {
    modalBody.innerHTML = `<p class="empty">加载失败：${esc(e.message)}</p>`;
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
        </div>

        <div class="field">
          <label>数据目录</label>
          <div class="dirlist">${esc(s.dataRoot)}</div>
        </div>

        <div class="field">
          <label>成就墙导出目录（留空 = 关闭）</label>
          <input id="s-wall" type="text" value="${esc(s.wall?.dir || "")}" placeholder="例如 D:\\GameTools\\AchievementWall">
          <div class="hint">watchdog 每次解锁实时同步该目录；也可用 <code>node src/cli.js path set wall &lt;目录&gt;</code> 设置。</div>
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
    $("#s-save").addEventListener("click", async () => {
      try {
        const body = {
          lang: $("#s-lang").value,
          timeThreshold: +$("#s-threshold").value,
          tick: +$("#s-tick").value,
          notify: $("#s-notify").checked,
          iconPrefetch: $("#s-prefetch").checked,
          websocket: { enabled: $("#s-ws").checked, port: +$("#s-wsport").value },
          steamApiKey: $("#s-key").value,
          steamApiFallbackKey: $("#s-key2").value,
          wall: { dir: $("#s-wall").value },
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
$("#settings").addEventListener("click", () => { location.hash = "settings"; });
$("#modal-close").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
});
window.addEventListener("hashchange", route);

loadLibrary().then(route);
