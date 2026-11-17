import { createHash } from "node:crypto";

export const AICHATLINK_RUNTIME_SERVICE = "aichatlink" as const;
export const AICHATLINK_RUNTIME_PROTOCOL = "aichatlink.runtime/1" as const;

export interface AIChatLinkRuntimeIdentity {
  readonly service: typeof AICHATLINK_RUNTIME_SERVICE;
  readonly protocol: typeof AICHATLINK_RUNTIME_PROTOCOL;
  readonly runtimeKey: string;
  /**
   * Stable for one canonical config path even when the config contents change.
   * This is a local correlation handle for controlled restart, not a secret.
   */
  readonly runtimeScopeKey?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

function materialHash(material: unknown): string {
  const canonical = JSON.stringify(canonicalize(material));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Create a non-secret, deterministic identity for one concrete runtime configuration. */
export function createAIChatLinkRuntimeIdentity(
  material: unknown,
  runtimeScopeMaterial: unknown = material
): AIChatLinkRuntimeIdentity {
  return {
    service: AICHATLINK_RUNTIME_SERVICE,
    protocol: AICHATLINK_RUNTIME_PROTOCOL,
    runtimeKey: materialHash(material),
    runtimeScopeKey: materialHash(runtimeScopeMaterial)
  };
}

export function parseAIChatLinkRuntimeIdentity(input: unknown): AIChatLinkRuntimeIdentity | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const candidate = input as Record<string, unknown>;
  if (
    candidate.service !== AICHATLINK_RUNTIME_SERVICE ||
    candidate.protocol !== AICHATLINK_RUNTIME_PROTOCOL ||
    typeof candidate.runtimeKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.runtimeKey)
  ) {
    return undefined;
  }
  const runtimeScopeKey = candidate.runtimeScopeKey;
  if (
    runtimeScopeKey !== undefined &&
    (typeof runtimeScopeKey !== "string" || !/^[a-f0-9]{64}$/u.test(runtimeScopeKey))
  ) {
    return undefined;
  }
  return {
    service: AICHATLINK_RUNTIME_SERVICE,
    protocol: AICHATLINK_RUNTIME_PROTOCOL,
    runtimeKey: candidate.runtimeKey,
    ...(runtimeScopeKey === undefined ? {} : { runtimeScopeKey })
  };
}
