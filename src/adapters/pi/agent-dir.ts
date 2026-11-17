import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AIChatLinkError } from "../../core/errors.js";
import type { McpBindingLaunchSpec } from "../types.js";
import { buildPiMcpConfig, splitPiModel } from "./protocol.js";

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * Env switch for how much of the user's pi capability surface a room Agent gets.
 *
 * - `isolated` (default): credentials and settings are copied in a bounded form,
 *   user extensions/packages never load.
 * - `shared`: the role directory still owns `mcp.json` and `sessions/` (the MCP
 *   binding is per Agent and cannot be shared), but `settings.json`, the model
 *   catalog, extensions, Agents, skills, prompts and themes come from the user's
 *   own `~/.pi/agent`, so a room Agent behaves like the local pi install.
 */
export const PI_CONFIG_MODE_ENV = "AICHATLINK_PI_CONFIG";

export type PiConfigMode = "isolated" | "shared";

export function piConfigMode(env: NodeJS.ProcessEnv = process.env): PiConfigMode {
  return env[PI_CONFIG_MODE_ENV] === "shared" ? "shared" : "isolated";
}

/** Directories linked (Windows junction / POSIX symlink) from the user's agent dir. */
const SHARED_RESOURCE_DIRECTORIES = ["extensions", "skills", "prompts", "themes", "agents", "npm"] as const;
/** State files copied verbatim so OAuth providers and the model cache keep working. */
const SHARED_STATE_FILES = ["auth.json", "mcp-auth.json", "models-store.json"] as const;

/**
 * Packages that cannot load in `--mode rpc` and would abort the process.
 * `pi-open-tui` calls `pi.registerToolRenderer`, which only exists in the TUI
 * runtime; keeping it makes every room turn die at handshake.
 * Extra names can be appended with `AICHATLINK_PI_DROP_PACKAGES=a,b`.
 */
const RPC_INCOMPATIBLE_PACKAGES: ReadonlySet<string> = new Set(["pi-open-tui"]);

export const PI_DROP_PACKAGES_ENV = "AICHATLINK_PI_DROP_PACKAGES";

function droppedPackageNames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env[PI_DROP_PACKAGES_ENV] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return new Set([...RPC_INCOMPATIBLE_PACKAGES, ...extra]);
}

export interface PiAgentDirectoryOptions {
  /** Room workspace; the native process cwd and the local state root. */
  workDirectory: string;
  agentId: string;
  mcp?: McpBindingLaunchSpec | undefined;
  bindingId?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  /** Overrides the user's pi agent directory (tests and `PI_AGENT_MODELS`). */
  userAgentDirectory?: string | undefined;
  /** Defaults to `AICHATLINK_PI_CONFIG`; `shared` keeps the user's pi capability surface. */
  configMode?: PiConfigMode | undefined;
}

export interface PiAgentDirectory {
  directory: string;
  environment: NodeJS.ProcessEnv;
  providers: ReadonlySet<string>;
  selection: { provider: string | undefined; model: string | undefined };
  thinking: string | undefined;
  mcpConfigured: boolean;
}

/** Per-agent state lives beside the room's `.aichatlink/` database. */
export function piAgentDirectoryPath(workDirectory: string, agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/gu, "_");
  return path.join(workDirectory, ".aichatlink", "pi-agents", safe);
}

/**
 * Prepare the isolated pi agent directory:
 *
 * - copy the user's `models.json` (API keys) trimmed to the selected provider,
 *   so a room process never reads or writes `~/.pi/agent`;
 * - generate a minimal `settings.json` (no user extensions/packages);
 * - write the AIChatLink MCP entry with `direct` exposure.
 *
 * File contents are never logged, echoed, or persisted into AIChatLink records.
 */
export async function preparePiAgentDirectory(
  options: PiAgentDirectoryOptions
): Promise<PiAgentDirectory> {
  const userAgentDirectory =
    options.userAgentDirectory ?? path.join(os.homedir(), ".pi", "agent");
  const mode = options.configMode ?? piConfigMode();
  const directory = piAgentDirectoryPath(options.workDirectory, options.agentId);
  await mkdir(directory, { recursive: true });
  // The directory holds a credential copy. Keep `git add -A` in the user's
  // workspace from committing it even when the repository has no ignore rule.
  await mkdir(path.join(options.workDirectory, ".aichatlink", "pi-agents"), { recursive: true });
  await writePrivateText(
    path.join(options.workDirectory, ".aichatlink", "pi-agents", ".gitignore"),
    "*\n!.gitignore\n"
  );

  const models = await readUserModels(userAgentDirectory);
  const providers = new Set(
    models === undefined ? [] : Object.keys(isRecord(models.providers) ? models.providers : {})
  );
  const requested = splitPiModel(options.model, providers);
  // Shared mode keeps the whole catalog: the Agent is supposed to behave like
  // the local install, so a provider switch inside the room must not fail on a
  // trimmed file. Isolated mode never copies every provider when no model was
  // selected; it picks one provider and its first model instead.
  const selection =
    mode === "shared"
      ? requested
      : requested.provider === undefined && requested.model === undefined
        ? firstProviderSelection(models, providers)
        : requested;

  if (models !== undefined && (mode === "shared" || selection.provider !== undefined)) {
    const written = mode === "shared" ? models : trimModels(models, selection.provider as string);
    await writePrivateJson(path.join(directory, "models.json"), written);
  } else {
    // Built-in providers may still resolve from environment variables.
    await rm(path.join(directory, "models.json"), { force: true });
  }

  if (mode === "shared") {
    await copySharedUserState(userAgentDirectory, directory);
  } else {
    const settings: Record<string, unknown> = {
      compaction: { enabled: true }
    };
    if (selection.provider !== undefined) settings.defaultProvider = selection.provider;
    if (selection.model !== undefined) settings.defaultModel = selection.model;
    if (options.thinking !== undefined) settings.defaultThinkingLevel = options.thinking;
    await writePrivateJson(path.join(directory, "settings.json"), settings);
  }

  const mcp = buildPiMcpConfig(options.mcp, options.bindingId);
  if (mcp === undefined) {
    await rm(path.join(directory, "mcp.json"), { force: true });
  } else {
    await writePrivateJson(path.join(directory, "mcp.json"), mcp);
  }

  return {
    directory,
    environment: { [PI_AGENT_DIR_ENV]: directory },
    providers,
    selection,
    thinking: options.thinking,
    mcpConfigured: mcp !== undefined
  };
}

/**
 * Mirror the user's pi capability surface into the role directory without
 * touching `~/.pi/agent`: settings and state files are copied (the role may
 * rewrite them), extension/skill/prompt/theme/Agent directories are linked so
 * there is a single source of truth. `mcp.json` is deliberately not linked: it
 * carries the per-Agent AIChatLink binding.
 */
async function copySharedUserState(
  userAgentDirectory: string,
  directory: string
): Promise<void> {
  const settingsCopied = await copyFileIfPresent(
    path.join(userAgentDirectory, "settings.json"),
    path.join(directory, "settings.json"),
    false
  );
  if (!settingsCopied) {
    // A machine without a user settings file still needs a valid one.
    await writePrivateJson(path.join(directory, "settings.json"), { compaction: { enabled: true } });
  } else {
    await dropRpcIncompatiblePackages(path.join(directory, "settings.json"));
  }
  for (const name of SHARED_STATE_FILES) {
    await copyFileIfPresent(
      path.join(userAgentDirectory, name),
      path.join(directory, name),
      true
    );
  }
  for (const name of SHARED_RESOURCE_DIRECTORIES) {
    await linkUserResource(path.join(userAgentDirectory, name), path.join(directory, name));
  }
}

async function copyFileIfPresent(source: string, target: string, privateMode: boolean): Promise<boolean> {
  try {
    const info = await lstat(source);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  await copyFile(source, target);
  if (privateMode) await chmod(target, 0o600);
  return true;
}

/** Remove packages that abort `pi --mode rpc`; everything else stays untouched. */
async function dropRpcIncompatiblePackages(settingsPath: string): Promise<void> {
  const drop = droppedPackageNames();
  if (drop.size === 0) return;
  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    return;
  }
  if (!isRecord(settings) || !Array.isArray(settings.packages)) return;
  const kept = settings.packages.filter((entry) => {
    if (typeof entry !== "string") return true;
    const name = entry.startsWith("npm:") ? entry.slice(4) : entry;
    return !drop.has(name) && !drop.has(name.split("/").pop() ?? name);
  });
  if (kept.length === settings.packages.length) return;
  await writePrivateJson(settingsPath, { ...settings, packages: kept });
}

/** Idempotent directory link; falls back to a copy when linking is not permitted. */
async function linkUserResource(source: string, target: string): Promise<void> {
  try {
    if (!(await lstat(source)).isDirectory()) return;
  } catch {
    return;
  }
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      await rm(target, { force: true });
    } else {
      // A real directory already exists (an older isolated run or a manual
      // setup); leave it alone rather than deleting room state.
      return;
    }
  } catch {
    // missing target is the normal path
  }
  try {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch {
    await cp(source, target, { recursive: true, force: true, dereference: true });
  }
}

export async function piSessionFileExists(
  agentDirectory: string,
  sessionId: string
): Promise<boolean> {
  if (sessionId.length === 0) return false;
  const suffix = `_${sessionId}.jsonl`;
  const root = path.join(agentDirectory, "sessions");
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return true;
      }
    }
  }
  return false;
}

async function readUserModels(
  userAgentDirectory: string
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(userAgentDirectory, "models.json"), "utf8");
  } catch (error) {
    // A missing catalog is legitimate: built-in providers can resolve from
    // environment variables. An unreadable/invalid catalog is not, because the
    // room would silently fall back to a different provider set.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AIChatLinkError(
      "ADAPTER_START_FAILED",
      "Unable to read the pi provider catalog"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AIChatLinkError("ADAPTER_START_FAILED", "The pi provider catalog is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new AIChatLinkError("ADAPTER_START_FAILED", "The pi provider catalog is not an object");
  }
  return parsed;
}

function firstProviderSelection(
  models: Record<string, unknown> | undefined,
  providers: ReadonlySet<string>
): { provider: string | undefined; model: string | undefined } {
  const provider = [...providers][0];
  if (models === undefined || provider === undefined || !isRecord(models.providers)) {
    return { provider: undefined, model: undefined };
  }
  const entry = models.providers[provider];
  const firstModel =
    isRecord(entry) && Array.isArray(entry.models) && isRecord(entry.models[0])
      ? optionalId(entry.models[0].id)
      : undefined;
  return { provider, model: firstModel };
}

function trimModels(
  models: Record<string, unknown>,
  provider: string
): Record<string, unknown> {
  if (!isRecord(models.providers) || !Object.hasOwn(models.providers, provider)) {
    // The requested provider is absent; do not fall back to copying everything.
    return { providers: {} };
  }
  return { ...models, providers: { [provider]: models.providers[provider] } };
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writePrivateText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateText(file: string, content: string): Promise<void> {
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
}

/**
 * Remove the generated provider/settings/MCP files when the native session
 * ends. Session files stay for `--session-id` resume; the credential copy is
 * regenerated before the next launch.
 */
export async function clearPiAgentSecrets(agentDirectory: string): Promise<void> {
  await Promise.all(
    ["models.json", "settings.json", "mcp.json", "auth.json", "mcp-auth.json", "models-store.json"].map((name) =>
      rm(path.join(agentDirectory, name), { force: true })
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
