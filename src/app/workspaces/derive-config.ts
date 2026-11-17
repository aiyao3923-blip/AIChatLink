import path from "node:path";

import type { AIChatLinkConfig } from "../../config.js";
import type { CanonicalWorkspacePath } from "./registry.js";

/** Windows paths are case-insensitive; POSIX paths are not. */
export function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const slashed = path.normalize(value).split(path.sep).join("/");
    return slashed.length > 1 && slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
  };
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sharedAgentCwd(config: AIChatLinkConfig): string | undefined {
  const values = Object.values(config.agents).map((agent) => agent.cwd);
  const first = values[0];
  if (first === undefined) return undefined;
  return values.every((value) => sameDirectory(value, first)) ? first : undefined;
}

/** The directory the primary room treats as "the workspace" (D-036). */
export function primaryWorkspacePath(config: AIChatLinkConfig): string | undefined {
  return config.workspace ?? sharedAgentCwd(config);
}

export function workspaceDataDirectory(dataRoot: string, workspaceId: string): string {
  return path.join(dataRoot, "workspaces", workspaceId);
}

/**
 * Build one workspace's runtime config from the primary config. Agents and the
 * assistant that followed the primary directory follow the new one; explicit
 * per-Agent overrides are preserved (D-036). The input config is never mutated.
 */
export function deriveWorkspaceConfig(
  primary: AIChatLinkConfig,
  workspace: CanonicalWorkspacePath,
  dataRoot: string
): AIChatLinkConfig {
  const primaryWorkspace = primaryWorkspacePath(primary);
  const follow = (cwd: string): string =>
    primaryWorkspace !== undefined && sameDirectory(cwd, primaryWorkspace)
      ? workspace.path
      : cwd;
  const agents = Object.fromEntries(
    Object.entries(primary.agents).map(([agentId, agent]) => [
      agentId,
      { ...agent, cwd: follow(agent.cwd) }
    ])
  );
  const assistant =
    primary.assistant === undefined
      ? undefined
      : {
          ...primary.assistant,
          brain: { ...primary.assistant.brain, cwd: follow(primary.assistant.brain.cwd) }
        };
  return {
    ...primary,
    workspace: workspace.path,
    storage: {
      path: path.join(workspaceDataDirectory(dataRoot, workspace.workspaceId), "aichatlink.db")
    },
    agents,
    ...(assistant === undefined ? {} : { assistant })
  };
}
