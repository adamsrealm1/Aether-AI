const Aether = {
  config: {
    appName: "Aether",
    apiEndpoint: defaultApiEndpoint(),
  },
  state: {
    chats: [],
    activeChatId: null,
    composerDraft: "",
    sidebarSearch: "",
    mobileSidebarOpen: false,
    toast: "",
    thinking: false,
    profanityPopup: false,
    rateLimitPopup: false,
    voiceListening: false,
    rateLimit: {
      limit: 300,
      used: 0,
      remaining: 300,
      percentUsed: 0,
      resetInSeconds: 60,
    },
    rateMeter: {
      displayPercent: 100,
      targetPercent: 100,
    },
    serverOnline: false,
  },
};

let messageVisibilityObserver = null;
let rateMeterTimer = null;
let rateLimitCountdownTimer = null;
let serverStatusTimer = null;
let voiceRecognition = null;
let voiceSilenceTimer = null;
let voiceBaseDraft = "";
let voiceTranscript = "";
let voiceAutoSending = false;
const thoughtTimerTimeouts = new Map();
const LOCATION_TIME_PERMISSION_MESSAGE = "Accept Aether's permission to view your location to see what timezone you are in.";
const PROFANITY_BLOCK_MESSAGE = "You cant send Aether a message with profanity in it. You can try again without profanity in your message.";
const VOICE_AUTO_SEND_DELAY_MS = 1800;
const PROFANITY_PATTERNS = [
  /\bass\b/i,
  /\basshole\b/i,
  /\bbastard\b/i,
  /\bbitch\b/i,
  /\bcrap\b/i,
  /\bdamn\b/i,
  /\bfuck(?:er|ing)?\b/i,
  /\bshit(?:ty)?\b/i,
  /\bslut\b/i,
  /\bwhore\b/i,
  /\bnigga\b/i,
  /\bnigger\b/i,
  /\bnigg\b/i,
  /\bnig\b/i,
  /\bdick\b/i,
  /\bcock\b/i,
  /\bpussy\b/i,
];

const storage = {
  load() {
    const savedConfig = readJson("aether.config", {});
    for (const key of Object.keys(savedConfig)) {
      if (key === "apiEndpoint") continue;
      Aether.config[key] = savedConfig[key];
    }
    Aether.config.apiEndpoint = defaultApiEndpoint();
    Aether.state.chats = readJson("aether.chats", []).map(normalizeChat);
    Aether.state.activeChatId = localStorage.getItem("aether.activeChatId");

    if (!Aether.state.chats.length) {
      const chat = createChat("New conversation");
      Aether.state.chats = [chat];
      Aether.state.activeChatId = chat.id;
      storage.save();
    }

    if (!Aether.state.chats.some((chat) => chat.id === Aether.state.activeChatId)) {
      Aether.state.activeChatId = Aether.state.chats[0].id;
    }
  },
  save() {
    localStorage.setItem("aether.config", JSON.stringify(Aether.config));
    localStorage.setItem("aether.chats", JSON.stringify(Aether.state.chats));
    localStorage.setItem("aether.activeChatId", Aether.state.activeChatId || "");
  },
};

function defaultApiEndpoint() {
  if (canUseRelativeApi()) {
    return "/api/chat";
  }
  const publicEndpoint = configuredPublicApiEndpoint();
  if (publicEndpoint) {
    return publicEndpoint;
  }
  if (isStaticLaunch()) {
    return "http://127.0.0.1:8765/api/chat";
  }
  return "/api/chat";
}

function configuredPublicApiEndpoint() {
  const value = String(window.AETHER_API_ENDPOINT || "").trim();
  if (!/^https?:\/\//i.test(value)) return "";
  try {
    const url = new URL(value);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/api/chat";
      return url.toString().replace(/\/+$/, "");
    }
    return /\/api\/chat\/?$/i.test(url.pathname) ? url.toString().replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

function canUseRelativeApi() {
  return location.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(location.hostname);
}

function isStaticLaunch() {
  return location.protocol === "file:" || location.hostname.endsWith("github.io");
}

function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function createChat(title) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: createId(),
        role: "assistant",
        content: "Hi there! I'm Aether. What's on your mind?",
        createdAt: now,
      },
    ],
  };
}

function normalizeChat(chat) {
  const now = new Date().toISOString();
  const normalized = {
    id: chat?.id || createId(),
    title: String(chat?.title || "New conversation"),
    createdAt: chat?.createdAt || now,
    updatedAt: chat?.updatedAt || chat?.createdAt || now,
    messages: Array.isArray(chat?.messages) ? chat.messages : [],
  };
  normalized.messages = normalized.messages.map((message) => ({
    ...message,
    id: message?.id || createId(),
    role: message?.role === "user" ? "user" : "assistant",
    content: String(message?.content || ""),
    createdAt: message?.createdAt || normalized.createdAt,
  }));
  if (!normalized.messages.length) {
    normalized.messages = createChat(normalized.title).messages;
  }
  return normalized;
}

function activeChat() {
  return Aether.state.chats.find((chat) => chat.id === Aether.state.activeChatId);
}

function bootstrap() {
  injectStyles();
  storage.load();
  startRateLimitCountdown();
  render();
  checkServerStatus();
  startServerStatusPolling();
}

function render() {
  const root = document.getElementById("app");
  const chat = activeChat();
  const mobileSidebarClass = Aether.state.mobileSidebarOpen ? " mobile-sidebar-open" : "";

  root.innerHTML = `
    <div class="app-shell${mobileSidebarClass}">
      <button class="mobile-sidebar-scrim" type="button" data-action="close-mobile-sidebar" aria-label="Close sidebar"></button>
      <aside class="sidebar">
        <button class="brand" data-action="home" aria-label="Aether home">
          <img src="assets/Aether.png" alt="Aether" width="60" height="60">
          <span class="brand-copy">
            <span class="brand-name">Aether</span>
            ${renderServerStatus()}
          </span>
        </button>
        <button class="new-chat" data-action="new-chat">+ New conversation</button>
        <input class="sidebar-search" data-action="sidebar-search" autocomplete="off" placeholder="Search conversations" value="${escapeHtml(Aether.state.sidebarSearch)}">
        <div class="chat-list">
          ${filteredChats().map(chatListItem).join("") || `<div class="sidebar-empty">No conversations found.</div>`}
        </div>
        ${renderRateLimitMeter()}
      </aside>

      ${renderChatPage(chat)}
      ${renderProfanityPopup()}
      ${renderRateLimitPopup()}
      ${renderToast()}
    </div>
  `;

  bindEvents(root);
  observeMessageVisibility();
  scrollChatToBottom();
}

function renderChatPage(chat) {
  return `
    <main class="chat-page">
      <div class="animated-bg" aria-hidden="true"></div>
      <header class="topbar">
        <div class="topbar-title-row">
          <button class="mobile-sidebar-toggle" type="button" data-action="toggle-mobile-sidebar" aria-label="${Aether.state.mobileSidebarOpen ? "Close sidebar" : "Open sidebar"}" aria-expanded="${Aether.state.mobileSidebarOpen ? "true" : "false"}">
            <span></span>
            <span></span>
          </button>
          <h1>${escapeHtml(chat.title)}</h1>
        </div>
        <div class="topbar-actions">
          <button class="secondary-button" data-action="rename-chat">Rename</button>
          <button class="secondary-button" data-action="regenerate-last">Resend last</button>
        </div>
      </header>
      <div class="messages" id="messages">
        ${chat.messages.map(renderMessage).join("")}
        ${Aether.state.thinking ? renderThinking() : ""}
      </div>
      <div class="composer-area">
        <form class="composer" data-action="send-message">
          <div class="composer-input-wrap">
            <div class="composer-highlights" aria-hidden="true">${renderHighlightedComposerText(Aether.state.composerDraft)}</div>
            <textarea name="message" autocomplete="off" rows="1" placeholder="Send a message here." spellcheck="true">${escapeHtml(Aether.state.composerDraft)}</textarea>
          </div>
          <button class="voice-button ${Aether.state.voiceListening ? "listening" : ""}" type="button" data-action="voice-input" aria-label="${Aether.state.voiceListening ? "Stop voice input" : "Start voice input"}" aria-pressed="${Aether.state.voiceListening ? "true" : "false"}" title="${Aether.state.voiceListening ? "Stop voice input" : "Start voice input"}"${Aether.state.thinking ? " disabled" : ""}>🎙️</button>
          <button type="submit">Send</button>
        </form>
        <p class="composer-note">Aether can make mistakes. Check important info.</p>
      </div>
    </main>
  `;
}

function renderServerStatus() {
  const online = Boolean(Aether.state.serverOnline);
  return `
    <span class="server-status ${online ? "online" : "offline"}" aria-live="polite">
      <span class="server-dot" aria-hidden="true"></span>
      <span class="server-status-label">${online ? "Servers are online" : "Servers are offline"}</span>
    </span>
  `;
}

function chatListItem(chat) {
  const active = chat.id === Aether.state.activeChatId ? "active" : "";
  return `
    <div class="chat-item-row ${active}">
      <button class="chat-item" data-chat-id="${chat.id}">
        <span>${escapeHtml(chat.title)}</span>
        <small>${escapeHtml(chatPreview(chat))}</small>
      </button>
      <button class="delete-chat" data-delete-chat="${chat.id}" aria-label="Delete ${escapeHtml(chat.title)}">X</button>
    </div>
  `;
}

function filteredChats() {
  const query = Aether.state.sidebarSearch.trim().toLowerCase();
  return [...Aether.state.chats]
    .filter((chat) => {
      if (!query) return true;
      return [chat.title, ...chat.messages.map((message) => message.content)]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function chatPreview(chat) {
  const last = [...chat.messages].reverse().find((message) => message.content && message.role === "user") || chat.messages.at(-1);
  return last?.content ? last.content.slice(0, 72) : "Fresh conversation";
}

function renderToast() {
  const visible = Aether.state.toast ? " show" : "";
  return `<div class="toast${visible}" role="status" aria-live="polite">${escapeHtml(Aether.state.toast)}</div>`;
}

function renderRateLimitMeter() {
  const rate = Aether.state.rateLimit || {};
  const limit = Math.max(1, Number(rate.limit || 300));
  const remaining = Math.max(0, Math.min(limit, Number(rate.remaining ?? limit)));
  const targetPercent = Math.round((remaining / limit) * 100);
  const displayPercent = clampPercent(Aether.state.rateMeter?.displayPercent ?? targetPercent);
  const resetInSeconds = Math.max(0, Number(rate.resetInSeconds || 0));
  return `
    <div class="rate-card" style="--rate-color: ${rateColor(displayPercent)}">
      <div class="rate-percent">${displayPercent}%</div>
      <div class="rate-track"><span class="rate-fill" style="width: ${displayPercent}%"></span></div>
      <div class="rate-label">${remaining}/${limit} left - resets in ${resetInSeconds}s</div>
    </div>
  `;
}

function renderMessage(message) {
  const roleClass = message.role === "user" ? "user" : "assistant";
  const typingClass = message.typing ? " typing" : "";
  const messageId = message.id || "";
  const content = message.role === "assistant" ? sanitizeAssistantText(message.content) : message.content;
  const copyButton =
    message.role === "assistant" && !message.typing
      ? `<button class="copy-message" data-copy-message="${escapeHtml(messageId)}" aria-label="Copy this message" title="Copy this message">Copy</button>`
      : "";
  const thoughtTime =
    message.role === "assistant" && !message.typing && message.showThoughtTime && Number.isFinite(message.thoughtTimeMs)
      ? `<span class="thought-time">Aether took ${escapeHtml(formatThoughtTime(message.thoughtTimeMs))}</span>`
      : "";
  const messageControls = copyButton || thoughtTime ? `<div class="message-controls">${copyButton}${thoughtTime}</div>` : "";
  return `
    <div class="message-row ${roleClass}${typingClass}" data-message-id="${escapeHtml(messageId)}">
      <div class="message-stack">
        <div class="bubble">${escapeHtml(content)}</div>
        ${messageControls}
      </div>
    </div>
  `;
}

function renderThinking() {
  return `
    <div class="message-row assistant">
      <div class="thinking">
        <span>Thinking</span>
        <i></i><i></i><i></i>
      </div>
    </div>
  `;
}

function renderProfanityPopup() {
  if (!Aether.state.profanityPopup) return "";
  return `
    <div class="warning-overlay" role="dialog" aria-modal="true" aria-labelledby="warning-title">
      <div class="warning-modal">
        <h2 id="warning-title">Oops!</h2>
        <p>${escapeHtml(PROFANITY_BLOCK_MESSAGE)}</p>
        <button class="warning-understand" data-action="close-profanity">I understand</button>
      </div>
    </div>
  `;
}

function renderRateLimitPopup() {
  if (!Aether.state.rateLimitPopup) return "";
  const rate = Aether.state.rateLimit || {};
  return `
    <div class="warning-overlay compact" role="dialog" aria-modal="true">
      <div class="warning-modal compact-modal">
        <h2>Oops!</h2>
        <p>Wait ${Number(rate.resetInSeconds || 0)} seconds to use <strong>Aether</strong> AI again.</p>
        <button class="warning-understand" data-action="close-rate-limit">Okay.</button>
      </div>
    </div>
  `;
}

function bindEvents(root) {
  root.querySelector("[data-action='home']")?.addEventListener("click", () => {
    Aether.state.mobileSidebarOpen = false;
    render();
  });

  root.querySelector("[data-action='new-chat']")?.addEventListener("click", () => {
    Aether.state.mobileSidebarOpen = false;
    createNewChat();
  });
  root.querySelector("[data-action='toggle-mobile-sidebar']")?.addEventListener("click", () => {
    Aether.state.mobileSidebarOpen = !Aether.state.mobileSidebarOpen;
    render();
  });
  root.querySelector("[data-action='close-mobile-sidebar']")?.addEventListener("click", () => {
    Aether.state.mobileSidebarOpen = false;
    render();
  });

  root.querySelector("[data-action='rename-chat']")?.addEventListener("click", renameCurrentChat);
  root.querySelector("[data-action='regenerate-last']")?.addEventListener("click", regenerateLastAssistantMessage);
  root.querySelector("[data-action='sidebar-search']")?.addEventListener("input", (event) => {
    Aether.state.sidebarSearch = event.currentTarget.value;
    updateChatListDom();
  });

  bindChatListEvents(root);

  root.querySelector("[data-action='send-message']")?.addEventListener("submit", sendMessage);
  root.querySelector("[data-action='voice-input']")?.addEventListener("click", toggleVoiceInput);
  const composerInput = root.querySelector(".composer textarea[name='message']");
  composerInput?.addEventListener("input", (event) => {
    Aether.state.composerDraft = event.currentTarget.value;
    if (!containsProfanity(Aether.state.composerDraft)) {
      Aether.state.profanityPopup = false;
    }
    syncComposerHeight(event.currentTarget);
    updateProfanityHighlightDom(event.currentTarget);
  });
  composerInput?.addEventListener("scroll", () => syncComposerHighlightScroll(composerInput));
  composerInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  });
  if (composerInput) {
    syncComposerHeight(composerInput);
    updateProfanityHighlightDom(composerInput);
  }
  root.querySelector("[data-action='close-profanity']")?.addEventListener("click", () => {
    Aether.state.profanityPopup = false;
    render();
  });
  root.querySelector("[data-action='close-rate-limit']")?.addEventListener("click", () => {
    Aether.state.rateLimitPopup = false;
    render();
  });
  root.querySelectorAll("[data-copy-message]").forEach((button) => {
    button.addEventListener("click", () => copyAssistantMessage(button.dataset.copyMessage, button));
  });
}

function bindChatListEvents(root) {
  root.querySelectorAll("[data-chat-id]").forEach((button) => {
    button.addEventListener("click", () => {
      Aether.state.activeChatId = button.dataset.chatId;
      Aether.state.mobileSidebarOpen = false;
      storage.save();
      render();
    });
  });

  root.querySelectorAll("[data-delete-chat]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(button.dataset.deleteChat);
    });
  });
}

function updateChatListDom() {
  const list = document.querySelector(".chat-list");
  if (!list) return;
  list.innerHTML = filteredChats().map(chatListItem).join("") || `<div class="sidebar-empty">No conversations found.</div>`;
  bindChatListEvents(list);
}

function deleteChat(chatId) {
  const index = Aether.state.chats.findIndex((chat) => chat.id === chatId);
  if (index === -1) return;

  Aether.state.chats.splice(index, 1);
  if (!Aether.state.chats.length) {
    const chat = createChat("New conversation");
    Aether.state.chats.push(chat);
    Aether.state.activeChatId = chat.id;
  } else if (Aether.state.activeChatId === chatId) {
    const nextChat = Aether.state.chats[Math.min(index, Aether.state.chats.length - 1)];
    Aether.state.activeChatId = nextChat.id;
  }

  Aether.state.thinking = false;
  storage.save();
  render();
}

function createNewChat(seedText = "") {
  const chat = createChat(seedText ? seedText.slice(0, 36) : "New conversation");
  Aether.state.chats.unshift(chat);
  Aether.state.activeChatId = chat.id;
  Aether.state.composerDraft = seedText;
  storage.save();
  render();
  focusComposer();
}

function touchChat(chat) {
  if (!chat) return;
  chat.updatedAt = new Date().toISOString();
}

function renameCurrentChat() {
  const chat = activeChat();
  if (!chat) return;
  const title = window.prompt("Rename conversation", chat.title);
  if (!title) return;
  chat.title = title.trim().slice(0, 80) || chat.title;
  touchChat(chat);
  storage.save();
  render();
}

function syncComposerHeight(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(180, Math.max(42, textarea.scrollHeight))}px`;
  const highlights = textarea.closest(".composer-input-wrap")?.querySelector(".composer-highlights");
  if (highlights) {
    highlights.style.height = textarea.style.height;
  }
  syncComposerHighlightScroll(textarea);
}

function syncComposerHighlightScroll(textarea) {
  const highlights = textarea.closest(".composer-input-wrap")?.querySelector(".composer-highlights");
  if (!highlights) return;
  highlights.scrollTop = textarea.scrollTop;
  highlights.scrollLeft = textarea.scrollLeft;
}

function updateProfanityHighlightDom(textarea) {
  const highlights = textarea.closest(".composer-input-wrap")?.querySelector(".composer-highlights");
  if (!highlights) return;
  highlights.innerHTML = renderHighlightedComposerText(textarea.value);
  syncComposerHighlightScroll(textarea);
}

function renderHighlightedComposerText(text) {
  const value = String(text || "");
  if (!value) return "";
  const combined = new RegExp(`(${PROFANITY_PATTERNS.map((pattern) => pattern.source).join("|")})`, "gi");
  return escapeHtml(value).replace(combined, (match) => `<mark>${match}</mark>`);
}

async function sendMessage(event) {
  event.preventDefault();
  if (Aether.state.thinking) return;
  stopVoiceInput({ keepDraft: true });

  const form = event.currentTarget;
  const input = form.elements.message;
  const text = input.value.trim();
  Aether.state.composerDraft = input.value;
  if (!text) return;
  if (isRateLimited()) {
    Aether.state.rateLimitPopup = true;
    render();
    return;
  }
  if (handleLocalProfanity(text)) {
    syncComposerHeight(input);
    updateProfanityHighlightDom(input);
    return;
  }

  input.value = "";
  Aether.state.composerDraft = "";
  await sendTextMessage(text);
}

async function sendTextMessage(text, options = {}) {
  if (Aether.state.thinking) return;
  if (isRateLimited()) {
    Aether.state.rateLimitPopup = true;
    render();
    return;
  }
  if (handleLocalProfanity(text)) return;

  const chat = activeChat();
  if (options.addUser !== false) {
    chat.messages.push(createMessage("user", text));
  }
  if (["New conversation", "..."].includes(chat.title)) chat.title = text.slice(0, 48);
  touchChat(chat);

  Aether.state.thinking = true;
  storage.save();
  render();

  const thinkingStartedAt = performance.now();
  const answer = await getAssistantReply(text);
  const thoughtTimeMs = performance.now() - thinkingStartedAt;
  if (answer) {
    const assistantMessage = createMessage("assistant", "", { typing: true, thoughtTimeMs });
    chat.messages.push(assistantMessage);
    touchChat(chat);
    Aether.state.thinking = false;
    storage.save();
    render();
    await typeAssistantMessage(chat, assistantMessage, answer);
    return;
  }
  Aether.state.thinking = false;
  storage.save();
  render();
}

async function getAssistantReply(text) {
  if (looksLikeLocationTimeRequest(text)) {
    return getLocationTimeReply(text);
  }

  if (Aether.config.apiEndpoint) {
    const location = await locationForWeatherRequest(text);
    return fetchAssistantReply(text, location);
  }

  await wait(650);
  const lowered = text.toLowerCase();
  if (lowered.includes("time")) {
    return `It is ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  }
  return "Call-limit reached.";
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function toggleVoiceInput() {
  if (Aether.state.thinking) return;
  if (Aether.state.voiceListening) {
    stopVoiceInput({ keepDraft: true });
    return;
  }
  startVoiceInput();
}

function startVoiceInput() {
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) {
    showToast("Voice input is not supported in this browser.");
    return;
  }

  const input = document.querySelector(".composer textarea[name='message']");
  if (!input) return;

  stopVoiceInput({ keepDraft: true, silent: true });
  voiceBaseDraft = input.value.trim();
  voiceTranscript = "";
  voiceAutoSending = false;
  voiceRecognition = new Recognition();
  voiceRecognition.lang = navigator.language || "en-US";
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = true;
  voiceRecognition.maxAlternatives = 1;

  voiceRecognition.onresult = handleVoiceResult;
  voiceRecognition.onerror = (event) => {
    clearVoiceSilenceTimer();
    Aether.state.voiceListening = false;
    updateVoiceButtonDom();
    if (event.error !== "aborted" && event.error !== "no-speech") {
      showToast("Voice input stopped.");
    }
  };
  voiceRecognition.onend = () => {
    if (!voiceAutoSending) {
      Aether.state.voiceListening = false;
      updateVoiceButtonDom();
    }
  };

  try {
    voiceRecognition.start();
    Aether.state.voiceListening = true;
    updateVoiceButtonDom();
    input.focus();
  } catch {
    Aether.state.voiceListening = false;
    updateVoiceButtonDom();
  }
}

function handleVoiceResult(event) {
  let transcript = "";
  for (let index = 0; index < event.results.length; index += 1) {
    transcript += event.results[index][0]?.transcript || "";
  }
  voiceTranscript = transcript.trim();
  applyVoiceTranscript();
  scheduleVoiceAutoSend();
}

function applyVoiceTranscript() {
  const input = document.querySelector(".composer textarea[name='message']");
  if (!input) return;
  const nextText = [voiceBaseDraft, voiceTranscript].filter(Boolean).join(" ").trim();
  input.value = nextText;
  Aether.state.composerDraft = nextText;
  syncComposerHeight(input);
}

function scheduleVoiceAutoSend() {
  clearVoiceSilenceTimer();
  if (!voiceTranscript) return;
  voiceSilenceTimer = setTimeout(() => {
    autoSendVoiceTranscript();
  }, VOICE_AUTO_SEND_DELAY_MS);
}

function autoSendVoiceTranscript() {
  const form = document.querySelector("[data-action='send-message']");
  const input = form?.elements?.message;
  const text = input?.value?.trim() || "";
  if (!form || !text || Aether.state.thinking) return;
  voiceAutoSending = true;
  stopVoiceInput({ keepDraft: true, silent: true });
  form.requestSubmit();
}

function stopVoiceInput(options = {}) {
  clearVoiceSilenceTimer();
  if (voiceRecognition) {
    const recognition = voiceRecognition;
    voiceRecognition = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {}
    }
  }
  voiceBaseDraft = options.keepDraft ? Aether.state.composerDraft : "";
  voiceTranscript = "";
  Aether.state.voiceListening = false;
  updateVoiceButtonDom();
  if (!options.silent) storage.save();
}

function clearVoiceSilenceTimer() {
  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
}

function updateVoiceButtonDom() {
  const button = document.querySelector("[data-action='voice-input']");
  if (!button) return;
  const listening = Boolean(Aether.state.voiceListening);
  button.classList.toggle("listening", listening);
  button.setAttribute("aria-pressed", listening ? "true" : "false");
  button.setAttribute("aria-label", listening ? "Stop voice input" : "Start voice input");
  button.setAttribute("title", listening ? "Stop voice input" : "Start voice input");
}

async function getLocationTimeReply(text) {
  const permissionState = await geolocationPermissionState();
  if (permissionState !== "granted") {
    addAssistantMessage(LOCATION_TIME_PERMISSION_MESSAGE);
  }
  const location = await browserLocation(12000);
  if (!location) return "";

  if (!Aether.config.apiEndpoint) {
    return browserTimeReply();
  }

  return fetchAssistantReply(text, location);
}

async function fetchAssistantReply(text, location = null) {
  if (Aether.config.apiEndpoint) {
    let retryDelayMs = 3000;
    while (true) {
      try {
        const headers = await authHeaders({ "Content-Type": "application/json;charset=UTF-8" });
        const response = await fetch(Aether.config.apiEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ message: text, chat: activeChat().messages, location }),
        });
        if (!response.ok) {
          if (isRetryableStatus(response.status)) {
            await wait(retryDelayMs);
            retryDelayMs = nextRetryDelay(retryDelayMs);
            continue;
          }
          return `I could not reach ${Aether.config.apiEndpoint}. ${backendLaunchMessage()}`;
        }
        const data = await response.json();
        applyServerStatus(data);
        if (data.retryable) {
          await wait(Number(data.retryAfterSeconds || 4) * 1000);
          retryDelayMs = nextRetryDelay(retryDelayMs);
          continue;
        }
        if (data.rateLimited) {
          Aether.state.rateLimitPopup = true;
          render();
          return "";
        }
        if (data.profanityBlocked) {
          Aether.state.profanityPopup = true;
          render();
          return "";
        }
        if (data.reply) return data.reply;
      } catch (error) {
        await wait(retryDelayMs);
        retryDelayMs = nextRetryDelay(retryDelayMs);
      }
    }
  }
  return "";
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function nextRetryDelay(currentDelayMs) {
  return Math.min(15000, Math.max(3000, Math.round(currentDelayMs * 1.4)));
}

function handleLocalProfanity(text) {
  if (!containsProfanity(text)) return false;
  Aether.state.profanityPopup = true;
  render();
  return true;
}

function containsProfanity(text) {
  return PROFANITY_PATTERNS.some((pattern) => pattern.test(text));
}

function isRateLimited() {
  resetExpiredRateLimitWindow();
  const rate = Aether.state.rateLimit;
  return Boolean(rate && Number(rate.remaining) <= 0);
}

function applyServerStatus(data) {
  if (data.rateLimit) {
    updateRateLimit(data.rateLimit);
  }
}

function setServerOnline(online) {
  const previous = Boolean(Aether.state.serverOnline);
  Aether.state.serverOnline = Boolean(online);
  updateServerStatusDom();
  return previous !== Aether.state.serverOnline;
}

function updateServerStatusDom() {
  const status = document.querySelector(".server-status");
  if (!status) return;
  const online = Boolean(Aether.state.serverOnline);
  status.classList.toggle("online", online);
  status.classList.toggle("offline", !online);
  const label = status.querySelector(".server-status-label");
  if (label) label.textContent = online ? "Servers are online" : "Servers are offline";
}

function startServerStatusPolling() {
  if (serverStatusTimer) clearInterval(serverStatusTimer);
  serverStatusTimer = setInterval(pingServerStatus, 15000);
}

async function pingServerStatus() {
  try {
    const response = await fetch(apiUrl("/api/status"), {
      headers: await authHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Status failed with HTTP ${response.status}`);
    const data = await response.json();
    setServerOnline(true);
    applyServerStatus(data);
  } catch {
    setServerOnline(false);
  }
}

function updateRateLimit(rateLimit) {
  Aether.state.rateLimit = {
    ...Aether.state.rateLimit,
    ...rateLimit,
  };
  animateRateMeterTo(ratePercent(Aether.state.rateLimit));
  updateRateMeterDom();
}

function startRateLimitCountdown() {
  if (rateLimitCountdownTimer) clearInterval(rateLimitCountdownTimer);
  rateLimitCountdownTimer = setInterval(() => {
    const rate = Aether.state.rateLimit;
    if (!rate) return;
    const current = Number(rate.resetInSeconds);
    if (!Number.isFinite(current)) return;
    if (current <= 0) {
      resetExpiredRateLimitWindow();
      updateRateMeterDom();
      return;
    }
    rate.resetInSeconds = Math.max(0, current - 1);
    if (rate.resetInSeconds === 0) {
      resetExpiredRateLimitWindow();
    }
    updateRateMeterDom();
  }, 1000);
}

function resetExpiredRateLimitWindow() {
  const rate = Aether.state.rateLimit;
  if (!rate) return;
  const limit = Number(rate.limit || 0);
  if (!limit || Number(rate.resetInSeconds || 0) > 0) return;
  rate.used = 0;
  rate.remaining = limit;
  rate.percentUsed = 0;
  rate.resetInSeconds = 60;
  animateRateMeterTo(100);
}

function animateRateMeterTo(targetPercent) {
  targetPercent = clampPercent(targetPercent);
  Aether.state.rateMeter.targetPercent = targetPercent;
  if (!Number.isFinite(Number(Aether.state.rateMeter.displayPercent))) {
    Aether.state.rateMeter.displayPercent = targetPercent;
  }
  if (rateMeterTimer) clearInterval(rateMeterTimer);

  rateMeterTimer = setInterval(() => {
    const current = clampPercent(Aether.state.rateMeter.displayPercent);
    if (current === targetPercent) {
      clearInterval(rateMeterTimer);
      rateMeterTimer = null;
      return;
    }
    Aether.state.rateMeter.displayPercent = current + (targetPercent > current ? 1 : -1);
    updateRateMeterDom();
  }, 24);
}

function updateRateMeterDom() {
  const card = document.querySelector(".rate-card");
  if (!card) return;
  const rate = Aether.state.rateLimit || {};
  const limit = Math.max(1, Number(rate.limit || 300));
  const remaining = Math.max(0, Math.min(limit, Number(rate.remaining ?? limit)));
  const displayPercent = clampPercent(Aether.state.rateMeter?.displayPercent ?? ratePercent(rate));
  const resetInSeconds = Math.max(0, Number(rate.resetInSeconds || 0));
  card.style.setProperty("--rate-color", rateColor(displayPercent));
  const percentElement = card.querySelector(".rate-percent");
  if (percentElement) percentElement.textContent = `${displayPercent}%`;
  const fillElement = card.querySelector(".rate-fill");
  if (fillElement) fillElement.style.width = `${displayPercent}%`;
  const labelElement = card.querySelector(".rate-label");
  if (labelElement) labelElement.textContent = `${remaining}/${limit} left - resets in ${resetInSeconds}s`;
}

function ratePercent(rate) {
  const limit = Math.max(1, Number(rate?.limit || 300));
  const remaining = Math.max(0, Math.min(limit, Number(rate?.remaining ?? limit)));
  return Math.round((remaining / limit) * 100);
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function rateColor(percent) {
  const t = 1 - clampPercent(percent) / 100;
  const white = [248, 251, 255];
  const red = [239, 68, 68];
  const mixed = white.map((channel, index) => Math.round(channel + (red[index] - channel) * t));
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

async function checkServerStatus() {
  try {
    const response = await fetch(apiUrl("/api/status"), { cache: "no-store" });
    if (!response.ok) throw new Error(`Status failed with HTTP ${response.status}`);
    const data = await response.json();
    setServerOnline(true);
    applyServerStatus(data);
    storage.save();
    updateRateMeterDom();
  } catch {
    setServerOnline(false);
  }
}

async function authHeaders(base = {}) {
  return { ...base };
}


function apiUrl(path) {
  if (Aether.config.apiEndpoint?.startsWith("http://") || Aether.config.apiEndpoint?.startsWith("https://")) {
    return new URL(path, Aether.config.apiEndpoint).toString();
  }
  return path;
}

function backendLaunchMessage() {
  if (canUseRelativeApi()) {
    return "Start server.py and open http://127.0.0.1:8765/.";
  }
  if (location.protocol === "file:") {
    return "Start server.py. This file page uses http://127.0.0.1:8765/api/chat on this computer.";
  }
  if (location.protocol === "https:" && location.hostname.endsWith("github.io")) {
    return "This GitHub Pages site needs a public HTTPS backend in config.js to work from anywhere.";
  }
  return "Start server.py, or use a public HTTPS backend.";
}

async function locationForWeatherRequest(text) {
  if (!looksLikeWeatherRequest(text)) return null;
  return browserLocation(8000);
}

async function browserLocation(timeout = 8000) {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => resolve(null),
      {
        enableHighAccuracy: false,
        timeout,
        maximumAge: 600000,
      },
    );
  });
}

async function geolocationPermissionState() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state || "unknown";
  } catch {
    return "unknown";
  }
}

function looksLikeWeatherRequest(text) {
  return /\b(weather|forecast|temperature|rain|snow|humidity|wind|storm|hot|cold)\b/i.test(text);
}

function looksLikeLocationTimeRequest(text) {
  return /\bwhat\b/i.test(text) && /\btime\b/i.test(text);
}

function browserTimeReply() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "your local timezone";
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `It is ${time} in ${timezone}.`;
}

function addAssistantMessage(text) {
  const chat = activeChat();
  chat.messages.push(createMessage("assistant", text));
  touchChat(chat);
  storage.save();
  render();
}

function createMessage(role, content, extras = {}) {
  return {
    id: createId(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extras,
  };
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function copyAssistantMessage(messageId, button) {
  const chat = activeChat();
  const message = chat?.messages.find((item) => item.id === messageId);
  if (!message?.content) return;
  await writeClipboard(sanitizeAssistantText(message.content), button);
}

async function writeClipboard(text, button = null) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied to clipboard.");
    if (button) button.textContent = "Copied";
  } catch {
    showToast("Copy failed.");
    if (button) button.textContent = "Copy failed";
  }
  if (button) {
    setTimeout(() => {
      button.textContent = "📋";
    }, 1200);
  }
}

function regenerateLastAssistantMessage() {
  const chat = activeChat();
  if (!chat || Aether.state.thinking) return;
  const lastAssistantIndex = findLastMessageIndex(chat, "assistant");
  if (lastAssistantIndex <= 0) return;
  const previousUser = [...chat.messages.slice(0, lastAssistantIndex)].reverse().find((message) => message.role === "user");
  if (!previousUser) return;
  chat.messages.splice(lastAssistantIndex, 1);
  touchChat(chat);
  storage.save();
  render();
  sendTextMessage(previousUser.content, { addUser: false });
}

function findLastMessageIndex(chat, role) {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    if (chat.messages[index].role === role) return index;
  }
  return -1;
}

function showToast(message) {
  Aether.state.toast = message;
  updateToastDom();
  setTimeout(() => {
    if (Aether.state.toast === message) {
      Aether.state.toast = "";
      updateToastDom();
    }
  }, 1800);
}

function updateToastDom() {
  let toast = document.querySelector(".toast");
  if (!toast) {
    const shell = document.querySelector(".app-shell");
    if (!shell) return;
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    shell.appendChild(toast);
  }
  toast.textContent = Aether.state.toast;
  toast.classList.toggle("show", Boolean(Aether.state.toast));
}

function focusComposer() {
  requestAnimationFrame(() => {
    const input = document.querySelector(".composer textarea[name='message']");
    input?.focus();
    if (input) {
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      syncComposerHeight(input);
    }
  });
}

async function typeAssistantMessage(chat, message, fullText) {
  const row = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  const bubble = row?.querySelector(".bubble");
  const cleanText = sanitizeAssistantText(fullText);

  if (bubble) {
    await revealAssistantText(bubble, cleanText);
    scrollChatToBottom();
  }

  message.content = cleanText;
  message.typing = false;
  message.showThoughtTime = Number.isFinite(message.thoughtTimeMs);
  row?.classList.remove("typing");
  storage.save();
  render();
  scheduleThoughtTimeFade(message.id);
}

function scheduleThoughtTimeFade(messageId) {
  if (!messageId) return;
  if (thoughtTimerTimeouts.has(messageId)) {
    clearTimeout(thoughtTimerTimeouts.get(messageId));
  }

  const timeoutId = setTimeout(() => {
    thoughtTimerTimeouts.delete(messageId);
    const message = Aether.state.chats
      .flatMap((chat) => chat.messages)
      .find((item) => item.id === messageId);
    if (!message || !message.showThoughtTime) return;
    message.showThoughtTime = false;
    storage.save();
    const row = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    row?.querySelector(".thought-time")?.remove();
  }, 3000);

  thoughtTimerTimeouts.set(messageId, timeoutId);
}

function formatThoughtTime(milliseconds) {
  if (milliseconds < 1000) return `${Math.max(0.1, milliseconds / 1000).toFixed(1)}s`;
  if (milliseconds < 10000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.round(milliseconds / 1000)}s`;
}

async function revealAssistantText(container, text) {
  const parts = text.match(/\s+|\S+/g) || [text];
  const totalWords = parts.filter((part) => !/^\s+$/.test(part)).length;
  const delayStep = wordRevealDelay(totalWords);
  let revealedWords = 0;

  container.textContent = "";
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      container.appendChild(document.createTextNode(part));
      continue;
    }

    const word = document.createElement("span");
    word.className = "fade-word";
    word.textContent = part;
    container.appendChild(word);
    revealedWords += 1;

    if (revealedWords % 8 === 0) {
      scrollChatToBottom();
    }
    await wait(delayStep);
  }
}

function wordRevealDelay(wordCount) {
  if (wordCount > 700) return 8;
  if (wordCount > 220) return 12;
  if (wordCount > 120) return 18;
  if (wordCount > 70) return 28;
  return 48;
}

function sanitizeAssistantText(text) {
  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`{1,3}/g, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "");
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    const messages = document.getElementById("messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
}

function observeMessageVisibility() {
  const messages = document.getElementById("messages");
  if (!messages) return;

  if (messageVisibilityObserver) {
    messageVisibilityObserver.disconnect();
  }

  messageVisibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const opacity = Math.max(0.16, Math.min(1, entry.intersectionRatio * 1.25));
        entry.target.style.opacity = opacity.toFixed(2);
        entry.target.classList.toggle("is-faded", opacity < 0);
      }
    },
    {
      root: messages,
      threshold: [0, 0, 0, 0.24, 0.32, 0.4, 0.55, 0.7, 0.85, 1],
    },
  );

  messages.querySelectorAll(".message-row").forEach((row) => {
    messageVisibilityObserver.observe(row);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; } 
    html, body, #app { width: 100%; height: 100%; margin: 0; }
    body {
      overflow: hidden;
      background: #02040a;
      color: #f8fbff;
      font-family: Inter, "Segoe UI", Arial, sans-serif;
    }
    button, input, textarea { font: inherit; }
    button { cursor: pointer; }
    .app-shell {
      position: relative;
      isolation: isolate;
      display: grid;
      grid-template-columns: 284px 1fr;
      height: 100%;
      background:
        linear-gradient(125deg, #02040a 0%, #062a2d 28%, #111827 54%, #251324 78%, #040506 100%);
      background-size: 180% 180%;
      animation: shellGradient 22s ease-in-out infinite;
      overflow: hidden;
    }
    .app-shell::before,
    .app-shell::after {
      content: "";
      position: fixed;
      inset: -20%;
      z-index: -1;
      pointer-events: none;
    }
    .app-shell::before {
      background:
        linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
      background-size: 72px 72px;
      -webkit-mask-image: linear-gradient(135deg, transparent 8%, black 35%, black 70%, transparent 96%);
      mask-image: linear-gradient(135deg, transparent 8%, black 35%, black 70%, transparent 96%);
      animation: gridPan 18s linear infinite;
      opacity: 0.44;
    }
    .app-shell::after {
      background:
        conic-gradient(from 120deg at 50% 50%,
          transparent 0deg,
          rgba(45, 212, 191, 0.16) 54deg,
          rgba(251, 191, 36, 0.08) 112deg,
          transparent 170deg,
          rgba(56, 189, 248, 0.14) 238deg,
          rgba(244, 114, 182, 0.08) 304deg,
          transparent 360deg);
      filter: blur(32px);
      transform: scale(1.16);
      animation: auraTurn 28s ease-in-out infinite alternate;
      opacity: 0.78;
    }
    .mobile-sidebar-scrim,
    .mobile-sidebar-toggle {
      display: none;
    }
    .animated-bg {
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      overflow: hidden;
      background:
        linear-gradient(105deg, transparent 0%, rgba(14, 165, 233, 0.13) 25%, transparent 46%),
        linear-gradient(290deg, transparent 12%, rgba(34, 197, 94, 0.08) 38%, transparent 58%),
        repeating-linear-gradient(125deg, rgba(255, 255, 255, 0.045) 0 1px, transparent 1px 18px);
      background-size: 200% 200%, 180% 180%, 100% 100%;
      animation: backgroundSweep 16s ease-in-out infinite alternate;
      opacity: 0.72;
    }
    @keyframes shellGradient {
      0%, 100% { background-position: 0% 42%; }
      50% { background-position: 100% 58%; }
    }
    @keyframes gridPan {
      from { transform: translate3d(0, 0, 0); }
      to { transform: translate3d(72px, 72px, 0); }
    }
    @keyframes auraTurn {
      from { transform: scale(1.12) rotate(-6deg); }
      to { transform: scale(1.22) rotate(8deg); }
    }
    @keyframes backgroundSweep {
      from { background-position: 0% 50%, 100% 50%, 0 0; }
      to { background-position: 100% 50%, 0% 50%, 0 0; }
    }
    @keyframes serverPulseGreen {
      0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.48); }
      70% { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
      100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }
    @keyframes serverPulseRed {
      0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.48); }
      70% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
      100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
    }
    .sidebar {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 18px;
      border-right: 1px solid rgba(191, 219, 254, 0.12);
      background: rgba(0, 0, 0, 0.36);
      backdrop-filter: blur(18px);
      min-width: 0;
    }
    .brand, .new-chat, .chat-item, .delete-chat, .copy-message, .composer button, .primary-button, .secondary-button, .danger-button { border: 0; }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #fff;
      background: rgba(255, 255, 255, 0.02);
      font-weight: 760;
      font-size: 18px;
      padding: 8px;
      border-radius: 16px;
      text-align: left;
      transition: background 180ms ease, transform 180ms ease;
    }
    .brand:hover, .brand:focus-visible {
      background: rgba(255, 255, 255, 0.06);
      outline: none;
      transform: translateY(-1px);
    }
    .brand img {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      object-fit: cover;
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18), 0 12px 28px rgba(0, 0, 0, 0.28);
    }
    .brand-copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .brand-name {
      font-size: 19px;
      line-height: 1;
      letter-spacing: 0;
    }
    .server-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      color: #bfdbfe;
      font-size: 12px;
      font-weight: 760;
      line-height: 1.25;
      white-space: nowrap;
    }
    .server-dot {
      position: relative;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.42);
      animation: serverPulseGreen 1.55s ease-out infinite;
      flex: 0 0 auto;
    }
    .server-status.offline .server-dot {
      background: #ef4444;
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.42);
      animation-name: serverPulseRed;
    }
    .server-status.online .server-status-label {
      color: #bbf7d0;
    }
    .server-status.offline .server-status-label {
      color: #fecaca;
    }
    .new-chat {
      height: 42px;
      border-radius: 12px;
      color: #07111f;
      background: linear-gradient(135deg, #dbeafe, #bbf7d0);
      font-weight: 740;
      box-shadow: 0 10px 30px rgba(14, 165, 233, 0.14);
      transition: transform 160ms ease, filter 160ms ease;
    }
    .new-chat:hover, .new-chat:focus-visible {
      transform: translateY(-1px);
      filter: brightness(1.04);
      outline: none;
    }
    .sidebar-search {
      width: 100%;
      height: 38px;
      border: 1px solid rgba(191, 219, 254, 0.16);
      border-radius: 10px;
      color: #f8fbff;
      background: rgba(5, 10, 20, 0.5);
      outline: none;
      padding: 0 12px;
    }
    .sidebar-search::placeholder {
      color: rgba(219, 234, 254, 0.48);
    }
    .sidebar-search:focus {
      border-color: rgba(45, 212, 191, 0.55);
      box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.12);
    }
    .chat-list {
      display: grid;
      gap: 4px;
      margin-top: 8px;
      overflow: auto;
      flex: 1 1 auto;
      min-height: 0;
      align-content: start;
      grid-auto-rows: max-content;
    }
    .sidebar-empty {
      padding: 12px;
      color: rgba(219, 234, 254, 0.62);
      font-size: 13px;
      line-height: 1.4;
    }
    .rate-card {
      --rate-color: #f8fbff;
      margin-top: auto;
      display: grid;
      gap: 10px;
      padding: 14px 12px;
      border: 1px solid rgba(191, 219, 254, 0.16);
      border-radius: 14px;
      background: rgba(5, 10, 20, 0.54);
      color: #dbeafe;
    }
    .rate-percent {
      color: var(--rate-color);
      font-size: 34px;
      line-height: 1;
      text-align: center;
      font-weight: 760;
      transition: color 140ms linear;
    }
    .rate-track {
      height: 28px;
      overflow: hidden;
      border: 2px solid rgba(2, 6, 23, 0.92);
      border-radius: 999px;
      background: rgba(219, 234, 254, 0.1);
    }
    .rate-track span {
      display: block;
      height: 100%;
      min-width: 0;
      border-radius: inherit;
      background: var(--rate-color);
      transition:
        width 120ms linear,
        background-color 140ms linear;
    }
    .rate-label {
      color: #bfdbfe;
      font-size: 12px;
      text-align: center;
      line-height: 1.35;
    }
    .chat-item-row {
      display: grid;
      grid-template-columns: 1fr 28px;
      align-items: center;
      width: 100%;
      min-height: 54px;
      border-radius: 10px;
      overflow: hidden;
      background: transparent;
    }
    .chat-item-row.active, .chat-item-row:hover, .chat-item-row:focus-within {
      background: rgba(219, 234, 254, 0.12);
    }
    .chat-item {
      min-width: 0;
      min-height: 54px;
      display: grid;
      align-content: center;
      gap: 3px;
      color: #dbeafe;
      background: transparent;
      text-align: left;
      padding: 0 8px 0 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-item span, .chat-item small {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-item span {
      font-weight: 760;
    }
    .chat-item small {
      color: rgba(219, 234, 254, 0.58);
      font-size: 11px;
      line-height: 1.2;
    }
    .chat-item-row.active .chat-item, .chat-item-row:hover .chat-item, .chat-item-row:focus-within .chat-item {
      color: #fff;
    }
    .delete-chat {
      width: 26px;
      height: 26px;
      margin-right: 4px;
      border-radius: 7px;
      color: #dbeafe;
      background: transparent;
      opacity: 0;
      transform: scale(0.92);
      transition: opacity 150ms ease, transform 150ms ease, background 150ms ease, color 150ms ease;
    }
    .chat-item-row:hover .delete-chat, .chat-item-row:focus-within .delete-chat {
      opacity: 1;
      transform: scale(1);
    }
    .delete-chat:hover, .delete-chat:focus-visible {
      color: #07111f;
      background: #dbeafe;
      outline: none;
    }
    .chat-page {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
      min-width: 0;
      overflow: hidden;
      padding: 24px 36px 28px;
    }
    .topbar {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      max-width: 980px;
      width: 100%;
      margin: 0 auto;
    }
    .topbar-title-row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .topbar h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .messages {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      gap: 18px;
      width: 100%;
      max-width: 980px;
      margin: 0 auto;
      padding: 44px 0 24px;
      overflow-y: auto;
      scrollbar-width: none;
    }
    .messages::-webkit-scrollbar, .chat-list::-webkit-scrollbar { width: 0; height: 0; }
    .message-row {
      display: flex;
      width: 100%;
      opacity: 1;
      transform: translateY(0);
      transition: opacity 520ms ease, filter 520ms ease;
    }
    .message-row.user { justify-content: flex-end; }
    .message-row.assistant { justify-content: flex-start; }
    .message-row.is-faded {
      filter: saturate(0.82);
    }
    .bubble {
      max-width: min(760px, 78%);
      white-space: pre-wrap;
      line-height: 1.45;
      border-radius: 20px;
      padding: 13px 17px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
    }
    .message-stack {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      max-width: min(760px, 78%);
    }
    .message-row.user .message-stack {
      align-items: flex-end;
    }
    .message-stack .bubble {
      max-width: 100%;
    }
    .message-controls {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 22px;
    }
    .copy-message {
      height: 22px;
      min-width: 48px;
      padding: 0 8px;
      border-radius: 7px;
      color: rgba(219, 234, 254, 0.68);
      background: rgba(7, 17, 31, 0.48);
      font-size: 12px;
      font-weight: 760;
      line-height: 1;
      opacity: 0;
      pointer-events: none;
      transform: translateY(3px);
      transition:
        opacity 180ms ease,
        color 150ms ease,
        background 150ms ease,
        transform 180ms ease;
    }
    .message-row:hover .copy-message,
    .message-row:focus-within .copy-message {
      opacity: 0.76;
      pointer-events: auto;
      transform: translateY(0);
    }
    .copy-message:hover, .copy-message:focus-visible {
      color: #07111f;
      background: #dbeafe;
      opacity: 1;
      outline: none;
      transform: translateY(-1px);
    }
    .thought-time {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 0 9px;
      color: rgba(219, 234, 254, 0.92);
      background: rgba(7, 17, 31, 0.44);
      border: 1px solid rgba(191, 219, 254, 0.12);
      font-size: 12px;
      font-weight: 760;
      animation: thoughtTimePulse 3s ease forwards;
    }
    @keyframes thoughtTimePulse {
      0% {
        opacity: 0;
        transform: translateY(2px);
      }
      18%, 72% {
        opacity: 1;
        transform: translateY(0);
      }
      100% {
        opacity: 0;
        transform: translateY(-2px);
      }
    }
    .thinking {
      transition: opacity 520ms ease, transform 520ms ease;
    }
    .bubble::selection {
      background: rgba(37, 99, 235, 0.28);
    }
    .message-row.user .bubble {
      color: #06111f;
      background: #fff;
      border: 1px solid rgba(219, 234, 254, 0.94);
    }
    .message-row.assistant .bubble {
      color: #06111f;
      background: linear-gradient(135deg, #e0f2fe, #b9ddff);
      border: 1px solid rgba(191, 219, 254, 0.94);
    }
    .fade-word {
      display: inline-block;
      opacity: 0;
      animation: wordReveal 420ms ease-out forwards;
    }
    @keyframes wordReveal {
      to {
        opacity: 1;
      }
    }
    .thinking {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      color: #d1d5db;
      background: rgba(12, 18, 30, 0.94);
      border: 1px solid rgba(148, 163, 184, 0.42);
      border-radius: 20px;
      padding: 11px 17px;
      font-weight: 700;
    }
    .thinking i {
      width: 7px;
      color: #c7cbd3;
      font-style: normal;
      animation: dotJump 760ms ease-in-out infinite;
    }
    .thinking i::before { content: "."; }
    .thinking i:nth-child(3) { animation-delay: 130ms; }
    .thinking i:nth-child(4) { animation-delay: 260ms; }
    @keyframes dotJump {
      0%, 100% { transform: translateY(0); opacity: 0.68; }
      45% { transform: translateY(-7px); opacity: 1; }
    }
    .composer-area {
      position: relative;
      z-index: 1;
      display: grid;
      gap: 8px;
      width: min(820px, 100%);
      margin: 0 auto;
    }
    .composer {
      display: grid;
      grid-template-columns: 1fr auto auto;
      align-items: end;
      gap: 10px;
      width: 100%;
      padding: 8px;
      border-radius: 28px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      background: rgba(5, 10, 20, 0.92);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
    }
    .composer-input-wrap {
      position: relative;
      min-height: 42px;
      max-height: 180px;
      overflow: hidden;
    }
    .composer-highlights {
      position: absolute;
      inset: 0;
      z-index: 0;
      min-height: 42px;
      max-height: 180px;
      overflow: hidden;
      padding: 10px 14px;
      color: #fff;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      line-height: 1.4;
      pointer-events: none;
    }
    .composer-highlights mark {
      border-radius: 5px;
      color: #fff;
      background: rgba(239, 68, 68, 0.7);
      box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
    }
    .composer textarea {
      position: relative;
      z-index: 1;
      width: 100%;
      min-height: 42px;
      max-height: 180px;
      border: 0;
      outline: 0;
      color: transparent;
      caret-color: #fff;
      background: transparent;
      padding: 10px 14px;
      resize: none;
      line-height: 1.4;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(219, 234, 254, 0.3) transparent;
    }
    .composer textarea::placeholder {
      color: rgba(219, 234, 254, 0.52);
    }
    .composer button {
      min-width: 76px;
      min-height: 42px;
      border-radius: 22px;
      color: #07111f;
      background: #bfdbfe;
      font-weight: 800;
      transition: background 160ms ease, transform 160ms ease;
    }
    .composer .voice-button {
      min-width: 52px;
      width: 52px;
      color: #dbeafe;
      background: rgba(148, 163, 184, 0.16);
      border: 1px solid rgba(191, 219, 254, 0.18);
      overflow: hidden;
    }
    .composer .voice-button.listening {
      color: #07111f;
      background: #a7f3d0;
      box-shadow: 0 0 0 6px rgba(167, 243, 208, 0.12);
      animation: micPulse 1.05s ease-in-out infinite;
    }
    .composer .voice-button:disabled {
      opacity: 0.48;
      cursor: not-allowed;
      transform: none;
    }
    .composer button:hover, .composer button:focus-visible {
      background: #a7f3d0;
      outline: none;
      transform: translateY(-1px);
    }
    @keyframes micPulse {
      0%, 100% {
        box-shadow: 0 0 0 4px rgba(167, 243, 208, 0.12);
      }
      50% {
        box-shadow: 0 0 0 9px rgba(167, 243, 208, 0.22);
      }
    }
    .composer-note {
      margin: 0;
      color: #93c5fd;
      font-size: 12px;
      text-align: center;
      line-height: 1.35;
      animation: composerNotePulse 2.8s ease-in-out infinite;
    }
    @keyframes composerNotePulse {
      0%, 100% {
        opacity: 0.56;
        text-shadow: 0 0 0 rgba(147, 197, 253, 0);
      }
      50% {
        opacity: 1;
        text-shadow: 0 0 18px rgba(147, 197, 253, 0.42);
      }
    }
    .warning-overlay {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.56);
      backdrop-filter: blur(10px);
      animation: warningFade 180ms ease-out both;
    }
    .warning-modal {
      width: min(440px, 100%);
      border-radius: 18px;
      border: 1px solid rgba(191, 219, 254, 0.28);
      background: linear-gradient(145deg, rgba(7, 20, 38, 0.96), rgba(2, 6, 23, 0.98));
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.48);
      padding: 26px;
      color: #f8fbff;
      text-align: center;
      animation: warningPop 220ms ease-out both;
    }
    .warning-modal h2 {
      margin: 0 0 10px;
      font-size: 28px;
      letter-spacing: 0;
    }
    .warning-modal p {
      margin: 0;
      color: #dbeafe;
      line-height: 1.5;
    }
    .compact-modal {
      width: min(380px, 100%);
    }
    .warning-understand {
      height: 44px;
      min-width: 160px;
      margin-top: 22px;
      border: 0;
      border-radius: 14px;
      color: #fff;
      background: #2563eb;
      font-weight: 800;
      animation: understandFlash 1.6s ease-in-out infinite;
    }
    .primary-button, .secondary-button, .danger-button {
      min-height: 38px;
      border-radius: 10px;
      padding: 0 14px;
      font-weight: 800;
    }
    .primary-button {
      color: #07111f;
      background: #bfdbfe;
    }
    .secondary-button {
      color: #dbeafe;
      background: rgba(191, 219, 254, 0.12);
      border: 1px solid rgba(191, 219, 254, 0.2);
    }
    .danger-button {
      color: #fff;
      background: #b91c1c;
    }
    .secondary-button:disabled, .danger-button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .toast {
      position: fixed;
      right: 26px;
      bottom: 26px;
      z-index: 80;
      max-width: min(360px, calc(100vw - 32px));
      min-height: 38px;
      display: grid;
      place-items: center;
      padding: 9px 14px;
      border: 1px solid rgba(191, 219, 254, 0.18);
      border-radius: 10px;
      color: #f8fbff;
      background: rgba(5, 10, 20, 0.92);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
      font-size: 13px;
      font-weight: 760;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    @keyframes warningFade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes warningPop {
      from { opacity: 0; transform: translateY(10px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes understandFlash {
      0%, 100% {
        background: #2563eb;
        box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.3);
      }
      50% {
        background: #60a5fa;
        box-shadow: 0 0 0 9px rgba(96, 165, 250, 0);
      }
    }
    @media (max-width: 860px) {
      html, body, #app {
        min-width: 320px;
      }
      .app-shell {
        grid-template-columns: 1fr;
        overflow: hidden;
      }
      .mobile-sidebar-scrim {
        position: fixed;
        inset: 0;
        z-index: 30;
        display: block;
        border: 0;
        background: rgba(2, 6, 23, 0.58);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
      }
      .mobile-sidebar-open .mobile-sidebar-scrim {
        opacity: 1;
        pointer-events: auto;
      }
      .sidebar {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 40;
        width: min(88vw, 336px);
        padding: 16px;
        border-right: 1px solid rgba(191, 219, 254, 0.18);
        border-radius: 0 18px 18px 0;
        background: rgba(3, 8, 18, 0.96);
        box-shadow: 24px 0 70px rgba(0, 0, 0, 0.46);
        transform: translateX(-104%);
        transition: transform 220ms ease;
        overflow: hidden;
      }
      .mobile-sidebar-open .sidebar {
        transform: translateX(0);
      }
      .brand,
      .chat-list,
      .sidebar-search,
      .rate-card {
        display: grid;
      }
      .brand {
        display: flex;
      }
      .sidebar-search {
        display: block;
      }
      .chat-list {
        overflow-y: auto;
      }
      .rate-card {
        margin-top: 0;
        padding: 12px;
      }
      .rate-percent {
        font-size: 28px;
      }
      .mobile-sidebar-toggle {
        display: inline-grid;
        place-items: center;
        gap: 5px;
        width: 42px;
        height: 42px;
        flex: 0 0 auto;
        border: 1px solid rgba(191, 219, 254, 0.2);
        border-radius: 12px;
        background: rgba(5, 10, 20, 0.72);
        box-shadow: 0 14px 38px rgba(0, 0, 0, 0.24);
      }
      .mobile-sidebar-toggle span {
        width: 18px;
        height: 2px;
        border-radius: 999px;
        background: #dbeafe;
      }
      .mobile-sidebar-toggle:hover,
      .mobile-sidebar-toggle:focus-visible {
        outline: none;
        background: rgba(191, 219, 254, 0.16);
      }
      .chat-page {
        height: 100dvh;
        padding: calc(12px + env(safe-area-inset-top)) 12px calc(14px + env(safe-area-inset-bottom));
      }
      .topbar {
        width: 100%;
        max-width: none;
        align-items: stretch;
        flex-direction: column;
        gap: 10px;
      }
      .topbar-title-row {
        width: 100%;
      }
      .topbar h1 {
        min-width: 0;
        font-size: 18px;
        line-height: 42px;
      }
      .topbar-actions {
        width: 100%;
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .topbar-actions .secondary-button {
        width: 100%;
        min-width: 0;
        padding: 0 10px;
        font-size: 13px;
      }
      .messages {
        max-width: none;
        gap: 14px;
        padding: 18px 0 14px;
      }
      .message-stack,
      .bubble {
        max-width: min(100%, 86vw);
      }
      .message-row.user .message-stack {
        align-items: flex-end;
      }
      .bubble {
        border-radius: 18px;
        padding: 12px 14px;
      }
      .composer-area {
        width: 100%;
        gap: 6px;
      }
      .composer {
        grid-template-columns: 1fr 46px 64px;
        gap: 7px;
        padding: 7px;
        border-radius: 22px;
      }
      .composer-input-wrap,
      .composer textarea,
      .composer-highlights {
        min-height: 40px;
      }
      .composer-highlights,
      .composer textarea {
        padding: 9px 10px;
        font-size: 15px;
      }
      .composer button {
        min-width: 0;
        min-height: 40px;
        border-radius: 18px;
        font-size: 13px;
      }
      .composer .voice-button {
        width: 46px;
        min-width: 46px;
        font-size: 12px;
      }
      .composer-note {
        font-size: 11px;
      }
      .toast {
        right: 12px;
        bottom: calc(82px + env(safe-area-inset-bottom));
        max-width: calc(100vw - 24px);
      }
    }
    @media (max-width: 430px) {
      .chat-page {
        padding-left: 10px;
        padding-right: 10px;
      }
      .topbar-actions {
        gap: 6px;
      }
      .composer {
        grid-template-columns: 1fr 42px 56px;
      }
      .composer .voice-button {
        width: 42px;
        min-width: 42px;
      }
      .composer button {
        font-size: 12px;
      }
    }
  `;
  document.head.appendChild(style);
}

bootstrap();



