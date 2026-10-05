// Pi event mapper
// ---------------
// Converts AgentSessionEvent objects (from pi AgentSession.subscribe()) into
// flat objects with a yokeType field that sdk-message-processor.js understands.
//
// Pi's AssistantMessageEvent sub-events (inside message_update):
//   text_start / text_delta / text_end
//   thinking_start / thinking_delta / thinking_end
//   toolcall_start / toolcall_delta / toolcall_end
//
// Clay yokeType vocabulary this mapper emits:
//   init, turn_start, text_start, text_delta, thinking_start, thinking_delta,
//   tool_start, tool_input_delta, block_stop, tool_executing, tool_result,
//   tool_progress, result
//
// NOTE: turn_end fires once per LLM call (multiple times per agent run when
// tools are used). We must NOT map it to "result". Only agent_end maps to
// "result", which ends the processing indicator in the UI.

var _blockCounter = 0;
function nextBlockId() {
  return "pi-blk-" + (++_blockCounter);
}

// Map pi AgentSessionEvent to a flat yokeType object (or null to skip).
// sessionState is a mutable object for tracking block IDs across events:
//   { blockIds: {} }  keyed by contentIndex -> blockId
function mapPiEvent(evt, sessionState, session) {
  if (!evt || !evt.type) return null;

  // ---- agent_start: emit synthetic init ----
  if (evt.type === "agent_start") {
    var models = [];
    var modelId = "";
    try {
      if (session && session.model) {
        modelId = (session.model.provider || "") + "/" + (session.model.id || "");
      }
      if (session && session.modelRuntime) {
        var allModels = session.modelRuntime.getModels();
        for (var m = 0; m < allModels.length; m++) {
          models.push(allModels[m].provider + "/" + allModels[m].id);
        }
      }
    } catch (e) {}
    return {
      yokeType: "init",
      model: modelId,
      models: models,
      skills: [],
      slashCommands: [],
      fastModeState: null,
      sessionId: session ? session.sessionId : null,
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

  // ---- turn_start ----
  if (evt.type === "turn_start") {
    return { yokeType: "turn_start" };
  }

  // ---- message_update: carries AssistantMessageEvent sub-events ----
  if (evt.type === "message_update") {
    var ae = evt.assistantMessageEvent;
    if (!ae) return null;

    var ci = ae.contentIndex != null ? ae.contentIndex : 0;
    var blockId = sessionState.blockIds[ci];

    if (ae.type === "text_start") {
      blockId = nextBlockId();
      sessionState.blockIds[ci] = blockId;
      return { yokeType: "text_start", blockId: blockId, blockIndex: ci };
    }

    if (ae.type === "text_delta") {
      return { yokeType: "text_delta", blockId: blockId, text: ae.delta || "" };
    }

    if (ae.type === "text_end") {
      var id = blockId;
      delete sessionState.blockIds[ci];
      return { yokeType: "block_stop", blockId: id };
    }

    if (ae.type === "thinking_start") {
      blockId = nextBlockId();
      sessionState.blockIds[ci] = blockId;
      return { yokeType: "thinking_start", blockId: blockId, blockIndex: ci };
    }

    if (ae.type === "thinking_delta") {
      return { yokeType: "thinking_delta", blockId: blockId, text: ae.delta || "" };
    }

    if (ae.type === "thinking_end") {
      var id = blockId;
      delete sessionState.blockIds[ci];
      return { yokeType: "block_stop", blockId: id };
    }

    if (ae.type === "toolcall_start") {
      blockId = nextBlockId();
      sessionState.blockIds[ci] = blockId;
      // toolcall_start partial may have the id; toolcall_end has the final ToolCall
      var toolId = null;
      var toolName = null;
      if (ae.partial && Array.isArray(ae.partial.content)) {
        var blk = ae.partial.content[ci];
        if (blk && blk.type === "toolCall") {
          toolId = blk.id || null;
          toolName = blk.name || null;
        }
      }
      sessionState.toolCallMeta = sessionState.toolCallMeta || {};
      sessionState.toolCallMeta[ci] = { blockId: blockId, toolId: toolId, toolName: toolName };
      return { yokeType: "tool_start", blockId: blockId, blockIndex: ci, toolId: toolId, toolName: toolName };
    }

    if (ae.type === "toolcall_delta") {
      return { yokeType: "tool_input_delta", blockId: blockId, partialJson: ae.delta || "" };
    }

    if (ae.type === "toolcall_end") {
      var meta = (sessionState.toolCallMeta || {})[ci] || {};
      var finalBlockId = meta.blockId || blockId;
      // Populate final tool id/name from the completed ToolCall
      if (ae.toolCall) {
        if (ae.toolCall.id) meta.toolId = ae.toolCall.id;
        if (ae.toolCall.name) meta.toolName = ae.toolCall.name;
        if (sessionState.toolCallMeta) sessionState.toolCallMeta[ci] = meta;
      }
      delete sessionState.blockIds[ci];
      return { yokeType: "block_stop", blockId: finalBlockId };
    }

    return null;
  }

  // ---- tool_execution_start: block_stop already sends tool_executing via
  // the accumulated inputJson. Skip to avoid duplicate tool_executing events.
  if (evt.type === "tool_execution_start") {
    return null;
  }

  // ---- tool_execution_update: streaming bash output ----
  if (evt.type === "tool_execution_update") {
    var partial = evt.partialResult;
    var outputText = "";
    if (partial && typeof partial === "object") {
      outputText = partial.output || partial.stdout || partial.delta || "";
    } else if (typeof partial === "string") {
      outputText = partial;
    }
    if (!outputText) return null;
    return {
      yokeType: "tool_progress",
      toolId: evt.toolCallId,
      toolName: evt.toolName,
      text: outputText,
    };
  }

  // ---- tool_execution_end: tool result ----
  if (evt.type === "tool_execution_end") {
    var resultContent = "";
    var r = evt.result;
    if (r && typeof r === "object") {
      if (typeof r.output === "string") resultContent = r.output;
      else if (typeof r.result === "string") resultContent = r.result;
      else { try { resultContent = JSON.stringify(r); } catch (e) { resultContent = String(r); } }
    } else if (r != null) {
      resultContent = String(r);
    }
    return {
      yokeType: "tool_result",
      toolId: evt.toolCallId,
      toolName: evt.toolName,
      content: resultContent,
      isError: !!evt.isError,
    };
  }

  // ---- agent_end: the whole run is done, emit result ----
  if (evt.type === "agent_end") {
    // Compute cost + usage from session stats if available
    var cost = 0;
    var usage = null;
    try {
      if (session && typeof session.getSessionStats === "function") {
        var stats = session.getSessionStats();
        cost = stats.cost || 0;
        if (stats.tokens) {
          usage = {
            input_tokens: stats.tokens.input || 0,
            output_tokens: stats.tokens.output || 0,
            cache_read_input_tokens: stats.tokens.cacheRead || 0,
            cache_creation_input_tokens: stats.tokens.cacheWrite || 0,
          };
        }
      }
    } catch (e) {}
    return {
      yokeType: "result",
      cost: cost,
      usage: usage,
      duration: null,
      sessionId: session ? session.sessionId : null,
    };
  }

  // ---- agent_settled: all follow-ups done, nothing extra needed ----
  if (evt.type === "agent_settled") {
    return null;
  }

  return null;
}

module.exports = { mapPiEvent: mapPiEvent };
