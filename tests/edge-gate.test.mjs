import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");

const { default: worker, __test } = await import("../edge-gate.js");

const password = "correct-horse-battery-staple";
const passwordHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password))).toString("hex");
const env = {
  SITE_PASSWORD_HASH: passwordHash,
  SITE_SESSION_SECRET: "test-session-secret-that-is-long-and-random-enough",
  OWNER_BRIDGE_SECRET: "test-owner-bridge-secret-with-at-least-32-bytes",
  ASSETS: {
    async fetch(request) {
      return new Response(`asset:${new URL(request.url).pathname}`, {
        headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=600" },
      });
    },
  },
};

function request(path, init = {}) {
  return new Request(`https://www.zouyihui.me${path}`, init);
}

function formRequest(path, body, extraHeaders = {}) {
  return request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://www.zouyihui.me",
      "CF-Connecting-IP": "203.0.113.10",
      ...extraHeaders,
    },
    body: new URLSearchParams(body),
  });
}

let response = await worker.fetch(request("/"), env);
assert.equal(response.status, 200);
assert.equal(await response.text(), "asset:/");
assert.match(response.headers.get("cache-control"), /public, max-age=300/);

response = await worker.fetch(request("/assets/mark.svg"), env);
assert.equal(response.status, 200);

response = await worker.fetch(request("/apps/portal/?invite=one-time"), env);
assert.equal(response.status, 200);

response = await worker.fetch(request("/config/portal.config.js"), env);
assert.equal(response.status, 200);

response = await worker.fetch(request("/apps/admin/"), env);
assert.equal(response.status, 200);

response = await worker.fetch(request("/personal/"), env);
assert.equal(response.status, 303);
assert.equal(new URL(response.headers.get("location")).pathname, "/__access");
assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);

response = await worker.fetch(request("/__access?next=https://evil.example/steal"), env);
assert.equal(response.status, 200);
const accessDocument = await response.text();
assert.match(accessDocument, /name="next" value="\/"/);
assert.match(accessDocument, /PERSONAL SPACE/);
assert.match(accessDocument, /src="\/assets\/mark\.svg"/);

response = await worker.fetch(formRequest("/__access/login", { password: "wrong", next: "/personal/" }), env);
assert.equal(response.status, 401);
assert.equal(response.headers.get("set-cookie"), null);
assert.match(await response.text(), /访问密码不正确/);

response = await worker.fetch(formRequest("/__access/login", { password, next: "/personal/" }), env);
assert.equal(response.status, 303);
assert.equal(new URL(response.headers.get("location")).pathname, "/personal/");
const setCookie = response.headers.get("set-cookie");
assert.match(setCookie, /__Host-zouyihui_session=/);
assert.match(setCookie, /HttpOnly/);
assert.match(setCookie, /Secure/);
assert.match(setCookie, /SameSite=Strict/);
const sessionCookie = setCookie.split(";", 1)[0];

response = await worker.fetch(request("/personal/", { headers: { Cookie: sessionCookie } }), env);
assert.equal(response.status, 200);
assert.equal(await response.text(), "asset:/personal/");
assert.equal(response.headers.get("cache-control"), "private, no-store");

response = await worker.fetch(request("/__access/owner-admin", { headers: { Cookie: sessionCookie } }), env);
assert.equal(response.status, 303);
const ownerLocation = new URL(response.headers.get("location"));
assert.equal(ownerLocation.pathname, "/apps/admin/");
assert.match(ownerLocation.hash, /^#owner=v1\.[0-9]+\.[A-Za-z0-9_-]{32,64}\.[A-Za-z0-9_-]{40,48}$/);
assert.equal(response.headers.get("cache-control"), "no-store");

const tamperedCookie = `${sessionCookie.slice(0, -1)}x`;
response = await worker.fetch(request("/personal/", { headers: { Cookie: tamperedCookie } }), env);
assert.equal(response.status, 303);

response = await worker.fetch(formRequest("/__access/logout", {}), env);
assert.equal(response.status, 303);
assert.match(response.headers.get("set-cookie"), /Max-Age=0/);

response = await worker.fetch(new Request("https://zouyihui.me/apps/portal/?event=abc"), env);
assert.equal(response.status, 308);
assert.equal(new URL(response.headers.get("location")).hostname, "www.zouyihui.me");

assert.equal(__test.safeNext("//evil.example"), "/");
assert.equal(__test.safeNext("/apps/portal/?event=abc"), "/apps/portal/?event=abc");
assert.equal(__test.isPublicAssetPath("/"), true);
assert.equal(__test.isPublicAssetPath("/apps/portal/portal.js"), true);
assert.equal(__test.isPublicAssetPath("/apps/admin/admin.js"), true);
assert.equal(__test.isPublicAssetPath("/personal/"), false);
assert.equal(__test.constantTimeEqual("same", "same"), true);
assert.equal(__test.constantTimeEqual("same", "different"), false);

console.log("edge-gate tests: OK");
