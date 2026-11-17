import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyPiSettle,
  buildPiLaunchArgv,
  buildPiMcpConfig,
  piThinkingLevel,
  splitPiModel,
  type PiAssistantMessage
} from "../../../../src/adapters/pi/protocol.js";
import { piAgentDirectoryPath } from "../../../../src/adapters/pi/agent-dir.js";
import { PiRpcAdapter } from "../../../../src/adapters/pi/index.js";
import type { NativeEvent, NativeSession } from "../../../../src/adapters/types.js";
import { AIChatLinkError } from "../../../../src/core/errors.js";

const FIXTURE_SOURCE = fileURLToPath(new URL("../../../fixtures/pi", import.meta.url));
const workspaces: string[] = [];
const liveSessions: Array<{ adapter: PiRpcAdapter; session: NativeSession }> = [];

afterEach(async () => {
  for (const { adapter, session } of liveSessions.splice(0)) {
    await adapter.close(session).catch(() => undefined);
  }
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

describe("pi protocol helpers", () => {
  it("splits only a known provider prefix from the model id", () => {
    const providers = new Set(["newapi", "openai"]);
    expect(splitPiModel("newapi/deepseek-v4.1-flash", providers)).toEqual({
      provider: "newapi",
      model: "deepseek-v4.1-flash"
    });
    expect(splitPiModel("anthropic/claude-sonnet-4", providers)).toEqual({
      provider: undefined,
      model: "anthropic/claude-sonnet-4"
    });
    expect(splitPiModel(undefined, providers)).toEqual({ provider: undefined, model: undefined });
  });

  it("maps the room vocabulary onto pi levels", () => {
    expect(piThinkingLevel("none")).toBe("off");
    expect(piThinkingLevel("ultra")).toBe("max");
    expect(piThinkingLevel("high")).toBe("high");
    expect(piThinkingLevel("bogus")).toBeUndefined();
  });

  it("builds the fixed RPC argv without accepting native policy flags", () => {
    expect(
      buildPiLaunchArgv("node", ["C:/pi/cli.js"], {
        sessionId: "session-1",
        provider: "newapi",
        model: "deepseek-v4.1-flash",
        thinking: "high"
      })
    ).toEqual([
      "node",
      "C:/pi/cli.js",
      "--mode",
      "rpc",
      "--session-id",
      "session-1",
      "--provider",
      "newapi",
      "--model",
      "deepseek-v4.1-flash",
      "--thinking",
      "high"
    ]);
  });

  it("writes a direct-exposure AIChatLink MCP entry with the binding header", () => {
    expect(
      buildPiMcpConfig({ transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }, "binding:pi:1")
    ).toEqual({
      mcpServers: {
        aichatlink: {
          type: "http",
          url: "http://127.0.0.1:4310/mcp",
          headers: { "X-AIChatLink-Binding": "binding:pi:1" },
          exposure: "direct"
        }
      }
    });
    expect(() =>
      buildPiMcpConfig({ transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }, undefined)
    ).toThrowError(expect.objectContaining({ code: "MCP_BINDING_MISMATCH" }));
  });

  it("classifies the settled assistant message, never agent_end", () => {
    const message = (overrides: Partial<PiAssistantMessage>): PiAssistantMessage => ({
      stopReason: "stop",
      errorMessage: undefined,
      usage: undefined,
      text: "",
      thinking: "",
      ...overrides
    });
    expect(classifyPiSettle(message({}), false)).toBe("completed");
    expect(classifyPiSettle(message({ stopReason: "error" }), false)).toBe("failed");
    expect(classifyPiSettle(message({ stopReason: "aborted" }), false)).toBe("cancelled");
    expect(classifyPiSettle(message({ stopReason: "error" }), true)).toBe("cancelled");
  });
});

describe("pi RPC adapter", () => {
  it("starts with an isolated agent directory, trimmed providers, and a direct MCP entry", async () => {
    const workspace = await fixtureWorkspace({});
    const userAgentDirectory = await userPiDirectory(workspace);
    const adapter = piAdapter(userAgentDirectory);

    const session = await adapter.start({
      command: process.execPath,
      prefixArgs: [join(workspace, "fake-pi.mjs")],
      cwd: workspace,
      instanceId: "instance:pi:prebound",
      bindingId: "binding:pi:test",
      mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" },
      model: "newapi/deepseek-v4.1-flash",
      thinking: "high"
    });
    liveSessions.push({ adapter, session });

    expect(session).toMatchObject({
      adapterId: "pi",
      actorId: "agent:pi",
      protocol: "pi-rpc-jsonl-v1",
      instanceId: "instance:pi:prebound",
      bindingId: "binding:pi:test"
    });
    expect(session.nativeSessionId).toMatch(/[0-9a-f-]{36}/u);
    expect(adapter.health()).toMatchObject({ status: "ready", nativeSessionAvailable: true });

    const agentDirectory = piAgentDirectoryPath(workspace, "pi");
    const models = JSON.parse(await readFile(join(agentDirectory, "models.json"), "utf8"));
    expect(Object.keys(models.providers)).toEqual(["newapi"]);
    expect(models.providers.newapi.models.length).toBeGreaterThan(0);
    const settings = JSON.parse(await readFile(join(agentDirectory, "settings.json"), "utf8"));
    expect(settings).toMatchObject({
      defaultProvider: "newapi",
      defaultModel: "deepseek-v4.1-flash",
      defaultThinkingLevel: "high",
      compaction: { enabled: true }
    });
    const mcp = JSON.parse(await readFile(join(agentDirectory, "mcp.json"), "utf8"));
    expect(mcp).toEqual({
      mcpServers: {
        aichatlink: {
          type: "http",
          url: "http://127.0.0.1:4310/mcp",
          headers: { "X-AIChatLink-Binding": "binding:pi:test" },
          exposure: "direct"
        }
      }
    });

    const startup = (await wireLog(workspace)).find((entry) => entry.type === "startup");
    const argv = startup?.argv as string[];
    expect(argv.slice(0, 5)).toEqual(["--mode", "rpc", "--session-id", session.nativeSessionId, "--provider"]);
    expect(argv[argv.indexOf("--model") + 1]).toBe("deepseek-v4.1-flash");
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");

    const report = await adapter.probe();
    expect(report.protocol).toBe("pi-rpc-jsonl-v1");
    expect(report.findings.find((entry) => entry.capability === "rpc.get_state")).toMatchObject({
      level: "verified"
    });
    expect(report.findings.find((entry) => entry.capability === "context.isolation")).toMatchObject({
      level: "probed"
    });
    expect(report.findings.find((entry) => entry.capability === "mcp.http")).toMatchObject({ level: "probed" });
  });

  it("normalizes one turn without duplicating streamed text and finishes only on agent_settled", async () => {
    const workspace = await fixtureWorkspace({ prompt: { text: "pi answer", tool: true, thinkingDelta: true } });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "reasoning.delta",
      "tool.started",
      "tool.completed",
      "turn.completed"
    ]);
    expect(events[1]?.payload).toMatchObject({ text: "pi answer" });
    expect(events[2]?.payload).toMatchObject({ text: "thinking hard" });
    expect(events[3]?.payload).toMatchObject({ toolUseId: "call_1", toolName: "bash" });
    expect(events[4]?.payload).toMatchObject({ toolUseId: "call_1", status: "completed" });
    expect(events.at(-1)?.payload).toMatchObject({ stopReason: "stop" });
    expect(events.every((event) => event.nativeSessionId === session.nativeSessionId)).toBe(true);
  });

  it("does not finish a turn on agent_end when pi will retry", async () => {
    const workspace = await fixtureWorkspace({ prompt: { text: "first", willRetry: true } });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("falls back to the complete assistant message when no text delta streamed", async () => {
    const workspace = await fixtureWorkspace({ prompt: { text: "fallback text", streamText: false } });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.find((event) => event.type === "content.delta")?.payload).toMatchObject({
      text: "fallback text",
      finalMessageFallback: true
    });
  });

  it("reports a stopReason=error assistant as a failed turn, not an empty success", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { text: "", stopReason: "error", errorMessage: "provider exploded" }
    });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload).toMatchObject({ errorCode: "TURN_INTERRUPTED" });
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
  });

  it("cancels through abort and reports the settled cancellation", async () => {
    const workspace = await fixtureWorkspace({ prompt: { hold: true } });
    const adapter = piAdapter(await userPiDirectory(workspace), { cancelMs: 2_000 });
    const session = await startFixture(adapter, workspace);

    const controller = new AbortController();
    const collection = collect(
      adapter.prompt(session, {
        turnId: "turn-1",
        content: "hold",
        correlationId: "corr-1",
        signal: controller.signal
      })
    );
    await waitFor(() => wireLog(workspace).then((log) => log.some((entry) => entry.frame?.type === "prompt")));
    const result = await adapter.cancel(session, "turn-1");
    controller.abort();
    const events = await collection;

    expect(result).toMatchObject({ requested: true, supported: true, terminalObserved: true });
    expect(events.at(-1)?.type).toBe("turn.cancelled");
  });

  it("fails the turn when the process exits before agent_settled and cleans the credential copy", async () => {
    const workspace = await fixtureWorkspace({ prompt: { exitAfterAccept: true } });
    const userAgentDirectory = await userPiDirectory(workspace);
    const adapter = piAdapter(userAgentDirectory);
    const session = await startFixture(adapter, workspace, "newapi/deepseek-v4.1-flash");

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(adapter.health().status).toBe("failed");
    const directory = piAgentDirectoryPath(workspace, "pi");
    await waitFor(async () => {
      try {
        await readFile(join(directory, "models.json"), "utf8");
        return false;
      } catch {
        return true;
      }
    });
  });

  it("fails closed on non-JSON stdout", async () => {
    const workspace = await fixtureWorkspace({ prompt: { malformed: true } });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.find((event) => event.type === "transport.error")?.payload).toMatchObject({
      errorCode: "PROTOCOL_INVALID_MESSAGE"
    });
    // A protocol failure poisons the process: the next prompt must not reuse a
    // possibly still-running native run.
    await expect(
      collect(adapter.prompt(session, { turnId: "turn-2", content: "again", correlationId: "corr-2" }))
    ).rejects.toMatchObject({ code: "SESSION_NOT_AVAILABLE" });
  });

  it("recovers quickly when an abort is answered by a settle without agent_end", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { hold: true },
      abortSettleOnly: true
    });
    const adapter = piAdapter(await userPiDirectory(workspace), { idleMs: 120, cancelMs: 5_000 });
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hold", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    // The settle was recognised during the timeout path, so the process was
    // not torn down after waiting the full cancellation window.
    expect(adapter.health().status).toBe("ready");
  });

  it("cleans the credential copy when the native session fails to start", async () => {
    const workspace = await fixtureWorkspace({ getStateError: "no model configured" });
    const userAgentDirectory = await userPiDirectory(workspace);
    const adapter = piAdapter(userAgentDirectory);

    await expect(
      adapter.start({
        command: process.execPath,
        prefixArgs: [join(workspace, "fake-pi.mjs")],
        cwd: workspace,
        model: "newapi/deepseek-v4.1-flash"
      })
    ).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });

    const directory = piAgentDirectoryPath(workspace, "pi");
    await waitFor(async () => {
      try {
        await readFile(join(directory, "models.json"), "utf8");
        return false;
      } catch {
        return true;
      }
    });
  });

  it("ignores a stray agent_settled from the previous run", async () => {
    const workspace = await fixtureWorkspace({ prompt: { text: "second run" }, straySettleBeforeRun: true });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    // First turn is a normal run so promptCounter reaches 2 on the next one.
    await collect(adapter.prompt(session, { turnId: "turn-1", content: "one", correlationId: "corr-1" }));
    const second = await collect(
      adapter.prompt(session, { turnId: "turn-2", content: "two", correlationId: "corr-2" })
    );

    expect(second.map((event) => event.type)).toContain("content.delta");
    expect(second.at(-1)?.type).toBe("turn.completed");
    expect(second.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("times out a run that never produces its first event", async () => {
    const workspace = await fixtureWorkspace({ prompt: { hold: true, silence: true } });
    const adapter = piAdapter(await userPiDirectory(workspace), { firstEventMs: 80 });
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload).toMatchObject({ errorCode: "TURN_INTERRUPTED" });
  });

  it("times out a run that is active but idle, then stops it before failing", async () => {
    const workspace = await fixtureWorkspace({ prompt: { hold: true } });
    const adapter = piAdapter(await userPiDirectory(workspace), { idleMs: 120, cancelMs: 1_000 });
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hold", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload).toMatchObject({ errorCode: "TURN_INTERRUPTED" });
    // The idle run was aborted and settled, so the process stays reusable.
    expect(adapter.health().status).toBe("ready");
  });

  it("reports a cancellation that pi never settles as not observed and tears the process down", async () => {
    const workspace = await fixtureWorkspace({ prompt: { hold: true }, abortHang: true });
    const adapter = piAdapter(await userPiDirectory(workspace), { cancelMs: 120 });
    const session = await startFixture(adapter, workspace);

    const controller = new AbortController();
    const collection = collect(
      adapter.prompt(session, {
        turnId: "turn-1",
        content: "hold",
        correlationId: "corr-1",
        signal: controller.signal
      })
    );
    await waitFor(() => wireLog(workspace).then((log) => log.some((entry) => entry.frame?.type === "prompt")));
    const result = await adapter.cancel(session, "turn-1");
    const events = await collection;

    expect(result).toMatchObject({ requested: true, terminalObserved: false });
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("fails the turn when pi rejects the prompt", async () => {
    const workspace = await fixtureWorkspace({ promptRejected: true });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload).toMatchObject({ errorCode: "TURN_INTERRUPTED" });
  });

  it("ignores fire-and-forget extension UI notifications", async () => {
    const workspace = await fixtureWorkspace({ prompt: { text: "notified", uiRequest: true, uiRequestMethod: "notify" } });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("fails closed on an interactive extension UI request", async () => {
    const workspace = await fixtureWorkspace({ prompt: { uiRequest: true } });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)?.payload).toMatchObject({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" });
  });

  it("resumes only when the native session file exists", async () => {
    const workspace = await fixtureWorkspace({ resumeMessageCount: 4 });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);
    const resumedId = session.nativeSessionId as string;
    const agentDirectory = piAgentDirectoryPath(workspace, "pi");
    const sessionDirectory = join(agentDirectory, "sessions", "--fixture--");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, `2026-01-01T00-00-00-000Z_${resumedId}.jsonl`), "{}\n", "utf8");
    await adapter.close(session);
    liveSessions.length = 0;

    const resumed = await adapter.resume({
      command: process.execPath,
      prefixArgs: [join(workspace, "fake-pi.mjs")],
      cwd: workspace,
      nativeSessionId: resumedId
    });
    liveSessions.push({ adapter, session: resumed });
    expect(resumed.nativeSessionId).toBe(resumedId);

    await adapter.close(resumed);
    liveSessions.length = 0;
    await expect(
      adapter.resume({
        command: process.execPath,
        prefixArgs: [join(workspace, "fake-pi.mjs")],
        cwd: workspace,
        nativeSessionId: "missing-session"
      })
    ).rejects.toMatchObject({ code: "SESSION_NOT_AVAILABLE" });
  });

  it("treats an extension-handled prompt as a completed turn without waiting for settle", async () => {
    const workspace = await fixtureWorkspace({ disposition: "handled" });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "/command", correlationId: "corr-1" })
    );

    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.at(-1)?.payload).toMatchObject({ stopReason: "handled" });
  });

  it("removes a stale MCP entry when the launch has no binding", async () => {
    const workspace = await fixtureWorkspace({});
    const userAgentDirectory = await userPiDirectory(workspace);
    const adapter = piAdapter(userAgentDirectory);
    const directory = piAgentDirectoryPath(workspace, "pi");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "mcp.json"), '{"mcpServers":{"stale":{}}}\n', "utf8");

    const session = await adapter.start({
      command: process.execPath,
      prefixArgs: [join(workspace, "fake-pi.mjs")],
      cwd: workspace
    });
    liveSessions.push({ adapter, session });

    await expect(readFile(join(directory, "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tears down an idle protocol violation and allows a fresh start", async () => {
    const workspace = await fixtureWorkspace({ malformedAfterStart: true });
    const userAgentDirectory = await userPiDirectory(workspace);
    const adapter = piAdapter(userAgentDirectory);
    const session = await startFixture(adapter, workspace, "newapi/deepseek-v4.1-flash");

    await waitFor(async () => adapter.health().status !== "ready");
    const directory = piAgentDirectoryPath(workspace, "pi");
    await waitFor(async () => {
      try {
        await readFile(join(directory, "models.json"), "utf8");
        return false;
      } catch {
        return true;
      }
    });
    expect(adapter.health().lastError).toBeDefined();

    const restarted = await adapter.start({
      command: process.execPath,
      prefixArgs: [join(workspace, "fake-pi.mjs")],
      cwd: workspace
    });
    liveSessions.push({ adapter, session: restarted });
    expect(restarted.nativeSessionId).not.toBe(session.nativeSessionId);
  });

  it("keeps the process reusable after a native stopReason=error turn", async () => {
    const workspace = await fixtureWorkspace({ failFirstPromptOnly: true, prompt: { text: "recovered" } });
    const adapter = piAdapter(await userPiDirectory(workspace));
    const session = await startFixture(adapter, workspace);

    const first = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "one", correlationId: "corr-1" })
    );
    expect(first.at(-1)?.type).toBe("turn.failed");
    expect(adapter.health().status).toBe("ready");

    const second = await collect(
      adapter.prompt(session, { turnId: "turn-2", content: "two", correlationId: "corr-2" })
    );
    expect(second.at(-1)?.type).toBe("turn.completed");
    expect(second.find((event) => event.type === "content.delta")?.payload).toMatchObject({
      text: "recovered"
    });
  });

  it("refuses an unreadable provider catalog without echoing its contents", async () => {
    const workspace = await fixtureWorkspace({});
    const userAgentDirectory = join(workspace, "user-pi");
    await mkdir(userAgentDirectory, { recursive: true });
    await writeFile(join(userAgentDirectory, "models.json"), '{"apiKey":"fixture-secret"', "utf8");
    const adapter = piAdapter(userAgentDirectory);

    await expect(
      adapter.start({
        command: process.execPath,
        prefixArgs: [join(workspace, "fake-pi.mjs")],
        cwd: workspace
      })
    ).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });
    expect(adapter.health().lastError).not.toContain("fixture-secret");
  });
});

function piAdapter(
  userAgentDirectory: string,
  timeouts: Partial<Record<string, number>> = {}
): PiRpcAdapter {
  return new PiRpcAdapter({
    userAgentDirectory,
    timeouts: {
      handshakeMs: 2_000,
      requestMs: 2_000,
      firstEventMs: 2_000,
      idleMs: 2_000,
      cancelMs: 2_000,
      closeMs: 250,
      ...timeouts
    }
  });
}

async function startFixture(
  adapter: PiRpcAdapter,
  workspace: string,
  model?: string
): Promise<NativeSession> {
  const session = await adapter.start({
    command: process.execPath,
    prefixArgs: [join(workspace, "fake-pi.mjs")],
    cwd: workspace,
    ...(model === undefined ? {} : { model })
  });
  liveSessions.push({ adapter, session });
  return session;
}

async function collect(stream: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> {
  const events: NativeEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function fixtureWorkspace(config: Record<string, unknown>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "aichatlink-pi-fixture-"));
  workspaces.push(workspace);
  await Promise.all([
    copyFile(join(FIXTURE_SOURCE, "fake-pi.mjs"), join(workspace, "fake-pi.mjs")),
    writeFile(join(workspace, "fake-pi-config.json"), JSON.stringify(config), "utf8")
  ]);
  return workspace;
}

async function userPiDirectory(workspace: string): Promise<string> {
  const directory = join(workspace, "user-pi");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "models.json"),
    JSON.stringify({
      providers: {
        newapi: {
          name: "newapi",
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          apiKey: "fixture-secret",
          models: [{ id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" }]
        },
        other: {
          name: "other",
          baseUrl: "https://other.invalid/v1",
          api: "openai-completions",
          apiKey: "other-secret",
          models: [{ id: "other-model", name: "other-model" }]
        }
      }
    }),
    "utf8"
  );
  return directory;
}

async function wireLog(workspace: string): Promise<Array<Record<string, any>>> {
  try {
    const text = await readFile(join(workspace, "fake-pi-wire.jsonl"), "utf8");
    return text
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the timeout");
}
