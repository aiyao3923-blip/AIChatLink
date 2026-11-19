import { z } from "zod";

import {
  ActorIdSchema,
  AgentActorIdSchema,
  ClientCommandIdSchema,
  CursorParameterSchema,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_SUPERVISION_OBSERVERS,
  MessageContentSchema,
  MessageTargetsSchema,
  NonNegativeIntegerSchema,
  OptionalReplyToEventIdSchema,
  PositiveLimitSchema,
  ReferenceIdSchema
} from "./common.js";
import { AIChatLinkEnvelopeSchema } from "./events.js";
import {
  assertKnownTargets,
  parseContractOutput,
  parseWriteRequest,
  type KnownTargetOptions
} from "./validation.js";

const SupervisionObserversSchema = z
  .array(AgentActorIdSchema)
  .min(1)
  .max(MAX_SUPERVISION_OBSERVERS)
  .superRefine((observers, context) => {
    const seen = new Set<string>();
    for (const [index, observer] of observers.entries()) {
      if (seen.has(observer)) {
        context.addIssue({
          code: "custom",
          message: "supervision observers must be unique",
          path: [index]
        });
      }
      seen.add(observer);
    }
  })
  .transform((observers) => [...observers].sort((left, right) => left.localeCompare(right)));

export const SupervisionPairSchema = z.strictObject({
  observers: SupervisionObserversSchema,
  mode: z.literal("live_steer")
});


export const ResumedConversationSchema = z.strictObject({
  conversationId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  fromSeq: z.number().int().nonnegative(),
  throughSeq: z.number().int().positive()
});

export const ConversationRangeSchema = z.strictObject({
  fromSeq: z.number().int().positive(),
  throughSeq: z.number().int().positive()
});

export const ConversationSummarySchema = z.strictObject({
  conversationId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().positive().nullable(),
  startedAt: z.string().min(1).max(64),
  active: z.boolean(),
  /** The open epoch holds no room-context message yet; the sidebar hides it. */
  empty: z.boolean(),
  /** Closed conversation this epoch was resumed from, if any. */
  resumedFrom: ResumedConversationSchema.nullable(),
  /**
   * Seq ranges this conversation actually occupies, in order. A conversation
   * continues across epochs, so its own segments may be separated by another
   * conversation's events; replaying only these ranges keeps the two apart.
   */
  ranges: z.array(ConversationRangeSchema).max(64)
});

export const ConversationListSchema = z.strictObject({
  conversations: z.array(ConversationSummarySchema).max(10_000)
});

export const ResumeConversationRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  conversationId: z.string().min(1).max(64),
  resetNativeSessions: z.boolean().optional()
});

export const DeleteConversationRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  conversationId: z.string().min(1).max(64),
  resetNativeSessions: z.boolean().optional()
});

export const DeleteConversationResultSchema = z.strictObject({
  conversationId: z.string().min(1).max(64),
  deletedEvents: NonNegativeIntegerSchema,
  deletedTurns: NonNegativeIntegerSchema
});


export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ConversationList = z.infer<typeof ConversationListSchema>;
export type ResumeConversationRequest = z.infer<typeof ResumeConversationRequestSchema>;
export type DeleteConversationRequest = z.infer<typeof DeleteConversationRequestSchema>;
export type DeleteConversationResult = z.infer<typeof DeleteConversationResultSchema>;
export type ResetContextRequest = z.infer<typeof ResetContextRequestSchema>;
export type RoomContextResetResult = z.infer<typeof RoomContextResetResultSchema>;

export function parseConversationList(input: unknown): ConversationList {
  return parseContractOutput(ConversationListSchema, input);
}

export function parseResumeConversationRequest(input: unknown): ResumeConversationRequest {
  return parseWriteRequest(ResumeConversationRequestSchema, input);
}

export function parseDeleteConversationRequest(input: unknown): DeleteConversationRequest {
  return parseWriteRequest(DeleteConversationRequestSchema, input);
}

export function parseDeleteConversationResult(input: unknown): DeleteConversationResult {
  return parseContractOutput(DeleteConversationResultSchema, input);
}

export function parseResetContextRequest(input: unknown): ResetContextRequest {
  return parseWriteRequest(ResetContextRequestSchema, input);
}

export function parseRoomContextResetResult(input: unknown): RoomContextResetResult {
  return parseContractOutput(RoomContextResetResultSchema, input);
}

export const CreateMessageRequestSchema = z
  .strictObject({
    clientCommandId: ClientCommandIdSchema,
    to: MessageTargetsSchema,
    content: MessageContentSchema,
    replyToEventId: OptionalReplyToEventIdSchema,
    supervision: SupervisionPairSchema.optional()
  })
  .superRefine((request, context) => {
    if (request.supervision === undefined) return;
    const workers = new Set(request.to);
    for (const [index, observer] of request.supervision.observers.entries()) {
      if (workers.has(observer)) {
        context.addIssue({
          code: "custom",
          message: "a supervision observer cannot also be a worker in the same command",
          path: ["supervision", "observers", index]
        });
      }
    }
  });

export const QueuedTurnResultSchema = z.object({
  target: AgentActorIdSchema,
  turnId: ReferenceIdSchema,
  status: z.literal("queued"),
  queuePosition: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  activeTurnId: ReferenceIdSchema.optional()
}).passthrough();

export const QueuedTurnResultsSchema = z
  .array(QueuedTurnResultSchema)
  .min(1)
  .max(32)
  .superRefine((turns, context) => {
    const targets = turns.map((turn) => turn.target);
    if (new Set(targets).size !== targets.length) {
      context.addIssue({
        code: "custom",
        message: "accepted turn targets must be unique",
        path: []
      });
    }
  });

export const CreateMessageAcceptedSchema = z.object({
  messageEventId: ReferenceIdSchema,
  correlationId: ReferenceIdSchema,
  turns: QueuedTurnResultsSchema,
  watchTurns: QueuedTurnResultsSchema.optional(),
  watchEventId: ReferenceIdSchema.optional(),
  pairEventId: ReferenceIdSchema.optional()
}).passthrough();

export const CancelTurnRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const TurnStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

export const CancelTurnResultSchema = z
  .strictObject({
    turnId: ReferenceIdSchema,
    accepted: z.boolean(),
    status: TurnStatusSchema
  })
  .superRefine((result, context) => {
    if (!result.accepted && !TERMINAL_TURN_STATUSES.has(result.status)) {
      context.addIssue({
        code: "custom",
        message: "a rejected cancel result must describe an already-terminal Turn",
        path: ["status"]
      });
    }
  });

export const RestartAgentRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const RestartAgentAcceptedSchema = z.object({
  actorId: AgentActorIdSchema,
  accepted: z.literal(true),
  previousInstanceId: ReferenceIdSchema.optional()
}).passthrough();

const RuntimeIdentityKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const RuntimeShutdownRequestSchema = z.strictObject({
  runtimeScopeKey: RuntimeIdentityKeySchema
});

export const RuntimeShutdownAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  runtimeKey: RuntimeIdentityKeySchema,
  runtimeScopeKey: RuntimeIdentityKeySchema
});

export const CompactContextRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const RoomContextUsageSchema = z
  .object({
    roomId: ReferenceIdSchema,
    throughSeq: NonNegativeIntegerSchema,
    estimatedCharacters: NonNegativeIntegerSchema,
    maxCharacters: z.number().int().positive(),
    compactionTriggerCharacters: z.number().int().positive(),
    utilizationPercent: z.number().int().min(0).max(100),
    uncompactedMessageCount: NonNegativeIntegerSchema,
    summaryThroughSeq: NonNegativeIntegerSchema.optional(),
    resetThroughSeq: NonNegativeIntegerSchema.optional(),
    compactable: z.boolean()
  })
  .passthrough()
  .superRefine((usage, context) => {
    if (usage.compactionTriggerCharacters > usage.maxCharacters) {
      context.addIssue({
        code: "custom",
        message: "compaction trigger must not exceed the hard context limit",
        path: ["compactionTriggerCharacters"]
      });
    }
    if (usage.summaryThroughSeq !== undefined && usage.summaryThroughSeq > usage.throughSeq) {
      context.addIssue({
        code: "custom",
        message: "summaryThroughSeq must not exceed throughSeq",
        path: ["summaryThroughSeq"]
      });
    }
  });

export const CompactContextResultSchema = z.object({
  compacted: z.boolean(),
  usage: RoomContextUsageSchema
}).passthrough();

export const MemoryScopeTypeSchema = z.enum(["room", "agent", "correlation"]);
export const AgentMemoryTypeSchema = z.enum(["core", "dated"]);
export const MemoryKindSchema = z.enum([
  "fact",
  "decision",
  "preference",
  "instruction",
  "constraint",
  "summary",
  "note"
]);
export const WritableMemoryKindSchema = z.enum([
  "fact",
  "decision",
  "preference",
  "instruction",
  "constraint",
  "note"
]);
export const IdentityKindSchema = z.enum(["preference", "instruction", "constraint", "note"]);

export const MemoryScopeSchema = z
  .strictObject({
    type: MemoryScopeTypeSchema,
    id: ReferenceIdSchema
  })
  .superRefine((scope, context) => {
    if (scope.type === "agent" && !AgentActorIdSchema.safeParse(scope.id).success) {
      context.addIssue({
        code: "custom",
        message: "agent memory scopes require an agent actor id",
        path: ["id"]
      });
    }
  });

export const MemoryScopeOutputSchema = z
  .object({
    type: MemoryScopeTypeSchema,
    id: ReferenceIdSchema
  })
  .passthrough();

export const RememberMemoryRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  scope: MemoryScopeSchema,
  kind: WritableMemoryKindSchema,
  content: MessageContentSchema,
  subjectActorId: AgentActorIdSchema.optional(),
  sourceEventId: ReferenceIdSchema.optional()
});

export const SupersedeMemoryRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  kind: WritableMemoryKindSchema.optional(),
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const RetractMemoryRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const RememberIdentityRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  subjectActorId: AgentActorIdSchema,
  kind: IdentityKindSchema,
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const SupersedeIdentityRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  kind: IdentityKindSchema.optional(),
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const RetractIdentityRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const EventsQuerySchema = z.strictObject({
  afterSeq: CursorParameterSchema.optional()
});

export const MemoryQuerySchema = z.strictObject({
  scopeType: MemoryScopeTypeSchema.optional(),
  scopeId: ReferenceIdSchema.optional(),
  agentMemoryType: AgentMemoryTypeSchema.optional(),
  kind: MemoryKindSchema.optional(),
  authorActorId: ActorIdSchema.optional(),
  subjectActorId: AgentActorIdSchema.optional(),
  cursor: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional(),
  includeHistory: z.boolean().optional()
});

export const IdentityQuerySchema = z.strictObject({
  subjectActorId: AgentActorIdSchema.optional(),
  authorActorId: ActorIdSchema.optional(),
  kind: IdentityKindSchema.optional(),
  cursor: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional(),
  includeHistory: z.boolean().optional()
});

export const MemoryRecordSchema = z
  .object({
    memoryId: ReferenceIdSchema,
    scope: MemoryScopeOutputSchema,
    agentMemoryType: AgentMemoryTypeSchema.optional(),
    kind: MemoryKindSchema,
    authorActorId: ActorIdSchema,
    subjectActorId: AgentActorIdSchema.optional(),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
    sourceEventId: ReferenceIdSchema.optional(),
    sourceKind: z.enum([
      "web",
      "mcp",
      "operator",
      "generated_summary",
      "automatic_turn",
      "automatic_rollup"
    ]),
    status: z.enum(["active", "superseded", "retracted"]),
    supersedesMemoryId: ReferenceIdSchema.optional(),
    createdAt: z.string().min(1).max(64),
    retractedAt: z.string().min(1).max(64).optional()
  })
  .passthrough()
  .superRefine((record, context) => {
    if (record.scope.type === "agent" && record.agentMemoryType === undefined) {
      context.addIssue({
        code: "custom",
        message: "Agent memory records require agentMemoryType",
        path: ["agentMemoryType"]
      });
    }
    if (record.scope.type !== "agent" && record.agentMemoryType !== undefined) {
      context.addIssue({
        code: "custom",
        message: "agentMemoryType is only valid for Agent memory",
        path: ["agentMemoryType"]
      });
    }
  });

export const IdentityRecordSchema = z.object({
  identityId: ReferenceIdSchema,
  subjectActorId: AgentActorIdSchema,
  authorActorId: ActorIdSchema,
  kind: IdentityKindSchema,
  content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
  sourceEventId: ReferenceIdSchema.optional(),
  sourceKind: z.enum(["web", "mcp", "adapter", "operator"]),
  status: z.enum(["active", "superseded", "retracted"]),
  supersedesIdentityId: ReferenceIdSchema.optional(),
  createdAt: z.string().min(1).max(64),
  retractedAt: z.string().min(1).max(64).optional()
}).passthrough();

export const RememberMemoryAcceptedSchema = z.object({
  memory: MemoryRecordSchema
}).passthrough();

export const RememberIdentityAcceptedSchema = z.object({
  identity: IdentityRecordSchema
}).passthrough();

export const MemoryPageSchema = z.object({
  items: z.array(MemoryRecordSchema),
  nextCursor: NonNegativeIntegerSchema.optional()
}).passthrough();

export const IdentityPageSchema = z.object({
  items: z.array(IdentityRecordSchema),
  nextCursor: NonNegativeIntegerSchema.optional()
}).passthrough();

export const AgentProjectionSchema = z
  .object({
    actorId: AgentActorIdSchema,
    displayName: z.string().min(1).max(128),
    status: z.string().min(1).max(64),
    instanceId: ReferenceIdSchema.optional(),
    cwd: z.string().min(1).max(32_768).optional(),
    enabled: z.boolean().optional(),
    capabilities: z.json().optional(),
    /** Explicit roster position; presentation only. */
    order: z.number().int().optional()
  })
  .passthrough();

export const TurnProjectionSchema = z
  .object({
    turnId: ReferenceIdSchema,
    targetActorId: AgentActorIdSchema,
    status: z.string().min(1).max(64),
    sourceEventId: ReferenceIdSchema,
    /**
     * Bounded tail of the text this Turn has already produced. It is what a
     * reloaded page can honestly show instead of an empty "running" card;
     * only Active Turns carry it, and the live delta stream supersedes it.
     */
    partialText: z.string().max(2_000).optional(),
    partialTextTruncated: z.boolean().optional()
  })
  .strict();

export const TurnProgressToolSchema = z.strictObject({
  occurredAt: z.string().min(1).max(64),
  nativeType: z.enum(["tool.started", "tool.completed"]),
  toolCallId: z.string().max(200).optional(),
  /** Bounded, already-redacted one-line summary; never the raw payload. */
  summary: z.string().max(400)
});

/**
 * Live progress of one Turn. This is an observation surface, not durable state:
 * it exists so an operator who switched conversations can still see what a
 * running Turn is doing, without persisting token deltas.
 */
export const TurnProgressSchema = z.strictObject({
  turnId: ReferenceIdSchema,
  targetActorId: AgentActorIdSchema,
  status: z.string().min(1).max(64),
  queuedAt: z.string().min(1).max(64),
  startedAt: z.string().min(1).max(64).nullable(),
  elapsedMs: z.number().int().nonnegative(),
  queuePosition: z.number().int().nonnegative().nullable(),
  partialText: z.string().max(2_000),
  partialTextTruncated: z.boolean(),
  reasoning: z.string().max(4_000),
  reasoningTruncated: z.boolean(),
  tools: z.array(TurnProgressToolSchema).max(50),
  errorCode: z.string().max(64).optional()
});

export const BootstrapResponseSchema = z.object({
  schema: z.literal("aichatlink.bootstrap/0.1"),
  room: z.object({
    roomId: ReferenceIdSchema,
    throughSeq: NonNegativeIntegerSchema
  }).passthrough(),
  agents: z.array(AgentProjectionSchema),
  recentEvents: z.array(AIChatLinkEnvelopeSchema),
  activeTurns: z.array(TurnProjectionSchema),
  previousPage: z
    .object({
      beforeSeq: NonNegativeIntegerSchema
    })
    .passthrough()
    .optional()
}).passthrough();

export type SupervisionPair = z.infer<typeof SupervisionPairSchema>;
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;
export type CreateMessageAccepted = z.infer<typeof CreateMessageAcceptedSchema>;
export type CancelTurnRequest = z.infer<typeof CancelTurnRequestSchema>;
export type CancelTurnResult = z.infer<typeof CancelTurnResultSchema>;
export type RestartAgentRequest = z.infer<typeof RestartAgentRequestSchema>;
export type RestartAgentAccepted = z.infer<typeof RestartAgentAcceptedSchema>;
export type RuntimeShutdownRequest = z.infer<typeof RuntimeShutdownRequestSchema>;
export type RuntimeShutdownAccepted = z.infer<typeof RuntimeShutdownAcceptedSchema>;
export type CompactContextRequest = z.infer<typeof CompactContextRequestSchema>;
export type RoomContextUsage = z.infer<typeof RoomContextUsageSchema>;

export const ResetContextRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  resetNativeSessions: z.boolean().optional()
});

export const RoomContextResetResultSchema = z.strictObject({
  reset: z.boolean(),
  throughSeq: z.number().int().nonnegative(),
  resetNativeSessions: z.boolean(),
  usage: RoomContextUsageSchema
});

export type CompactContextResult = z.infer<typeof CompactContextResultSchema>;
export type RememberMemoryRequest = z.infer<typeof RememberMemoryRequestSchema>;
export type SupersedeMemoryRequest = z.infer<typeof SupersedeMemoryRequestSchema>;
export type RetractMemoryRequest = z.infer<typeof RetractMemoryRequestSchema>;
export type RememberIdentityRequest = z.infer<typeof RememberIdentityRequestSchema>;
export type SupersedeIdentityRequest = z.infer<typeof SupersedeIdentityRequestSchema>;
export type RetractIdentityRequest = z.infer<typeof RetractIdentityRequestSchema>;
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
export type IdentityQuery = z.infer<typeof IdentityQuerySchema>;
export type MemoryRecordContract = z.infer<typeof MemoryRecordSchema>;
export type IdentityRecordContract = z.infer<typeof IdentityRecordSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
export type TurnProgress = z.infer<typeof TurnProgressSchema>;

export function parseCreateMessageRequest(
  input: unknown,
  options?: KnownTargetOptions
): CreateMessageRequest {
  const parsed = parseWriteRequest(CreateMessageRequestSchema, input);
  assertKnownTargets(
    [
      ...parsed.to,
      ...(parsed.supervision === undefined ? [] : parsed.supervision.observers)
    ],
    options
  );
  return parsed;
}

export function parseCancelTurnRequest(input: unknown): CancelTurnRequest {
  return parseWriteRequest(CancelTurnRequestSchema, input);
}

export function parseRestartAgentRequest(input: unknown): RestartAgentRequest {
  return parseWriteRequest(RestartAgentRequestSchema, input);
}

export function parseRuntimeShutdownRequest(input: unknown): RuntimeShutdownRequest {
  return parseWriteRequest(RuntimeShutdownRequestSchema, input);
}

export function parseCompactContextRequest(input: unknown): CompactContextRequest {
  return parseWriteRequest(CompactContextRequestSchema, input);
}

export function parseRememberMemoryRequest(
  input: unknown,
  options?: KnownTargetOptions
): RememberMemoryRequest {
  const parsed = parseWriteRequest(RememberMemoryRequestSchema, input);
  const actors = [
    ...(parsed.subjectActorId === undefined ? [] : [parsed.subjectActorId]),
    ...(parsed.scope.type === "agent" ? [parsed.scope.id] : [])
  ];
  if (actors.length > 0) {
    assertKnownTargets(actors, options);
  }
  return parsed;
}

export function parseSupersedeMemoryRequest(input: unknown): SupersedeMemoryRequest {
  return parseWriteRequest(SupersedeMemoryRequestSchema, input);
}

export function parseRetractMemoryRequest(input: unknown): RetractMemoryRequest {
  return parseWriteRequest(RetractMemoryRequestSchema, input);
}

export function parseRememberIdentityRequest(
  input: unknown,
  options?: KnownTargetOptions
): RememberIdentityRequest {
  const parsed = parseWriteRequest(RememberIdentityRequestSchema, input);
  assertKnownTargets([parsed.subjectActorId], options);
  return parsed;
}

export function parseSupersedeIdentityRequest(input: unknown): SupersedeIdentityRequest {
  return parseWriteRequest(SupersedeIdentityRequestSchema, input);
}

export function parseRetractIdentityRequest(input: unknown): RetractIdentityRequest {
  return parseWriteRequest(RetractIdentityRequestSchema, input);
}

export function parseCreateMessageAccepted(input: unknown): CreateMessageAccepted {
  return parseContractOutput(CreateMessageAcceptedSchema, input);
}

export function parseEventsQuery(input: unknown): z.infer<typeof EventsQuerySchema> {
  return parseContractOutput(EventsQuerySchema, input);
}

export function parseMemoryQuery(input: unknown): MemoryQuery {
  return parseContractOutput(MemoryQuerySchema, input);
}

export function parseIdentityQuery(input: unknown): IdentityQuery {
  return parseContractOutput(IdentityQuerySchema, input);
}

export function parseCancelTurnResult(input: unknown): CancelTurnResult {
  return parseContractOutput(CancelTurnResultSchema, input);
}

export function parseRestartAgentAccepted(input: unknown): RestartAgentAccepted {
  return parseContractOutput(RestartAgentAcceptedSchema, input);
}

export function parseRuntimeShutdownAccepted(input: unknown): RuntimeShutdownAccepted {
  return parseContractOutput(RuntimeShutdownAcceptedSchema, input);
}

export function parseRoomContextUsage(input: unknown): RoomContextUsage {
  return parseContractOutput(RoomContextUsageSchema, input);
}

export function parseCompactContextResult(input: unknown): CompactContextResult {
  return parseContractOutput(CompactContextResultSchema, input);
}

export function parseRememberMemoryAccepted(
  input: unknown
): z.infer<typeof RememberMemoryAcceptedSchema> {
  return parseContractOutput(RememberMemoryAcceptedSchema, input);
}

export function parseRememberIdentityAccepted(
  input: unknown
): z.infer<typeof RememberIdentityAcceptedSchema> {
  return parseContractOutput(RememberIdentityAcceptedSchema, input);
}

export function parseMemoryPage(input: unknown): z.infer<typeof MemoryPageSchema> {
  return parseContractOutput(MemoryPageSchema, input);
}

export function parseIdentityPage(input: unknown): z.infer<typeof IdentityPageSchema> {
  return parseContractOutput(IdentityPageSchema, input);
}

export function parseTurnProgress(input: unknown): TurnProgress {
  return parseContractOutput(TurnProgressSchema, input);
}

export function parseBootstrapResponse(input: unknown): BootstrapResponse {
  return parseContractOutput(BootstrapResponseSchema, input);
}
