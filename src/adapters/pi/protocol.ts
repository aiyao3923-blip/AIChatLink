import { isAbsolute } from "node:path";

import { AIChatLinkError } from "../../core/errors.js";
import type { McpBindingLaunchSpec, NativeEvent } from "../types.js";

/**
 * pi's first-party structured stdio surface is RPC mode: one JSONL record per
 * line on stdin/stdout with `{type}` commands, `{type:"response"}` replies and
 * a session event stream. It is not ACP and not Claude stream-json.
 */
export const PI_PROTOCOL = "pi-rpc-jsonl-v1";
export const PI_MCP_SERVER_NAME = "aichatlink";
export const PI_MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;

/** pi's documented thinking levels. `off` is its "no reasoning" value. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface PiLaunchOptions {
  /** Exact native session id. pi creates it when missing and resumes it when present. */
  sessionId: string;
  /** Provider id, only when the configured model is written as `provider/model`. */
  provider?: string | undefined;
  /** Native model id. */
  model?: string | undefined;
  /** Already normalized to a pi level. */
  thinking?: string | undefined;
}

export interface PiModelSelection {
  provider: string | undefined;
  model: string | undefined;
}

/**
 * The setup page and the legacy pi shim store a model as `provider/model`.
 * Only split when the prefix is a provider pi actually knows; otherwise an
 * OpenRouter-style `anthropic/claude-...` id would be misread as a provider.
 */
export function splitPiModel(
  model: string | undefined,
  knownProviders: ReadonlySet<string>
): PiModelSelection {
  if (model === undefined) return { provider: undefined, model: undefined };
  const trimmed = model.trim();
  if (trimmed.length === 0) return { provider: undefined, model: undefined };
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    if (knownProviders.has(prefix)) {
      return { provider: prefix, model: trimmed.slice(slash + 1) };
    }
  }
  return { provider: undefined, model: trimmed };
}

/** Map AIChatLink's wider vocabulary onto pi's documented levels. */
export function piThinkingLevel(level: string | undefined): string | undefined {
  if (level === undefined) return undefined;
  const normalized = level.trim().toLowerCase();
  if (normalized === "none") return "off";
  if (normalized === "ultra") return "max";
  return (PI_THINKING_LEVELS as readonly string[]).includes(normalized) ? normalized : undefined;
}

/**
 * Fixed argv for `pi --mode rpc`. No shell, no user settings file mutation:
 * isolation is supplied by `PI_CODING_AGENT_DIR` from the launch environment.
 */
export function buildPiLaunchArgv(
  command: string,
  prefixArgs: readonly string[] = [],
  options: PiLaunchOptions
): readonly [string, ...string[]] {
  if (command.length === 0) throw new TypeError("pi command must be non-empty");
  if (options.sessionId.length === 0) throw new TypeError("pi sessionId must be non-empty");

  const argv: string[] = [...prefixArgs, "--mode", "rpc", "--session-id", options.sessionId];
  if (options.provider !== undefined && options.provider.length > 0) {
    argv.push("--provider", options.provider);
  }
  if (options.model !== undefined && options.model.length > 0) {
    argv.push("--model", options.model);
  }
  if (options.thinking !== undefined) {
    argv.push("--thinking", options.thinking);
  }
  return [command, ...argv];
}

export type PiMcpServer =
  | {
      type: "http";
      url: string;
      headers: Record<string, string>;
      exposure: "direct";
    }
  | {
      type: "stdio";
      command: string;
      args: string[];
      exposure: "direct";
    };

export interface PiMcpConfig {
  mcpServers: Record<typeof PI_MCP_SERVER_NAME, PiMcpServer>;
}

/**
 * Build the one AIChatLink-owned MCP entry. `exposure: "direct"` is required:
 * the default `codemode` exposure would hide `send`/`ask`/`read` behind a
 * script tool, and the room's routing contract expects direct calls.
 */
export function buildPiMcpConfig(
  mcp: McpBindingLaunchSpec | undefined,
  bindingId: string | undefined
): PiMcpConfig | undefined {
  if (mcp === undefined) return undefined;
  if (bindingId === undefined || bindingId.length === 0) {
    throw new AIChatLinkError(
      "MCP_BINDING_MISMATCH",
      "MCP-enabled pi sessions require a Broker-preassigned bindingId"
    );
  }
  if (mcp.transport === "stdio") {
    if (!isAbsolute(mcp.command)) {
      throw new TypeError("Invalid AIChatLink MCP stdio launch specification");
    }
    if (mcp.args.some((argument) => argument === "--binding" || argument.startsWith("--binding="))) {
      throw new AIChatLinkError(
        "MCP_BINDING_MISMATCH",
        "AIChatLink MCP stdio binding is assigned by the Adapter and must not be supplied in mcp.args"
      );
    }
    return {
      mcpServers: {
        [PI_MCP_SERVER_NAME]: {
          type: "stdio",
          command: mcp.command,
          args: [...mcp.args, "--binding", bindingId],
          exposure: "direct"
        }
      }
    };
  }
  if (mcp.url.length === 0) {
    throw new TypeError("Invalid AIChatLink MCP HTTP URL");
  }
  return {
    mcpServers: {
      [PI_MCP_SERVER_NAME]: {
        type: "http",
        url: mcp.url,
        headers: { "X-AIChatLink-Binding": bindingId },
        exposure: "direct"
      }
    }
  };
}

export interface PiGetState {
  sessionId: string;
  messageCount: number | undefined;
  isStreaming: boolean | undefined;
  model: { provider?: string; id?: string } | undefined;
}

export interface PiResponseRecord {
  id: string | undefined;
  command: string;
  success: boolean;
  data: Record<string, unknown> | undefined;
  error: string | undefined;
}

export function parsePiResponse(value: Record<string, unknown>): PiResponseRecord | undefined {
  if (value.type !== "response") return undefined;
  if (typeof value.command !== "string" || typeof value.success !== "boolean") return undefined;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    command: value.command,
    success: value.success,
    data: isRecord(value.data) ? value.data : undefined,
    error: typeof value.error === "string" ? value.error : undefined
  };
}

export function parsePiGetState(data: Record<string, unknown> | undefined): PiGetState {
  const sessionId = data !== undefined && typeof data.sessionId === "string" ? data.sessionId : undefined;
  if (sessionId === undefined) {
    throw new AIChatLinkError("PROTOCOL_INVALID_MESSAGE", "pi get_state response is missing sessionId");
  }
  return {
    sessionId,
    messageCount: typeof data?.messageCount === "number" ? data.messageCount : undefined,
    isStreaming: typeof data?.isStreaming === "boolean" ? data.isStreaming : undefined,
    model: isRecord(data?.model)
      ? {
          ...(typeof data.model.provider === "string" ? { provider: data.model.provider } : {}),
          ...(typeof data.model.id === "string" ? { id: data.model.id } : {})
        }
      : undefined
  };
}

export interface PiStreamProjection {
  type: Extract<NativeEvent["type"], "content.delta" | "reasoning.delta" | "tool.started">;
  payload: Record<string, unknown>;
}

/** Text/thinking deltas and tool-call starts from `message_update`. */
export function projectPiMessageUpdate(value: Record<string, unknown>): PiStreamProjection | undefined {
  if (!isRecord(value.assistantMessageEvent)) return undefined;
  const event = value.assistantMessageEvent;
  if (event.type === "text_delta" && typeof event.delta === "string") {
    return { type: "content.delta", payload: { text: event.delta } };
  }
  if (event.type === "thinking_delta" && typeof event.delta === "string") {
    return { type: "reasoning.delta", payload: { text: event.delta } };
  }
  return undefined;
}

export interface PiToolStart {
  toolCallId: string;
  toolName: string | undefined;
  args: unknown;
}

export function parsePiToolStart(value: Record<string, unknown>): PiToolStart | undefined {
  if (value.type !== "tool_execution_start") return undefined;
  if (typeof value.toolCallId !== "string" || value.toolCallId.length === 0) return undefined;
  return {
    toolCallId: value.toolCallId,
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    args: value.args
  };
}

export interface PiToolEnd {
  toolCallId: string;
  toolName: string | undefined;
  isError: boolean;
}

export function parsePiToolEnd(value: Record<string, unknown>): PiToolEnd | undefined {
  if (value.type !== "tool_execution_end") return undefined;
  if (typeof value.toolCallId !== "string" || value.toolCallId.length === 0) return undefined;
  return {
    toolCallId: value.toolCallId,
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    isError: value.isError === true
  };
}

export interface PiAssistantMessage {
  stopReason: string | undefined;
  errorMessage: string | undefined;
  usage: unknown;
  text: string;
  thinking: string;
}

/** Projection of the authoritative `message_end` assistant message. */
export function parsePiAssistantMessage(value: Record<string, unknown>): PiAssistantMessage | undefined {
  if (value.type !== "message_end" || !isRecord(value.message)) return undefined;
  const message = value.message;
  if (message.role !== "assistant") return undefined;
  const text: string[] = [];
  const thinking: string[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") text.push(block.text);
      else if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
    }
  }
  return {
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    usage: message.usage,
    text: text.join(""),
    thinking: thinking.join("")
  };
}

export type PiTerminalKind = "completed" | "cancelled" | "failed";

/** `agent_settled` is the only authoritative terminal; `agent_end` may still retry. */
export function classifyPiSettle(
  lastAssistant: PiAssistantMessage | undefined,
  cancelRequested: boolean
): PiTerminalKind {
  if (cancelRequested) return "cancelled";
  if (lastAssistant?.stopReason === "aborted") return "cancelled";
  if (lastAssistant?.stopReason === "error") return "failed";
  return "completed";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
