import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SetupApi, SetupWorkspaceApi } from "../../../../src/web/server/index.js";
import { createAIChatLinkSetupHttpServer, type AIChatLinkSetupHttpServer } from "../../../../src/web/setup/index.js";

const directories: string[] = [];
const servers: AIChatLinkSetupHttpServer[] = [];

function workspaceApi(directories: string[] = []): SetupWorkspaceApi {
  return {
    list: (requested) => {
      const target = requested ?? "/workspace";
      return { path: target, parent: "/", shortcuts: [], entries: [], truncated: false };
    },
    reveal: (requested) => {
      directories.push(requested);
      return { opened: true, path: requested };
    }
  };
}

function setupApi(): SetupApi {
  return {
    snapshot: () => ({
      configPath: "D:\\AIChatLink\\aichatlink.json",
      existing: false,
      runtimeActive: false,
      drivers: [
        { driver: "codex", found: true },
        { driver: "grok", found: true },
        { driver: "claude", found: true },
        { driver: "pi", found: true },
        { driver: "workbuddy", found: true },
        { driver: "kimi", found: true },
        { driver: "hermes", found: true }
      ],
      config: {
        serverPort: 4_310,
        storagePath: ".aichatlink/aichatlink.db",
        agents: [{
          id: "codex",
          driver: "codex",
          name: "",
          command: { executable: "codex", prefixArgs: [] },
          cwd: ".",
          enabled: true
        }]
      }
    }),
    save: (request) => ({
      saved: true,
      configPath: "D:\\AIChatLink\\aichatlink.json",
      agentCount: request.config.agents.length,
      enabledAgentCount: request.config.agents.filter((agent) => agent.enabled).length,
      restartRequired: false
    })
  };
}

describe("standalone setup server", () => {
  it("serves the wizard and resolves completion after a valid multi-Codex save", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aichatlink-setup-http-"));
    directories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "setup.html"), "<!doctype html><title>Agent setup</title>"),
      writeFile(path.join(directory, "setup.js"), "document.body.dataset.setup = 'ready';"),
      writeFile(path.join(directory, "pagination.js"), "export const marker = 'pagination';"),
      writeFile(path.join(directory, "setup.css"), "body { color: black; }")
    ]);
    const api = setupApi();
    const save = vi.spyOn(api, "save");
    const server = createAIChatLinkSetupHttpServer({ setupApi: api, staticRoot: directory });
    servers.push(server);
    const origin = (await server.start()).origin;

    expect(await (await fetch(`${origin}/`)).text()).toContain("Agent setup");
    expect((await (await fetch(`${origin}/api/setup`)).json() as { configPath: string }).configPath).toContain("aichatlink.json");

    const response = await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          serverPort: 4_310,
          storagePath: ".aichatlink/aichatlink.db",
          agents: ["codex", "reviewer"].map((id) => ({
            id,
            driver: "codex",
            name: id === "reviewer" ? "Reviewer" : "",
            identity: id === "reviewer" ? "独立审查当前房间任务" : "",
            command: { executable: "codex", prefixArgs: [] },
            cwd: ".",
            enabled: true
          }))
        }
      })
    });

    expect(response.status).toBe(200);
    expect(save.mock.calls[0]?.[0].config.agents[1]?.identity).toBe("独立审查当前房间任务");
    await expect(server.completed).resolves.toMatchObject({ agentCount: 2, enabledAgentCount: 2 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(await (await fetch(`${origin}/api/setup/launch`)).json()).toEqual({ status: "waiting" });
    server.markLaunchReady("http://127.0.0.1:4310");
    expect(await (await fetch(`${origin}/api/setup/launch`)).json()).toEqual({
      status: "ready",
      origin: "http://127.0.0.1:4310"
    });
    await expect(server.launchObserved).resolves.toBeUndefined();
    expect(await (await fetch(`${origin}/setup.js`)).text()).toContain("dataset.setup");
    expect(await (await fetch(`${origin}/pagination.js`)).text()).toContain("pagination");
  });

  it("serves the workspace picker and requires the setup header before revealing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aichatlink-setup-workspace-"));
    directories.push(directory);
    const revealed: string[] = [];
    const server = createAIChatLinkSetupHttpServer({
      setupApi: setupApi(),
      workspaceApi: workspaceApi(revealed),
      staticRoot: directory
    });
    servers.push(server);
    const origin = (await server.start()).origin;

    const listing = await fetch(`${origin}/api/setup/workspace?path=${encodeURIComponent("/repo")}`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ path: "/repo", parent: "/", truncated: false });

    const missingHeader = await fetch(`${origin}/api/setup/workspace/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/repo" })
    });
    expect(missingHeader.status).toBe(400);
    expect(revealed).toEqual([]);

    const revealedResponse = await fetch(`${origin}/api/setup/workspace/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aichatlink-setup": "1" },
      body: JSON.stringify({ path: "/repo" })
    });
    expect(revealedResponse.status).toBe(200);
    expect(await revealedResponse.json()).toEqual({ opened: true, path: "/repo" });
    expect(revealed).toEqual(["/repo"]);

    const wrongMethod = await fetch(`${origin}/api/setup/workspace`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });

  it("reports a bounded launch failure and rejects non-loopback redirect origins", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aichatlink-setup-http-"));
    directories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "setup.html"), "setup"),
      writeFile(path.join(directory, "setup.js"), "setup"),
      writeFile(path.join(directory, "setup.css"), "setup")
    ]);
    const server = createAIChatLinkSetupHttpServer({ setupApi: setupApi(), staticRoot: directory });
    servers.push(server);
    const origin = (await server.start()).origin;
    const body = JSON.stringify({
      config: {
        serverPort: 4_310,
        storagePath: ".aichatlink/aichatlink.db",
        agents: [{
          id: "codex",
          driver: "codex",
          name: "",
          command: { executable: "codex", prefixArgs: [] },
          cwd: ".",
          enabled: true
        }]
      }
    });
    expect((await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    })).status).toBe(200);

    expect(() => server.markLaunchReady("https://example.com")).toThrowError(
      expect.objectContaining({ code: "INVALID_ENVELOPE" })
    );
    server.markLaunchFailed();
    expect(await (await fetch(`${origin}/api/setup/launch`)).json()).toEqual({
      status: "failed",
      message: "AIChatLink 启动失败，请查看终端中的诊断信息。"
    });
    await expect(server.launchObserved).resolves.toBeUndefined();
  });

  it("rejects unknown fields and a second save", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aichatlink-setup-http-"));
    directories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "setup.html"), "setup"),
      writeFile(path.join(directory, "setup.js"), "setup"),
      writeFile(path.join(directory, "setup.css"), "setup")
    ]);
    const server = createAIChatLinkSetupHttpServer({ setupApi: setupApi(), staticRoot: directory });
    servers.push(server);
    const origin = (await server.start()).origin;
    const body = {
      config: {
        serverPort: 4_310,
        storagePath: ".aichatlink/aichatlink.db",
        agents: [{
          id: "codex",
          driver: "codex",
          name: "",
          command: { executable: "codex", prefixArgs: [] },
          cwd: ".",
          enabled: true
        }]
      }
    };

    const invalid = await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access: "unrestricted" })
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("access-control-allow-origin")).toBeNull();

    expect((await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })).status).toBe(200);
    expect((await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })).status).toBe(409);
  });

  it("rejects a concurrent second save while the first write is still in flight", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aichatlink-setup-http-"));
    directories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "setup.html"), "setup"),
      writeFile(path.join(directory, "setup.js"), "setup"),
      writeFile(path.join(directory, "setup.css"), "setup")
    ]);
    let releaseSave!: () => void;
    let observeSave!: () => void;
    const saveEntered = new Promise<void>((resolve) => {
      observeSave = resolve;
    });
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const api = setupApi();
    const originalSave = api.save;
    let saveCalls = 0;
    api.save = vi.fn(async (request, signal) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        observeSave();
        await saveReleased;
      }
      return originalSave(request, signal);
    });
    const server = createAIChatLinkSetupHttpServer({ setupApi: api, staticRoot: directory });
    servers.push(server);
    const origin = (await server.start()).origin;
    const body = JSON.stringify({
      config: {
        serverPort: 4_310,
        storagePath: ".aichatlink/aichatlink.db",
        agents: [{
          id: "codex",
          driver: "codex",
          name: "",
          command: { executable: "codex", prefixArgs: [] },
          cwd: ".",
          enabled: true
        }]
      }
    });

    const first = fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    await saveEntered;
    const second = await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });

    releaseSave();
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
    expect(api.save).toHaveBeenCalledTimes(1);
  });
});
