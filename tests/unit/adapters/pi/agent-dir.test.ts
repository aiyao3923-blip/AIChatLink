import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearPiAgentSecrets,
  piAgentDirectoryPath,
  preparePiAgentDirectory
} from "../../../../src/adapters/pi/agent-dir.js";

const workspaces: string[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ workspace: string; userAgentDirectory: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "aichatlink-pi-dir-"));
  workspaces.push(workspace);
  const userAgentDirectory = join(workspace, "user-pi");
  await mkdir(userAgentDirectory, { recursive: true });
  await writeFile(
    join(userAgentDirectory, "models.json"),
    JSON.stringify({
      providers: {
        alpha: {
          name: "alpha",
          baseUrl: "https://alpha.invalid/v1",
          api: "openai-completions",
          apiKey: "alpha-secret",
          models: [{ id: "alpha-model", name: "alpha-model" }]
        },
        beta: {
          name: "beta",
          baseUrl: "https://beta.invalid/v1",
          api: "openai-completions",
          apiKey: "beta-secret",
          models: [{ id: "beta-model", name: "beta-model" }]
        }
      }
    }),
    "utf8"
  );
  return { workspace, userAgentDirectory };
}

describe("pi agent directory", () => {
  it("copies only the selected provider", async () => {
    const { workspace, userAgentDirectory } = await fixture();
    await preparePiAgentDirectory({
      workDirectory: workspace,
      agentId: "pi",
      model: "beta/beta-model",
      userAgentDirectory
    });

    const directory = piAgentDirectoryPath(workspace, "pi");
    const models = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
    expect(Object.keys(models.providers)).toEqual(["beta"]);
    const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
    expect(settings).toMatchObject({ defaultProvider: "beta", defaultModel: "beta-model" });
  });

  it("never copies every provider when no model was selected", async () => {
    const { workspace, userAgentDirectory } = await fixture();
    const prepared = await preparePiAgentDirectory({
      workDirectory: workspace,
      agentId: "pi",
      userAgentDirectory
    });

    const models = JSON.parse(await readFile(join(prepared.directory, "models.json"), "utf8"));
    expect(Object.keys(models.providers)).toEqual(["alpha"]);
    expect(JSON.stringify(models)).not.toContain("beta-secret");
    expect(prepared.selection).toEqual({ provider: "alpha", model: "alpha-model" });
  });

  it("adds a workspace-local ignore rule and removes the credential copy on close", async () => {
    const { workspace, userAgentDirectory } = await fixture();
    const prepared = await preparePiAgentDirectory({
      workDirectory: workspace,
      agentId: "pi",
      model: "alpha/alpha-model",
      userAgentDirectory
    });

    expect(
      await readFile(join(workspace, ".aichatlink", "pi-agents", ".gitignore"), "utf8")
    ).toBe("*\n!.gitignore\n");

    await clearPiAgentSecrets(prepared.directory);
    await expect(readFile(join(prepared.directory, "models.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(prepared.directory, "settings.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("does not copy any provider when the selected prefix is an unknown model id", async () => {
    const { workspace, userAgentDirectory } = await fixture();
    const prepared = await preparePiAgentDirectory({
      workDirectory: workspace,
      agentId: "pi",
      model: "anthropic/claude-sonnet-4",
      userAgentDirectory
    });

    // An unknown prefix is treated as a full model id (OpenRouter style), not
    // as a provider; no credential copy happens.
    expect(prepared.selection).toEqual({ provider: undefined, model: "anthropic/claude-sonnet-4" });
    await expect(readFile(join(prepared.directory, "models.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
  describe("shared config mode", () => {
    async function sharedFixture(): Promise<{ workspace: string; userAgentDirectory: string }> {
      const base = await fixture();
      await writeFile(
        join(base.userAgentDirectory, "settings.json"),
        JSON.stringify({ packages: ["npm:pi-plan-mode"], defaultModel: "alpha-model" }),
        "utf8"
      );
      await mkdir(join(base.userAgentDirectory, "extensions", "subagent"), { recursive: true });
      await writeFile(
        join(base.userAgentDirectory, "extensions", "subagent", "index.ts"),
        "export default function () {}\n",
        "utf8"
      );
      await mkdir(join(base.userAgentDirectory, "agents"), { recursive: true });
      await writeFile(join(base.userAgentDirectory, "agents", "scout.md"), "---\nname: scout\n---\n", "utf8");
      return base;
    }

    it("keeps the user's settings, catalog and extensions while binding MCP per Agent", async () => {
      const { workspace, userAgentDirectory } = await sharedFixture();
      const prepared = await preparePiAgentDirectory({
        workDirectory: workspace,
        agentId: "pi-lead",
        model: "beta/beta-model",
        configMode: "shared",
        userAgentDirectory,
        mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" },
        bindingId: "binding_pi-lead_test"
      });

      // The full catalog survives: a shared Agent must be able to switch provider.
      const models = JSON.parse(await readFile(join(prepared.directory, "models.json"), "utf8"));
      expect(Object.keys(models.providers).sort()).toEqual(["alpha", "beta"]);
      expect(prepared.providers.has("beta")).toBe(true);

      // The user's settings are copied verbatim, not replaced by a minimal one.
      const settings = JSON.parse(await readFile(join(prepared.directory, "settings.json"), "utf8"));
      expect(settings).toEqual({ packages: ["npm:pi-plan-mode"], defaultModel: "alpha-model" });

      // Capability directories are linked, so the room sees the same tools/Agents.
      const extension = await readFile(
        join(prepared.directory, "extensions", "subagent", "index.ts"),
        "utf8"
      );
      expect(extension).toContain("export default");
      expect(await readFile(join(prepared.directory, "agents", "scout.md"), "utf8")).toContain(
        "name: scout"
      );

      // The per-Agent MCP binding is still written locally and never linked.
      const mcp = JSON.parse(await readFile(join(prepared.directory, "mcp.json"), "utf8"));
      expect(mcp.mcpServers.aichatlink.headers["X-AIChatLink-Binding"]).toBe(
        "binding_pi-lead_test"
      );

      // The user's own directory is never written.
      const userSettings = JSON.parse(
        await readFile(join(userAgentDirectory, "settings.json"), "utf8")
      );
      expect(userSettings).toEqual({ packages: ["npm:pi-plan-mode"], defaultModel: "alpha-model" });
    });

    it("does not invent a default model when the Agent pins none", async () => {
      const { workspace, userAgentDirectory } = await sharedFixture();
      const prepared = await preparePiAgentDirectory({
        workDirectory: workspace,
        agentId: "pi-architect",
        configMode: "shared",
        userAgentDirectory
      });

      // pi's own settings default must win; argv carries no provider/model.
      expect(prepared.selection).toEqual({ provider: undefined, model: undefined });
      const settings = JSON.parse(await readFile(join(prepared.directory, "settings.json"), "utf8"));
      expect(settings.defaultModel).toBe("alpha-model");
    });
  });
});
