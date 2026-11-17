import { GrokAcpAdapter, HermesAcpAdapter, KimiAcpAdapter } from "../adapters/acp/index.js";
import { ClaudeCliAdapter } from "../adapters/claude/index.js";
import { CodexAppServerAdapter } from "../adapters/codex/index.js";
import { PiRpcAdapter } from "../adapters/pi/index.js";
import { WorkBuddyCliAdapter } from "../adapters/workbuddy/index.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { CliAdapter } from "../adapters/types.js";
import {
  assertActiveTransport,
  type AIChatLinkConfig
} from "../config.js";
import type { AgentDriver } from "../launch/command-spec.js";

export function createStructuredAgentAdapter(
  agentId: string,
  driver: AgentDriver,
  timeouts: AIChatLinkConfig["timeouts"],
  piConfig?: AIChatLinkConfig["agents"][string]["piConfig"]
): CliAdapter {
  const acpOptions = {
    handshakeTimeoutMs: timeouts.handshakeMs,
    closeGraceMs: timeouts.closeMs,
    killGraceMs: timeouts.closeMs,
    agentId
  };
  switch (driver) {
    case "codex":
      return new CodexAppServerAdapter({ timeouts, agentId });
    case "grok":
      return new GrokAcpAdapter(acpOptions);
    case "claude":
      return new ClaudeCliAdapter({ timeouts, agentId });
    case "workbuddy":
      return new WorkBuddyCliAdapter({ timeouts, agentId });
    case "pi":
      return new PiRpcAdapter({
        timeouts,
        agentId,
        ...(piConfig === undefined ? {} : { configMode: piConfig })
      });
    case "kimi":
    case "hermes":
      // Legacy drivers remain loadable for existing aichatlink.json files.
      return new (driver === "kimi" ? KimiAcpAdapter : HermesAcpAdapter)(acpOptions);
  }
}

/** Build one adapter per enabled configured agent in the single globally selected transport. */
export function createAdapterRegistry(
  config: Pick<AIChatLinkConfig, "transport" | "agents" | "timeouts">
): AdapterRegistry {
  // Direct is intentionally not wired here. Its implementation remains only
  // for historical compatibility tests; do not restore a runtime entry.
  assertActiveTransport(config.transport);
  const registry = new AdapterRegistry();
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (!agent.enabled) continue;
    registry.register(
      createStructuredAgentAdapter(agentId, agent.driver, config.timeouts, agent.piConfig)
    );
  }
  return registry;
}
