const Aether = {
  config: {
    appName: "Aether AI",
    apiEndpoint: defaultApiEndpoint(),
  },
  state: {
    chats: [],
    activeChatId: null,
    thinking: false,
    listening: false,
    warningPopup: null,
    shortMessagePopup: false,
    rateLimitPopup: false,
    ban: null,
    rateLimit: {
      limit: 15,
      used: 0,
      remaining: 15,
      percentUsed: 0,
      resetInSeconds: 0,
      unlimited: false,
    },
    reportPopup: null,
    reportNotice: "",
    isAdmin: false,
    adminView: false,
    adminData: null,
    adminLoading: false,
    adminSearch: "",
    adminStatusFilter: "open",
    account: null,
    accountSession: "",
    accountModal: null,
    accountError: "",
  },
};

let speechRecognition = null;
let messageVisibilityObserver = null;
const thoughtTimerTimeouts = new Map();
const PROFANITY_LIMIT = 6;
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
    Aether.state.chats = readJson("aether.chats", []);
    Aether.state.activeChatId = localStorage.getItem("aether.activeChatId");
    Aether.state.accountSession = localStorage.getItem("aether.accountSession") || "";
    Aether.state.account = readJson("aether.account", null);

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
    if (Aether.state.accountSession) {
      localStorage.setItem("aether.accountSession", Aether.state.accountSession);
    } else {
      localStorage.removeItem("aether.accountSession");
    }
    if (Aether.state.account) {
      localStorage.setItem("aether.account", JSON.stringify(Aether.state.account));
    } else {
      localStorage.removeItem("aether.account");
    }
  },
};

function defaultApiEndpoint() {
  const publicEndpoint = configuredPublicApiEndpoint();
  if (publicEndpoint) {
    return publicEndpoint;
  }
  if (canUseRelativeApi()) {
    return "/api/chat";
  }
  if (isStaticLaunch()) {
    return "http://127.0.0.1:8765/api/chat";
  }
  return "/api/chat";
}

function configuredPublicApiEndpoint() {
  const value = String(window.AETHER_API_ENDPOINT || "").trim();
  return /^https?:\/\/[^/]+\/api\/chat\/?$/i.test(value) ? value.replace(/\/+$/, "") : "";
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
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    title,
    messages: [
      {
        id: createId(),
        role: "assistant",
        content: "Hi there! I'm Aether. What's on your mind today?",
      },
    ],
  };
}

function activeChat() {
  return Aether.state.chats.find((chat) => chat.id === Aether.state.activeChatId);
}

function bootstrap() {
  injectStyles();
  storage.load();
  bindGlobalEvents();
  render();
  checkAdminStatus();
}

function bindGlobalEvents() {
  document.addEventListener("click", (event) => {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.action;
    if (action === "open-account") {
      event.preventDefault();
      openAccountModal();
    }
    if (action === "close-account") {
      event.preventDefault();
      closeAccountModal();
    }
    if (action === "show-register") {
      event.preventDefault();
      Aether.state.accountModal = "register";
      Aether.state.accountError = "";
      render();
    }
    if (action === "show-login") {
      event.preventDefault();
      Aether.state.accountModal = "login";
      Aether.state.accountError = "";
      render();
    }
    if (action === "logout-account") {
      event.preventDefault();
      logoutAccount();
    }
  });
}

function openAccountModal() {
  Aether.state.accountModal = Aether.state.account ? "profile" : "login";
  Aether.state.accountError = "";
  render();
}

function closeAccountModal() {
  Aether.state.accountModal = null;
  Aether.state.accountError = "";
  render();
}

function render() {
  const root = document.getElementById("app");
  const chat = activeChat();

  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <button class="brand" data-action="home" aria-label="Aether AI home">
        <img src="assets/Aether.png" alt="Aether" width="60" height="60">
          <span>Aether AI</span>
        </button>
        <button class="new-chat" data-action="new-chat">+ New conversation</button>
        <button class="account-tab" data-action="open-account">
          ${Aether.state.account ? escapeHtml(Aether.state.account.displayName || Aether.state.account.username) : "Sign in"}
        </button>
        ${Aether.state.isAdmin ? `<button class="admin-tab ${Aether.state.adminView ? "active" : ""}" data-action="admin-view" aria-label="Admin dashboard">Admin</button>` : ""}
        <div class="chat-list">
          ${Aether.state.chats.map(chatListItem).join("")}
        </div>
        ${renderRateLimitMeter()}
      </aside>

      ${Aether.state.adminView ? renderAdminPage() : renderChatPage(chat)}
      ${renderWarningPopup()}
      ${renderShortMessagePopup()}
      ${renderRateLimitPopup()}
      ${renderReportPopup()}
      ${renderAccountModal()}
      ${renderBanOverlay()}
    </div>
  `;

  bindEvents(root);
  observeMessageVisibility();
  scrollChatToBottom();
}

function renderChatPage(chat) {
  return `
    <main class="chat-page">
      <div class="animated-bg">
        <span></span><span></span><span></span>
      </div>
      <header class="topbar">
        <h1>${escapeHtml(chat.title)}</h1>
      </header>
      <div class="messages" id="messages">
        ${chat.messages.map(renderMessage).join("")}
        ${Aether.state.thinking ? renderThinking() : ""}
      </div>
      <form class="composer" data-action="send-message">
        <input name="message" autocomplete="off" placeholder="Send a message here.">
        <button class="mic-button ${Aether.state.listening ? "listening" : ""}" type="button" data-action="toggle-mic" aria-label="Use microphone">🎤︎︎</button>
        <button type="submit">Send</button>
      </form>
    </main>
  `;
}

function chatListItem(chat) {
  const active = chat.id === Aether.state.activeChatId ? "active" : "";
  return `
    <div class="chat-item-row ${active}">
      <button class="chat-item" data-chat-id="${chat.id}">${escapeHtml(chat.title)}</button>
      <button class="delete-chat" data-delete-chat="${chat.id}" aria-label="Delete ${escapeHtml(chat.title)}">X</button>
    </div>
  `;
}

function renderRateLimitMeter() {
  const rate = Aether.state.rateLimit || {};
  if (rate.unlimited) {
    return `
      <div class="rate-card unlimited">
        <div class="rate-percent">∞</div>
        <div class="rate-track"><span style="width: 100%"></span></div>
        <div class="rate-label">Unlimited admin messages</div>
      </div>
    `;
  }

  const percent = Math.max(0, Math.min(100, Number(rate.percentUsed || 0)));
  const remaining = Number(rate.remaining ?? rate.limit ?? 0);
  const limit = Number(rate.limit || 0);
  return `
    <div class="rate-card">
      <div class="rate-percent">${percent}%</div>
      <div class="rate-track"><span style="width: ${percent}%"></span></div>
      <div class="rate-label">${remaining}/${limit} left · resets in ${Number(rate.resetInSeconds || 0)}s</div>
    </div>
  `;
}

function renderMessage(message) {
  const roleClass = message.role === "user" ? "user" : "assistant";
  const typingClass = message.typing ? " typing" : "";
  const messageId = message.id || "";
  const content = message.role === "assistant" ? sanitizeAssistantText(message.content) : message.content;
  const reportButton =
    message.role === "assistant" && !message.typing
      ? `<button class="report-message" data-report-message="${escapeHtml(messageId)}" aria-label="Report this message" title="Report this message">⚑</button>`
      : "";
  const thoughtTime =
    message.role === "assistant" && !message.typing && message.showThoughtTime && Number.isFinite(message.thoughtTimeMs)
      ? `<span class="thought-time">Thought for ${escapeHtml(formatThoughtTime(message.thoughtTimeMs))}</span>`
      : "";
  const messageControls = reportButton || thoughtTime ? `<div class="message-controls">${reportButton}${thoughtTime}</div>` : "";
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

function renderWarningPopup() {
  if (!Aether.state.warningPopup) return "";
  const warnings = Aether.state.warningPopup.warnings;
  const banned = warnings >= PROFANITY_LIMIT;
  return `
    <div class="warning-overlay" role="dialog" aria-modal="true" aria-labelledby="warning-title">
      <div class="warning-modal">
        <h2 id="warning-title">${banned ? "You are permanently banned from Aether AI." : "Oops!"}</h2>
        <p>
          You used a blocked word in your message, you have ${warnings} warnings,
          reaching 6 will permanently ban you from Aether AI.
        </p>
        <button class="warning-understand" data-action="close-warning">I understand</button>
      </div>
    </div>
  `;
}

function renderShortMessagePopup() {
  if (!Aether.state.shortMessagePopup) return "";
  return `
    <div class="warning-overlay compact" role="dialog" aria-modal="true">
      <div class="warning-modal compact-modal">
        <h2>Message too short</h2>
        <p>Your message must have at least 2 letters.</p>
        <button class="warning-understand" data-action="close-short-message">I understand</button>
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
        <h2>Rate limit reached</h2>
        <p>Wait ${Number(rate.resetInSeconds || 0)} seconds, or sign in for 30 messages per minute.</p>
        <button class="warning-understand" data-action="close-rate-limit">I understand</button>
      </div>
    </div>
  `;
}

function renderBanOverlay() {
  if (!Aether.state.ban?.banned) return "";
  return `
    <div class="ban-overlay" role="dialog" aria-modal="true">
      <div class="ban-modal">
        <h2>You are permanently banned from Aether AI for breaking the TOS.</h2>
      </div>
    </div>
  `;
}

function renderReportPopup() {
  const report = Aether.state.reportPopup;
  if (!report) return "";
  const reasons = [
    "Wrong or misleading answer",
    "Unsafe or harmful advice",
    "Hate or harassment",
    "Sexual content",
    "Private information",
    "Spam or low quality",
    "Other",
  ];
  return `
    <div class="report-overlay" role="dialog" aria-modal="true" aria-labelledby="report-title">
      <form class="report-modal" data-action="submit-report">
        <h2 id="report-title">What's wrong?</h2>
        <div class="report-options">
          ${reasons
            .map(
              (reason, index) => `
                <label class="report-option">
                  <input type="radio" name="reason" value="${escapeHtml(reason)}" ${index === 0 ? "checked" : ""}>
                  <span>${escapeHtml(reason)}</span>
                </label>
              `,
            )
            .join("")}
        </div>
        <textarea name="details" data-report-details placeholder="Tell us what happened."></textarea>
        <div class="modal-actions">
          <button type="button" class="secondary-button" data-action="close-report">Cancel</button>
          <button type="submit" class="primary-button">Submit report</button>
        </div>
      </form>
    </div>
  `;
}

function renderAccountModal() {
  if (!Aether.state.accountModal) return "";
  const isRegister = Aether.state.accountModal === "register";
  const account = Aether.state.account;
  return `
    <div class="account-overlay" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <div class="account-modal">
        <button class="modal-close" type="button" data-action="close-account" aria-label="Close">X</button>
        ${
          account
            ? `
              <h2 id="account-title">${escapeHtml(account.displayName || account.username)}</h2>
              <p class="account-subtitle">${account.isAdmin ? "Admin account" : "Signed in account"}</p>
              <div class="account-card-row">
                <span>Username</span>
                <strong>${escapeHtml(account.username)}</strong>
              </div>
              <div class="modal-actions">
                <button class="secondary-button" type="button" data-action="logout-account">Sign out</button>
              </div>
            `
            : `
              <h2 id="account-title">${isRegister ? "Create account" : "Sign in"}</h2>
              <p class="account-subtitle">Accounts are optional. You can keep using Aether as a guest.</p>
              ${Aether.state.accountError ? `<p class="account-error">${escapeHtml(Aether.state.accountError)}</p>` : ""}
              <form class="account-form" data-action="${isRegister ? "register-account" : "login-account"}">
                ${isRegister ? `<input name="displayName" placeholder="Display name" autocomplete="name">` : ""}
                <input name="username" placeholder="Username" autocomplete="username">
                <input name="password" type="password" placeholder="Password" autocomplete="${isRegister ? "new-password" : "current-password"}">
                <button class="primary-button" type="submit">${isRegister ? "Create account" : "Sign in"}</button>
              </form>
              <button class="link-button" type="button" data-action="${isRegister ? "show-login" : "show-register"}">
                ${isRegister ? "I already have an account" : "Create a new account"}
              </button>
            `
        }
      </div>
    </div>
  `;
}

function renderAdminPage() {
  const data = Aether.state.adminData;
  const reports = filteredAdminReports(data?.reports || []);
  const stats = data?.stats || {};
  const bannedUsers = data?.bannedUsers || {};
  const bannedMacs = data?.bannedMacs || {};
  const adminMacs = data?.adminMacs || {};
  const adminIps = data?.adminIps || {};
  const accounts = data?.accounts || [];
  const adminAccounts = accounts.filter((account) => account.isAdmin);
  const bannedTotal = Number(stats.bannedUsers || 0) + Number(stats.bannedMacs || 0);
  const adminIdentityTotal = Number(stats.adminMacs || 0) + Number(stats.adminAccounts || 0);
  return `
    <main class="admin-page">
      <div class="animated-bg">
        <span></span><span></span><span></span>
      </div>
      <header class="admin-header">
        <div>
          <h1>Admin</h1>
          <p>${escapeHtml(data?.client?.ip || "Checking access")} ${data?.client?.mac ? `· ${escapeHtml(data.client.mac)}` : ""}</p>
        </div>
        <div class="admin-header-actions">
          <button class="secondary-button" data-action="refresh-admin">Refresh</button>
          <button class="danger-button" data-action="clear-ignored">Clear ignored</button>
          <button class="secondary-button" data-action="reset-rate-limits">Reset limits</button>
        </div>
      </header>
      ${Aether.state.adminLoading ? `<div class="admin-empty">Loading reports...</div>` : ""}
      <section class="admin-stats">
        <div><strong>${Number(stats.openReports || 0)}</strong><span>Open reports</span></div>
        <div><strong>${Number(stats.totalReports || 0)}</strong><span>Total reports</span></div>
        <div><strong>${bannedTotal}</strong><span>Banned IPs/MACs</span></div>
        <div><strong>${adminIdentityTotal}</strong><span>Admin MACs/accounts</span></div>
        <div><strong>${Number(stats.adminIps || 0)}</strong><span>Admin IPs</span></div>
        <div><strong>${Number(stats.accounts || 0)}</strong><span>Accounts</span></div>
      </section>
      <section class="admin-panel">
        <h2>Give admin</h2>
        <div class="manual-grid">
          <form class="manual-form" data-action="grant-admin-user">
            <label>Give admin by username</label>
            <input name="username" placeholder="username" autocomplete="off">
            <button class="primary-button" type="submit">Give admin</button>
          </form>
          <form class="manual-form" data-action="grant-admin-mac">
            <label>Give admin by MAC</label>
            <input name="value" placeholder="10:FF:E0:3F:09:F5" autocomplete="off">
            <input name="note" placeholder="Note" autocomplete="off">
            <button class="primary-button" type="submit">Give admin</button>
          </form>
          <form class="manual-form" data-action="grant-admin-ip">
            <label>Give admin by IP</label>
            <input name="value" placeholder="127.0.0.1" autocomplete="off">
            <input name="note" placeholder="Note" autocomplete="off">
            <button class="primary-button" type="submit">Give admin</button>
          </form>
        </div>
      </section>
      <section class="admin-panel">
        <h2>Manual moderation</h2>
        <div class="manual-grid">
          <form class="manual-form" data-action="manual-ban-ip">
            <label>Ban IP</label>
            <input name="ip" placeholder="127.0.0.1" autocomplete="off">
            <input name="reason" placeholder="Reason" autocomplete="off">
            <button class="danger-button" type="submit">Ban IP</button>
          </form>
          <form class="manual-form" data-action="manual-ban-mac">
            <label>Ban MAC</label>
            <input name="mac" placeholder="10:FF:E0:3F:09:F5" autocomplete="off">
            <input name="reason" placeholder="Reason" autocomplete="off">
            <button class="danger-button" type="submit">Ban MAC</button>
          </form>
        </div>
        <div class="admin-recent">
          <span>Recent IPs: ${escapeHtml((data?.recent?.ips || []).join(", ") || "none")}</span>
          <span>Recent MACs: ${escapeHtml((data?.recent?.macs || []).join(", ") || "none")}</span>
        </div>
      </section>
      <section class="admin-panel">
        <div class="admin-panel-head">
          <h2>Reports</h2>
          <div class="admin-filters">
            <input data-action="admin-search" value="${escapeHtml(Aether.state.adminSearch)}" placeholder="Search reports, IPs, MACs">
            <select data-action="admin-status-filter">
              <option value="open" ${Aether.state.adminStatusFilter === "open" ? "selected" : ""}>Open</option>
              <option value="ignored" ${Aether.state.adminStatusFilter === "ignored" ? "selected" : ""}>Ignored</option>
              <option value="all" ${Aether.state.adminStatusFilter === "all" ? "selected" : ""}>All</option>
            </select>
          </div>
        </div>
        ${reports.length ? reports.map(renderAdminReport).join("") : `<div class="admin-empty">No reports yet.</div>`}
      </section>
      <section class="admin-panel">
        <h2>Banned IPs & MACs</h2>
        <h3>Banned IPs</h3>
        ${
          Object.keys(bannedUsers).length
            ? Object.entries(bannedUsers)
                .map(
                  ([ip, info]) => `
                    <div class="ban-row">
                      <strong>${escapeHtml(ip)}</strong>
                      <span>${escapeHtml(info.reason || "Profanity ban")}</span>
                      <button class="secondary-button" data-unban-ip="${escapeHtml(ip)}">Unban</button>
                    </div>
                  `,
                )
                .join("")
            : `<div class="admin-empty">No banned IPs.</div>`
        }
        <h3>Banned MACs</h3>
        ${
          Object.keys(bannedMacs).length
            ? Object.entries(bannedMacs)
                .map(
                  ([mac, info]) => `
                    <div class="ban-row">
                      <strong>${escapeHtml(mac)}</strong>
                      <span>${escapeHtml(info.reason || "Admin MAC ban")}</span>
                      <button class="secondary-button" data-unban-mac="${escapeHtml(mac)}">Unban</button>
                    </div>
                  `,
                )
                .join("")
            : `<div class="admin-empty">No banned MACs.</div>`
        }
      </section>
      <section class="admin-panel">
        <h2>Admins</h2>
        <h3>Admin MACs & accounts</h3>
        ${
          Object.keys(adminMacs).length
            ? Object.entries(adminMacs)
                .map(
                  ([mac, info]) => `
                    <div class="ban-row">
                      <strong>${escapeHtml(mac)}</strong>
                      <span>${escapeHtml(info.note || "Admin")}</span>
                      <button class="secondary-button" data-revoke-admin-mac="${escapeHtml(mac)}" ${info.primary ? "disabled" : ""}>${info.primary ? "Primary" : "Revoke"}</button>
                    </div>
                  `,
                )
                .join("")
            : `<div class="admin-empty">No admin MACs.</div>`
        }
        ${
          adminAccounts.length
            ? adminAccounts
                .map(
                  (account) => `
                    <div class="ban-row">
                      <strong>${escapeHtml(account.displayName || account.username)}</strong>
                      <span>@${escapeHtml(account.username)} Admin account</span>
                      <button class="secondary-button" data-account-admin="${escapeHtml(account.username)}" data-admin-value="false">Remove admin</button>
                    </div>
                  `,
                )
                .join("")
            : `<div class="admin-empty">No admin accounts.</div>`
        }
        <h3>Admin IPs</h3>
        ${
          Object.keys(adminIps).length
            ? Object.entries(adminIps)
                .map(
                  ([ip, info]) => `
                    <div class="ban-row">
                      <strong>${escapeHtml(ip)}</strong>
                      <span>${escapeHtml(info.note || "Admin")}</span>
                      <button class="secondary-button" data-revoke-admin-ip="${escapeHtml(ip)}">Revoke</button>
                    </div>
                  `,
                )
                .join("")
            : `<div class="admin-empty">No admin IPs.</div>`
        }
      </section>
      <section class="admin-panel">
        <h2>Accounts</h2>
        ${
          accounts.length
            ? accounts
                .map(
                  (account) => `
                    <div class="ban-row">
                      <strong>${escapeHtml(account.displayName || account.username)}</strong>
                      <span>@${escapeHtml(account.username)} ${account.isAdmin ? "Admin" : "User"}</span>
                      <button class="secondary-button" data-account-admin="${escapeHtml(account.username)}" data-admin-value="${account.isAdmin ? "false" : "true"}">
                        ${account.isAdmin ? "Remove admin" : "Make admin"}
                      </button>
                      <button class="danger-button" data-delete-account="${escapeHtml(account.username)}">Delete</button>
                    </div>
                  `,
                )
                .join("")
            : `<div class="admin-empty">No accounts yet.</div>`
        }
      </section>
    </main>
  `;
}

function renderAdminReport(report) {
  const isOpen = report.status === "open";
  return `
    <article class="admin-report ${isOpen ? "" : "ignored"}">
      <div class="report-topline">
        <strong>${escapeHtml(report.reason || "Report")}</strong>
        <span>${escapeHtml(report.createdAt || "")}</span>
      </div>
      <p>${escapeHtml(report.messageContent || "No message content saved.")}</p>
      ${report.details ? `<p class="report-detail">${escapeHtml(report.details)}</p>` : ""}
      <div class="report-meta">
        <span>User: ${escapeHtml(report.reporterUsername || "guest")}</span>
        <span>IP: ${escapeHtml(report.reporterIp || "unknown")}</span>
        <span>MAC: ${escapeHtml(report.reporterMac || "unknown")}</span>
        <span>Chat: ${escapeHtml(report.chatTitle || "Untitled")}</span>
        <span>Status: ${escapeHtml(report.status || "open")}</span>
      </div>
      <div class="admin-actions">
        <button class="secondary-button" data-ignore-report="${escapeHtml(report.id)}" ${isOpen ? "" : "disabled"}>Ignore</button>
        <button class="secondary-button" data-delete-report="${escapeHtml(report.id)}">Delete</button>
        <button class="danger-button" data-ban-ip="${escapeHtml(report.reporterIp || "")}" ${report.reporterIp ? "" : "disabled"}>Ban IP</button>
        <button class="danger-button" data-ban-mac="${escapeHtml(report.reporterMac || "")}" ${report.reporterMac ? "" : "disabled"}>Ban MAC</button>
      </div>
    </article>
  `;
}

function filteredAdminReports(reports) {
  const query = Aether.state.adminSearch.trim().toLowerCase();
  return reports.filter((report) => {
    const statusMatch = Aether.state.adminStatusFilter === "all" || report.status === Aether.state.adminStatusFilter;
    if (!statusMatch) return false;
    if (!query) return true;
    return [
      report.reason,
      report.details,
      report.messageContent,
      report.reporterIp,
      report.reporterMac,
      report.reporterUsername,
      report.chatTitle,
      report.status,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function bindEvents(root) {
  root.querySelector("[data-action='home']")?.addEventListener("click", () => {
    Aether.state.adminView = false;
    render();
  });
  root.querySelector("[data-action='login-account']")?.addEventListener("submit", loginAccount);
  root.querySelector("[data-action='register-account']")?.addEventListener("submit", registerAccount);

  root.querySelector("[data-action='admin-view']")?.addEventListener("click", () => {
    Aether.state.adminView = true;
    render();
    loadAdminData();
  });

  root.querySelector("[data-action='new-chat']")?.addEventListener("click", () => {
    const chat = createChat("New conversation");
    Aether.state.chats.unshift(chat);
    Aether.state.activeChatId = chat.id;
    Aether.state.adminView = false;
    storage.save();
    render();
  });

  root.querySelectorAll("[data-chat-id]").forEach((button) => {
    button.addEventListener("click", () => {
      Aether.state.activeChatId = button.dataset.chatId;
      Aether.state.adminView = false;
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

  root.querySelector("[data-action='send-message']")?.addEventListener("submit", sendMessage);
  root.querySelector("[data-action='toggle-mic']")?.addEventListener("click", toggleMic);
  root.querySelector("[data-action='close-warning']")?.addEventListener("click", () => {
    Aether.state.warningPopup = null;
    render();
  });
  root.querySelector("[data-action='close-short-message']")?.addEventListener("click", () => {
    Aether.state.shortMessagePopup = false;
    render();
  });
  root.querySelector("[data-action='close-rate-limit']")?.addEventListener("click", () => {
    Aether.state.rateLimitPopup = false;
    render();
  });
  root.querySelectorAll("[data-report-message]").forEach((button) => {
    button.addEventListener("click", () => openReportPopup(button.dataset.reportMessage));
  });
  root.querySelector("[data-action='close-report']")?.addEventListener("click", () => {
    Aether.state.reportPopup = null;
    render();
  });
  root.querySelector("[data-action='submit-report']")?.addEventListener("submit", submitReport);
  root.querySelectorAll("input[name='reason']").forEach((input) => {
    input.addEventListener("change", () => syncReportDetails(input.form));
  });
  syncReportDetails(root.querySelector("[data-action='submit-report']"));
  root.querySelector("[data-action='refresh-admin']")?.addEventListener("click", loadAdminData);
  root.querySelector("[data-action='clear-ignored']")?.addEventListener("click", () => clearReports("ignored"));
  root.querySelector("[data-action='reset-rate-limits']")?.addEventListener("click", resetRateLimits);
  root.querySelector("[data-action='admin-search']")?.addEventListener("input", (event) => {
    Aether.state.adminSearch = event.currentTarget.value;
    render();
  });
  root.querySelector("[data-action='admin-status-filter']")?.addEventListener("change", (event) => {
    Aether.state.adminStatusFilter = event.currentTarget.value;
    render();
  });
  root.querySelector("[data-action='manual-ban-ip']")?.addEventListener("submit", manualBanIp);
  root.querySelector("[data-action='manual-ban-mac']")?.addEventListener("submit", manualBanMac);
  root.querySelector("[data-action='grant-admin-user']")?.addEventListener("submit", grantAdminUser);
  root.querySelector("[data-action='grant-admin-mac']")?.addEventListener("submit", (event) => grantAdmin(event, "mac"));
  root.querySelector("[data-action='grant-admin-ip']")?.addEventListener("submit", (event) => grantAdmin(event, "ip"));
  root.querySelectorAll("[data-ignore-report]").forEach((button) => {
    button.addEventListener("click", () => updateReport(button.dataset.ignoreReport, "ignored"));
  });
  root.querySelectorAll("[data-delete-report]").forEach((button) => {
    button.addEventListener("click", () => deleteReport(button.dataset.deleteReport));
  });
  root.querySelectorAll("[data-ban-ip]").forEach((button) => {
    button.addEventListener("click", () => banIp(button.dataset.banIp));
  });
  root.querySelectorAll("[data-ban-mac]").forEach((button) => {
    button.addEventListener("click", () => banMac(button.dataset.banMac));
  });
  root.querySelectorAll("[data-unban-ip]").forEach((button) => {
    button.addEventListener("click", () => unbanIp(button.dataset.unbanIp));
  });
  root.querySelectorAll("[data-unban-mac]").forEach((button) => {
    button.addEventListener("click", () => unbanMac(button.dataset.unbanMac));
  });
  root.querySelectorAll("[data-revoke-admin-mac]").forEach((button) => {
    button.addEventListener("click", () => revokeAdmin("mac", button.dataset.revokeAdminMac));
  });
  root.querySelectorAll("[data-revoke-admin-ip]").forEach((button) => {
    button.addEventListener("click", () => revokeAdmin("ip", button.dataset.revokeAdminIp));
  });
  root.querySelectorAll("[data-account-admin]").forEach((button) => {
    button.addEventListener("click", () => setAccountAdmin(button.dataset.accountAdmin, button.dataset.adminValue === "true"));
  });
  root.querySelectorAll("[data-delete-account]").forEach((button) => {
    button.addEventListener("click", () => deleteAccount(button.dataset.deleteAccount));
  });
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

async function sendMessage(event) {
  event.preventDefault();
  if (Aether.state.thinking) return;

  const form = event.currentTarget;
  const input = form.elements.message;
  const text = input.value.trim();
  if (!text) return;
  if (!hasMinimumLetters(text)) {
    Aether.state.shortMessagePopup = true;
    render();
    return;
  }
  if (isRateLimited()) {
    Aether.state.rateLimitPopup = true;
    render();
    return;
  }
  if (handleLocalProfanity(text)) {
    input.value = "";
    return;
  }

  input.value = "";
  await sendTextMessage(text);
}

async function sendTextMessage(text) {
  if (Aether.state.thinking) return;
  if (Aether.state.ban?.banned) return;
  if (!hasMinimumLetters(text)) {
    Aether.state.shortMessagePopup = true;
    render();
    return;
  }
  if (isRateLimited()) {
    Aether.state.rateLimitPopup = true;
    render();
    return;
  }
  if (handleLocalProfanity(text)) return;

  const chat = activeChat();
  chat.messages.push(createMessage("user", text));
  if (chat.title === "...") chat.title = text.slice(0, 36);

  Aether.state.thinking = true;
  storage.save();
  render();

  const thinkingStartedAt = performance.now();
  const answer = await getAssistantReply(text);
  const thoughtTimeMs = performance.now() - thinkingStartedAt;
  if (answer) {
    const assistantMessage = createMessage("assistant", "", { typing: true, thoughtTimeMs });
    chat.messages.push(assistantMessage);
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
  if (Aether.config.apiEndpoint) {
    try {
      const location = await locationForWeatherRequest(text);
      const response = await fetch(Aether.config.apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8", ...authHeaders() },
        body: JSON.stringify({ message: text, chat: activeChat().messages, location }),
      });
      const data = await response.json();
      applyServerStatus(data);
      if (data.ban) {
        Aether.state.ban = data.ban;
        return "";
      }
      if (data.rateLimited) {
        Aether.state.rateLimitPopup = true;
        render();
        return "";
      }
      if (data.warning) {
        showProfanityWarning(data.warning.warnings, data.warning.banned);
        return "";
      }
      if (data.reply) return data.reply;
    } catch (error) {
      return `I could not reach ${Aether.config.apiEndpoint} from ${location.href}. ${backendLaunchMessage()}`;
    }
  }

  await wait(650);
  const lowered = text.toLowerCase();
  if (lowered.includes("time")) {
    return `It is ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
  }
  return "Call-limit reached.";
}

function handleLocalProfanity(text) {
  if (!containsProfanity(text)) return false;

  const store = window.AETHER_PROFANITY_STORE || { warnedUsers: {}, bannedUsers: {} };
  const key = "browser";
  const currentWarnings = Number(store.warnedUsers?.[key]?.warnings || 0) + 1;
  store.warnedUsers = store.warnedUsers || {};
  store.bannedUsers = store.bannedUsers || {};
  store.warnedUsers[key] = { warnings: currentWarnings, updatedAt: new Date().toISOString() };
  if (currentWarnings >= PROFANITY_LIMIT) {
    store.bannedUsers[key] = { warnings: currentWarnings, bannedAt: new Date().toISOString() };
  }
  window.AETHER_PROFANITY_STORE = store;
  showProfanityWarning(currentWarnings, currentWarnings >= PROFANITY_LIMIT);
  return true;
}

function containsProfanity(text) {
  return PROFANITY_PATTERNS.some((pattern) => pattern.test(text));
}

function showProfanityWarning(warnings, banned) {
  Aether.state.warningPopup = { warnings, banned };
  if (banned) {
    Aether.state.ban = { banned: true };
  }
  render();
}

function hasMinimumLetters(text) {
  return (text.match(/[a-zA-Z]/g) || []).length >= 2;
}

function isRateLimited() {
  const rate = Aether.state.rateLimit;
  return Boolean(rate && !rate.unlimited && Number(rate.remaining) <= 0);
}

function applyServerStatus(data) {
  if (data.rateLimit) {
    Aether.state.rateLimit = data.rateLimit;
  }
  if (data.ban) {
    Aether.state.ban = data.ban;
  }
}

async function checkAdminStatus() {
  try {
    const response = await fetch(apiUrl("/api/admin/status"), { headers: authHeaders() });
    const data = await response.json();
    applyServerStatus(data);
    Aether.state.isAdmin = Boolean(data.isAdmin);
    if (data.account) {
      Aether.state.account = data.account;
    } else if (Aether.state.accountSession) {
      Aether.state.account = null;
      Aether.state.accountSession = "";
    }
    storage.save();
    if (Aether.state.isAdmin) {
      loadAdminData();
    } else {
      render();
    }
  } catch {
    Aether.state.isAdmin = false;
  }
}

async function loginAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  let data;
  try {
    data = await postJson("/api/account/login", {
      username: form.elements.username.value,
      password: form.elements.password.value,
    });
  } catch (error) {
    Aether.state.accountError = backendUnavailableMessage();
    render();
    return;
  }
  if (!data.ok) {
    Aether.state.accountError = data.error || "Could not sign in.";
    render();
    return;
  }
  Aether.state.accountSession = data.session;
  Aether.state.account = data.account;
  Aether.state.accountModal = null;
  Aether.state.accountError = "";
  storage.save();
  await checkAdminStatus();
  render();
}

async function registerAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value;
  const password = form.elements.password.value;
  let created;
  try {
    created = await postJson("/api/account/register", {
      displayName: form.elements.displayName.value,
      username,
      password,
    });
  } catch (error) {
    Aether.state.accountError = backendUnavailableMessage();
    render();
    return;
  }
  if (!created.ok) {
    Aether.state.accountError = created.error || "Could not create account.";
    render();
    return;
  }
  const loggedIn = await postJson("/api/account/login", { username, password });
  if (!loggedIn.ok) {
    Aether.state.accountModal = "login";
    Aether.state.accountError = "Account created. Sign in to continue.";
    render();
    return;
  }
  Aether.state.accountSession = loggedIn.session;
  Aether.state.account = loggedIn.account;
  Aether.state.accountModal = null;
  Aether.state.accountError = "";
  storage.save();
  await checkAdminStatus();
  render();
}

async function logoutAccount() {
  await postJson("/api/account/logout", {});
  Aether.state.account = null;
  Aether.state.accountSession = "";
  Aether.state.accountModal = null;
  Aether.state.isAdmin = false;
  Aether.state.adminView = false;
  Aether.state.adminData = null;
  storage.save();
  await checkAdminStatus();
  render();
}

function openReportPopup(messageId) {
  const chat = activeChat();
  const message = chat?.messages.find((item) => item.id === messageId);
  if (!message) return;
  Aether.state.reportPopup = {
    messageId,
    messageContent: sanitizeAssistantText(message.content),
    chatId: chat.id,
    chatTitle: chat.title,
  };
  render();
}

async function submitReport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const reason = new FormData(form).get("reason") || "Other";
  const details = String(form.elements.details.value || "").trim();
  if (reason === "Other" && !details) {
    form.elements.details.focus();
    return;
  }

  const report = Aether.state.reportPopup;
  if (!report) return;

  await fetch(apiUrl("/api/report"), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      ...report,
      reason,
      details,
    }),
  });

  Aether.state.reportPopup = null;
  addAssistantMessage("Thanks. The report was submitted for review.");
}

function syncReportDetails(form) {
  if (!form) return;
  const selectedReason = new FormData(form).get("reason");
  form.classList.toggle("other-selected", selectedReason === "Other");
}

async function loadAdminData() {
  if (!Aether.state.isAdmin) return;
  Aether.state.adminLoading = true;
  render();
  try {
    const response = await fetch(apiUrl("/api/admin/reports"), { headers: authHeaders() });
    if (!response.ok) throw new Error("Admin access required.");
    Aether.state.adminData = await response.json();
  } catch {
    Aether.state.adminData = null;
  }
  Aether.state.adminLoading = false;
  render();
}

async function updateReport(reportId, status) {
  await postJson("/api/admin/report", { reportId, status });
  await loadAdminData();
}

async function banIp(ip) {
  if (!ip) return;
  await postJson("/api/admin/ban", { ip, reason: "Banned from admin reports" });
  await loadAdminData();
}

async function banMac(mac) {
  if (!mac) return;
  await postJson("/api/admin/ban-mac", { mac, reason: "Banned from admin reports" });
  await loadAdminData();
}

async function unbanIp(ip) {
  if (!ip) return;
  await postJson("/api/admin/unban", { ip });
  await loadAdminData();
}

async function unbanMac(mac) {
  if (!mac) return;
  await postJson("/api/admin/unban-mac", { mac });
  await loadAdminData();
}

async function deleteReport(reportId) {
  if (!reportId) return;
  await postJson("/api/admin/delete-report", { reportId });
  await loadAdminData();
}

async function clearReports(status) {
  await postJson("/api/admin/clear-reports", { status });
  await loadAdminData();
}

async function resetRateLimits() {
  await postJson("/api/admin/reset-rate-limits", {});
  await checkAdminStatus();
  await loadAdminData();
}

async function manualBanIp(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const ip = form.elements.ip.value.trim();
  if (!ip) return;
  await postJson("/api/admin/ban", { ip, reason: form.elements.reason.value.trim() || "Manual admin ban" });
  form.reset();
  await loadAdminData();
}

async function manualBanMac(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const mac = form.elements.mac.value.trim();
  if (!mac) return;
  await postJson("/api/admin/ban-mac", { mac, reason: form.elements.reason.value.trim() || "Manual admin MAC ban" });
  form.reset();
  await loadAdminData();
}

async function grantAdmin(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = form.elements.value.value.trim();
  if (!value) return;
  await postJson("/api/admin/grant", {
    type,
    value,
    note: form.elements.note.value.trim() || "Granted by admin",
  });
  form.reset();
  await loadAdminData();
}

async function revokeAdmin(type, value) {
  if (!value) return;
  await postJson("/api/admin/revoke", { type, value });
  await loadAdminData();
}

async function grantAdminUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value.trim();
  if (!username) return;
  await setAccountAdmin(username, true);
  form.reset();
}

async function setAccountAdmin(username, isAdmin) {
  await postJson("/api/admin/account-admin", { username, isAdmin });
  await loadAdminData();
}

async function deleteAccount(username) {
  if (!username) return;
  await postJson("/api/admin/delete-account", { username });
  await loadAdminData();
}

async function postJson(path, payload) {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    try {
      return await response.json();
    } catch {
      throw new Error(`Request failed with HTTP ${response.status}`);
    }
  }
  return response.json();
}

function backendUnavailableMessage() {
  return `Could not reach ${apiUrl("/api/account/login")}. ${backendLaunchMessage()}`;
}

function authHeaders() {
  return Aether.state.accountSession ? { "X-Aether-Session": Aether.state.accountSession } : {};
}

function jsonHeaders() {
  return {
    "Content-Type": "application/json",
    ...authHeaders(),
  };
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
  if (!looksLikeWeatherRequest(text) || !navigator.geolocation) return null;

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
        timeout: 8000,
        maximumAge: 600000,
      },
    );
  });
}

function looksLikeWeatherRequest(text) {
  return /\b(weather|forecast|temperature|rain|snow|humidity|wind|storm|hot|cold)\b/i.test(text);
}

function toggleMic() {
  if (Aether.state.thinking) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addAssistantMessage("Your browser does not support speech recognition. Try Chrome or Edge.");
    return;
  }

  if (speechRecognition && Aether.state.listening) {
    speechRecognition.stop();
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = "en-US";
  speechRecognition.interimResults = true;
  speechRecognition.continuous = false;

  let finalTranscript = "";
  Aether.state.listening = true;
  render();

  speechRecognition.onresult = (event) => {
    let interimTranscript = "";
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const transcript = event.results[index][0].transcript;
      if (event.results[index].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    const input = document.querySelector(".composer input");
    if (input) input.value = `${finalTranscript}${interimTranscript}`.trim();
  };

  speechRecognition.onerror = () => {
    Aether.state.listening = false;
    speechRecognition = null;
    render();
    addAssistantMessage("I could not access the microphone.");
  };

  speechRecognition.onend = () => {
    const inputValue = document.querySelector(".composer input")?.value.trim() || "";
    const transcript = finalTranscript.trim() || inputValue;
    Aether.state.listening = false;
    speechRecognition = null;
    render();
    if (transcript) sendTextMessage(transcript);
  };

  speechRecognition.start();
}

function addAssistantMessage(text) {
  activeChat().messages.push(createMessage("assistant", text));
  storage.save();
  render();
}

function createMessage(role, content, extras = {}) {
  return {
    id: createId(),
    role,
    content,
    ...extras,
  };
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function typeAssistantMessage(chat, message, fullText) {
  const row = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  const bubble = row?.querySelector(".bubble");
  const cleanText = sanitizeAssistantText(fullText);

  message.content = cleanText;

  if (bubble) {
    const wordCount = renderWordReveal(bubble, cleanText);
    scrollChatToBottom();
    await wait(Math.min(3200, wordCount * 58 + 420));
  }

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
    render();
  }, 3000);

  thoughtTimerTimeouts.set(messageId, timeoutId);
}

function formatThoughtTime(milliseconds) {
  if (milliseconds < 1000) return `${Math.max(0.1, milliseconds / 1000).toFixed(1)}s`;
  if (milliseconds < 10000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.round(milliseconds / 1000)}s`;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function renderWordReveal(container, text) {
  const parts = text.match(/\s+|\S+/g) || [text];
  let wordIndex = 0;
  container.innerHTML = parts
    .map((part) => {
      if (/^\s+$/.test(part)) return escapeHtml(part);
      const delay = wordIndex * 58;
      wordIndex += 1;
      return `<span class="fade-word" style="animation-delay: ${delay}ms">${escapeHtml(part)}</span>`;
    })
    .join("");
  return wordIndex;
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
        entry.target.classList.toggle("is-faded", opacity < 0.65);
      }
    },
    {
      root: messages,
      threshold: [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.55, 0.7, 0.85, 1],
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
    button, input { font: inherit; }
    button { cursor: pointer; }
    .app-shell {
      display: grid;
      grid-template-columns: 284px 1fr;
      height: 100%;
      background:
        radial-gradient(circle at 20% 12%, rgba(37, 99, 235, 0.32), transparent 34%),
        radial-gradient(circle at 82% 30%, rgba(14, 165, 233, 0.18), transparent 30%),
        linear-gradient(145deg, #02040a 0%, #071426 45%, #000 100%);
    }
    .animated-bg {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
    }
    .animated-bg span {
      position: absolute;
      width: 52vw;
      height: 52vw;
      min-width: 520px;
      min-height: 520px;
      border-radius: 999px;
      filter: blur(70px);
      opacity: 0.22;
      animation: drift 18s ease-in-out infinite alternate;
    }
    .animated-bg span:nth-child(1) { left: 12%; top: -18%; background: #2563eb; }
    .animated-bg span:nth-child(2) { right: -12%; top: 22%; background: #38bdf8; animation-delay: -5s; }
    .animated-bg span:nth-child(3) { left: 32%; bottom: -28%; background: #0f766e; animation-delay: -9s; }
    @keyframes drift {
      from { transform: translate3d(-3%, -2%, 0) scale(0.95); }
      to { transform: translate3d(5%, 4%, 0) scale(1.08); }
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
    .brand, .new-chat, .account-tab, .admin-tab, .chat-item, .delete-chat, .report-message, .composer button, .primary-button, .secondary-button, .danger-button, .modal-close, .link-button { border: 0; }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #fff;
      background: transparent;
      font-weight: 760;
      font-size: 18px;
      padding: 8px;
      text-align: left;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      color: #07111f;
      background: #bfdbfe;
      font-weight: 800;
    }
    .new-chat {
      height: 42px;
      border-radius: 12px;
      color: #07111f;
      background: #dbeafe;
      font-weight: 740;
    }
    .account-tab {
      display: block;
      width: 100%;
      min-height: 38px;
      border-radius: 10px;
      color: #dbeafe;
      background: rgba(191, 219, 254, 0.08);
      border: 1px solid rgba(191, 219, 254, 0.14);
      font-weight: 760;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 12px;
    }
    .account-tab:hover, .account-tab:focus-visible {
      color: #07111f;
      background: #dbeafe;
      outline: none;
    }
    .admin-tab {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 38px;
      border-radius: 10px;
      color: #dbeafe;
      background: rgba(219, 234, 254, 0.1);
      font-weight: 760;
    }
    .admin-tab.active, .admin-tab:hover, .admin-tab:focus-visible {
      color: #07111f;
      background: #bfdbfe;
      outline: none;
    }
    .chat-list {
      display: grid;
      gap: 4px;
      margin-top: 8px;
      overflow: auto;
      min-height: 0;
    }
    .rate-card {
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
      color: #f8fbff;
      font-size: 34px;
      line-height: 1;
      text-align: center;
      font-weight: 760;
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
      background: #f8fbff;
      transition: width 240ms ease;
    }
    .rate-card.unlimited .rate-track span {
      background: #bfdbfe;
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
      min-height: 40px;
      border-radius: 10px;
      overflow: hidden;
      background: transparent;
    }
    .chat-item-row.active, .chat-item-row:hover, .chat-item-row:focus-within {
      background: rgba(219, 234, 254, 0.12);
    }
    .chat-item {
      min-width: 0;
      min-height: 40px;
      color: #dbeafe;
      background: transparent;
      text-align: left;
      padding: 0 8px 0 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      max-width: 980px;
      width: 100%;
      margin: 0 auto;
    }
    .topbar h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0;
    }
    .messages {
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
    .report-message {
      width: 26px;
      height: 22px;
      border-radius: 7px;
      color: rgba(219, 234, 254, 0.68);
      background: rgba(7, 17, 31, 0.48);
      font-size: 14px;
      line-height: 1;
      opacity: 0.72;
      transition: opacity 150ms ease, color 150ms ease, background 150ms ease, transform 150ms ease;
    }
    .report-message:hover, .report-message:focus-visible {
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
    .composer {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 10px;
      width: min(820px, 100%);
      margin: 0 auto;
      padding: 8px;
      border-radius: 28px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      background: rgba(5, 10, 20, 0.92);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
    }
    .composer input {
      height: 42px;
      border: 0;
      outline: 0;
      color: #fff;
      background: transparent;
      padding: 0 14px;
    }
    .composer button {
      min-width: 76px;
      border-radius: 22px;
      color: #07111f;
      background: #bfdbfe;
      font-weight: 800;
    }
    .composer .mic-button {
      min-width: 56px;
      color: #dbeafe;
      background: rgba(191, 219, 254, 0.12);
      border: 1px solid rgba(191, 219, 254, 0.2);
    }
    .composer .mic-button:hover {
      color: #fff;
      background: rgba(191, 219, 254, 0.18);
    }
    .composer .mic-button.listening {
      color: #07111f;
      background: #c7cbd3;
      animation: micPulse 900ms ease-in-out infinite;
    }
    @keyframes micPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(199, 203, 211, 0.26); }
      50% { box-shadow: 0 0 0 7px rgba(199, 203, 211, 0); }
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
    .ban-overlay {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.82);
      backdrop-filter: blur(14px);
    }
    .ban-modal {
      width: min(620px, 100%);
      border: 1px solid rgba(248, 113, 113, 0.28);
      border-radius: 20px;
      background: linear-gradient(145deg, rgba(47, 8, 16, 0.96), rgba(2, 6, 23, 0.98));
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.62);
      padding: 34px;
      text-align: center;
    }
    .ban-modal h2 {
      margin: 0;
      color: #fff;
      font-size: clamp(26px, 4vw, 42px);
      line-height: 1.12;
      letter-spacing: 0;
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
    .account-overlay {
      position: fixed;
      inset: 0;
      z-index: 24;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.58);
      backdrop-filter: blur(10px);
      animation: warningFade 180ms ease-out both;
    }
    .account-modal {
      position: relative;
      width: min(420px, 100%);
      border-radius: 20px;
      border: 1px solid rgba(191, 219, 254, 0.28);
      background: linear-gradient(145deg, rgba(7, 20, 38, 0.98), rgba(2, 6, 23, 0.98));
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.5);
      padding: 26px;
      color: #f8fbff;
      animation: warningPop 220ms ease-out both;
    }
    .account-modal h2 {
      margin: 0;
      font-size: 26px;
      letter-spacing: 0;
    }
    .account-subtitle {
      margin: 8px 0 18px;
      color: #bfdbfe;
      line-height: 1.45;
    }
    .modal-close {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 30px;
      height: 30px;
      border-radius: 9px;
      color: #dbeafe;
      background: rgba(191, 219, 254, 0.1);
    }
    .modal-close:hover, .modal-close:focus-visible {
      color: #07111f;
      background: #dbeafe;
      outline: none;
    }
    .account-form {
      display: grid;
      gap: 10px;
    }
    .account-form input {
      height: 42px;
      border: 1px solid rgba(191, 219, 254, 0.22);
      border-radius: 12px;
      outline: none;
      color: #fff;
      background: rgba(2, 6, 23, 0.72);
      padding: 0 12px;
    }
    .account-form input:focus {
      border-color: rgba(191, 219, 254, 0.72);
      box-shadow: 0 0 0 3px rgba(191, 219, 254, 0.12);
    }
    .account-error {
      margin: 0 0 12px;
      color: #fecaca;
      background: rgba(185, 28, 28, 0.22);
      border: 1px solid rgba(248, 113, 113, 0.28);
      border-radius: 12px;
      padding: 10px 12px;
    }
    .account-card-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 44px;
      border-radius: 12px;
      background: rgba(191, 219, 254, 0.08);
      padding: 0 12px;
      color: #bfdbfe;
    }
    .account-card-row strong {
      color: #fff;
    }
    .link-button {
      margin-top: 14px;
      color: #bfdbfe;
      background: transparent;
      font-weight: 760;
    }
    .link-button:hover, .link-button:focus-visible {
      color: #fff;
      outline: none;
    }
    .report-overlay {
      position: fixed;
      inset: 0;
      z-index: 22;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.58);
      backdrop-filter: blur(10px);
      animation: warningFade 180ms ease-out both;
    }
    .report-modal {
      width: min(520px, 100%);
      border-radius: 18px;
      border: 1px solid rgba(191, 219, 254, 0.26);
      background: rgba(7, 20, 38, 0.98);
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.5);
      padding: 24px;
      color: #f8fbff;
    }
    .report-modal h2 {
      margin: 0 0 16px;
      font-size: 24px;
      letter-spacing: 0;
    }
    .report-options {
      display: grid;
      gap: 8px;
    }
    .report-option {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 38px;
      padding: 9px 11px;
      border: 1px solid rgba(191, 219, 254, 0.18);
      border-radius: 10px;
      background: rgba(191, 219, 254, 0.08);
      color: #dbeafe;
    }
    .report-option input {
      width: 16px;
      height: 16px;
      accent-color: #bfdbfe;
    }
    .report-modal textarea {
      display: none;
      width: 100%;
      min-height: 92px;
      margin-top: 12px;
      resize: vertical;
      border: 1px solid rgba(191, 219, 254, 0.22);
      border-radius: 12px;
      outline: none;
      padding: 11px 12px;
      color: #fff;
      background: rgba(2, 6, 23, 0.72);
    }
    .report-modal.other-selected textarea {
      display: block;
    }
    .modal-actions, .admin-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 16px;
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
    .admin-page {
      position: relative;
      z-index: 1;
      height: 100vh;
      overflow-y: auto;
      padding: 28px 36px;
    }
    .admin-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      max-width: 1100px;
      margin: 0 auto 20px;
    }
    .admin-header-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .admin-header h1 {
      margin: 0;
      font-size: 28px;
    }
    .admin-header p {
      margin: 4px 0 0;
      color: #bfdbfe;
    }
    .admin-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      max-width: 1100px;
      margin: 0 auto 16px;
    }
    .admin-stats div, .admin-panel {
      border: 1px solid rgba(191, 219, 254, 0.14);
      border-radius: 14px;
      background: rgba(5, 10, 20, 0.76);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.2);
    }
    .admin-stats div {
      display: grid;
      gap: 4px;
      padding: 16px;
    }
    .admin-stats strong {
      font-size: 26px;
    }
    .admin-stats span, .report-meta, .admin-empty, .ban-row span {
      color: #bfdbfe;
    }
    .admin-panel {
      max-width: 1100px;
      margin: 0 auto 16px;
      padding: 18px;
    }
    .admin-panel h2 {
      margin: 0 0 12px;
      font-size: 20px;
    }
    .admin-panel h3 {
      margin: 14px 0 8px;
      color: #dbeafe;
      font-size: 15px;
      letter-spacing: 0;
    }
    .admin-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .admin-panel-head h2 {
      margin: 0;
    }
    .admin-filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .admin-filters input, .admin-filters select, .manual-form input {
      min-height: 38px;
      border: 1px solid rgba(191, 219, 254, 0.2);
      border-radius: 10px;
      outline: none;
      color: #fff;
      background: rgba(2, 6, 23, 0.7);
      padding: 0 11px;
    }
    .admin-filters input {
      width: min(280px, 100%);
    }
    .manual-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .manual-form {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid rgba(191, 219, 254, 0.12);
      border-radius: 12px;
      background: rgba(191, 219, 254, 0.06);
    }
    .manual-form label {
      color: #dbeafe;
      font-weight: 800;
    }
    .admin-recent {
      display: grid;
      gap: 6px;
      margin-top: 12px;
      color: #bfdbfe;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .admin-report {
      display: grid;
      gap: 10px;
      padding: 14px 0;
      border-top: 1px solid rgba(191, 219, 254, 0.12);
    }
    .admin-report.ignored {
      opacity: 0.62;
    }
    .report-topline, .report-meta, .ban-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }
    .admin-report p {
      margin: 0;
      color: #f8fbff;
      line-height: 1.45;
    }
    .admin-report .report-detail {
      color: #dbeafe;
      background: rgba(191, 219, 254, 0.08);
      border-radius: 10px;
      padding: 10px;
    }
    .report-meta {
      justify-content: flex-start;
      font-size: 13px;
    }
    .ban-row {
      min-height: 40px;
      border-top: 1px solid rgba(191, 219, 254, 0.12);
    }
    .admin-empty {
      padding: 14px 0;
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
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: fixed;
        inset: auto 14px 14px;
        z-index: 4;
        display: grid;
        grid-template-columns: 1fr auto;
        border: 1px solid rgba(191, 219, 254, 0.16);
        border-radius: 18px;
      }
      .brand, .chat-list { display: none; }
      .rate-card { display: none; }
      .chat-page { padding: 18px 16px 100px; }
      .admin-page { padding: 18px 16px 110px; }
      .admin-header, .admin-panel-head {
        align-items: stretch;
        flex-direction: column;
      }
      .admin-header-actions, .admin-filters {
        justify-content: stretch;
      }
      .admin-stats, .manual-grid {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.appendChild(style);
}

bootstrap();
