// 弹窗渲染逻辑：收广播 → Xbox 风格卡片 → 顺序队列逐张播放（普通 5s / 稀有 10s）
const stack = document.getElementById("stack");
const NORMAL_MS = 5000;
const RARE_MS = 10000;
const EXIT_MS = 380; // 与 CSS slideout 动画时长一致
const QUEUE_MAX = 10; // 队列上限：防批量解锁刷屏积压，超出的丢最旧的
const RESUME_MS = 2000; // 悬停后移开鼠标，再给的宽限时间

function playSound(soundPath) {
  if (!soundPath) return;
  try {
    const url = "file:///" + encodeURI(String(soundPath).replace(/\\/g, "/")).replace(/#/g, "%23");
    const audio = new Audio(url);
    audio.volume = 0.9;
    audio.play().catch(() => {}); // 文件缺失/格式不支持：静默
  } catch { /* ignore */ }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// —— 顺序队列：一张完整播完（进入→停留→退出）再弹下一张 ——
const queue = [];
let playing = false;

function enqueue(p) {
  if (queue.length >= QUEUE_MAX) queue.shift();
  queue.push(p);
  pump();
}

function pump() {
  if (playing || queue.length === 0) return;
  const p = queue.shift();
  playing = true;
  playSound(p.soundPath); // 音效跟随卡片登场，顺序播放时音效也是逐个的
  addCard(p);
}

function addCard(p) {
  const rare = !!p.rare;
  const card = document.createElement("div");
  // 样式固定 Steam 蓝调（.card 基础样式 + .steam 覆盖）
  card.className = "card steam" + (rare ? " rare" : "");

  // 图标：Steam CDN 直链，加载失败回落奖杯
  let iconHtml;
  if (p.icon) {
    iconHtml = `<img class="icon" src="${p.icon}" onerror="this.outerHTML='<div class=&quot;icon fallback&quot;>🏆</div>'">`;
  } else {
    iconHtml = `<div class="icon fallback">🏆</div>`;
  }

  const badge = rare && p.attribution
    ? `<span class="badge">◆ ${escapeHtml(p.attribution)}</span>`
    : "";
  const progress = p.progress
    ? `<div class="progress"><div style="width:${Math.min(100, (p.progress.current / p.progress.max) * 100)}%"></div></div>`
    : "";

  card.innerHTML = `
    ${iconHtml}
    <div class="body">
      <div class="game">${escapeHtml(p.game || "")}</div>
      <div class="title">${escapeHtml(p.displayName || "成就解锁")}</div>
      <div class="desc">${escapeHtml(p.description || "")}</div>
      ${badge}${progress}
    </div>
  `;

  let finished = false;
  let timer = setTimeout(finish, rare ? RARE_MS : NORMAL_MS);

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    card.classList.add("out");
    setTimeout(() => {
      card.remove();
      playing = false;
      pump(); // 退场完毕，播下一张
    }, EXIT_MS);
  }

  // 悬停暂停消失；移开后给 2 秒宽限
  card.addEventListener("mouseenter", () => clearTimeout(timer));
  card.addEventListener("mouseleave", () => {
    if (!finished) timer = setTimeout(finish, RESUME_MS);
  });
  card.addEventListener("click", () => { window.aw2?.openPanel(); finish(); });

  stack.replaceChildren(card); // 一次只显示一张
}

// 有卡片时窗口可点，无卡片时鼠标穿透（不挡游戏）
// ?. 防御：preload 加载失败时不至于让整个脚本挂掉（否则 onAchievement 也注册不上）
stack.addEventListener("mouseenter", () => window.aw2?.setIgnore(false));
stack.addEventListener("mouseleave", () => window.aw2?.setIgnore(true));
window.aw2?.setIgnore(true);
if (!window.aw2) console.error("[overlay] preload 桥未加载，无法接收通知");

window.aw2?.onAchievement((p) => {
  console.warn("[overlay] 收到卡片:", p.displayName);
  enqueue({ ...p });
});
