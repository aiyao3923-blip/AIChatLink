import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AIChatLinkError } from "../../core/errors.js";

export const WORKSPACE_REGISTRY_VERSION = 1 as const;
export const MAX_WORKSPACES = 8;
const MAX_REGISTRY_ENTRIES = 32;
const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{12}$/u;

export interface WorkspaceRegistryEntry {
  /** Real absolute directory path, preserving the user's casing for display. */
  readonly path: string;
  readonly label: string;
  readonly addedAt: string;
}

export interface WorkspaceRegistryDocument {
  readonly version: typeof WORKSPACE_REGISTRY_VERSION;
  readonly workspaces: readonly WorkspaceRegistryEntry[];
}

export interface CanonicalWorkspacePath {
  /** Real absolute path used for display and for the runtime config. */
  readonly path: string;
  /** Stable id derived from the case-folded real path. */
  readonly workspaceId: string;
}

export function workspaceRegistryPath(primaryStorePath: string): string {
  return path.join(path.dirname(path.resolve(primaryStorePath)), "workspaces.json");
}

/** Windows paths are case-insensitive; the hash must not fork on casing. */
function hashMaterial(realPath: string): string {
  const normalized = path.normalize(realPath).split(path.sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function workspaceIdForCanonicalPath(realPath: string): string {
  const digest = createHash("sha256").update(hashMaterial(realPath), "utf8").digest("hex");
  return `ws_${digest.slice(0, 12)}`;
}

/**
 * Resolve a directory the operator picked, then derive the stable workspace id.
 * The id is a path hash so re-adding the same folder reattaches its database
 * instead of creating a second runtime over the same files.
 */
export async function canonicalizeWorkspacePath(input: string): Promise<CanonicalWorkspacePath> {
  const requested = input.trim();
  if (requested.length === 0) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace path must not be empty");
  }
  const resolved = path.resolve(requested);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new AIChatLinkError(
      "INVALID_ENVELOPE",
      `Workspace path does not exist: ${resolved}`,
      undefined,
      { cause: error }
    );
  }
  if (!info.isDirectory()) {
    throw new AIChatLinkError("INVALID_ENVELOPE", `Workspace path is not a directory: ${resolved}`);
  }
  const realPath = path.normalize(await realpath(resolved).catch(() => resolved));
  return { path: realPath, workspaceId: workspaceIdForCanonicalPath(realPath) };
}

function defaultLabel(realPath: string): string {
  const label = path.basename(realPath);
  return label.length > 0 ? label : realPath;
}

function parseRegistryEntry(value: unknown): WorkspaceRegistryEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const rawPath = candidate.path;
  const label = candidate.label;
  const addedAt = candidate.addedAt;
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.length > 4_096) {
    return undefined;
  }
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 120) {
    return undefined;
  }
  if (typeof addedAt !== "string" || Number.isNaN(Date.parse(addedAt))) {
    return undefined;
  }
  return {
    path: path.normalize(rawPath),
    label: label.trim(),
    addedAt
  };
}

export function emptyWorkspaceRegistry(): WorkspaceRegistryDocument {
  return { version: WORKSPACE_REGISTRY_VERSION, workspaces: [] };
}

/** Missing file means "no added workspaces"; malformed content fails closed. */
export async function readWorkspaceRegistry(
  registryPath: string
): Promise<WorkspaceRegistryDocument> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWorkspaceRegistry();
    throw new AIChatLinkError("STORE_UNAVAILABLE", "Unable to read the workspace registry", undefined, {
      cause: error
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace registry is not valid JSON", undefined, {
      cause: error
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace registry must be an object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== WORKSPACE_REGISTRY_VERSION) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace registry version is not supported");
  }
  if (!Array.isArray(candidate.workspaces)) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace registry is missing its workspaces array");
  }
  if (candidate.workspaces.length > MAX_REGISTRY_ENTRIES) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace registry has too many entries");
  }
  const seen = new Set<string>();
  const workspaces: WorkspaceRegistryEntry[] = [];
  for (const value of candidate.workspaces) {
    const entry = parseRegistryEntry(value);
    if (entry === undefined) {
      throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace registry contains an invalid entry");
    }
    const workspaceId = workspaceIdForCanonicalPath(entry.path);
    if (seen.has(workspaceId)) continue;
    seen.add(workspaceId);
    workspaces.push(entry);
  }
  return { version: WORKSPACE_REGISTRY_VERSION, workspaces };
}

/** Atomic tmp+rename so a crash never leaves a half-written registry. */
export async function writeWorkspaceRegistry(
  registryPath: string,
  document: WorkspaceRegistryDocument
): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const tmp = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    version: WORKSPACE_REGISTRY_VERSION,
    workspaces: document.workspaces.map((entry) => ({
      path: entry.path,
      label: entry.label,
      addedAt: entry.addedAt
    }))
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, registryPath);
}

export function createWorkspaceRegistryEntry(
  canonical: CanonicalWorkspacePath,
  options: { label?: string; addedAt?: string } = {}
): WorkspaceRegistryEntry {
  return {
    path: canonical.path,
    label: options.label?.trim() || defaultLabel(canonical.path),
    addedAt: options.addedAt ?? new Date().toISOString()
  };
}

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value);
}
