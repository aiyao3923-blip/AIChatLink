// Per-role agent directory.
//
// AIChatLink spawns one pi process per role. Each process gets its own
// PI_CODING_AGENT_DIR so that sessions, MCP servers and settings never leak
// between roles or back into the user's own ~/.pi/agent.
//
// SECURITY CONTRACT
//   * models.json holds provider API keys. It is copied (never shared by hard
//     link) so a write inside a role can never mutate the user's file, it is
//     trimmed to the providers that role needs, and its CONTENT IS NEVER LOGGED.
//   * settings.json is generated from scratch. The user's settings.json carries
//     package extensions (plan-mode, goal, hindsight, playwright, ...) that must
//     not run inside a room worker.
//   * Nothing is written to the user's agent dir.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const ROLE_SETTINGS_KEYS = Object.freeze(["defaultProvider", "defaultModel", "defaultThinkingLevel", "compaction"]);
const MCP_SERVER_KEYS = new Set(["type", "command", "args", "env", "url", "headers"]);

export class RoleDirError extends Error {
  constructor(message, code = "role_dir_invalid") {
    super(message);
    this.name = "RoleDirError";
    this.code = code;
  }
}

/**
 * @param {{
 *   roleId: string, role: import("./roles.mjs").NormalizedRole | object,
 *   rolesRoot: string, userAgentDir: string,
 *   mcpConfig?: unknown, log?: (event: string, detail?: object) => void
 * }} options
 */
export async function prepareRoleDir(options) {
  const { roleId, role, rolesRoot, userAgentDir } = options;
  const log = options.log ?? (() => {});
  const roleDir = path.join(rolesRoot, roleId);
  // The room workspace must win: AIChatLink spawns this shim with the Agent `cwd`,
  // so an unset `workdir` follows that directory instead of a private scratch
  // dir. `workdir` in ROLES.json stays the explicit per-role override and is
  // resolved against the role directory.
  const workDir =
    options.workDir ?? (role.workdir ? path.resolve(roleDir, role.workdir) : path.join(roleDir, "work"));

  await mkdir(roleDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(path.join(roleDir, "sessions"), { recursive: true });

  const snapshot = await readSnapshot(rolesRoot, roleId);
  const model = snapshot?.model ?? role.model;
  const provider = snapshot?.provider ?? role.provider;
  const thinking = snapshot?.thinking ?? role.thinking;

  const providers = await writeModels(roleDir, userAgentDir, role.providers, log);
  await writeSettings(roleDir, { provider, model, thinking }, userAgentDir);
  const mcp = await writeMcp(roleDir, options.mcpConfig);

  return {
    roleDir,
    workDir,
    model,
    provider,
    thinking,
    providers,
    mcp,
    env: {
      PI_CODING_AGENT_DIR: roleDir,
      PI_SHIM_ROLE_DIR: roleDir,
      PI_SHIM_ROLE_ID: roleId,
    },
  };
}

export async function readSnapshot(rolesRoot, roleId) {
  const file = path.join(rolesRoot, `${roleId}.role.json`);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.model !== "string" || typeof parsed.provider !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSnapshot(rolesRoot, roleId, value) {
  const file = path.join(rolesRoot, `${roleId}.role.json`);
  const payload = {
    model: value.model,
    provider: value.provider,
    thinking: value.thinking,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

/**
 * Copy models.json with an optional provider allowlist.
 * Returns provider names only - never key material, never the file body.
 */
async function writeModels(roleDir, userAgentDir, allowedProviders, log) {
  const source = path.join(userAgentDir, "models.json");
  const target = path.join(roleDir, "models.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new RoleDirError(`cannot read provider catalog: ${error.code ?? error.message}`, "models_unreadable");
  }
  const providers = parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object"
    ? parsed.providers
    : {};
  const names = Object.keys(providers);
  if (names.length === 0) throw new RoleDirError("provider catalog has no providers", "models_empty");

  let selected = names;
  if (Array.isArray(allowedProviders) && allowedProviders.length > 0) {
    const missing = allowedProviders.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      throw new RoleDirError(`unknown provider in role config: ${missing.join(", ")}`, "provider_unknown");
    }
    selected = allowedProviders;
  }

  const trimmed = { ...parsed, providers: Object.fromEntries(selected.map((name) => [name, providers[name]])) };
  await writeFile(target, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
  log("role.models.written", { providers: selected });
  return selected;
}

/**
 * Generate a minimal settings.json. Only the four keys listed in
 * ROLE_SETTINGS_KEYS ever survive; package extensions never do.
 */
async function writeSettings(roleDir, selection, userAgentDir) {
  const settings = {
    defaultProvider: selection.provider,
    defaultModel: selection.model,
    defaultThinkingLevel: selection.thinking,
  };
  try {
    const userSettings = JSON.parse(await readFile(path.join(userAgentDir, "settings.json"), "utf8"));
    const key = `${selection.provider}/${selection.model}`;
    const override = userSettings?.compaction?.modelOverrides?.[key];
    if (override && typeof override === "object") settings.compaction = { modelOverrides: { [key]: override } };
  } catch {
    // No user settings or unreadable: the generated defaults are enough.
  }
  await writeFile(path.join(roleDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

/**
 * Translate AIChatLink's --mcp-config (Claude Code shape) into a pi mcp.json.
 * Only the AIChatLink server survives, and only documented fields are copied.
 */
async function writeMcp(roleDir, mcpConfig) {
  const servers = {};
  if (mcpConfig !== undefined && mcpConfig !== null) {
    const source = mcpConfig.mcpServers;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new RoleDirError("--mcp-config has no mcpServers object", "mcp_config_invalid");
    }
    for (const [name, raw] of Object.entries(source)) {
      if (!raw || typeof raw !== "object") throw new RoleDirError(`mcp server ${name} is invalid`, "mcp_config_invalid");
      const entry = {};
      for (const [key, value] of Object.entries(raw)) {
        if (MCP_SERVER_KEYS.has(key)) entry[key] = value;
      }
      if (entry.command === undefined && entry.url === undefined) {
        throw new RoleDirError(`mcp server ${name} needs command or url`, "mcp_config_invalid");
      }
      if (entry.command !== undefined && !path.isAbsolute(String(entry.command))) {
        throw new RoleDirError(`mcp server ${name} command must be absolute`, "mcp_config_invalid");
      }
      if (Array.isArray(entry.args) && entry.args.some((arg) => typeof arg !== "string")) {
        throw new RoleDirError(`mcp server ${name} args must be strings`, "mcp_config_invalid");
      }
      servers[name] = entry;
    }
  }
  const payload = { mcpServers: servers };
  await writeFile(path.join(roleDir, "mcp.json"), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return Object.keys(servers);
}

/** Fingerprint used by the shim to notice that a role dir changed underneath it. */
export async function fingerprintRoleDir(roleDir) {
  const hash = createHash("sha256");
  for (const name of ["models.json", "settings.json", "mcp.json"]) {
    try {
      const info = await stat(path.join(roleDir, name));
      hash.update(`${name}:${info.size}:${info.mtimeMs};`);
    } catch {
      hash.update(`${name}:missing;`);
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export async function copySecretFree(source, target) {
  await copyFile(source, target);
  return target;
}
