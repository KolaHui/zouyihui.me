(() => {
  "use strict";

  // 所有后端耦合都收敛在这里，便于本地、Tunnel 与线上环境共用同一套前端。
  const portalConfig = window.PORTAL_CONFIG || {};
  const isLocalAdminPage = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const API_BASE = String(
    isLocalAdminPage
      ? window.location.origin
      : portalConfig.apiBaseUrl || window.AI_API_BASE_URL || window.location.origin
  ).replace(/\/$/, "");
  const ADMIN_API = `${API_BASE}/api/collection/admin`;
  const PUBLIC_SITE_URL = String(
    portalConfig.publicSiteUrl || new URL("../portal/", window.location.href).toString()
  ).trim();
  const TOKEN_KEY = "zouyihui_matchday_admin_token_v1";
  const AUTO_REFRESH_MS = 30000;
  const RECORD_PAGE_SIZE = 500;
  const MAX_RENDERED_RECORDS = 3000;

  const $ = (id) => document.getElementById(id);
  const ui = {
    loginScreen: $("loginScreen"),
    loginForm: $("loginForm"),
    usernameInput: $("usernameInput"),
    passwordInput: $("passwordInput"),
    loginBtn: $("loginBtn"),
    loginStatus: $("loginStatus"),
    retrySessionBtn: $("retrySessionBtn"),
    appShell: $("appShell"),
    connectionPill: $("connectionPill"),
    connectionText: $("connectionText"),
    adminName: $("adminName"),
    logoutBtn: $("logoutBtn"),
    securityBanner: $("securityBanner"),
    openPasswordBtn: $("openPasswordBtn"),
    eventList: $("eventList"),
    newEventBtn: $("newEventBtn"),
    refreshEventsBtn: $("refreshEventsBtn"),
    noEventState: $("noEventState"),
    emptyCreateBtn: $("emptyCreateBtn"),
    eventWorkspace: $("eventWorkspace"),
    heroStatus: $("heroStatus"),
    heroTitle: $("heroTitle"),
    heroCount: $("heroCount"),
    metricPeople: $("metricPeople"),
    metricBatches: $("metricBatches"),
    metricGroups: $("metricGroups"),
    metricAmount: $("metricAmount"),
    eventStatusBadge: $("eventStatusBadge"),
    eventForm: $("eventForm"),
    eventTitleInput: $("eventTitleInput"),
    closeEventBtn: $("closeEventBtn"),
    saveEventBtn: $("saveEventBtn"),
    publishEventBtn: $("publishEventBtn"),
    eventFormStatus: $("eventFormStatus"),
    publishStrip: $("publishStrip"),
    publishSymbol: $("publishSymbol"),
    publishLabel: $("publishLabel"),
    publicLinkText: $("publicLinkText"),
    inviteLabelInput: $("inviteLabelInput"),
    openInviteBtn: $("openInviteBtn"),
    generateInviteBtn: $("generateInviteBtn"),
    inviteList: $("inviteList"),
    exportExcelBtn: $("exportExcelBtn"),
    refreshRecordsBtn: $("refreshRecordsBtn"),
    lastSyncText: $("lastSyncText"),
    recordsHint: $("recordsHint"),
    recordsTableWrap: $("recordsTableWrap"),
    addRowBtn: $("addRowBtn"),
    addRowModal: $("addRowModal"),
    addRowForm: $("addRowForm"),
    addNameInput: $("addNameInput"),
    addPhoneInput: $("addPhoneInput"),
    addDocumentTypeInput: $("addDocumentTypeInput"),
    addIdcardInput: $("addIdcardInput"),
    addPriceInput: $("addPriceInput"),
    addPositionInput: $("addPositionInput"),
    addExtraInput: $("addExtraInput"),
    addRowSubmitBtn: $("addRowSubmitBtn"),
    addRowStatus: $("addRowStatus"),
    saveIndicator: $("saveIndicator"),
    discardRowsBtn: $("discardRowsBtn"),
    saveRowsBtn: $("saveRowsBtn"),
    eventModal: $("eventModal"),
    createEventForm: $("createEventForm"),
    createTitleInput: $("createTitleInput"),
    createEventSubmitBtn: $("createEventSubmitBtn"),
    createEventStatus: $("createEventStatus"),
    passwordModal: $("passwordModal"),
    passwordForm: $("passwordForm"),
    currentPasswordInput: $("currentPasswordInput"),
    newPasswordInput: $("newPasswordInput"),
    confirmPasswordInput: $("confirmPasswordInput"),
    passwordSubmitBtn: $("passwordSubmitBtn"),
    passwordCancelBtn: $("passwordCancelBtn"),
    passwordStatus: $("passwordStatus"),
    toastRegion: $("toastRegion"),
  };

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || "",
    admin: null,
    mustChangePassword: false,
    events: [],
    selectedEventId: "",
    rows: [],
    originalRows: new Map(),
    dirtyRowIds: new Set(),
    recordsLoading: false,
    recordsRequestSeq: 0,
    recordsLoadedEventId: "",
    recordsTotal: 0,
    recordsTruncated: false,
    recordsSnapshot: "",
    invites: [],
    invitesEventId: "",
    lastInviteLink: "",
    pollTimer: 0,
    lastSyncAt: null,
  };

  const EVENT_STATUS = {
    draft: { label: "草稿", className: "draft" },
    published: { label: "收集中", className: "published" },
    paused: { label: "已暂停", className: "closed" },
    closed: { label: "已结束", className: "closed" },
  };

  const EDIT_FIELDS = [
    "phone",
    "name",
    "document_type",
    "idcard",
    "price",
    "position",
    "extra",
    "group_id",
  ];

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setStatus(element, message, tone = "") {
    element.textContent = message || "";
    element.className = `status-message${tone ? ` ${tone}` : ""}`;
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = busyText || "处理中…";
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
      delete button.dataset.label;
    }
  }

  function showToast(message, tone = "ok") {
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`;
    toast.textContent = message;
    ui.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function setConnection(online, text) {
    ui.connectionPill.classList.toggle("online", Boolean(online));
    ui.connectionText.textContent = text || (online ? "主机在线" : "连接异常");
  }

  function setToken(token) {
    state.token = token || "";
    if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (state.token && options.auth !== false) headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    let response;
    try {
      response = await fetch(`${ADMIN_API}${path}`, {
        method: options.method || "GET",
        headers,
        body:
          options.body === undefined || options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body),
        cache: "no-store",
      });
    } catch (_) {
      setConnection(false, "主机离线");
      const error = new Error("无法连接当前 Mac 主机，请确认本地服务与 Cloudflare Tunnel 正在运行。");
      error.status = 0;
      throw error;
    }

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");

    if (response.status === 401 && options.auth !== false) {
      clearSession();
      showLogin("登录状态已失效，请重新登录。", "error");
      const error = new Error("登录状态已失效");
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const message =
        (data && (data.message || data.error || data.detail)) ||
        `请求失败（HTTP ${response.status}）`;
      const error = new Error(String(message));
      error.status = response.status;
      error.fieldErrors = data && data.field_errors;
      throw error;
    }
    setConnection(true, "主机在线");
    return data || {};
  }

  function unwrapList(data, keys) {
    if (Array.isArray(data)) return data;
    for (const key of keys) {
      if (Array.isArray(data && data[key])) return data[key];
    }
    return [];
  }

  function unwrapItem(data, keys) {
    if (!data || typeof data !== "object") return data;
    for (const key of keys) {
      if (data[key] && typeof data[key] === "object" && !Array.isArray(data[key])) return data[key];
    }
    return data;
  }

  function currentEvent() {
    return state.events.find((event) => String(event.id) === String(state.selectedEventId)) || null;
  }

  function parseCount(event, names, fallback = 0) {
    const counts = (event && event.counts) || {};
    for (const name of names) {
      const value = counts[name] ?? (event && event[name]);
      if (value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    return fallback;
  }

  function tomorrowTitle() {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return `${date.getMonth() + 1}月${date.getDate()}日足球赛购票需求登记`;
  }

  function formatDateTime(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function compactPhone(value) {
    const compact = String(value || "").trim().replace(/[\s-]/g, "");
    return /^1[3-9]\d{9}$/.test(compact) ? compact : "";
  }

  function validDateParts(year, month, day) {
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
  }

  function validChineseId(value) {
    const id = String(value || "").trim().toUpperCase();
    if (!/^(?:\d{15}|\d{17}[\dX])$/.test(id) || id.slice(0, 6) === "000000") return false;
    if (id.length === 15) {
      return validDateParts(`19${id.slice(6, 8)}`, id.slice(8, 10), id.slice(10, 12));
    }
    if (!validDateParts(id.slice(6, 10), id.slice(10, 12), id.slice(12, 14))) return false;
    const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
    const sum = id
      .slice(0, 17)
      .split("")
      .reduce((total, digit, index) => total + Number(digit) * factors[index], 0);
    return checks[sum % 11] === id[17];
  }

  function inviteLink(rawToken) {
    if (!rawToken) return "";
    const url = new URL(PUBLIC_SITE_URL, window.location.href);
    url.search = "";
    url.hash = "";
    url.hash = `invite=${encodeURIComponent(rawToken)}`;
    return url.toString();
  }

  function eventDeadlinePassed(event) {
    if (!event || !event.deadline) return false;
    const deadline = new Date(event.deadline).getTime();
    return Number.isFinite(deadline) && deadline <= Date.now();
  }

  function eventIsCollecting(event) {
    return Boolean(event && event.status === "published" && !eventDeadlinePassed(event));
  }

  function recordsLoadedFor(eventId) {
    return Boolean(eventId && String(state.recordsLoadedEventId) === String(eventId));
  }

  function invalidateRecordRequests() {
    state.recordsRequestSeq += 1;
    state.recordsLoading = false;
    ui.refreshRecordsBtn.disabled = false;
  }

  function resetRecordState() {
    invalidateRecordRequests();
    state.rows = [];
    state.originalRows.clear();
    state.dirtyRowIds.clear();
    state.recordsLoadedEventId = "";
    state.recordsTotal = 0;
    state.recordsTruncated = false;
    state.recordsSnapshot = "";
    state.lastSyncAt = null;
    state.invites = [];
    state.invitesEventId = "";
    state.lastInviteLink = "";
    ui.lastSyncText.textContent = "尚未同步";
    ui.recordsHint.textContent = "可横向滚动查看全部购票字段";
    updateSaveIndicator();
  }

  function restoreDirtyRows() {
    state.rows = state.rows.map((row) => {
      const original = state.originalRows.get(String(row.id));
      return original ? { ...row, ...JSON.parse(original) } : row;
    });
    state.dirtyRowIds.clear();
    invalidateRecordRequests();
  }

  function guardDirty(actionLabel) {
    if (!state.dirtyRowIds.size) return true;
    const confirmed = window.confirm(
      `当前表格有 ${state.dirtyRowIds.size} 行未保存修改，${actionLabel}会丢失这些修改。确定继续？`
    );
    if (!confirmed) return false;
    restoreDirtyRows();
    renderRecordsTable();
    renderMetrics();
    return true;
  }

  function clearSession() {
    setToken("");
    state.admin = null;
    state.mustChangePassword = false;
    state.events = [];
    state.selectedEventId = "";
    resetRecordState();
    stopPolling();
  }

  function showLogin(message = "", tone = "", allowRetry = false) {
    ui.appShell.hidden = true;
    ui.loginScreen.hidden = false;
    setStatus(ui.loginStatus, message, tone);
    ui.retrySessionBtn.hidden = !allowRetry;
    stopPolling();
    // iOS 上页面显示后立即脚本聚焦，可能留下“看似有焦点但键盘不再弹出”的
    // 假焦点。触屏设备完全交给用户原生点击；桌面端才自动聚焦。
    ui.usernameInput.disabled = false;
    ui.usernameInput.readOnly = false;
    ui.usernameInput.tabIndex = 0;
    if (window.matchMedia("(pointer: fine)").matches) {
      window.setTimeout(() => {
        if (!ui.loginScreen.hidden && document.activeElement === document.body) ui.usernameInput.focus();
      }, 40);
    }
  }

  function showApp() {
    ui.loginScreen.hidden = true;
    ui.appShell.hidden = false;
    ui.retrySessionBtn.hidden = true;
    const admin = state.admin || {};
    ui.adminName.textContent = admin.display_name || admin.name || admin.username || "管理员";
    ui.securityBanner.hidden = !state.mustChangePassword;
    if (state.mustChangePassword) stopPolling();
    else startPolling();
  }

  function setPasswordModalRequired(required) {
    ui.passwordModal.dataset.required = required ? "true" : "false";
    ui.passwordModal.querySelectorAll("[data-password-dismiss]").forEach((button) => {
      button.hidden = Boolean(required);
    });
  }

  function openPasswordModal(required = false) {
    ui.passwordForm.reset();
    setStatus(ui.passwordStatus, "");
    setPasswordModalRequired(required);
    openModal(ui.passwordModal);
  }

  async function login(event) {
    event.preventDefault();
    const username = ui.usernameInput.value.trim();
    const password = ui.passwordInput.value;
    if (!username || !password) return;
    setBusy(ui.loginBtn, true, "正在验证…");
    setStatus(ui.loginStatus, "正在连接当前 Mac 主机…");
    try {
      const data = await api("/login", {
        method: "POST",
        auth: false,
        body: { username, password },
      });
      if (!data.token) throw new Error("后端未返回登录凭证");
      setToken(data.token);
      state.admin = data.admin || { username };
      state.mustChangePassword = Boolean(data.must_change_password);
      ui.passwordInput.value = "";
      setStatus(ui.loginStatus, "");
      showApp();
      if (state.mustChangePassword) openPasswordModal(true);
      else await loadEvents();
    } catch (error) {
      setStatus(ui.loginStatus, error.message || "登录失败，请检查账号和密码。", "error");
    } finally {
      setBusy(ui.loginBtn, false);
    }
  }

  function takeOwnerAssertion() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const assertion = params.get("owner") || "";
    if (window.location.hash) {
      // 所有者断言只存在于 fragment，读取后立即从地址栏和浏览器历史中清除。
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    return assertion;
  }

  async function exchangeOwnerAssertion(assertion) {
    showLogin("正在进入所有者控制台…");
    try {
      const data = await api("/owner-exchange", {
        method: "POST",
        auth: false,
        body: { assertion },
      });
      if (!data.token) throw new Error("服务端未返回所有者登录凭证");
      setToken(data.token);
      state.admin = data.admin || { username: "所有者", role: "owner" };
      state.mustChangePassword = Boolean(data.must_change_password);
      showApp();
      if (state.mustChangePassword) openPasswordModal(true);
      else await loadEvents();
      return true;
    } catch (error) {
      clearSession();
      showLogin(`${error.message || "所有者授权失败"}，请返回个人空间重新进入。`, "error");
      return false;
    }
  }

  async function bootstrapAdmin() {
    const assertion = takeOwnerAssertion();
    if (assertion) {
      await exchangeOwnerAssertion(assertion);
      return;
    }
    await restoreSession();
  }

  async function restoreSession() {
    if (!state.token) {
      showLogin();
      return;
    }
    try {
      const data = await api("/me");
      state.admin = data.admin || data.user || data;
      state.mustChangePassword = Boolean(
        data.must_change_password ?? (data.admin && data.admin.must_change_password)
      );
      showApp();
      if (state.mustChangePassword) openPasswordModal(true);
      else await loadEvents();
    } catch (error) {
      if (!state.token || error.status === 401) {
        showLogin("登录状态已失效，请重新登录。", "error");
      } else {
        showLogin(
          `${error.message || "当前主机暂时不可用"} 登录凭证仍已保留，可直接重试连接。`,
          "error",
          true
        );
      }
    }
  }

  async function logout() {
    ui.logoutBtn.disabled = true;
    try {
      if (state.token) await api("/logout", { method: "POST" });
    } catch (_) {
      // 即使主机暂时离线，也应清理本机浏览器里的管理员令牌。
    } finally {
      clearSession();
      ui.logoutBtn.disabled = false;
      ui.loginForm.reset();
      showLogin("已安全退出。", "ok");
    }
  }

  function openModal(modal) {
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    const firstInput = modal.querySelector("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([hidden]):not([disabled])");
    window.setTimeout(() => firstInput && firstInput.focus(), 30);
  }

  function closeModal(modal, options = {}) {
    if (
      modal === ui.passwordModal &&
      ui.passwordModal.dataset.required === "true" &&
      !options.force
    ) {
      return false;
    }
    modal.hidden = true;
    document.body.style.overflow = "";
    return true;
  }

  function openCreateEvent() {
    if (!guardDirty("新建比赛")) return;
    ui.createEventForm.reset();
    ui.createTitleInput.value = tomorrowTitle();
    setStatus(ui.createEventStatus, "");
    openModal(ui.eventModal);
    ui.createTitleInput.select();
  }

  function renderEventList() {
    if (!state.events.length) {
      ui.eventList.innerHTML = '<div class="empty-side">还没有比赛。<br>点击“新建比赛”开始。</div>';
      return;
    }
    ui.eventList.innerHTML = state.events
      .map((event, index) => {
        const status = EVENT_STATUS[event.status] || EVENT_STATUS.draft;
        const count = parseCount(event, ["person_count", "people", "participants", "submission_rows", "row_count", "total"], 0);
        const active = String(event.id) === String(state.selectedEventId);
        return `
          <button class="event-item${active ? " active" : ""}" type="button" data-event-id="${escapeHtml(event.id)}">
            <span class="date-tile"><b>${String(index + 1).padStart(2, "0")}</b><small>场次</small></span>
            <span class="event-item-copy"><span class="event-item-title">${escapeHtml(event.title || "未命名比赛")}</span><span class="event-item-meta">${count} 人已登记</span></span>
            <span class="status-badge ${status.className}">${status.label}</span>
          </button>`;
      })
      .join("");

    ui.eventList.querySelectorAll("[data-event-id]").forEach((button) => {
      button.addEventListener("click", () => selectEvent(button.dataset.eventId));
    });
  }

  async function loadEvents(options = {}) {
    if (state.mustChangePassword) return;
    ui.refreshEventsBtn.disabled = true;
    try {
      const data = await api("/events");
      state.events = unwrapList(data, ["events", "rows", "items"]);
      state.events.sort((a, b) => {
        const aTime = Date.parse(String(a.created_at || ""));
        const bTime = Date.parse(String(b.created_at || ""));
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      });
      if (!state.events.some((event) => String(event.id) === String(state.selectedEventId))) {
        resetRecordState();
        state.selectedEventId = state.events[0] ? String(state.events[0].id) : "";
      }
      renderEventList();
      renderSelectedEvent();
      if (state.selectedEventId && options.loadRecords !== false) {
        await Promise.all([loadRecords({ silent: options.silent }), loadInvites({ silent: true })]);
      }
    } catch (error) {
      if (!options.silent) showToast(error.message || "比赛列表加载失败", "error");
    } finally {
      ui.refreshEventsBtn.disabled = false;
    }
  }

  async function refreshEvents() {
    if (!guardDirty("刷新比赛和名单")) return;
    await loadEvents();
  }

  async function selectEvent(eventId) {
    if (String(eventId) === String(state.selectedEventId)) return;
    if (!guardDirty("切换比赛")) return;
    resetRecordState();
    state.selectedEventId = String(eventId);
    renderEventList();
    renderSelectedEvent();
    await Promise.all([loadRecords(), loadInvites()]);
  }

  async function loadInvites(options = {}) {
    const eventId = String(state.selectedEventId || "");
    if (!eventId || state.mustChangePassword) return;
    try {
      const data = await api(`/events/${encodeURIComponent(eventId)}/invites`);
      if (eventId !== String(state.selectedEventId)) return;
      state.invites = unwrapList(data, ["invites", "rows", "items"]);
      state.invitesEventId = eventId;
      renderInvitePanel(currentEvent());
    } catch (error) {
      if (!options.silent) showToast(error.message || "客户链接状态加载失败", "error");
    }
  }

  function renderSelectedEvent() {
    const event = currentEvent();
    const hasEvent = Boolean(event);
    ui.noEventState.hidden = hasEvent;
    ui.eventWorkspace.hidden = !hasEvent;
    if (!event) return;

    const status = EVENT_STATUS[event.status] || EVENT_STATUS.draft;
    const people = recordsLoadedFor(event.id)
      ? state.recordsTotal
      : parseCount(event, ["person_count", "people", "participants", "submission_rows", "row_count", "total"], 0);
    ui.heroStatus.textContent = status.label;
    ui.heroTitle.textContent = event.title || "未命名比赛";
    ui.heroCount.textContent = String(people);
    ui.eventStatusBadge.textContent = status.label;
    ui.eventStatusBadge.className = `status-badge ${status.className}`;

    ui.eventTitleInput.value = event.title || "";

    const isPublished = event.status === "published";
    const canPublish = event.status === "draft" || event.status === "paused";
    ui.closeEventBtn.hidden = !isPublished;
    ui.publishEventBtn.hidden = !canPublish;
    ui.publishEventBtn.textContent = event.status === "paused" ? "恢复收集" : "发布收集页";
    renderInvitePanel(event);
    renderMetrics();
  }

  function renderInvitePanel(event) {
    const isCollecting = eventIsCollecting(event);
    const deadlinePassed = eventDeadlinePassed(event);
    ui.publishStrip.classList.toggle("active", isCollecting);
    ui.publishSymbol.textContent = isCollecting ? "✓" : deadlinePassed ? "!" : "—";
    ui.publishLabel.textContent = isCollecting
      ? "公开页正在收集"
      : deadlinePassed
      ? "收集已截止"
      : event && event.status === "paused"
      ? "收集已暂停"
      : "尚未发布";
    ui.publicLinkText.textContent = state.lastInviteLink
      ? "刚生成的客户专属链接已复制；原始链接不会保存在服务器。"
      : isCollecting
      ? "每位客户生成一个专属链接，成功提交一次后自动失效。"
      : "发布后才可以生成客户专属链接。";
    ui.inviteLabelInput.disabled = !isCollecting;
    ui.generateInviteBtn.disabled = !isCollecting;
    ui.openInviteBtn.disabled = !state.lastInviteLink;
    renderInviteList();
  }

  function renderInviteList() {
    if (!ui.inviteList) return;
    if (!state.invites.length) {
      ui.inviteList.innerHTML = '<div class="invite-empty">还没有生成客户链接。</div>';
      return;
    }
    const statusLabels = { active: "未使用", used: "已使用", revoked: "已撤销" };
    ui.inviteList.innerHTML = state.invites
      .map((invite) => {
        const status = invite.status || "revoked";
        const createdAt = formatDateTime(invite.created_at);
        const label = invite.label || `客户链接 ${String(invite.id || "").slice(-6).toUpperCase()}`;
        const detail = status === "used"
          ? `${invite.person_count || 0} 人 · ${formatDateTime(invite.used_at)}`
          : createdAt;
        return `<div class="invite-item">
          <span class="invite-dot ${escapeHtml(status)}" aria-hidden="true"></span>
          <span class="invite-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span>
          <span class="invite-status ${escapeHtml(status)}">${statusLabels[status] || "不可用"}</span>
          ${status === "active" ? `<button class="quiet-button invite-revoke" type="button" data-revoke-invite="${escapeHtml(invite.id)}">撤销</button>` : ""}
        </div>`;
      })
      .join("");
    ui.inviteList.querySelectorAll("[data-revoke-invite]").forEach((button) => {
      button.addEventListener("click", () => revokeInvite(button.dataset.revokeInvite));
    });
  }

  async function createEvent(event) {
    event.preventDefault();
    const body = { title: ui.createTitleInput.value.trim() };
    if (!body.title) return;
    setBusy(ui.createEventSubmitBtn, true, "正在建立…");
    setStatus(ui.createEventStatus, "正在保存到当前 Mac…");
    try {
      const data = await api("/events", { method: "POST", body });
      const created = unwrapItem(data, ["event", "item"]);
      if (!created || created.id === undefined) throw new Error("比赛已创建，但后端未返回比赛编号");
      closeModal(ui.eventModal);
      resetRecordState();
      state.events = [created, ...state.events.filter((item) => String(item.id) !== String(created.id))];
      state.selectedEventId = String(created.id);
      renderEventList();
      renderSelectedEvent();
      await loadEvents();
      showToast("比赛已建立，确认标题后即可发布。", "ok");
    } catch (error) {
      setStatus(ui.createEventStatus, error.message || "新建失败", "error");
    } finally {
      setBusy(ui.createEventSubmitBtn, false);
    }
  }

  function openAddRowModal() {
    const event = currentEvent();
    if (!event) {
      showToast("请先选择一场比赛。", "error");
      return;
    }
    if (state.dirtyRowIds.size) {
      showToast("请先保存或放弃表格修改，再补录人员。", "error");
      return;
    }
    ui.addRowForm.reset();
    ui.addRowForm.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
    ui.addRowModal.dataset.eventId = String(event.id);
    setStatus(ui.addRowStatus, "");
    openModal(ui.addRowModal);
  }

  function invalidAddRowField(input, message) {
    input.setAttribute("aria-invalid", "true");
    setStatus(ui.addRowStatus, message, "error");
    input.focus();
    return null;
  }

  function validatedAddRowPerson() {
    ui.addRowForm.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
    const person = {
      name: ui.addNameInput.value.trim(),
      phone: compactPhone(ui.addPhoneInput.value),
      document_type: ui.addDocumentTypeInput.value,
      idcard: ui.addIdcardInput.value.trim().toUpperCase(),
      price: ui.addPriceInput.value.trim(),
      position: ui.addPositionInput.value.trim(),
      extra: ui.addExtraInput.value.trim(),
    };
    if (!person.name) return invalidAddRowField(ui.addNameInput, "请填写姓名。");
    if (!person.phone) return invalidAddRowField(ui.addPhoneInput, "请输入正确的 11 位手机号。");
    if (!person.idcard) return invalidAddRowField(ui.addIdcardInput, "请填写证件号码。");
    if (person.document_type === "身份证" && !validChineseId(person.idcard)) {
      const confirmed = window.confirm("这个身份证号码未通过格式、日期或校验码检查。若已与原证件人工核对一致，可以按原样保存。是否继续补录？");
      if (!confirmed) return invalidAddRowField(ui.addIdcardInput, "请核对身份证号码；确认与原证件一致后可继续保存。");
    }
    if (!person.price || !/^\d+$/.test(person.price)) {
      return invalidAddRowField(ui.addPriceInput, "想要票价必须是纯数字，不要带“元”。");
    }
    if (!person.position) return invalidAddRowField(ui.addPositionInput, "请填写想要的位置。");
    return person;
  }

  async function addRow(event) {
    event.preventDefault();
    const selectedEvent = currentEvent();
    const eventId = ui.addRowModal.dataset.eventId || "";
    if (!selectedEvent || String(selectedEvent.id) !== eventId) {
      setStatus(ui.addRowStatus, "当前比赛已发生变化，请关闭后重新补录。", "error");
      return;
    }
    const person = validatedAddRowPerson();
    if (!person) return;
    setBusy(ui.addRowSubmitBtn, true, "正在补录…");
    setStatus(ui.addRowStatus, "正在写入当前 Mac…");
    try {
      await api("/submissions", {
        method: "POST",
        body: { event_id: eventId, person },
      });
      closeModal(ui.addRowModal);
      await loadRecords();
      showToast(`已补录 ${person.name}。`, "ok");
    } catch (error) {
      setStatus(ui.addRowStatus, error.message || "补录失败", "error");
    } finally {
      setBusy(ui.addRowSubmitBtn, false);
    }
  }

  function eventFormBody() {
    return { title: ui.eventTitleInput.value.trim() };
  }

  async function patchCurrentEvent(body) {
    const event = currentEvent();
    if (!event) throw new Error("请先选择一场比赛");
    const data = await api(`/events/${encodeURIComponent(event.id)}`, { method: "PATCH", body });
    const updated = unwrapItem(data, ["event", "item"]);
    const index = state.events.findIndex((item) => String(item.id) === String(event.id));
    if (index >= 0) state.events[index] = { ...state.events[index], ...updated };
    renderEventList();
    renderSelectedEvent();
    return state.events[index];
  }

  async function saveEvent(event) {
    event.preventDefault();
    if (!ui.eventForm.reportValidity()) return;
    setBusy(ui.saveEventBtn, true, "保存中…");
    setStatus(ui.eventFormStatus, "正在保存标题…");
    try {
      await patchCurrentEvent(eventFormBody());
      setStatus(ui.eventFormStatus, "标题已保存。", "ok");
      showToast("公开页标题已保存。", "ok");
    } catch (error) {
      setStatus(ui.eventFormStatus, error.message || "保存失败", "error");
    } finally {
      setBusy(ui.saveEventBtn, false);
    }
  }

  async function publishEvent() {
    if (!ui.eventForm.reportValidity()) return;
    const event = currentEvent();
    if (!event) return;
    if (ui.eventTitleInput.value.trim() !== String(event.title || "").trim()) {
      setStatus(ui.eventFormStatus, "标题有尚未保存的修改，请先保存标题再发布。", "error");
      ui.saveEventBtn.focus();
      return;
    }
    setBusy(ui.publishEventBtn, true, "发布中…");
    setStatus(ui.eventFormStatus, "正在生成公开填写页…");
    try {
      await patchCurrentEvent({ status: "published" });
      setStatus(ui.eventFormStatus, "收集页已发布，现在可为每位客户生成一次性链接。", "ok");
      showToast("收集页已发布。", "ok");
      await loadInvites({ silent: true });
    } catch (error) {
      setStatus(ui.eventFormStatus, error.message || "发布失败", "error");
    } finally {
      setBusy(ui.publishEventBtn, false);
    }
  }

  async function pauseEvent() {
    if (!window.confirm("暂停后，公开页面将不能继续提交。已经收到的数据不会删除。确定暂停？")) return;
    setBusy(ui.closeEventBtn, true, "暂停中…");
    try {
      await patchCurrentEvent({ status: "paused" });
      setStatus(ui.eventFormStatus, "收集已暂停，可随时恢复。", "ok");
      showToast("这场比赛已停止接收新信息。", "ok");
    } catch (error) {
      setStatus(ui.eventFormStatus, error.message || "暂停失败", "error");
    } finally {
      setBusy(ui.closeEventBtn, false);
    }
  }

  function normalizeRow(raw) {
    return {
      ...raw,
      id: raw.id,
      group_id: raw.group_id ?? raw.groupId ?? 1,
      sequence_no: raw.sequence_no ?? raw.sequenceNo ?? 1,
      phone: raw.phone || "",
      name: raw.name || "",
      document_type: raw.document_type || raw.documentType || "身份证",
      idcard: String(raw.idcard || raw.document_no || "").toUpperCase(),
      country: raw.country || "",
      price: raw.price ?? "",
      position: raw.position || "",
      size: raw.size || "",
      address: raw.address || "",
      extra: raw.extra || "",
    };
  }

  async function loadRecords(options = {}) {
    if (!state.selectedEventId || state.mustChangePassword) return;
    if (state.dirtyRowIds.size) {
      if (!options.silent) showToast("请先保存或放弃当前表格修改。", "error");
      return;
    }
    const requestedEventId = String(state.selectedEventId);
    const requestSeq = ++state.recordsRequestSeq;
    const requestIsCurrent = () =>
      requestSeq === state.recordsRequestSeq &&
      requestedEventId === String(state.selectedEventId) &&
      state.dirtyRowIds.size === 0;
    state.recordsLoading = true;
    ui.refreshRecordsBtn.disabled = true;
    ui.exportExcelBtn.disabled = true;
    if (!options.silent) ui.recordsHint.textContent = "正在从当前 Mac 同步…";
    try {
      let offset = 0;
      let total = Infinity;
      let snapshot = "";
      const rowsById = new Map();
      while (offset < total && rowsById.size < MAX_RENDERED_RECORDS) {
        if (!requestIsCurrent()) return;
        const params = new URLSearchParams({
          event_id: requestedEventId,
          limit: String(RECORD_PAGE_SIZE),
          offset: String(offset),
        });
        if (snapshot) params.set("snapshot", snapshot);
        const data = await api(`/submissions?${params.toString()}`);
        if (!requestIsCurrent()) return;
        const page = unwrapList(data, ["rows", "submissions", "items"]);
        const responseSnapshot = data.snapshot ?? data.snapshot_token ?? data.snapshot_at;
        if (!snapshot && responseSnapshot !== undefined && responseSnapshot !== null) {
          snapshot = String(responseSnapshot);
        } else if (
          snapshot &&
          responseSnapshot !== undefined &&
          responseSnapshot !== null &&
          String(responseSnapshot) !== snapshot
        ) {
          throw new Error("名单快照在分页期间发生变化，已取消本次同步，请重试。");
        }
        page.forEach((raw) => {
          const row = normalizeRow(raw);
          const id = String(row.id || "");
          if (id && !rowsById.has(id) && rowsById.size < MAX_RENDERED_RECORDS) {
            rowsById.set(id, row);
          }
        });
        total = Number.isFinite(Number(data.total)) ? Number(data.total) : rowsById.size;
        if (!page.length || page.length < RECORD_PAGE_SIZE) break;
        offset += page.length;
        if (offset < total && !snapshot) {
          throw new Error("服务器未返回名单快照，已停止多页加载以避免名单错位。请刷新后重试。");
        }
      }
      if (!requestIsCurrent()) return;
      const rows = Array.from(rowsById.values());
      const resolvedTotal = Number.isFinite(total) ? Math.max(total, rows.length) : rows.length;
      state.rows = rows;
      state.originalRows = new Map(rows.map((row) => [String(row.id), JSON.stringify(editableSnapshot(row))]));
      state.dirtyRowIds.clear();
      state.recordsLoadedEventId = requestedEventId;
      state.recordsTotal = resolvedTotal;
      state.recordsTruncated = resolvedTotal > rows.length;
      state.recordsSnapshot = snapshot;
      state.lastSyncAt = new Date();
      renderRecordsTable();
      renderMetrics();
      renderSelectedEventCounts();
      ui.lastSyncText.textContent = state.lastSyncAt.toLocaleTimeString("zh-CN", { hour12: false });
      updateRecordsHint();
      updateExportAvailability();
    } catch (error) {
      if (requestIsCurrent()) {
        ui.recordsHint.textContent = error.message || "数据同步失败";
        if (!options.silent) showToast(error.message || "数据同步失败", "error");
      }
    } finally {
      if (requestSeq === state.recordsRequestSeq) {
        state.recordsLoading = false;
        ui.refreshRecordsBtn.disabled = false;
        updateExportAvailability();
      }
    }
  }

  function groupRows(rows) {
    const groups = [];
    const map = new Map();
    rows.forEach((row) => {
      const key = String(row.group_id || 1);
      if (!map.has(key)) {
        const group = { id: key, rows: [] };
        map.set(key, group);
        groups.push(group);
      }
      map.get(key).rows.push(row);
    });
    return groups;
  }

  function groupTotal(rows) {
    return rows.reduce((sum, row) => {
      const value = Number(String(row.price ?? "").replace(/[^\d.-]/g, ""));
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  }

  function batchCount(rows) {
    const batchIds = rows
      .map((row) => row.submission_group_id || row.batch_id || row.submission_id)
      .filter(Boolean);
    if (batchIds.length) return new Set(batchIds.map(String)).size;
    const submittedTimes = rows.map((row) => row.submitted_at).filter(Boolean);
    return submittedTimes.length ? new Set(submittedTimes).size : groupRows(rows).length;
  }

  function renderMetrics() {
    const event = currentEvent();
    if (!event) return;
    const loaded = recordsLoadedFor(event.id);
    const people = loaded ? state.recordsTotal : parseCount(event, ["person_count", "people"], 0);
    const groups = loaded
      ? groupRows(state.rows).length
      : parseCount(event, ["submission_group_count", "groups", "batches"], 0);
    const amount = loaded ? groupTotal(state.rows) : 0;
    ui.metricPeople.textContent = String(people);
    ui.metricBatches.textContent = String(loaded ? batchCount(state.rows) : groups);
    ui.metricGroups.textContent = String(groups);
    ui.metricAmount.textContent = `¥${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
    ui.heroCount.textContent = String(people);
  }

  function renderSelectedEventCounts() {
    const event = currentEvent();
    if (!event) return;
    const submittedGroups = batchCount(state.rows);
    event.person_count = state.recordsTotal;
    if (!state.recordsTruncated) event.submission_group_count = submittedGroups;
    event.counts = {
      ...(event.counts || {}),
      people: state.recordsTotal,
      groups: groupRows(state.rows).length,
      amount: groupTotal(state.rows),
      batches: submittedGroups,
    };
    renderEventList();
  }

  function fieldIsDirty(row, field) {
    const original = state.originalRows.get(String(row.id));
    if (!original) return false;
    try {
      return JSON.parse(original)[field] !== (row[field] ?? "");
    } catch (_) {
      return false;
    }
  }

  function editableChanges(row) {
    const original = state.originalRows.get(String(row.id));
    if (!original) return {};
    try {
      const baseline = JSON.parse(original);
      return EDIT_FIELDS.reduce((changes, field) => {
        const value = row[field] ?? "";
        if (baseline[field] !== value) changes[field] = value;
        return changes;
      }, {});
    } catch (_) {
      return {};
    }
  }

  function cellIsInvalid(row, field, value = row[field]) {
    const text = String(value ?? "").trim();
    const requiredFields = ["name", "phone", "idcard", "price", "position"];
    if (requiredFields.includes(field) && !text) return true;
    if (field === "phone" && text && !compactPhone(text)) return true;
    if (field === "document_type" && !["身份证", "护照"].includes(text)) return true;
    if (field === "price" && text && !/^\d+$/.test(text)) return true;
    if (field === "name" && Array.from(text).length > 100) return true;
    if (field === "position" && Array.from(text).length > 200) return true;
    if (field === "extra" && Array.from(text).length > 2000) return true;
    if (field === "group_id") {
      const group = Number(text);
      if (!/^\d+$/.test(text) || !Number.isInteger(group) || group < 1 || group > 1000000) return true;
    }
    return false;
  }

  function cellHasWarning(row, field, value = row[field]) {
    return field === "idcard" && row.document_type === "身份证" && Boolean(String(value || "").trim()) && !validChineseId(value);
  }

  function rowInput(row, field, className, type = "text") {
    const value = row[field] ?? "";
    const isDirty = fieldIsDirty(row, field);
    const dirty = isDirty ? " dirty" : "";
    const invalid = isDirty && cellIsInvalid(row, field, value) ? " invalid" : "";
    const warning = cellHasWarning(row, field, value) ? " warning" : "";
    const warningAttr = warning ? ' data-warning="true" title="身份证规则校验未通过；人工核对无误后仍可保存"' : "";
    return `<input class="table-input ${className}${dirty}${invalid}${warning}" type="${type}" data-row-id="${escapeHtml(row.id)}" data-field="${field}" value="${escapeHtml(value)}"${warningAttr} ${type === "number" ? 'inputmode="numeric" min="1" max="1000000" step="1"' : ""} />`;
  }

  function rowDocumentTypeSelect(row) {
    const dirty = fieldIsDirty(row, "document_type") ? " dirty" : "";
    return `<select class="table-select w-document${dirty}" data-row-id="${escapeHtml(row.id)}" data-field="document_type">
      <option value="身份证"${row.document_type === "身份证" ? " selected" : ""}>身份证</option>
      <option value="护照"${row.document_type === "护照" ? " selected" : ""}>护照</option>
    </select>`;
  }

  function renderRecordsTable() {
    if (!state.rows.length) {
      ui.recordsTableWrap.innerHTML = '<div class="table-empty">还没有人提交信息。<br>发布并分享公开链接后，规范数据会实时出现在这里。</div>';
      updateSaveIndicator();
      return;
    }

    let number = 0;
    const groupsHtml = groupRows(state.rows)
      .map((group, groupIndex) => {
        const rowHtml = group.rows
          .map((row) => {
            number += 1;
            return `
              <tr data-record-id="${escapeHtml(row.id)}">
                <td>${number}</td>
                <td>${rowInput(row, "phone", "w-phone")}</td>
                <td>${rowInput(row, "name", "w-name")}</td>
                <td>${rowDocumentTypeSelect(row)}</td>
                <td>${rowInput(row, "idcard", "w-id")}</td>
                <td>${rowInput(row, "price", "w-money")}</td>
                <td>${rowInput(row, "position", "w-position")}</td>
                <td>${rowInput(row, "extra", "w-note")}</td>
                <td>${rowInput(row, "group_id", "w-group", "number")}</td>
                <td><button class="row-delete" type="button" data-delete-row="${escapeHtml(row.id)}">删除</button></td>
              </tr>`;
          })
          .join("");
        return `${rowHtml}<tr class="group-row"><td colspan="6">第 ${groupIndex + 1} 组 · ${group.rows.length} 人</td><td colspan="2">意向小计 ¥${groupTotal(group.rows).toLocaleString("zh-CN")}</td><td colspan="2"></td></tr>`;
      })
      .join("");

    ui.recordsTableWrap.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th>No</th><th>手机号</th><th>姓名</th><th>证件类型</th><th>证件号</th><th>想要票价</th>
          <th>想要位置</th><th>备注</th><th>分组</th><th>操作</th>
        </tr></thead>
        <tbody>${groupsHtml}</tbody>
      </table>`;

    ui.recordsTableWrap.querySelectorAll("[data-row-id][data-field]").forEach((input) => {
      input.addEventListener("input", handleCellEdit);
      input.addEventListener("change", handleCellEdit);
      input.addEventListener("blur", handleCellEdit);
    });
    ui.recordsTableWrap.querySelectorAll("[data-delete-row]").forEach((button) => {
      button.addEventListener("click", () => deleteRow(button.dataset.deleteRow));
    });
    updateSaveIndicator();
  }

  function editableSnapshot(row) {
    const result = {};
    EDIT_FIELDS.forEach((field) => {
      result[field] = row[field] ?? "";
    });
    return result;
  }

  function handleCellEdit(event) {
    const input = event.currentTarget;
    const row = state.rows.find((item) => String(item.id) === String(input.dataset.rowId));
    if (!row) return;
    // 用户一开始编辑，就让此前发出的刷新响应失效，避免旧数据覆盖正在修改的单元格。
    invalidateRecordRequests();
    const field = input.dataset.field;
    let value = input.value;
    if (field === "idcard") value = value.trim().toUpperCase();
    if (field === "group_id" && /^\d+$/.test(value)) value = Number(value);
    row[field] = value;
    if (input.value !== String(value)) input.value = value;

    const original = state.originalRows.get(String(row.id));
    const dirty = original !== JSON.stringify(editableSnapshot(row));
    if (dirty) state.dirtyRowIds.add(String(row.id));
    else state.dirtyRowIds.delete(String(row.id));
    input.classList.toggle("dirty", fieldIsDirty(row, field));

    const invalid = fieldIsDirty(row, field) && cellIsInvalid(row, field, value);
    input.classList.toggle("invalid", Boolean(invalid));
    const warning = cellHasWarning(row, field, value);
    input.classList.toggle("warning", warning);
    if (warning) input.setAttribute("data-warning", "true");
    else input.removeAttribute("data-warning");
    updateSaveIndicator();
    renderMetrics();
    if (["change", "blur"].includes(event.type) && ["document_type", "price", "group_id"].includes(field)) {
      renderRecordsTable();
      renderMetrics();
    }
  }

  function updateExportAvailability() {
    const blocked =
      !state.rows.length ||
      state.dirtyRowIds.size > 0 ||
      state.recordsTruncated ||
      !recordsLoadedFor(state.selectedEventId);
    ui.exportExcelBtn.disabled = blocked;
    ui.exportExcelBtn.title = state.recordsTruncated
      ? `名单共 ${state.recordsTotal} 人，当前只加载 ${state.rows.length} 人，不能导出不完整购票模板。`
      : state.dirtyRowIds.size
      ? "请先保存或放弃表格修改，再导出购票模板。"
      : "";
  }

  function updateRecordsHint() {
    if (!recordsLoadedFor(state.selectedEventId)) return;
    ui.recordsHint.textContent = state.recordsTruncated
      ? `共 ${state.recordsTotal.toLocaleString("zh-CN")} 人，仅显示前 ${state.rows.length.toLocaleString("zh-CN")} 人；购票模板导出已禁用，避免漏人。`
      : `已完整同步 ${state.rows.length.toLocaleString("zh-CN")} 人，可横向滚动查看全部购票字段。`;
  }

  function updateSaveIndicator() {
    const count = state.dirtyRowIds.size;
    ui.saveIndicator.textContent = count ? `${count} 行有未保存修改` : "暂无未保存修改";
    ui.saveIndicator.classList.toggle("dirty", Boolean(count));
    ui.saveRowsBtn.disabled = !count;
    ui.discardRowsBtn.disabled = !count;
    updateExportAvailability();
  }

  async function saveRows() {
    const dirtyIds = Array.from(state.dirtyRowIds);
    if (!dirtyIds.length) return;
    const invalidCell = ui.recordsTableWrap.querySelector(".table-input.dirty.invalid, .table-select.dirty.invalid");
    if (invalidCell) {
      invalidCell.focus();
      showToast("表格中仍有红色无效字段，请修正后再保存。", "error");
      return;
    }
    setBusy(ui.saveRowsBtn, true, `保存 ${dirtyIds.length} 行…`);
    ui.discardRowsBtn.disabled = true;
    const failures = [];
    let saved = 0;

    for (const id of dirtyIds) {
      const row = state.rows.find((item) => String(item.id) === id);
      if (!row) continue;
      try {
        const body = editableChanges(row);
        if (!Object.keys(body).length) {
          state.dirtyRowIds.delete(id);
          continue;
        }
        const data = await api(`/submissions/${encodeURIComponent(row.id)}`, { method: "PATCH", body });
        const updated = normalizeRow(unwrapItem(data, ["submission", "row", "item"]));
        Object.assign(row, updated);
        state.originalRows.set(id, JSON.stringify(editableSnapshot(row)));
        state.dirtyRowIds.delete(id);
        saved += 1;
      } catch (error) {
        failures.push(`${row.name || `记录 ${row.id}`}：${error.message}`);
      }
    }

    renderRecordsTable();
    renderMetrics();
    setBusy(ui.saveRowsBtn, false);
    updateSaveIndicator();
    if (failures.length) {
      showToast(`已保存 ${saved} 行，${failures.length} 行失败：${failures[0]}`, "error");
    } else {
      showToast(`已保存 ${saved} 行修改。`, "ok");
    }
  }

  function discardRowChanges() {
    if (!state.dirtyRowIds.size) return;
    if (!window.confirm("确定放弃当前表格中尚未保存的修改？")) return;
    restoreDirtyRows();
    renderRecordsTable();
    renderMetrics();
  }

  async function deleteRow(rowId) {
    const row = state.rows.find((item) => String(item.id) === String(rowId));
    if (!row) return;
    if (!window.confirm(`确定删除“${row.name || "这条"}”报名信息？删除后无法在管理界面恢复。`)) return;
    invalidateRecordRequests();
    try {
      await api(`/submissions/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      state.rows = state.rows.filter((item) => String(item.id) !== String(row.id));
      state.originalRows.delete(String(row.id));
      state.dirtyRowIds.delete(String(row.id));
      state.recordsTotal = Math.max(0, state.recordsTotal - 1);
      state.recordsTruncated = state.recordsTotal > state.rows.length;
      renderRecordsTable();
      renderMetrics();
      renderSelectedEventCounts();
      updateRecordsHint();
      updateExportAvailability();
      showToast("报名记录已删除。", "ok");
    } catch (error) {
      showToast(error.message || "删除失败", "error");
    }
  }

  async function exportTicketTemplate() {
    if (state.dirtyRowIds.size) {
      showToast("表格有未保存修改，请先保存或放弃修改后再导出。", "error");
      return;
    }
    if (state.recordsTruncated) {
      showToast(`名单共 ${state.recordsTotal} 人，当前仅加载 ${state.rows.length} 人，不能导出不完整购票模板。`, "error");
      return;
    }
    if (!state.rows.length) {
      showToast("当前没有可导出的报名信息。", "error");
      return;
    }
    if (!window.confirm(`将导出 ${state.rows.length} 人的完整手机号和证件信息，请确认当前环境安全。`)) return;
    const event = currentEvent();
    const basename = (event && event.title ? event.title : "比赛报名信息").replace(/[\\/:*?"<>|]/g, "_");
    const rows = state.rows.map((row) => ({
      ...row,
      documentType: row.document_type || "身份证",
      documentNo: row.idcard,
      groupId: row.group_id || 1,
    }));
    setBusy(ui.exportExcelBtn, true, "正在生成模板…");
    try {
      const result = await window.TicketTemplateExport.download({
        rows,
        filename: `${basename}.xlsx`,
        templateUrl: new URL("../../购票模板.xlsx", window.location.href).href,
      });
      showToast(`购票模板已导出：${result.people} 人 / ${result.groups} 组。`, "ok");
    } catch (error) {
      showToast(error.message || "购票模板导出失败，请刷新后重试。", "error");
    } finally {
      setBusy(ui.exportExcelBtn, false);
      updateExportAvailability();
    }
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    }
  }

  async function generateInviteLink() {
    const event = currentEvent();
    if (!event || !eventIsCollecting(event)) {
      showToast("请先发布活动，再生成客户链接。", "error");
      renderInvitePanel(event);
      return;
    }
    setBusy(ui.generateInviteBtn, true, "正在生成…");
    try {
      const label = ui.inviteLabelInput.value.trim();
      const data = await api(`/events/${encodeURIComponent(event.id)}/invites`, {
        method: "POST",
        body: label ? { label } : {},
      });
      const link = inviteLink(data.token);
      if (!link) throw new Error("服务器未返回客户链接令牌");
      state.lastInviteLink = link;
      ui.inviteLabelInput.value = "";
      const copied = await copyText(link);
      await loadInvites({ silent: true });
      renderInvitePanel(event);
      showToast(
        copied ? "客户专属链接已生成并复制，只能成功提交一次。" : `链接已生成，请手动复制：${link}`,
        copied ? "ok" : "error"
      );
    } catch (error) {
      showToast(error.message || "客户链接生成失败", "error");
    } finally {
      setBusy(ui.generateInviteBtn, false);
      renderInvitePanel(currentEvent());
    }
  }

  async function revokeInvite(inviteId) {
    if (!window.confirm("撤销后该客户链接将立即失效，确定撤销？")) return;
    try {
      await api(`/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });
      await loadInvites({ silent: true });
      showToast("客户链接已撤销。", "ok");
    } catch (error) {
      showToast(error.message || "撤销失败", "error");
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    const currentPassword = ui.currentPasswordInput.value;
    const newPassword = ui.newPasswordInput.value;
    const confirmPassword = ui.confirmPasswordInput.value;
    if (newPassword !== confirmPassword) {
      setStatus(ui.passwordStatus, "两次输入的新密码不一致。", "error");
      return;
    }
    if (newPassword.length < 8) {
      setStatus(ui.passwordStatus, "新密码至少需要 8 位。", "error");
      return;
    }
    setBusy(ui.passwordSubmitBtn, true, "修改中…");
    try {
      const data = await api("/change-password", {
        method: "POST",
        body: { current_password: currentPassword, new_password: newPassword },
      });
      if (data.token) setToken(data.token);
      state.mustChangePassword = false;
      ui.securityBanner.hidden = true;
      ui.passwordForm.reset();
      setPasswordModalRequired(false);
      closeModal(ui.passwordModal, { force: true });
      showToast("密码已修改，当前会话已更新。", "ok");
      startPolling();
      await loadEvents();
    } catch (error) {
      setStatus(ui.passwordStatus, error.message || "密码修改失败", "error");
    } finally {
      setBusy(ui.passwordSubmitBtn, false);
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = window.setInterval(() => {
      if (state.selectedEventId) renderInvitePanel(currentEvent());
      if (
        document.hidden ||
        !state.selectedEventId ||
        state.dirtyRowIds.size ||
        state.recordsLoading ||
        state.mustChangePassword
      ) return;
      loadRecords({ silent: true });
      loadInvites({ silent: true });
    }, AUTO_REFRESH_MS);
  }

  function stopPolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }

  async function refreshRecords() {
    if (!guardDirty("刷新名单")) return;
    await loadRecords();
  }

  function bindEvents() {
    ui.loginForm.addEventListener("submit", login);
    const usernameField = ui.usernameInput.closest(".field");
    const focusUsernameFromTap = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      // 必须在用户的 pointer/click 手势中同步聚焦，iOS 才会可靠弹出键盘。
      // 监听整个字段，同时覆盖直接点中 placeholder 文字的情况。
      ui.usernameInput.focus({ preventScroll: true });
    };
    usernameField.addEventListener("pointerdown", focusUsernameFromTap);
    usernameField.addEventListener("click", focusUsernameFromTap);
    ui.retrySessionBtn.addEventListener("click", restoreSession);
    ui.logoutBtn.addEventListener("click", logout);
    ui.newEventBtn.addEventListener("click", openCreateEvent);
    ui.emptyCreateBtn.addEventListener("click", openCreateEvent);
    ui.refreshEventsBtn.addEventListener("click", refreshEvents);
    ui.createEventForm.addEventListener("submit", createEvent);
    ui.eventForm.addEventListener("submit", saveEvent);
    ui.publishEventBtn.addEventListener("click", publishEvent);
    ui.closeEventBtn.addEventListener("click", pauseEvent);
    ui.generateInviteBtn.addEventListener("click", generateInviteLink);
    ui.openInviteBtn.addEventListener("click", () => {
      if (state.lastInviteLink) window.open(state.lastInviteLink, "_blank", "noopener,noreferrer");
      else renderInvitePanel(currentEvent());
    });
    ui.refreshRecordsBtn.addEventListener("click", refreshRecords);
    ui.addRowBtn.addEventListener("click", openAddRowModal);
    ui.addRowForm.addEventListener("submit", addRow);
    ui.addRowForm.querySelectorAll("input, select, textarea").forEach((input) => {
      input.addEventListener("input", () => {
        input.removeAttribute("aria-invalid");
        setStatus(ui.addRowStatus, "");
      });
    });
    ui.saveRowsBtn.addEventListener("click", saveRows);
    ui.discardRowsBtn.addEventListener("click", discardRowChanges);
    ui.exportExcelBtn.addEventListener("click", exportTicketTemplate);
    ui.openPasswordBtn.addEventListener("click", () => {
      openPasswordModal(state.mustChangePassword);
    });
    ui.passwordForm.addEventListener("submit", changePassword);

    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener("click", () => closeModal($(button.dataset.closeModal)));
    });
    document.querySelectorAll(".modal-backdrop").forEach((modal) => {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeModal(modal);
      });
    });
    document.querySelectorAll("[data-toggle-password]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = $(button.dataset.togglePassword);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.textContent = show ? "隐藏" : "显示";
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      document.querySelectorAll(".modal-backdrop:not([hidden])").forEach(closeModal);
    });
    document.addEventListener("visibilitychange", () => {
      if (
        !document.hidden &&
        state.token &&
        state.selectedEventId &&
        !state.dirtyRowIds.size &&
        !state.recordsLoading &&
        !state.mustChangePassword
      ) {
        renderInvitePanel(currentEvent());
        loadRecords({ silent: true });
        loadInvites({ silent: true });
      }
    });
    window.addEventListener("beforeunload", (event) => {
      if (!state.dirtyRowIds.size) return;
      event.preventDefault();
      event.returnValue = "";
    });

  }

  bindEvents();
  bootstrapAdmin();
})();
