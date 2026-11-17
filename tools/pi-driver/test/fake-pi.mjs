#!/usr/bin/env node
// Stand-in for `pi --mode rpc`, used by the shim smoke test.
// Emulates the record shapes documented in pi/docs/json.md and rpc-commands.md.
import { createLineReader, writeRecord } from "../lines.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const state = {
  provider: flag("--provider", "fakeA"),
  model: flag("--model", "fake-model"),
  thinking: flag("--thinking", "off"),
  sessionId: flag("--session-id", "unknown"),
  busy: false,
  turns: 0,
};

const out = (record) => writeRecord(process.stdout, record);

// Noise that must never reach AIChatLink: extension UI traffic is not protocol.
out({ type: "extension_ui_request", id: "ui-1", method: "setStatus", statusKey: "plan-mode" });

function streamTurn(text) {
  state.turns += 1;
  state.busy = true;
  out({ type: "message_start", message: { id: `fake-${state.turns}` } });
  for (const chunk of text.match(/.{1,4}/gu) ?? []) {
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
  }
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想一下" } });
  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "call-1", toolName: "read" } });
  out({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "call-1", name: "read", arguments: { path: "a.txt" } } },
  });
  out({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.txt" } });
  out({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "file body", isError: false });
  out({ type: "message_end", message: { id: `fake-${state.turns}`, usage: { input: 12, output: 34 } } });
  out({ type: "agent_settled" });
  state.busy = false;
}

createLineReader(process.stdin, {
  onLine: (line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (data, success = true) =>
      out({ id: record.id, type: "response", command: record.type, success, data });

    switch (record.type) {
      case "get_state":
        reply({
          model: { provider: state.provider, id: state.model },
          thinkingLevel: state.thinking,
          isStreaming: state.busy,
          messageCount: state.turns,
          sessionId: state.sessionId,
        });
        break;
      case "set_model":
        state.provider = record.provider;
        state.model = record.modelId;
        reply({ provider: state.provider, id: state.model });
        break;
      case "set_thinking_level":
        state.thinking = record.level;
        reply({ level: state.thinking });
        break;
      case "get_available_models":
        reply({ models: [{ provider: "fakeA", id: "fake-model" }, { provider: "fakeB", id: "other-model" }] });
        break;
      case "prompt":
        reply({ disposition: "started" });
        streamTurn(String(record.message ?? ""));
        break;
      case "abort":
        reply({ aborted: true });
        out({ type: "agent_settled" });
        state.busy = false;
        break;
      default:
        reply({}, false);
        break;
    }
  },
  onError: () => {},
});
