const SESSION_COOKIE = "__Host-zouyihui_session";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 5 * 60;
const LOGIN_MAX_FAILURES = 8;
const MAX_PASSWORD_BYTES = 256;
const MAX_FAILURE_KEYS = 10_000;

const encoder = new TextEncoder();
const loginFailures = new Map();

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.hostname === "zouyihui.me") {
    url.hostname = "www.zouyihui.me";
    return secureResponse(Response.redirect(url.toString(), 308));
  }

  if (url.pathname === "/__access/login" && request.method === "POST") {
    return handleLogin(request, env, url);
  }

  if (url.pathname === "/__access/logout" && request.method === "POST") {
    return handleLogout(request, url);
  }

  if (url.pathname === "/__access" && request.method === "GET") {
    if (await hasValidSession(request, env)) {
      return secureResponse(Response.redirect(new URL(safeNext(url.searchParams.get("next")), url), 303));
    }
    return loginPage({ next: safeNext(url.searchParams.get("next")) });
  }

  if (url.pathname === "/__access/owner-admin" && request.method === "GET") {
    if (!(await hasValidSession(request, env))) {
      const loginUrl = new URL("/__access", url);
      loginUrl.searchParams.set("next", "/__access/owner-admin");
      return secureResponse(Response.redirect(loginUrl.toString(), 303));
    }
    return ownerAdminRedirect(env, url);
  }

  if (url.pathname === "/__access/owner-notes" && request.method === "GET") {
    if (!(await hasValidSession(request, env))) {
      const loginUrl = new URL("/__access", url);
      loginUrl.searchParams.set("next", "/__access/owner-notes");
      return secureResponse(Response.redirect(loginUrl.toString(), 303));
    }
    return ownerNotesRedirect(env, url);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
  }

  if (isPublicAssetPath(url.pathname)) {
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return htmlResponse(503, systemUnavailablePage());
    }
    return securePublicAssetResponse(await env.ASSETS.fetch(request));
  }

  if (!(await hasValidSession(request, env))) {
    const next = `${url.pathname}${url.search}`;
    const loginUrl = new URL("/__access", url);
    loginUrl.searchParams.set("next", safeNext(next));
    return secureResponse(Response.redirect(loginUrl.toString(), 303));
  }

  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return htmlResponse(503, systemUnavailablePage());
  }

  const assetResponse = await env.ASSETS.fetch(request);
  return secureAssetResponse(assetResponse, url.pathname);
}

async function handleLogin(request, env, url) {
  if (!sameOriginRequest(request, url)) {
    return loginPage({ error: "请求来源无法确认，请刷新页面后重试。", status: 403 });
  }

  const contentType = request.headers.get("Content-Type") || "";
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded") || contentLength > 1024) {
    return loginPage({ error: "登录请求格式不正确，请刷新页面后重试。", status: 415 });
  }

  const clientKey = loginClientKey(request);
  const retryAfter = reserveLoginAttempt(clientKey);
  if (retryAfter > 0) {
    return loginPage({
      error: `尝试次数较多，请 ${retryAfter} 秒后再试。`,
      status: 429,
      retryAfter,
    });
  }

  if (!env.SITE_PASSWORD_HASH || !env.SITE_SESSION_SECRET) {
    settleLoginAttempt(clientKey, false);
    return loginPage({ error: "访问保护尚未完成配置，请稍后再试。", status: 503 });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    settleLoginAttempt(clientKey, false);
    return loginPage({ error: "登录请求无法读取，请刷新页面后重试。", status: 400 });
  }

  const password = String(form.get("password") || "");
  const next = safeNext(form.get("next"));
  const passwordBytes = encoder.encode(password);
  if (!passwordBytes.length || passwordBytes.length > MAX_PASSWORD_BYTES) {
    settleLoginAttempt(clientKey, false);
    return loginPage({ error: "访问密码不正确，请确认后重试。", next, status: 401 });
  }

  const suppliedHash = await sha256Hex(passwordBytes);
  const expectedHash = normalizeHex(env.SITE_PASSWORD_HASH);
  const passwordMatches = expectedHash.length === 64 && constantTimeEqual(suppliedHash, expectedHash);
  if (!passwordMatches) {
    settleLoginAttempt(clientKey, false);
    return loginPage({ error: "访问密码不正确，请确认后重试。", next, status: 401 });
  }

  settleLoginAttempt(clientKey, true);
  const cookieValue = await createSession(env.SITE_SESSION_SECRET);
  const headers = new Headers({
    Location: new URL(next, url).toString(),
    "Cache-Control": "no-store",
    "Set-Cookie": serializeSessionCookie(cookieValue, SESSION_SECONDS),
  });
  return secureResponse(new Response(null, { status: 303, headers }));
}

function handleLogout(request, url) {
  if (!sameOriginRequest(request, url)) {
    return jsonResponse(403, { error: "请求来源无法确认。" });
  }
  const headers = new Headers({
    Location: new URL("/__access", url).toString(),
    "Cache-Control": "no-store",
    "Set-Cookie": serializeSessionCookie("", 0),
  });
  return secureResponse(new Response(null, { status: 303, headers }));
}

async function createSession(secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = bytesToBase64Url(nonceBytes);
  const payload = `v1.${expiresAt}.${nonce}`;
  const signature = await hmacSign(secret, payload);
  return `${payload}.${signature}`;
}

async function hasValidSession(request, env) {
  if (!env.SITE_SESSION_SECRET) return false;
  const cookie = readCookie(request.headers.get("Cookie") || "", SESSION_COOKIE);
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  if (!/^[A-Za-z0-9_-]{20,32}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{40,48}$/.test(parts[3])) return false;
  const payload = parts.slice(0, 3).join(".");
  const expected = await hmacSign(env.SITE_SESSION_SECRET, payload);
  return constantTimeEqual(parts[3], expected);
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function ownerAppRedirect(env, url, pathname) {
  const secret = String(env.OWNER_BRIDGE_SECRET || "");
  if (encoder.encode(secret).length < 32) {
    return htmlResponse(503, systemUnavailablePage());
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = `v1.${expiresAt}.${nonce}`;
  const assertion = `${payload}.${await hmacSign(secret, payload)}`;
  const target = new URL(pathname, url);
  target.hash = `owner=${encodeURIComponent(assertion)}`;
  const headers = new Headers({
    Location: target.toString(),
    "Cache-Control": "no-store",
  });
  return secureResponse(new Response(null, { status: 303, headers }));
}

async function ownerAdminRedirect(env, url) {
  return ownerAppRedirect(env, url, "/apps/admin/");
}

async function ownerNotesRedirect(env, url) {
  return ownerAppRedirect(env, url, "/apps/notes/");
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reserveLoginAttempt(clientKey) {
  const now = Date.now();
  const cutoff = now - LOGIN_WINDOW_SECONDS * 1000;
  const attempts = (loginFailures.get(clientKey) || []).filter((stamp) => stamp > cutoff);
  if (attempts.length >= LOGIN_MAX_FAILURES) {
    loginFailures.delete(clientKey);
    loginFailures.set(clientKey, attempts);
    return Math.max(1, Math.ceil((attempts[0] + LOGIN_WINDOW_SECONDS * 1000 - now) / 1000));
  }
  attempts.push(now);
  loginFailures.delete(clientKey);
  loginFailures.set(clientKey, attempts);
  while (loginFailures.size > MAX_FAILURE_KEYS) {
    loginFailures.delete(loginFailures.keys().next().value);
  }
  return 0;
}

function settleLoginAttempt(clientKey, success) {
  if (success) loginFailures.delete(clientKey);
}

function loginClientKey(request) {
  return String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 64);
}

function sameOriginRequest(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

function safeNext(value) {
  const text = String(value || "/");
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\") || /[\r\n]/.test(text)) return "/";
  return text.slice(0, 2048);
}

function isPublicAssetPath(pathname) {
  if (pathname === "/" || pathname === "/index.html") return true;
  // 首页是公开页，它引用到的标志资源必须一起放行 ——
  // 漏掉任何一个，未登录访客的首页就只剩一个空框。
  if (pathname === "/assets/mark-metal.js" || pathname === "/assets/mark-still.png") return true;
  if (pathname === "/assets/favicon.ico" || pathname === "/assets/mark-180.png") return true;
  // 登录页自己也画标志，所以这两个同样要在未登录时可取
  if (pathname === "/assets/mark-icon.png" || pathname === "/assets/mark-icon-small.png") return true;
  if (pathname === "/config/portal.config.js") return true;
  if (pathname === "/购票模板.xlsx") return true;
  if (pathname === "/apps/vendor/exceljs.min.js") return true;
  if (pathname === "/apps/shared/ticket-template-export.js") return true;
  if (pathname === "/apps/admin" || pathname === "/apps/admin/" || pathname.startsWith("/apps/admin/")) return true;
  return pathname === "/apps/portal" || pathname === "/apps/portal/" || pathname.startsWith("/apps/portal/");
}

function readCookie(header, name) {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function serializeSessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function normalizeHex(value) {
  return String(value || "").trim().toLowerCase();
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isPrivateStudyPath(pathname) {
  return pathname === "/apps/private-jet-study" || pathname === "/apps/private-jet-study/" || pathname.startsWith("/apps/private-jet-study/");
}

function secureAssetResponse(response, pathname = "") {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  applySecurityHeaders(headers);
  if (isPrivateStudyPath(pathname)) {
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function securePublicAssetResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  applySecurityHeaders(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function secureResponse(response) {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function applySecurityHeaders(headers) {
  headers.set("Strict-Transport-Security", "max-age=86400; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  // `no-referrer` makes browsers serialize Origin as `null` for ordinary
  // form POSTs, which defeats the strict same-origin login check below.
  // `same-origin` keeps referrers off cross-site requests while preserving a
  // verifiable Origin for the password form and logout POST.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
}

function htmlResponse(status, html, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  applySecurityHeaders(headers);
  return new Response(html, { status, headers });
}

function jsonResponse(status, payload, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(payload), { status, headers });
}

function loginPage({ error = "", next = "/", status = 200, retryAfter = 0 } = {}) {
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const headers = {
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return htmlResponse(status, loginDocument({ error, next, nonce }), headers);
}

function loginDocument({ error, next, nonce }) {
  const safeError = escapeHtml(error);
  const safeNextValue = escapeHtml(next);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f3fbff">
  <title>个人空间 · ZOUYIHUI.ME</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif;
      font-synthesis: none;
      --ink: #10293c;
      --muted: #6a7c88;
      --line: rgba(42, 112, 149, .14);
      --card: rgba(255, 255, 255, .74);
      --green: #1b9ddf;
      --green-deep: #0d79b8;
      --focus: rgba(31, 157, 220, .2);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100svh;
      overflow: hidden;
      color: var(--ink);
      background:
        radial-gradient(circle at 15% 5%, rgba(193, 238, 245, .78), transparent 38%),
        radial-gradient(circle at 88% 88%, rgba(205, 230, 250, .72), transparent 42%),
        linear-gradient(145deg, #f9fdff 0%, #eef9ff 48%, #f7fcff 100%);
      -webkit-font-smoothing: antialiased;
    }
    .ambient {
      position: fixed;
      inset: -18vmax;
      pointer-events: none;
      filter: blur(28px);
      opacity: .72;
    }
    .orb {
      position: absolute;
      width: 34vmax;
      aspect-ratio: 1;
      border-radius: 46% 54% 61% 39% / 51% 42% 58% 49%;
      will-change: transform;
    }
    .orb-a {
      left: 8%; top: 5%;
      background: rgba(112, 218, 229, .34);
      animation: drift-a 15s ease-in-out infinite alternate;
    }
    .orb-b {
      right: 4%; bottom: 3%;
      background: rgba(114, 183, 235, .3);
      animation: drift-b 18s ease-in-out infinite alternate;
    }
    .shell {
      position: relative;
      z-index: 1;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: max(24px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
    }
    .card {
      width: min(100%, 382px);
      padding: 30px;
      border: 1px solid rgba(255, 255, 255, .86);
      border-radius: 28px;
      background: var(--card);
      box-shadow: 0 26px 70px rgba(43, 104, 136, .11), 0 2px 8px rgba(43, 104, 136, .05);
      backdrop-filter: blur(24px) saturate(128%);
      -webkit-backdrop-filter: blur(24px) saturate(128%);
      animation: card-in 560ms cubic-bezier(.22, 1, .36, 1) both;
    }
    .eyebrow {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 26px;
      color: #55788b;
      font-size: 12px;
      font-weight: 650;
      letter-spacing: .16em;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
    }
    .mark img {
      width: 30px;
      height: 30px;
      filter: drop-shadow(0 3px 7px rgba(32, 147, 203, .13));
    }
    h1 {
      margin: 0;
      font-size: clamp(27px, 7vw, 32px);
      line-height: 1.16;
      font-weight: 640;
      letter-spacing: -.035em;
    }
    .subtitle {
      margin: 12px 0 25px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
    }
    label {
      display: block;
      margin: 0 0 8px 2px;
      color: #405d6e;
      font-size: 13px;
      font-weight: 600;
    }
    .password-wrap { position: relative; }
    input {
      width: 100%;
      height: 52px;
      padding: 0 49px 0 15px;
      border: 1px solid var(--line);
      border-radius: 15px;
      outline: none;
      color: var(--ink);
      background: rgba(255, 255, 255, .82);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .7);
      font: inherit;
      font-size: 16px;
      transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
    }
    input:hover { border-color: rgba(31, 157, 220, .28); }
    input:focus {
      border-color: rgba(31, 157, 220, .58);
      box-shadow: 0 0 0 4px var(--focus);
      background: white;
    }
    .reveal {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 12px;
      color: #647987;
      background: transparent;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .reveal:hover { background: rgba(31, 139, 196, .07); }
    .reveal:focus-visible { outline: 3px solid var(--focus); outline-offset: 0; }
    .error {
      display: ${safeError ? "flex" : "none"};
      gap: 8px;
      align-items: flex-start;
      margin: 12px 2px 0;
      padding: 10px 12px;
      border: 1px solid rgba(185, 123, 42, .16);
      border-radius: 12px;
      color: #7d561f;
      background: rgba(255, 244, 214, .62);
      font-size: 13px;
      line-height: 1.45;
    }
    .error::before { content: "!"; font-weight: 750; }
    .submit {
      position: relative;
      width: 100%;
      height: 52px;
      margin-top: 18px;
      overflow: hidden;
      border: 0;
      border-radius: 15px;
      color: white;
      background: linear-gradient(180deg, #25a8e6, #147fc0);
      box-shadow: 0 10px 24px rgba(22, 128, 186, .2), inset 0 1px 0 rgba(255, 255, 255, .25);
      font: inherit;
      font-size: 15px;
      font-weight: 650;
      cursor: pointer;
      transition: transform 120ms ease, box-shadow 180ms ease, background 180ms ease;
      -webkit-tap-highlight-color: transparent;
    }
    .submit:hover { background: linear-gradient(180deg, #1d9edc, #0e72b0); box-shadow: 0 12px 28px rgba(22, 128, 186, .24); }
    .submit:active { transform: scale(.985); }
    .submit:focus-visible { outline: 4px solid var(--focus); outline-offset: 3px; }
    .submit[data-loading="true"] { cursor: wait; }
    .submit-label { transition: opacity 150ms ease, transform 180ms ease; }
    .spinner {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 150ms ease, transform 180ms ease;
    }
    .spinner::after {
      content: "";
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255,255,255,.38);
      border-top-color: white;
      border-radius: 50%;
      animation: spin .72s linear infinite;
    }
    .submit[data-loading="true"] .submit-label { opacity: 0; transform: translateY(-6px); }
    .submit[data-loading="true"] .spinner { opacity: 1; transform: none; }
    .privacy {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-top: 19px;
      color: #849089;
      font-size: 11px;
      letter-spacing: .01em;
    }
    .lock {
      width: 11px;
      height: 9px;
      border: 1.4px solid currentColor;
      border-radius: 3px;
      position: relative;
    }
    .lock::before {
      content: "";
      position: absolute;
      left: 2px;
      top: -6px;
      width: 5px;
      height: 6px;
      border: 1.4px solid currentColor;
      border-bottom: 0;
      border-radius: 5px 5px 0 0;
    }
    @keyframes card-in { from { opacity: 0; transform: translateY(12px) scale(.985); } }
    @keyframes drift-a { to { transform: translate3d(9vw, 6vh, 0) rotate(14deg) scale(1.08); } }
    @keyframes drift-b { to { transform: translate3d(-8vw, -7vh, 0) rotate(-12deg) scale(.94); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 420px) {
      .card { padding: 25px 22px; border-radius: 24px; }
      .eyebrow { margin-bottom: 23px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
      .card { animation: none; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .card { background: #fbfdfc; backdrop-filter: none; -webkit-backdrop-filter: none; }
    }
  </style>
</head>
<body>
  <div class="ambient" aria-hidden="true"><div class="orb orb-a"></div><div class="orb orb-b"></div></div>
  <main class="shell">
    <section class="card" aria-labelledby="access-title">
      <div class="eyebrow"><span class="mark" aria-hidden="true"><img src="/assets/mark-icon-small.png" srcset="/assets/mark-icon-small.png 1x, /assets/mark-icon.png 2x" alt="" width="30" height="30"></span><span>PERSONAL SPACE</span></div>
      <h1 id="access-title">进入个人空间</h1>
      <p class="subtitle">请输入个人空间密码。验证后，本次浏览器会话可以继续访问你的工作台。</p>
      <form id="access-form" method="post" action="/__access/login" novalidate>
        <input type="hidden" name="next" value="${safeNextValue}">
        <label for="access-password">访问密码</label>
        <div class="password-wrap">
          <input id="access-password" name="password" type="password" autocomplete="current-password" inputmode="text" maxlength="256" spellcheck="false" required autofocus aria-describedby="access-error">
          <button class="reveal" id="reveal-password" type="button" aria-label="显示密码" aria-pressed="false">显示</button>
        </div>
        <div class="error" id="access-error" role="alert" aria-live="polite">${safeError}</div>
        <button class="submit" id="access-submit" type="submit">
          <span class="submit-label">继续访问</span><span class="spinner" aria-hidden="true"></span>
        </button>
      </form>
      <div class="privacy"><span class="lock" aria-hidden="true"></span><span>加密连接 · 会话仅保存在当前浏览器</span></div>
    </section>
  </main>
  <script nonce="${nonce}">
    (() => {
      const form = document.getElementById("access-form");
      const password = document.getElementById("access-password");
      const reveal = document.getElementById("reveal-password");
      const submit = document.getElementById("access-submit");
      reveal.addEventListener("click", () => {
        const showing = password.type === "text";
        password.type = showing ? "password" : "text";
        reveal.textContent = showing ? "显示" : "隐藏";
        reveal.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
        reveal.setAttribute("aria-pressed", String(!showing));
        password.focus({ preventScroll: true });
      });
      form.addEventListener("submit", (event) => {
        if (!password.value) {
          event.preventDefault();
          password.focus();
          return;
        }
        submit.dataset.loading = "true";
        submit.disabled = true;
        submit.setAttribute("aria-busy", "true");
      });
    })();
  </script>
</body>
</html>`;
}

function systemUnavailablePage() {
  return "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>暂时无法访问</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;color:#24332d;background:#f4faf7}main{padding:28px;text-align:center}p{color:#718078}</style><main><h1>暂时无法访问</h1><p>页面服务正在恢复，请稍后重试。</p></main>";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export const __test = {
  handleRequest,
  safeNext,
  isPublicAssetPath,
  isPrivateStudyPath,
  ownerAdminRedirect,
  ownerNotesRedirect,
  constantTimeEqual,
  loginFailures,
};
