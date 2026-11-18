export interface PendingConfiguredAgent {
  actorId: string;
  displayName: string;
  status: "pending_restart";
  driver: string;
  cwd: string;
  enabled: true;
  capabilities: string[];
  order?: number;
}

type JsonRecord = Record<string, unknown>;

/** Mirrors the contracts roster id rule; the browser bundle imports no contracts. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;

interface ConfiguredAgentEntry {
  actorId: string;
  displayName: string;
  driver: string;
  cwd: string;
  enabled: boolean;
  order?: number;
}

/** One field of a roster item the order rule needs; both projections satisfy it. */
export interface RosterOrderable {
  actorId: string;
  order?: number;
}

/**
 * Roster order: the explicit `order` an operator saved in `aichatlink.json`
 * wins; anything without one keeps the historical actorId order and sits after
 * the ordered entries. Ordering is presentation only — dispatch, `@all` and the
 * ask tool never depend on it.
 */
export function compareRosterOrder(left: RosterOrderable, right: RosterOrderable): number {
  const leftOrdered = typeof left.order === "number" && Number.isFinite(left.order);
  const rightOrdered = typeof right.order === "number" && Number.isFinite(right.order);
  if (leftOrdered && rightOrdered && left.order !== right.order) {
    return (left.order as number) - (right.order as number);
  }
  if (leftOrdered !== rightOrdered) {
    return leftOrdered ? -1 : 1;
  }
  return left.actorId.localeCompare(right.actorId);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredAgents(snapshot: unknown): unknown[] {
  if (!isRecord(snapshot) || !isRecord(snapshot.config) || !Array.isArray(snapshot.config.agents)) {
    return [];
  }
  return snapshot.config.agents;
}

function readConfiguredAgent(
  value: unknown,
  workspace: string
): ConfiguredAgentEntry | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const id = value.id.trim();
  if (!AGENT_ID_PATTERN.test(id)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  // An omitted cwd follows the room workspace; show the effective directory.
  const cwd = typeof value.cwd === "string" && value.cwd.trim().length > 0;
  const directory = typeof value.cwd === "string" ? value.cwd.trim() : workspace;
  const driver = typeof value.driver === "string" ? value.driver.trim() : "";
  const order =
    typeof value.order === "number" && Number.isFinite(value.order) ? value.order : undefined;
  return {
    actorId: `agent:${id}`,
    displayName: name || id,
    driver,
    cwd: cwd || directory.length === 0 ? directory : workspace,
    enabled: value.enabled === true,
    ...(order === undefined ? {} : { order })
  };
}

/**
 * Projects enabled agents saved after runtime startup without pretending their
 * native session is already available. The active bootstrap roster remains
 * authoritative for every actor it contains.
 */
export function pendingConfiguredAgents(
  snapshot: unknown,
  activeActorIds: ReadonlySet<string>
): PendingConfiguredAgent[] {
  const pending = new Map<string, PendingConfiguredAgent>();
  const workspace =
    isRecord(snapshot) && typeof snapshot.workspaceResolved === "string"
      ? snapshot.workspaceResolved.trim()
      : isRecord(snapshot) && isRecord(snapshot.config) && typeof snapshot.config.workspace === "string"
        ? snapshot.config.workspace.trim()
        : "";
  for (const value of configuredAgents(snapshot)) {
    const entry = readConfiguredAgent(value, workspace);
    if (!entry || !entry.enabled || activeActorIds.has(entry.actorId)) continue;
    pending.set(entry.actorId, {
      actorId: entry.actorId,
      displayName: entry.displayName,
      status: "pending_restart",
      driver: entry.driver,
      cwd: entry.cwd,
      enabled: true,
      capabilities: [],
      ...(entry.order === undefined ? {} : { order: entry.order })
    });
  }
  return [...pending.values()].sort(compareRosterOrder);
}

/**
 * Actor ids the running runtime still holds although the saved roster no longer
 * enables them (disabled or removed). Saving `/setup` only rewrites
 * `aichatlink.json`, so those native sessions stay alive until AIChatLink restarts; the
 * room must stop presenting them as available targets in the meantime.
 *
 * Returns `undefined` when the snapshot cannot answer the question — setup is not
 * served, the saved file is missing or unparsable, or the roster is malformed —
 * so an unknown roster never disables a live agent.
 */
export function disabledConfiguredActorIds(
  snapshot: unknown,
  liveActorIds: Iterable<string>
): ReadonlySet<string> | undefined {
  if (!isRecord(snapshot) || snapshot.existing !== true || snapshot.existingConfigError !== undefined) {
    return undefined;
  }
  const entries = configuredAgents(snapshot).map((value) => readConfiguredAgent(value, ""));
  if (entries.length === 0) return undefined;
  const enabledActorIds = new Set<string>();
  for (const entry of entries) {
    if (entry?.enabled === true) enabledActorIds.add(entry.actorId);
  }
  const disabled = new Set<string>();
  for (const actorId of liveActorIds) {
    if (!enabledActorIds.has(actorId)) disabled.add(actorId);
  }
  return disabled;
}
