// 弹窗渲染逻辑：收广播 → Xbox 风格卡片 → 自动消失（普通 5s / 稀有 10s）
const stack = document.getElementById("stack");
const NORMAL_MS = 5000;
const RARE_MS = 10000;

function playSound(soundPath) {
  if (!soundPath) return;
  try {
    const url = "file:///" + encodeURI(String(soundPath).replace(/\\/g, "/")).replace(/#/g, "%23");
    const audio = new Audio(url);
    audio.volume = 0.9;
    audio.play().catch(() => {}); // 文件缺失/格式不支持：静默
  } catch { /* ignore */ }
}

function addCard(p) {
  const rare = !!p.rare;
  const card = document.createElement("div");
  card.className = "card" + (rare ? " rare" : "");

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

  const duration = rare ? RARE_MS : NORMAL_MS;
  const timer = setTimeout(() => dismiss(card), duration);
  card.addEventListener("mouseenter", () => clearTimeout(timer)); // 悬停暂停消失
  card.addEventListener("mouseleave", () => {
    clearTimeout(timer);
    setTimeout(() => dismiss(card), 2000); // 移开后再给 2 秒
  });
  card.addEventListener("click", () => { window.aw2.openPanel(); dismiss(card); });

  stack.prepend(card);
  trimStack();
}

function dismiss(card) {
  if (!card.isConnected || card.classList.contains("out")) return;
  card.classList.add("out");
  setTimeout(() => card.remove(), 380);
}

// 最多同时 4 张，多余的立刻滑走
function trimStack() {
  while (stack.children.length > 4) dismiss(stack.lastElementChild);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 有卡片时窗口可点，无卡片时鼠标穿透（不挡游戏）
stack.addEventListener("mouseenter", () => window.aw2.setIgnore(false));
stack.addEventListener("mouseleave", () => window.aw2.setIgnore(true));
window.aw2.setIgnore(true);

window.aw2.onAchievement((p) => {
  if (p.progress && !p.time) {
    // 进度类广播：轻量展示
    addCard({ ...p });
    return;
  }
  playSound(p.soundPath);
  addCard(p);
});
