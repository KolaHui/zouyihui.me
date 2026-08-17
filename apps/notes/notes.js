(() => {
  "use strict";

  const config = window.PORTAL_CONFIG || {};
  const isLocal = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const API_BASE = String(isLocal ? window.location.origin : config.apiBaseUrl || window.location.origin).replace(/\/$/, "");
  const API = `${API_BASE}/api/collection/admin`;
  const TOKEN_KEY = "zouyihui_owner_notes_token_v1";
  const SAVE_DELAY = 650;

  const $ = (id) => document.getElementById(id);
  const ui = {
    bootScreen: $("bootScreen"), bootTitle: $("bootTitle"), bootMessage: $("bootMessage"), bootAction: $("bootAction"),
    noteApp: $("noteApp"), newNoteBtn: $("newNoteBtn"), emptyCreateBtn: $("emptyCreateBtn"), searchInput: $("searchInput"),
    folderNav: $("folderNav"), noteList: $("noteList"), mobileMenuBtn: $("mobileMenuBtn"), sidebarScrim: $("sidebarScrim"),
    crumbFolder: $("crumbFolder"), crumbTitle: $("crumbTitle"), deleteNoteBtn: $("deleteNoteBtn"), emptyEditor: $("emptyEditor"),
    editorGrid: $("editorGrid"), noteTitle: $("noteTitle"), noteFolder: $("noteFolder"), noteContent: $("noteContent"),
    markdownPreview: $("markdownPreview"), wordCount: $("wordCount"), syncIndicator: $("syncIndicator"), syncText: $("syncText"),
  };

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || "",
    notes: [], active: null, folder: "全部", query: "", dirty: false, saving: false, saveTimer: 0, loadSeq: 0,
  };

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code || ""; }
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    if (options.auth !== false && state.token) headers.Authorization = `Bearer ${state.token}`;
    const init = { method: options.method || "GET", headers, cache: "no-store" };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response;
    try { response = await fetch(`${API}${path}`, init); }
    catch { throw new ApiError("无法连接 Mac，请检查本机服务和网络。", 0, "NETWORK_ERROR"); }
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new ApiError(data.error || `请求失败（${response.status}）`, response.status, data.error_code);
    return data;
  }

  function takeOwnerAssertion() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const assertion = params.get("owner") || "";
    if (window.location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
    return assertion;
  }

  function setToken(token) {
    state.token = token || "";
    if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  function showBoot(title, message, action = false) {
    ui.bootTitle.textContent = title;
    ui.bootMessage.textContent = message;
    ui.bootAction.hidden = !action;
    ui.bootScreen.hidden = false;
    ui.noteApp.hidden = true;
  }

  function showApp() { ui.bootScreen.hidden = true; ui.noteApp.hidden = false; }

  function setSync(status, text) {
    ui.syncIndicator.hidden = !state.active;
    ui.syncIndicator.dataset.state = status;
    ui.syncText.textContent = text;
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚";
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function filteredNotes() {
    const query = state.query.trim().toLowerCase();
    return state.notes.filter((note) => {
      const inFolder = state.folder === "全部" || note.folder === state.folder;
      const haystack = `${note.title} ${note.excerpt || ""} ${note.folder}`.toLowerCase();
      return inFolder && (!query || haystack.includes(query));
    });
  }

  function renderFolders() {
    const folders = ["全部", ...new Set(state.notes.map((note) => note.folder || "未分类"))];
    ui.folderNav.replaceChildren(...folders.map((folder) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "folder-chip";
      button.textContent = folder;
      button.setAttribute("aria-pressed", String(folder === state.folder));
      button.addEventListener("click", () => { state.folder = folder; renderFolders(); renderNotes(); });
      return button;
    }));
  }

  function renderNotes() {
    const notes = filteredNotes();
    if (!notes.length) {
      const empty = document.createElement("p");
      empty.className = "list-empty";
      empty.textContent = state.notes.length ? "没有找到符合条件的笔记。" : "还没有笔记。点击右上角 ＋ 开始记录。";
      ui.noteList.replaceChildren(empty);
      return;
    }
    ui.noteList.replaceChildren(...notes.map((note) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "note-card";
      button.setAttribute("aria-current", String(state.active?.id === note.id));
      const title = document.createElement("strong");
      title.textContent = note.title || "未命名笔记";
      const excerpt = document.createElement("span");
      excerpt.textContent = note.excerpt || "空白笔记";
      const time = document.createElement("small");
      time.textContent = `${note.folder || "未分类"} · ${formatTime(note.updated_at)}`;
      button.append(title, excerpt, time);
      button.addEventListener("click", () => selectNote(note.id));
      return button;
    }));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function inlineMarkdown(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }

  function renderMarkdown(value) {
    const lines = String(value || "").split(/\r?\n/);
    const html = [];
    let listOpen = false;
    const closeList = () => { if (listOpen) { html.push("</ul>"); listOpen = false; } };
    for (const line of lines) {
      if (/^###\s+/.test(line)) { closeList(); html.push(`<h3>${inlineMarkdown(line.replace(/^###\s+/, ""))}</h3>`); }
      else if (/^##\s+/.test(line)) { closeList(); html.push(`<h2>${inlineMarkdown(line.replace(/^##\s+/, ""))}</h2>`); }
      else if (/^#\s+/.test(line)) { closeList(); html.push(`<h1>${inlineMarkdown(line.replace(/^#\s+/, ""))}</h1>`); }
      else if (/^>\s?/.test(line)) { closeList(); html.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`); }
      else if (/^[-*]\s+/.test(line)) { if (!listOpen) { html.push("<ul>"); listOpen = true; } html.push(`<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`); }
      else if (!line.trim()) { closeList(); }
      else { closeList(); html.push(`<p>${inlineMarkdown(line)}</p>`); }
    }
    closeList();
    ui.markdownPreview.innerHTML = html.join("") || '<p class="preview-empty">预览会在这里出现。</p>';
  }

  function updateWordCount() {
    const text = ui.noteContent.value;
    const chars = text.replace(/\s/g, "").length;
    const words = (text.match(/[A-Za-z0-9]+|[\u3400-\u9fff]/g) || []).length;
    ui.wordCount.textContent = `${chars} 字 · ${words} 词元`;
  }

  function refreshEditor() {
    const note = state.active;
    const hasNote = Boolean(note);
    ui.emptyEditor.hidden = hasNote;
    ui.editorGrid.hidden = !hasNote;
    ui.wordCount.hidden = !hasNote;
    ui.deleteNoteBtn.disabled = !hasNote;
    if (!note) { setSync("idle", "等待编辑"); return; }
    ui.noteTitle.value = note.title || "";
    ui.noteFolder.value = note.folder || "未分类";
    ui.noteContent.value = note.content || "";
    ui.crumbFolder.textContent = note.folder || "未分类";
    ui.crumbTitle.textContent = ` · ${note.title || "未命名笔记"}`;
    renderMarkdown(note.content);
    updateWordCount();
    setSync("saved", `已同步到 Mac · ${formatTime(note.updated_at)}`);
  }

  function upsertSummary(note) {
    const compact = String(note.content || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const summary = { ...note, excerpt: compact };
    const index = state.notes.findIndex((item) => item.id === note.id);
    if (index >= 0) state.notes.splice(index, 1);
    state.notes.unshift(summary);
    renderFolders();
    renderNotes();
  }

  async function loadNotes() {
    const data = await api("/notes");
    state.notes = Array.isArray(data.notes) ? data.notes : [];
    renderFolders();
    renderNotes();
    if (state.notes.length) await selectNote(state.notes[0].id, true);
    else refreshEditor();
  }

  async function selectNote(id, initial = false) {
    if (state.active?.id === id) { closeSidebar(); return; }
    if (!initial && state.dirty) {
      const saved = await saveActive();
      if (!saved) return;
    }
    const seq = ++state.loadSeq;
    setSync("saving", "正在读取…");
    try {
      const data = await api(`/notes/${encodeURIComponent(id)}`);
      if (seq !== state.loadSeq) return;
      state.active = data.note;
      state.dirty = false;
      refreshEditor();
      renderNotes();
      closeSidebar();
    } catch (error) { handleApiError(error, "读取笔记失败"); }
  }

  async function createNote() {
    if (state.dirty && !(await saveActive())) return;
    setSync("saving", "正在新建…");
    try {
      const data = await api("/notes", { method: "POST", body: { title: "未命名笔记", folder: "未分类", content: "" } });
      state.active = data.note;
      state.dirty = false;
      upsertSummary(data.note);
      refreshEditor();
      closeSidebar();
      requestAnimationFrame(() => ui.noteTitle.select());
    } catch (error) { handleApiError(error, "新建笔记失败"); }
  }

  function scheduleSave() {
    state.dirty = true;
    clearTimeout(state.saveTimer);
    setSync(navigator.onLine ? "saving" : "error", navigator.onLine ? "等待同步到 Mac…" : "网络已断开，尚未同步");
    state.saveTimer = window.setTimeout(saveActive, SAVE_DELAY);
  }

  async function saveActive() {
    clearTimeout(state.saveTimer);
    if (!state.active || !state.dirty) return true;
    if (state.saving) { state.saveTimer = window.setTimeout(saveActive, SAVE_DELAY); return false; }
    state.saving = true;
    const noteId = state.active.id;
    const submitted = { title: ui.noteTitle.value, folder: ui.noteFolder.value, content: ui.noteContent.value };
    const revision = state.active.revision;
    setSync("saving", "正在同步到 Mac…");
    try {
      const data = await api(`/notes/${encodeURIComponent(noteId)}`, { method: "PATCH", body: { ...submitted, expected_revision: revision } });
      if (state.active?.id !== noteId) return true;
      const unchanged = ui.noteTitle.value === submitted.title && ui.noteFolder.value === submitted.folder && ui.noteContent.value === submitted.content;
      state.active = { ...data.note, ...(unchanged ? {} : { title: ui.noteTitle.value, folder: ui.noteFolder.value, content: ui.noteContent.value }) };
      state.dirty = !unchanged;
      upsertSummary(data.note);
      ui.crumbFolder.textContent = state.active.folder || "未分类";
      ui.crumbTitle.textContent = ` · ${state.active.title || "未命名笔记"}`;
      setSync("saved", `已同步到 Mac · ${formatTime(data.note.updated_at)}`);
      if (state.dirty) state.saveTimer = window.setTimeout(saveActive, SAVE_DELAY);
      return true;
    } catch (error) {
      state.dirty = true;
      if (error.code === "NOTE_REVISION_CONFLICT") setSync("error", "另一页面已修改，请刷新后继续");
      else handleApiError(error, "同步失败");
      return false;
    } finally { state.saving = false; }
  }

  async function deleteActive() {
    if (!state.active) return;
    const title = state.active.title || "未命名笔记";
    if (!window.confirm(`确定删除“${title}”吗？此操作会同时从 Mac 数据库删除。`)) return;
    clearTimeout(state.saveTimer);
    try {
      await api(`/notes/${encodeURIComponent(state.active.id)}`, { method: "DELETE" });
      state.notes = state.notes.filter((note) => note.id !== state.active.id);
      state.active = null;
      state.dirty = false;
      renderFolders(); renderNotes(); refreshEditor();
      if (state.notes.length) await selectNote(state.notes[0].id, true);
    } catch (error) { handleApiError(error, "删除笔记失败"); }
  }

  function handleApiError(error, fallback) {
    if (error.status === 401 || error.status === 403) {
      setToken("");
      showBoot("笔记库需要重新授权", error.message || "请从我的个人空间重新进入。", true);
      return;
    }
    setSync("error", error.message || fallback);
  }

  function noteInput() {
    if (!state.active) return;
    state.active.title = ui.noteTitle.value;
    state.active.folder = ui.noteFolder.value;
    state.active.content = ui.noteContent.value;
    ui.crumbFolder.textContent = state.active.folder || "未分类";
    ui.crumbTitle.textContent = ` · ${state.active.title || "未命名笔记"}`;
    renderMarkdown(state.active.content);
    updateWordCount();
    scheduleSave();
  }

  function openSidebar() { ui.noteApp.dataset.sidebar = "open"; }
  function closeSidebar() { ui.noteApp.dataset.sidebar = "closed"; }

  function bindEvents() {
    ui.newNoteBtn.addEventListener("click", createNote);
    ui.emptyCreateBtn.addEventListener("click", createNote);
    ui.deleteNoteBtn.addEventListener("click", deleteActive);
    ui.mobileMenuBtn.addEventListener("click", openSidebar);
    ui.sidebarScrim.addEventListener("click", closeSidebar);
    ui.searchInput.addEventListener("input", () => { state.query = ui.searchInput.value; renderNotes(); });
    [ui.noteTitle, ui.noteFolder, ui.noteContent].forEach((input) => input.addEventListener("input", noteInput));
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      const mode = button.dataset.view;
      ui.editorGrid.dataset.mode = mode;
      document.querySelectorAll("[data-view]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    }));
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveActive(); }
      if (event.key === "Escape") closeSidebar();
    });
    window.addEventListener("online", () => { if (state.dirty) saveActive(); });
    window.addEventListener("offline", () => { if (state.active) setSync("error", "网络已断开，尚未同步"); });
    document.addEventListener("visibilitychange", () => { if (document.hidden && state.dirty) saveActive(); });
    window.addEventListener("beforeunload", (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
  }

  async function bootstrap() {
    bindEvents();
    const assertion = takeOwnerAssertion();
    try {
      if (assertion) {
        const data = await api("/owner-exchange", { method: "POST", auth: false, body: { assertion } });
        if (!data.token || data.admin?.role !== "owner") throw new ApiError("所有者授权无效", 403);
        setToken(data.token);
      } else if (state.token) {
        const me = await api("/me");
        if (me.admin?.role !== "owner") throw new ApiError("笔记仅限所有者访问", 403);
      } else {
        showBoot("从个人空间进入笔记", "为了保护笔记内容，请先返回我的个人空间，再点击“笔记”。", true);
        return;
      }
      showApp();
      await loadNotes();
    } catch (error) { handleApiError(error, "无法打开笔记库"); }
  }

  bootstrap();
})();
