import test from "node:test";
import assert from "node:assert/strict";
import {
  CANCELLED,
  FAILED,
  MAX_FRAME_BYTES,
  assistantAggregate,
  controlErrorResponse,
  createProjector,
  initResponse,
  messageStart,
  resultFrame,
  setPermissionModeResponse,
  textDelta,
  thinkingDelta,
  toolResult,
  toolUseStart,
} from "../frames.mjs";

// --- constructors: shapes AIChatLink's own validators demand -------------------

test("initResponse carries current_permission_mode (parseClaudeHandshake)", () => {
  const frame = initResponse("req-1", { pid: 4242 });
  assert.deepEqual(frame, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: { current_permission_mode: "bypassPermissions", pid: 4242 },
    },
  });
});

test("setPermissionModeResponse reports the mode AIChatLink established", () => {
  const frame = setPermissionModeResponse("req-2");
  assert.equal(frame.response.response.mode, "bypassPermissions");
});

test("controlErrorResponse keeps request_id and an error string", () => {
  const frame = controlErrorResponse("req-3", "nope");
  assert.deepEqual(frame.response, { subtype: "error", request_id: "req-3", error: "nope" });
});

test("toolUseStart always carries an id (normalizeClaudeStreamEvent drops id-less blocks)", () => {
  const frame = toolUseStart("tool-1", "read");
  assert.deepEqual(frame.event.content_block, { type: "tool_use", id: "tool-1", name: "read" });
  assert.throws(() => toolUseStart("", "read"), /id is required/);
});

test("textDelta / thinkingDelta use the field names AIChatLink reads", () => {
  assert.equal(textDelta("hi").event.delta.text, "hi");
  assert.equal(thinkingDelta("hmm").event.delta.thinking, "hmm");
  assert.equal(textDelta("hi").event.delta.type, "text_delta");
  assert.equal(thinkingDelta("hmm").event.delta.type, "thinking_delta");
});

test("assistantAggregate exposes message.id and typed content blocks", () => {
  const frame = assistantAggregate("msg_1_1", ["hello"], [{ id: "tool-1", name: "read", input: { path: "a" } }]);
  assert.equal(frame.type, "assistant");
  assert.equal(frame.message.id, "msg_1_1");
  assert.deepEqual(frame.message.content[0], { type: "text", text: "hello" });
  assert.deepEqual(frame.message.content[1], { type: "tool_use", id: "tool-1", name: "read", input: { path: "a" } });
});

test("toolResult uses tool_use_id and only sets is_error when true", () => {
  const ok = toolResult("tool-1", { result: "done" });
  assert.equal(ok.message.content[0].tool_use_id, "tool-1");
  assert.equal(ok.message.content[0].is_error, undefined);
  assert.equal(ok.message.content[0].content, "done");

  const bad = toolResult("tool-2", { isError: true });
  assert.equal(bad.message.content[0].is_error, true);
});

test("resultFrame classifies cancelled vs completed the way AIChatLink does", () => {
  const cancelled = resultFrame({ ...CANCELLED, numTurns: 1 });
  assert.equal(cancelled.terminal_reason, "aborted_streaming");
  const completed = resultFrame({ subtype: "success", isError: false, numTurns: 2, usage: { input: 1 } });
  assert.equal(completed.subtype, "success");
  assert.equal(completed.is_error, false);
  assert.deepEqual(completed.usage, { input: 1 });
  assert.equal(resultFrame({ ...FAILED }).terminal_reason, "error");
});

test("messageStart opens a message with an id", () => {
  assert.equal(messageStart("msg_1_1").event.message.id, "msg_1_1");
  assert.equal(messageStart("msg_1_1").event.type, "message_start");
});

// --- projector: pi records -> AIChatLink frames --------------------------------

test("text turn produces message_start, deltas, aggregate and a result", () => {
  const projector = createProjector();
  projector.beginTurn();
  const frames = [
    ...projector.push({ type: "message_start" }),
    ...projector.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你" } }),
    ...projector.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好" } }),
    ...projector.push({ type: "message_end", message: { usage: { input: 3 } } }),
    ...projector.push({ type: "agent_settled" }),
  ];

  assert.equal(frames[0].type, "stream_event");
  assert.equal(frames[0].event.message.id, "msg_1_1");
  assert.deepEqual(
    frames.filter((f) => f.event?.type === "content_block_delta").map((f) => f.event.delta.text),
    ["你", "好"],
  );
  const aggregate = frames.find((f) => f.type === "assistant");
  assert.deepEqual(aggregate.message.content, [{ type: "text", text: "你好" }]);
  const result = frames.at(-1);
  assert.equal(result.type, "result");
  assert.equal(result.subtype, "success");
  assert.equal(result.is_error, false);
  assert.equal(result.num_turns, 1);
  assert.deepEqual(result.usage, { input: 3 });
});

test("tool turn emits a tool_use block and a matching tool_result", () => {
  const projector = createProjector();
  projector.beginTurn();
  const frames = [
    ...projector.push({ type: "message_start" }),
    ...projector.push({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", id: "call-1", toolName: "read" },
    }),
    ...projector.push({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "call-1", name: "read", arguments: { path: "a" } } },
    }),
    ...projector.push({ type: "tool_execution_end", toolCallId: "call-1", isError: false, result: "ok" }),
    ...projector.push({ type: "message_end", message: {} }),
    ...projector.push({ type: "agent_settled" }),
  ];

  const start = frames.find((f) => f.event?.type === "content_block_start");
  assert.equal(start.event.content_block.id, "call-1");
  const result = frames.find((f) => f.type === "user");
  assert.equal(result.message.content[0].tool_use_id, "call-1");
  assert.equal(result.message.content[0].content, "ok");
  const aggregate = frames.find((f) => f.type === "assistant");
  assert.equal(aggregate.message.content[0].type, "tool_use");
  assert.deepEqual(aggregate.message.content[0].input, { path: "a" });
});

test("tool_use without an id is dropped and counted, never emitted", () => {
  const projector = createProjector();
  projector.beginTurn();
  const frames = projector.push({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", toolName: "read" },
  });
  assert.deepEqual(frames, []);
  assert.equal(projector.stats.droppedFrames, 1);
});

test("an oversized aggregate frame is skipped instead of failing the turn", () => {
  const projector = createProjector({ maxFrameBytes: 200 });
  projector.beginTurn();
  projector.push({ type: "message_start" });
  projector.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(500) } });
  const frames = projector.push({ type: "message_end", message: {} });
  assert.deepEqual(frames, []);
  assert.equal(projector.stats.overlongFrames, 1);
});

test("long deltas are chunked below the channel limit", () => {
  const projector = createProjector();
  projector.beginTurn();
  const frames = projector.push({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "y".repeat(40_000) },
  });
  assert.ok(frames.length > 1);
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") < MAX_FRAME_BYTES);
  }
});

test("unknown and extension records are ignored", () => {
  const projector = createProjector();
  projector.beginTurn();
  for (const record of [
    { type: "extension_ui_request", method: "setStatus" },
    { type: "queue_update" },
    { type: "turn_start" },
    { type: "session_info_changed", name: "x" },
    null,
    "string",
  ]) {
    assert.deepEqual(projector.push(record), []);
  }
});

test("a new turn gets fresh message ids", () => {
  const projector = createProjector();
  projector.beginTurn();
  const first = projector.push({ type: "message_start" })[0].event.message.id;
  projector.beginTurn();
  const second = projector.push({ type: "message_start" })[0].event.message.id;
  assert.notEqual(first, second);
  assert.equal(first, "msg_1_1");
  assert.equal(second, "msg_2_1");
});

test("a provider error message becomes a failed result, not a blank success", () => {
  const projector = createProjector();
  projector.beginTurn();
  const frames = projector.push({
    type: "message_end",
    message: {
      id: "m1",
      role: "assistant",
      content: [],
      provider: "<provider>",
      model: "<model-c>",
      stopReason: "error",
      errorMessage: "400: role 'developer' is not allowed",
    },
  });
  const result = frames.find((frame) => frame.type === "result");
  assert.ok(result, "a result frame must settle the turn");
  assert.equal(result.is_error, true);
  assert.equal(result.terminal_reason, "error");
  const aggregate = frames.find((frame) => frame.type === "assistant");
  assert.match(aggregate.message.content[0].text, /role 'developer' is not allowed/);
});

test("agent_settled after a failed message never reports success twice", () => {
  const projector = createProjector();
  projector.beginTurn();
  projector.push({
    type: "message_end",
    message: { id: "m1", role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
  });
  const afterSettle = projector.push({ type: "agent_settled" });
  assert.deepEqual(afterSettle, [], "the turn already settled as failed");
});
