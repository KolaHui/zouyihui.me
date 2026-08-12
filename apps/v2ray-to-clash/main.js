/* V2Ray → Clash 转换页的界面逻辑。
   转换本身全在浏览器里跑；只有「生成订阅链接」才会碰后端。 */
(() => {
  "use strict";

  const apiBase = String(window.AI_API_BASE_URL || "").replace(/\/$/, "");
  const el = (id) => document.getElementById(id);

  const state = {
    yaml: "",
    links: [],       // 原始节点链接，用来出单节点二维码
    proxies: [],
    backendOnline: false,
  };

  // ── 后端探活 ────────────────────────────────────────────
  async function probeBackend() {
    if (!apiBase) return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${apiBase}/api/config`, { signal: ctrl.signal });
      clearTimeout(timer);
      return r.ok;
    } catch (e) {
      return false;
    }
  }

  function renderBackendStatus() {
    const dot = el("be-dot");
    const text = el("be-text");
    const desc = el("sub-desc");
    if (state.backendOnline) {
      dot.className = "dot on";
      text.textContent = "后端在线，可以生成订阅链接";
      desc.textContent = "会安全保存配置并生成一个临时订阅网址，需要输入访问密码。";
      el("btn-sub").disabled = false;
    } else {
      dot.className = "dot off";
      text.textContent = "后端不在线";
      desc.textContent = "订阅服务暂时不可用，请直接下载 .yaml 文件导入 Clash。";
      el("btn-sub").disabled = true;
    }
  }

  // ── 转换 ────────────────────────────────────────────────
  function convert() {
    const text = el("input").value;
    if (!text.trim()) {
      alert("请先粘贴节点链接");
      return;
    }

    const { links, notes, subUrls } = window.V2Clash.expandInput(text);
    const { proxies, errors } = window.V2Clash.parseLinks(links);

    if (subUrls.length) {
      notes.push(
        `有 ${subUrls.length} 条订阅网址被跳过：浏览器不能跨域拉取别人家的订阅，` +
        `请把节点链接本身贴进来，或改用本地版工具。`
      );
    }

    const yaml = window.V2Clash.buildConfig(proxies, {
      mode: el("mode").value,
      testUrl: el("testurl").value,
      mixedPort: parseInt(el("port").value, 10) || 7890,
      allowLan: el("lan").checked,
      regionGroups: el("region").checked,
    });

    state.yaml = yaml;
    state.links = links;
    state.proxies = proxies;

    render(proxies, errors, notes, yaml);
  }

  function render(proxies, errors, notes, yaml) {
    el("result").classList.remove("hide");

    const byType = {};
    for (const p of proxies) byType[p.type] = (byType[p.type] || 0) + 1;

    const tags = el("tags");
    tags.innerHTML = "";
    const addTag = (html) => {
      const s = document.createElement("span");
      s.className = "tag";
      s.innerHTML = html;
      tags.appendChild(s);
    };
    addTag(`识别节点 <b>${proxies.length}</b> 个`);
    for (const [k, v] of Object.entries(byType)) addTag(`${k} <b>${v}</b>`);
    if (errors.length) addTag(`失败 <b>${errors.length}</b> 条`);

    const msgs = el("msgs");
    msgs.innerHTML = "";
    const addMsg = (cls, txt) => {
      const d = document.createElement("div");
      d.className = `msg ${cls}`;
      d.textContent = txt;
      msgs.appendChild(d);
    };
    notes.forEach((m) => addMsg("note", m));
    errors.slice(0, 20).forEach((m) => addMsg("err", m));

    el("yaml").textContent = yaml;

    // 单节点二维码：链接太长的（超出二维码容量）跳过并说明
    const grid = el("qrs");
    grid.innerHTML = "";
    state.links.forEach((link, i) => {
      const name = proxies[i] ? proxies[i].name : `节点 ${i + 1}`;
      const item = document.createElement("div");
      item.className = "qr-item";
      try {
        item.innerHTML = window.QR.makeSvg(link, { scale: 4, border: 2 });
      } catch (e) {
        item.innerHTML = `<div class="nm" style="padding:24px 0">链接过长，无法生成二维码</div>`;
      }
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = name;
      item.appendChild(nm);
      grid.appendChild(item);
    });

    // 每次重新转换后，之前生成的订阅链接就作废了
    el("sub-done").classList.add("hide");
    el("sub-idle").classList.remove("hide");

    el("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── 生成订阅链接（走后端）──────────────────────────────
  async function makeSubscription() {
    if (!state.yaml) return;
    const btn = el("btn-sub");
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      let auth = window.AiAuth ? await window.AiAuth.authHeaders() : {};
      let resp = await fetch(`${apiBase}/api/clash-sub`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ yaml: state.yaml, name: "clash-转换配置" }),
      });
      if (resp.status === 401 && window.AiAuth) {
        auth = await window.AiAuth.reauth();
        resp = await fetch(`${apiBase}/api/clash-sub`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify({ yaml: state.yaml, name: "clash-转换配置" }),
        });
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      const url = `${apiBase}/sub/${data.token}`;
      el("suburl").value = url;
      el("subqr").innerHTML = window.QR.makeSvg(url, { scale: 6, border: 3 });
      el("sub-idle").classList.add("hide");
      el("sub-done").classList.remove("hide");
    } catch (e) {
      alert("生成订阅链接失败：" + e.message);
    }
    btn.disabled = false;
    btn.textContent = "生成订阅链接";
  }

  // ── 复制 / 下载 ────────────────────────────────────────
  function toast(text) {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText =
      "position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(15,23,42,.9);" +
      "color:#fff;padding:10px 20px;border-radius:999px;font-size:14px;z-index:99";
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1600);
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch (e) {
      // http 页面或旧浏览器拿不到剪贴板权限时的兜底
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast(okMsg); } catch (_) { alert("复制失败，请手动选中复制"); }
      ta.remove();
    }
  }

  function downloadYaml() {
    const blob = new Blob([state.yaml], { type: "text/yaml;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "clash.yaml";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── 绑定 ────────────────────────────────────────────────
  el("go").addEventListener("click", convert);
  el("btn-copy").addEventListener("click", () => copyText(state.yaml, "配置全文已复制"));
  el("btn-download").addEventListener("click", downloadYaml);
  el("btn-sub").addEventListener("click", makeSubscription);
  el("btn-copy-url").addEventListener("click", () => copyText(el("suburl").value, "订阅链接已复制"));

  probeBackend().then((ok) => {
    state.backendOnline = ok;
    renderBackendStatus();
  });
})();
