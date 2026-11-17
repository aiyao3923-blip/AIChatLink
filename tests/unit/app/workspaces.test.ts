import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AIChatLinkConfig } from "../../../src/config.js";
import { parseConfigDocument } from "../../../src/config.js";
import { WorkspaceSupervisor, type WorkspaceRuntimeHandle } from "../../../src/app/workspaces/supervisor.js";
import {
  canonicalizeWorkspacePath,
  readWorkspaceRegistry,
  workspaceRegistryPath,
  writeWorkspaceRegistry
} from "../../../src/app/workspaces/registry.js";
import {
  deriveWorkspaceConfig,
  primaryWorkspacePath
} from "../../../src/app/workspaces/derive-config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "aichatlink-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function configFor(primaryWorkspace: string, storagePath: string): AIChatLinkConfig {
  return parseConfigDocument({
    transport: "structured",
    workspace: primaryWorkspace,
    server: { host: "127.0.0.1", port: 4_310 },
    storage: { path: storagePath },
    agents: {
      codex: { driver: "codex", command: "codex", cwd: primaryWorkspace, enabled: true },
      claude: {
        driver: "claude",
        command: "claude",
        cwd: primaryWorkspace,
        enabled: false
      }
    },
    assistant: {
      enabled: false,
      brain: { driver: "claude", command: "claude", cwd: primaryWorkspace }
    }
  });
}

describe("workspace ids and registry", () => {
  it("derives one stable id from the real path and reuses it across casing", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "Repo");
    await mkdir(target);
    const first = await canonicalizeWorkspacePath(target);
    const second = await canonicalizeWorkspacePath(process.platform === "win32" ? target.toLowerCase() : target);
    expect(first.workspaceId).toMatch(/^ws_[a-f0-9]{12}$/u);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.path.endsWith("Repo")).toBe(true);
  });

  it("round-trips an atomic registry document and rejects malformed content", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "workspaces.json");
    await writeWorkspaceRegistry(file, {
      version: 1,
      workspaces: [{ path: root, label: "Root", addedAt: "2026-11-17T00:00:00.000Z" }]
    });
    await expect(readWorkspaceRegistry(file)).resolves.toEqual({
      version: 1,
      workspaces: [{ path: root, label: "Root", addedAt: "2026-11-17T00:00:00.000Z" }]
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });

    await writeFile(file, "{not json", "utf8");
    await expect(readWorkspaceRegistry(file)).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
  });

  it("uses the primary store directory for its registry", () => {
    expect(workspaceRegistryPath(path.join("C:", "repo", ".aichatlink", "aichatlink.db"))).toBe(
      path.join("C:", "repo", ".aichatlink", "workspaces.json")
    );
  });
});

describe("deriveWorkspaceConfig", () => {
  it("re-points followers, keeps explicit overrides, and never mutates the primary", async () => {
    const root = await temporaryDirectory();
    const primaryWorkspace = path.join(root, "primary");
    const target = path.join(root, "target");
    const explicit = path.join(root, "sandbox");
    await Promise.all([mkdir(primaryWorkspace), mkdir(target), mkdir(explicit)]);
    const config = configFor(primaryWorkspace, path.join(root, ".aichatlink", "aichatlink.db"));
    config.agents.claude = { ...config.agents.claude!, cwd: explicit };
    const canonical = await canonicalizeWorkspacePath(target);

    const derived = deriveWorkspaceConfig(config, canonical, path.dirname(config.storage.path));
    expect(primaryWorkspacePath(config)).toBe(primaryWorkspace);
    expect(derived).not.toBe(config);
    expect(derived.workspace).toBe(canonical.path);
    expect(derived.agents.codex?.cwd).toBe(canonical.path);
    expect(derived.agents.claude?.cwd).toBe(explicit);
    expect(derived.assistant?.brain.cwd).toBe(canonical.path);
    expect(derived.storage.path).toBe(
      path.join(path.dirname(config.storage.path), "workspaces", canonical.workspaceId, "aichatlink.db")
    );
    // The primary object is untouched.
    expect(config.agents.codex?.cwd).toBe(primaryWorkspace);
    expect(config.workspace).toBe(primaryWorkspace);
  });
});

describe("WorkspaceSupervisor", () => {
  function fixture(config: AIChatLinkConfig) {
    const started: AIChatLinkConfig[] = [];
    const environments: NodeJS.ProcessEnv[] = [];
    const closed: string[] = [];
    let port = 51_000;
    const createRuntime = async (
      derived: AIChatLinkConfig,
      options: { readonly port: 0; readonly agentEnv: NodeJS.ProcessEnv }
    ): Promise<WorkspaceRuntimeHandle> => {
      started.push(derived);
      environments.push(options.agentEnv);
      const origin = `http://127.0.0.1:${port++}`;
      return {
        address: { origin },
        close: async () => {
          closed.push(derived.storage.path);
        }
      };
    };
    const supervisor = new WorkspaceSupervisor({
      config,
      configPath: path.join(path.dirname(config.storage.path), "aichatlink.json"),
      createRuntime
    });
    return { supervisor, started, environments, closed };
  }

  it("lists the primary, creates a directory, starts it, and exposes a proxy target", async () => {
    const root = await temporaryDirectory();
    const primaryWorkspace = path.join(root, "primary");
    const target = path.join(root, "target");
    await Promise.all([mkdir(primaryWorkspace), mkdir(target)]);
    const config = configFor(primaryWorkspace, path.join(root, ".aichatlink", "aichatlink.db"));
    const { supervisor, started, environments } = fixture(config);
    await supervisor.initialize();
    supervisor.attachPrimary({ address: { origin: "http://127.0.0.1:4310" }, close: async () => undefined });

    const listed = supervisor.list(new AbortController().signal);
    expect(listed.workspaces).toHaveLength(1);
    expect(listed.workspaces[0]).toMatchObject({ kind: "primary", status: "ready" });

    const created = await supervisor.create({ path: target }, new AbortController().signal);
    expect(created.created).toBe(true);
    expect(created.workspace.kind).toBe("added");
    await supervisor.startRegistered();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = supervisor.list(new AbortController().signal);
    const added = after.workspaces.find((workspace) => workspace.workspaceId === created.workspace.workspaceId);
    expect(added?.status).toBe("ready");
    expect(started).toHaveLength(1);
    expect(started[0]?.workspace).toBe(added?.path);
    expect(started[0]?.agents.codex?.cwd).toBe(added?.path);
    expect(environments[0]?.PI_SHIM_ROLES_ROOT).toBe(
      path.join(path.dirname(config.storage.path), "workspaces", created.workspace.workspaceId, "pi-roles")
    );
    expect(supervisor.resolve(created.workspace.workspaceId)).toMatchObject({
      kind: "child",
      origin: expect.stringContaining("127.0.0.1")
    });

    const registry = await readWorkspaceRegistry(path.join(path.dirname(config.storage.path), "workspaces.json"));
    expect(registry.workspaces).toHaveLength(1);

    await supervisor.remove(created.workspace.workspaceId, new AbortController().signal);
    expect(supervisor.list(new AbortController().signal).workspaces).toHaveLength(1);
    await expect(
      readWorkspaceRegistry(path.join(path.dirname(config.storage.path), "workspaces.json"))
    ).resolves.toMatchObject({ workspaces: [] });

    await supervisor.closeAll();
  });

  it("returns the primary instead of creating a duplicate and reports failed starts", async () => {
    const root = await temporaryDirectory();
    const primaryWorkspace = path.join(root, "primary");
    const target = path.join(root, "target");
    await Promise.all([mkdir(primaryWorkspace), mkdir(target)]);
    const config = configFor(primaryWorkspace, path.join(root, ".aichatlink", "aichatlink.db"));
    const { supervisor } = fixture(config);
    await supervisor.initialize();

    const primary = await supervisor.create(
      { path: primaryWorkspace },
      new AbortController().signal
    );
    expect(primary.created).toBe(false);
    expect(primary.workspace.kind).toBe("primary");

    const failing = new WorkspaceSupervisor({
      config,
      configPath: path.join(root, "aichatlink.json"),
      createRuntime: async () => {
        throw new Error("adapter exploded");
      }
    });
    await failing.initialize();
    const created = await failing.create({ path: target }, new AbortController().signal);
    await failing.startRegistered();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const failed = failing
      .list(new AbortController().signal)
      .workspaces.find((workspace) => workspace.workspaceId === created.workspace.workspaceId);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toContain("adapter exploded");
    await failing.closeAll();
  });

  it("ignores a malformed registry instead of blocking the primary room", async () => {
    const root = await temporaryDirectory();
    const primaryWorkspace = path.join(root, "primary");
    await mkdir(primaryWorkspace);
    const config = configFor(primaryWorkspace, path.join(root, ".aichatlink", "aichatlink.db"));
    await mkdir(path.join(root, ".aichatlink"), { recursive: true });
    await writeFile(path.join(root, ".aichatlink", "workspaces.json"), "{broken", "utf8");
    const errors: unknown[] = [];
    const supervisor = new WorkspaceSupervisor({
      config,
      configPath: path.join(root, "aichatlink.json"),
      onError: (error) => errors.push(error)
    });
    await supervisor.initialize();
    expect(supervisor.list(new AbortController().signal).workspaces).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("stops every child on closeAll", async () => {
    const root = await temporaryDirectory();
    const primaryWorkspace = path.join(root, "primary");
    const one = path.join(root, "one");
    const two = path.join(root, "two");
    await Promise.all([mkdir(primaryWorkspace), mkdir(one), mkdir(two)]);
    const config = configFor(primaryWorkspace, path.join(root, ".aichatlink", "aichatlink.db"));
    const { supervisor, closed } = fixture(config);
    await supervisor.initialize();
    await supervisor.create({ path: one }, new AbortController().signal);
    await supervisor.create({ path: two }, new AbortController().signal);
    await supervisor.startRegistered();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await supervisor.closeAll();
    expect(closed).toHaveLength(2);
  });
});
