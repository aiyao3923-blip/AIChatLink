/**
 * Read-only model discovery for the setup page.
 *
 * Two local sources are projected into a bounded, credential-free catalog:
 *
 *  1. CC Switch (`~/.cc-switch/cc-switch.db`) — the user's current provider per
 *     app type. Only provider name, model ids and reasoning levels leave this
 *     module; `settings_config` also contains API keys and those are never
 *     copied into a catalog, a log line or a response.
 *  2. pi (`~/.pi/agent/models.json`) — the same catalog the pi driver copies,
 *     trimmed to `provider/model` ids so a role can select a model in place.
 *
 * A catalog only feeds the setup form. Selecting a value stores it in
 * aichatlink.json and the runtime passes it to the native CLI as argv/thread config;
 * no user CLI configuration file is written.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import type { SetupAgentCatalog } from "../contracts/index.js";

const PI_MODEL_LIST_LIMIT = 200;
const CATALOG_NOTE_LIMIT = 300;

export interface CatalogAgentRef {
  readonly id: string;
  readonly driver: string;
  readonly command: { readonly prefixArgs: readonly string[] };
}

interface SourceCatalogs {
  readonly claude?: SetupAgentCatalog | undefined;
  readonly codex?: SetupAgentCatalog | undefined;
  readonly pi?: SetupAgentCatalog | undefined;
}

export function ccSwitchDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CC_SWITCH_DB ?? path.join(os.homedir(), ".cc-switch", "cc-switch.db");
}

export function piAgentModelsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_AGENT_MODELS ?? path.join(os.homedir(), ".pi", "agent", "models.json");
}

/** A pi-backed roster entry is a Claude-driver shim whose prefix is pi-driver. */
export function isPiBackedAgent(agent: CatalogAgentRef): boolean {
  return agent.command.prefixArgs.some((argument) => /(?:pi-driver|pi-shim)/u.test(argument));
}

/**
 * @returns catalogs keyed by roster agent id; omitted entirely on a total miss.
 */
export async function discoverAgentCatalogs(
  agents: readonly CatalogAgentRef[],
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, SetupAgentCatalog>> {
  const sources = await readSources(env);
  const catalogs: Record<string, SetupAgentCatalog> = {};
  for (const agent of agents) {
    const catalog = catalogForAgent(agent, sources);
    if (catalog !== undefined) catalogs[agent.id] = catalog;
  }
  return catalogs;
}

function catalogForAgent(
  agent: CatalogAgentRef,
  sources: SourceCatalogs
): SetupAgentCatalog | undefined {
  if (isPiBackedAgent(agent)) return sources.pi;
  switch (agent.driver) {
    case "claude":
      return sources.claude;
    case "codex":
      return sources.codex;
    case "pi":
      return sources.pi;
    // Grok/Kimi/Hermes ACP expose no model-selection surface today; the setup
    // page says so instead of offering a value that would change nothing.
    case "grok":
    case "hermes":
    case "kimi":
    default:
      return undefined;
  }
}

async function readSources(env: NodeJS.ProcessEnv): Promise<SourceCatalogs> {
  const [ccSwitch, pi] = await Promise.all([
    readCcSwitchCatalogs(ccSwitchDatabasePath(env)),
    readPiCatalog(piAgentModelsPath(env))
  ]);
  return { ...ccSwitch, ...(pi === undefined ? {} : { pi }) };
}

function readCcSwitchCatalogs(databasePath: string): SourceCatalogs {
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const rows = database
      .prepare(
        "SELECT app_type, name, settings_config FROM providers WHERE is_current = 1 ORDER BY app_type"
      )
      .all() as Array<{ app_type: string; name: string; settings_config: string }>;
    const next = new Map<string, SetupAgentCatalog>();
    for (const row of rows) {
      const catalog = projectProvider(row.app_type, row.name, row.settings_config);
      if (catalog !== undefined) next.set(row.app_type, catalog);
    }
    return {
      ...(next.get("claude") === undefined ? {} : { claude: next.get("claude") }),
      ...(next.get("codex") === undefined ? {} : { codex: next.get("codex") })
    };
  } catch {
    // Missing/locked database is normal on a machine without CC Switch.
    return {};
  } finally {
    try {
      database?.close();
    } catch {
      // ignore
    }
  }
}

function projectProvider(appType: string, providerName: string, raw: string): SetupAgentCatalog | undefined {
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(config)) return undefined;
  const env = isRecord(config.env) ? config.env : undefined;
  const models = new Set<string>();
  const levels = new Set<string>();
  let defaultModel: string | undefined;

  if (appType === "claude") {
    defaultModel = pickModelName(env, ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"]);
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"
    ]) {
      const value = env?.[key];
      if (typeof value === "string" && value.trim().length > 0) models.add(value.trim());
    }
    const effort = config.effortLevel;
    if (typeof effort === "string") levels.add(effort);
  } else if (appType === "codex") {
    const text = typeof config.config === "string" ? config.config : "";
    const modelMatch = /^\s*model\s*=\s*"([^"]+)"/mu.exec(text);
    if (modelMatch?.[1]) {
      defaultModel = modelMatch[1];
      models.add(modelMatch[1]);
    }
    const catalog = isRecord(config.modelCatalog) ? config.modelCatalog : undefined;
    const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
    for (const entry of catalogModels) {
      if (!isRecord(entry)) continue;
      if (typeof entry.model === "string" && entry.model.length > 0) models.add(entry.model);
      const reasoning = Array.isArray(entry.reasoningLevels) ? entry.reasoningLevels : [];
      for (const level of reasoning) if (typeof level === "string") levels.add(level);
    }
  } else if (appType === "hermes") {
    defaultModel = pickModelName(env, ["HERMES_MODEL", "OPENAI_MODEL", "MODEL"]);
    if (defaultModel !== undefined) models.add(defaultModel);
  }

  if (models.size === 0 && levels.size === 0) return undefined;
  return boundedCatalog({
    source: "cc-switch",
    provider: providerName,
    defaultModel,
    models: [...models],
    thinkingLevels: [...levels]
  });
}

function pickModelName(env: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

async function readPiCatalog(modelsPath: string): Promise<SetupAgentCatalog | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(modelsPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return undefined;
  const models = new Set<string>();
  const levels = new Set<string>(["off", "low", "medium", "high", "xhigh"]);
  for (const [providerName, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) continue;
      models.add(`${providerName}/${model.id}`);
      if (isRecord(model.thinkingLevelMap)) {
        for (const level of Object.keys(model.thinkingLevelMap)) levels.add(level);
      }
    }
  }
  if (models.size === 0) return undefined;
  return boundedCatalog({
    source: "pi",
    models: [...models],
    thinkingLevels: [...levels],
    note: "来自 ~/.pi/agent/models.json（CC Switch 的 pi 供应商同源）"
  });
}

function boundedCatalog(input: {
  source: SetupAgentCatalog["source"];
  provider?: string | undefined;
  defaultModel?: string | undefined;
  models: readonly string[];
  thinkingLevels: readonly string[];
  note?: string | undefined;
}): SetupAgentCatalog {
  const filteredLevels = input.thinkingLevels.filter((level) => LEVEL_SET.has(level));
  return {
    source: input.source,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
    models: [...new Set(input.models)].slice(0, PI_MODEL_LIST_LIMIT),
    thinkingLevels: [...new Set(filteredLevels)] as SetupAgentCatalog["thinkingLevels"],
    ...(input.note === undefined ? {} : { note: input.note.slice(0, CATALOG_NOTE_LIMIT) })
  };
}

const LEVEL_SET = new Set([
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
