import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShim } from "../shim.mjs";
import { createLineReader, encodeRecord } from "../lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakePi = path.join(here, "fake-pi.mjs");

// A stand-in user agent dir. Keys here are obvious dummies, never real ones.
async function makeUserAgentDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-shim-user-"));
  await writeFile(
    path.join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          fakeA: { baseUrl: "https://a.invalid/v1", apiKey: "dummy-a", models: [{ id: "fake-model" }] },
          fakeB: { baseUrl: "https://b.invalid/v1", apiKey: "dummy-b", models: [{ id: "other-model" }] },
          unused: { baseUrl: "https://c.invalid/v1", apiKey: "dummy-c", models: [{ id: "x" }] },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      packages: ["npm:pi-plan-mode", "npm:pi-goal-x"],
      extensions: ["C:/somewhere/hindsight/pi.js"],
      defaultProvider: "fakeA",
      defaultModel: "fake-model",
      defaultThinkingLevel: "xhigh",
      compaction: { modelOverrides: { "fakeA/fake-model": { reserveTokens: 1234 } } },
    }),
  );
  return dir;
}

async function boot() {
  const rolesRoot = await mkdtemp(path.join(os.tmpdir(), "pi-shim-roles-"));
  const userAgentDir = await makeUserAgentDir();
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  createLineReader(output, { onLine: (line) => frames.push(JSON.parse(line)), onError: () => {} });

  const running = runShim({
    roleId: "t-architect",
    role: {
      model: "fake-model",
      provider: "fakeA",
      thinking: "high",
      tools: { mode: "all" },
      workdir: null,
      contextFiles: false,
      systemPrompt: null,
      providers: ["fakeA", "fakeB"],
      piArgs: [],
    },
    rolesRoot,
    userAgentDir,
    piEntry: fakePi,
    argv: [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          aichatlink: { type: "stdio", command: process.execPath, args: ["/abs/aichatlink-mcp.mjs", "--binding", "bind-1"] },
        },
      }),
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
    ],
    input,
    output,
    log: () => {},
  });

  const send = (frame) => input.write(encodeRecord(frame));
  const waitFor = async (predicate, label, timeoutMs = 8_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const hit = frames.find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timeout waiting for ${label}; got ${JSON.stringify(frames).slice(0, 600)}`);
  };
  const settle = async () => {
    input.end();
    await running.catch(() => {});
  };
  return { frames, send, waitFor, settle, rolesRoot, userAgentDir };
}

test("initialize is answered with current_permission_mode", async () => {
  const ctx = await boot();
  ctx.send({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
  const reply = await ctx.waitFor((frame) => frame.type === "control_response", "init response");
  assert.equal(reply.response.request_id, "init-1");
  assert.equal(reply.response.response.current_permission_mode, "bypassPermissions");
  await ctx.settle();
});

test("set_permission_mode returns the established mode", async () => {
  const ctx = await boot();
  ctx.send({ type: "control_request", request_id: "perm-1", request: { subtype: "set_permission_mode", mode: "bypassPermissions" } });
  const reply = await ctx.waitFor((frame) => frame.type === "control_response", "perm response");
  assert.equal(reply.response.response.mode, "bypassPermissions");
  await ctx.settle();
});

test("a user turn becomes message_start, deltas, aggregate, tool_result and result", async () => {
  const ctx = await boot();
  ctx.send({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello there" }] } });
  const result = await ctx.waitFor((frame) => frame.type === "result", "result frame");
  await ctx.settle();

  const kinds = ctx.frames.map((frame) => frame.type);
  assert.ok(kinds.includes("assistant"));
  const start = ctx.frames.find((frame) => frame.event?.type === "message_start");
  assert.ok(start, "expected a message_start stream event");
  const deltas = ctx.frames.filter((frame) => frame.event?.delta?.type === "text_delta");
  assert.ok(deltas.length > 1, "text must stream in more than one delta");
  const streamed = deltas.map((frame) => frame.event.delta.text).join("");
  assert.ok(streamed.startsWith("[host_agent]"), "host facts must lead the prompt");
  assert.match(streamed, /model=fake-model/u);
  assert.ok(streamed.includes("hello there"), "deltas must reconstruct the model output");
  const aggregate = ctx.frames.find((frame) => frame.type === "assistant");
  assert.ok(aggregate.message.content[0].text.includes("hello there"));
  const toolUse = ctx.frames.find((frame) => frame.event?.content_block?.type === "tool_use");
  assert.equal(toolUse.event.content_block.id, "call-1");
  const toolResult = ctx.frames.find((frame) => frame.type === "user");
  assert.equal(toolResult.message.content[0].tool_use_id, "call-1");
  assert.equal(result.subtype, "success");
  assert.equal(result.is_error, false);
  assert.deepEqual(result.usage, { input: 12, output: 34 });
  // No extension UI record may leak through to AIChatLink.
  assert.equal(ctx.frames.some((frame) => frame.type === "extension_ui_request"), false);
});

test("interrupt acknowledges immediately and settles as cancelled", async () => {
  const ctx = await boot();
  ctx.send({ type: "user", message: { role: "user", content: [{ type: "text", text: "long job" }] } });
  await ctx.waitFor((frame) => frame.event?.delta?.type === "text_delta", "first delta");
  ctx.send({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } });
  const ack = await ctx.waitFor(
    (frame) => frame.type === "control_response" && frame.response.request_id === "int-1",
    "interrupt ack",
  );
  assert.equal(ack.response.subtype, "success");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await ctx.settle();
  const cancelled = ctx.frames.find((frame) => frame.type === "result" && frame.terminal_reason === "aborted_streaming");
  assert.ok(cancelled, "a cancelled result frame must settle the turn");
});

test("/model switches in place, persists a snapshot and answers inside a synthetic turn", async () => {
  const ctx = await boot();
  ctx.send({ type: "user", message: { role: "user", content: [{ type: "text", text: "/model fakeB/other-model" }] } });
  const result = await ctx.waitFor((frame) => frame.type === "result", "synthetic result");
  assert.equal(result.subtype, "success");
  const text = ctx.frames
    .filter((frame) => frame.event?.delta?.type === "text_delta")
    .map((frame) => frame.event.delta.text)
    .join("");
  assert.match(text, /已切换到 fakeB\/other-model/);

  const snapshot = JSON.parse(await readFile(path.join(ctx.rolesRoot, "t-architect.role.json"), "utf8"));
  assert.equal(snapshot.provider, "fakeB");
  assert.equal(snapshot.model, "other-model");
  await ctx.settle();
});

test("role dir is minimal: trimmed providers, generated settings, aichatlink-only mcp", async () => {
  const ctx = await boot();
  try {
    // Give prepareRoleDir a moment; it runs before the pi child is spawned.
    await new Promise((resolve) => setTimeout(resolve, 400));
  const roleDir = path.join(ctx.rolesRoot, "t-architect");

  const models = JSON.parse(await readFile(path.join(roleDir, "models.json"), "utf8"));
  assert.deepEqual(Object.keys(models.providers).sort(), ["fakeA", "fakeB"], "only configured providers survive");

  const settings = JSON.parse(await readFile(path.join(roleDir, "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(settings).sort(), ["compaction", "defaultModel", "defaultProvider", "defaultThinkingLevel"]);
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.equal(settings.packages, undefined, "package extensions must never be copied");
  assert.equal(settings.extensions, undefined, "local extensions must never be copied");

  const mcp = JSON.parse(await readFile(path.join(roleDir, "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["aichatlink"]);
  assert.deepEqual(mcp.mcpServers.aichatlink.args.slice(-2), ["--binding", "bind-1"]);
  } finally {
    await ctx.settle();
  }
});

test("a slash command is read from the [current_message] tail, not the room packet", async () => {
  const ctx = await boot();
  const packet = [
    "[room_context]",
    "agent:pi-reviewer said: 上一条房间消息",
    "",
    "[current_message]",
    "/model fakeB/other-model",
  ].join("\n");
  ctx.send({ type: "user", message: { role: "user", content: [{ type: "text", text: packet }] } });
  const result = await ctx.waitFor((frame) => frame.type === "result", "synthetic result");
  await ctx.settle();

  assert.equal(result.subtype, "success");
  const text = ctx.frames
    .filter((frame) => frame.event?.delta?.type === "text_delta")
    .map((frame) => frame.event.delta.text)
    .join("");
  assert.match(text, /已切换到 fakeB\/other-model/, "the switch must be answered locally");

  const snapshot = JSON.parse(await readFile(path.join(ctx.rolesRoot, "t-architect.role.json"), "utf8"));
  assert.equal(snapshot.provider, "fakeB");
  assert.equal(snapshot.model, "other-model");
});

test("the packet alone never looks like a slash command", async () => {
  const ctx = await boot();
  const packet = "[room_context]\nuse /model to switch\n\n[current_message]\n你好";
  ctx.send({ type: "user", message: { role: "user", content: [{ type: "text", text: packet }] } });
  const result = await ctx.waitFor((frame) => frame.type === "result", "model result");
  await ctx.settle();
  assert.equal(result.subtype, "success");
  const text = ctx.frames
    .filter((frame) => frame.event?.delta?.type === "text_delta")
    .map((frame) => frame.event.delta.text)
    .join("");
  assert.doesNotMatch(text, /已切换到|未知指令/, "a normal message must reach the model, not a local command handler");
});
