/* 导航 —— 个人空间的网址收藏
   ============================================================
   数据只存在这台浏览器的 localStorage 里，没有走后端。
   换浏览器、清网站数据都会没有，别把它当唯一副本。

   两个视图共用同一份顺序（你拖出来的顺序），只有一个例外：
   在一览里选中的那个，切到详细时会被临时拎到第一行 ——
   只是显示上提前，数组顺序没动。
   ============================================================ */
(() => {
  "use strict";

  const STORE = "zouyihui-nav-v1";
  const VIEW_STORE = "zouyihui-nav-view";
  const DRAG_SLOP = 7;         // 超过这个位移才算拖动，不算点击

  /* 第一次打开时的底子，之后完全由你自己增删 */
  const SEED = [
    { name: "GitHub", url: "https://github.com", note: "代码托管。这个站的前端仓库 zouyihui.me 和后端 zouyihui-backend 都在这儿。" },
    { name: "Cloudflare", url: "https://dash.cloudflare.com", note: "本站的域名、Worker 和隧道都在这里管。edge-gate 那个访问密码也是在这儿配的 Secret。" },
    { name: "苹果", url: "https://www.apple.com.cn", note: "Apple 中国官网。查机型参数、看设计规范的时候常来。" },
    { name: "哔哩哔哩", url: "https://www.bilibili.com", note: "视频站。技术教程和杂七杂八的都在这儿看。" },
    { name: "知乎", url: "https://www.zhihu.com", note: "问答社区。查经验贴、看别人踩过的坑。" },
    { name: "少数派", url: "https://sspai.com", note: "效率工具和数字生活的中文站，找 App 和工作流的时候翻。" },
    { name: "V2EX", url: "https://www.v2ex.com", note: "程序员社区。节点杂但信息新，偶尔能捡到好东西。" },
    { name: "淘宝", url: "https://www.taobao.com", note: "买东西。" },
  ];

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const editBar = $("editBar");
  const hint = $("hint");
  const editor = $("editor");
  const form = $("editorForm");
  const formError = $("formError");

  let sites = load();
  let view = localStorage.getItem(VIEW_STORE) === "list" ? "list" : "icon";
  let selectedId = null;       // 只在本次浏览有效，不写进存储
  let editing = false;
  let editingId = null;        // 正在表单里改的那条

  /* ── 存取 ────────────────────────────────────────────── */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || "null");
      if (raw && Array.isArray(raw.sites) && raw.sites.length) {
        return raw.sites.filter((s) => s && s.url).map(normalize);
      }
    } catch { /* 存坏了就退回种子，不让页面开不了 */ }
    return SEED.map(normalize);
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ v: 1, sites }));
    } catch {
      hint.textContent = "存不进去了 —— 浏览器的存储可能满了或被禁用。";
    }
  }
  function normalize(s) {
    return {
      id: s.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: String(s.name || "").trim() || hostOf(s.url) || "未命名",
      url: fixUrl(s.url),
      note: String(s.note || "").trim(),
      icon: String(s.icon || "").trim(),
    };
  }
  function fixUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  }
  function hostOf(url) {
    try { return new URL(fixUrl(url)).hostname.replace(/^www\./, ""); } catch { return ""; }
  }

  /* ── 图标 ────────────────────────────────────────────── */
  /* 依次试：你填的地址 → 站点的 apple-touch-icon → 站点的 favicon
     全都拿不到就退回首字母色块。不依赖任何第三方图标服务，
     省得哪天那个服务连不上，一整页图标全空。 */
  function iconChain(site) {
    const list = [];
    if (site.icon) list.push(site.icon);
    try {
      const origin = new URL(site.url).origin;
      list.push(`${origin}/apple-touch-icon.png`);
      list.push(`${origin}/favicon.ico`);
    } catch { /* 网址不合法就只剩首字母 */ }
    return list;
  }
  function hueOf(text) {
    let h = 0;
    for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 360;
    return h;
  }
  function buildIcon(site) {
    const box = document.createElement("span");
    box.className = "icon";
    const chain = iconChain(site);
    const letter = () => {
      const span = document.createElement("span");
      span.className = "letter";
      span.style.background = `linear-gradient(145deg, hsl(${hueOf(site.url)} 58% 62%), hsl(${(hueOf(site.url) + 26) % 360} 62% 47%))`;
      span.textContent = (site.name || "?").trim().charAt(0).toUpperCase();
      box.replaceChildren(span);
    };
    if (!chain.length) { letter(); return box; }
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    let at = 0;
    img.addEventListener("error", () => {
      at += 1;
      if (at < chain.length) img.src = chain[at];
      else letter();
    });
    img.src = chain[0];
    box.append(img);
    return box;
  }

  /* ── 顺序 ────────────────────────────────────────────── */
  /* 详细视图里把选中的那个临时提到第一行；一览保持原样 */
  function ordered() {
    if (view !== "list" || !selectedId) return sites;
    const at = sites.findIndex((s) => s.id === selectedId);
    if (at <= 0) return sites;
    return [sites[at], ...sites.slice(0, at), ...sites.slice(at + 1)];
  }

  /* ── 渲染 ────────────────────────────────────────────── */
  function render() {
    $("viewIcon").setAttribute("aria-pressed", String(view === "icon"));
    $("viewList").setAttribute("aria-pressed", String(view === "list"));
    editBar.dataset.on = String(editing);
    $("editBtn").textContent = editing ? "完成" : "编辑";
    $("editBtn").hidden = view !== "icon";

    if (!sites.length) {
      stage.replaceChildren(Object.assign(document.createElement("div"), {
        className: "empty",
        textContent: "还没有收藏。点右上角「添加」放第一个进来。",
      }));
      hint.textContent = "";
      return;
    }
    hint.textContent = view === "icon"
      ? "点右上角「编辑」后，可以拖动图标重新排序。"
      : "选中的那个会临时排在第一行。";
    stage.replaceChildren(view === "icon" ? renderGrid() : renderList());
  }

  function renderGrid() {
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.id = "grid";
    grid.dataset.editing = String(editing);
    sites.forEach((site) => {
      const card = document.createElement("button");
      card.className = "card";
      card.type = "button";
      card.dataset.id = site.id;
      card.dataset.selected = String(site.id === selectedId);
      card.title = site.note || site.url;
      card.setAttribute("aria-label", `${site.name}${site.id === selectedId ? "（已选中，再点一次打开）" : ""}`);

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = site.name;

      const go = document.createElement("span");
      go.className = "go";
      go.textContent = "再点一次打开";

      const del = document.createElement("span");
      del.className = "badge";
      del.setAttribute("role", "button");
      del.setAttribute("aria-label", `删除 ${site.name}`);
      del.textContent = "×";

      card.append(buildIcon(site), name, go, del);
      grid.append(card);
    });
    bindGrid(grid);
    return grid;
  }

  function renderList() {
    const list = document.createElement("div");
    list.className = "list";
    ordered().forEach((site, index) => {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.id = site.id;
      row.dataset.selected = String(site.id === selectedId);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `${site.name}${site.id === selectedId ? "（已选中，再点一次打开）" : ""}`);

      const main = document.createElement("div");
      main.className = "row-main";
      const nm = document.createElement("strong");
      nm.className = "row-name";
      nm.textContent = site.name;
      if (index === 0 && site.id === selectedId && sites[0]?.id !== site.id) {
        const flag = document.createElement("span");
        flag.className = "first-flag";
        flag.textContent = "选中";
        nm.append(flag);
      }
      const link = document.createElement("span");
      link.className = "row-url";
      link.textContent = site.url.replace(/^https?:\/\//, "");
      main.append(nm, link);

      const note = document.createElement("div");
      note.className = "row-note";
      note.textContent = site.note;

      const side = document.createElement("div");
      side.className = "row-side";
      const edit = document.createElement("button");
      edit.className = "mini";
      edit.type = "button";
      edit.title = "编辑";
      edit.setAttribute("aria-label", `编辑 ${site.name}`);
      edit.textContent = "✎";
      edit.addEventListener("click", (e) => { e.stopPropagation(); openEditor(site.id); });
      const del = document.createElement("button");
      del.className = "mini del";
      del.type = "button";
      del.title = "删除";
      del.setAttribute("aria-label", `删除 ${site.name}`);
      del.textContent = "🗑";
      del.addEventListener("click", (e) => { e.stopPropagation(); removeSite(site.id); });
      side.append(edit, del);

      const hit = () => activate(site.id);
      row.addEventListener("click", hit);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hit(); }
      });

      row.append(buildIcon(site), main, note, side);
      list.append(row);
    });
    return list;
  }

  /* 只改选中态，不重建 DOM ——
     整片重渲染会让所有站点图标重新请求一遍，点一下闪一次，很难看。
     详细视图里的置顶也不在这里做：用户要的是「切换视图时」才提到第一行，
     在详细里点一下就自己跳到顶部反而莫名其妙。 */
  function updateSelection() {
    for (const el of document.querySelectorAll(".card, .row")) {
      el.dataset.selected = String(el.dataset.id === selectedId);
    }
  }

  /* 点第一次选中，点第二次才打开 */
  function activate(id) {
    if (selectedId !== id) {
      selectedId = id;
      updateSelection();
      return;
    }
    const site = sites.find((s) => s.id === id);
    if (site) window.open(site.url, "_blank", "noopener,noreferrer");
  }

  /* ── 一览的指针操作：编辑态拖动排序、普通态点击选中 ──── */
  function bindGrid(grid) {
    let dragEl = null;
    let baseX = 0, baseY = 0;  // 指针原点（会随 DOM 重排校正）
    let moved = false;
    let activePointer = null;

    function rects() {
      const map = new Map();
      for (const el of grid.children) map.set(el, el.getBoundingClientRect());
      return map;
    }
    /* FLIP：让让位的图标从旧位置滑到新位置，而不是瞬间跳过去。
       用 Web Animations 而不是「设 transform + rAF 里清掉」——
       后台标签里 rAF 不跑，那种写法会把图标永久卡在错位上。
       动画不带 fill，跑完自己回到无 transform 的状态。 */
    function flip(prev) {
      for (const el of grid.children) {
        if (el === dragEl) continue;
        const before = prev.get(el);
        if (!before) continue;
        const after = el.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (!dx && !dy) continue;
        el.getAnimations().forEach((a) => a.cancel());
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          { duration: 260, easing: "cubic-bezier(.2,.9,.2,1)" },
        );
      }
    }
    function nearest(x, y) {
      let best = null, bestDist = Infinity;
      for (const el of grid.children) {
        if (el === dragEl) continue;
        const r = el.getBoundingClientRect();
        const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (d < bestDist) { bestDist = d; best = el; }
      }
      return best;
    }

    function beginDrag(card, x, y) {
      dragEl = card;
      baseX = x;
      baseY = y;
      moved = false;
      card.classList.add("dragging");
      card.classList.remove("settling");
    }

    function onMove(e) {
      if (e.pointerId !== activePointer) return;
      const dx = e.clientX - baseX;
      const dy = e.clientY - baseY;
      if (!dragEl) return;
      if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      moved = true;
      e.preventDefault();
      dragEl.style.transform = `translate(${dx}px, ${dy}px)`;

      const over = nearest(e.clientX, e.clientY);
      if (!over) return;
      const kids = [...grid.children];
      const from = kids.indexOf(dragEl);
      const to = kids.indexOf(over);
      if (from === to) return;

      const prev = rects();
      const seen = dragEl.getBoundingClientRect();
      grid.insertBefore(dragEl, to > from ? over.nextSibling : over);
      // DOM 位置换了，transform 的基准也跟着变 —— 校正原点，
      // 否则图标会在换位的瞬间跳一下
      dragEl.style.transform = "";
      const now = dragEl.getBoundingClientRect();
      baseX += now.left - seen.left;
      baseY += now.top - seen.top;
      dragEl.style.transform = `translate(${e.clientX - baseX}px, ${e.clientY - baseY}px)`;
      flip(prev);
    }

    function onUp(e) {
      if (e.pointerId !== activePointer) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      activePointer = null;

      if (dragEl) {
        const card = dragEl;
        const wasMoved = moved;
        card.classList.add("settling");
        card.style.transform = "";
        card.classList.remove("dragging");
        setTimeout(() => card.classList.remove("settling"), 280);
        dragEl = null;
        if (wasMoved) {
          const order = [...grid.children].map((el) => el.dataset.id);
          sites.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
          save();
        } else if (editing) {
          openEditor(card.dataset.id);      // 编辑模式下没拖动 = 想改它
        }
        return;
      }
    }

    grid.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      const badge = e.target.closest(".badge");
      const card = e.target.closest(".card");
      if (!card) return;
      if (badge) {                          // 红点只删除，不参与拖动
        e.preventDefault();
        removeSite(card.dataset.id);
        return;
      }
      if (!editing) return;
      activePointer = e.pointerId;
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      beginDrag(card, e.clientX, e.clientY);
    });

    grid.addEventListener("click", (e) => {
      if (editing || e.target.closest(".badge")) return;
      const card = e.target.closest(".card");
      if (card) activate(card.dataset.id);
    });

    grid.addEventListener("contextmenu", (e) => { if (editing) e.preventDefault(); });
  }

  function setEditing(on) {
    editing = on;
    render();
  }

  /* ── 增删改 ──────────────────────────────────────────── */
  function removeSite(id) {
    const site = sites.find((s) => s.id === id);
    if (!site) return;
    if (!confirm(`删除「${site.name}」？`)) return;
    sites = sites.filter((s) => s.id !== id);
    if (selectedId === id) selectedId = null;
    save();
    render();
  }

  function openEditor(id) {
    editingId = id || null;
    const site = id ? sites.find((s) => s.id === id) : null;
    $("editorTitle").textContent = site ? "编辑网站" : "添加网站";
    $("fName").value = site ? site.name : "";
    $("fUrl").value = site ? site.url : "";
    $("fNote").value = site ? site.note : "";
    $("fIcon").value = site ? site.icon : "";
    formError.textContent = "";
    editor.showModal();
    $("fName").focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("fName").value.trim();
    const url = fixUrl($("fUrl").value);
    if (!name) { formError.textContent = "名称不能空着。"; return; }
    let parsed;
    try { parsed = new URL(url); } catch { formError.textContent = "这个网址看不懂，检查一下。"; return; }
    if (!/^https?:$/.test(parsed.protocol)) { formError.textContent = "只收 http / https 的网址。"; return; }

    const patch = { name, url, note: $("fNote").value.trim(), icon: $("fIcon").value.trim() };
    if (editingId) {
      const at = sites.findIndex((s) => s.id === editingId);
      if (at >= 0) sites[at] = { ...sites[at], ...patch };
    } else {
      sites.push(normalize(patch));
    }
    editingId = null;
    save();
    editor.close();
    render();
  });

  $("cancelBtn").addEventListener("click", () => { editingId = null; editor.close(); });

  /* ── 顶栏 ────────────────────────────────────────────── */
  function setView(next) {
    view = next;
    localStorage.setItem(VIEW_STORE, next);
    if (next === "list") editing = false;   // 详细视图没有拖动排序
    render();
  }
  $("viewIcon").addEventListener("click", () => setView("icon"));
  $("viewList").addEventListener("click", () => setView("list"));
  $("editBtn").addEventListener("click", () => setEditing(!editing));
  $("doneBtn").addEventListener("click", () => setEditing(false));
  $("addBtn").addEventListener("click", () => openEditor(null));

  // 点空白处退出编辑
  document.addEventListener("pointerdown", (e) => {
    if (!editing) return;
    if (e.target.closest(".card") || e.target.closest(".edit-bar") || e.target.closest(".top")) return;
    setEditing(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editing && !editor.open) setEditing(false);
  });

  render();
})();
