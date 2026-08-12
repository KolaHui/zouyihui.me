(() => {
  "use strict";

  // API 合约集中在 portalApi；后端路径或响应结构变化时只需改这里。
  const config = window.PORTAL_CONFIG || {};
  const isLocalPortalPage = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const apiBase = String(
    isLocalPortalPage
      ? window.location.origin
      : config.apiBaseUrl || window.AI_API_BASE_URL || window.location.origin
  ).replace(/\/$/, "");
  const portalApi = {
    async getEvent(publicToken) {
      return requestJson(`/api/collection/public/events/${encodeURIComponent(publicToken)}`);
    },
    async submit(publicToken, payload) {
      return requestJson(`/api/collection/public/events/${encodeURIComponent(publicToken)}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  };

  const MAX_PEOPLE = 100;
  const MAX_REQUEST_BYTES = 256 * 1024;
  const SHARED_FIELDS = ["phone"];
  const PAYLOAD_PERSON_FIELDS = ["name", "document_type", "idcard", "phone", "position", "price", "extra"];
  const FIELD_LIMITS = {
    name: 100,
    phone: 32,
    document_type: 16,
    idcard: 32,
    position: 200,
    price: 20,
    extra: 2000,
  };
  const FIELD_ALIASES = {
    documentType: "document_type",
    document_no: "idcard",
    documentNo: "idcard",
  };

  const $ = (id) => document.getElementById(id);
  const dom = {
    eventTitle: $("eventTitle"),
    pageState: $("pageState"),
    pageStateText: $("pageStateText"),
    registrationForm: $("registrationForm"),
    applySharedBtn: $("applySharedBtn"),
    applySharedLabel: document.querySelector("[data-apply-shared-label]"),
    buyerList: $("buyerList"),
    buyerCountText: $("buyerCountText"),
    buyerCardTemplate: $("buyerCardTemplate"),
    addBuyerBtn: $("addBuyerBtn"),
    formMessage: $("formMessage"),
    submitButton: $("submitButton"),
    submitButtonText: $("submitButtonText"),
    submitSpinner: $("submitSpinner"),
    receiptCard: $("receiptCard"),
    receiptTitle: $("receiptTitle"),
    receiptMessage: $("receiptMessage"),
    receiptCount: $("receiptCount"),
    receiptTime: $("receiptTime"),
    receiptGroup: $("receiptGroup"),
    receiptEvent: $("receiptEvent"),
    duplicateNote: $("duplicateNote"),
    registerAnotherBtn: $("registerAnotherBtn"),
    reviewDialog: $("reviewDialog"),
    reviewOrientation: $("reviewOrientation"),
    reviewSkipBtn: $("reviewSkipBtn"),
    reviewScreen: $("reviewScreen"),
    reviewBackBtn: $("reviewBackBtn"),
    reviewCountPill: $("reviewCountPill"),
    reviewEventTitle: $("reviewEventTitle"),
    reviewScrollShell: $("reviewScrollShell"),
    reviewTableBody: $("reviewTableBody"),
    reviewMessage: $("reviewMessage"),
    reviewSubmitRail: $("reviewSubmitRail"),
    reviewSubmitButton: $("reviewSubmitButton"),
    reviewSubmitLabel: $("reviewSubmitLabel"),
  };

  const query = new URLSearchParams(window.location.search);
  // 新链接使用 event；读取 invite 是为了兼容已复制出去的旧参数形式。
  const publicToken = String(query.get("event") || query.get("invite") || "").trim();

  let currentEvent = null;
  let nextPersonId = 1;
  let isSubmitting = false;
  let collectionStopped = false;
  let pendingSubmissionIdentity = null;
  let reviewSnapshot = null;
  let reviewIntroTimer = 0;
  let applySharedTimer = 0;
  const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  class PortalApiError extends Error {
    constructor(message, status, fieldErrors, code = "", reference = "") {
      super(message);
      this.name = "PortalApiError";
      this.status = status;
      this.fieldErrors = fieldErrors || null;
      this.code = normalizeString(code);
      this.reference = normalizeString(reference);
    }
  }

  function localErrorReference(code = "WEB_ERROR") {
    return `${normalizeString(code) || "WEB_ERROR"}-${Date.now().toString(36).toUpperCase()}`;
  }

  async function requestJson(path, options = {}) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.headers || {}),
        },
      });
    } catch (_) {
      throw new PortalApiError(
        "无法连接登记服务，请确认网络正常后重试。",
        0,
        null,
        "NETWORK_ERROR",
        localErrorReference("NETWORK")
      );
    }

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        if (!response.ok) {
          throw new PortalApiError(
            `登记服务返回了无法识别的错误（HTTP ${response.status}）。`,
            response.status,
            null,
            `HTTP_${response.status}`,
            localErrorReference(`HTTP${response.status}`)
          );
        }
        throw new PortalApiError(
          "登记服务返回的数据格式异常。",
          response.status,
          null,
          "INVALID_RESPONSE",
          localErrorReference("RESPONSE")
        );
      }
    }

    if (!response.ok || data.error) {
      throw new PortalApiError(
        String(data.error || `请求失败（${response.status}）`),
        response.status,
        data.field_errors || null,
        data.error_code || `HTTP_${response.status}`,
        data.error_reference || localErrorReference(`HTTP${response.status}`)
      );
    }
    return data;
  }

  function newId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    const random = Math.random().toString(36).slice(2, 12);
    return `portal_${Date.now()}_${random}`;
  }

  function normalizeString(value) {
    return value == null ? "" : String(value).trim();
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function safeVibrate(pattern) {
    if (typeof navigator.vibrate !== "function") return;
    try {
      navigator.vibrate(pattern);
    } catch (_) {
      // iOS Safari 等不支持震动的浏览器静默降级，视觉反馈仍完整保留。
    }
  }

  function cloneFormData(formData) {
    return {
      shared: { ...formData.shared },
      people: formData.people.map(({ values }) => ({ values: { ...values } })),
    };
  }

  function unicodeLength(value) {
    return Array.from(String(value || "")).length;
  }

  function hasControlCharacters(value) {
    return /[\u0000-\u001F\u007F-\u009F]/u.test(String(value || ""));
  }

  function utf8Bytes(value) {
    return new TextEncoder().encode(String(value || ""));
  }

  async function payloadSignature(value) {
    const bytes = utf8Bytes(JSON.stringify(value));
    if (window.crypto?.subtle) {
      const digest = await window.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    // 非安全上下文的旧浏览器没有 SubtleCrypto；双 FNV 只用于识别本页内容是否变化。
    let first = 2166136261;
    let second = 2246822519;
    bytes.forEach((byte) => {
      first = Math.imul(first ^ byte, 16777619) >>> 0;
      second = Math.imul(second ^ byte, 3266489917) >>> 0;
    });
    return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
  }

  async function idempotencyKeyFor(contentPayload) {
    const signature = await payloadSignature(contentPayload);
    if (!pendingSubmissionIdentity || pendingSubmissionIdentity.signature !== signature) {
      pendingSubmissionIdentity = { signature, key: newId() };
    }
    return pendingSubmissionIdentity.key;
  }

  function normalizeEvent(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      public_token: normalizeString(source.public_token || publicToken),
      title: normalizeString(source.title || source.name || "购票信息登记"),
    };
  }

  function parseDate(raw) {
    const value = normalizeString(raw);
    if (!value) return null;
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      return {
        date: new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])),
        hasTime: false,
      };
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return { date, hasTime: /[T ]\d{1,2}:\d{2}/.test(value) };
  }

  function formatDateTime(raw) {
    const parsed = parseDate(raw);
    if (!parsed) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed.date);
  }

  function showPageState(message, tone = "") {
    dom.pageState.hidden = false;
    dom.pageState.className = `page-state${tone ? ` ${tone}` : ""}`;
    dom.pageStateText.textContent = message;
    const icon = dom.pageState.querySelector(".state-icon");
    if (tone === "error") {
      icon.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5"/><path d="M12 17h.01"/><path d="M10.3 3.6 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>';
    }
  }

  function hidePageState() {
    dom.pageState.hidden = true;
  }

  function showEventError(message) {
    dom.eventTitle.textContent = "无法打开本次登记";
    dom.registrationForm.hidden = true;
    dom.receiptCard.hidden = true;
    showPageState(message, "error");
  }

  function markCollectionStopped(message) {
    collectionStopped = true;
    setFormMessage(message || "该活动已停止收集。你填写的内容仍保留在本页，但已无法提交。", "error");
    setSubmitting(false);
  }

  function renderEvent(event) {
    document.title = `${event.title}｜购票信息登记`;
    dom.eventTitle.textContent = event.title;
  }

  function sharedInput(field) {
    return dom.registrationForm.querySelector(`[data-shared-field="${field}"]`);
  }

  function getSharedValues() {
    const values = {};
    SHARED_FIELDS.forEach((field) => {
      values[field] = normalizeString(sharedInput(field)?.value);
    });
    values.phone = compactPhone(values.phone) || values.phone;
    return values;
  }

  function setSharedValue(field, value) {
    const input = sharedInput(field);
    if (input) input.value = normalizeString(value);
  }

  function sharedDefaultsForPerson() {
    const shared = getSharedValues();
    return {
      name: "",
      phone: shared.phone,
      document_type: "身份证",
      idcard: "",
      position: "",
      price: "",
      extra: "",
    };
  }

  function personAutocomplete(field, personId) {
    const token = {
      name: "name",
      phone: "tel",
    }[field];
    return token ? `section-person-${personId} ${token}` : "off";
  }

  function addBuyer(initialValues = {}) {
    const currentCount = dom.buyerList.querySelectorAll(".buyer-card").length;
    if (currentCount >= MAX_PEOPLE) {
      setFormMessage(`一次最多登记 ${MAX_PEOPLE} 人，如人数更多请分批提交。`, "warn");
      return;
    }

    const fragment = dom.buyerCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".buyer-card");
    const personId = nextPersonId++;
    card.dataset.personId = String(personId);
    const values = { ...sharedDefaultsForPerson(), ...initialValues };

    card.querySelectorAll("[data-person-field]").forEach((input) => {
      const field = input.dataset.personField;
      input.value = normalizeString(values[field]);
      input.autocomplete = personAutocomplete(field, personId);
      if (SHARED_FIELDS.includes(field)) input.dataset.inherited = "true";
      const message = card.querySelector(`[data-field-error="${field}"]`);
      if (message) {
        message.id = `person-${personId}-${field}-message`;
        input.setAttribute("aria-describedby", message.id);
      }
      input.addEventListener("input", handlePersonInput);
      input.addEventListener("change", handlePersonInput);
      if (field === "idcard") input.addEventListener("blur", handlePersonInput);
    });
    syncDocumentInput(card);

    card.querySelector("[data-remove-buyer]").addEventListener("click", () => removeBuyer(card));
    if (currentCount > 0) card.classList.add("is-entering");
    dom.buyerList.appendChild(fragment);
    updateBuyerNumbers();
    if (currentCount > 0) {
      window.setTimeout(() => card.classList.remove("is-entering"), reduceMotionQuery.matches ? 0 : 420);
    }
    return card;
  }

  function handlePersonInput(event) {
    const input = event.currentTarget;
    const field = input.dataset.personField;
    const card = input.closest(".buyer-card");
    if (SHARED_FIELDS.includes(field)) {
      input.dataset.inherited = "false";
      setApplySharedState("idle");
    }
    clearFieldError(input.closest(".field"));
    if (field === "document_type") {
      syncDocumentInput(card);
      updateIdentityWarning(card);
    } else if (field === "idcard" && event.type !== "input") {
      updateIdentityWarning(card);
    }
  }

  function syncDocumentInput(card) {
    if (!card) return;
    const typeInput = card.querySelector('[data-person-field="document_type"]');
    const idInput = card.querySelector('[data-person-field="idcard"]');
    const label = card.querySelector("[data-document-label]");
    const isPassport = typeInput?.value === "护照";
    if (label) label.textContent = isPassport ? "护照号码" : "身份证号码";
    if (idInput) {
      idInput.placeholder = isPassport ? "请输入外国护照号码" : "请输入 15 或 18 位身份证号";
      idInput.inputMode = isPassport ? "text" : "numeric";
    }
  }

  function identityWarningText(card) {
    const cards = Array.from(dom.buyerList.querySelectorAll(".buyer-card"));
    const index = Math.max(0, cards.indexOf(card));
    return `第 ${index + 1} 位：这个身份证号码未通过常见规则检查（可能涉及位数、出生日期或校验码）。请对照原证件再确认一次；如果号码确与原证件一致，仍可继续提交。`;
  }

  function updateIdentityWarning(card) {
    if (!card) return false;
    const typeInput = card.querySelector('[data-person-field="document_type"]');
    const idInput = card.querySelector('[data-person-field="idcard"]');
    const wrapper = card.querySelector('[data-field-wrap="idcard"]');
    const value = normalizeString(idInput?.value).toUpperCase();
    if (!wrapper || wrapper.classList.contains("invalid")) return false;
    if (typeInput?.value !== "身份证" || !value || textFieldIssue("idcard", value) || validChineseId(value)) {
      if (wrapper.classList.contains("warning")) clearFieldError(wrapper);
      return false;
    }
    setFieldWarning(wrapper, identityWarningText(card));
    return true;
  }

  function removeBuyer(card) {
    if (isSubmitting || collectionStopped) return;
    const cards = dom.buyerList.querySelectorAll(".buyer-card");
    if (cards.length <= 1) return;
    card.remove();
    updateBuyerNumbers();
  }

  function updateBuyerNumbers() {
    const cards = Array.from(dom.buyerList.querySelectorAll(".buyer-card"));
    cards.forEach((card, index) => {
      card.querySelector("[data-buyer-number]").textContent = String(index + 1);
      card.querySelector("[data-buyer-title]").textContent = `第 ${index + 1} 位购票人`;
      const remove = card.querySelector("[data-remove-buyer]");
      remove.hidden = cards.length === 1;
      remove.setAttribute("aria-label", `删除第 ${index + 1} 位购票人`);
    });
    dom.buyerCountText.textContent = `当前 ${cards.length} 人，最多可一次登记 ${MAX_PEOPLE} 人。`;
    dom.addBuyerBtn.disabled = cards.length >= MAX_PEOPLE || isSubmitting || collectionStopped;
  }

  function syncSharedField(field, value, force = false) {
    dom.buyerList.querySelectorAll(`[data-person-field="${field}"]`).forEach((input) => {
      if (force || input.dataset.inherited !== "false") {
        input.value = value;
        input.dataset.inherited = "true";
        clearFieldError(input.closest(".field"));
      }
    });
  }

  function setApplySharedState(state) {
    window.clearTimeout(applySharedTimer);
    applySharedTimer = 0;
    dom.applySharedBtn.dataset.state = state;
    const label = state === "applying" ? "正在套用手机号" : state === "applied" ? "手机号已套用" : "套用到所有人";
    dom.applySharedBtn.setAttribute("aria-label", label);
    if (dom.applySharedLabel) dom.applySharedLabel.textContent = "套用到所有人";
  }

  function applyAllSharedValues() {
    const shared = getSharedValues();
    const input = sharedInput("phone");
    const phone = compactPhone(input?.value);
    const wrapper = input?.closest(".field");
    if (!phone) {
      setApplySharedState("idle");
      const problem = setFieldError(wrapper, "请先填写正确的 11 位手机号。");
      setFormMessage("统一手机号格式不正确，暂未套用。", "error");
      focusProblem(problem);
      return;
    }

    input.value = phone;
    clearFieldError(wrapper);
    setApplySharedState("applying");
    syncSharedField("phone", phone, true);
    setFormMessage("统一手机号已套用到全部购票人，你仍可逐人修改。", "ok");
    applySharedTimer = window.setTimeout(() => {
      setApplySharedState("applied");
      safeVibrate(16);
    }, reduceMotionQuery.matches ? 40 : 520);
  }

  function defaultsFromLastBuyer() {
    const cards = dom.buyerList.querySelectorAll(".buyer-card");
    const lastCard = cards[cards.length - 1];
    if (!lastCard) return {};
    const { values } = readPersonForm(lastCard);
    return {
      document_type: values.document_type || "身份证",
      position: values.position,
      price: values.price,
    };
  }

  function addBuyerFromPrevious() {
    const defaults = defaultsFromLastBuyer();
    const card = addBuyer(defaults);
    if (!card) return;
    if (defaults.document_type || defaults.position || defaults.price) {
      setFormMessage("已为新购票人沿用上一位的证件类型、座位/位置和票价，可继续单独修改。", "ok");
    }
  }

  function compactPhone(value) {
    const compact = normalizeString(value).replace(/[\s-]/g, "");
    return /^1[3-9]\d{9}$/.test(compact) ? compact : "";
  }

  function textFieldIssue(field, value) {
    if (hasControlCharacters(value)) return "不能包含控制字符。";
    const limit = FIELD_LIMITS[field];
    if (limit && unicodeLength(value) > limit) return `最多 ${limit} 个字符。`;
    return "";
  }

  function validDateParts(year, month, day) {
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
  }

  function validChineseId(idcard) {
    const id = normalizeString(idcard).toUpperCase();
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

  function clearFieldError(wrapper) {
    if (!wrapper) return;
    wrapper.classList.remove("invalid", "warning");
    const error = wrapper.querySelector(".field-error");
    if (error) error.textContent = "";
    const input = wrapper.querySelector("input, select, textarea");
    if (input) {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("data-warning");
    }
  }

  function setFieldError(wrapper, message) {
    if (!wrapper) return null;
    wrapper.classList.remove("warning");
    wrapper.classList.add("invalid");
    const error = wrapper.querySelector(".field-error");
    if (error) error.textContent = message;
    const input = wrapper.querySelector("input, select, textarea");
    if (input) {
      input.removeAttribute("data-warning");
      input.setAttribute("aria-invalid", "true");
    }
    return input;
  }

  function setFieldWarning(wrapper, message) {
    if (!wrapper) return null;
    wrapper.classList.remove("invalid");
    wrapper.classList.add("warning");
    const error = wrapper.querySelector(".field-error");
    if (error) error.textContent = message;
    const input = wrapper.querySelector("input, select, textarea");
    if (input) {
      input.removeAttribute("aria-invalid");
      input.setAttribute("data-warning", "true");
    }
    return input;
  }

  function clearAllErrors() {
    dom.registrationForm.querySelectorAll(".field.invalid, .field.warning").forEach(clearFieldError);
  }

  function readPersonForm(card) {
    const values = {};
    card.querySelectorAll("[data-person-field]").forEach((input) => {
      values[input.dataset.personField] = normalizeString(input.value);
    });
    values.phone = compactPhone(values.phone) || values.phone;
    values.idcard = normalizeString(values.idcard).toUpperCase();
    return { values };
  }

  function readFormData() {
    return {
      shared: getSharedValues(),
      people: Array.from(dom.buyerList.querySelectorAll(".buyer-card")).map(readPersonForm),
    };
  }

  function buildPayloadContent(formData) {
    const people = formData.people.map(({ values }) => {
      const person = {};
      PAYLOAD_PERSON_FIELDS.forEach((field) => {
        person[field] = values[field];
      });
      return person;
    });
    const content = { shared: { phone: formData.shared.phone }, people };
    if (formData.shared.phone) content.submitter_phone = formData.shared.phone;
    return content;
  }

  function buildPayload(content, idempotencyKey) {
    return { idempotency_key: idempotencyKey, ...content };
  }

  function validateShared(shared, errors) {
    const phoneWrapper = dom.registrationForm.querySelector('[data-shared-field-wrap="phone"]');
    if (shared.phone && !compactPhone(sharedInput("phone").value)) {
      errors.push(setFieldError(phoneWrapper, "请输入正确的 11 位手机号。"));
    }

    SHARED_FIELDS.forEach((field) => {
      const value = shared[field];
      const limit = FIELD_LIMITS[field];
      if (!value || !limit || unicodeLength(value) <= limit) return;
      const wrapper = dom.registrationForm.querySelector(`[data-shared-field-wrap="${field}"]`);
      errors.push(setFieldError(wrapper, `最多 ${limit} 个字符。`));
    });
  }

  function validatePerson(card, index, values, errors, warnings) {
    const fail = (field, message) => {
      const wrapper = card.querySelector(`[data-field-wrap="${field}"]`);
      errors.push(setFieldError(wrapper, `第 ${index + 1} 位：${message}`));
    };

    if (!values.name) {
      fail("name", "请填写姓名。");
    } else if (values.name) {
      const issue = textFieldIssue("name", values.name);
      if (issue) fail("name", `姓名${issue}`);
    }

    if (!values.document_type || !["身份证", "护照"].includes(values.document_type)) {
      fail("document_type", "请选择身份证或护照。");
    }

    if (!values.idcard) {
      fail("idcard", "请填写证件号码。");
    } else {
      const issue = textFieldIssue("idcard", values.idcard);
      if (issue) {
        fail("idcard", `证件号码${issue}`);
      } else if (values.document_type === "身份证" && !validChineseId(values.idcard)) {
        const wrapper = card.querySelector('[data-field-wrap="idcard"]');
        setFieldWarning(wrapper, identityWarningText(card));
        warnings.push(index);
      }
    }

    if (!values.phone) {
      fail("phone", "请填写手机号。");
    } else if (values.phone && !compactPhone(card.querySelector('[data-person-field="phone"]').value)) {
      fail("phone", "请输入正确的 11 位手机号。");
    }

    if (!values.position) {
      fail("position", "请填写想要的座位/位置。");
    } else {
      const issue = textFieldIssue("position", values.position);
      if (issue) fail("position", `座位/位置${issue}`);
    }

    if (!values.price) {
      fail("price", "请填写想要的票价。");
    } else if (!/^\d+$/.test(values.price)) {
      fail("price", "票价只能填写纯数字，不要带“元”。");
    } else if (unicodeLength(values.price) > FIELD_LIMITS.price) {
      fail("price", `票价最多 ${FIELD_LIMITS.price} 个字符。`);
    }

    if (values.extra && unicodeLength(values.extra) > FIELD_LIMITS.extra) {
      fail("extra", `备注最多 ${FIELD_LIMITS.extra} 个字符。`);
    }
  }

  function validateFormData(formData) {
    clearAllErrors();
    const errors = [];
    validateShared(formData.shared, errors);

    if (!formData.people.length) {
      setFormMessage("请至少添加一位购票人。", "error");
      return { ok: false, first: dom.addBuyerBtn };
    }
    if (formData.people.length > MAX_PEOPLE) {
      setFormMessage(`一次最多登记 ${MAX_PEOPLE} 人，请分批提交。`, "error");
      return { ok: false, first: dom.addBuyerBtn };
    }

    const cards = Array.from(dom.buyerList.querySelectorAll(".buyer-card"));
    const warnings = [];
    formData.people.forEach((person, index) => validatePerson(cards[index], index, person.values, errors, warnings));

    const documentOwners = new Map();
    formData.people.forEach(({ values: person }, index) => {
      if (!person.idcard) return;
      const key = person.idcard;
      if (documentOwners.has(key)) {
        const wrapper = cards[index].querySelector('[data-field-wrap="idcard"]');
        errors.push(setFieldError(wrapper, `与第 ${documentOwners.get(key) + 1} 位的证件号码重复。`));
      } else {
        documentOwners.set(key, index);
      }
    });

    const first = errors.find(Boolean) || null;
    const warningIndexes = Array.from(new Set(warnings));
    return { ok: !first, first, warningCount: warningIndexes.length, warningIndexes };
  }

  function normalizeBackendField(field) {
    return FIELD_ALIASES[field] || field;
  }

  function applyApiFieldErrors(fieldErrors) {
    if (!fieldErrors) return { first: null, summaries: [] };
    const entries = Array.isArray(fieldErrors)
      ? fieldErrors.map((item, index) => [String(index), item])
      : Object.entries(fieldErrors);
    const cards = Array.from(dom.buyerList.querySelectorAll(".buyer-card"));
    let first = null;
    const summaries = [];

    entries.forEach(([path, rawMessage]) => {
      const message = Array.isArray(rawMessage) ? rawMessage.join("；") : normalizeString(rawMessage);
      if (!message) return;

      const personMatch = path.match(/^people(?:\.|\[)(\d+)\]?\.([A-Za-z_]+)$/);
      if (personMatch) {
        const index = Number(personMatch[1]);
        const field = normalizeBackendField(personMatch[2]);
        const wrapper = cards[index]?.querySelector(`[data-field-wrap="${field}"]`);
        const friendlyMessage = `第 ${index + 1} 位：${message}`;
        const input = setFieldError(wrapper, friendlyMessage);
        summaries.push(friendlyMessage);
        if (wrapper?.closest("details")) wrapper.closest("details").open = true;
        if (!first && input) first = input;
        return;
      }

      const sharedMatch = path.match(/^shared\.([A-Za-z_]+)$/);
      if (sharedMatch) {
        const field = normalizeBackendField(sharedMatch[1]);
        const wrapper = dom.registrationForm.querySelector(`[data-shared-field-wrap="${field}"]`);
        const friendlyMessage = `统一信息：${message}`;
        const input = setFieldError(wrapper, friendlyMessage);
        summaries.push(friendlyMessage);
        if (wrapper?.closest("details")) wrapper.closest("details").open = true;
        if (!first && input) first = input;
        return;
      }
      summaries.push(message);
    });
    return { first, summaries };
  }

  function errorReferenceText(error) {
    const code = normalizeString(error?.code) || `HTTP_${error?.status || 0}`;
    const reference = normalizeString(error?.reference) || localErrorReference(code);
    return `${code} · ${reference}`;
  }

  function focusProblem(input) {
    if (!input) return;
    input.scrollIntoView({ behavior: reduceMotionQuery.matches ? "auto" : "smooth", block: "center" });
    window.setTimeout(() => input.focus({ preventScroll: true }), reduceMotionQuery.matches ? 0 : 260);
  }

  function setFormMessage(message, tone = "") {
    dom.formMessage.textContent = message;
    dom.formMessage.className = `form-message${tone ? ` ${tone}` : ""}`;
  }

  function setReviewMessage(message, tone = "") {
    dom.reviewMessage.textContent = message;
    dom.reviewMessage.className = `review-message${tone ? ` ${tone}` : ""}`;
  }

  function setReviewSubmitState(state) {
    dom.reviewSubmitRail.dataset.state = state;
    dom.reviewSubmitButton.dataset.state = state;
    const label = state === "loading" ? "正在安全提交" : state === "success" ? "提交成功" : "确认无误，正式提交";
    dom.reviewSubmitButton.setAttribute("aria-label", label);
  }

  function reviewIsOpen() {
    return dom.reviewDialog.hasAttribute("open");
  }

  function setSubmitting(value) {
    isSubmitting = value;
    const disabled = value || collectionStopped;
    dom.registrationForm.querySelectorAll("button, input, select, textarea").forEach((control) => {
      control.disabled = disabled;
    });
    dom.reviewBackBtn.disabled = value;
    dom.reviewSubmitButton.disabled = disabled;
    dom.submitButtonText.textContent = collectionStopped ? "已停止收集" : value ? "正在提交，请稍候…" : "预览并核对";
    dom.submitSpinner.hidden = !value || collectionStopped;
    if (!value) updateBuyerNumbers();
  }

  function appendReviewCell(row, value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = normalizeString(value) || "—";
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function appendReviewDocumentCell(row, person, needsReview = false) {
    const cell = document.createElement("td");
    cell.className = "review-document-cell";
    const badge = document.createElement("span");
    badge.className = "review-document-badge";
    badge.textContent = person.document_type || "身份证";
    const number = document.createElement("span");
    number.textContent = normalizeString(person.idcard) || "—";
    cell.append(badge, number);
    if (needsReview) {
      cell.classList.add("warning");
      const warning = document.createElement("span");
      warning.className = "review-id-warning";
      warning.textContent = "请核对";
      cell.appendChild(warning);
    }
    row.appendChild(cell);
  }

  function renderReview(contentPayload, warningIndexes = []) {
    const people = contentPayload.people || [];
    const warningSet = new Set(warningIndexes);
    const warningCount = warningSet.size;
    dom.reviewTableBody.replaceChildren();
    people.forEach((person, index) => {
      const row = document.createElement("tr");
      const indexCell = document.createElement("th");
      indexCell.scope = "row";
      indexCell.className = "review-index-cell";
      indexCell.textContent = String(index + 1);
      row.appendChild(indexCell);
      appendReviewCell(row, person.name, "review-name-cell");
      appendReviewDocumentCell(row, person, warningSet.has(index));
      appendReviewCell(row, person.phone, "review-phone-cell");
      appendReviewCell(row, person.position, "review-position-cell");
      appendReviewCell(row, person.price ? `¥${person.price}` : "", "review-price-cell");
      appendReviewCell(row, person.extra, "review-note-cell");
      dom.reviewTableBody.appendChild(row);
    });

    dom.reviewCountPill.textContent = `${people.length} 人`;
    dom.reviewEventTitle.textContent = currentEvent?.title || "本次购票登记";
    dom.reviewSubmitLabel.textContent = `确认无误，正式提交 ${people.length} 人`;
    setReviewMessage(
      warningCount
        ? `${warningCount} 位身份证未通过规则校验，已按警告保留；请确认号码与原证件一致后再提交。`
        : "请确认每个人的信息，提交后将进入管理员名单。",
      warningCount ? "warn" : ""
    );
    setReviewSubmitState("idle");
    dom.reviewScrollShell.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  function finishReviewIntro() {
    window.clearTimeout(reviewIntroTimer);
    reviewIntroTimer = 0;
    if (!reviewIsOpen()) return;
    dom.reviewDialog.dataset.stage = "review";
    dom.reviewOrientation.setAttribute("aria-hidden", "true");
    dom.reviewScreen.setAttribute("aria-hidden", "false");
    window.requestAnimationFrame(() => dom.reviewBackBtn.focus({ preventScroll: true }));
  }

  function openReview(contentPayload, warningIndexes = []) {
    reviewSnapshot = { contentPayload, warningIndexes };
    renderReview(contentPayload, warningIndexes);
    document.activeElement?.blur?.();
    dom.reviewDialog.dataset.stage = "rotating";
    dom.reviewOrientation.setAttribute("aria-hidden", "false");
    dom.reviewScreen.setAttribute("aria-hidden", "true");
    document.body.classList.add("review-open");

    if (!reviewIsOpen()) {
      if (typeof dom.reviewDialog.showModal === "function") {
        dom.reviewDialog.showModal();
      } else {
        dom.reviewDialog.setAttribute("open", "");
      }
    }

    if (reduceMotionQuery.matches) {
      finishReviewIntro();
      return;
    }
    dom.reviewSkipBtn.focus({ preventScroll: true });
    reviewIntroTimer = window.setTimeout(finishReviewIntro, 720);
  }

  function closeReview({ restoreFocus = true, preserveSnapshot = false } = {}) {
    window.clearTimeout(reviewIntroTimer);
    reviewIntroTimer = 0;
    if (reviewIsOpen()) {
      if (typeof dom.reviewDialog.close === "function") {
        dom.reviewDialog.close();
      } else {
        dom.reviewDialog.removeAttribute("open");
      }
    }
    document.body.classList.remove("review-open");
    dom.reviewDialog.dataset.stage = "rotating";
    dom.reviewOrientation.setAttribute("aria-hidden", "false");
    dom.reviewScreen.setAttribute("aria-hidden", "true");
    if (!preserveSnapshot) reviewSnapshot = null;
    if (restoreFocus && !collectionStopped) {
      window.requestAnimationFrame(() => dom.submitButton.focus({ preventScroll: true }));
    }
  }

  function renderReceipt(result, fallbackCount) {
    const count = Number(result.person_count || fallbackCount || 0);
    const submittedAt = result.submitted_at || new Date().toISOString();
    const duplicate = Boolean(result.duplicate);

    dom.receiptTitle.textContent = duplicate ? "信息已登记" : "登记成功";
    dom.receiptMessage.textContent = duplicate
      ? "这次请求此前已经成功提交，系统没有重复写入。"
      : "信息已经安全提交，请保留本页回执并勿重复登记。";
    dom.receiptCount.textContent = `${count} 人`;
    dom.receiptTime.textContent = formatDateTime(submittedAt);
    dom.receiptGroup.textContent = normalizeString(result.group_id) || "已登记";
    dom.receiptEvent.textContent = currentEvent?.title || "本次活动";
    dom.duplicateNote.hidden = !duplicate;

    dom.registrationForm.hidden = true;
    dom.receiptCard.hidden = false;
    dom.receiptCard.scrollIntoView({ behavior: reduceMotionQuery.matches ? "auto" : "smooth", block: "start" });
  }

  function requestSubmissionReview(event) {
    event.preventDefault();
    if (isSubmitting || collectionStopped || !currentEvent) return;

    const formData = readFormData();
    const validation = validateFormData(formData);
    if (!validation.ok) {
      setFormMessage("还有信息需要核对，请查看红色提示。", "error");
      focusProblem(validation.first);
      return;
    }

    const snapshot = cloneFormData(formData);
    const contentPayload = buildPayloadContent(snapshot);
    const previewPayload = buildPayload(contentPayload, "00000000-0000-4000-8000-000000000000");
    const requestBytes = utf8Bytes(JSON.stringify(previewPayload)).byteLength;
    if (requestBytes > MAX_REQUEST_BYTES) {
      setFormMessage(
        `本次信息约 ${Math.ceil(requestBytes / 1024)} KiB，超过 256 KiB 上限，请减少人数或备注后分批提交。`,
        "error"
      );
      return;
    }

    setFormMessage(
      validation.warningCount
        ? `已生成 ${formData.people.length} 位预览；其中 ${validation.warningCount} 位身份证有校验警告，请在横屏表格中人工核对。`
        : `已生成 ${formData.people.length} 位购票人的预览，最终确认前不会提交。`,
      validation.warningCount ? "warn" : "ok"
    );
    openReview(contentPayload, validation.warningIndexes);
  }

  async function submitReviewedRegistration() {
    if (isSubmitting || collectionStopped || !currentEvent || !reviewSnapshot) return;

    const contentPayload = reviewSnapshot.contentPayload;
    const personCount = contentPayload.people.length;
    setReviewSubmitState("loading");
    setReviewMessage(`正在提交 ${personCount} 位购票人的信息，请保持页面开启。`, "");
    setSubmitting(true);
    try {
      const idempotencyKey = await idempotencyKeyFor(contentPayload);
      const payload = buildPayload(contentPayload, idempotencyKey);
      const requestBytes = utf8Bytes(JSON.stringify(payload)).byteLength;
      if (requestBytes > MAX_REQUEST_BYTES) {
        throw new PortalApiError(
          `本次信息约 ${Math.ceil(requestBytes / 1024)} KiB，超过 256 KiB 上限，请减少人数或备注后分批提交。`,
          413,
          null
        );
      }

      const result = await portalApi.submit(publicToken, payload);
      if (!result || result.ok !== true) {
        throw new PortalApiError("提交未完成，请稍后重试。", 500, result?.field_errors);
      }

      setReviewSubmitState("success");
      setReviewMessage("提交成功，正在生成登记回执。", "ok");
      safeVibrate([24, 42, 58]);
      await wait(reduceMotionQuery.matches ? 90 : 680);
      closeReview({ restoreFocus: false });
      renderReceipt(result, personCount);
      pendingSubmissionIdentity = null;
      setSubmitting(false);
      setReviewSubmitState("idle");
    } catch (error) {
      if (error.status === 410) {
        setReviewSubmitState("idle");
        closeReview({ restoreFocus: false });
        markCollectionStopped(
          `${error.message || "该活动已停止收集。"} 你填写的内容仍保留在本页。如需帮助，请向活动管理员提供错误编号 ${errorReferenceText(error)}。`
        );
        return;
      }
      const fieldResult = applyApiFieldErrors(error.fieldErrors);
      const message = error.message || "提交失败，请稍后重试。";
      const reason = fieldResult.summaries.length ? fieldResult.summaries.join("；") : message;
      const reference = errorReferenceText(error);
      const customerMessage = `提交未受理：${reason} 如需帮助，请联系活动管理员并提供错误编号 ${reference}。`;
      setReviewSubmitState("idle");
      setSubmitting(false);
      setFormMessage(customerMessage, "error");
      if (fieldResult.first) {
        closeReview({ restoreFocus: false });
        focusProblem(fieldResult.first);
        return;
      }
      const canRetryUnchanged = !error.status || error.status === 429 || error.status >= 500;
      setReviewMessage(
        canRetryUnchanged
          ? `${customerMessage} 你可以保持信息不变并直接重试，系统会避免重复写入。`
          : `${customerMessage} 请返回修改对应信息后再试。`,
        "error"
      );
    }
  }

  function resetForAnotherBatch() {
    if (collectionStopped) return;
    pendingSubmissionIdentity = null;
    reviewSnapshot = null;
    clearAllErrors();
    setApplySharedState("idle");
    setSharedValue("phone", "");
    dom.buyerList.innerHTML = "";
    addBuyer();
    dom.receiptCard.hidden = true;
    dom.registrationForm.hidden = false;
    setFormMessage("点击下方按钮后会先进入横屏表格预览，不会直接提交。", "");
    dom.registrationForm.scrollIntoView({ behavior: reduceMotionQuery.matches ? "auto" : "smooth", block: "start" });
    window.setTimeout(
      () => sharedInput("phone")?.focus({ preventScroll: true }),
      reduceMotionQuery.matches ? 0 : 260
    );
  }

  function bindEvents() {
    dom.registrationForm.addEventListener("submit", requestSubmissionReview);
    dom.addBuyerBtn.addEventListener("click", addBuyerFromPrevious);
    dom.applySharedBtn.addEventListener("click", applyAllSharedValues);
    dom.registerAnotherBtn.addEventListener("click", resetForAnotherBatch);
    dom.reviewSkipBtn.addEventListener("click", finishReviewIntro);
    dom.reviewBackBtn.addEventListener("click", () => {
      if (!isSubmitting) closeReview();
    });
    dom.reviewSubmitButton.addEventListener("click", submitReviewedRegistration);
    dom.reviewDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!isSubmitting) closeReview();
    });
    dom.reviewDialog.addEventListener("close", () => {
      document.body.classList.remove("review-open");
    });

    dom.registrationForm.querySelectorAll("[data-shared-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.dataset.sharedField;
        setApplySharedState("idle");
        syncSharedField(field, input.value, false);
        clearFieldError(input.closest(".field"));
      });
    });
  }

  async function initialize() {
    bindEvents();
    if (!publicToken) {
      showEventError("链接中缺少活动编号，请重新打开管理员发送的完整链接。");
      return;
    }

    try {
      const payload = await portalApi.getEvent(publicToken);
      const rawEvent = payload?.event || payload?.data || payload;
      if (!rawEvent || typeof rawEvent !== "object") {
        throw new PortalApiError("没有找到该活动，请确认链接是否完整。", 404, null);
      }
      currentEvent = normalizeEvent(rawEvent);
      renderEvent(currentEvent);
      addBuyer();
      hidePageState();
      dom.registrationForm.hidden = false;
    } catch (error) {
      const message = error.message || "活动信息加载失败，请稍后重试。";
      const reference = error instanceof PortalApiError ? ` 如需帮助，请提供错误编号 ${errorReferenceText(error)}。` : "";
      showEventError(`${message}${reference}`);
    }
  }

  initialize();
})();
