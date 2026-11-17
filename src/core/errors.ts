export const AICHATLINK_ERROR_CODES = [
  "ADAPTER_NOT_FOUND",
  "ADAPTER_START_FAILED",
  "PROTOCOL_HANDSHAKE_TIMEOUT",
  "PROTOCOL_INVALID_MESSAGE",
  "SESSION_NOT_AVAILABLE",
  "NATIVE_RESUME_UNSUPPORTED",
  "MCP_UNAVAILABLE",
  "TURN_FIRST_EVENT_TIMEOUT",
  "TURN_IDLE_TIMEOUT",
  "TURN_CANCEL_TIMEOUT",
  "TURN_INTERRUPTED",
  "UNEXPECTED_NATIVE_INTERACTION",
  "NATIVE_POLICY_BLOCKED",
  "MCP_BINDING_MISMATCH",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_READY",
  "STORE_UNAVAILABLE",
  "STORE_CONFLICT",
  "CLIENT_COMMAND_CONFLICT",
  "TRANSPORT_MODE_MISMATCH",
  "CONTEXT_BUDGET_EXCEEDED",
  "INVALID_ENVELOPE",
  "UNKNOWN_ACTOR",
  "UNKNOWN_TARGET",
  "SENDER_FIELD_FORBIDDEN",
  "DUPLICATE_DISPATCH",
  "CAUSAL_CYCLE",
  "ROOT_TURN_LIMIT_REACHED",
  "HOP_LIMIT_REACHED",
  "QUEUE_CAPACITY_REACHED",
  "MESSAGE_TOO_LARGE",
  "ASK_TIMEOUT",
  "STEER_LIMIT_REACHED",
  "SUPERVISION_WATCH_REQUIRED",
  "SUPERVISION_STEER_REQUIRED",
  "SUPERVISION_PAIR_INVALID"
] as const;

export type AIChatLinkErrorCode = (typeof AICHATLINK_ERROR_CODES)[number];

export class AIChatLinkError extends Error {
  readonly code: AIChatLinkErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: AIChatLinkErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AIChatLinkError";
    this.code = code;
    this.details = details;
  }
}

export function toAIChatLinkError(error: unknown, fallback: AIChatLinkErrorCode = "STORE_UNAVAILABLE"): AIChatLinkError {
  if (error instanceof AIChatLinkError) {
    return error;
  }
  if (error instanceof Error) {
    return new AIChatLinkError(fallback, error.message, undefined, { cause: error });
  }
  return new AIChatLinkError(fallback, String(error));
}
