// YOKE Pi Adapter
// ---------------
// Implements the YOKE interface using @earendil-works/pi-coding-agent.
// One AgentSession per clay session; createQuery returns a long-lived handle.
// Session files live in ~/.pi/agent (shared with the pi CLI), but clay only
// lists sessions it started itself — listSessions always returns [].
//
// V1 scope: prompt, stream, abort, model, thinking. No rewind/fork/betas.

var path = require("path");
var { mapPiEvent } = require("./pi-events");

// --- SDK lazy loader (ESM) ---
var _sdkPromise = null;
function loadSDK() {
  if (!_sdkPromise) {
    _sdkPromise = import("@earendil-works/pi-coding-agent");
  }
  return _sdkPromise;
}

// Check if the pi package is available by looking for its directory on disk.
// require.resolve() fails on ESM-only packages with no CJS exports entry.
function isPiInstalled() {
  var path = require("path");
  var fs = require("fs");
  // Check relative to this file's node_modules chain
  var check = function(dir) {
    var pkgPath = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    return fs.existsSync(pkgPath);
  };
  // Walk up from this file's location
  var current = __dirname;
  for (var i = 0; i < 8; i++) {
    if (check(current)) return true;
    var parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

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

function createPiAdapter(opts) {
  var _cwd = (opts && opts.cwd) || process.cwd();
  var _services = null;

  // Build the same builtin extension factories the pi CLI loads:
  // MCP (reads mcp.json, connects servers), codemode, and tool_search.
  // Without these, MCP tools, codemode, and tool_search are all absent.
  function makeBuiltinFactories(sdk) {
    var factories = [];
    try { factories.push(sdk.createMcpExtension()); } catch (e) {
      console.warn("[pi-adapter] createMcpExtension failed:", e.message);
    }
    try { factories.push(sdk.createCodemodeExtension()); } catch (e) {
      console.warn("[pi-adapter] createCodemodeExtension failed:", e.message);
    }
    try { factories.push(sdk.createToolSearchExtension()); } catch (e) {
      console.warn("[pi-adapter] createToolSearchExtension failed:", e.message);
    }
    return factories;
  }

  // ---- init ----
  async function init(initOpts) {
    var sdk = await loadSDK();
    var cwd = (initOpts && initOpts.cwd) || _cwd;

    _services = await sdk.createAgentSessionServices({
      cwd: cwd,
      resourceLoaderOptions: { extensionFactories: makeBuiltinFactories(sdk) },
    });

    if (_services.diagnostics && _services.diagnostics.length) {
      _services.diagnostics.forEach(function(d) {
        console.log("[pi-adapter] init diagnostic [" + d.type + "]:", d.message);
      });
    }

    var models = [];
    var defaultModel = "";
    try {
      models = getFilteredModels();
      if (models.length > 0) {
        defaultModel = typeof models[0] === "string" ? models[0] : (models[0].value || "");
      }
    } catch (e) {
      console.warn("[pi-adapter] Could not list models:", e.message);
    }

    console.log("[pi-adapter] init done, " + models.length + " models, default:", defaultModel);

    return {
      models: models,
      defaultModel: defaultModel,
      skills: [],
      slashCommands: [],
      fastModeState: null,
      capabilities: {
        thinking: true,
        betas: false,
        rewind: false,
        sessionResume: true,
        promptSuggestions: false,
        elicitation: false,
        fileCheckpointing: false,
        contextCompacting: true,
        toolPolicy: ["allow-all"],
      },
    };
  }

  // Returns pi models filtered to the user's enabledModels list (if set).
  // Returns models from enabledModels setting ("provider/id" strings).
  // Extension-registered providers (kiro, deepseek) only load inside a
  // session, not at service-creation time, so we use settings directly
  // rather than modelRuntime.getModels().
  function getFilteredModels() {
    if (!_services) return [];
    try {
      var settings = _services.settingsManager.getSettings();
      var enabled = settings && settings.enabledModels;
      if (enabled && enabled.length > 0) {
        return enabled.map(function(entry) {
          // entry is already "provider/model-id"
          var parts = entry.split("/");
          var modelId = parts.slice(1).join("/") || entry;
          // Try to get display name from modelRuntime for known built-in models
          var displayName = modelId;
          try {
            var m = _services.modelRuntime.getModel(parts[0], modelId);
            if (m && m.name) displayName = m.name;
          } catch (e) {}
          return { value: entry, displayName: displayName };
        });
      }
      // Fallback: all models known at init time
      var allModels = _services.modelRuntime.getModels();
      return allModels.map(function(m) {
        return { value: m.provider + "/" + m.id, displayName: m.name || m.id };
      });
    } catch (e) {
      console.warn("[pi-adapter] getFilteredModels failed:", e.message);
      return [];
    }
  }

  // ---- supportedModels ----
  async function supportedModels() {
    return getFilteredModels();
  }

  // ---- createToolServer (stub) ----
  function createToolServer(def) {
    console.warn("[pi-adapter] createToolServer not implemented (pi uses native MCP)");
    return null;
  }

  // ---- createQuery ----
  function createQuery(queryOpts) {
    queryOpts = queryOpts || {};
    var cwd = queryOpts.cwd || _cwd;
    var resumeFile = queryOpts.piSessionFile || null;

    var mq = createMessageQueue();
    var _localSession = null;
    var _savedSession = null; // kept alive after close() for disposeSession()
    var _localUnsubscribe = null;
    var _closed = false;
    var _sessionState = { blockIds: {}, toolCallMeta: {} };
    var _bootPromise = null;
    var _sessionFileCallback = null;
    var _lastCost = 0;  // for cost delta calculation
    var _idleTimer = null;
    var PI_IDLE_MS = 10 * 60 * 1000; // 10 min, matches pi-web default

    function resetIdleTimer() {
      if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    }

    function scheduleIdleDispose() {
      resetIdleTimer();
      _idleTimer = setTimeout(function() {
        _idleTimer = null;
        if (!_closed && _savedSession) {
          console.log("[pi-adapter] idle timeout, disposing session");
          handle.disposeSession("quit").catch(function(e) {
            console.warn("[pi-adapter] idle disposeSession failed:", e.message || e);
          });
        }
      }, PI_IDLE_MS);
    }

    function boot() {
      if (_bootPromise) return _bootPromise;
      _bootPromise = (async function() {
        var sdk = await loadSDK();

        // Ensure services for this cwd
        if (!_services || _services.cwd !== cwd) {
          _services = await sdk.createAgentSessionServices({
            cwd: cwd,
            resourceLoaderOptions: { extensionFactories: makeBuiltinFactories(sdk) },
          });
        }

        // Resolve model object if specified
        var model = null;
        if (queryOpts.model) {
          try {
            var parts = queryOpts.model.split("/");
            var providerId = parts[0];
            var modelId = parts.slice(1).join("/");
            model = _services.modelRuntime.getModel(providerId, modelId) || null;
          } catch (e) {}
        }

        // Build SessionManager: open existing file for resume, create new otherwise.
        // Do NOT pass sessionDir manually — SessionManager.create(cwd) derives the
        // correct encoding (--home-jpbragatti-tmp-clay-pi-- style) automatically,
        // matching what the pi CLI uses so sessions are shared.
        var SessionManager = sdk.SessionManager;

        var sessionManager;
        if (resumeFile) {
          try {
            sessionManager = SessionManager.open(resumeFile);
            console.log("[pi-adapter] resuming session from file:", resumeFile);
          } catch (e) {
            console.warn("[pi-adapter] Could not open session file for resume, creating new:", e.message);
            sessionManager = SessionManager.create(cwd);
          }
        } else {
          sessionManager = SessionManager.create(cwd);
        }

        var sessionOpts = {
          services: _services,
          sessionManager: sessionManager,
        };
        if (model) sessionOpts.model = model;
        if (queryOpts.thinkingLevel) sessionOpts.thinkingLevel = queryOpts.thinkingLevel;

        var result = await sdk.createAgentSessionFromServices(sessionOpts);
        _localSession = result.session;
        _savedSession = _localSession;

        // Bind minimal no-op UI context to prevent extension dialog hangs
        // bindExtensions is on the session itself (not extensionsResult)
        if (typeof _localSession.bindExtensions === "function") {
          try {
            await _localSession.bindExtensions({
              uiContext: createNoopUiContext(),
              mode: "rpc",
            });
          } catch (e) {
            console.warn("[pi-adapter] Could not bind extensions:", e.message);
          }
        }

        // Store session file path
        var piFile = _localSession.sessionFile || null;
        if (_sessionFileCallback) _sessionFileCallback(piFile);

        // Emit synthetic init
        var initEvt = mapPiEvent({ type: "agent_start" }, _sessionState, _localSession);
        if (initEvt) mq.push(initEvt);

        // Subscribe to events
        _localUnsubscribe = _localSession.subscribe(function(evt) {
          if (_closed) return;
          var mapped = mapPiEvent(evt, _sessionState, _localSession);
          if (mapped) {
            // For result events, send cost delta (not cumulative total)
            // and schedule idle dispose
            if (mapped.yokeType === "result" && typeof mapped.cost === "number") {
              var delta = mapped.cost - _lastCost;
              _lastCost = mapped.cost;
              mapped = Object.assign({}, mapped, { cost: delta > 0 ? delta : 0 });
              scheduleIdleDispose();
            }
            mq.push(mapped);
          }
        });

        console.log("[pi-adapter] session ready, file:", piFile, "id:", _localSession.sessionId);
      })();
      return _bootPromise;
    }

    var handle = {
      [Symbol.asyncIterator]: function() {
        boot().catch(function(e) {
          console.error("[pi-adapter] Boot failed:", e.message || e);
          mq.push({
            yokeType: "result",
            cost: 0,
            usage: null,
            duration: null,
            subtype: "error_during_execution",
            errors: [e.message || String(e)],
          });
          mq.end();
        });
        return mq[Symbol.asyncIterator]();
      },

      pushMessage: async function(text, images) {
        resetIdleTimer(); // cancel idle dispose when a new message arrives
        await boot();
        if (!_localSession) return;
        var imgs = (images && images.length) ? images : [];
        if (_localSession.isStreaming) {
          await _localSession.followUp(text, imgs, { source: "rpc" });
        } else {
          await _localSession.prompt(text, { images: imgs, source: "rpc" });
        }
      },

      setModel: async function(model) {
        await boot();
        if (!_localSession || !_services) return;
        try {
          var parts = model.split("/");
          var providerId = parts[0];
          var modelId = parts.slice(1).join("/");
          var m = _services.modelRuntime.getModel(providerId, modelId);
          if (m) await _localSession.setModel(m);
        } catch (e) {
          console.warn("[pi-adapter] setModel failed:", e.message);
        }
      },

      setEffort: async function(effort) {
        await boot();
        if (!_localSession) return;
        var levelMap = {
          "off": "off", "minimal": "minimal", "low": "low",
          "medium": "medium", "high": "high", "xhigh": "xhigh",
          "max": "max", "auto": "medium", "extended": "high",
        };
        var level = levelMap[effort] || "medium";
        try { _localSession.setThinkingLevel(level); } catch (e) {
          console.warn("[pi-adapter] setEffort failed:", e.message);
        }
      },

      setToolPolicy: async function(policy) {
        // Pi always allow-all in v1
      },

      stopTask: async function(taskId) {
        if (!_localSession) return;
        try { await _localSession.abort(); } catch (e) {}
      },

      getContextUsage: async function() {
        if (!_localSession) return null;
        try {
          var usage = _localSession.getContextUsage();
          if (!usage) return null;
          return {
            percent: usage.percent != null ? usage.percent : null,
            contextWindow: usage.contextWindow || 0,
            tokens: usage.tokens || null,
          };
        } catch (e) { return null; }
      },

      abort: async function() {
        if (!_localSession) return;
        try { await _localSession.abort(); } catch (e) {}
      },

      close: function() {
        _closed = true;
        resetIdleTimer();
        if (_localUnsubscribe) { try { _localUnsubscribe(); } catch (e) {} }
        // Don't dispose here — sdk-bridge calls close() between turns but
        // reuses the session. Dispose happens via disposeSession().
        mq.end();
      },

      // Called when the clay session is permanently destroyed (daemon shutdown,
      // delete_session). Fires session_shutdown so pi extensions (e.g. claude-mem)
      // can summarize, then disposes the AgentSession.
      disposeSession: async function(reason) {
        var sess = _savedSession;
        if (!sess) return;
        _savedSession = null;
        _localSession = null;
        _closed = true;
        resetIdleTimer();
        if (_localUnsubscribe) { try { _localUnsubscribe(); } catch (e) {} }
        mq.end();
        try {
          var runner = sess.extensionRunner;
          if (runner && typeof runner.emit === "function") {
            await runner.emit({ type: "session_shutdown", reason: reason || "quit" });
          }
        } catch (e) {
          console.warn("[pi-adapter] session_shutdown emit failed:", e.message);
        }
        try { sess.dispose(); } catch (e) {}
      },

      onSessionFile: function(cb) { _sessionFileCallback = cb; },
      getPiSessionFile: function() {
        return _localSession ? (_localSession.sessionFile || null) : null;
      },
    };

    return handle;
  }

  // ---- Session management ----
  async function listSessions() { return []; }

  async function getSessionInfo(sessionId) {
    return { id: sessionId, title: null };
  }

  async function renameSession(sessionId, title) {}

  async function forkSession() {
    throw new Error("[pi-adapter] forkSession not supported in v1");
  }

  async function generateTitle(messages) {
    if (messages && messages.length > 0) {
      var text = String(messages[0] || "");
      return text.substring(0, 40).trim() || "Pi session";
    }
    return "Pi session";
  }

  return {
    vendor: "pi",
    init: init,
    supportedModels: supportedModels,
    createToolServer: createToolServer,
    createQuery: createQuery,
    listSessions: listSessions,
    getSessionInfo: getSessionInfo,
    renameSession: renameSession,
    forkSession: forkSession,
    generateTitle: generateTitle,
  };
}

module.exports = { createPiAdapter: createPiAdapter, isPiInstalled: isPiInstalled };
