#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runDoctor } from "./app/doctor.js";
import { AIChatLinkConfigSetupService } from "./app/init-config.js";
import type { AIChatLinkRuntime } from "./app/runtime.js";
import {
  describeAIChatLinkRuntimeLaunch,
  isAddressInUseError,
  probeAIChatLinkRuntime,
  requestAIChatLinkRuntimeShutdown,
  type AIChatLinkRuntimeLaunchDescriptor,
  type AIChatLinkRuntimeProbe
} from "./app/runtime-instance.js";
import { runAIChatLinkUpdate } from "./app/update.js";
import { parseConfigPath } from "./config.js";
import type { AIChatLinkRuntimeIdentity } from "./core/runtime-instance.js";
import { openBrowser } from "./utils/open-browser.js";
import { createAIChatLinkSetupHttpServer, createSetupWorkspaceApi } from "./web/setup/index.js";

const HELP = `AIChatLink — 本机多 CLI 群聊

用法:
  aichatlink [start] [--config <path>] [--no-open]   启动 Broker 与 Web UI(默认命令)
  aichatlink stop [--config <path>]                  优雅关闭当前配置对应的 runtime
  aichatlink restart [--config <path>] [--no-open]   关闭现有 runtime 并按最新配置重载
  aichatlink doctor [--config <path>]                检测系统、Node 与 codex/grok/kimi/hermes/claude CLI
  aichatlink init [--config <path>] [--no-open]      配置 Agent，随后启动并进入群聊
  aichatlink update [--check]                       检查并安装 npm latest 版本
  aichatlink --version                               打印版本
  aichatlink --help                                  打印帮助
`;

function stdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export interface StartConfiguredRuntimeDependencies {
  describeLaunch(configPath: string): Promise<AIChatLinkRuntimeLaunchDescriptor>;
  probe(descriptor: AIChatLinkRuntimeLaunchDescriptor): Promise<AIChatLinkRuntimeProbe>;
  startRuntime(configPath: string): Promise<AIChatLinkRuntime>;
  open(url: string): Promise<boolean>;
  writeLine(line: string): void;
  delay(milliseconds: number): Promise<void>;
}

export interface StopConfiguredRuntimeDependencies {
  describeLaunch(configPath: string): Promise<AIChatLinkRuntimeLaunchDescriptor>;
  probe(descriptor: AIChatLinkRuntimeLaunchDescriptor): Promise<AIChatLinkRuntimeProbe>;
  writeLine(line: string): void;
  delay(milliseconds: number): Promise<void>;
  requestShutdown(
    descriptor: AIChatLinkRuntimeLaunchDescriptor,
    runningIdentity: AIChatLinkRuntimeIdentity
  ): Promise<void>;
}

export type RestartConfiguredRuntimeDependencies =
  StartConfiguredRuntimeDependencies & StopConfiguredRuntimeDependencies;

export type StartConfiguredRuntimeResult =
  | { readonly kind: "started"; readonly origin: string; readonly runtime: AIChatLinkRuntime }
  | { readonly kind: "reused"; readonly origin: string };

const startDependencies: StartConfiguredRuntimeDependencies = {
  describeLaunch: describeAIChatLinkRuntimeLaunch,
  probe: probeAIChatLinkRuntime,
  startRuntime: async (configPath) => {
    const { main } = await import("./main.js");
    return await main(["--config", configPath]);
  },
  open: openBrowser,
  writeLine: stdout,
  delay: async (milliseconds) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
};

const restartDependencies: RestartConfiguredRuntimeDependencies = {
  ...startDependencies,
  requestShutdown: requestAIChatLinkRuntimeShutdown
};

function portConflictError(
  descriptor: AIChatLinkRuntimeLaunchDescriptor,
  probe: Exclude<AIChatLinkRuntimeProbe, { kind: "same" } | { kind: "unreachable" }>,
  action: "启动" | "停止" | "重启" = "启动"
): Error {
  if (probe.kind === "different-config") {
    return new Error(
      `无法${action} AIChatLink：${descriptor.origin} 上已有使用其他配置的 AIChatLink。` +
        "请停止原实例，或修改当前配置的 server.port。"
    );
  }
  if (probe.kind === "legacy-aichatlink") {
    return new Error(
      `无法${action} AIChatLink：${descriptor.origin} 上已有旧版 AIChatLink，无法确认配置一致。` +
        "请先停止原实例再重试。"
    );
  }
  if (probe.kind === "incompatible-aichatlink") {
    return new Error(
      `无法${action} AIChatLink：${descriptor.origin} 上已有不兼容的 AIChatLink runtime。` +
        "请先停止原实例再重试。"
    );
  }
  return new Error(
    `无法${action} AIChatLink：端口 ${descriptor.port} 已被其他程序占用。` +
      "请停止占用程序，或修改当前配置的 server.port。"
  );
}

async function reuseRunningRuntime(
  descriptor: AIChatLinkRuntimeLaunchDescriptor,
  noOpen: boolean,
  dependencies: StartConfiguredRuntimeDependencies
): Promise<StartConfiguredRuntimeResult> {
  dependencies.writeLine(`AIChatLink 已在运行: ${descriptor.origin}/`);
  if (!noOpen) {
    dependencies.writeLine(
      (await dependencies.open(`${descriptor.origin}/`))
        ? "已复用现有 AIChatLink 实例并打开页面"
        : `请手动打开 ${descriptor.origin}/`
    );
  }
  return { kind: "reused", origin: descriptor.origin };
}

async function probeAfterAddressInUse(
  descriptor: AIChatLinkRuntimeLaunchDescriptor,
  dependencies: StartConfiguredRuntimeDependencies
): Promise<AIChatLinkRuntimeProbe> {
  let latest: AIChatLinkRuntimeProbe = { kind: "unreachable" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    latest = await dependencies.probe(descriptor);
    if (latest.kind !== "unreachable") return latest;
    if (attempt < 2) await dependencies.delay(100);
  }
  return latest;
}

/** Idempotent product start: reuse the same runtime, but never kill or replace another listener. */
export async function startConfiguredRuntime(
  configPath: string,
  noOpen: boolean,
  dependencies: StartConfiguredRuntimeDependencies = startDependencies
): Promise<StartConfiguredRuntimeResult> {
  const descriptor = await dependencies.describeLaunch(configPath);
  const existing = await dependencies.probe(descriptor);
  if (existing.kind === "same") {
    return await reuseRunningRuntime(descriptor, noOpen, dependencies);
  }
  if (existing.kind !== "unreachable") {
    throw portConflictError(descriptor, existing);
  }

  let runtime: AIChatLinkRuntime;
  try {
    runtime = await dependencies.startRuntime(configPath);
  } catch (error) {
    if (!isAddressInUseError(error)) throw error;
    const raced = await probeAfterAddressInUse(descriptor, dependencies);
    if (raced.kind === "same") {
      return await reuseRunningRuntime(descriptor, noOpen, dependencies);
    }
    if (raced.kind === "unreachable") {
      throw portConflictError(descriptor, { kind: "occupied" });
    }
    throw portConflictError(descriptor, raced);
  }

  const origin = runtime.address?.origin;
  if (origin === undefined) throw new Error("AIChatLink runtime did not expose a loopback address");
  if (!noOpen) {
    const url = `${origin}/`;
    dependencies.writeLine(
      (await dependencies.open(url)) ? `已在浏览器打开 ${url}` : `请手动打开 ${url}`
    );
  }
  return { kind: "started", origin, runtime };
}

function controllableIdentity(
  descriptor: AIChatLinkRuntimeLaunchDescriptor,
  probe: AIChatLinkRuntimeProbe
): AIChatLinkRuntimeIdentity | undefined {
  if (probe.kind === "same") return probe.identity;
  if (
    probe.kind === "different-config" &&
    probe.identity.runtimeScopeKey !== undefined &&
    probe.identity.runtimeScopeKey === descriptor.identity.runtimeScopeKey
  ) {
    return probe.identity;
  }
  return undefined;
}

async function waitForRuntimeStop(
  descriptor: AIChatLinkRuntimeLaunchDescriptor,
  operation: "stop" | "restart",
  dependencies: StopConfiguredRuntimeDependencies
): Promise<void> {
  const pollMilliseconds = 100;
  const waitMilliseconds = Math.max(
    15_000,
    Math.min(300_000, descriptor.closeTimeoutMs * 3 + 1_000)
  );
  const attempts = Math.ceil(waitMilliseconds / pollMilliseconds) + 1;
  let consecutiveUnreachable = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const observed = await dependencies.probe(descriptor);
    if (observed.kind === "unreachable") {
      consecutiveUnreachable += 1;
      if (consecutiveUnreachable >= 3) return;
      if (attempt + 1 < attempts) await dependencies.delay(pollMilliseconds);
      continue;
    }
    consecutiveUnreachable = 0;
    if (controllableIdentity(descriptor, observed) === undefined) {
      if (observed.kind === "same") {
        throw new Error("AIChatLink runtime identity could not be correlated for lifecycle control");
      }
      throw portConflictError(descriptor, observed, operation === "stop" ? "停止" : "重启");
    }
    if (attempt + 1 < attempts) await dependencies.delay(pollMilliseconds);
  }
  throw new Error(
    operation === "restart"
      ? `AIChatLink 未能在 ${waitMilliseconds} ms 内完成关闭；为避免新旧 runtime 重叠，未启动替代实例。`
      : `AIChatLink 未能在 ${waitMilliseconds} ms 内完成关闭；未将 runtime 报告为已停止。`
  );
}

async function shutdownConfiguredRuntime(
  configPath: string,
  operation: "stop" | "restart",
  dependencies: StopConfiguredRuntimeDependencies
): Promise<AIChatLinkRuntimeLaunchDescriptor> {
  const descriptor = await dependencies.describeLaunch(configPath);
  const existing = await dependencies.probe(descriptor);
  if (existing.kind === "unreachable") {
    throw new Error(
      `未在 ${descriptor.origin} 检测到可${operation === "stop" ? "停止" : "重启"}的 AIChatLink。` +
        (operation === "restart" ? "若实例本来未运行，请使用 aichatlink start；" : "") +
        "若刚修改了 server.port，请先停止旧端口上的实例。"
    );
  }

  const runningIdentity = controllableIdentity(descriptor, existing);
  if (runningIdentity === undefined) {
    if (existing.kind === "same") {
      throw new Error("AIChatLink runtime identity could not be correlated for lifecycle control");
    }
    throw portConflictError(descriptor, existing, operation === "stop" ? "停止" : "重启");
  }

  dependencies.writeLine(`正在优雅关闭 ${descriptor.origin}/ ...`);
  await dependencies.requestShutdown(descriptor, runningIdentity);
  await waitForRuntimeStop(descriptor, operation, dependencies);
  return descriptor;
}

export type StopConfiguredRuntimeResult = {
  readonly kind: "stopped";
  readonly origin: string;
};

/** Gracefully stop the runtime bound to this canonical config path. */
export async function stopConfiguredRuntime(
  configPath: string,
  dependencies: StopConfiguredRuntimeDependencies = restartDependencies
): Promise<StopConfiguredRuntimeResult> {
  const descriptor = await shutdownConfiguredRuntime(configPath, "stop", dependencies);
  dependencies.writeLine(`AIChatLink 已完整停止: ${descriptor.origin}/`);
  return { kind: "stopped", origin: descriptor.origin };
}

/** Gracefully stop the runtime for this config path, then start with the latest file contents. */
export async function restartConfiguredRuntime(
  configPath: string,
  noOpen: boolean,
  dependencies: RestartConfiguredRuntimeDependencies = restartDependencies
): Promise<StartConfiguredRuntimeResult> {
  await shutdownConfiguredRuntime(configPath, "restart", dependencies);
  dependencies.writeLine("原 AIChatLink 已完整关闭，正在按最新配置重载。");
  return await startConfiguredRuntime(configPath, noOpen, dependencies);
}

async function runSetupWizard(
  configPath: string,
  noOpen: boolean
): Promise<AIChatLinkRuntime | undefined> {
  const service = new AIChatLinkConfigSetupService({ configPath, runtimeActive: false });
  const server = createAIChatLinkSetupHttpServer({
    setupApi: service,
    workspaceApi: createSetupWorkspaceApi()
  });
  const address = await server.start();
  try {
    const url = `${address.origin}/`;
    stdout(`AIChatLink Agent 配置引导页: ${url}`);
    if (!noOpen) {
      stdout((await openBrowser(url)) ? "已在浏览器打开配置引导页" : `请手动打开 ${url}`);
    }
    const result = await server.completed;
    stdout(`已保存 ${result.agentCount} 个 Agent: ${result.configPath}`);
    try {
      const started = await startConfiguredRuntime(configPath, true);
      const origin = started.origin;
      server.markLaunchReady(origin);
      stdout(`AIChatLink 已就绪，引导页将自动进入 ${origin}/`);
      if (noOpen) stdout(`请手动打开 ${origin}/`);
      await Promise.race([
        server.launchObserved,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000))
      ]);
      return started.kind === "started" ? started.runtime : undefined;
    } catch (error) {
      server.markLaunchFailed();
      await Promise.race([
        server.launchObserved,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ]);
      throw error;
    }
  } finally {
    await server.close();
  }
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "version" in parsed
      ? String(parsed.version)
      : "unknown";
  } catch {
    return "unknown";
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "start": {
      const noOpen = rest.includes("--no-open");
      const forwarded = rest.filter((value) => value !== "--no-open");
      const configPath = path.resolve(process.cwd(), parseConfigPath(forwarded) ?? "aichatlink.json");
      if (!fileExists(configPath)) {
        stdout(`未找到配置 ${configPath}，先打开 Agent 引导页。`);
        await runSetupWizard(configPath, noOpen);
      } else {
        await startConfiguredRuntime(configPath, noOpen);
      }
      return 0;
    }
    case "restart": {
      const noOpen = rest.includes("--no-open");
      const forwarded = rest.filter((value) => value !== "--no-open");
      const configPath = path.resolve(process.cwd(), parseConfigPath(forwarded) ?? "aichatlink.json");
      if (!fileExists(configPath)) {
        throw new Error(`无法重启 AIChatLink：未找到配置 ${configPath}`);
      }
      await restartConfiguredRuntime(configPath, noOpen);
      return 0;
    }
    case "stop": {
      const configPath = path.resolve(process.cwd(), parseConfigPath(rest) ?? "aichatlink.json");
      if (!fileExists(configPath)) {
        throw new Error(`无法停止 AIChatLink：未找到配置 ${configPath}`);
      }
      await stopConfiguredRuntime(configPath);
      return 0;
    }
    case "doctor": {
      const configPath = parseConfigPath(rest);
      return runDoctor({ cwd: process.cwd(), ...(configPath === undefined ? {} : { configPath }) });
    }
    case "init": {
      const configPath = parseConfigPath(rest);
      await runSetupWizard(
        path.resolve(process.cwd(), configPath ?? "aichatlink.json"),
        rest.includes("--no-open")
      );
      return 0;
    }
    case "update": {
      const unknown = rest.filter((value) => value !== "--check");
      if (unknown.length > 0) {
        throw new Error(`aichatlink update 不支持参数: ${unknown.join(" ")}`);
      }
      await runAIChatLinkUpdate({
        currentVersion: await packageVersion(),
        checkOnly: rest.includes("--check")
      });
      return 0;
    }
    case "--version":
    case "-v":
    case "version":
      stdout(await packageVersion());
      return 0;
    case "--help":
    case "-h":
    case "help":
      stdout(HELP);
      return 0;
    default:
      process.stderr.write(`未知命令: ${command}\n\n${HELP}`);
      return 1;
  }
}

export function isEntryModule(
  entry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url
): boolean {
  if (entry === undefined) return false;

  try {
    const entryUrl = pathToFileURL(realpathSync(path.resolve(entry))).href;
    const modulePath = realpathSync(new URL(moduleUrl));
    return entryUrl === pathToFileURL(modulePath).href;
  } catch {
    return moduleUrl === pathToFileURL(path.resolve(entry)).href;
  }
}

if (isEntryModule()) {
  void run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
