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
      windowSeconds: 60,
    },
    rateMeter: {
      displayPercent: 100,
      targetPercent: 100,
    },
    serverOnline: false,
    aetherAvailable: true,
    signedIn: false,
    account: null,
    authModal: false,
    authMode: "signin",
    authLoading: false,
    authError: "",
    accountModal: false,
    accountLoading: false,
    accountError: "",
    adminView: false,
    adminSecret: "",
    adminStatus: null,
    adminLoading: false,
    adminError: "",
    blockedAttemptsExpanded: false,
  },
};

let messageVisibilityObserver = null;
let rateMeterTimer = null;
let rateLimitCountdownTimer = null;
let serverStatusTimer = null;
let voiceRecognition = null;
let voiceSilenceTimer = null;
let voiceBaseDraft = "";
let voiceFinalTranscript = "";
let voiceFinalResultIndexes = new Set();
let voiceTranscript = "";
let voiceAutoSending = false;
const thoughtTimerTimeouts = new Map();
const LOCATION_TIME_PERMISSION_MESSAGE = "Aether needs your permission to see your location to give your location.";
const PROFANITY_BLOCK_MESSAGE = "You cant send Aether a message with profanity in it. You can try again without profanity in your message.";
const VOICE_AUTO_SEND_DELAY_MS = 1800;
const ACCOUNT_SESSION_TOKEN_KEY = "aether.accountSessionToken";
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
    Aether.state.adminSecret = localStorage.getItem("aether.adminSecret") || "";

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
        ${renderAccountSidebarButton()}
        <button class="admin-tab ${Aether.state.adminView ? "active" : ""}" data-action="admin-tab">Admin</button>
        <input class="sidebar-search" data-action="sidebar-search" autocomplete="off" placeholder="Search conversations" value="${escapeHtml(Aether.state.sidebarSearch)}">
        <div class="chat-list">
          ${filteredChats().map(chatListItem).join("") || `<div class="sidebar-empty">No conversations found.</div>`}
        </div>
        ${renderRateLimitMeter()}
      </aside>

      ${Aether.state.adminView ? renderAdminPage() : renderChatPage(chat)}
      ${renderProfanityPopup()}
      ${renderRateLimitPopup()}
      ${renderAuthModal()}
      ${renderAccountModal()}
      ${renderToast()}
    </div>
  `;

  bindEvents(root);
  observeMessageVisibility();
  scrollChatToBottom();
}

function renderAccountSidebarButton() {
  if (Aether.state.signedIn && Aether.state.account) {
    return `
      <button class="account-tab signed-in" data-action="account-tab">
        <span class="account-avatar">${escapeHtml(accountInitials(Aether.state.account.username))}</span>
        <span class="account-tab-copy">
          <strong>${escapeHtml(Aether.state.account.username)}</strong>
          <small>Account</small>
        </span>
      </button>
    `;
  }
  return `<button class="account-tab" data-action="signin-tab">Sign in</button>`;
}

function renderChatPage(chat) {
  const unavailable = Aether.state.aetherAvailable === false;
  const composerPlaceholder = unavailable ? "Aether AI is currently unavailable" : "Send a message here.";
  const composerDisabled = unavailable || Aether.state.thinking;
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
          <button class="secondary-button" data-action="regenerate-last"${unavailable ? " disabled" : ""}>Resend last</button>
        </div>
      </header>
      <div class="messages" id="messages">
        ${chat.messages.map(renderMessage).join("")}
        ${Aether.state.thinking ? renderThinking() : ""}
      </div>
      <div class="composer-area">
        <form class="composer${unavailable ? " unavailable" : ""}" data-action="send-message">
          <div class="composer-input-wrap">
            <div class="composer-highlights" aria-hidden="true">${renderHighlightedComposerText(Aether.state.composerDraft)}</div>
            <textarea name="message" autocomplete="off" rows="1" placeholder="${escapeHtml(composerPlaceholder)}" spellcheck="true"${unavailable ? " disabled" : ""}>${escapeHtml(Aether.state.composerDraft)}</textarea>
          </div>
          <button class="voice-button ${Aether.state.voiceListening ? "listening" : ""}" type="button" data-action="voice-input" aria-label="${Aether.state.voiceListening ? "Stop voice input" : "Start voice input"}" aria-pressed="${Aether.state.voiceListening ? "true" : "false"}" title="${Aether.state.voiceListening ? "Stop voice input" : "Start voice input"}"${composerDisabled ? " disabled" : ""}>🎙️</button>
          <button type="submit"${composerDisabled ? " disabled" : ""}>Send</button>
        </form>
        <p class="composer-note">Aether can make mistakes. Double check important info.</p>
      </div>
    </main>
  `;
}

function renderAdminPage() {
  const status = Aether.state.adminStatus || {};
  const counts = status.requestCounts || { minute: 0, hour: 0, day: 0 };
  const database = status.database || {};
  const rate = status.rateLimit || Aether.state.rateLimit || {};
  const accounts = status.accounts || [];
  const available = status.aetherAvailable !== false;
  const locked = !Aether.state.adminSecret;

  return `
    <main class="chat-page admin-page">
      <div class="animated-bg" aria-hidden="true"></div>
      <header class="topbar">
        <div class="topbar-title-row">
          <button class="mobile-sidebar-toggle" type="button" data-action="toggle-mobile-sidebar" aria-label="${Aether.state.mobileSidebarOpen ? "Close sidebar" : "Open sidebar"}" aria-expanded="${Aether.state.mobileSidebarOpen ? "true" : "false"}">
            <span></span>
            <span></span>
          </button>
          <h1>Admin</h1>
        </div>
        <div class="topbar-actions">
          <button class="secondary-button" data-action="admin-refresh"${locked ? " disabled" : ""}>Refresh</button>
          <button class="secondary-button" data-action="admin-lock"${locked ? " disabled" : ""}>Lock Admin Portal</button>
        </div>
      </header>
      <div class="admin-scroll">
        ${locked ? renderAdminLogin() : `
          ${Aether.state.adminError ? `<div class="admin-alert">${escapeHtml(Aether.state.adminError)}</div>` : ""}
          <section class="admin-hero">
            <div>
              <span class="admin-kicker">${escapeHtml(database.provider || "database")} </span>
              <h2>${available ? "Aether is available" : "Aether is unavailable"}</h2>
              <p>You can disable or enable Aether globally, and rate-limit settings apply to each user separately.</p>
            </div>
            <label class="admin-switch">
              <input type="checkbox" data-action="admin-availability" ${available ? "checked" : ""}${Aether.state.adminLoading ? " disabled" : ""}>
              <span>${available ? "Available" : "Unavailable"}</span>
            </label>
          </section>
          <section class="admin-grid">
            <div class="admin-metric">
              <span>Last minute</span>
              <strong>${Number(counts.minute || 0)}</strong>
            </div>
            <div class="admin-metric">
              <span>Last hour</span>
              <strong>${Number(counts.hour || 0)}</strong>
            </div>
            <div class="admin-metric">
              <span>Last day</span>
              <strong>${Number(counts.day || 0)}</strong>
            </div>
          </section>
          <section class="admin-actions">
            <form class="admin-rate-form" data-action="admin-rate-limit">
              <label>
                <span>Messages</span>
                <input name="limit" type="number" min="1" max="100000" step="1" value="${escapeHtml(rate.limit || 300)}">
              </label>
              <label>
                <span>Seconds</span>
                <input name="windowSeconds" type="number" min="1" max="86400" step="1" value="${escapeHtml(rate.windowSeconds || 60)}">
              </label>
              <button class="primary-button" type="submit"${Aether.state.adminLoading ? " disabled" : ""}>Save rate limit</button>
            </form>
            <button class="danger-button" data-action="admin-reset-rate"${Aether.state.adminLoading ? " disabled" : ""}>Reset all user limits</button>
          </section>
          <section class="admin-two-column">
            ${renderBanIpPanel(status.bannedIps || [])}
            ${renderBlockedAttemptsPanel(status.blockedAttempts || [])}
          </section>
          ${renderAdminAccountsPanel(accounts)}
        `}
      </div>
    </main>
  `;
}

function renderAdminLogin() {
  return `
    <form class="admin-login" data-action="admin-login">
      <h2>Admin login</h2>
      <p>Please enter your password.</p>
      ${Aether.state.adminError ? `<div class="admin-alert">${escapeHtml(Aether.state.adminError)}</div>` : ""}
      <input name="adminSecret" autocomplete="current-password" type="password" placeholder="Enter your password here.">
      <button class="primary-button" type="submit"${Aether.state.adminLoading ? " disabled" : ""}>Unlock</button>
    </form>
  `;
}

function renderBanIpPanel(bannedIps) {
  return `
    <section class="admin-panel">
      <div class="admin-panel-head">
        <h2>Ban IPs</h2>
        <span>${bannedIps.length}</span>
      </div>
      <form class="admin-ban-form" data-action="admin-ban-ip">
        <input name="ipAddress" autocomplete="off" placeholder="IP address">
        <input name="reason" autocomplete="off" placeholder="Reason">
        <button class="primary-button" type="submit"${Aether.state.adminLoading ? " disabled" : ""}>Ban</button>
      </form>
      <div class="admin-list">
        ${bannedIps.map((item) => `
          <div class="admin-list-item">
            <div>
              <strong>${escapeHtml(item.ipAddress || "")}</strong>
              <small>${escapeHtml(item.reason || "No reason")} - ${escapeHtml(formatAdminDate(item.createdAt))}</small>
            </div>
            <button class="secondary-button" data-unban-ip="${escapeHtml(item.ipAddress || "")}">Unban</button>
          </div>
        `).join("") || `<div class="admin-empty">No banned IPs.</div>`}
      </div>
    </section>
  `;
}

function renderBlockedAttemptsPanel(attempts) {
  return `
    <section class="admin-panel">
      <div class="admin-panel-head">
        <h2>Blocked attempts</h2>
        <span>${attempts.length}${Aether.state.blockedAttemptsExpanded ? " shown" : " recent"}</span>
      </div>
      <div class="admin-list blocked-list">
        ${attempts.map((attempt) => `
          <div class="blocked-attempt">
            <div class="blocked-attempt-head">
              <strong>${escapeHtml(attempt.ipAddress || "")}</strong>
              <small>${escapeHtml(formatAdminDate(attempt.createdAt))}</small>
            </div>
            <p>${escapeHtml(attempt.message || "")}</p>
            <ol>
              ${(attempt.context || []).map((message) => `<li>${escapeHtml(message)}</li>`).join("")}
            </ol>
          </div>
        `).join("") || `<div class="admin-empty">No blocked attempts.</div>`}
      </div>
      <button class="secondary-button show-all-button" data-action="admin-show-all"${Aether.state.blockedAttemptsExpanded ? " disabled" : ""}>Show all</button>
    </section>
  `;
}

function renderAdminAccountsPanel(accounts) {
  return `
    <section class="admin-panel account-admin-panel">
      <div class="admin-panel-head">
        <h2>Accounts</h2>
        <span>${accounts.length}</span>
      </div>
      <div class="admin-list account-admin-list">
        ${accounts.map((account) => `
          <div class="admin-list-item account-admin-item">
            <div>
              <strong>${escapeHtml(account.username || "")}</strong>
              <small>Created ${escapeHtml(formatAdminDate(account.createdAt))} - Last login ${escapeHtml(formatAdminDate(account.lastLoginAt))}</small>
            </div>
            <button class="danger-button" data-admin-delete-account="${escapeHtml(account.id || "")}"${Aether.state.adminLoading ? " disabled" : ""}>Delete</button>
          </div>
        `).join("") || `<div class="admin-empty">No accounts yet.</div>`}
      </div>
    </section>
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
      <div class="rate-label">${remaining}/${limit} left - resets in ${escapeHtml(formatRateLimitDuration(resetInSeconds))}</div>
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
        <p>Wait ${escapeHtml(formatRateLimitDuration(rate.resetInSeconds || 0))} to use <strong>Aether</strong> AI again.</p>
        <button class="warning-understand" data-action="close-rate-limit">Okay.</button>
      </div>
    </div>
  `;
}

function renderAuthModal() {
  if (!Aether.state.authModal) return "";
  const creating = Aether.state.authMode === "create";
  return `
    <div class="account-overlay" role="dialog" aria-modal="true" aria-labelledby="auth-title" data-action="close-auth-modal">
      <form class="auth-card" data-action="auth-submit">
        <button class="modal-close" type="button" data-action="close-auth-modal" aria-label="Close">×</button>
        <div class="auth-card-head">
          <span class="auth-badge">${creating ? "New account" : "Welcome back"}</span>
          <h2 id="auth-title">${creating ? "Create Account" : "Sign In"}</h2>
        </div>
        <div class="auth-mode-switch" role="tablist" aria-label="Account mode">
          <button type="button" class="${!creating ? "active" : ""}" data-auth-mode="signin">Sign in</button>
          <button type="button" class="${creating ? "active" : ""}" data-auth-mode="create">Create account</button>
        </div>
        ${Aether.state.authError ? `<div class="form-alert">${escapeHtml(Aether.state.authError)}</div>` : ""}
        <label>
          <span>Username</span>
          <input name="username" autocomplete="username" minlength="3" maxlength="24" required placeholder="adam">
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="${creating ? "new-password" : "current-password"}" minlength="8" maxlength="128" required placeholder="At least 8 characters">
        </label>
        <button class="primary-button" type="submit"${Aether.state.authLoading ? " disabled" : ""}>${creating ? "Create account" : "Sign in"}</button>
      </form>
    </div>
  `;
}

function renderAccountModal() {
  if (!Aether.state.accountModal || !Aether.state.signedIn || !Aether.state.account) return "";
  const account = Aether.state.account;
  return `
    <div class="account-overlay" role="dialog" aria-modal="true" aria-labelledby="account-title" data-action="close-account-modal">
      <div class="account-card">
        <button class="modal-close" type="button" data-action="close-account-modal" aria-label="Close">×</button>
        <div class="account-card-head">
          <div class="account-avatar large">${escapeHtml(accountInitials(account.username))}</div>
          <div>
            <span class="auth-badge">Signed in</span>
            <h2 id="account-title">${escapeHtml(account.username)}</h2>
            <p>Created ${escapeHtml(formatAdminDate(account.createdAt))}</p>
          </div>
        </div>
        ${Aether.state.accountError ? `<div class="form-alert">${escapeHtml(Aether.state.accountError)}</div>` : ""}
        <form class="account-form" data-action="account-username">
          <label>
            <span>Change username</span>
            <input name="username" autocomplete="username" minlength="3" maxlength="24" required value="${escapeHtml(account.username)}">
          </label>
          <button class="secondary-button" type="submit"${Aether.state.accountLoading ? " disabled" : ""}>Save username</button>
        </form>
        <form class="account-form" data-action="account-password">
          <label>
            <span>Current password</span>
            <input name="currentPassword" type="password" autocomplete="current-password" required>
          </label>
          <label>
            <span>New password</span>
            <input name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
          </label>
          <button class="secondary-button" type="submit"${Aether.state.accountLoading ? " disabled" : ""}>Change password</button>
        </form>
        <div class="account-danger">
          <button class="secondary-button" type="button" data-action="account-signout"${Aether.state.accountLoading ? " disabled" : ""}>Sign out</button>
          <form class="account-form" data-action="account-delete">
            <label>
              <span>Delete account</span>
              <input name="password" type="password" autocomplete="current-password" required placeholder="Confirm password">
            </label>
            <button class="danger-button" type="submit"${Aether.state.accountLoading ? " disabled" : ""}>Delete</button>
          </form>
        </div>
      </div>
    </div>
  `;
}

function bindEvents(root) {
  root.querySelector("[data-action='home']")?.addEventListener("click", () => {
    Aether.state.adminView = false;
    Aether.state.mobileSidebarOpen = false;
    render();
  });

  root.querySelector("[data-action='new-chat']")?.addEventListener("click", () => {
    Aether.state.adminView = false;
    Aether.state.mobileSidebarOpen = false;
    createNewChat();
  });
  root.querySelector("[data-action='signin-tab']")?.addEventListener("click", () => {
    Aether.state.authMode = "signin";
    Aether.state.authModal = true;
    Aether.state.authError = "";
    Aether.state.mobileSidebarOpen = false;
    render();
  });
  root.querySelector("[data-action='account-tab']")?.addEventListener("click", () => {
    Aether.state.accountModal = true;
    Aether.state.accountError = "";
    Aether.state.mobileSidebarOpen = false;
    render();
  });
  root.querySelector("[data-action='admin-tab']")?.addEventListener("click", () => {
    Aether.state.adminView = true;
    Aether.state.mobileSidebarOpen = false;
    render();
    loadAdminStatus();
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
  bindAccountEvents(root);
  bindAdminEvents(root);
}

function bindAccountEvents(root) {
  root.querySelectorAll("[data-action='close-auth-modal']").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (element.classList.contains("account-overlay") && event.target !== element) return;
      Aether.state.authModal = false;
      Aether.state.authError = "";
      render();
    });
  });
  root.querySelectorAll("[data-action='close-account-modal']").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (element.classList.contains("account-overlay") && event.target !== element) return;
      Aether.state.accountModal = false;
      Aether.state.accountError = "";
      render();
    });
  });
  root.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      Aether.state.authMode = button.dataset.authMode || "signin";
      Aether.state.authError = "";
      render();
    });
  });
  root.querySelector("[data-action='auth-submit']")?.addEventListener("submit", submitAuthForm);
  root.querySelector("[data-action='account-username']")?.addEventListener("submit", submitUsernameChange);
  root.querySelector("[data-action='account-password']")?.addEventListener("submit", submitPasswordChange);
  root.querySelector("[data-action='account-delete']")?.addEventListener("submit", submitAccountDelete);
  root.querySelector("[data-action='account-signout']")?.addEventListener("click", signOutAccount);
}

async function submitAuthForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  const password = String(data.get("password") || "");
  const path = Aether.state.authMode === "create" ? "/api/account/create" : "/api/account/signin";

  Aether.state.authLoading = true;
  Aether.state.authError = "";
  render();
  try {
    const result = await accountRequest(path, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    applyAccountStatus(result);
    Aether.state.authModal = false;
    showToast(result.message || (Aether.state.authMode === "create" ? "Account created." : "Signed in."));
  } catch (error) {
    Aether.state.authError = error?.message || "Account request failed.";
  } finally {
    Aether.state.authLoading = false;
    render();
  }
}

async function submitUsernameChange(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  await runAccountAction(
    "/api/account/username",
    { username: String(data.get("username") || "").trim() },
    "Username updated.",
  );
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const success = await runAccountAction(
    "/api/account/password",
    {
      currentPassword: String(data.get("currentPassword") || ""),
      newPassword: String(data.get("newPassword") || ""),
    },
    "Password updated.",
  );
  if (success) form.reset();
}

async function submitAccountDelete(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  Aether.state.accountLoading = true;
  Aether.state.accountError = "";
  render();
  try {
    const result = await accountRequest("/api/account", {
      method: "DELETE",
      body: JSON.stringify({ password: String(data.get("password") || "") }),
    });
    applyAccountStatus(result);
    Aether.state.accountModal = false;
    showToast("Account deleted.");
  } catch (error) {
    Aether.state.accountError = error?.message || "Account could not be deleted.";
  } finally {
    Aether.state.accountLoading = false;
    render();
  }
}

async function signOutAccount() {
  Aether.state.accountLoading = true;
  Aether.state.accountError = "";
  render();
  try {
    const result = await accountRequest("/api/account/signout", { method: "POST" });
    applyAccountStatus(result);
    Aether.state.accountModal = false;
    showToast("Signed out.");
  } catch (error) {
    Aether.state.accountError = error?.message || "Sign out failed.";
  } finally {
    Aether.state.accountLoading = false;
    render();
  }
}

async function runAccountAction(path, payload, successMessage) {
  Aether.state.accountLoading = true;
  Aether.state.accountError = "";
  render();
  try {
    const result = await accountRequest(path, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    applyAccountStatus(result);
    showToast(result.message || successMessage);
    return true;
  } catch (error) {
    Aether.state.accountError = error?.message || "Account update failed.";
    return false;
  } finally {
    Aether.state.accountLoading = false;
    render();
  }
}

function bindChatListEvents(root) {
  root.querySelectorAll("[data-chat-id]").forEach((button) => {
    button.addEventListener("click", () => {
      Aether.state.activeChatId = button.dataset.chatId;
      Aether.state.adminView = false;
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

function bindAdminEvents(root) {
  root.querySelector("[data-action='admin-login']")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = String(new FormData(form).get("adminSecret") || "").trim();
    if (!secret) {
      Aether.state.adminError = "Enter the admin secret first.";
      render();
      return;
    }
    Aether.state.adminSecret = secret;
    localStorage.setItem("aether.adminSecret", secret);
    await loadAdminStatus();
  });

  root.querySelector("[data-action='admin-refresh']")?.addEventListener("click", () => loadAdminStatus());
  root.querySelector("[data-action='admin-lock']")?.addEventListener("click", () => {
    Aether.state.adminSecret = "";
    Aether.state.adminStatus = null;
    Aether.state.adminError = "";
    localStorage.removeItem("aether.adminSecret");
    render();
  });
  root.querySelector("[data-action='admin-availability']")?.addEventListener("change", async (event) => {
    await adminRequest("/api/admin/availability", {
      method: "POST",
      body: JSON.stringify({ available: Boolean(event.currentTarget.checked) }),
    });
  });
  root.querySelector("[data-action='admin-reset-rate']")?.addEventListener("click", async () => {
    await adminRequest("/api/admin/reset-rate-limit", { method: "POST" });
  });
  root.querySelector("[data-action='admin-rate-limit']")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await adminRequest("/api/admin/rate-limit", {
      method: "POST",
      body: JSON.stringify({
        limit: Number(data.get("limit") || 300),
        windowSeconds: Number(data.get("windowSeconds") || 60),
      }),
    });
    if (saved) showToast("Rate limit updated.");
  });
  root.querySelector("[data-action='admin-ban-ip']")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await adminRequest("/api/admin/ban-ip", {
      method: "POST",
      body: JSON.stringify({
        ipAddress: String(data.get("ipAddress") || "").trim(),
        reason: String(data.get("reason") || "").trim(),
      }),
    });
    form.reset();
  });
  root.querySelectorAll("[data-unban-ip]").forEach((button) => {
    button.addEventListener("click", async () => {
      await adminRequest("/api/admin/unban-ip", {
        method: "POST",
        body: JSON.stringify({ ipAddress: button.dataset.unbanIp || "" }),
      });
    });
  });
  root.querySelectorAll("[data-admin-delete-account]").forEach((button) => {
    button.addEventListener("click", async () => {
      const accountId = button.dataset.adminDeleteAccount || "";
      if (!accountId) return;
      const deleted = await adminRequest("/api/admin/delete-account", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      });
      if (deleted) showToast("Account deleted.");
    });
  });
  root.querySelector("[data-action='admin-show-all']")?.addEventListener("click", () => {
    Aether.state.blockedAttemptsExpanded = true;
    loadAdminStatus({ all: true });
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
  Aether.state.adminView = false;
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
  if (!isAetherAvailable()) return;
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
  if (!isAetherAvailable()) return;
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
  if (!isAetherAvailable()) return;
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
  voiceFinalTranscript = "";
  voiceFinalResultIndexes = new Set();
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
  let interimTranscript = "";
  for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const phrase = String(result[0]?.transcript || "").trim();
    if (!phrase) continue;
    if (result.isFinal) {
      if (voiceFinalResultIndexes.has(index)) continue;
      voiceFinalResultIndexes.add(index);
      voiceFinalTranscript = joinVoiceText(voiceFinalTranscript, phrase);
    } else {
      interimTranscript = joinVoiceText(interimTranscript, phrase);
    }
  }
  voiceTranscript = joinVoiceText(voiceFinalTranscript, interimTranscript);
  applyVoiceTranscript();
  scheduleVoiceAutoSend();
}

function joinVoiceText(...parts) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" ");
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
  voiceFinalTranscript = "";
  voiceFinalResultIndexes = new Set();
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
        if (data.aetherUnavailable) {
          applyServerStatus({ ...data, aetherAvailable: false });
          return "";
        }
        if (data.reply) return data.reply;
        return "";
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

function isAetherAvailable() {
  return Aether.state.aetherAvailable !== false;
}

function applyServerStatus(data) {
  if (Object.prototype.hasOwnProperty.call(data, "aetherAvailable")) {
    setAetherAvailability(data.aetherAvailable !== false);
  }
  if (Object.prototype.hasOwnProperty.call(data, "signedIn")) {
    applyAccountStatus(data);
  }
  if (data.rateLimit) {
    updateRateLimit(data.rateLimit);
  }
}

function applyAccountStatus(data) {
  if (data?.sessionToken) {
    setAccountSessionToken(data.sessionToken);
  } else if (data?.signedIn === false) {
    setAccountSessionToken("");
  }
  Aether.state.signedIn = Boolean(data?.signedIn && data?.account);
  Aether.state.account = Aether.state.signedIn ? data.account : null;
  if (!Aether.state.signedIn) {
    Aether.state.accountModal = false;
  }
}

function accountSessionToken() {
  try {
    return localStorage.getItem(ACCOUNT_SESSION_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function setAccountSessionToken(token) {
  try {
    if (token) {
      localStorage.setItem(ACCOUNT_SESSION_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(ACCOUNT_SESSION_TOKEN_KEY);
    }
  } catch {
    // Browsers can block localStorage in hardened modes; cookies still work for same-origin installs.
  }
}

function setAetherAvailability(available) {
  const nextAvailable = available !== false;
  const changed = Aether.state.aetherAvailable !== nextAvailable;
  Aether.state.aetherAvailable = nextAvailable;
  if (!nextAvailable) {
    stopVoiceInput({ keepDraft: true, silent: true });
  }
  if (changed && !Aether.state.adminView) {
    render();
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
  serverStatusTimer = setInterval(pingServerStatus, 2000);
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
  rate.resetInSeconds = Math.max(1, Number(rate.windowSeconds || 60));
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
  if (labelElement) labelElement.textContent = `${remaining}/${limit} left - resets in ${formatRateLimitDuration(resetInSeconds)}`;
}

function ratePercent(rate) {
  const limit = Math.max(1, Number(rate?.limit || 300));
  const remaining = Math.max(0, Math.min(limit, Number(rate?.remaining ?? limit)));
  return Math.round((remaining / limit) * 100);
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function formatRateLimitDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  if (totalSeconds <= 0) return "now";

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (days > 0) {
    const parts = [`${days} ${days === 1 ? "day" : "days"}`];
    if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hr" : "hrs"}`);
    if (minutes > 0 && parts.length < 3) parts.push(`${minutes} ${minutes === 1 ? "min" : "mins"}`);
    return parts.join(" ");
  }

  if (hours > 0) {
    const parts = [`${hours} ${hours === 1 ? "hr" : "hrs"}`];
    if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "min" : "mins"}`);
    return parts.join(" ");
  }

  if (minutes > 0) {
    const minuteLabel = `${minutes} ${minutes === 1 ? "min" : "minutes"}`;
    if (remainingSeconds > 0) {
      return `${minuteLabel} and ${remainingSeconds} ${remainingSeconds === 1 ? "second" : "seconds"}`;
    }
    return minuteLabel;
  }

  return `${totalSeconds} ${totalSeconds === 1 ? "second" : "seconds"}`;
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
    const response = await fetch(apiUrl("/api/status"), {
      headers: await authHeaders(),
      cache: "no-store",
    });
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
  const token = accountSessionToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : { ...base };
}

async function accountRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: await authHeaders({
      "Content-Type": "application/json;charset=UTF-8",
      ...(options.headers || {}),
    }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Account request failed with HTTP ${response.status}`);
  }
  return data;
}

async function adminHeaders(base = {}) {
  return {
    ...base,
    "X-Aether-Admin-Secret": Aether.state.adminSecret || "",
  };
}

async function loadAdminStatus(options = {}) {
  if (!Aether.state.adminSecret) return;
  Aether.state.adminLoading = true;
  Aether.state.adminError = "";
  if (Aether.state.adminView) render();
  try {
    const all = options.all || Aether.state.blockedAttemptsExpanded;
    const response = await fetch(apiUrl(`/api/admin/status${all ? "?all=1" : ""}`), {
      headers: await adminHeaders(),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Admin request failed with HTTP ${response.status}`);
    }
    Aether.state.adminStatus = data;
    if (Object.prototype.hasOwnProperty.call(data, "aetherAvailable")) {
      setAetherAvailability(data.aetherAvailable !== false);
    }
    if (data.rateLimit) updateRateLimit(data.rateLimit);
    Aether.state.adminError = "";
  } catch (error) {
    Aether.state.adminError = error?.message || "Admin request failed.";
  } finally {
    Aether.state.adminLoading = false;
    if (Aether.state.adminView) render();
  }
}

async function adminRequest(path, options = {}) {
  if (!Aether.state.adminSecret) {
    Aether.state.adminError = "Enter the admin secret first.";
    render();
    return null;
  }
  Aether.state.adminLoading = true;
  Aether.state.adminError = "";
  render();
  try {
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: await adminHeaders({ "Content-Type": "application/json;charset=UTF-8", ...(options.headers || {}) }),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Admin request failed with HTTP ${response.status}`);
    }
    Aether.state.adminStatus = data;
    if (Object.prototype.hasOwnProperty.call(data, "aetherAvailable")) {
      setAetherAvailability(data.aetherAvailable !== false);
    }
    if (data.rateLimit) updateRateLimit(data.rateLimit);
    Aether.state.adminError = "";
    return data;
  } catch (error) {
    Aether.state.adminError = error?.message || "Admin request failed.";
    return null;
  } finally {
    Aether.state.adminLoading = false;
    render();
  }
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
  return /\b(?:what\s+time\s+is\s+it|what['\u2019]?s\s+the\s+time)\b/i.test(text);
}

function browserTimeReply() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "your local timezone";
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `It is ${time} in ${timezone}.`;
}

function formatAdminDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function accountInitials(username) {
  const cleaned = String(username || "A").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return cleaned.slice(0, 2) || "A";
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
    .brand, .new-chat, .account-tab, .admin-tab, .chat-item, .delete-chat, .copy-message, .composer button, .primary-button, .secondary-button, .danger-button, .modal-close, .auth-mode-switch button { border: 0; }
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
    .account-tab,
    .admin-tab {
      display: grid;
      place-items: center;
      height: 38px;
      border-radius: 10px;
      color: #dbeafe;
      background: rgba(191, 219, 254, 0.1);
      font-weight: 780;
      transition: background 160ms ease, color 160ms ease, transform 160ms ease;
    }
    .account-tab.signed-in {
      grid-template-columns: auto minmax(0, 1fr);
      place-items: center stretch;
      gap: 10px;
      height: auto;
      min-height: 48px;
      padding: 8px 10px;
      text-align: left;
    }
    .account-avatar {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      color: #07111f;
      background: linear-gradient(135deg, #bfdbfe, #a7f3d0);
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 0;
    }
    .account-avatar.large {
      width: 54px;
      height: 54px;
      font-size: 18px;
      flex: 0 0 auto;
    }
    .account-tab-copy {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .account-tab-copy strong,
    .account-tab-copy small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .account-tab-copy small {
      color: #93c5fd;
      font-size: 11px;
      font-weight: 760;
    }
    .account-tab:hover, .account-tab:focus-visible, .admin-tab:hover, .admin-tab:focus-visible, .admin-tab.active {
      color: #07111f;
      background: #a7f3d0;
      outline: none;
      transform: translateY(-1px);
    }
    .account-tab:hover .account-tab-copy small,
    .account-tab:focus-visible .account-tab-copy small {
      color: #0f172a;
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
    .admin-page {
      grid-template-rows: auto 1fr;
    }
    .admin-scroll {
      position: relative;
      z-index: 1;
      width: min(1060px, 100%);
      margin: 0 auto;
      padding: 28px 0 8px;
      overflow-y: auto;
      scrollbar-width: none;
      display: grid;
      gap: 18px;
      align-content: start;
    }
    .admin-scroll::-webkit-scrollbar { width: 0; height: 0; }
    .admin-hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 22px;
      border: 1px solid rgba(191, 219, 254, 0.16);
      border-radius: 8px;
      background: rgba(5, 10, 20, 0.66);
    }
    .admin-kicker {
      display: inline-flex;
      margin-bottom: 8px;
      color: #a7f3d0;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .admin-hero h2,
    .admin-login h2,
    .admin-panel h2 {
      margin: 0;
      letter-spacing: 0;
    }
    .admin-hero h2 {
      font-size: 26px;
    }
    .admin-hero p,
    .admin-login p {
      margin: 8px 0 0;
      max-width: 620px;
      color: #bfdbfe;
      line-height: 1.45;
    }
    .admin-switch {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      padding: 0 14px;
      border-radius: 999px;
      color: #07111f;
      background: #dbeafe;
      font-weight: 820;
      white-space: nowrap;
      cursor: pointer;
    }
    .admin-switch input {
      width: 18px;
      height: 18px;
      accent-color: #16a34a;
    }
    .admin-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .admin-metric {
      display: grid;
      gap: 8px;
      padding: 18px;
      border: 1px solid rgba(191, 219, 254, 0.16);
      border-radius: 8px;
      background: rgba(5, 10, 20, 0.56);
    }
    .admin-metric span {
      color: #bfdbfe;
      font-size: 13px;
      font-weight: 760;
    }
    .admin-metric strong {
      font-size: 34px;
      line-height: 1;
    }
    .admin-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 10px;
      justify-content: flex-start;
    }
    .admin-two-column {
      display: grid;
      grid-template-columns: minmax(280px, 0.84fr) minmax(320px, 1.16fr);
      gap: 14px;
      align-items: start;
    }
    .admin-panel,
    .admin-login {
      display: grid;
      gap: 14px;
      padding: 20px;
      border: 1px solid rgba(191, 219, 254, 0.16);
      border-radius: 8px;
      background: rgba(5, 10, 20, 0.62);
    }
    .admin-login {
      width: min(520px, 100%);
      margin: 48px auto 0;
    }
    .admin-panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .admin-panel-head span {
      color: #a7f3d0;
      font-size: 12px;
      font-weight: 820;
    }
    .admin-ban-form,
    .admin-rate-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
      gap: 8px;
    }
    .admin-rate-form {
      width: min(560px, 100%);
      align-items: end;
    }
    .admin-rate-form label {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .admin-rate-form label span {
      color: #bfdbfe;
      font-size: 12px;
      font-weight: 780;
    }
    .admin-login input,
    .admin-ban-form input,
    .admin-rate-form input,
    .auth-card input,
    .account-form input {
      width: 100%;
      min-height: 40px;
      border: 1px solid rgba(191, 219, 254, 0.18);
      border-radius: 10px;
      color: #f8fbff;
      background: rgba(2, 6, 23, 0.54);
      outline: none;
      padding: 0 12px;
    }
    .admin-login input:focus,
    .admin-ban-form input:focus,
    .admin-rate-form input:focus,
    .auth-card input:focus,
    .account-form input:focus {
      border-color: rgba(45, 212, 191, 0.56);
      box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.12);
    }
    .admin-list {
      display: grid;
      gap: 10px;
      max-height: min(54vh, 520px);
      overflow-y: auto;
      padding-right: 4px;
      scrollbar-width: thin;
      scrollbar-color: rgba(219, 234, 254, 0.26) transparent;
    }
    .admin-list-item,
    .blocked-attempt {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid rgba(191, 219, 254, 0.12);
      background: rgba(2, 6, 23, 0.44);
    }
    .admin-list-item {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
    }
    .admin-list-item strong,
    .blocked-attempt strong {
      display: block;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .admin-list-item small,
    .blocked-attempt small {
      display: block;
      margin-top: 3px;
      color: #bfdbfe;
      line-height: 1.35;
    }
    .blocked-attempt-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .blocked-attempt p {
      margin: 0;
      color: #fecaca;
      overflow-wrap: anywhere;
      line-height: 1.4;
    }
    .blocked-attempt ol {
      margin: 0;
      padding-left: 20px;
      color: #dbeafe;
      line-height: 1.35;
    }
    .blocked-attempt li {
      overflow-wrap: anywhere;
      margin-top: 4px;
    }
    .admin-empty {
      padding: 12px;
      color: #bfdbfe;
      border: 1px dashed rgba(191, 219, 254, 0.18);
      border-radius: 8px;
      text-align: center;
    }
    .admin-alert {
      padding: 12px;
      border-radius: 8px;
      color: #fecaca;
      background: rgba(127, 29, 29, 0.26);
      border: 1px solid rgba(248, 113, 113, 0.26);
    }
    .show-all-button {
      justify-self: start;
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
    .composer.unavailable {
      border-color: rgba(148, 163, 184, 0.22);
      background: rgba(15, 23, 42, 0.72);
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
    .composer textarea:disabled {
      cursor: not-allowed;
      opacity: 1;
      caret-color: transparent;
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
    .composer button:disabled {
      opacity: 0.48;
      cursor: not-allowed;
      transform: none;
    }
    .composer button:hover, .composer button:focus-visible {
      background: #a7f3d0;
      outline: none;
      transform: translateY(-1px);
    }
    .composer button:disabled:hover,
    .composer button:disabled:focus-visible {
      background: #bfdbfe;
      outline: none;
      transform: none;
    }
    .composer .voice-button:disabled:hover,
    .composer .voice-button:disabled:focus-visible {
      background: rgba(148, 163, 184, 0.16);
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
    .account-overlay {
      position: fixed;
      inset: 0;
      z-index: 70;
      display: grid;
      place-items: center;
      padding: 22px;
      background: rgba(2, 6, 23, 0.72);
      backdrop-filter: blur(18px);
      animation: warningFade 180ms ease-out both;
    }
    .auth-card,
    .account-card {
      position: relative;
      width: min(460px, 100%);
      display: grid;
      gap: 14px;
      padding: 22px;
      border: 1px solid rgba(191, 219, 254, 0.18);
      border-radius: 12px;
      background:
        linear-gradient(160deg, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 0.96)),
        radial-gradient(circle at 18% 0%, rgba(45, 212, 191, 0.16), transparent 32%);
      box-shadow: 0 28px 90px rgba(0, 0, 0, 0.5);
      animation: warningPop 220ms ease-out both;
    }
    .account-card {
      width: min(620px, 100%);
      max-height: min(760px, calc(100dvh - 34px));
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(219, 234, 254, 0.26) transparent;
    }
    .modal-close {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 34px;
      height: 34px;
      border-radius: 10px;
      color: #dbeafe;
      background: rgba(191, 219, 254, 0.1);
      font-size: 22px;
      line-height: 1;
    }
    .modal-close:hover,
    .modal-close:focus-visible {
      outline: none;
      background: rgba(191, 219, 254, 0.18);
    }
    .auth-card-head,
    .account-card-head {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-right: 38px;
    }
    .auth-card-head {
      display: grid;
      gap: 8px;
    }
    .auth-badge {
      width: max-content;
      padding: 5px 9px;
      border-radius: 999px;
      color: #07111f;
      background: #a7f3d0;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .auth-card h2,
    .account-card h2 {
      margin: 0;
      font-size: 28px;
      line-height: 1.05;
      letter-spacing: 0;
    }
    .account-card p {
      margin: 4px 0 0;
      color: #93c5fd;
      font-size: 13px;
      font-weight: 720;
    }
    .auth-mode-switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 5px;
      border: 1px solid rgba(191, 219, 254, 0.14);
      border-radius: 12px;
      background: rgba(2, 6, 23, 0.5);
    }
    .auth-mode-switch button {
      min-height: 36px;
      border-radius: 9px;
      color: #bfdbfe;
      background: transparent;
      font-weight: 850;
    }
    .auth-mode-switch button.active {
      color: #07111f;
      background: #bfdbfe;
    }
    .auth-card label,
    .account-form label {
      display: grid;
      gap: 6px;
      color: #bfdbfe;
      font-size: 12px;
      font-weight: 820;
    }
    .form-alert {
      padding: 10px 12px;
      border: 1px solid rgba(248, 113, 113, 0.3);
      border-radius: 10px;
      color: #fecaca;
      background: rgba(127, 29, 29, 0.24);
      font-size: 13px;
      font-weight: 760;
    }
    .account-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 10px;
      padding: 14px;
      border: 1px solid rgba(191, 219, 254, 0.12);
      border-radius: 10px;
      background: rgba(2, 6, 23, 0.34);
    }
    .account-form:has(label + label) {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    }
    .account-danger {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: stretch;
    }
    .account-admin-panel {
      margin-top: 14px;
    }
    .account-admin-item .danger-button {
      align-self: center;
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
    .primary-button:disabled, .secondary-button:disabled, .danger-button:disabled {
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
      .account-tab,
      .admin-tab,
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
      .admin-page {
        height: 100dvh;
      }
      .admin-scroll {
        width: 100%;
        max-width: none;
        padding: 18px 0 10px;
      }
      .admin-hero,
      .admin-two-column,
      .admin-grid,
      .admin-ban-form,
      .admin-rate-form,
      .account-form,
      .account-form:has(label + label),
      .account-danger {
        grid-template-columns: 1fr;
      }
      .admin-hero {
        display: grid;
        padding: 16px;
      }
      .admin-hero h2 {
        font-size: 22px;
      }
      .admin-switch {
        justify-self: start;
      }
      .admin-two-column {
        gap: 12px;
      }
      .admin-panel,
      .admin-login {
        padding: 16px;
      }
      .admin-login {
        margin-top: 20px;
      }
      .admin-list {
        max-height: none;
      }
      .blocked-attempt-head,
      .admin-list-item {
        grid-template-columns: 1fr;
      }
      .blocked-attempt-head {
        display: grid;
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



