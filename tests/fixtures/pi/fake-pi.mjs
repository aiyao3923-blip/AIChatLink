import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, resolve } from "node:path";

const configPath = resolve(process.cwd(), "fake-pi-config.json");
const logPath = resolve(process.cwd(), "fake-pi-wire.jsonl");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

const record = (value) => appendFileSync(logPath, `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const sessionId = flag("--session-id") ?? "fake-pi-session";
let activeTurn = undefined;
let messageCount = config.resumeMessageCount ?? 0;
let abortRequested = false;
let promptCounter = 0;

record({ type: "startup", argv });

if (config.malformedAfterStart === true) {
  setTimeout(() => process.stdout.write("{not json\n"), config.malformedDelayMs ?? 30);
}

if (config.exitBeforeHandshake === true) {
  process.stderr.write(config.stderrBeforeExit ?? "fake pi refused to start");
  process.exit(config.exitCode ?? 9);
}

function response(id, command, data = undefined, error = undefined) {
  send({
    id,
    type: "response",
    command,
    success: error === undefined,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error })
  });
}

function emitTurn() {
  promptCounter += 1;
  const prompt =
    config.failFirstPromptOnly === true && promptCounter === 1
      ? { ...(config.prompt ?? {}), text: "", stopReason: "error", errorMessage: "first prompt failed" }
      : (config.prompt ?? {});
  const turn = {
    text: prompt.text ?? "fake pi answer",
    stopReason: prompt.stopReason ?? "stop",
    errorMessage: prompt.errorMessage,
    willRetry: prompt.willRetry === true,
    streamText: prompt.streamText !== false,
    tool: prompt.tool === true
  };
  activeTurn = turn;
  abortRequested = false;

  if (prompt.silence === true) {
    return;
  }

  if (config.straySettleBeforeRun === true && promptCounter === 2) {
    // A late settle from the previous run arrives before this run starts.
    send({ type: "agent_settled" });
  }

  send({ type: "agent_start" });
  send({ type: "turn_start" });

  if (prompt.exitAfterAccept === true) {
    process.exit(prompt.exitCode ?? 3);
  }
  if (prompt.hold === true) {
    return;
  }

  if (prompt.malformed === true) {
    process.stdout.write("{not json\n");
    return;
  }

  if (turn.streamText) {
    send({
      type: "message_update",
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: turn.text }
    });
  }
  if (prompt.thinkingDelta === true) {
    send({
      type: "message_update",
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "thinking hard" }
    });
  }
  if (turn.tool) {
    send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
    send({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls" },
      partialResult: { content: [{ type: "text", text: "partial" }] }
    });
    send({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }] },
      isError: prompt.toolError === true
    });
  }

  if (prompt.uiRequest === true) {
    send({
      type: "extension_ui_request",
      id: "ui-1",
      method: prompt.uiRequestMethod ?? "confirm",
      title: "continue?"
    });
    if (["select", "confirm", "input", "editor"].includes(prompt.uiRequestMethod ?? "confirm")) return;
  }

  messageCount += 2;
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: turn.text }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture-model",
      usage: { input: 1, output: 1, totalTokens: 2 },
      stopReason: turn.stopReason,
      ...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }),
      timestamp: Date.now()
    }
  });
  send({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
  send({ type: "agent_end", messages: [], willRetry: turn.willRetry });
  if (turn.willRetry) {
    // pi retries internally; a second low-level run follows before settling.
    setTimeout(() => {
      send({ type: "agent_start" });
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `${turn.text} (retried)` }],
          stopReason: "stop",
          timestamp: Date.now()
        }
      });
      send({ type: "agent_end", messages: [], willRetry: false });
      if (config.noSettle !== true) send({ type: "agent_settled" });
    }, config.retryDelayMs ?? 10);
    return;
  }
  if (config.noSettle === true) return;
  send({ type: "agent_settled" });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write("fake pi received malformed JSON\n");
    return;
  }
  record({ type: "in", frame });

  if (frame.type === "get_state") {
    response(
      frame.id,
      "get_state",
      config.getStateError === undefined
        ? {
            sessionId,
            messageCount,
            isStreaming: activeTurn !== undefined,
            thinkingLevel: flag("--thinking") ?? "off",
            model: { provider: flag("--provider") ?? "fixture", id: flag("--model") ?? "fixture-model" }
          }
        : undefined,
      config.getStateError
    );
    return;
  }
  if (frame.type === "prompt") {
    if (config.promptRejected === true) {
      response(frame.id, "prompt", undefined, "fixture rejected prompt");
      return;
    }
    response(frame.id, "prompt", { disposition: config.disposition ?? "started" });
    if ((config.disposition ?? "started") === "handled") return;
    emitTurn();
    return;
  }
  if (frame.type === "abort") {
    abortRequested = true;
    response(frame.id, "abort", undefined);
    if (config.abortHang === true) return;
    if (activeTurn !== undefined) {
      activeTurn = undefined;
      if (config.abortSettleOnly !== true) {
        send({ type: "agent_end", messages: [], willRetry: false });
      }
      if (config.noSettle !== true) send({ type: "agent_settled" });
    }
    return;
  }
  if (frame.type === "extension_ui_response") {
    return;
  }
  response(frame.id, frame.type, undefined, `unsupported command ${String(frame.type)}`);
});

lines.on("close", () => {
  record({ type: "close", sessionId, script: basename(process.argv[1] ?? "") });
  process.exit(config.exitCode ?? 0);
});
