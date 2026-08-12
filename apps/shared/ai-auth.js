/**
 * AiAuth —— 网站 AI 功能访问密码（前端不存明文密码，只存用户输入过的值）
 *
 * 前端代码不包含访问密码。用户首次使用 AI 功能时输入一次，
 * 存 localStorage；每个 AI 请求带
 * Authorization: Bearer <密码>。后端返回 401 时清除并重新弹窗。
 *
 * 用法：
 *   const headers = await AiAuth.authHeaders();      // {Authorization: "Bearer xxx"} 或抛出（用户取消）
 *   fetch(url, { method:"POST", headers: { "Content-Type":"application/json", ...headers }, body });
 *   if (res.status === 401) { AiAuth.clear(); ...重试 }
 */
(() => {
  const KEY = "ai_access_token_v1";

  const CSS = `
.ai-auth-mask { position: fixed; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.32); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; }
.ai-auth-card { width: min(340px, calc(100vw - 48px)); background: #fff; border-radius: 16px; padding: 22px 20px 18px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.22); }
.ai-auth-title { font-size: 17px; font-weight: 600; color: #1c1c1e; margin: 0 0 4px; }
.ai-auth-sub { font-size: 13px; color: rgba(60,60,67,0.6); margin: 0 0 16px; line-height: 1.5; }
.ai-auth-input { width: 100%; box-sizing: border-box; font-size: 17px; padding: 11px 12px; border: 1px solid rgba(60,60,67,0.22);
  border-radius: 10px; outline: none; -webkit-appearance: none; }
.ai-auth-input:focus { border-color: #007AFF; }
.ai-auth-err { color: #FF3B30; font-size: 12px; min-height: 16px; margin: 6px 2px 0; }
.ai-auth-btn { width: 100%; margin-top: 12px; font-size: 16px; font-weight: 600; color: #fff; background: #007AFF;
  border: none; border-radius: 10px; padding: 11px; cursor: pointer; }
.ai-auth-btn:active { background: #0062cc; }
@media (prefers-color-scheme: dark) {
  .ai-auth-card { background: #1c1c1e; }
  .ai-auth-title { color: #f2f2f7; }
  .ai-auth-input { background: #2c2c2e; color: #f2f2f7; border-color: rgba(235,235,245,0.24); }
}`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function getToken() {
    try {
      return localStorage.getItem(KEY) || "";
    } catch {
      return "";
    }
  }

  function setToken(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch {}
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {}
  }

  /** 弹窗让用户输入密码，返回 Promise<string>；用户关闭则 reject */
  function promptToken(errorText) {
    injectStyle();
    return new Promise((resolve, reject) => {
      const mask = document.createElement("div");
      mask.className = "ai-auth-mask";
      mask.innerHTML = `
        <div class="ai-auth-card">
          <div class="ai-auth-title">请输入访问密码</div>
          <div class="ai-auth-sub">AI 功能需要密码才能使用（防止他人占用）。密码由管理员提供。</div>
          <input class="ai-auth-input" type="password" inputmode="numeric" autocomplete="off" placeholder="访问密码" />
          <div class="ai-auth-err">${errorText ? errorText : ""}</div>
          <button class="ai-auth-btn" type="button">确定</button>
        </div>`;
      document.body.appendChild(mask);

      const input = mask.querySelector(".ai-auth-input");
      const btn = mask.querySelector(".ai-auth-btn");
      setTimeout(() => input.focus(), 50);

      const submit = () => {
        const value = input.value.trim();
        if (!value) {
          mask.querySelector(".ai-auth-err").textContent = "密码不能为空";
          return;
        }
        setToken(value);
        mask.remove();
        resolve(value);
      };
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      mask.addEventListener("click", (e) => {
        if (e.target === mask) {
          mask.remove();
          reject(new Error("已取消输入访问密码"));
        }
      });
    });
  }

  /** 返回带 Authorization 的 headers；没有本地密码就先弹窗 */
  async function authHeaders() {
    let token = getToken();
    if (!token) token = await promptToken("");
    return { Authorization: `Bearer ${token}` };
  }

  /** 后端 401 后调用：清除旧密码并重新弹窗，返回新 headers */
  async function reauth() {
    clear();
    const token = await promptToken("密码错误，请重新输入");
    return { Authorization: `Bearer ${token}` };
  }

  window.AiAuth = { getToken, clear, authHeaders, reauth };
})();
