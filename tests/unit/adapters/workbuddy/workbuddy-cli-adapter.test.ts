import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { NativeEvent, NativeSession } from "../../../../src/adapters/types.js";
import { WorkBuddyCliAdapter } from "../../../../src/adapters/workbuddy/index.js";

const FIXTURE_SOURCE = fileURLToPath(new URL("../../../fixtures/claude", import.meta.url));
const workspaces: string[] = [];
const liveSessions: Array<{ adapter: WorkBuddyCliAdapter; session: NativeSession }> = [];

afterEach(async () => {
  for (const { adapter, session } of liveSessions.splice(0)) {
    await adapter.close(session).catch(() => undefined);
  }
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

describe("WorkBuddy stream-json adapter", () => {
  it("starts when initialize omits current_permission_mode and the vendor rejects set_permission_mode", async () => {
    const workspace = await fixtureWorkspace({
      omitInitializePermissionMode: true,
      setModeError: "Session not found: current"
    });
    const adapter = new WorkBuddyCliAdapter({ timeouts: fixtureTimeouts() });

    const session = await adapter.start({
      command: process.execPath,
      prefixArgs: [join(workspace, "fixture-claude.mjs")],
      cwd: workspace,
      instanceId: "instance:workbuddy:prebound",
      bindingId: "binding:workbuddy:test",
      mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }
    });
    liveSessions.push({ adapter, session });

    expect(session).toMatchObject({
      adapterId: "workbuddy",
      actorId: "agent:workbuddy",
      instanceId: "instance:workbuddy:prebound",
      bindingId: "binding:workbuddy:test",
      protocol: "workbuddy-codebuddy-stream-json-v1"
    });
    expect(adapter.health()).toMatchObject({ status: "ready", nativeSessionAvailable: true });

    const report = await adapter.probe();
    expect(report.protocol).toBe("workbuddy-codebuddy-stream-json-v1");
    expect(report.findings.find((entry) => entry.capability === "control.initialize")).toMatchObject({
      level: "verified"
    });
    // Argv is the request, not proof: the first system/init frame must verify it.
    expect(report.findings.find((entry) => entry.capability === "access.unrestricted")).toMatchObject({
      level: "advertised"
    });

    const startup = (await wireLog(workspace)).find((entry) => entry.event === "startup");
    const argv = startup?.argv as string[];
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}")).toMatchObject({
      mcpServers: { aichatlink: { type: "http", headers: { "X-AIChatLink-Binding": "binding:workbuddy:test" } } }
    });
    // The vendor cannot answer this before its first session exists, so the
    // adapter must not send it at all.
    expect((await wireLog(workspace)).some((entry) => entry.frame?.request?.subtype === "set_permission_mode")).toBe(false);
  });

  it("verifies bypassPermissions from the first system/init frame and completes the turn", async () => {
    const workspace = await fixtureWorkspace({
      omitInitializePermissionMode: true,
      setModeError: "Session not found: current"
    });
    const adapter = new WorkBuddyCliAdapter({ timeouts: fixtureTimeouts() });
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "reasoning.delta",
      "content.delta",
      "tool.started",
      "tool.completed",
      "turn.completed"
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ terminalReason: "completed" });
    // The verified system/init frame promotes the argv request to probed.
    expect((await adapter.probe()).findings.find((entry) => entry.capability === "access.unrestricted")).toMatchObject({
      level: "probed"
    });
  });

  it("fails the turn closed when the session banner downgrades the permission mode", async () => {
    const workspace = await fixtureWorkspace({
      omitInitializePermissionMode: true,
      setModeError: "Session not found: current",
      initPermissionMode: "default"
    });
    const adapter = new WorkBuddyCliAdapter({ timeouts: fixtureTimeouts() });
    const session = await startFixture(adapter, workspace);

    const events = await collect(
      adapter.prompt(session, { turnId: "turn-1", content: "hello", correlationId: "corr-1" })
    );

    expect(events.map((event) => event.type)).toContain("turn.failed");
    expect(events.find((event) => event.type === "transport.error")?.payload).toMatchObject({
      errorCode: "NATIVE_POLICY_BLOCKED"
    });
  });
});

function fixtureTimeouts(): Record<string, number> {
  return {
    handshakeMs: 2_000,
    requestMs: 2_000,
    firstEventMs: 2_000,
    idleMs: 2_000,
    cancelMs: 2_000,
    closeMs: 250
  };
}

async function startFixture(adapter: WorkBuddyCliAdapter, workspace: string): Promise<NativeSession> {
  const session = await adapter.start({
    command: process.execPath,
    prefixArgs: [join(workspace, "fixture-claude.mjs")],
    cwd: workspace
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

async function fixtureWorkspace(config: Record<string, unknown> = {}): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "aichatlink-workbuddy-fixture-"));
  workspaces.push(workspace);
  await Promise.all([
    copyFile(join(FIXTURE_SOURCE, "fixture-claude.mjs"), join(workspace, "fixture-claude.mjs")),
    writeFile(join(workspace, "fixture-config.json"), JSON.stringify(config), "utf8")
  ]);
  return workspace;
}

async function wireLog(workspace: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(join(workspace, "wire-log.jsonl"), "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}
