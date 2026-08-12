/**
 * AiProgress —— AI 请求横向进度条（苹果 UI 风格）
 *
 * 进度与预估时间基于同类请求的真实历史耗时（localStorage 里按请求类型存 EMA，
 * 并按本次输入规模缩放），越用越准；到 96% 后等待真实完成，不假装跑满。
 *
 * 用法：
 *   const p = AiProgress.start(hostElement, { key: "chat:deepseek-v4-pro", units: 120, title: "正在请求", fallbackMs: 15000 });
 *   p.setStage("回复中…"); p.finish(); / p.fail("请求失败");
 */
(() => {
  const STATS_KEY = "ai_progress_stats_v1";

  // iOS UIProgressView 规格：4px 圆角轨道、systemBlue 填充、13px 次级灰文字
  const CSS = `
.ai-progress { margin: 10px 2px 4px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; opacity: 1; transition: opacity .3s ease; }
.ai-progress.ai-progress-hide { opacity: 0; }
.ai-progress-label { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px; }
.ai-progress-stage { font-size: 13px; font-weight: 500; color: rgba(60, 60, 67, 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-progress-meta { font-size: 12px; color: rgba(60, 60, 67, 0.6); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ai-progress-track { height: 4px; border-radius: 2px; background: rgba(120, 120, 128, 0.2); overflow: hidden; }
.ai-progress-fill { height: 100%; width: 0%; border-radius: 2px; background: #007AFF; transition: width .18s ease-out; }
.ai-progress-failed .ai-progress-fill { background: #FF3B30; }
.ai-progress-failed .ai-progress-stage { color: #FF3B30; }
@media (prefers-color-scheme: dark) {
  .ai-progress-stage { color: rgba(235, 235, 245, 0.85); }
  .ai-progress-meta { color: rgba(235, 235, 245, 0.6); }
  .ai-progress-track { background: rgba(120, 120, 128, 0.32); }
  .ai-progress-fill { background: #0A84FF; }
}`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function loadStats() {
    try {
      return JSON.parse(localStorage.getItem(STATS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveStats(stats) {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch {}
  }

  /** 预估耗时：同类请求历史 EMA × 输入规模比例（一半权重），避免小样本抖动过猛 */
  function estimateMs(key, units, fallbackMs) {
    const s = loadStats()[key];
    if (!s || !s.emaMs) return fallbackMs;
    let est = s.emaMs;
    if (units > 0 && s.emaUnits > 0) {
      est = s.emaMs * (0.5 + 0.5 * (units / s.emaUnits));
    }
    return Math.min(Math.max(est, 1500), 10 * 60 * 1000);
  }

  function record(key, ms, units) {
    const all = loadStats();
    const s = all[key] || {};
    const alpha = 0.35;
    s.emaMs = s.emaMs ? s.emaMs * (1 - alpha) + ms * alpha : ms;
    s.emaUnits = s.emaUnits ? s.emaUnits * (1 - alpha) + (units || 1) * alpha : units || 1;
    all[key] = s;
    saveStats(all);
  }

  /** 预估时间内匀速走到 80%，之后指数放缓，最多 96%，等真实完成再跳 100% */
  function progressFraction(elapsed, est) {
    const t = elapsed / Math.max(est, 1);
    if (t <= 0.8) return t;
    return Math.min(0.96, 0.8 + 0.16 * (1 - Math.exp(-(t - 0.8) / 0.6)));
  }

  function formatDuration(ms) {
    const sec = Math.max(1, Math.round(ms / 1000));
    if (sec < 60) return `${sec} 秒`;
    return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  }

  function start(host, options) {
    const opts = options || {};
    if (!host || typeof document === "undefined") {
      return { setStage() {}, finish() {}, fail() {} };
    }
    injectStyle();

    const el = document.createElement("div");
    el.className = "ai-progress";
    el.innerHTML = `
      <div class="ai-progress-label">
        <span class="ai-progress-stage"></span>
        <span class="ai-progress-meta"></span>
      </div>
      <div class="ai-progress-track"><div class="ai-progress-fill"></div></div>`;
    host.appendChild(el);

    const stageEl = el.querySelector(".ai-progress-stage");
    const metaEl = el.querySelector(".ai-progress-meta");
    const fillEl = el.querySelector(".ai-progress-fill");
    stageEl.textContent = opts.title || "AI 处理中…";

    const key = opts.key || "default";
    const units = Number(opts.units) || 0;
    const startAt = Date.now();
    const est = estimateMs(key, units, Number(opts.fallbackMs) || 20000);
    let done = false;

    const timer = setInterval(() => {
      if (done) return;
      if (!el.isConnected) {
        clearInterval(timer);
        return;
      }
      const elapsed = Date.now() - startAt;
      const p = progressFraction(elapsed, est);
      fillEl.style.width = `${(p * 100).toFixed(1)}%`;
      const remain = est - elapsed;
      metaEl.textContent =
        remain > 900
          ? `${Math.round(p * 100)}% · 预计还需 ${formatDuration(remain)}`
          : `${Math.round(p * 100)}% · 即将完成…`;
    }, 120);

    function stop(ok, message) {
      if (done) return;
      done = true;
      clearInterval(timer);
      const ms = Date.now() - startAt;
      if (ok) record(key, ms, units);
      if (!el.isConnected) return;
      fillEl.style.width = "100%";
      if (ok) {
        metaEl.textContent = `100% · 用时 ${formatDuration(ms)}`;
      } else {
        el.classList.add("ai-progress-failed");
        stageEl.textContent = message || "请求失败";
        metaEl.textContent = "已中断";
      }
      setTimeout(() => {
        el.classList.add("ai-progress-hide");
        setTimeout(() => el.remove(), 350);
      }, ok ? 600 : 1800);
    }

    return {
      setStage(text) {
        if (!done && el.isConnected) stageEl.textContent = text;
      },
      finish() {
        stop(true);
      },
      fail(message) {
        stop(false, message);
      },
    };
  }

  window.AiProgress = { start };
})();
