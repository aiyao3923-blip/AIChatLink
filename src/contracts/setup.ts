import { z } from "zod";

import { parseContractOutput, parseWriteRequest } from "./validation.js";

const RESERVED_SETUP_AGENT_IDS = new Set(["assistant", "__assistant__"]);

// Mirrors BUILTIN_AGENT_IDS. The contracts layer stays free of runtime imports,
// so the list is duplicated here and pinned by tests/unit/contracts/setup.test.ts.
export const SetupAgentDriverSchema = z.enum([
  "codex",
  "grok",
  "claude",
  "pi",
  "workbuddy",
  "kimi",
  "hermes"
]);

export const SetupAgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u, "invalid agent id");

export const SetupCommandDraftSchema = z.strictObject({
  executable: z.string().trim().min(1).max(4_096),
  prefixArgs: z.array(z.string().trim().min(1).max(4_096)).max(1).default([])
});

// Mirrors core/model-selection.ts. The contracts layer stays free of runtime
// imports, so the levels are duplicated here and pinned by
// tests/unit/contracts/setup.test.ts.
export const SetupAgentThinkingSchema = z.enum([
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

export const SetupAgentDraftSchema = z
  .strictObject({
    id: SetupAgentIdSchema,
    driver: SetupAgentDriverSchema,
    name: z.string().trim().max(64).default(""),
    identity: z.string().trim().max(32_768).optional(),
    /** Native model id; empty means "use the driver/CLI default". */
    model: z.string().trim().max(200).optional(),
    /** Reasoner effort; omitted/empty means "use the driver default". */
    thinking: SetupAgentThinkingSchema.optional(),
    /** pi only: share the user's own pi config instead of the isolated copy. */
    piConfig: z.enum(["isolated", "shared"]).optional(),
    command: SetupCommandDraftSchema,
    /** Empty/absent means "follow the room workspace". */
    cwd: z.string().trim().max(4_096).optional(),
    enabled: z.boolean().default(true)
  })
  .superRefine((agent, context) => {
    if (RESERVED_SETUP_AGENT_IDS.has(agent.id)) {
      context.addIssue({
        code: "custom",
        message: "assistant is not a roster agent id",
        path: ["id"]
      });
    }
  });

export const SetupAssistantDraftSchema = z.strictObject({
  enabled: z.boolean().default(false),
  name: z.string().trim().min(1).max(64).default("房间助理"),
  brain: z.strictObject({
    driver: SetupAgentDriverSchema,
    command: SetupCommandDraftSchema,
    /** Empty/absent means "follow the room workspace". */
    cwd: z.string().trim().max(4_096).optional()
  }),
  extraInstructions: z.string().trim().max(32_768).optional()
});

export const SetupConfigDraftSchema = z
  .strictObject({
    serverPort: z.number().int().min(1).max(65_535).default(4_310),
    /** Room-level working directory every Agent inherits unless it overrides `cwd`. */
    workspace: z.string().trim().max(4_096).optional(),
    storagePath: z.string().trim().min(1).max(4_096).default(".aichatlink/aichatlink.db"),
    agents: z.array(SetupAgentDraftSchema).min(1).max(64),
    assistant: SetupAssistantDraftSchema.optional()
  })
  .superRefine((draft, context) => {
    const seen = new Set<string>();
    for (const [index, agent] of draft.agents.entries()) {
      if (seen.has(agent.id)) {
        context.addIssue({
          code: "custom",
          message: "agent ids must be unique",
          path: ["agents", index, "id"]
        });
      }
      seen.add(agent.id);
    }
  });

export const SetupSaveRequestSchema = z
  .strictObject({
    config: SetupConfigDraftSchema
  })
  .superRefine((request, context) => {
    if (!request.config.agents.some((agent) => agent.enabled)) {
      context.addIssue({
        code: "custom",
        message: "at least one agent must be enabled",
        path: ["config", "agents"]
      });
    }
  });

export const SetupDriverProbeSchema = z.strictObject({
  driver: SetupAgentDriverSchema,
  found: z.boolean()
});

/** Model choices offered for one roster entry; never carries credentials. */
export const SetupAgentCatalogSchema = z
  .strictObject({
    source: z.enum(["cc-switch", "pi", "driver"]),
    provider: z.string().max(200).optional(),
    defaultModel: z.string().max(200).optional(),
    models: z.array(z.string().max(200)).max(200),
    thinkingLevels: z.array(SetupAgentThinkingSchema).max(20),
    note: z.string().max(300).optional()
  });

export const SetupSnapshotSchema = z
  .strictObject({
    configPath: z.string().min(1),
    existing: z.boolean(),
    runtimeActive: z.boolean(),
    drivers: z.array(SetupDriverProbeSchema).length(SetupAgentDriverSchema.options.length),
    config: SetupConfigDraftSchema,
    /** Absolute form of `config.workspace`, for display only. */
    workspaceResolved: z.string().trim().min(1).optional(),
    /** Keyed by roster agent id. Absent when discovery failed entirely. */
    agentCatalogs: z.record(z.string(), SetupAgentCatalogSchema).optional(),
    /** Fallback by driver for a newly added roster entry. */
    driverCatalogs: z.record(z.string(), SetupAgentCatalogSchema).optional(),
    existingConfigError: z.string().min(1).optional()
  })
  .superRefine((snapshot, context) => {
    const drivers = new Set(snapshot.drivers.map(({ driver }) => driver));
    if (drivers.size !== SetupAgentDriverSchema.options.length) {
      context.addIssue({
        code: "custom",
        message: `driver probes must contain ${SetupAgentDriverSchema.options.join(", ")} exactly once`,
        path: ["drivers"]
      });
    }
  });

export const SetupSaveResponseSchema = z
  .strictObject({
    saved: z.literal(true),
    configPath: z.string().min(1),
    agentCount: z.number().int().min(1).max(64),
    enabledAgentCount: z.number().int().min(1).max(64),
    restartRequired: z.boolean()
  })
  .superRefine((response, context) => {
    if (response.enabledAgentCount > response.agentCount) {
      context.addIssue({
        code: "custom",
        message: "enabled agent count cannot exceed total agent count",
        path: ["enabledAgentCount"]
      });
    }
  });

export type SetupAgentDriver = z.infer<typeof SetupAgentDriverSchema>;
export type SetupAgentDraft = z.infer<typeof SetupAgentDraftSchema>;
export type SetupAgentCatalog = z.infer<typeof SetupAgentCatalogSchema>;
export type SetupAssistantDraft = z.infer<typeof SetupAssistantDraftSchema>;
export type SetupConfigDraft = z.infer<typeof SetupConfigDraftSchema>;
export type SetupSaveRequest = z.infer<typeof SetupSaveRequestSchema>;
export type SetupSnapshot = z.infer<typeof SetupSnapshotSchema>;
export type SetupSaveResponse = z.infer<typeof SetupSaveResponseSchema>;

export function parseSetupSaveRequest(input: unknown): SetupSaveRequest {
  return parseWriteRequest(SetupSaveRequestSchema, input);
}

export function parseSetupConfigDraft(input: unknown): SetupConfigDraft {
  return parseContractOutput(SetupConfigDraftSchema, input);
}

export function parseSetupSnapshot(input: unknown): SetupSnapshot {
  return parseContractOutput(SetupSnapshotSchema, input);
}

export function parseSetupSaveResponse(input: unknown): SetupSaveResponse {
  return parseContractOutput(SetupSaveResponseSchema, input);
}
