import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AIChatLinkError } from "./core/errors.js";
import { isReservedAgentId } from "./core/assistant.js";
import { AGENT_THINKING_LEVELS } from "./core/model-selection.js";
import {
  BUILTIN_AGENT_IDS,
  resolveAgentCommand,
  systemCommandResolverDependencies,
  type AgentDriver,
  type BuiltinAgentId,
  type CommandResolverDependencies,
  type CommandSpec
} from "./launch/command-spec.js";

export const TRANSPORT_MODES = ["direct", "structured"] as const;
export const DEFAULT_CONTEXT_CHARACTERS = 1_000_000;
export const LEGACY_CONTEXT_CHARACTERS = 48_000;
/** Previous auto-generated default; upgraded to the current budget on load. */
export const PREVIOUS_CONTEXT_CHARACTERS = 256_000;

export type TransportMode = (typeof TRANSPORT_MODES)[number];

export {
  AGENT_THINKING_LEVELS,
  type AgentThinkingLevel
} from "./core/model-selection.js";

/** Direct is a storage/history discriminator only; every public runtime entry rejects it. */
export const TRANSPORT_LIFECYCLE = {
  direct: "deprecated",
  structured: "active"
} as const satisfies Record<TransportMode, "active" | "deprecated">;

export function assertActiveTransport(
  transport: TransportMode
): asserts transport is "structured" {
  if (transport === "structured") return;
  throw new AIChatLinkError(
    "ADAPTER_START_FAILED",
    "Direct transport is deprecated and disabled; use structured transport"
  );
}

const runtimeTransportSchema = z.enum(TRANSPORT_MODES).superRefine((transport, context) => {
  if (transport === "structured") return;
  context.addIssue({
    code: "custom",
    message: "Direct transport is deprecated and disabled; use structured"
  });
});

const commandSpecSchema = z
  .object({
    executable: z.string().min(1),
    prefixArgs: z.array(z.string().min(1)).default([])
  })
  .strict();

const commandInputSchema = z
  .union([z.string().min(1), commandSpecSchema])
  .transform((command): CommandSpec =>
    typeof command === "string" ? { executable: command, prefixArgs: [] } : command
  );

const agentIdKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u, "invalid agent id");

const agentConfigSchema = z
  .object({
    // Omit for the builtin ids (codex/grok/kimi/hermes/claude); required for custom ids.
    driver: z.enum(BUILTIN_AGENT_IDS).optional(),
    name: z.string().min(1).max(64).optional(),
    /** Stable AIChatLink room identity injected into every turn for this Agent. */
    identity: z.string().max(32_768).optional(),
    /** Native model id. Applied through argv/thread config, not the user's CLI files. */
    model: z.string().trim().min(1).max(200).optional(),
    /** Native reasoning effort. Unsupported levels are left to the driver default. */
    thinking: z.enum(AGENT_THINKING_LEVELS).optional(),
    /**
     * Roster position in the top bar / activity rail. Presentation only: it
     * never affects dispatch, `@all`, or how many times a role may be called.
     * Omitted keeps the historical actorId order.
     */
    order: z.number().int().min(0).max(9_999).optional(),
    /**
     * Finish-last seat. A Turn for this Agent is not dispatched until every
     * other in-flight Turn in the same room has reached a terminal status, so a
     * closing/summary role can never speak before the review Turns it reports
     * on. Dispatch semantics, unlike `order`, which is presentation only.
     * A bounded release (`timeouts.finishLastWaitMs`) keeps a stuck peer from
     * parking the closing Turn forever.
     */
    finishLast: z.boolean().optional(),
    /**
     * pi only. `shared` mounts the user's own pi capability surface
     * (settings, extensions, Agents, skills, full model catalog) in the role
     * directory; `isolated` keeps the bounded credential copy. Default:
     * `isolated`, or `AICHATLINK_PI_CONFIG` when set.
     */
    piConfig: z.enum(["isolated", "shared"]).optional(),
    command: commandInputSchema,
    cwd: z.string().min(1),
    enabled: z.boolean().default(true)
  })
  .strict();

const agentsConfigSchema = z
  .record(agentIdKeySchema, agentConfigSchema)
  .superRefine((agents, context) => {
    if (Object.keys(agents).length === 0) {
      context.addIssue({ code: "custom", message: "At least one agent is required" });
    }
    for (const [agentId, agent] of Object.entries(agents)) {
      if (isReservedAgentId(agentId)) {
        context.addIssue({
          code: "custom",
          path: [agentId],
          message: `Agent id "${agentId}" is reserved for the room assistant and cannot be a roster worker`
        });
      }
      if (agent.driver === undefined && !isBuiltinAgentId(agentId)) {
        context.addIssue({
          code: "custom",
          path: [agentId, "driver"],
          message: `Custom agent "${agentId}" requires a driver: ${BUILTIN_AGENT_IDS.join(" | ")}`
        });
      }
    }
  })
  .transform((agents) =>
    Object.fromEntries(
      Object.entries(agents).map(([agentId, agent]) => [
        agentId,
        { ...agent, driver: agent.driver ?? (agentId as AgentDriver) }
      ])
    )
  );

const assistantBrainSchema = z
  .object({
    driver: z.enum(BUILTIN_AGENT_IDS),
    command: commandInputSchema,
    cwd: z.string().min(1)
  })
  .strict();

const assistantConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    name: z.string().min(1).max(64).default("房间助理"),
    brain: assistantBrainSchema,
    extraInstructions: z.string().max(32_768).optional()
  })
  .strict();

export function isBuiltinAgentId(agentId: string): agentId is BuiltinAgentId {
  return (BUILTIN_AGENT_IDS as readonly string[]).includes(agentId);
}

const configSchema = z
  .object({
    transport: runtimeTransportSchema.default("structured"),
    /**
     * Room-level working directory. Agents and the room assistant omit `cwd` to
     * follow it, so changing the folder once re-points the whole room.
     */
    workspace: z.string().min(1).optional(),
    server: z
      .object({
        host: z.literal("127.0.0.1").default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535).default(4_310)
      })
      .strict()
      .default({ host: "127.0.0.1", port: 4_310 }),
    storage: z
      .object({
        path: z.string().min(1).default(".aichatlink/aichatlink.db")
      })
      .strict()
      .default({ path: ".aichatlink/aichatlink.db" }),
    // kimi/hermes stay loadable but are not part of the supported starter set.
    agents: agentsConfigSchema.default({
      codex: { driver: "codex", command: { executable: "codex", prefixArgs: [] }, cwd: ".", enabled: true },
      grok: { driver: "grok", command: { executable: "grok", prefixArgs: [] }, cwd: ".", enabled: true },
      claude: { driver: "claude", command: { executable: "claude", prefixArgs: [] }, cwd: ".", enabled: true }
    }),
    assistant: assistantConfigSchema.optional(),
    limits: z
      .object({
        // REST/MCP request schemas use the same fixed wire bound. Keep this
        // field for an explicit runtime snapshot, but do not pretend a config
        // value can widen or narrow a parser that is intentionally static.
        // The retired 32_768 literal stays parseable so older generated
        // configs load; the loader upgrades it to the current bound.
        messageCharacters: z
          .union([z.literal(131_072), z.literal(32_768)])
          .default(131_072),
        queuePerAgent: z.number().int().min(1).max(10_000).default(64),
        rootTurns: z.number().int().min(1).max(1_000).default(48),
        hopCount: z.number().int().min(1).max(1_000).default(24),
        actorCallsPerRoot: z.number().int().min(1).max(1_000).default(16),
        steersPerSubjectTurn: z.number().int().min(1).max(16).default(3),
        // Cross-Agent room budget. This is a deterministic character bound,
        // not a claim about any provider's token window (Codex may expose a
        // much larger model-specific window). RoomContextEngine compacts at a
        // 75% soft target to leave native instructions/response headroom while
        // this value remains the hard ceiling.
        contextCharacters: z
          .number()
          .int()
          .min(1_024)
          .max(10_000_000)
          .default(DEFAULT_CONTEXT_CHARACTERS),
        sseEvents: z.number().int().min(8).max(100_000).default(512),
        // A single durable event frame must always fit this buffer, so the
        // default stays a wide multiple of the message wire bound.
        sseBytes: z.number().int().min(16_384).max(100_000_000).default(2_097_152)
      })
      .strict()
      .default({
        messageCharacters: 131_072,
        queuePerAgent: 64,
        rootTurns: 48,
        hopCount: 24,
        actorCallsPerRoot: 16,
        steersPerSubjectTurn: 3,
        contextCharacters: DEFAULT_CONTEXT_CHARACTERS,
        sseEvents: 512,
        sseBytes: 2_097_152
      }),
    timeouts: z
      .object({
        handshakeMs: z.number().int().min(100).max(300_000).default(15_000),
        requestMs: z.number().int().min(100).max(300_000).default(10_000),
        firstEventMs: z.number().int().min(100).max(3_600_000).default(180_000),
        idleMs: z.number().int().min(100).max(3_600_000).default(300_000),
        cancelMs: z.number().int().min(100).max(300_000).default(10_000),
        closeMs: z.number().int().min(100).max(300_000).default(5_000),
        askMs: z.number().int().min(100).max(3_600_000).default(120_000),
        /**
         * Upper bound on how long a finish-last Turn may stay held behind other
         * in-flight Turns in its room. The bound is a deadlock release, not a
         * target: a healthy room releases the Turn as soon as the peers settle.
         */
        finishLastWaitMs: z.number().int().min(1_000).max(86_400_000).default(1_800_000),
        watchMs: z.number().int().min(100).max(3_600_000).default(120_000)
      })
      .strict()
      .default({
        handshakeMs: 15_000,
        requestMs: 10_000,
        firstEventMs: 180_000,
        idleMs: 300_000,
        cancelMs: 10_000,
        closeMs: 5_000,
        askMs: 120_000,
        finishLastWaitMs: 1_800_000,
        watchMs: 120_000
      })
  })
  .strict();

/**
 * An Agent or the assistant without `cwd` follows the room `workspace`. Filling
 * happens before validation so the parsed type keeps `cwd: string` for every
 * downstream consumer, while the on-disk document may omit it.
 */
function inheritWorkingDirectories(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const document = { ...(raw as Record<string, unknown>) };
  const workspace =
    typeof document.workspace === "string" && document.workspace.length > 0
      ? document.workspace
      : undefined;
  const fill = (value: unknown): string =>
    typeof value === "string" && value.length > 0 ? value : (workspace ?? ".");

  const agents = document.agents;
  if (typeof agents === "object" && agents !== null && !Array.isArray(agents)) {
    document.agents = Object.fromEntries(
      Object.entries(agents as Record<string, unknown>).map(([agentId, value]) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [agentId, value];
        const agent = { ...(value as Record<string, unknown>) };
        agent.cwd = fill(agent.cwd);
        return [agentId, agent];
      })
    );
  }

  const assistant = document.assistant;
  if (typeof assistant === "object" && assistant !== null && !Array.isArray(assistant)) {
    const assistantCopy = { ...(assistant as Record<string, unknown>) };
    const brain = assistantCopy.brain;
    if (typeof brain === "object" && brain !== null && !Array.isArray(brain)) {
      assistantCopy.brain = {
        ...(brain as Record<string, unknown>),
        cwd: fill((brain as Record<string, unknown>).cwd)
      };
    }
    document.assistant = assistantCopy;
  }
  return document;
}

const configDocumentSchema = configSchema;
const configSchemaWithInheritance = z.preprocess(
  inheritWorkingDirectories,
  configDocumentSchema
);

export type AIChatLinkConfig = z.infer<typeof configSchemaWithInheritance>;

/** Parse a config document without resolving commands or filesystem-relative paths. */
export function parseConfigDocument(input: unknown): AIChatLinkConfig {
  const parsed = configSchemaWithInheritance.safeParse(input);
  if (!parsed.success) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Invalid AIChatLink config", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return parsed.data;
}

/** Resolve a parsed document for one concrete config-directory/runtime context. */
export function resolveConfigDocument(
  config: AIChatLinkConfig,
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies = systemCommandResolverDependencies
): AIChatLinkConfig {
  return resolveConfigPaths(config, baseDirectory, commandDependencies);
}

export function defaultConfig(
  cwd = process.cwd(),
  commandDependencies: CommandResolverDependencies = systemCommandResolverDependencies
): AIChatLinkConfig {
  const parsed = configSchemaWithInheritance.parse({
    agents: {
      codex: { command: "codex", cwd },
      grok: { command: "grok", cwd },
      claude: { command: "claude", cwd }
    }
  });
  return resolveAgentCommands(parsed, path.resolve(cwd), commandDependencies);
}

export async function loadConfig(
  configPath?: string,
  cwd = process.cwd(),
  commandDependencies: CommandResolverDependencies = systemCommandResolverDependencies
): Promise<AIChatLinkConfig> {
  if (configPath === undefined) {
    return resolveConfigPaths(defaultConfig(cwd, commandDependencies), cwd, commandDependencies);
  }
  const absolutePath = path.resolve(cwd, configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new AIChatLinkError("INVALID_ENVELOPE", `Unable to read AIChatLink config: ${absolutePath}`, undefined, {
      cause: error
    });
  }
  const parsed = parseConfigDocument(raw);
  upgradeLegacyGeneratedDefaults(parsed);
  return resolveConfigDocument(parsed, path.dirname(absolutePath), commandDependencies);
}

/**
 * Upgrades values that exactly match an auto-generated default from an older
 * release to the current default. Any other explicit value stays user-owned;
 * this mirrors the original 48k context-budget migration precedent.
 */
export function upgradeLegacyGeneratedDefaults(config: AIChatLinkConfig): void {
  if (
    config.limits.contextCharacters === LEGACY_CONTEXT_CHARACTERS ||
    config.limits.contextCharacters === PREVIOUS_CONTEXT_CHARACTERS
  ) {
    config.limits.contextCharacters = DEFAULT_CONTEXT_CHARACTERS;
  }
  if (config.limits.messageCharacters === 32_768) {
    config.limits.messageCharacters = 131_072;
  }
  if (config.limits.rootTurns === 24) config.limits.rootTurns = 48;
  if (config.limits.hopCount === 12) config.limits.hopCount = 24;
  if (config.limits.actorCallsPerRoot === 8) config.limits.actorCallsPerRoot = 16;
  if (config.limits.sseBytes === 524_288) config.limits.sseBytes = 2_097_152;
  if (config.timeouts.firstEventMs === 90_000) config.timeouts.firstEventMs = 180_000;
  if (config.timeouts.idleMs === 120_000) config.timeouts.idleMs = 300_000;
}

function resolveConfigPaths(
  config: AIChatLinkConfig,
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies
): AIChatLinkConfig {
  const resolvedBaseDirectory = path.resolve(baseDirectory);
  const workspace =
    config.workspace === undefined ? undefined : path.resolve(resolvedBaseDirectory, config.workspace);
  return {
    ...config,
    ...(workspace === undefined ? {} : { workspace }),
    storage: { path: path.resolve(resolvedBaseDirectory, config.storage.path) },
    agents: mapAgentConfigs(config.agents, (agentId, agent) => ({
      ...agent,
      command: agent.enabled
        ? resolveAgentCommand(agentId, agent.driver, agent.command, resolvedBaseDirectory, commandDependencies)
        : agent.command,
      cwd: path.resolve(resolvedBaseDirectory, agent.cwd ?? config.workspace ?? ".")
    })),
    ...(config.assistant === undefined
      ? {}
      : {
          assistant: {
            ...config.assistant,
            brain: {
              ...config.assistant.brain,
              command: config.assistant.enabled
                ? resolveAgentCommand(
                    config.assistant.brain.driver,
                    config.assistant.brain.driver,
                    config.assistant.brain.command,
                    resolvedBaseDirectory,
                    commandDependencies
                  )
                : config.assistant.brain.command,
              cwd: path.resolve(resolvedBaseDirectory, config.assistant.brain.cwd ?? config.workspace ?? ".")
            }
          }
        })
  };
}

function resolveAgentCommands(
  config: AIChatLinkConfig,
  baseDirectory: string,
  commandDependencies: CommandResolverDependencies
): AIChatLinkConfig {
  return {
    ...config,
    agents: mapAgentConfigs(config.agents, (agentId, agent) => ({
      ...agent,
      command: resolveAgentCommand(agentId, agent.driver, agent.command, baseDirectory, commandDependencies)
    }))
  };
}

function mapAgentConfigs(
  agents: AIChatLinkConfig["agents"],
  map: (agentId: string, agent: AIChatLinkConfig["agents"][string]) => AIChatLinkConfig["agents"][string]
): AIChatLinkConfig["agents"] {
  return Object.fromEntries(Object.entries(agents).map(([agentId, agent]) => [agentId, map(agentId, agent)]));
}

export function parseConfigPath(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") {
      const next = argv[index + 1];
      if (!next) {
        throw new AIChatLinkError("INVALID_ENVELOPE", "--config requires a path");
      }
      return next;
    }
    if (value?.startsWith("--config=")) {
      const configPath = value.slice("--config=".length);
      if (configPath.length === 0) {
        throw new AIChatLinkError("INVALID_ENVELOPE", "--config requires a path");
      }
      return configPath;
    }
  }
  return undefined;
}
