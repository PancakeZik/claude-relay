var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { execFileSync } = require("child_process");
var { createLoopRegistry } = require("./scheduler");

/**
 * Attach loop engine to a project context.
 *
 * ctx fields:
 *   cwd, slug, sm, sdk, send, sendTo, sendToSession, pushModule,
 *   getHubSchedules, getLinuxUserForSession, onProcessingChanged,
 *   hydrateImageRefs
 */
function attachLoop(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var pushModule = ctx.pushModule;
  var notificationsModule = ctx.notificationsModule;
  var getHubSchedules = ctx.getHubSchedules;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var onProcessingChanged = ctx.onProcessingChanged;
  var hydrateImageRefs = ctx.hydrateImageRefs;

  // --- Ralph Loop state ---
  var loopState = {
    active: false,
    phase: "idle", // idle | crafting | approval | executing | done
    promptText: "",
    baseCommit: null,
    currentSessionId: null,
    results: [],
    stopping: false,
    name: null,
    settings: null,
    vendor: null,
    wizardData: null,
    craftingSessionId: null,
    startedAt: null,
    loopId: null,
    loopFilesId: null,
  };

  function loopDir() {
    var id = loopState.loopFilesId || loopState.loopId;
    if (!id) return null;
    return path.join(cwd, ".claude", "loops", id);
  }

  function generateLoopId() {
    return "loop_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
  }

  // Loop state persistence
  var _loopConfig = require("./config");
  var _loopUtils = require("./utils");
  var _loopDir = path.join(_loopConfig.CONFIG_DIR, "loops");
  var _loopEncodedCwd = _loopUtils.resolveEncodedFile(_loopDir, cwd, ".json");
  var _loopStatePath = path.join(_loopDir, _loopEncodedCwd + ".json");

  function saveLoopState() {
    try {
      fs.mkdirSync(_loopDir, { recursive: true });
      var data = {
        phase: loopState.phase,
        active: loopState.active,
        baseCommit: loopState.baseCommit,
        results: loopState.results,
        wizardData: loopState.wizardData,
        startedAt: loopState.startedAt,
        loopId: loopState.loopId,
        loopFilesId: loopState.loopFilesId || null,
      };
      var tmpPath = _loopStatePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, _loopStatePath);
    } catch (e) {
      console.error("[ralph-loop] Failed to save state:", e.message);
    }
  }

  function loadLoopState() {
    try {
      var raw = fs.readFileSync(_loopStatePath, "utf8");
      var data = JSON.parse(raw);
      loopState.phase = data.phase || "idle";
      loopState.active = data.active || false;
      loopState.baseCommit = data.baseCommit || null;
      loopState.results = data.results || [];
      loopState.wizardData = data.wizardData || null;
      loopState.startedAt = data.startedAt || null;
      loopState.loopId = data.loopId || null;
      loopState.loopFilesId = data.loopFilesId || null;
      // SDK sessions cannot survive daemon restart
      loopState.currentSessionId = null;
      loopState.craftingSessionId = null;
      loopState.stopping = false;
      // If was executing, schedule resume after SDK is ready
      if (loopState.phase === "executing" && loopState.active) {
        loopState._needsResume = true;
      }
      // If was crafting, check if files exist and move to approval
      if (loopState.phase === "crafting") {
        var hasFiles = checkLoopFilesExist();
        if (hasFiles) {
          loopState.phase = "approval";
          saveLoopState();
        } else {
          loopState.phase = "idle";
          saveLoopState();
        }
      }
    } catch (e) {
      // No saved state, use defaults
    }
    // Orphan recovery removed: without loopMode/JUDGE.md checks, every task folder
    // would match and show a spurious approval bar on restart.
  }

  function clearLoopState() {
    loopState.active = false;
    loopState.phase = "idle";
    loopState.promptText = "";
    loopState.baseCommit = null;
    loopState.currentSessionId = null;
    loopState.results = [];
    loopState.stopping = false;
    loopState.name = null;
    loopState.settings = null;
    loopState.vendor = null;
    loopState.wizardData = null;
    loopState.craftingSessionId = null;
    loopState.startedAt = null;
    loopState.loopId = null;
    loopState.loopFilesId = null;
    saveLoopState();
  }

  function checkLoopFilesExist() {
    var dir = loopDir();
    if (!dir) return false;
    try { fs.accessSync(path.join(dir, "PROMPT.md")); return true; } catch (e) { return false; }
  }

  // .claude/ directory watcher for PROMPT.md / JUDGE.md
  var claudeDirWatcher = null;
  var claudeDirDebounce = null;

  function startClaudeDirWatch() {
    if (claudeDirWatcher) return;
    var watchDir = loopDir();
    if (!watchDir) return;
    try { fs.mkdirSync(watchDir, { recursive: true }); } catch (e) {}
    try {
      claudeDirWatcher = fs.watch(watchDir, function () {
        if (claudeDirDebounce) clearTimeout(claudeDirDebounce);
        claudeDirDebounce = setTimeout(function () {
          broadcastLoopFilesStatus();
        }, 300);
      });
      claudeDirWatcher.on("error", function () {});
    } catch (e) {
      console.error("[ralph-loop] Failed to watch .claude/:", e.message);
    }
  }

  function stopClaudeDirWatch() {
    if (claudeDirWatcher) {
      claudeDirWatcher.close();
      claudeDirWatcher = null;
    }
    if (claudeDirDebounce) {
      clearTimeout(claudeDirDebounce);
      claudeDirDebounce = null;
    }
  }

  function broadcastLoopFilesStatus() {
    var dir = loopDir();
    var hasPrompt = false;
    var hasLoopJson = false;
    if (dir) {
      try { fs.accessSync(path.join(dir, "PROMPT.md")); hasPrompt = true; } catch (e) {}
      try { fs.accessSync(path.join(dir, "LOOP.json")); hasLoopJson = true; } catch (e) {}
    }
    send({
      type: "ralph_files_status",
      promptReady: hasPrompt,
      judgeReady: hasPrompt, // kept for client compat, always matches promptReady
      loopJsonReady: hasLoopJson,
      bothReady: hasPrompt,
      taskId: loopState.loopId,
    });
    // Auto-transition to approval phase when files are ready
    if (bothReady && loopState.phase === "crafting") {
      loopState.phase = "approval";
      saveLoopState();

      // Parse recommended title from crafting session conversation
      if (loopState.craftingSessionId && loopState.loopId) {
        var craftSess = sm.sessions.get(loopState.craftingSessionId);
        if (craftSess && craftSess.history) {
          for (var hi = craftSess.history.length - 1; hi >= 0; hi--) {
            var entry = craftSess.history[hi];
            var entryText = entry.text || "";
            var titleMatch = entryText.match(/\[\[LOOP_TITLE:\s*(.+?)\]\]/);
            if (titleMatch) {
              var suggestedTitle = titleMatch[1].trim();
              if (suggestedTitle) {
                loopRegistry.updateRecord(loopState.loopId, { name: suggestedTitle });
              }
              break;
            }
          }
        }
      }
    }
  }

  // Load persisted state on startup
  loadLoopState();

  // --- Loop Registry (unified one-off + scheduled) ---
  var activeRegistryId = null; // track which registry record triggered current loop
  var pendingTriggers = []; // queue for deferred triggers when skipIfRunning=false

  function triggerFromQueue(record) {
    // For schedule records, resolve the linked task to get loop files
    var loopFilesId = record.id;
    if (record.source === "schedule") {
      if (!record.linkedTaskId) {
        console.error("[loop-registry] Schedule has no linked task: " + record.name);
        return;
      }
      loopFilesId = record.linkedTaskId;
      console.log("[loop-registry] Schedule triggered: " + record.name + " -> linked task " + loopFilesId);
    }

    // Verify the loop directory and PROMPT.md exist
    var recDir = path.join(cwd, ".claude", "loops", loopFilesId);
    try {
      fs.accessSync(path.join(recDir, "PROMPT.md"));
    } catch (e) {
      console.error("[loop-registry] PROMPT.md missing for " + loopFilesId);
      return;
    }
    // Set the loopId to the schedule's own id (not the linked task) so sidebar groups correctly
    loopState.loopId = record.id;
    loopState.loopFilesId = loopFilesId;
    loopState.wizardData = null; // clear any previous wizard data to avoid name leak
    activeRegistryId = record.id;
    console.log("[loop-registry] Auto-starting loop: " + record.name + " (" + loopState.loopId + ")");
    send({ type: "schedule_run_started", recordId: record.id });
    startLoop({ name: record.name });
  }

  var loopRegistry = createLoopRegistry({
    cwd: cwd,
    onTrigger: function (record) {
      // Skip or queue trigger if a loop is already active
      if (loopState.active || loopState.phase === "executing") {
        if (record.skipIfRunning !== false) {
          console.log("[loop-registry] Skipping trigger for " + record.name + " — loop already active (skipIfRunning)");
          return;
        }
        console.log("[loop-registry] Loop active, queuing trigger for " + record.name);
        pendingTriggers.push(record);
        return;
      }

      triggerFromQueue(record);
    },
    onChange: function () {
      send({ type: "loop_registry_updated", records: getHubSchedules() });
    },
  });
  loopRegistry.load();
  loopRegistry.startTimer();

  // Wire loop info resolution for session list broadcasts
  sm.setResolveLoopInfo(function (loopId) {
    var rec = loopRegistry.getById(loopId);
    if (!rec) return null;
    return { name: rec.name || null, source: rec.source || null };
  });

  function startLoop(opts) {
    var loopOpts = opts || {};
    var dir = loopDir();
    if (!dir) {
      send({ type: "loop_error", text: "No loop directory. Run the wizard first." });
      return;
    }
    var promptPath = path.join(dir, "PROMPT.md");
    var promptText;
    try {
      promptText = fs.readFileSync(promptPath, "utf8");
    } catch (e) {
      send({ type: "loop_error", text: "Missing PROMPT.md in " + dir });
      return;
    }

    var baseCommit;
    try {
      baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: cwd, encoding: "utf8", timeout: 5000,
      }).trim();
    } catch (e) {
      send({ type: "loop_error", text: "Failed to get git HEAD: " + e.message });
      return;
    }

    // Read loop config from LOOP.json in loop directory
    var loopConfig = {};
    try {
      loopConfig = JSON.parse(fs.readFileSync(path.join(dir, "LOOP.json"), "utf8"));
    } catch (e) {}

    loopState.active = true;
    loopState.phase = "executing";
    loopState.promptText = promptText;
    loopState.baseCommit = baseCommit;
    loopState.currentSessionId = null;
    loopState.results = [];
    loopState.stopping = false;
    loopState.name = loopOpts.name || null;
    loopState.settings = loopConfig.settings || null;
    loopState.vendor = loopConfig.vendor || null;
    loopState.startedAt = Date.now();
    saveLoopState();

    stopClaudeDirWatch();

    send({ type: "loop_started", name: loopState.name });
    runOnce();
  }

  function runOnce() {
    console.log("[ralph-loop] runOnce called, active: " + loopState.active + ", stopping: " + loopState.stopping);
    if (!loopState.active || loopState.stopping) {
      finishLoop("stopped");
      return;
    }

    var _resolvedVendor = loopState.vendor || sm.newSessionVendor || sm.defaultVendor || null;
    console.log("[ralph-loop] vendor resolved:", _resolvedVendor, "(loop:", loopState.vendor || "none", "default:", sm.defaultVendor || "none", "newSession:", sm.newSessionVendor || "none", ")");
    var session = sm.createSession(_resolvedVendor ? { vendor: _resolvedVendor } : null);
    var loopSource = loopRegistry.getById(loopState.loopId);
    var loopName = (loopState.wizardData && loopState.wizardData.name) || (loopSource && loopSource.name) || "";
    var loopSourceTag = (loopSource && loopSource.source) || null;
    var isRalphLoop = loopSourceTag === "ralph";
    session.loop = { active: true, iteration: 1, role: "coder", loopId: loopState.loopId, name: loopName, source: loopSourceTag, startedAt: loopState.startedAt };
    session.title = (isRalphLoop ? "Ralph" : "Task") + (loopName ? " " + loopName : "");
    sm.saveSessionFile(session);
    sm.broadcastSessionList();

    loopState.currentSessionId = session.localId;

    send({
      type: "loop_iteration",
      iteration: 1,
      sessionId: session.localId,
    });

    var completed = false;
    var runWatchdog = null;
    var runSessionId = session.localId;
    session.onQueryComplete = function(completedSession) {
      if (completed) return;
      // Guard against stale completions from a previous session
      if (completedSession.localId !== runSessionId) return;
      completed = true;
      if (runWatchdog) { clearTimeout(runWatchdog); runWatchdog = null; }
      console.log("[ralph-loop] runOnce onQueryComplete fired, history length: " + completedSession.history.length);
      if (!loopState.active || loopState.stopping) {
        finishLoop("stopped");
        return;
      }
      // Check if session ended with error
      var lastItems = completedSession.history.slice(-3);
      var hadError = false;
      for (var i = 0; i < lastItems.length; i++) {
        if (lastItems[i].type === "error" || (lastItems[i].type === "done" && lastItems[i].code === 1)) {
          hadError = true;
          break;
        }
      }
      if (hadError) {
        loopState.results.push({ verdict: "error", summary: "Session ended with error" });
        finishLoop("error");
        return;
      }
      loopState.results.push({ verdict: "complete", summary: "Task completed" });
      finishLoop("complete");
    };

    // Watchdog: if onQueryComplete hasn't fired after 10 minutes, force error
    runWatchdog = setTimeout(function() {
      if (!completed && loopState.active && !loopState.stopping) {
        console.error("[ralph-loop] runOnce watchdog triggered — onQueryComplete never fired");
        completed = true;
        loopState.results.push({ verdict: "error", summary: "Session timed out" });
        finishLoop("error");
      }
    }, 10 * 60 * 1000);

    var userMsg = { type: "user_message", text: loopState.promptText };
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);

    session.isProcessing = true;
    onProcessingChanged();
    session.sentToolResults = {};
    sendToSession(session.localId, { type: "status", status: "processing" });
    session.acceptEditsAfterStart = true;
    session.singleTurn = true;
    if (loopState.settings) session.loopSettings = loopState.settings;
    sdk.startQuery(session, loopState.promptText, undefined, getLinuxUserForSession(session));
  }

  function finishLoop(reason) {
    console.log("[ralph-loop] finishLoop called, reason: " + reason + ", iteration: " + loopState.iteration);

    // Unlock the last coder session so users can continue interacting with it
    if (loopState.currentSessionId) {
      var lastCoderSession = sm.sessions.get(loopState.currentSessionId);
      if (lastCoderSession) {
        lastCoderSession.singleTurn = false;
        lastCoderSession.loop.active = false;
      }
    }

    loopState.active = false;
    loopState.phase = "done";
    loopState.stopping = false;
    loopState.currentSessionId = null;
    saveLoopState();

    send({
      type: "loop_finished",
      reason: reason,
      iterations: 1,
      results: loopState.results,
    });

    // Record result in loop registry
    if (loopState.loopId) {
      loopRegistry.recordRun(loopState.loopId, {
        reason: reason,
        startedAt: loopState.startedAt,
        iterations: 1,
      });
    }
    if (activeRegistryId) {
      send({ type: "schedule_run_finished", recordId: activeRegistryId, reason: reason, iterations: 1 });
      activeRegistryId = null;
    }

    if (pushModule) {
      var _finishBody = reason === "complete"
        ? "Task completed"
        : reason === "stopped" ? "Stopped by user" : "Ended due to error";
      pushModule.sendPush({
        type: "done", slug: slug, title: "Task Complete", body: _finishBody, tag: "ralph-loop-done",
      });
    }

    if (notificationsModule) {
      notificationsModule.notify("loop_complete", {
        reason: reason,
        name: loopState.name,
        iterations: 1,
        sessionId: loopState.currentSessionId,
      });
    }

    // Process next queued trigger if any
    if (pendingTriggers.length > 0) {
      var next = pendingTriggers.shift();
      console.log("[loop-registry] Processing queued trigger: " + next.name);
      setTimeout(function () {
        triggerFromQueue(next);
      }, 1000);
    }
  }

  function resumeLoop() {
    var dir = loopDir();
    if (!dir) {
      console.error("[ralph-loop] Cannot resume: no loop directory");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    try {
      loopState.promptText = fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8");
    } catch (e) {
      console.error("[ralph-loop] Cannot resume: missing PROMPT.md");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    console.log("[ralph-loop] Resuming loop");
    send({ type: "loop_started", name: loopState.name || null });
    runOnce();
  }

  function stopLoop() {
    if (!loopState.active) return;
    console.log("[ralph-loop] stopLoop called");
    loopState.stopping = true;

    // Abort the coder session
    var sessionIds = [loopState.currentSessionId];
    for (var i = 0; i < sessionIds.length; i++) {
      if (sessionIds[i] == null) continue;
      var s = sm.sessions.get(sessionIds[i]);
      if (!s) continue;
      // End message queue so SDK exits prompt wait
      if (s.messageQueue) { try { s.messageQueue.end(); } catch (e) {} }
      // Abort active API call
      if (s.abortController) { try { s.abortController.abort(); } catch (e) {} }
    }

    send({ type: "loop_stopping" });

    // Fallback: force finish if onQueryComplete hasn't fired after 5s
    setTimeout(function() {
      if (loopState.active && loopState.stopping) {
        console.log("[ralph-loop] Stop fallback triggered — forcing finishLoop");
        finishLoop("stopped");
      }
    }, 5000);
  }

  // --- Message handler for loop-related messages ---
  function handleLoopMessage(ws, msg) {
    if (msg.type === "loop_start") {
      // If this loop has a cron schedule, don't run immediately
      if (loopState.wizardData && loopState.wizardData.cron) {
        loopState.active = false;
        loopState.phase = "done";
        saveLoopState();
        send({ type: "loop_finished", reason: "scheduled", iterations: 0, results: [] });
        send({ type: "ralph_phase", phase: "idle", wizardData: null });
        send({ type: "loop_scheduled", recordId: loopState.loopId, cron: loopState.wizardData.cron });
        return true;
      }
      // Save per-loop settings to LOOP.json if provided
      if (msg.settings && Object.keys(msg.settings).length > 0) {
        var lDir3 = loopDir();
        if (lDir3) {
          var ljPath = path.join(lDir3, "LOOP.json");
          var lj = {};
          try { lj = JSON.parse(fs.readFileSync(ljPath, "utf8")); } catch (e) {}
          lj.settings = msg.settings;
          fs.writeFileSync(ljPath, JSON.stringify(lj, null, 2), "utf8");
        }
      }
      startLoop();
      return true;
    }

    if (msg.type === "loop_stop") {
      stopLoop();
      return true;
    }

    if (msg.type === "ralph_wizard_complete") {
      var wData = msg.data || {};
      var wizardCron = wData.cron || null;
      var newLoopId = generateLoopId();
      loopState.loopId = newLoopId;
      var recordSource = wData.source === "task" ? null : "ralph";
      loopState.wizardData = {
        name: wData.name || wData.task || "Untitled",
        task: wData.task || "",
        cron: wizardCron,
        promptAuthor: wData.promptAuthor || "clay",
        source: recordSource,
      };
      loopState.phase = "crafting";
      loopState.startedAt = Date.now();
      saveLoopState();

      // Register in loop registry
      loopRegistry.register({
        id: newLoopId,
        name: loopState.wizardData.name,
        task: wData.task || "",
        cron: wizardCron,
        enabled: wizardCron ? true : false,
        source: recordSource,
      });

      // Create loop directory and write LOOP.json (no loopMode/maxIterations)
      var lDir = loopDir();
      try { fs.mkdirSync(lDir, { recursive: true }); } catch (e) {}
      var loopJsonPath = path.join(lDir, "LOOP.json");
      var tmpLoopJson = loopJsonPath + ".tmp";
      // Seed new template with current vendor so scheduled tasks don't fall back to claude.
      var _seedVendor = sm.newSessionVendor || null;
      fs.writeFileSync(tmpLoopJson, JSON.stringify(_seedVendor ? { vendor: _seedVendor } : {}, null, 2));
      fs.renameSync(tmpLoopJson, loopJsonPath);

      var craftName = (loopState.wizardData && loopState.wizardData.name) || "";
      var isRalphCraft = recordSource === "ralph";

      // User provided their own PROMPT.md (and optionally JUDGE.md)
      if (wData.mode === "own" && wData.promptText) {
        // Write PROMPT.md
        var promptPath = path.join(lDir, "PROMPT.md");
        var tmpPrompt = promptPath + ".tmp";
        fs.writeFileSync(tmpPrompt, wData.promptText);
        fs.renameSync(tmpPrompt, promptPath);

        // Go straight to approval
        loopState.phase = "approval";
        saveLoopState();
        send({ type: "ralph_phase", phase: "approval", source: recordSource, wizardData: loopState.wizardData });
        send({ type: "ralph_files_status", promptReady: true, judgeReady: true, bothReady: true });
        return true;
      }

      // Default: "draft" mode — Clay crafts PROMPT.md via the clay-ralph skill
      var craftingPrompt = "Use the /clay-ralph skill to design a task for the following request. " +
        "You MUST invoke the clay-ralph skill — do NOT execute the task yourself. " +
        "Your job is to create ONLY a PROMPT.md file that a future autonomous session will execute. " +
        "Do NOT create a JUDGE.md file.\n\n" +
        "## Task\n" + (wData.task || "") +
        "\n\n## Loop Directory\n" + lDir;

      // Create a new session for crafting
      var craftingSession = sm.createSession(sm.newSessionVendor ? { vendor: sm.newSessionVendor } : null);
      craftingSession.title = (isRalphCraft ? "Ralph" : "Task") + (craftName ? " " + craftName : "") + " Crafting";
      craftingSession.ralphCraftingMode = true;
      craftingSession.loop = { active: true, iteration: 0, role: "crafting", loopId: newLoopId, name: craftName, source: recordSource, startedAt: loopState.startedAt };
      sm.saveSessionFile(craftingSession);
      sm.switchSession(craftingSession.localId, null, hydrateImageRefs);
      loopState.craftingSessionId = craftingSession.localId;

      // Store crafting session ID in the registry record
      loopRegistry.updateRecord(newLoopId, { craftingSessionId: craftingSession.localId });

      // Start .claude/ directory watcher
      startClaudeDirWatch();

      // Send crafting prompt and start the conversation with Claude.
      craftingSession.history.push({ type: "user_message", text: craftingPrompt });
      sm.appendToSessionFile(craftingSession, { type: "user_message", text: craftingPrompt });
      sendToSession(craftingSession.localId, { type: "user_message", text: craftingPrompt });
      craftingSession.isProcessing = true;
      onProcessingChanged();
      craftingSession.sentToolResults = {};
      sendToSession(craftingSession.localId, { type: "status", status: "processing" });
      sdk.startQuery(craftingSession, craftingPrompt, undefined, getLinuxUserForSession(craftingSession));

      send({ type: "ralph_crafting_started", sessionId: craftingSession.localId, taskId: newLoopId, source: recordSource });
      send({ type: "ralph_phase", phase: "crafting", wizardData: loopState.wizardData, craftingSessionId: craftingSession.localId });
      return true;
    }

    if (msg.type === "loop_registry_files") {
      var recId = msg.id;
      var lDir = path.join(cwd, ".claude", "loops", recId);
      var promptContent = "";
      var loopSettings = null;
      var loopVendor = null;
      try { promptContent = fs.readFileSync(path.join(lDir, "PROMPT.md"), "utf8"); } catch (e) {}
      try {
        var loopJson = JSON.parse(fs.readFileSync(path.join(lDir, "LOOP.json"), "utf8"));
        loopSettings = loopJson.settings || null;
        loopVendor = loopJson.vendor || null;
      } catch (e) {}
      sendTo(ws, {
        type: "loop_registry_files_content",
        id: recId,
        prompt: promptContent,
        settings: loopSettings,
        vendor: loopVendor,
        availableVendors: sm.availableVendors || [],
      });
      return true;
    }

    if (msg.type === "loop_registry_save_files") {
      var recId2 = msg.id;
      var lDir2 = path.join(cwd, ".claude", "loops", recId2);
      try {
        fs.mkdirSync(lDir2, { recursive: true });
        if (msg.prompt !== undefined) {
          fs.writeFileSync(path.join(lDir2, "PROMPT.md"), msg.prompt, "utf8");
        }
        // Persist settings and/or vendor into LOOP.json
        if (msg.settings !== undefined || msg.vendor !== undefined) {
          var loopJsonPath2 = path.join(lDir2, "LOOP.json");
          var loopJson2 = {};
          try { loopJson2 = JSON.parse(fs.readFileSync(loopJsonPath2, "utf8")); } catch (e) {}
          if (msg.settings !== undefined) loopJson2.settings = msg.settings;
          // Only update vendor if explicitly set to a non-empty string.
          // An empty/null msg.vendor from the UI must NOT clobber an existing vendor.
          if (msg.vendor !== undefined && msg.vendor) loopJson2.vendor = msg.vendor;
          fs.writeFileSync(loopJsonPath2, JSON.stringify(loopJson2, null, 2), "utf8");
        }
        send({ type: "loop_registry_save_files_result", id: recId2, ok: true });
        // Re-send updated content so the UI refreshes
        var updatedPrompt = "";
        var updatedSettings2 = null;
        var updatedVendor2 = null;
        try { updatedPrompt = fs.readFileSync(path.join(lDir2, "PROMPT.md"), "utf8"); } catch (e) {}
        try {
          var uj = JSON.parse(fs.readFileSync(path.join(lDir2, "LOOP.json"), "utf8"));
          updatedSettings2 = uj.settings || null;
          updatedVendor2 = uj.vendor || null;
        } catch (e) {}
        send({ type: "loop_registry_files_content", id: recId2, prompt: updatedPrompt, settings: updatedSettings2, vendor: updatedVendor2, availableVendors: sm.availableVendors || [] });
      } catch (e) {
        send({ type: "loop_registry_save_files_result", id: recId2, ok: false, error: e.message });
      }
      return true;
    }

    if (msg.type === "ralph_preview_files") {
      var promptContent = "";
      var judgeContent = "";
      var previewDir = loopDir();
      if (previewDir) {
        try { promptContent = fs.readFileSync(path.join(previewDir, "PROMPT.md"), "utf8"); } catch (e) {}
        try { judgeContent = fs.readFileSync(path.join(previewDir, "JUDGE.md"), "utf8"); } catch (e) {}
      }
      sendTo(ws, {
        type: "ralph_files_content",
        prompt: promptContent,
        judge: judgeContent,
      });
      return true;
    }

    if (msg.type === "ralph_wizard_cancel") {
      stopClaudeDirWatch();
      // Clean up loop directory
      var cancelDir = loopDir();
      if (cancelDir) {
        try { fs.rmSync(cancelDir, { recursive: true, force: true }); } catch (e) {}
      }
      clearLoopState();
      send({ type: "ralph_phase", phase: "idle", wizardData: null });
      return true;
    }

    if (msg.type === "ralph_cancel_crafting") {
      // Abort the crafting session if running
      if (loopState.craftingSessionId != null) {
        var craftSession = sm.sessions.get(loopState.craftingSessionId) || null;
        if (craftSession && craftSession.abortController) {
          craftSession.abortController.abort();
        }
      }
      stopClaudeDirWatch();
      // Clean up loop directory
      var craftCancelDir = loopDir();
      if (craftCancelDir) {
        try { fs.rmSync(craftCancelDir, { recursive: true, force: true }); } catch (e) {}
      }
      clearLoopState();
      send({ type: "ralph_phase", phase: "idle", wizardData: null });
      return true;
    }

    // --- Schedule create (from calendar click) ---
    if (msg.type === "schedule_create") {
      var sData = msg.data || {};
      loopRegistry.register({
        name: sData.name || "Untitled",
        task: sData.name || "",
        description: sData.description || "",
        date: sData.date || null,
        time: sData.time || null,
        allDay: sData.allDay !== undefined ? sData.allDay : true,
        linkedTaskId: sData.taskId || null,
        cron: sData.cron || null,
        enabled: sData.cron ? (sData.enabled !== false) : false,
        source: "schedule",
        color: sData.color || null,
        recurrenceEnd: sData.recurrenceEnd || null,
        skipIfRunning: sData.skipIfRunning !== undefined ? sData.skipIfRunning : true,
        intervalEnd: sData.intervalEnd || null,
      });
      return true;
    }

    // --- Hub: cross-project schedule aggregation ---
    if (msg.type === "hub_schedules_list") {
      sendTo(ws, { type: "hub_schedules", schedules: getHubSchedules() });
      return true;
    }

    // --- Loop Registry messages ---
    if (msg.type === "loop_registry_list") {
      sendTo(ws, { type: "loop_registry_updated", records: getHubSchedules() });
      return true;
    }

    if (msg.type === "loop_registry_update") {
      var updatedRec = loopRegistry.update(msg.id, msg.data || {});
      if (!updatedRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
      }
      return true;
    }

    if (msg.type === "loop_registry_rename") {
      if (msg.id && msg.name) {
        loopRegistry.updateRecord(msg.id, { name: String(msg.name).substring(0, 100) });
        sm.broadcastSessionList();
      }
      return true;
    }

    if (msg.type === "loop_registry_remove") {
      var removedRec = loopRegistry.remove(msg.id);
      if (!removedRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
      }
      return true;
    }

    if (msg.type === "loop_registry_convert") {
      // Convert ralph source to regular task (remove source tag)
      if (msg.id) {
        loopRegistry.updateRecord(msg.id, { source: null });
        sm.broadcastSessionList();
      }
      return true;
    }

    if (msg.type === "delete_loop_group") {
      // Delete all sessions belonging to this loopId, then remove registry record
      var loopIdToDel = msg.loopId;
      if (!loopIdToDel) return true;
      var sessionIds = [];
      sm.sessions.forEach(function (s, lid) {
        if (s.loop && s.loop.loopId === loopIdToDel) sessionIds.push(lid);
      });
      for (var di = 0; di < sessionIds.length; di++) {
        sm.deleteSessionQuiet(sessionIds[di]);
      }
      loopRegistry.remove(loopIdToDel);
      sm.broadcastSessionList();
      return true;
    }

    if (msg.type === "loop_registry_toggle") {
      var toggledRec = loopRegistry.toggleEnabled(msg.id);
      if (!toggledRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found or not scheduled" });
      }
      return true;
    }

    if (msg.type === "loop_registry_rerun") {
      // Re-run an existing job (one-off from library)
      if (loopState.active || loopState.phase === "executing") {
        sendTo(ws, { type: "loop_registry_error", text: "A loop is already running" });
        return true;
      }
      var rerunRec = loopRegistry.getById(msg.id);
      if (!rerunRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
        return true;
      }
      var rerunDir = path.join(cwd, ".claude", "loops", rerunRec.id);
      try {
        fs.accessSync(path.join(rerunDir, "PROMPT.md"));
      } catch (e) {
        sendTo(ws, { type: "loop_registry_error", text: "PROMPT.md missing for " + rerunRec.id });
        return true;
      }
      loopState.loopId = rerunRec.id;
      loopState.loopFilesId = null;
      loopState.wizardData = null; // clear any previous wizard data to avoid name leak
      activeRegistryId = null; // not a scheduled trigger
      send({ type: "loop_rerun_started", recordId: rerunRec.id });
      startLoop();
      return true;
    }

    return false; // not handled
  }

  // --- Connection state: send loop state to newly connected client ---
  function sendConnectionState(ws) {
    // Ralph Loop availability — PROMPT.md alone is sufficient
    var hasLoopFiles = false;
    try {
      fs.accessSync(path.join(cwd, ".claude", "PROMPT.md"));
      hasLoopFiles = true;
    } catch (e) {}
    // Also check loop directory files
    if (!hasLoopFiles && loopState.loopId) {
      var _avDir = loopDir();
      if (_avDir) {
        try {
          fs.accessSync(path.join(_avDir, "PROMPT.md"));
          hasLoopFiles = true;
        } catch (e) {}
      }
    }
    sendTo(ws, {
      type: "loop_available",
      available: hasLoopFiles,
      active: loopState.active,
      name: loopState.name || null,
    });

    // Ralph phase state
    var _connSource = loopState.wizardData ? (loopState.wizardData.source || null) : null;
    sendTo(ws, {
      type: "ralph_phase",
      phase: loopState.phase,
      wizardData: loopState.wizardData,
      craftingSessionId: loopState.craftingSessionId || null,
      source: _connSource,
    });
    if (loopState.phase === "crafting" || loopState.phase === "approval") {
      var _hasPrompt = false;
      var _lDir = loopDir();
      if (_lDir) {
        try { fs.accessSync(path.join(_lDir, "PROMPT.md")); _hasPrompt = true; } catch (e) {}
      }
      sendTo(ws, {
        type: "ralph_files_status",
        promptReady: _hasPrompt,
        judgeReady: _hasPrompt,
        bothReady: _hasPrompt,
        taskId: loopState.loopId,
      });
    }
  }

  // --- Public API ---
  return {
    loopState: loopState,
    loopRegistry: loopRegistry,
    loopDir: loopDir,
    startLoop: startLoop,
    stopLoop: stopLoop,
    resumeLoop: resumeLoop,
    handleLoopMessage: handleLoopMessage,
    sendConnectionState: sendConnectionState,
    stopClaudeDirWatch: stopClaudeDirWatch,
    getSchedules: function () { return loopRegistry.getAll(); },
    importSchedule: function (data) { return loopRegistry.register(data); },
    removeSchedule: function (id) { return loopRegistry.remove(id); },
    stopTimer: function () { loopRegistry.stopTimer(); },
  };
}

module.exports = { attachLoop: attachLoop };
