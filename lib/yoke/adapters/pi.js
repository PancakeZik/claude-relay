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
var { createNoopUiContext, createMessageQueue } = require("./pi-utils");

// --- SDK lazy loader (ESM) ---
// Resolve the absolute path to the package entry point at load time.
// ESM dynamic import() cannot find globally-installed (e.g. nvm) packages
// by name, so we compute the path and import from the file URL instead.
var _sdkEntryUrl = (function() {
  var fs = require("fs");
  var url = require("url");
  // Candidates: local node_modules walk, then global via process.execPath
  var candidates = [];
  var current = __dirname;
  for (var i = 0; i < 8; i++) {
    candidates.push(path.join(current, "node_modules", "@earendil-works", "pi-coding-agent"));
    var parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.push(path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
  for (var j = 0; j < candidates.length; j++) {
    var pkgJson = path.join(candidates[j], "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        var pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
        var entry = (pkg.exports && pkg.exports["."] && (pkg.exports["."]["import"] || pkg.exports["."])) || pkg.main || "dist/index.js";
        if (typeof entry !== "string") entry = "dist/index.js";
        return url.pathToFileURL(path.join(candidates[j], entry)).href;
      } catch (e) {}
    }
  }
  return null;
})();

var _sdkPromise = null;
function loadSDK() {
  if (!_sdkPromise) {
    if (!_sdkEntryUrl) {
      _sdkPromise = Promise.reject(new Error("[pi-adapter] Cannot find @earendil-works/pi-coding-agent package"));
    } else {
      _sdkPromise = import(_sdkEntryUrl);
    }
  }
  return _sdkPromise;
}

// Check if the pi package is importable. Uses _sdkEntryUrl as the ground
// truth — same resolver that loadSDK() uses, so binary-on-PATH but
// package-not-resolvable cannot return a false positive.
function isPiInstalled() {
  return _sdkEntryUrl !== null;
}


function createPiAdapter(opts) {
  var _cwd = (opts && opts.cwd) || process.cwd();
  var _services = null;

  // Build the same builtin extension factories the pi CLI loads, as named
  // InlineExtension objects with builtin:true and replaceable:true.
  // This matches the CLI order (codemode, tool-search, mcp) and puts them in
  // DefaultResourceLoader's builtinExtensions map, so:
  //   - User extensions from settings.json packages still load alongside them
  //   - -builtin:mcp etc. in settings correctly disables the matching builtin
  //   - A user extension that replaces /mcp replaces rather than colliding
  // Filter out extensions that crash when used inside Clay (e.g. pi-cc-extensions
  // renderer, which captures ctx in session_start and fires registerTool in a
  // setTimeout after the session is replaced, triggering assertActive errors).
  function makeExtensionsOverride(base) {
    var filtered = base.extensions.filter(function(e) {
      var p = e.resolvedPath || e.path || "";
      return p.indexOf("pi-cc-extensions") === -1;
    });
    return { extensions: filtered, errors: base.errors, warnings: base.warnings, runtime: base.runtime };
  }

  function makeBuiltinFactories(sdk) {
    var defs = [
      { name: "codemode", create: function() { return sdk.createCodemodeExtension(); } },
      { name: "tool-search", create: function() { return sdk.createToolSearchExtension(); } },
      { name: "mcp", create: function() { return sdk.createMcpExtension(); } },
    ];
    var factories = [];
    for (var i = 0; i < defs.length; i++) {
      try {
        factories.push({ name: defs[i].name, factory: defs[i].create(), builtin: true, replaceable: true });
      } catch (e) {
        console.warn("[pi-adapter] " + defs[i].name + " extension failed:", e.message);
      }
    }
    return factories;
  }

  // ---- init ----
  async function init(initOpts) {
    var sdk = await loadSDK();
    var cwd = (initOpts && initOpts.cwd) || _cwd;

    _services = await sdk.createAgentSessionServices({
      cwd: cwd,
      resourceLoaderOptions: { extensionFactories: makeBuiltinFactories(sdk), extensionsOverride: makeExtensionsOverride },
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
      // Derive default from settings (defaultProvider/defaultModel)
      try {
        var settings = _services.settingsManager.getSettings();
        var dp = settings && settings.defaultProvider;
        var dm = settings && settings.defaultModel;
        if (dp && dm) {
          var candidate = dp + "/" + dm;
          // Use it if it's in the enabled list, otherwise fall back to first
          var inList = models.some(function(m) { return (typeof m === "string" ? m : m.value) === candidate; });
          defaultModel = inList ? candidate : (models.length > 0 ? (typeof models[0] === "string" ? models[0] : (models[0].value || "")) : "");
        } else if (models.length > 0) {
          defaultModel = typeof models[0] === "string" ? models[0] : (models[0].value || "");
        }
      } catch (e) {
        if (models.length > 0) defaultModel = typeof models[0] === "string" ? models[0] : (models[0].value || "");
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
    var _disposePromise = null; // memoized so close() + project.js both await the same work
    var _sessionFileCallback = null;
    var _qServices = null; // per-query services: shared _services or one-off filtered instance
    var _lastCost = 0;  // for cost delta calculation
    var _idleTimer = null;
    var _endAfterResult = false; // set by endInput() for single-turn sessions
    var PI_IDLE_MS = 5 * 60 * 1000; // 5 min idle before disposing (fires session_shutdown)

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

        // Ensure shared services for this cwd
        if (!_services || _services.cwd !== cwd) {
          _services = await sdk.createAgentSessionServices({
            cwd: cwd,
            resourceLoaderOptions: { extensionFactories: makeBuiltinFactories(sdk), extensionsOverride: makeExtensionsOverride },
          });
        }

        // For sessions with disableAllHooks, build a one-off services instance
        // that filters out claude-mem-hooks from the extension list. The shared
        // _services is left untouched so interactive sessions are unaffected.
        if (queryOpts.disableAllHooks) {
          _qServices = await sdk.createAgentSessionServices({
            cwd: cwd,
            resourceLoaderOptions: {
              extensionFactories: makeBuiltinFactories(sdk),
              extensionsOverride: function(base) {
                var filtered = base.extensions.filter(function(e) {
                  var p = e.resolvedPath || e.path || "";
                  var basename = p.split("/").pop();
                  return basename !== "claude-mem-hooks.ts" && p.indexOf("pi-cc-extensions") === -1;
                });
                var removed = base.extensions.filter(function(e) {
                  var p = e.resolvedPath || e.path || "";
                  var basename = p.split("/").pop();
                  return basename === "claude-mem-hooks.ts" || p.indexOf("pi-cc-extensions") !== -1;
                }).map(function(e) { return (e.resolvedPath || e.path || "").split("/").pop(); });
                console.log("[pi-adapter] disableAllHooks: excluded extensions:", removed.join(", ") || "(none)");
                return { extensions: filtered, errors: base.errors, warnings: base.warnings, runtime: base.runtime };
              },
            },
          });
          console.log("[pi-adapter] disableAllHooks: filtered services created (claude-mem-hooks excluded)");
        } else {
          _qServices = _services;
        }

        // Resolve model object if specified.
        // Extension-registered providers (e.g. kiro) may not be available at
        // service-creation time, so try a refresh on first miss.
        var model = null;
        if (queryOpts.model) {
          try {
            var parts = queryOpts.model.split("/");
            var providerId = parts[0];
            var modelId = parts.slice(1).join("/");
            model = _qServices.modelRuntime.getModel(providerId, modelId) || null;
            if (!model) {
              await _qServices.modelRuntime.refresh({ allowNetwork: false });
              model = _qServices.modelRuntime.getModel(providerId, modelId) || null;
            }
          } catch (e) {}
        }

        // Build SessionManager: open existing file for resume, create new otherwise.
        // Do NOT pass sessionDir manually — SessionManager.create(cwd) derives the
        // correct encoding (--home-jpbragatti-tmp-clay-pi-- style) automatically,
        // matching what the pi CLI uses so sessions are shared.
        var SessionManager = sdk.SessionManager;

        var sessionManager;
        if (resumeFile && require("fs").existsSync(resumeFile)) {
          try {
            sessionManager = SessionManager.open(resumeFile);
            console.log("[pi-adapter] resuming session from file:", resumeFile);
          } catch (e) {
            console.warn("[pi-adapter] Could not open session file for resume, creating new:", e.message);
            sessionManager = SessionManager.create(cwd);
          }
        } else {
          if (resumeFile) console.warn("[pi-adapter] Session file not found, creating new:", resumeFile);
          sessionManager = SessionManager.create(cwd);
        }

        var sessionOpts = {
          services: _qServices,
          sessionManager: sessionManager,
        };
        if (model) sessionOpts.model = model;
        if (queryOpts.thinkingLevel) sessionOpts.thinkingLevel = queryOpts.thinkingLevel;

        var result = await sdk.createAgentSessionFromServices(sessionOpts);
        _localSession = result.session;
        _savedSession = _localSession;

        // Bind minimal no-op UI context to prevent extension dialog hangs.
        // bindExtensions dispatches session_start to all extensions (claude-mem etc.).
        if (typeof _localSession.bindExtensions === "function") {
          try {
            await _localSession.bindExtensions({ uiContext: createNoopUiContext(), mode: "rpc" });
          } catch (e) {
            console.warn("[pi-adapter] Could not bind extensions:", e.message);
          }
        }

        // Retry model resolution after bind — extension-registered providers (kiro)
        // only become available once bindExtensions completes.
        if (queryOpts.model && !model) {
          try {
            var lparts = queryOpts.model.split("/");
            await _qServices.modelRuntime.refresh({ allowNetwork: false });
            var lateModel = _qServices.modelRuntime.getModel(lparts[0], lparts.slice(1).join("/")) || null;
            if (lateModel) { await _localSession.setModel(lateModel); }
            else { console.warn("[pi-adapter] model not found after bind:", queryOpts.model); }
          } catch (e) { console.warn("[pi-adapter] late model resolve failed:", e.message); }
        }

        // Store session file path
        var piFile = _localSession.sessionFile || null;
        if (_sessionFileCallback) _sessionFileCallback(piFile);

        // Wire abort signal so stopLoop() / stopTask() can cancel the session.
        if (queryOpts.abortController && queryOpts.abortController.signal) {
          queryOpts.abortController.signal.addEventListener("abort", function() {
            if (_localSession) {
              try { _localSession.abort(); } catch (e) {}
            }
            mq.end();
          });
        }

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
            // For single-turn (loop) sessions, end the queue after the result
            // so processQueryStream's for-await exits cleanly.
            if (mapped.yokeType === "result" && _endAfterResult) {
              mq.end();
            }
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
        if (!_localSession || !_qServices) return;
        try {
          var parts = model.split("/");
          var providerId = parts[0];
          var modelId = parts.slice(1).join("/");
          var m = _qServices.modelRuntime.getModel(providerId, modelId);
          if (!m) {
            // Extension-registered providers aren't in the runtime at init time;
            // a non-network refresh makes them available after bind.
            await _qServices.modelRuntime.refresh({ allowNetwork: false });
            m = _qServices.modelRuntime.getModel(providerId, modelId);
          }
          if (m) {
            await _localSession.setModel(m);
          } else {
            console.warn("[pi-adapter] setModel: model not found after refresh:", model);
          }
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
        mq.end();
        // If the session is still alive when the stream ends (e.g. the sdk-bridge
        // idle reaper called close()), fire disposeSession so session_shutdown
        // reaches extensions and the AgentSession is not leaked.
        // disposeSession() is memoized, so close() + project.js destroy() both
        // await the same in-flight promise rather than racing two shutdowns.
        if (_savedSession) {
          handle.disposeSession("quit").catch(function(e) {
            console.warn("[pi-adapter] close() disposeSession failed:", e.message || e);
          });
        }
      },

      // Called when the clay session is permanently destroyed (daemon shutdown,
      // delete_session, or idle reaper via close()). Memoized: concurrent calls
      // all return the same promise; the work runs once.
      disposeSession: function(reason) {
        if (_disposePromise) return _disposePromise;
        if (!_savedSession) return Promise.resolve();
        var sess = _savedSession;
        _savedSession = null; _localSession = null; _closed = true;
        resetIdleTimer();
        if (_localUnsubscribe) { try { _localUnsubscribe(); } catch (e) {} }
        mq.end();
        _disposePromise = (async function() {
          // Wait for boot (session_start) before emitting session_shutdown.
          // Race against 5s so a hanging MCP connect doesn't block forever.
          if (_bootPromise) {
            try {
              await Promise.race([_bootPromise, new Promise(function(r) { var t = setTimeout(r, 5000); if (t.unref) t.unref(); })]);
            } catch (e) {}
          }
          try {
            var runner = sess.extensionRunner;
            if (runner && typeof runner.emit === "function") {
              // Give extensions at most 5s to handle session_shutdown (mirrors pi-web).
              await Promise.race([
                runner.emit({ type: "session_shutdown", reason: reason || "quit" }),
                new Promise(function(r) { var t = setTimeout(r, 5000); if (t.unref) t.unref(); }),
              ]);
            }
          } catch (e) { console.warn("[pi-adapter] session_shutdown emit failed:", e.message); }
          try { sess.dispose(); } catch (e) {}
        })();
        return _disposePromise;
      },

      onSessionFile: function(cb) { _sessionFileCallback = cb; },
      getPiSessionFile: function() {
        return _localSession ? (_localSession.sessionFile || null) : null;
      },
      endInput: function() {
        // For single-turn (loop) sessions: end the queue after the next
        // result event so processQueryStream's for-await exits cleanly.
        // Do NOT call mq.end() here — that would drop buffered events
        // (including the result itself) before they are consumed.
        _endAfterResult = true;
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
