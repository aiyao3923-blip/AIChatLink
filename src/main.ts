import path from "node:path";
import { pathToFileURL } from "node:url";

import { startAIChatLinkRuntime, type AIChatLinkRuntime } from "./app/runtime.js";
import { describeAIChatLinkRuntimeLaunch } from "./app/runtime-instance.js";
import { AIChatLinkConfigSetupService } from "./app/init-config.js";
import { loadConfig, parseConfigPath } from "./config.js";
import { toSafeErrorBody } from "./contracts/index.js";
import { WorkspaceSupervisor } from "./app/workspaces/supervisor.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<AIChatLinkRuntime> {
  const configPath = path.resolve(process.cwd(), parseConfigPath(argv) ?? "aichatlink.json");
  const launch = await describeAIChatLinkRuntimeLaunch(configPath);
  const config = await loadConfig(configPath);
  const workspaces = new WorkspaceSupervisor({
    config,
    configPath,
    onError: (error, context) => {
      process.stderr.write(
        `${JSON.stringify({
          operation: context.operation,
          ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
          ...toSafeErrorBody(error)
        })}\n`
      );
    }
  });
  await workspaces.initialize();
  const runtime = await startAIChatLinkRuntime(config, {
    setupApi: new AIChatLinkConfigSetupService({ configPath, runtimeActive: true }),
    runtimeIdentity: launch.identity,
    workspaceHub: workspaces,
    workspaceRouting: workspaces,
    beforeClose: async () => await workspaces.closeAll()
  });
  workspaces.attachPrimary(runtime);
  void workspaces.startRegistered().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(toSafeErrorBody(error))}\n`);
  });
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.close().catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify(toSafeErrorBody(error))}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.write(
    `AIChatLink listening on ${runtime.address?.origin ?? "unknown"} ` +
      `(transport=${config.transport}, access=unrestricted)\n`
  );
  return runtime;
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isEntryModule()) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(toSafeErrorBody(error))}\n`);
    process.exitCode = 1;
  });
}
