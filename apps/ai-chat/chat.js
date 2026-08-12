(() => {
  const apiBase = String(window.AI_API_BASE_URL || "").replace(/\/$/, "");
  const apiPath = (path) => (apiBase ? `${apiBase}${path}` : path);

  const ENDPOINTS = {
    config: window.AI_CONFIG_API_ENDPOINT || apiPath("/api/config"),
    chat: window.AI_CHAT_API_ENDPOINT || apiPath("/api/chat"),
    image: window.AI_IMAGE_API_ENDPOINT || apiPath("/api/image"),
    video: window.AI_VIDEO_API_ENDPOINT || apiPath("/api/video"),
    history: apiPath("/api/history"),
  };

  // 带访问密码的 POST；后端 401 时重新弹窗要密码并重试一次
  async function aiFetch(url, body) {
    const auth = window.AiAuth ? await window.AiAuth.authHeaders() : {};
    let response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(body),
    });
    if (response.status === 401 && window.AiAuth) {
      const retryAuth = await window.AiAuth.reauth();
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...retryAuth },
        body: JSON.stringify(body),
      });
    }
    return response;
  }

  const DEFAULT_CONFIG = {
    textModels: [
      { id: "agnes-2.0-flash", label: "Agnes 2.0 Flash" },
      { id: "agnes-1.5-flash", label: "Agnes 1.5 Flash" },
    ],
    imageModels: [
      { id: "agnes-image-2.1-flash", label: "Agnes Image 2.1 Flash" },
      { id: "agnes-image-2.0-flash", label: "Agnes Image 2.0 Flash" },
    ],
    videoModels: [
      { id: "agnes-video-v2.0", label: "Agnes Video v2.0" },
    ],
  };

  const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));
  const modeTitle = document.getElementById("modeTitle");
  const modelSelect = document.getElementById("modelSelect");
  const statusText = document.getElementById("statusText");
  const chatPanel = document.getElementById("chatPanel");
  const mediaPanel = document.getElementById("mediaPanel");
  const messagesEl = document.getElementById("messages");
  const emptyState = document.getElementById("emptyState");
  const mediaResults = document.getElementById("mediaResults");
  const mediaEmptyState = document.getElementById("mediaEmptyState");
  const mediaEmptyTitle = document.getElementById("mediaEmptyTitle");
  const mediaEmptyText = document.getElementById("mediaEmptyText");
  const chatForm = document.getElementById("chatForm");
  const promptInput = document.getElementById("promptInput");
  const sendBtn = document.getElementById("sendBtn");
  const newChatBtn = document.getElementById("newChatBtn");
  const historyList = document.getElementById("historyList");
  const historySectionTitle = document.getElementById("historySectionTitle");

  const messages = [];
  let pending = false;
  let currentMode = "chat";
  let config = { ...DEFAULT_CONFIG };
  let conversationId = generateId();
  let loadedConversationTitle = "";

  // -- mobile sidebar --
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const hamburgerBtn = document.getElementById("hamburgerBtn");

  function generateId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : "c" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("open");
  }

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("open");
  }

  const modeCopy = {
    chat: {
      title: "文本对话",
      status: "等待输入",
      placeholder: "输入问题...",
      hint: "Enter 发送，Shift + Enter 换行",
    },
    image: {
      title: "图片生成",
      status: "等待提示词",
      placeholder: "描述你想生成的图片，例如：明亮展馆里的购票信息工作台，玻璃质感，蓝色主调...",
      hint: "生成图片会消耗对应模型额度",
      emptyTitle: "描述你想生成的画面",
      emptyText: "选择 Agnes 图片模型后输入提示词，结果会显示在这里。",
    },
    video: {
      title: "视频生成",
      status: "等待提示词",
      placeholder: "描述你想生成的视频，例如：镜头缓慢推近一张科技感数据工作台，柔和蓝光，5秒...",
      hint: "视频模型耗时通常更长",
      emptyTitle: "描述你想生成的视频",
      emptyText: "选择 Agnes 视频模型后输入提示词，结果或任务信息会显示在这里。",
    },
  };

  // ── history helpers ────────────────────────────────

  // 历史记录接口现在也要访问密码（防止公网任意读写聊天记录）。
  // 这里只静默带上已保存的密码，不主动弹窗打断用户；401 时按失败处理。
  function silentAuthHeaders() {
    const token = window.AiAuth && window.AiAuth.getToken ? window.AiAuth.getToken() : "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  const HISTORY_CACHE_KEY = "ai_chat_history_cache";
  const HISTORY_LIMIT = 50;

  async function fetchHistoryList() {
    try {
      const url = `${ENDPOINTS.history}?limit=${HISTORY_LIMIT}`;
      const resp = await fetch(url, { headers: silentAuthHeaders() });
      if (!resp.ok) return [];
      const data = await resp.json();
      const convs = data.conversations || [];
      // Cache in localStorage for instant next load
      try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify({ ts: Date.now(), convs })); } catch {}
      return convs;
    } catch {
      // Fall back to cache
      try {
        const raw = localStorage.getItem(HISTORY_CACHE_KEY);
        if (raw) return JSON.parse(raw).convs || [];
      } catch {}
      return [];
    }
  }

  function getCachedHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_CACHE_KEY);
      if (raw) return JSON.parse(raw).convs || [];
    } catch {}
    return null;
  }

  async function saveHistory() {
    if (messages.length === 0) return;
    const type = currentMode === "chat" ? "chat" : currentMode;
    try {
      await fetch(ENDPOINTS.history, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...silentAuthHeaders() },
        body: JSON.stringify({
          conversation_id: conversationId,
          model: modelSelect.value,
          messages,
          type,
        }),
      });
      setSaveIndicator("已保存");
      renderHistoryList();
    } catch {
      setSaveIndicator("保存失败");
    }
  }

  async function loadConversation(id) {
    try {
      const resp = await fetch(`${ENDPOINTS.history}?conversation_id=${encodeURIComponent(id)}`, { headers: silentAuthHeaders() });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  async function deleteConversation(id) {
    try {
      await fetch(`${ENDPOINTS.history}?conversation_id=${encodeURIComponent(id)}`, { method: "DELETE", headers: silentAuthHeaders() });
    } catch {
      // best-effort
    }
  }

  function setSaveIndicator(text) {
    statusText.textContent = text;
    setTimeout(() => {
      if (statusText.textContent === text) {
        statusText.textContent = `当前会话：${Math.ceil(messages.length / 2)} 轮`;
      }
    }, 2000);
  }

  // ── history list UI ─────────────────────────────────

  function formatRelativeTime(ts) {
    const now = Date.now() / 1000;
    const diff = now - ts;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function renderHistoryList() {
    // Show cached data instantly
    const cached = getCachedHistory();
    if (cached) {
      _renderHistoryItems(cached.filter((c) => (c.type || "chat") === currentMode));
    }

    // Then refresh from network
    const convs = await fetchHistoryList();
    _renderHistoryItems(convs.filter((c) => (c.type || "chat") === currentMode));
  }

  function _renderHistoryItems(filtered) {
    historyList.textContent = "";

    if (filtered.length === 0) {
      const note = document.createElement("div");
      note.className = "side-note";
      note.textContent = "还没有对话记录。";
      note.style.padding = "6px 0";
      historyList.appendChild(note);
      return;
    }

    const typeIcons = { chat: "💬", image: "🖼", video: "🎬" };

    filtered.forEach((conv) => {
      const icon = typeIcons[conv.type] || "💬";

      const item = document.createElement("div");
      item.className = "history-item";
      if (conv.id === conversationId) item.classList.add("active");

      const title = document.createElement("span");
      title.className = "history-item-title";
      title.textContent = `${icon} ${conv.title || "(空对话)"}`;
      title.title = conv.title || "";

      const meta = document.createElement("span");
      meta.className = "history-item-meta";
      meta.textContent = `${conv.model || ""} · ${formatRelativeTime(conv.created_at)}`;

      const del = document.createElement("button");
      del.className = "history-item-del";
      del.textContent = "×";
      del.title = "删除此对话";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("确定删除这条对话记录？")) return;
        await deleteConversation(conv.id);
        if (conv.id === conversationId) {
          startNewConversation();
        } else {
          await renderHistoryList();
        }
      });

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(del);

      item.addEventListener("click", () => switchToConversation(conv.id));

      historyList.appendChild(item);
    });
  }

  function startNewConversation() {
    conversationId = generateId();
    loadedConversationTitle = "";
    messages.length = 0;
    const inner = messagesEl.querySelector(".messages-inner");
    if (inner) inner.querySelectorAll(".message").forEach((n) => n.remove());
    else messagesEl.querySelectorAll(".message").forEach((n) => n.remove());
    emptyState.style.display = "";
    setStatus(modeCopy[currentMode].status);
    statusText.textContent = "新对话";
    renderHistoryList();
    closeSidebar();
  }

  async function switchToConversation(id) {
    if (id === conversationId) return;
    const conv = await loadConversation(id);
    if (!conv) {
      statusText.textContent = "加载失败";
      return;
    }

    conversationId = conv.id;
    loadedConversationTitle = conv.title || "";

    messages.length = 0;
    (conv.messages || []).forEach((msg) => {
      messages.push(msg);
    });

    // If image/video, switch mode and render in media panel
    if (conv.type === "image" || conv.type === "video") {
      mediaResults.querySelectorAll(".result-card").forEach((n) => n.remove());
      setMode(conv.type);
      conv.messages.forEach((msg) => {
        if (msg.media_url && msg.media_url.startsWith("http")) {
          renderResultCard(conv.type, { url: msg.media_url }, msg.content);
        }
      });
    } else {
      // Re-render chat panel
      const inner = messagesEl.querySelector(".messages-inner");
      if (inner) inner.querySelectorAll(".message").forEach((n) => n.remove());
      messagesEl.querySelectorAll(".message").forEach((n) => n.remove());
      if (messages.length === 0) {
        emptyState.style.display = "";
      } else {
        emptyState.style.display = "none";
        messages.forEach((msg) => {
          renderMessage(msg.role, msg.content);
        });
      }
    }

    // Restore model if known
    if (conv.model && config[modelKeyForMode(currentMode)].some((m) => m.id === conv.model)) {
      modelSelect.value = conv.model;
    }

    statusText.textContent = `已加载：${Math.ceil(messages.length / 2)} 轮`;
    renderHistoryList();
    closeSidebar();
  }

  // ── model & config ──────────────────────────────────

  function modelKeyForMode(mode) {
    if (mode === "image") return "imageModels";
    if (mode === "video") return "videoModels";
    return "textModels";
  }

  function setStatus(text, isError = false) {
    statusText.textContent = text;
    statusText.classList.toggle("error", isError);
  }

  function populateModels() {
    const models = config[modelKeyForMode(currentMode)] || [];
    modelSelect.textContent = "";
    models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label || model.id;
      modelSelect.appendChild(option);
    });
    modelSelect.disabled = models.length === 0;
  }

  async function loadConfig() {
    try {
      const response = await fetch(ENDPOINTS.config);
      if (!response.ok) throw new Error("config unavailable");
      const data = await response.json();
      config = {
        textModels: data.textModels || data.models || DEFAULT_CONFIG.textModels,
        imageModels: data.imageModels || DEFAULT_CONFIG.imageModels,
        videoModels: data.videoModels || DEFAULT_CONFIG.videoModels,
      };
    } catch {
      config = { ...DEFAULT_CONFIG };
    }
    populateModels();
  }

  // ── rendering ───────────────────────────────────────

  function scrollActivePanelToBottom() {
    const target = currentMode === "chat" ? messagesEl : mediaResults;
    target.scrollTop = target.scrollHeight;
  }

  function renderMessage(role, text) {
    emptyState.style.display = "none";

    const item = document.createElement("article");
    item.className = `message ${role}`;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = role === "user" ? "你" : "AI";

    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = text;

    item.append(avatar, content);
    const inner = messagesEl.querySelector(".messages-inner");
    if (inner) inner.appendChild(item);
    scrollActivePanelToBottom();
    return content;
  }

  function renderResultCard(kind, payload, prompt) {
    mediaEmptyState.style.display = "none";

    const card = document.createElement("article");
    card.className = "result-card";

    const url = extractMediaUrl(payload);
    const meta = document.createElement("div");
    meta.className = "result-card-meta";
    meta.textContent = `模型：${modelSelect.value}\n提示词：${prompt}`;

    if (url && kind === "image") {
      const image = document.createElement("img");
      image.src = url;
      image.alt = prompt;
      card.appendChild(image);

      const dl = document.createElement("a");
      dl.className = "result-dl-btn";
      dl.href = url;
      dl.download = "";
      dl.textContent = "⬇ 下载图片";
      dl.target = "_blank";
      card.appendChild(dl);
    } else if (url && kind === "video") {
      const filename = url.split("/").pop() || "video.mp4";
      const dl = document.createElement("a");
      dl.className = "result-dl-btn";
      dl.href = url;
      dl.download = filename;
      dl.textContent = `⬇ ${filename}`;
      dl.target = "_blank";
      card.appendChild(dl);
    } else if (url) {
      const dl = document.createElement("a");
      dl.className = "result-dl-btn";
      dl.href = url;
      dl.download = "";
      dl.textContent = "⬇ 下载文件";
      dl.target = "_blank";
      card.appendChild(dl);
    } else {
      const pre = document.createElement("div");
      pre.textContent = JSON.stringify(payload, null, 2);
      card.appendChild(pre);
    }

    card.appendChild(meta);
    mediaResults.appendChild(card);
    scrollActivePanelToBottom();
  }

  function renderMediaError(text) {
    mediaEmptyState.style.display = "none";
    const card = document.createElement("article");
    card.className = "result-card error";
    card.textContent = text;
    mediaResults.appendChild(card);
    scrollActivePanelToBottom();
  }

  function extractReply(data) {
    if (!data) return "";
    if (typeof data.reply === "string") return data.reply;
    if (typeof data.output_text === "string") return data.output_text;
    if (Array.isArray(data.choices)) {
      return data.choices[0]?.message?.content || data.choices[0]?.text || "";
    }
    if (Array.isArray(data.output)) {
      return data.output
        .flatMap((item) => item.content || [])
        .map((part) => part.text || "")
        .join("")
        .trim();
    }
    return "";
  }

  function extractMediaUrl(data) {
    const first = Array.isArray(data?.data) ? data.data[0] : null;
    if (first?.url) return first.url;
    if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
    if (data?.url) return data.url;
    if (data?.video_url) return data.video_url;
    if (data?.output?.[0]?.url) return data.output[0].url;
    return "";
  }

  async function readError(response) {
    let detail = `API 请求失败：${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData?.error) detail = errorData.error;
    } catch {
      // Keep the HTTP status fallback.
    }
    return detail;
  }

  // ── send logic ──────────────────────────────────────

  function startProgress(options) {
    const slot = document.getElementById("aiProgressSlot");
    if (!slot || !window.AiProgress) {
      return { setStage() {}, finish() {}, fail() {} };
    }
    return window.AiProgress.start(slot, options);
  }

  async function sendChat(text) {
    const model = modelSelect.value;
    messages.push({ role: "user", content: text });
    renderMessage("user", text);

    const loadingContent = renderMessage("assistant", "正在生成回复...");
    loadingContent.classList.add("bubble-loading");
    setStatus(`正在请求 ${model}`);
    const progress = startProgress({ key: `chat:${model}`, title: "连接模型中…", fallbackMs: 15000 });

    try {
      await sendChatRequest(model, progress, loadingContent);
      progress.finish();
    } catch (error) {
      progress.fail("回复失败");
      throw error;
    }
  }

  async function sendChatRequest(model, progress, loadingContent) {
    const response = await aiFetch(ENDPOINTS.chat, {
      model,
      stream: true,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    if (!response.ok) throw new Error(await readError(response));

    const contentType = response.headers.get("content-type") || "";
    let reply = "";

    if (contentType.includes("text/event-stream") && response.body) {
      // 流式输出，降低长时间等待对移动端体验的影响。
      progress.setStage("模型思考中…");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          let piece = "";
          try {
            piece = JSON.parse(dataStr)?.choices?.[0]?.delta?.content || "";
          } catch {
            continue;
          }
          if (piece) {
            if (!reply) progress.setStage("回复生成中…");
            reply += piece;
            loadingContent.classList.remove("bubble-loading");
            loadingContent.textContent = reply;
            scrollActivePanelToBottom();
          }
        }
      }
      if (!reply) reply = "后端没有返回可显示的回复内容。";
    } else {
      // 兼容非流式后端（如 responses 风格 API）
      const data = await response.json();
      reply = extractReply(data) || "后端没有返回可显示的回复内容。";
    }

    messages.push({ role: "assistant", content: reply });
    loadingContent.textContent = reply;
    loadingContent.classList.remove("bubble-loading");
    setStatus(`已使用 ${model} 回复`);
    statusText.textContent = `当前会话：${Math.ceil(messages.length / 2)} 轮`;

    // Auto-save to backend
    saveHistory();
  }

  async function sendMedia(text) {
    const mode = currentMode;
    const model = modelSelect.value;
    const endpoint = ENDPOINTS[mode];

    setStatus(`正在请求 ${model}`);
    renderMediaError(`正在提交${mode === "image" ? "图片" : "视频"}生成任务...`);
    const progress = startProgress({
      key: `${mode}:${model}`,
      title: mode === "image" ? "图片生成中…" : "视频生成中…",
      fallbackMs: mode === "image" ? 25000 : 90000,
    });

    let data;
    try {
      const response = await aiFetch(endpoint, { model, prompt: text });

      mediaResults.lastElementChild?.remove();
      if (!response.ok) throw new Error(await readError(response));

      data = await response.json();
      progress.finish();
    } catch (error) {
      progress.fail(mode === "image" ? "图片生成失败" : "视频生成失败");
      throw error;
    }
    renderResultCard(mode, data, text);
    setStatus(`已提交 ${model}`);
    statusText.textContent = `${modeCopy[mode].title}：已生成 ${mediaResults.querySelectorAll(".result-card:not(.error)").length} 条结果`;

    // Save to history
    const mediaUrl = extractMediaUrl(data);
    messages.push({ role: "user", content: text, media_url: mediaUrl });
    saveHistory();
  }

  async function handleSubmit(text) {
    pending = true;
    sendBtn.disabled = true;
    promptInput.disabled = true;

    try {
      if (currentMode === "chat") {
        await sendChat(text);
      } else {
        await sendMedia(text);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (currentMode === "chat") {
        const content = renderMessage("assistant", `请求失败：\n\n${detail}`);
        content.classList.add("error");
      } else {
        renderMediaError(`请求失败：\n\n${detail}`);
      }
      setStatus("请求失败", true);
    } finally {
      pending = false;
      sendBtn.disabled = false;
      promptInput.disabled = false;
      scrollActivePanelToBottom();
    }
  }

  function setMode(mode) {
    currentMode = mode;
    modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
    chatPanel.classList.toggle("active", mode === "chat");
    mediaPanel.classList.toggle("active", mode !== "chat");

    // Clear opposite panel when switching
    if (mode === "chat") {
      mediaResults.querySelectorAll(".result-card").forEach((n) => n.remove());
      mediaEmptyState.style.display = "";
    } else {
      const inner = messagesEl.querySelector(".messages-inner");
      if (inner) inner.querySelectorAll(".message").forEach((n) => n.remove());
      messagesEl.querySelectorAll(".message").forEach((n) => n.remove());
      emptyState.style.display = "";
    }

    const copy = modeCopy[mode];
    modeTitle.textContent = copy.title;
    promptInput.placeholder = copy.placeholder;
    setStatus(copy.status);

    if (mode !== "chat") {
      mediaEmptyTitle.textContent = copy.emptyTitle;
      mediaEmptyText.textContent = copy.emptyText;
      mediaEmptyState.style.display = mediaResults.querySelector(".result-card") ? "none" : "";
    }

    statusText.textContent = mode === "chat"
      ? `当前会话：${Math.ceil(messages.length / 2)} 轮`
      : copy.hint || "";

    populateModels();
    renderHistoryList();
  }

  // ── events ──────────────────────────────────────────

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending) return;

    const text = promptInput.value.trim();
    if (!text) return;

    promptInput.value = "";
    handleSubmit(text);
  });

  promptInput.addEventListener("keydown", (event) => {
    if (currentMode === "chat" && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => { setMode(button.dataset.mode); closeSidebar(); });
  });

  // Hamburger menu
  hamburgerBtn.addEventListener("click", openSidebar);
  overlay.addEventListener("click", closeSidebar);

  // Auto-grow textarea
  promptInput.addEventListener("input", () => {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + "px";
  });

  newChatBtn.addEventListener("click", () => {
    if (currentMode === "chat") {
      startNewConversation();
    } else {
      mediaResults.querySelectorAll(".result-card").forEach((node) => node.remove());
      mediaEmptyState.style.display = "";
      setStatus(modeCopy[currentMode].status);
      statusText.textContent = modeCopy[currentMode].hint;
      }
  });

  // ── init ────────────────────────────────────────────

  loadConfig().then(async () => {
    await renderHistoryList();
    setMode("chat");
  });
})();
