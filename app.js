const Aether = {
  config: {
    appName: "Aether",
    apiEndpoint: defaultApiEndpoint(),
    speedMode: "default",
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
      resetAt: "",
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
    accountChatsSyncedFor: "",
    accountChatsLoading: false,
    adminView: false,
    adminStatus: null,
    adminLoading: false,
    adminError: "",
    blockedAttemptsExpanded: false,
    banStatus: null,
    speedMenuOpen: false,
  },
};

let messageVisibilityObserver = null;
let rateMeterTimer = null;
let rateLimitCountdownTimer = null;
let serverStatusTimer = null;
let accountChatsSaveTimer = null;
let accountChatsSaving = false;
let accountChatsSaveQueued = false;
let voiceRecognition = null;
let voiceSilenceTimer = null;
let voiceBaseDraft = "";
let voiceFinalTranscript = "";
let voiceFinalResultIndexes = new Set();
let voiceTranscript = "";
let voiceAutoSending = false;
const LOCATION_TIME_PERMISSION_MESSAGE = "Aether needs your permission to see your location to give your location.";
const PROFANITY_BLOCK_MESSAGE = "You cant send Aether a message with profanity in it. You can try again without profanity in your message.";
const SAFETY_LOCK_PLACEHOLDER = "Aether can not continue this conversation. Create a new conversation to keep using Aether.";
const BAN_POPUP_BODY = "You can not use Aether AI because you were banned by an admin.";
const VOICE_AUTO_SEND_DELAY_MS = 1800;
const SAFETY_LOCK_DELAY_MS = 3000;
const ACCOUNT_SESSION_TOKEN_KEY = "aether.accountSessionToken";
const MOBILE_SCROLL_FADE_QUERY = "(max-width: 860px), (pointer: coarse)";
const MAX_PROFILE_PICTURE_FILE_SIZE = 560000;
const ACCOUNT_CHATS_SAVE_DELAY_MS = 700;
const DEFAULT_ASSISTANT_GREETING = "Hi there! I'm Aether. What's on your mind?";
const SPEED_MODES = {
  default: {
    label: "Default",
    title: "Standard",
    detail: "Higher reasoning, less usage",
  },
  fast: {
    label: "Fast",
    title: "Fast",
    detail: "Low reasoning, increased usage",
  },
};
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
const SAFETY_LOCK_PATTERNS = [
  { reason: "self-harm", pattern: /\b(?:kill myself|end my life|suicide|suicidal|self[-\s]?harm|hurt myself|cut myself|overdose on purpose)\b/i },
  { reason: "harm", pattern: /\b(?:how (?:do i|to) (?:kill|murder|hurt) (?:someone|a person)|commit murder|school shooting|mass shooting)\b/i },
  { reason: "weapons", pattern: /\b(?:build|make|assemble|detonate|plant)\s+(?:a\s+)?(?:bomb|explosive|pipe bomb|molotov|grenade)\b/i },
  { reason: "child-safety", pattern: /\b(?:child sexual|sexualize (?:a )?minor|minor porn|cp\b|csam)\b/i },
  { reason: "cyber-abuse", pattern: /\b(?:make|write|build|deploy|use)\s+(?:malware|ransomware|keylogger|token grabber|phishing kit|password stealer|ddos bot)\b/i },
  { reason: "hard-drugs", pattern: /\b(?:make|cook|synthesize|manufacture)\s+(?:meth|fentanyl|heroin|cocaine|mdma)\b/i },
];
const VOICE_WAVE_BARS = [0.34, 0.55, 0.42, 0.72, 0.5, 0.86, 0.48, 0.64, 0.94, 0.56, 0.74, 0.46, 0.82, 0.58, 0.38, 0.7, 0.52, 0.9, 0.44, 0.62, 0.78, 0.4];

const storage = {
  load() {
    const savedConfig = readJson("aether.config", {});
    for (const key of Object.keys(savedConfig)) {
      if (key === "apiEndpoint") continue;
      Aether.config[key] = savedConfig[key];
    }
    Aether.config.apiEndpoint = defaultApiEndpoint();
    Aether.config.speedMode = normalizedSpeedMode(Aether.config.speedMode);
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
    queueAccountChatsSave();
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
        content: DEFAULT_ASSISTANT_GREETING,
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
    safetyLocked: Boolean(chat?.safetyLocked),
    safetyReason: String(chat?.safetyReason || ""),
    safetyLockedAt: chat?.safetyLockedAt || "",
    messages: Array.isArray(chat?.messages) ? chat.messages : [],
  };
  normalized.messages = normalized.messages.map((message) => ({
    ...message,
    id: message?.id || createId(),
    role: message?.role === "user" ? "user" : "assistant",
    content: String(message?.content || ""),
    createdAt: message?.createdAt || normalized.createdAt,
    voice: Boolean(message?.voice),
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
  storage.load();
  bindScrollFadePreferenceChanges();
  bindRateLimitClockEvents();
  startRateLimitCountdown();
  render();
  checkServerStatus();
  startServerStatusPolling();
}

function render() {
  const root = document.getElementById("app");
  const chat = activeChat();
  const mobileSidebarClass = Aether.state.mobileSidebarOpen ? " mobile-sidebar-open" : "";
  const showAdminView = Aether.state.adminView && isCurrentAdmin();
  const banLocked = isUserBanned();
  const lockableAttrs = banLocked ? ` inert aria-hidden="true"` : "";

  root.innerHTML = `
    <div class="app-shell${mobileSidebarClass}${banLocked ? " ban-locked-shell" : ""}">
      <div class="app-content"${lockableAttrs}>
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
          ${renderAdminSidebarButton()}
          <input class="sidebar-search" data-action="sidebar-search" autocomplete="off" placeholder="Search conversations" value="${escapeHtml(Aether.state.sidebarSearch)}">
          <div class="chat-list">
            ${filteredChats().map(chatListItem).join("") || `<div class="sidebar-empty">No conversations found.</div>`}
          </div>
          ${renderRateLimitMeter()}
        </aside>

        ${showAdminView ? renderAdminPage() : renderChatPage(chat)}
        ${renderProfanityPopup()}
        ${renderRateLimitPopup()}
        ${renderAuthModal()}
        ${renderAccountModal()}
        ${renderToast()}
      </div>
      ${renderBanOverlay()}
    </div>
  `;

  bindEvents(root);
  observeMessageVisibility();
  scrollChatToBottom();
}

function renderAdminSidebarButton() {
  if (!isCurrentAdmin()) return "";
  return `<button class="admin-tab ${Aether.state.adminView ? "active" : ""}" data-action="admin-tab">Admin Portal</button>`;
}

function isCurrentAdmin() {
  return Boolean(Aether.state.signedIn && Aether.state.account?.isAdmin);
}

function renderAccountSidebarButton() {
  if (Aether.state.signedIn && Aether.state.account) {
    return `
      <button class="account-tab signed-in" data-action="account-tab">
        ${renderAccountAvatar(Aether.state.account)}
        <span class="account-tab-copy">
          <strong>${escapeHtml(Aether.state.account.username)}</strong>
          <small>Account</small>
        </span>
      </button>
    `;
  }
  return `<button class="account-tab" data-action="signin-tab">Sign in</button>`;
}

function renderAccountAvatar(account, large = false) {
  const largeClass = large ? " large" : "";
  if (account?.profilePictureUrl) {
    return `<img class="account-avatar${largeClass}" src="${escapeHtml(account.profilePictureUrl)}" alt="${escapeHtml(account.username || "Account")}">`;
  }
  return `<span class="account-avatar${largeClass}">${escapeHtml(accountInitials(account?.username || ""))}</span>`;
}

function renderChatPage(chat) {
  const unavailable = Aether.state.aetherAvailable === false;
  const safetyLocked = Boolean(chat?.safetyLocked);
  const composerPlaceholder = safetyLocked
    ? SAFETY_LOCK_PLACEHOLDER
    : unavailable ? "Aether AI is currently unavailable" : "Send a message here.";
  const composerDisabled = unavailable || safetyLocked || Aether.state.thinking;
  const composerLocked = unavailable || safetyLocked;
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
          <button class="secondary-button" data-action="regenerate-last"${composerLocked ? " disabled" : ""}>Resend last</button>
        </div>
      </header>
      <div class="messages" id="messages">
        ${chat.messages.map(renderMessage).join("")}
        ${Aether.state.thinking ? renderThinking() : ""}
      </div>
      <div class="composer-area">
        <form class="composer${composerLocked ? " unavailable" : ""}" data-action="send-message">
          <div class="composer-input-wrap">
            <div class="composer-highlights" aria-hidden="true">${renderHighlightedComposerText(Aether.state.composerDraft)}</div>
            <textarea name="message" autocomplete="off" rows="1" placeholder="${escapeHtml(composerPlaceholder)}" spellcheck="true"${composerLocked ? " disabled" : ""}>${escapeHtml(Aether.state.composerDraft)}</textarea>
          </div>
          <div class="composer-toolbar">
            <div class="composer-tools-left">
              <button class="voice-button ${Aether.state.voiceListening ? "listening" : ""}" type="button" data-action="voice-input" aria-label="${Aether.state.voiceListening ? "Stop voice input" : "Start voice input"}" aria-pressed="${Aether.state.voiceListening ? "true" : "false"}" title="${Aether.state.voiceListening ? "Stop voice input" : "Start voice input"}"${composerDisabled ? " disabled" : ""}>🎙️</button>
            </div>
            <div class="composer-tools-right">
              ${renderSpeedMenu(composerLocked)}
              <button class="send-button" type="submit" aria-label="Send message"${composerDisabled ? " disabled" : ""}>↑</button>
            </div>
          </div>
        </form>
        <p class="composer-note">Aether can make mistakes. Double check important info.</p>
      </div>
    </main>
  `;
}

function renderSpeedMenu(disabled = false) {
  const mode = SPEED_MODES[normalizedSpeedMode(Aether.config.speedMode)] || SPEED_MODES.default;
  const openClass = Aether.state.speedMenuOpen ? " open" : "";
  return `
    <div class="speed-picker${openClass}">
      <button class="speed-trigger" type="button" data-action="toggle-speed-menu" aria-haspopup="menu" aria-expanded="${Aether.state.speedMenuOpen ? "true" : "false"}"${disabled ? " disabled" : ""}>
        <span>Speed</span>
        <span class="speed-current">${escapeHtml(mode.label)}</span>
        <i aria-hidden="true"></i>
      </button>
      ${Aether.state.speedMenuOpen ? `
        <div class="speed-menu" role="menu" aria-label="Speed">
          <span class="speed-menu-title">Speed</span>
          ${Object.entries(SPEED_MODES).map(([key, item]) => {
            const active = key === normalizedSpeedMode(Aether.config.speedMode);
            return `
              <button class="speed-option ${active ? "active" : ""}" type="button" role="menuitemradio" aria-checked="${active ? "true" : "false"}" data-speed-mode="${escapeHtml(key)}">
                <span class="speed-icon" aria-hidden="true">${key === "fast" ? "⚡" : ""}</span>
                <span>
                  <strong>${escapeHtml(item.title)}</strong>
                  <small>${escapeHtml(item.detail)}</small>
                </span>
                <b aria-hidden="true">${active ? "✓" : ""}</b>
              </button>
            `;
          }).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderAdminPage() {
  const status = Aether.state.adminStatus || {};
  const counts = status.requestCounts || { minute: 0, hour: 0, day: 0 };
  const database = status.database || {};
  const rate = status.rateLimit || Aether.state.rateLimit || {};
  const accounts = status.accounts || [];
  const admins = status.admins || [];
  const pendingProfilePictures = status.pendingProfilePictures || [];
  const available = status.aetherAvailable !== false;
  const canManageAdmins = Boolean(status.canManageAdmins || Aether.state.account?.isOwnerAdmin);

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
          <button class="secondary-button" data-action="admin-refresh">Refresh</button>
        </div>
      </header>
      <div class="admin-scroll">
        ${Aether.state.adminError ? `<div class="admin-alert">${escapeHtml(Aether.state.adminError)}</div>` : ""}
        <section class="admin-hero">
          <div>
            <span class="admin-kicker">${escapeHtml(database.provider || "database")} </span>
            <h2>${available ? "Aether is available" : "Aether is unavailable"}</h2>
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
          ${renderBanIpPanel(status.bannedIps || [], status.bannedAccounts || [])}
          ${renderBlockedAttemptsPanel(status.blockedAttempts || [])}
        </section>
        ${renderAdminsPanel(admins, canManageAdmins)}
        ${renderAdminAccountsPanel(accounts, canManageAdmins)}
        ${renderProfilePictureReviewPanel(pendingProfilePictures)}
      </div>
    </main>
  `;
}

function renderBanIpPanel(bannedIps, bannedAccounts = []) {
  const totalBans = bannedIps.length + bannedAccounts.length;
  return `
    <section class="admin-panel">
      <div class="admin-panel-head">
        <h2>Bans</h2>
        <span>${totalBans}</span>
      </div>
      <form class="admin-ban-form" data-action="admin-ban-ip">
        <input name="ipAddress" autocomplete="off" placeholder="IP address">
        <input name="reason" autocomplete="off" placeholder="Reason">
        <button class="primary-button" type="submit"${Aether.state.adminLoading ? " disabled" : ""}>Ban IP</button>
      </form>
      <form class="admin-ban-form" data-action="admin-ban-user">
        <input name="username" autocomplete="off" placeholder="Username">
        <input name="reason" autocomplete="off" placeholder="Reason">
        <button class="primary-button" type="submit"${Aether.state.adminLoading ? " disabled" : ""}>Ban user</button>
      </form>
      <div class="admin-list">
        ${bannedAccounts.map((item) => `
          <div class="admin-list-item banned-user-item">
            <div>
              <strong>${escapeHtml(item.username || "")}</strong>
              <small>User ban - ${escapeHtml(item.reason || "No reason")} - ${escapeHtml(formatAdminDate(item.createdAt))}</small>
              ${item.sourceMessage ? `<p>${escapeHtml(item.sourceMessage)}</p>` : ""}
            </div>
            <button class="secondary-button" data-unban-user="${escapeHtml(item.accountId || "")}">Unban user</button>
          </div>
        `).join("")}
        ${bannedIps.map((item) => {
          const username = String(item.username || "").trim();
          const sourceMessage = String(item.sourceMessage || "").trim();
          return `
            <div class="admin-list-item banned-user-item">
              <div>
                <strong>${escapeHtml(item.ipAddress || "")}</strong>
                <small>IP ban${username ? ` for ${escapeHtml(username)}` : ""} - ${escapeHtml(item.reason || "No reason")} - ${escapeHtml(formatAdminDate(item.createdAt))}</small>
                ${sourceMessage ? `<p>${escapeHtml(sourceMessage)}</p>` : ""}
              </div>
              <button class="secondary-button" data-unban-ip="${escapeHtml(item.ipAddress || "")}">Unban IP</button>
            </div>
          `;
        }).join("")}
        ${totalBans ? "" : `<div class="admin-empty">No banned users/IPs.</div>`}
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
        ${attempts.map((attempt) => {
          const username = String(attempt.username || "").trim();
          const ipAddress = String(attempt.ipAddress || "").trim();
          const attemptId = escapeHtml(attempt.id || "");
          const primaryLabel = username || ipAddress;
          const detailLabel = username ? `User ${escapeHtml(username)} - IP ${escapeHtml(ipAddress)}` : `IP ${escapeHtml(ipAddress)}`;
          return `
            <div class="blocked-attempt">
              <div class="blocked-attempt-head">
                <div>
                  <strong>${escapeHtml(primaryLabel)}</strong>
                  <small>${detailLabel}</small>
                </div>
                <small>${escapeHtml(formatAdminDate(attempt.createdAt))}</small>
              </div>
              <p>${escapeHtml(attempt.message || "")}</p>
              <ol>
                ${(attempt.context || []).map((message) => `<li>${escapeHtml(message)}</li>`).join("")}
              </ol>
              <div class="blocked-actions">
                <button class="danger-button" data-blocked-ban="${attemptId}"${Aether.state.adminLoading ? " disabled" : ""}>${username ? "Ban User" : "Ban IP"}</button>
                <button class="secondary-button" data-blocked-ignore="${attemptId}"${Aether.state.adminLoading ? " disabled" : ""}>Ignore</button>
              </div>
            </div>
          `;
        }).join("") || `<div class="admin-empty">No blocked attempts.</div>`}
      </div>
      <button class="secondary-button show-all-button" data-action="admin-show-all"${Aether.state.blockedAttemptsExpanded ? " disabled" : ""}>Show all</button>
    </section>
  `;
}

function renderAdminsPanel(admins, canManageAdmins) {
  return `
    <section class="admin-panel account-admin-panel">
      <div class="admin-panel-head">
        <h2>Admins</h2>
        <span>${admins.length}</span>
      </div>
      <div class="admin-list account-admin-list">
        ${admins.map((admin) => `
          <div class="admin-list-item account-admin-item">
            <div>
              <strong>${escapeHtml(admin.username || "")}${admin.isOwnerAdmin ? " (owner)" : ""}</strong>
              <small>Admin since ${escapeHtml(formatAdminDate(admin.adminSince || admin.createdAt))}</small>
            </div>
            ${canManageAdmins && !admin.isOwnerAdmin ? `<button class="secondary-button" data-admin-revoke="${escapeHtml(admin.id || "")}"${Aether.state.adminLoading ? " disabled" : ""}>Remove admin</button>` : ""}
          </div>
        `).join("") || `<div class="admin-empty">No admins yet.</div>`}
      </div>
    </section>
  `;
}

function renderAdminAccountsPanel(accounts, canManageAdmins) {
  return `
    <section class="admin-panel account-admin-panel">
      <div class="admin-panel-head">
        <h2>Accounts</h2>
        <span>${accounts.length}</span>
      </div>
      <div class="admin-list account-admin-list">
        ${accounts.map((account) => `
          <div class="admin-list-item account-admin-item">
            <div class="account-admin-profile">
              ${renderAccountAvatar(account)}
              <div>
                <strong>${escapeHtml(account.username || "")}</strong>
                <small>Created ${escapeHtml(formatAdminDate(account.createdAt))} - Last login ${escapeHtml(formatAdminDate(account.lastLoginAt))}${account.isAdmin ? " - Admin" : ""}${account.isBanned ? " - Banned" : ""}</small>
              </div>
            </div>
            <div class="admin-row-actions">
              ${canManageAdmins && !account.isAdmin ? `<button class="secondary-button" data-admin-grant="${escapeHtml(account.id || "")}"${Aether.state.adminLoading ? " disabled" : ""}>Give admin</button>` : ""}
              <button class="danger-button" data-admin-delete-account="${escapeHtml(account.id || "")}"${Aether.state.adminLoading || account.isOwnerAdmin ? " disabled" : ""}>Delete</button>
            </div>
          </div>
        `).join("") || `<div class="admin-empty">No accounts yet.</div>`}
      </div>
    </section>
  `;
}

function renderProfilePictureReviewPanel(requests) {
  return `
    <section class="admin-panel pfp-review-panel">
      <div class="admin-panel-head">
        <h2>Profile pictures</h2>
        <span>${requests.length}</span>
      </div>
      <div class="admin-list pfp-review-list">
        ${requests.map((request) => `
          <div class="admin-list-item pfp-review-item">
            <img class="pfp-review-image" src="${escapeHtml(request.imageDataUrl || "")}" alt="${escapeHtml(request.username || "Pending profile picture")}">
            <div>
              <strong>${escapeHtml(request.username || "")}</strong>
              <small>Submitted ${escapeHtml(formatAdminDate(request.submittedAt))}</small>
            </div>
            <div class="pfp-review-actions">
              <button class="primary-button" data-admin-approve-pfp="${escapeHtml(request.accountId || "")}"${Aether.state.adminLoading ? " disabled" : ""}>Approve</button>
              <button class="secondary-button" data-admin-decline-pfp="${escapeHtml(request.accountId || "")}"${Aether.state.adminLoading ? " disabled" : ""}>Decline</button>
            </div>
          </div>
        `).join("") || `<div class="admin-empty">No profile pictures waiting for review.</div>`}
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
  if (chat?.safetyLocked) return "Conversation locked";
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
  const resetTime = formatRateLimitResetTime(rate);
  return `
    <div class="rate-card" style="--rate-color: ${rateColor(displayPercent)}">
      <div class="rate-percent">${displayPercent}%</div>
      <div class="rate-track"><span class="rate-fill" style="width: ${displayPercent}%"></span></div>
      <div class="rate-label">${remaining}/${limit} left - ${escapeHtml(rateResetLabel(resetTime))}</div>
    </div>
  `;
}

function renderMessage(message) {
  const roleClass = message.role === "user" ? "user" : "assistant";
  const typingClass = message.typing ? " typing" : "";
  const voiceClass = message.voice ? " voice-message-row" : "";
  const messageId = message.id || "";
  const content = message.role === "assistant" ? normalizeAssistantText(message.content) : message.content;
  const bubble = message.role === "assistant"
    ? `<div class="bubble formatted">${renderAssistantMarkdown(content)}</div>`
    : `<div class="bubble">${escapeHtml(content)}</div>`;
  const copyButton =
    message.role === "assistant" && !message.typing
      ? `<button class="copy-message" data-copy-message="${escapeHtml(messageId)}" aria-label="Copy this message" title="Copy this message">Copy</button>`
      : "";
  const thoughtTime =
    message.role === "assistant" && !message.typing && Number.isFinite(message.thoughtTimeMs)
      ? `<span class="thought-time">Thought for ${escapeHtml(formatThoughtTime(message.thoughtTimeMs))}</span>`
      : "";
  const messageControls = copyButton || thoughtTime ? `<div class="message-controls">${copyButton}${thoughtTime}</div>` : "";
  return `
    <div class="message-row ${roleClass}${typingClass}${voiceClass}" data-message-id="${escapeHtml(messageId)}">
      <div class="message-stack">
        ${message.voice ? renderVoiceBubble(message) : bubble}
        ${messageControls}
      </div>
    </div>
  `;
}

function renderVoiceBubble(message) {
  const duration = voiceMessageDuration(message.content);
  const bars = VOICE_WAVE_BARS.map((height, index) => `<span style="--h:${height};--d:${index}"></span>`).join("");
  return `
    <div class="bubble voice-bubble" title="${escapeHtml(message.content || "Voice message")}">
      <span class="voice-wave" aria-hidden="true">${bars}</span>
      <span class="voice-time">${escapeHtml(duration)}</span>
    </div>
  `;
}

function voiceMessageDuration(text) {
  const seconds = Math.max(2, Math.min(25, Math.round(String(text || "").split(/\s+/).filter(Boolean).length * 0.45)));
  return `0:${String(seconds).padStart(2, "0")}`;
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
  const resetTime = formatRateLimitResetTime(rate);
  return `
    <div class="warning-overlay compact" role="dialog" aria-modal="true">
      <div class="warning-modal compact-modal">
        <h2>Oops!</h2>
        <p>${escapeHtml(rateResetLabel(resetTime))}.</p>
        <button class="warning-understand" data-action="close-rate-limit">Okay.</button>
      </div>
    </div>
  `;
}

function renderBanOverlay() {
  if (!isUserBanned()) return "";
  const ban = Aether.state.banStatus || {};
  const reason = String(ban.reason || "").trim() || "No reason was provided.";
  const username = String(ban.username || "").trim();
  const sourceMessage = String(ban.sourceMessage || "").trim();
  const bannedAt = ban.createdAt ? formatAdminDate(ban.createdAt) : "";
  return `
    <div class="ban-lock-overlay" role="dialog" aria-modal="true" aria-labelledby="ban-title" aria-describedby="ban-body">
      <section class="ban-lock-card" tabindex="-1">
        <div class="ban-lock-icon" aria-hidden="true">!</div>
        <span class="ban-lock-eyebrow">Access blocked</span>
        <h2 id="ban-title">You are banned from Aether AI</h2>
        <p id="ban-body">${escapeHtml(BAN_POPUP_BODY)}</p>
        <div class="ban-lock-details">
          <div class="ban-detail">
            <span>Reason</span>
            <strong>${escapeHtml(reason)}</strong>
          </div>
          ${username ? `
            <div class="ban-detail">
              <span>User</span>
              <strong>${escapeHtml(username)}</strong>
            </div>
          ` : ""}
          ${bannedAt ? `
            <div class="ban-detail">
              <span>Banned</span>
              <strong>${escapeHtml(bannedAt)}</strong>
            </div>
          ` : ""}
        </div>
        ${sourceMessage ? `
          <div class="ban-evidence">
            <span>What you said</span>
            <p>${escapeHtml(sourceMessage)}</p>
          </div>
        ` : ""}
      </section>
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
          ${renderAccountAvatar(account, true)}
          <div>
            <span class="auth-badge">Signed in</span>
            <h2 id="account-title">${escapeHtml(account.username)}</h2>
            <p>Created ${escapeHtml(formatAdminDate(account.createdAt))}</p>
          </div>
        </div>
        ${Aether.state.accountError ? `<div class="form-alert">${escapeHtml(Aether.state.accountError)}</div>` : ""}
        <form class="account-form pfp-form" data-action="account-profile-picture">
          <label>
            <span>Profile picture</span>
            <input name="profilePicture" type="file" accept="image/png,image/jpeg,image/webp" required>
          </label>
          <button class="secondary-button" type="submit"${Aether.state.accountLoading ? " disabled" : ""}>Submit</button>
        </form>
        ${account.profilePicturePending ? `<div class="form-note">Your profile picture is waiting for approval.</div>` : ""}
        ${(account.profilePictureUrl || account.profilePicturePending) ? `
          <button class="secondary-button" type="button" data-action="account-profile-picture-delete"${Aether.state.accountLoading ? " disabled" : ""}>Remove profile picture</button>
        ` : ""}
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
  if (isUserBanned()) {
    focusBanOverlay(root);
    return;
  }

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
    if (!isCurrentAdmin()) return;
    Aether.state.adminView = true;
    Aether.state.speedMenuOpen = false;
    Aether.state.mobileSidebarOpen = false;
    render();
    loadAdminStatus();
  });
  root.querySelector("[data-action='toggle-speed-menu']")?.addEventListener("click", () => {
    Aether.state.speedMenuOpen = !Aether.state.speedMenuOpen;
    render();
  });
  root.querySelectorAll("[data-speed-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setSpeedMode(button.dataset.speedMode || "default");
    });
  });
  root.querySelector("[data-action='toggle-mobile-sidebar']")?.addEventListener("click", () => {
    Aether.state.mobileSidebarOpen = !Aether.state.mobileSidebarOpen;
    Aether.state.speedMenuOpen = false;
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

function focusBanOverlay(root = document) {
  requestAnimationFrame(() => {
    root.querySelector(".ban-lock-card")?.focus({ preventScroll: true });
  });
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
  root.querySelector("[data-action='account-profile-picture']")?.addEventListener("submit", submitProfilePicture);
  root.querySelector("[data-action='account-profile-picture-delete']")?.addEventListener("click", deleteProfilePicture);
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

async function submitProfilePicture(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.profilePicture?.files?.[0];
  if (!file) {
    Aether.state.accountError = "Choose a profile picture first.";
    render();
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    Aether.state.accountError = "Profile picture must be a PNG, JPG, or WebP image.";
    render();
    return;
  }
  if (file.size > MAX_PROFILE_PICTURE_FILE_SIZE) {
    Aether.state.accountError = "Profile picture is too large.";
    render();
    return;
  }

  Aether.state.accountLoading = true;
  Aether.state.accountError = "";
  render();
  try {
    const imageDataUrl = await readFileAsDataUrl(file);
    const result = await accountRequest("/api/account/profile-picture", {
      method: "POST",
      body: JSON.stringify({ imageDataUrl }),
    });
    applyAccountStatus(result);
    showToast(result.message || "Profile picture submitted.");
  } catch (error) {
    Aether.state.accountError = error?.message || "Profile picture could not be submitted.";
  } finally {
    Aether.state.accountLoading = false;
    render();
  }
}

async function deleteProfilePicture() {
  Aether.state.accountLoading = true;
  Aether.state.accountError = "";
  render();
  try {
    const result = await accountRequest("/api/account/profile-picture", { method: "DELETE" });
    applyAccountStatus(result);
    showToast(result.message || "Profile picture removed.");
  } catch (error) {
    Aether.state.accountError = error?.message || "Profile picture could not be removed.";
  } finally {
    Aether.state.accountLoading = false;
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
  root.querySelector("[data-action='admin-refresh']")?.addEventListener("click", () => loadAdminStatus());
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
    const banned = await adminRequest("/api/admin/ban-ip", {
      method: "POST",
      body: JSON.stringify({
        ipAddress: String(data.get("ipAddress") || "").trim(),
        reason: String(data.get("reason") || "").trim(),
      }),
    });
    if (banned) form.reset();
  });
  root.querySelector("[data-action='admin-ban-user']")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const banned = await adminRequest("/api/admin/ban-user", {
      method: "POST",
      body: JSON.stringify({
        username: String(data.get("username") || "").trim(),
        reason: String(data.get("reason") || "").trim(),
      }),
    });
    if (banned) form.reset();
  });
  root.querySelectorAll("[data-unban-ip]").forEach((button) => {
    button.addEventListener("click", async () => {
      await adminRequest("/api/admin/unban-ip", {
        method: "POST",
        body: JSON.stringify({ ipAddress: button.dataset.unbanIp || "" }),
      });
    });
  });
  root.querySelectorAll("[data-unban-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      await adminRequest("/api/admin/unban-user", {
        method: "POST",
        body: JSON.stringify({ accountId: button.dataset.unbanUser || "" }),
      });
    });
  });
  root.querySelectorAll("[data-blocked-ban]").forEach((button) => {
    button.addEventListener("click", async () => {
      const banned = await adminRequest("/api/admin/blocked-attempt/ban", {
        method: "POST",
        body: JSON.stringify({ attemptId: button.dataset.blockedBan || "" }),
      });
      if (banned) showToast("Blocked attempt banned.");
    });
  });
  root.querySelectorAll("[data-blocked-ignore]").forEach((button) => {
    button.addEventListener("click", async () => {
      const ignored = await adminRequest("/api/admin/blocked-attempt/ignore", {
        method: "POST",
        body: JSON.stringify({ attemptId: button.dataset.blockedIgnore || "" }),
      });
      if (ignored) showToast("Blocked attempt ignored.");
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
  root.querySelectorAll("[data-admin-grant]").forEach((button) => {
    button.addEventListener("click", async () => {
      const granted = await adminRequest("/api/admin/grant-admin", {
        method: "POST",
        body: JSON.stringify({ accountId: button.dataset.adminGrant || "" }),
      });
      if (granted) showToast("Admin access granted.");
    });
  });
  root.querySelectorAll("[data-admin-revoke]").forEach((button) => {
    button.addEventListener("click", async () => {
      const revoked = await adminRequest("/api/admin/revoke-admin", {
        method: "POST",
        body: JSON.stringify({ accountId: button.dataset.adminRevoke || "" }),
      });
      if (revoked) showToast("Admin access removed.");
    });
  });
  root.querySelectorAll("[data-admin-approve-pfp]").forEach((button) => {
    button.addEventListener("click", async () => {
      const approved = await adminRequest("/api/admin/profile-picture/approve", {
        method: "POST",
        body: JSON.stringify({ accountId: button.dataset.adminApprovePfp || "" }),
      });
      if (approved) showToast("Profile picture approved.");
    });
  });
  root.querySelectorAll("[data-admin-decline-pfp]").forEach((button) => {
    button.addEventListener("click", async () => {
      const declined = await adminRequest("/api/admin/profile-picture/decline", {
        method: "POST",
        body: JSON.stringify({ accountId: button.dataset.adminDeclinePfp || "" }),
      });
      if (declined) showToast("Profile picture declined.");
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
  const fromVoice = voiceAutoSending;
  try {
    await sendTextMessage(text, { voice: fromVoice });
  } finally {
    voiceAutoSending = false;
  }
}

async function sendTextMessage(text, options = {}) {
  if (isUserBanned()) return;
  if (Aether.state.thinking) return;
  if (!isAetherAvailable()) return;
  const chat = activeChat();
  if (!chat || chat.safetyLocked) return;
  if (isRateLimited()) {
    Aether.state.rateLimitPopup = true;
    render();
    return;
  }
  if (handleLocalProfanity(text)) return;

  if (options.addUser !== false) {
    const userMessage = createMessage("user", text, options.voice ? { voice: true } : {});
    chat.messages.push(userMessage);
  }
  if (!options.voice && ["New conversation", "..."].includes(chat.title)) chat.title = text.slice(0, 48);
  touchChat(chat);
  const safetyReason = Aether.config.apiEndpoint ? "" : safetyLockReason(text);
  if (safetyReason) {
    Aether.state.thinking = true;
    storage.save();
    render();
    await lockChatForSafetyAfterDelay(chat, safetyReason);
    return;
  }

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
  if (isUserBanned()) return;
  if (Aether.state.thinking) return;
  if (!isAetherAvailable()) return;
  if (activeChat()?.safetyLocked) return;
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
          body: JSON.stringify({ message: text, chat: activeChat().messages, location, speedMode: normalizedSpeedMode(Aether.config.speedMode) }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          if (data.banned || data.ban) {
            applyServerStatus(data);
            render();
            return "";
          }
          if (isRetryableStatus(response.status)) {
            await wait(retryDelayMs);
            retryDelayMs = nextRetryDelay(retryDelayMs);
            continue;
          }
          return `I could not reach ${Aether.config.apiEndpoint}. ${backendLaunchMessage()}`;
        }
        const data = await response.json();
        applyServerStatus(data);
        if (data.banned || data.ban) {
          render();
          return "";
        }
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
        if (data.safetyLocked) {
          await lockChatForSafetyAfterDelay(activeChat(), data.safetyReason || "safety");
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

function safetyLockReason(text) {
  const match = SAFETY_LOCK_PATTERNS.find((item) => item.pattern.test(text));
  return match?.reason || "";
}

function lockChatForSafety(chat, reason = "safety") {
  if (!chat || chat.safetyLocked) return;
  const now = new Date().toISOString();
  chat.safetyLocked = true;
  chat.safetyReason = reason;
  chat.safetyLockedAt = now;
  touchChat(chat);
  Aether.state.thinking = false;
  stopVoiceInput({ keepDraft: true, silent: true });
}

async function lockChatForSafetyAfterDelay(chat, reason = "safety") {
  await wait(SAFETY_LOCK_DELAY_MS);
  lockChatForSafety(chat, reason);
  storage.save();
  render();
}

function isRateLimited() {
  resetExpiredRateLimitWindow();
  const rate = Aether.state.rateLimit;
  return Boolean(rate && Number(rate.remaining) <= 0);
}

function isAetherAvailable() {
  return Aether.state.aetherAvailable !== false && !isUserBanned();
}

function normalizedSpeedMode(value) {
  return value === "fast" ? "fast" : "default";
}

function setSpeedMode(value) {
  Aether.config.speedMode = normalizedSpeedMode(value);
  Aether.state.speedMenuOpen = false;
  storage.save();
  render();
}

function applyServerStatus(data) {
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(data, "aetherAvailable")) {
    setAetherAvailability(data.aetherAvailable !== false);
  }
  if (Object.prototype.hasOwnProperty.call(data, "banned") || Object.prototype.hasOwnProperty.call(data || {}, "ban")) {
    changed = applyBanStatus(data) || changed;
  }
  if (Object.prototype.hasOwnProperty.call(data, "signedIn")) {
    changed = applyAccountStatus(data) || changed;
  }
  if (data.rateLimit) {
    updateRateLimit(data.rateLimit);
  }
  return changed;
}

function isUserBanned() {
  return Boolean(Aether.state.banStatus?.banned);
}

function applyBanStatus(data) {
  const wasBanned = banStatusKey(Aether.state.banStatus);
  const nextStatus = normalizeBanStatus(data);
  Aether.state.banStatus = nextStatus;
  document.body.classList.toggle("ban-locked", Boolean(nextStatus?.banned));
  if (nextStatus?.banned) {
    Aether.state.thinking = false;
    Aether.state.authModal = false;
    Aether.state.accountModal = false;
    Aether.state.profanityPopup = false;
    Aether.state.rateLimitPopup = false;
    Aether.state.adminView = false;
    Aether.state.mobileSidebarOpen = false;
    stopVoiceInput({ keepDraft: true, silent: true });
  }
  return wasBanned !== banStatusKey(nextStatus);
}

function normalizeBanStatus(data) {
  const rawBan = data?.ban && typeof data.ban === "object" ? data.ban : data;
  if (!data?.banned && !rawBan?.banned) return null;
  return {
    banned: true,
    banType: String(rawBan.banType || ""),
    accountId: String(rawBan.accountId || ""),
    ipAddress: String(rawBan.ipAddress || ""),
    username: String(rawBan.username || ""),
    reason: String(rawBan.reason || ""),
    sourceMessage: String(rawBan.sourceMessage || ""),
    createdAt: String(rawBan.createdAt || ""),
  };
}

function banStatusKey(status) {
  if (!status?.banned) return "";
  return [
    status.banType || "",
    status.accountId || "",
    status.ipAddress || "",
    status.username || "",
    status.reason || "",
    status.sourceMessage || "",
    status.createdAt || "",
  ].join("|");
}

function applyAccountStatus(data) {
  const previousSignedIn = Aether.state.signedIn;
  const previousAccountKey = accountRenderKey(Aether.state.account);
  if (data?.sessionToken) {
    setAccountSessionToken(data.sessionToken);
  } else if (data?.signedIn === false) {
    setAccountSessionToken("");
  }
  Aether.state.signedIn = Boolean(data?.signedIn && data?.account);
  Aether.state.account = Aether.state.signedIn ? data.account : null;
  let starterGreetingChanged = false;
  if (!Aether.state.signedIn) {
    Aether.state.accountModal = false;
    Aether.state.accountChatsSyncedFor = "";
    Aether.state.accountChatsLoading = false;
    Aether.state.adminView = false;
    Aether.state.adminStatus = null;
  } else {
    starterGreetingChanged = updateStarterGreetingForAccount(Aether.state.account);
    syncAccountChatsForCurrentAccount();
    if (!Aether.state.account?.isAdmin) {
      Aether.state.adminView = false;
      Aether.state.adminStatus = null;
    }
  }
  return (
    starterGreetingChanged ||
    previousSignedIn !== Aether.state.signedIn ||
    previousAccountKey !== accountRenderKey(Aether.state.account)
  );
}

function updateStarterGreetingForAccount(account) {
  const username = String(account?.username || "").trim();
  if (!username) return false;
  const greeting = welcomeBackGreeting(username);
  let changed = false;
  for (const chat of Aether.state.chats) {
    if (!isUntouchedStarterChat(chat)) continue;
    if (chat.messages[0].content === greeting) continue;
    chat.messages[0].content = greeting;
    chat.updatedAt = new Date().toISOString();
    changed = true;
  }
  return changed;
}

function isUntouchedStarterChat(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  if (messages.length !== 1 || messages[0]?.role !== "assistant") return false;
  const content = String(messages[0]?.content || "");
  return content === DEFAULT_ASSISTANT_GREETING || /^Hey! Welcome back, .+! What's on your mind\?$/.test(content);
}

function welcomeBackGreeting(username) {
  return `Hey! Welcome back, ${username}! What's on your mind?`;
}

function accountRenderKey(account) {
  if (!account) return "";
  return [
    account.id ?? "",
    account.username ?? "",
    account.profilePictureUrl ?? "",
    account.profilePicturePending ? "pending" : "",
    account.isAdmin ? "admin" : "",
    account.isOwnerAdmin ? "owner" : "",
  ].join("|");
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

async function syncAccountChatsForCurrentAccount() {
  const accountId = String(Aether.state.account?.id || "");
  if (!accountId || Aether.state.accountChatsSyncedFor === accountId || Aether.state.accountChatsLoading) return;
  Aether.state.accountChatsLoading = true;
  try {
    const response = await fetch(apiUrl("/api/account/chats"), {
      headers: await authHeaders(),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (data.banned || data.ban) {
      applyServerStatus(data);
      render();
      return;
    }
    if (!response.ok) throw new Error(data.error || `Chat sync failed with HTTP ${response.status}`);
    if (String(Aether.state.account?.id || "") !== accountId) return;
    Aether.state.accountChatsSyncedFor = accountId;
    if (data.hasChats) {
      applyRemoteAccountChats(data);
    } else {
      queueAccountChatsSave({ immediate: true });
    }
  } catch (error) {
    Aether.state.accountError = error?.message || "Chat sync failed.";
  } finally {
    Aether.state.accountChatsLoading = false;
  }
}

function applyRemoteAccountChats(data) {
  const remoteChats = Array.isArray(data?.chats) ? data.chats.map(normalizeChat) : [];
  if (!remoteChats.length) return;
  Aether.state.chats = remoteChats;
  Aether.state.activeChatId = remoteChats.some((chat) => chat.id === data.activeChatId)
    ? data.activeChatId
    : remoteChats[0].id;
  localStorage.setItem("aether.chats", JSON.stringify(Aether.state.chats));
  localStorage.setItem("aether.activeChatId", Aether.state.activeChatId || "");
  render();
}

function queueAccountChatsSave(options = {}) {
  if (isUserBanned()) return;
  if (!Aether.state.signedIn || !Aether.state.account?.id) return;
  if (accountChatsSaveTimer) clearTimeout(accountChatsSaveTimer);
  const delay = options.immediate ? 0 : ACCOUNT_CHATS_SAVE_DELAY_MS;
  accountChatsSaveTimer = setTimeout(() => {
    accountChatsSaveTimer = null;
    saveAccountChatsNow();
  }, delay);
}

async function saveAccountChatsNow() {
  if (!Aether.state.signedIn || !Aether.state.account?.id) return;
  if (accountChatsSaving) {
    accountChatsSaveQueued = true;
    return;
  }
  accountChatsSaving = true;
  const accountId = String(Aether.state.account.id);
  try {
    const response = await fetch(apiUrl("/api/account/chats"), {
      method: "PUT",
      headers: await authHeaders({ "Content-Type": "application/json;charset=UTF-8" }),
      cache: "no-store",
      body: JSON.stringify({
        chats: accountChatsPayload(),
        activeChatId: Aether.state.activeChatId || "",
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.banned || data.ban) {
        applyServerStatus(data);
        render();
        return;
      }
      throw new Error(data.error || `Chat save failed with HTTP ${response.status}`);
    }
    if (String(Aether.state.account?.id || "") === accountId) {
      Aether.state.accountChatsSyncedFor = accountId;
    }
  } catch (error) {
    Aether.state.accountError = error?.message || "Chat save failed.";
  } finally {
    accountChatsSaving = false;
    if (accountChatsSaveQueued) {
      accountChatsSaveQueued = false;
      queueAccountChatsSave({ immediate: true });
    }
  }
}

function accountChatsPayload() {
  return Aether.state.chats.map((chat) => ({
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    safetyLocked: Boolean(chat.safetyLocked),
    safetyReason: chat.safetyReason || "",
    safetyLockedAt: chat.safetyLockedAt || "",
    messages: chat.messages
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        voice: Boolean(message.voice),
      })),
  }));
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
    const accountChanged = applyServerStatus(data);
    if (accountChanged) render();
  } catch {
    setServerOnline(false);
  }
}

function updateRateLimit(rateLimit) {
  const merged = {
    ...Aether.state.rateLimit,
    ...rateLimit,
  };
  Aether.state.rateLimit = normalizeRateLimitDeadline(merged, rateLimit);
  animateRateMeterTo(ratePercent(Aether.state.rateLimit));
  updateRateMeterDom();
}

function startRateLimitCountdown() {
  if (rateLimitCountdownTimer) clearInterval(rateLimitCountdownTimer);
  rateLimitCountdownTimer = setInterval(() => {
    const rate = Aether.state.rateLimit;
    if (!rate) return;
    rate.resetInSeconds = currentRateResetSeconds(rate);
    if (rate.resetInSeconds <= 0) {
      resetExpiredRateLimitWindow();
      updateRateMeterDom();
      return;
    }
    updateRateMeterDom();
  }, 1000);
}

function resetExpiredRateLimitWindow() {
  const rate = Aether.state.rateLimit;
  if (!rate) return;
  const limit = Number(rate.limit || 0);
  if (!limit || currentRateResetSeconds(rate) > 0) return;
  rate.used = 0;
  rate.remaining = limit;
  rate.percentUsed = 0;
  rate.resetAt = "";
  rate.resetInSeconds = currentRateResetSeconds(rate);
  animateRateMeterTo(100);
}

function normalizeRateLimitDeadline(rate, source = rate) {
  const normalized = { ...rate };
  if (!Object.prototype.hasOwnProperty.call(source || {}, "resetAt") && !Date.parse(normalized.resetAt || "")) {
    normalized.resetAt = "";
  }
  normalized.resetInSeconds = currentRateResetSeconds(normalized);
  return normalized;
}

function currentRateResetSeconds(rate) {
  const resetAtMs = Date.parse(rate?.resetAt || "");
  if (Number.isFinite(resetAtMs)) {
    return Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000));
  }
  return Math.max(0, Math.floor(Number(rate?.resetInSeconds || 0)));
}

function bindRateLimitClockEvents() {
  const refreshClock = () => {
    resetExpiredRateLimitWindow();
    updateRateMeterDom();
    if (!document.hidden) pingServerStatus();
  };
  document.addEventListener("visibilitychange", refreshClock);
  window.addEventListener("focus", refreshClock);
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
  const resetTime = formatRateLimitResetTime(rate);
  card.style.setProperty("--rate-color", rateColor(displayPercent));
  const percentElement = card.querySelector(".rate-percent");
  if (percentElement) percentElement.textContent = `${displayPercent}%`;
  const fillElement = card.querySelector(".rate-fill");
  if (fillElement) fillElement.style.width = `${displayPercent}%`;
  const labelElement = card.querySelector(".rate-label");
  if (labelElement) {
    labelElement.textContent = `${remaining}/${limit} left - ${rateResetLabel(resetTime)}`;
  }
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
    const response = await fetch(apiUrl("/api/status"), {
      headers: await authHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Status failed with HTTP ${response.status}`);
    const data = await response.json();
    setServerOnline(true);
    const accountChanged = applyServerStatus(data);
    storage.save();
    updateRateMeterDom();
    if (accountChanged) render();
  } catch {
    setServerOnline(false);
  }
}

async function authHeaders(base = {}) {
  const token = accountSessionToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : { ...base };
}

function formatRateLimitResetTime(rate) {
  const resetAtMs = Date.parse(rate?.resetAt || "");
  if (!Number.isFinite(resetAtMs)) return "";
  try {
    return new Date(resetAtMs).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function rateResetLabel(resetTime) {
  return resetTime ? `Resets at ${resetTime}` : "Reset time unavailable";
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
  if (data.banned || data.ban) {
    applyServerStatus(data);
    render();
  }
  if (!response.ok) {
    throw new Error(data.error || `Account request failed with HTTP ${response.status}`);
  }
  return data;
}

async function adminHeaders(base = {}) {
  return authHeaders(base);
}

async function loadAdminStatus(options = {}) {
  if (!isCurrentAdmin()) return;
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
    if (data.banned || data.ban) {
      applyServerStatus(data);
      render();
    }
    if (!response.ok) {
      throw new Error(data.error || `Admin request failed with HTTP ${response.status}`);
    }
    Aether.state.adminStatus = data;
    if (data.currentAdmin) {
      applyAccountStatus({ signedIn: true, account: data.currentAdmin });
    }
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
  if (!isCurrentAdmin()) {
    Aether.state.adminError = "Sign in with an admin account first.";
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
    if (data.banned || data.ban) {
      applyServerStatus(data);
      render();
    }
    if (!response.ok) {
      throw new Error(data.error || `Admin request failed with HTTP ${response.status}`);
    }
    Aether.state.adminStatus = data;
    if (data.currentAdmin) {
      applyAccountStatus({ signedIn: true, account: data.currentAdmin });
    }
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
  if (!chat || chat.safetyLocked) return;
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
  await writeClipboard(normalizeAssistantText(message.content), button);
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
  if (!chat || chat.safetyLocked || Aether.state.thinking) return;
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
  const cleanText = normalizeAssistantText(fullText);

  if (bubble) {
    bubble.classList.remove("formatted");
    await revealAssistantText(bubble, cleanText);
    bubble.classList.add("formatted");
    bubble.innerHTML = renderAssistantMarkdown(cleanText);
    scrollChatToBottom();
  }

  message.content = cleanText;
  message.typing = false;
  row?.classList.remove("typing");
  storage.save();
  render();
}

function formatThoughtTime(milliseconds) {
  const seconds = Math.max(0.1, milliseconds / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)} seconds`;
  return `${Math.round(seconds)} seconds`;
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

function normalizeAssistantText(text) {
  return String(text || "").replace(/\r\n?/g, "\n");
}

function renderAssistantMarkdown(text) {
  const source = normalizeAssistantText(text).trimEnd();
  if (!source) return "";

  const lines = source.split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(formatAssistantInline).join("<br>")}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = "";
  };

  const openList = (type) => {
    closeParagraph();
    if (listType === type) return;
    closeList();
    listType = type;
    html.push(`<${type}>`);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^```([a-z0-9_-]+)?\s*$/i);
    if (fenceMatch) {
      closeParagraph();
      closeList();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().match(/^```\s*$/)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      const language = fenceMatch[1] ? ` data-language="${escapeHtml(fenceMatch[1])}"` : "";
      html.push(`<pre${language}><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (!trimmed) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${formatAssistantInline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = trimmed.match(/^>\s?(.+)$/);
    if (quote) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${formatAssistantInline(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      openList("ul");
      html.push(`<li>${formatAssistantInline(unordered[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      openList("ol");
      html.push(`<li>${formatAssistantInline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeParagraph();
  closeList();
  return html.join("");
}

function formatAssistantInline(text) {
  const source = String(text || "");
  const html = [];
  const codePattern = /(`+)([\s\S]*?)\1/g;
  let lastIndex = 0;
  let match;

  while ((match = codePattern.exec(source))) {
    html.push(formatAssistantTextWithLinks(source.slice(lastIndex, match.index)));
    html.push(`<code>${escapeHtml(match[2])}</code>`);
    lastIndex = match.index + match[0].length;
  }

  html.push(formatAssistantTextWithLinks(source.slice(lastIndex)));
  return html.join("");
}

function formatAssistantTextWithLinks(text) {
  const source = String(text || "");
  const html = [];
  const linkPattern = /\[([^\]\n]{1,180})\]\((https?:\/\/[^\s)]+)\)/gi;
  let lastIndex = 0;
  let match;

  while ((match = linkPattern.exec(source))) {
    html.push(formatAssistantTextOnly(source.slice(lastIndex, match.index)));
    const href = safeMarkdownUrl(match[2]);
    if (href) {
      html.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${formatAssistantTextOnly(match[1])}</a>`);
    } else {
      html.push(formatAssistantTextOnly(match[0]));
    }
    lastIndex = match.index + match[0].length;
  }

  html.push(formatAssistantTextOnly(source.slice(lastIndex)));
  return html.join("");
}

function formatAssistantTextOnly(text) {
  return escapeHtml(text)
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s([])\*([^*\n]+)\*(?=$|[\s.,!?):;\]])/g, "$1<em>$2</em>")
    .replace(/(^|[\s([])_([^_\n]+)_(?=$|[\s.,!?):;\]])/g, "$1<em>$2</em>");
}

function safeMarkdownUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return escapeHtml(url.href);
  } catch {
    return "";
  }
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
    messageVisibilityObserver = null;
  }

  if (isMobileScrollFadeDisabled()) {
    clearMessageFadeState(messages);
    return;
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

function isMobileScrollFadeDisabled() {
  return Boolean(window.matchMedia?.(MOBILE_SCROLL_FADE_QUERY).matches);
}

function clearMessageFadeState(root = document) {
  root.querySelectorAll(".message-row").forEach((row) => {
    row.style.opacity = "";
    row.classList.remove("is-faded");
  });
}

function bindScrollFadePreferenceChanges() {
  const media = window.matchMedia?.(MOBILE_SCROLL_FADE_QUERY);
  if (!media) return;

  const handleChange = () => observeMessageVisibility();
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleChange);
  } else if (typeof media.addListener === "function") {
    media.addListener(handleChange);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(new Error("Profile picture could not be read.")));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

bootstrap();

