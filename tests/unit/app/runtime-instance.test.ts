import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeAIChatLinkRuntimeLaunch,
  isAddressInUseError,
  probeAIChatLinkRuntime,
  requestAIChatLinkRuntimeShutdown
} from "../../../src/app/runtime-instance.js";
import { createAIChatLinkRuntimeIdentity } from "../../../src/core/runtime-instance.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configDocument(port: number, identity = "builder") {
  return {
    transport: "structured",
    server: { host: "127.0.0.1", port },
    storage: { path: ".aichatlink/aichatlink.db" },
    agents: {
      codex: { command: "codex", cwd: ".", enabled: true, identity }
    }
  };
}

function writeConfig(port: number): string {
  const directory = mkdtempSync(path.join(tmpdir(), "aichatlink-runtime-instance-"));
  directories.push(directory);
  const configPath = path.join(directory, "aichatlink.json");
  writeFileSync(configPath, JSON.stringify(configDocument(port)), "utf8");
  return configPath;
}

async function listenWithBody(body: () => unknown): Promise<number> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body()));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture port missing");
  return address.port;
}

describe("AIChatLink runtime instance discovery", () => {
  it("builds a stable key from canonical config and changes it for semantic edits", async () => {
    const configPath = writeConfig(4_310);
    const first = await describeAIChatLinkRuntimeLaunch(configPath);
    const second = await describeAIChatLinkRuntimeLaunch(configPath);
    expect(second).toEqual(first);
    expect(first.identity).toMatchObject({
      service: "aichatlink",
      protocol: "aichatlink.runtime/1",
      runtimeKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      runtimeScopeKey: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });

    const reordered = configDocument(4_310);
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: reordered.agents,
        storage: reordered.storage,
        server: reordered.server,
        transport: reordered.transport
      }),
      "utf8"
    );
    expect((await describeAIChatLinkRuntimeLaunch(configPath)).identity.runtimeKey).toBe(
      first.identity.runtimeKey
    );

    writeFileSync(configPath, JSON.stringify(configDocument(4_310, "reviewer")), "utf8");
    const changed = await describeAIChatLinkRuntimeLaunch(configPath);
    expect(changed.identity.runtimeKey).not.toBe(first.identity.runtimeKey);
    expect(changed.identity.runtimeScopeKey).toBe(first.identity.runtimeScopeKey);
    expect(changed.closeTimeoutMs).toBe(5_000);
  });

  it("distinguishes the same runtime, another config, legacy AIChatLink and foreign HTTP", async () => {
    let responseBody: unknown = {};
    const port = await listenWithBody(() => responseBody);
    const descriptor = await describeAIChatLinkRuntimeLaunch(writeConfig(port));

    responseBody = { status: "ok", ...descriptor.identity };
    await expect(probeAIChatLinkRuntime(descriptor)).resolves.toMatchObject({ kind: "same" });

    responseBody = { status: "ok", ...createAIChatLinkRuntimeIdentity({ other: true }) };
    await expect(probeAIChatLinkRuntime(descriptor)).resolves.toMatchObject({
      kind: "different-config"
    });

    responseBody = {
      status: "ok",
      access: "unrestricted",
      transport: "structured",
      store: { available: true },
      agents: []
    };
    await expect(probeAIChatLinkRuntime(descriptor)).resolves.toEqual({ kind: "legacy-aichatlink" });

    responseBody = { status: "ok", application: "some-other-server" };
    await expect(probeAIChatLinkRuntime(descriptor)).resolves.toEqual({ kind: "occupied" });

    responseBody = { service: "aichatlink", protocol: "aichatlink.runtime/0" };
    await expect(probeAIChatLinkRuntime(descriptor)).resolves.toEqual({
      kind: "incompatible-aichatlink"
    });
  });

  it("treats an unavailable listener as unreachable and recognizes nested bind errors", async () => {
    const port = await listenWithBody(() => ({}));
    const descriptor = await describeAIChatLinkRuntimeLaunch(writeConfig(port));
    const server = servers.pop();
    if (server === undefined) throw new Error("fixture server missing");
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(probeAIChatLinkRuntime(descriptor, { timeoutMs: 100 })).resolves.toEqual({
      kind: "unreachable"
    });
    expect(isAddressInUseError({ cause: { code: "EADDRINUSE" } })).toBe(true);
    expect(isAddressInUseError({ code: "ECONNREFUSED" })).toBe(false);
  });

  it("requests shutdown only for the matching config-path scope", async () => {
    const descriptor = await describeAIChatLinkRuntimeLaunch(writeConfig(4_310));
    let requestBody: unknown;
    const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          accepted: true,
          runtimeKey: descriptor.identity.runtimeKey,
          runtimeScopeKey: descriptor.identity.runtimeScopeKey
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      );
    };

    await expect(
      requestAIChatLinkRuntimeShutdown(descriptor, descriptor.identity, { fetch })
    ).resolves.toBeUndefined();
    expect(requestBody).toEqual({ runtimeScopeKey: descriptor.identity.runtimeScopeKey });

    await expect(
      requestAIChatLinkRuntimeShutdown(
        descriptor,
        createAIChatLinkRuntimeIdentity({ other: true }),
        { fetch }
      )
    ).rejects.toThrow("同一配置路径");

    await expect(
      requestAIChatLinkRuntimeShutdown(descriptor, descriptor.identity, {
        fetch: () => Promise.resolve(new Response("not found", { status: 404 }))
      })
    ).rejects.toThrow("请先手动停止一次");
  });
});
