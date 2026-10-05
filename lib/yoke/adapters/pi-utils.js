// Pi adapter utilities
// --------------------
// Shared helpers extracted from pi.js to keep that module under 500 lines.

// --- Minimal no-op UI context ---
// Pi extensions (e.g. ask-advisor) may call ui.select/confirm/input.
// Without a bound UI context those calls would hang the session. We bind
// a context that auto-cancels all dialogs and logs a warning instead.
function createNoopUiContext() {
  function noop() { return Promise.resolve(undefined); }
  return {
    select: function(title) {
      console.warn("[pi-adapter] Extension dialog 'select' suppressed:", title);
      return Promise.resolve(undefined);
    },
    confirm: function(title) {
      console.warn("[pi-adapter] Extension dialog 'confirm' suppressed:", title);
      return Promise.resolve(false);
    },
    input: function(title) {
      console.warn("[pi-adapter] Extension dialog 'input' suppressed:", title);
      return Promise.resolve(undefined);
    },
    editor: function(title) {
      console.warn("[pi-adapter] Extension dialog 'editor' suppressed:", title);
      return Promise.resolve(undefined);
    },
    notify: function(message, type) {
      console.log("[pi-adapter] Extension notify [" + (type || "info") + "]:", message);
    },
    onTerminalInput: function() { return function() {}; },
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: noop,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: function() { return ""; },
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: function() { return undefined; },
    theme: {},
    getAllThemes: function() { return []; },
    getTheme: function() { return undefined; },
    setTheme: function() { return { success: false }; },
    getToolsExpanded: function() { return false; },
    setToolsExpanded: noop,
  };
}

// --- Async message queue ---
// A simple push/end/asyncIterator queue used by the pi adapter to bridge
// pi AgentSession events into the sdk-bridge for-await consumer loop.
function createMessageQueue() {
  var queue = [];
  var waiting = null;
  var ended = false;
  return {
    push: function(msg) {
      if (ended) return;
      if (waiting) {
        var resolve = waiting;
        waiting = null;
        resolve({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    end: function() {
      ended = true;
      if (waiting) {
        var resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function(resolve) { waiting = resolve; });
        },
      };
    },
  };
}

module.exports = { createNoopUiContext: createNoopUiContext, createMessageQueue: createMessageQueue };
