/**
 * Per-agent model/thinking selection shared by the config schema, the setup
 * contract and the setup page. Values travel to the native CLI as argv/thread
 * config (or to the pi shim); they are never written into a user's global CLI
 * configuration file.
 */
export const AGENT_THINKING_LEVELS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
] as const;

export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export function isAgentThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === "string" && (AGENT_THINKING_LEVELS as readonly string[]).includes(value);
}
