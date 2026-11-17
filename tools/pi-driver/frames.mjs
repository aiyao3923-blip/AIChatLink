// Pure frame construction + pi-event projection for the Claude Code
// stream-json dialect that AIChatLink's claude adapter speaks.
//
// Every constructor here is checked against AIChatLink's own validators:
//   src/adapters/claude/protocol.ts
//     parseClaudeHandshake            -> O1 needs response.current_permission_mode
//     parseClaudeSetPermissionModeResult -> O2 needs response.mode
//     normalizeClaudeStreamEvent      -> O4 needs content_block.id, O5 delta.text, O6 delta.thinking
//     readClaudeAssistantBlocks       -> O7 message.id + content[].type text|tool_use
//     readClaudeToolResults           -> O8 tool_result.tool_use_id
//     parseClaudeResult               -> O9 subtype/is_error/terminal_reason
// No frame here is ever emitted in v1 for O10 (system/init): AIChatLink validates
// session_id, cwd and permissionMode together and rejects the session on any
// mismatch, so the adapter's control handshake is used instead.

export const CLAUDE_PERMISSION_MODE = "bypassPermissions";
export const MAX_FRAME_BYTES = 1_048_000; // AIChatLink jsonline-process.ts:71 is 1 MiB
const MAX_DELTA_CHARS = 16_000;

export function initResponse(requestId, options = {}) {
  const payload = { current_permission_mode: CLAUDE_PERMISSION_MODE };
  if (Number.isInteger(options.pid)) payload.pid = options.pid;
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requireId(requestId), response: payload },
  };
}

export function setPermissionModeResponse(requestId) {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requireId(requestId),
      response: { mode: CLAUDE_PERMISSION_MODE },
    },
  };
}

export function controlErrorResponse(requestId, error) {
  return {
    type: "control_response",
    response: { subtype: "error", request_id: requireId(requestId), error: String(error ?? "unsupported") },
  };
}

export function messageStart(messageId) {
  return {
    type: "stream_event",
    event: { type: "message_start", message: { id: requireId(messageId), role: "assistant", content: [] } },
  };
}

export function textDelta(text) {
  return contentBlockDelta({ type: "text_delta", text: String(text) });
}

export function thinkingDelta(thinking) {
  return contentBlockDelta({ type: "thinking_delta", thinking: String(thinking) });
}

export function toolUseStart(toolUseId, toolName) {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: requireId(toolUseId), ...(toolName ? { name: String(toolName) } : {}) },
    },
  };
}

export function assistantAggregate(messageId, textBlocks, toolUses) {
  const content = [];
  for (const text of textBlocks) if (text.length > 0) content.push({ type: "text", text });
  for (const use of toolUses) {
    content.push({
      type: "tool_use",
      id: requireId(use.id),
      ...(use.name ? { name: String(use.name) } : {}),
      input: use.input && typeof use.input === "object" ? use.input : {},
    });
  }
  return { type: "assistant", message: { id: requireId(messageId), role: "assistant", content } };
}

export function toolResult(toolUseId, options = {}) {
  const block = {
    type: "tool_result",
    tool_use_id: requireId(toolUseId),
    ...(options.isError === true ? { is_error: true } : {}),
  };
  const content = stringifyToolResult(options.result);
  if (content !== undefined) block.content = content;
  return { type: "user", message: { role: "user", content: [block] } };
}

export function resultFrame(options = {}) {
  const frame = {
    type: "result",
    subtype: options.subtype ?? "success",
    is_error: options.isError === true,
  };
  if (options.terminalReason !== undefined) frame.terminal_reason = String(options.terminalReason);
  if (options.stopReason !== undefined) frame.stop_reason = String(options.stopReason);
  if (Number.isInteger(options.numTurns)) frame.num_turns = options.numTurns;
  if (isPlainObject(options.usage)) frame.usage = options.usage;
  return frame;
}

export const CANCELLED = Object.freeze({
  subtype: "error_during_execution",
  isError: true,
  terminalReason: "aborted_streaming",
});

export const FAILED = Object.freeze({
  subtype: "error_during_execution",
  isError: true,
  terminalReason: "error",
});

/**
 * Projects pi session records into AIChatLink frames.
 * The caller signals turn boundaries with beginTurn()/settle().
 */
export function createProjector(options = {}) {
  const maxFrameBytes = positive(options.maxFrameBytes, MAX_FRAME_BYTES);
  let turnSeq = 0;
  let messageSeq = 0;
  let messageId = null;
  let text = "";
  let toolUses = [];
  let usage;
  let numTurns = 0;
  let droppedFrames = 0;
  let overlongFrames = 0;
  // Guards against a second terminal frame for one turn: pi can emit an error
  // message_end and then agent_settled, and AIChatLink would settle twice.
  let terminal = false;

  function beginTurn() {
    turnSeq += 1;
    messageSeq = 0;
    messageId = null;
    text = "";
    toolUses = [];
    usage = undefined;
    numTurns = 0;
    terminal = false;
  }

  function openMessage() {
    messageSeq += 1;
    messageId = `msg_${turnSeq}_${messageSeq}`;
    text = "";
    toolUses = [];
    return messageStart(messageId);
  }

  /** @returns {Record<string, unknown>[]} frames to emit, in order. */
  function push(record) {
    if (!isPlainObject(record)) return [];
    const type = typeof record.type === "string" ? record.type : "";

    if (type === "message_start") {
      return [openMessage()];
    }

    if (type === "message_update") {
      if (isPlainObject(record.usage)) usage = record.usage;
      const event = isPlainObject(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
      if (!event) return [];
      switch (event.type) {
        case "text_delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta.length === 0) return [];
          // One text block per assistant message: Claude Code streams a single
          // text block and AIChatLink aggregates text blocks by concatenation, so
          // keeping per-delta blocks would render as repeated paragraphs.
          text += delta;
          return chunkText(delta).map(textDelta);
        }
        case "thinking_delta": {
          const thinking = typeof event.delta === "string" ? event.delta : "";
          if (thinking.length === 0) return [];
          return chunkText(thinking).map(thinkingDelta);
        }
        case "toolcall_start": {
          const id = typeof event.id === "string" ? event.id : undefined;
          if (!id) {
            // AIChatLink drops a tool_use block without an id, and the aggregate
            // frame would otherwise re-open it as a second start.
            droppedFrames += 1;
            return [];
          }
          const name = typeof event.toolName === "string" ? event.toolName : undefined;
          toolUses.push({ id, name });
          return [toolUseStart(id, name)];
        }
        case "toolcall_end": {
          const call = isPlainObject(event.toolCall) ? event.toolCall : undefined;
          const id = call && typeof call.id === "string" ? call.id : undefined;
          if (id) {
            const known = toolUses.find((use) => use.id === id);
            if (known) {
              if (!known.name && typeof call.name === "string") known.name = call.name;
              if (isPlainObject(call.arguments)) known.input = call.arguments;
            } else {
              toolUses.push({ id, name: typeof call.name === "string" ? call.name : undefined, input: call.arguments });
            }
          }
          return [];
        }
        default:
          return [];
      }
    }

    if (type === "message_end") {
      numTurns += 1;
      const message = isPlainObject(record.message) ? record.message : undefined;
      if (isPlainObject(message?.usage)) usage = message.usage;
      const id = messageId ?? `msg_${turnSeq}_0`;
      const stopReason = typeof message?.stopReason === "string" ? message.stopReason : "";
      if (stopReason === "error") {
        // A provider refusal (bad model, rejected role, quota, ...) arrives as an
        // assistant message with empty content. Reporting it as success would
        // show a blank reply in the room and hide the failure.
        terminal = true;
        text = "";
        toolUses = [];
        const provider = typeof message?.provider === "string" ? message.provider : "unknown";
        const model = typeof message?.model === "string" ? message.model : "unknown";
        const detail =
          typeof message?.errorMessage === "string" && message.errorMessage.length > 0
            ? message.errorMessage
            : "native model call failed";
        const reason = `模型调用失败（${provider}/${model}）：${detail}`.slice(0, 2_000);
        // AIChatLink copies stop_reason into the turn.failed payload, which is the
        // only diagnostic a failed native turn keeps in the room transcript.
        return [
          assistantAggregate(id, [reason], []),
          resultFrame({ ...FAILED, numTurns: numTurns || 1, usage, stopReason: reason.slice(0, 500) }),
        ];
      }
      const frame = assistantAggregate(id, text.length > 0 ? [text] : [], toolUses);
      text = "";
      toolUses = [];
      if (Buffer.byteLength(JSON.stringify(frame), "utf8") > maxFrameBytes) {
        // The deltas already carried this text; a second oversized copy would
        // trip AIChatLink's line_too_large and fail the turn.
        overlongFrames += 1;
        return [];
      }
      return [frame];
    }

    if (type === "tool_execution_end") {
      const id = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      if (!id) return [];
      return [toolResult(id, { isError: record.isError === true, result: record.result })];
    }

    if (type === "agent_settled") {
      if (terminal) return [];
      terminal = true;
      return [resultFrame({ subtype: "success", isError: false, numTurns: numTurns || 1, usage })];
    }

    if (type === "error") {
      if (terminal) return [];
      terminal = true;
      return [resultFrame({ ...FAILED, numTurns: numTurns || 1, usage })];
    }

    return [];
  }

  return {
    beginTurn,
    push,
    get turnSeq() {
      return turnSeq;
    },
    get stats() {
      return { droppedFrames, overlongFrames, turnSeq, messageSeq };
    },
  };
}

function contentBlockDelta(delta) {
  return { type: "stream_event", event: { type: "content_block_delta", index: 0, delta } };
}

function chunkText(text) {
  if (text.length <= MAX_DELTA_CHARS) return [text];
  const parts = [];
  for (let index = 0; index < text.length; index += MAX_DELTA_CHARS) {
    parts.push(text.slice(index, index + MAX_DELTA_CHARS));
  }
  return parts;
}

function stringifyToolResult(result) {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  try {
    const text = JSON.stringify(result);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

function requireId(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("id is required");
  return value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("maxFrameBytes must be a positive integer");
  return value;
}
