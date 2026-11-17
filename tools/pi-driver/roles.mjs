// Role configuration: validation + defaults.
//
// A role is the only place a model/provider/thinking level is chosen, so this
// file is deliberately strict: unknown keys are rejected, ids are constrained to
// what AIChatLink and pi both accept, and no value may smuggle in extra argv.

export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,180}$/;
const ALLOWED_KEYS = new Set([
  "model",
  "provider",
  "thinking",
  "tools",
  "workdir",
  "contextFiles",
  "systemPrompt",
  "providers",
  "piArgs",
]);

export class RoleConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RoleConfigError";
    this.code = "role_config_invalid";
  }
}

/** @returns {{id: string, role: NormalizedRole}} */
export function normalizeRole(id, raw) {
  if (typeof id !== "string" || !ROLE_ID.test(id)) {
    throw new RoleConfigError(`invalid role id: ${String(id)}`);
  }
  if (!isPlainObject(raw)) throw new RoleConfigError(`role ${id} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) throw new RoleConfigError(`role ${id} has unknown key: ${key}`);
  }

  const model = requireToken(raw.model, `role ${id}: model is required`);
  const provider = requireToken(raw.provider, `role ${id}: provider is required`);
  const thinking = raw.thinking === undefined ? "off" : raw.thinking;
  if (!THINKING_LEVELS.includes(thinking)) {
    throw new RoleConfigError(`role ${id}: thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }

  return {
    id,
    role: {
      model,
      provider,
      thinking,
      tools: normalizeTools(id, raw.tools),
      workdir: raw.workdir === undefined ? null : requirePath(id, raw.workdir),
      contextFiles: raw.contextFiles !== false,
      systemPrompt: raw.systemPrompt === undefined ? null : String(raw.systemPrompt),
      providers: normalizeProviders(id, raw.providers),
      piArgs: normalizePiArgs(id, raw.piArgs),
    },
  };
}

/**
 * @param {string} filePath  ROLES.json
 * @returns {Map<string, NormalizedRole>}
 */
export function parseRolesFile(value) {
  if (!isPlainObject(value)) throw new RoleConfigError("roles file must be an object");
  const roles = isPlainObject(value.roles) ? value.roles : value;
  const out = new Map();
  for (const [id, raw] of Object.entries(roles)) {
    if (id === "version") continue;
    const normalized = normalizeRole(id, raw);
    out.set(normalized.id, normalized.role);
  }
  if (out.size === 0) throw new RoleConfigError("roles file has no roles");
  return out;
}

/** pi accepts letters, digits, `.`, `_`, `-` and must start/end alphanumerically. */
export function sanitizeSessionId(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,190}[A-Za-z0-9])?$/.test(raw)) return raw;
  // Deterministic fallback so a resumed native session still maps to the same
  // pi session across restarts (djb2 over the raw id, prefixed to stay legal).
  let hash = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) + hash + raw.charCodeAt(index)) >>> 0;
  }
  return `sx${hash.toString(16)}${raw.length.toString(16)}`;
}

function normalizeTools(id, tools) {
  if (tools === undefined || tools === "all") return { mode: "all" };
  if (!isPlainObject(tools)) throw new RoleConfigError(`role ${id}: tools must be "all" or an object`);
  const { include, exclude } = tools;
  if (include !== undefined && exclude !== undefined) {
    throw new RoleConfigError(`role ${id}: tools.include and tools.exclude are mutually exclusive`);
  }
  if (include !== undefined) return { mode: "include", list: stringList(id, include, "tools.include") };
  if (exclude !== undefined) return { mode: "exclude", list: stringList(id, exclude, "tools.exclude") };
  throw new RoleConfigError(`role ${id}: tools object needs include or exclude`);
}

function normalizeProviders(id, providers) {
  if (providers === undefined) return null;
  const list = stringList(id, providers, "providers");
  if (list.length === 0) throw new RoleConfigError(`role ${id}: providers must not be empty`);
  return list;
}

function normalizePiArgs(id, args) {
  if (args === undefined) return [];
  const list = stringList(id, args, "piArgs");
  for (const arg of list) {
    // Never let configuration re-introduce the flags the shim owns.
    if (["--mode", "--session-id", "--session", "--resume", "--model", "--provider", "--thinking"].some(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    )) {
      throw new RoleConfigError(`role ${id}: piArgs may not override ${arg.split("=")[0]}`);
    }
  }
  return list;
}

function stringList(id, value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new RoleConfigError(`role ${id}: ${field} must be an array of non-empty strings`);
  }
  return [...value];
}

function requireToken(value, message) {
  if (typeof value !== "string" || !MODEL_TOKEN.test(value)) throw new RoleConfigError(message);
  return value;
}

function requirePath(id, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RoleConfigError(`role ${id}: workdir must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
