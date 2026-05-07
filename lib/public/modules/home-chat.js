// Home Chat (Clay) — phablet-style chat embedded in the home hub.
// Self-contained: own DOM, own renderer, own WS protocol.
// Talks to the user's Clay mate session via home_clay_* messages.
// Does not interfere with the active project session.

import { escapeHtml } from './utils.js';
import { getWs } from './ws-ref.js';
import { renderMarkdown } from './markdown.js';
import { refreshIcons } from './icons.js';
import { switchProject } from './app-projects.js';

var initialized = false;
var messagesEl = null;
var inputEl = null;
var sendBtn = null;
var typingEl = null;
var newBtnEl = null;

// Per-turn assembly state. Server may emit many delta events for a single
// assistant turn; we accumulate text and render incrementally into the
// last bubble.
var currentAssistantBubble = null;
var currentAssistantText = "";
var lastSenderWasUser = false;

// Initialize on first showHomeHub. The init function is exposed on
// window.__initHomeChat so app-home-hub.js (which already imports too
// many things) can call it without adding another import edge.
export function initHomeChat() {
  if (initialized) {
    // Re-mount idempotent: just ensure the WS subscription is open.
    requestSession();
    return;
  }
  initialized = true;

  messagesEl = document.getElementById("home-chat-messages");
  inputEl = document.getElementById("home-chat-input");
  sendBtn = document.getElementById("home-chat-send-btn");
  typingEl = document.getElementById("home-chat-typing");
  newBtnEl = document.getElementById("home-chat-new-btn");

  if (!messagesEl || !inputEl || !sendBtn) return;

  // --- Input handling ---
  inputEl.addEventListener("input", function () {
    autoResize();
    sendBtn.disabled = inputEl.value.trim().length === 0;
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.addEventListener("click", doSend);
  if (newBtnEl) {
    newBtnEl.addEventListener("click", function () {
      var ws = getWs();
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "home_clay_new_session" }));
      messagesEl.innerHTML = "";
      currentAssistantBubble = null;
      currentAssistantText = "";
      lastSenderWasUser = false;
      hideTyping();
      addSystemBubble("New conversation started.");
    });
  }

  // --- Initial state pull ---
  requestSession();
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(140, inputEl.scrollHeight) + "px";
}

function requestSession() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "home_clay_open" }));
}

function doSend() {
  var text = inputEl.value.trim();
  if (!text) return;
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;

  // Optimistic render of the user's message.
  addUserBubble(text);
  inputEl.value = "";
  autoResize();
  sendBtn.disabled = true;

  ws.send(JSON.stringify({ type: "home_clay_send", text: text }));
  showTyping();
}

// --- Rendering ---

function addUserBubble(text) {
  // Finalize any open assistant bubble before adding the next user turn.
  finalizeAssistant();
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-user";
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
  lastSenderWasUser = true;
}

function ensureAssistantBubble() {
  if (currentAssistantBubble) return currentAssistantBubble;
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-clay";
  messagesEl.appendChild(bubble);
  currentAssistantBubble = bubble;
  currentAssistantText = "";
  lastSenderWasUser = false;
  return bubble;
}

function appendAssistantText(text) {
  var bubble = ensureAssistantBubble();
  currentAssistantText += text;
  // Render markdown + linkify session refs after sanitization.
  bubble.innerHTML = linkifyRefs(renderMarkdown(currentAssistantText));
  scrollToBottom();
}

function finalizeAssistant() {
  if (currentAssistantBubble && !currentAssistantText) {
    // Empty assistant turn (no text produced). Drop the empty bubble.
    currentAssistantBubble.remove();
  }
  currentAssistantBubble = null;
  currentAssistantText = "";
}

function addSystemBubble(text) {
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-system";
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
}

// Convert [project-slug/sess_xxx — date] tokens in the rendered HTML
// into clickable chips. Server-side Clay is instructed to emit these.
function linkifyRefs(html) {
  // Match [slug/sess_id - date] inside text but not inside HTML attributes.
  // Conservative: the slug is alphanumeric/-/_, sess id starts with sess_.
  var re = /\[([a-zA-Z0-9_\-]+)\/(sess_[a-zA-Z0-9_\-]+)(?:\s+[—-]\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\]/g;
  return html.replace(re, function (_full, slug, sessId, date) {
    var label = slug + "/" + sessId.substring(0, 14) + (date ? " · " + date : "");
    return '<span class="home-chat-ref" data-slug="' + escapeHtml(slug) + '" data-session="' + escapeHtml(sessId) + '">' + escapeHtml(label) + '</span>';
  });
}

function scrollToBottom() {
  if (!messagesEl) return;
  // Always pin: home chat is short, no need for scroll-up detection.
  requestAnimationFrame(function () {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function showTyping() {
  if (typingEl) typingEl.classList.remove("hidden");
}
function hideTyping() {
  if (typingEl) typingEl.classList.add("hidden");
}

// --- Server message handlers (called from app-messages.js dispatcher) ---

export function handleHomeClayHistory(msg) {
  if (!messagesEl) return;
  messagesEl.innerHTML = "";
  currentAssistantBubble = null;
  currentAssistantText = "";
  hideTyping();
  var entries = msg.messages || [];
  if (entries.length === 0) {
    addSystemBubble("Hi — I'm Clay. I can search every session, project, and decision in your workspace. What are you trying to find?");
    return;
  }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.role === "user") {
      addUserBubble(e.text || "");
    } else if (e.role === "assistant") {
      // Replay finalized assistant text in one shot.
      appendAssistantText(e.text || "");
      finalizeAssistant();
    }
  }
}

export function handleHomeClayDelta(msg) {
  hideTyping();
  if (typeof msg.text === "string") appendAssistantText(msg.text);
}

export function handleHomeClayDone() {
  hideTyping();
  finalizeAssistant();
}

export function handleHomeClayError(msg) {
  hideTyping();
  finalizeAssistant();
  addSystemBubble("Error: " + (msg.text || "unknown"));
}

// --- Click delegation for session ref chips ---

document.addEventListener("click", function (e) {
  var chip = e.target && e.target.closest && e.target.closest(".home-chat-ref");
  if (!chip) return;
  var slug = chip.dataset.slug;
  if (!slug) return;
  // Clicking a chip jumps the user out of the home hub into the source
  // project. Session selection inside that project is up to the existing
  // session restore mechanism.
  if (typeof switchProject === "function") {
    var hubBtn = document.getElementById("home-hub-close");
    if (hubBtn) hubBtn.click();
    switchProject(slug);
  }
});

// Expose init for app-home-hub.js without adding an import edge.
if (typeof window !== "undefined") {
  window.__initHomeChat = initHomeChat;
}
