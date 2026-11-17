import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  parseWorkspaceListing,
  parseWorkspaceRevealResponse,
  type WorkspaceDirectory,
  type WorkspaceListing,
  type WorkspaceRevealResponse
} from "../../contracts/index.js";
import { AIChatLinkError } from "../../core/errors.js";
import type { SetupWorkspaceApi } from "../server/types.js";

const MAX_ENTRIES = 4_096;
const LISTING_TIMEOUT_MS = 5_000;

/** Injected so unit tests never touch the real desktop. */
export interface WorkspaceDependencies {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly cwd: string;
  readonly pathApi?: Pick<typeof path, "resolve" | "dirname" | "join" | "parse">;
  reveal(directory: string): void;
}

export const systemWorkspaceDependencies: WorkspaceDependencies = {
  platform: process.platform,
  home: homedir(),
  cwd: process.cwd(),
  reveal: (directory) => {
    const command =
      process.platform === "win32"
        ? { executable: "explorer.exe", args: [directory] }
        : process.platform === "darwin"
          ? { executable: "open", args: [directory] }
          : { executable: "xdg-open", args: [directory] };
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  }
};

const RESERVED_NAMES = new Set([
  "node_modules",
  "__pycache__",
  "$recycle.bin",
  "system volume information"
]);

function pathApiOf(
  dependencies: WorkspaceDependencies
): Pick<typeof path, "resolve" | "dirname" | "join" | "parse"> {
  return (
    dependencies.pathApi ?? {
      resolve: path.resolve,
      dirname: path.dirname,
      join: path.join,
      parse: path.parse
    }
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function directoryEntry(
  directory: string,
  dependencies: WorkspaceDependencies
): Promise<WorkspaceDirectory | undefined> {
  const api = pathApiOf(dependencies);
  if (!(await exists(directory))) return undefined;
  return {
    name: api.parse(directory).base || directory,
    path: directory,
    isRepository: await exists(api.join(directory, ".git"))
  };
}

async function shortcuts(dependencies: WorkspaceDependencies): Promise<WorkspaceDirectory[]> {
  const api = pathApiOf(dependencies);
  // Probe only real anchors: scanning every drive letter can stall on stale
  // network mappings, so we never do it.
  const candidates: string[] = [dependencies.home];
  const desktop = api.join(dependencies.home, "Desktop");
  if (await exists(desktop)) candidates.push(desktop);
  candidates.push(api.parse(dependencies.cwd).root, api.parse(dependencies.home).root);
  if (dependencies.platform !== "win32") candidates.push("/");
  const seen = new Set<string>();
  const result: WorkspaceDirectory[] = [];
  for (const candidate of candidates.map((value) => api.resolve(value))) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const entry = await directoryEntry(candidate, dependencies);
    if (entry !== undefined) result.push(entry);
    if (result.length >= 32) break;
  }
  return result;
}

function withTimeout<T>(operation: Promise<T>, dependencies: WorkspaceDependencies): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AIChatLinkError("INVALID_ENVELOPE", "directory listing timed out"));
    }, LISTING_TIMEOUT_MS);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
    void dependencies;
  });
}

/**
 * List child directories of one folder. Entries are directories only, and
 * hidden/system-ish folders are skipped so the picker stays usable.
 */
export async function listWorkspaceDirectories(
  requested: string | undefined,
  dependencies: WorkspaceDependencies = systemWorkspaceDependencies
): Promise<WorkspaceListing> {
  const api = pathApiOf(dependencies);
  const target = api.resolve(
    requested === undefined || requested.trim() === "" ? dependencies.cwd : requested
  );
  if (!path.isAbsolute(target)) {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace path must be absolute");
  }
  if (!(await isDirectory(target))) {
    throw new AIChatLinkError("INVALID_ENVELOPE", `Workspace path is not a readable directory: ${target}`);
  }
  let dirents;
  try {
    dirents = await withTimeout(readdir(target, { withFileTypes: true }), dependencies);
  } catch (error) {
    if (error instanceof AIChatLinkError) throw error;
    throw new AIChatLinkError("INVALID_ENVELOPE", `Workspace directory cannot be read: ${target}`);
  }
  const entries: WorkspaceDirectory[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (name.startsWith(".")) continue;
    if (RESERVED_NAMES.has(name.toLowerCase())) continue;
    const child = api.join(target, name);
    const isDirectoryEntry =
      dirent.isDirectory() || (dirent.isSymbolicLink() && (await isDirectory(child)));
    if (!isDirectoryEntry) continue;
    entries.push({
      name,
      path: child,
      isRepository: await exists(api.join(child, ".git"))
    });
  }
  entries.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
  );
  const truncated = entries.length > MAX_ENTRIES;
  const parent = api.dirname(target);
  return parseWorkspaceListing({
    path: target,
    parent: parent === target ? null : parent,
    shortcuts: await shortcuts(dependencies),
    entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
    truncated
  });
}

/** Reveal one directory in the platform file manager. Never blocks the request. */
export async function revealWorkspaceDirectory(
  requested: string,
  dependencies: WorkspaceDependencies = systemWorkspaceDependencies
): Promise<WorkspaceRevealResponse> {
  const api = pathApiOf(dependencies);
  const target = api.resolve(requested);
  if (!path.isAbsolute(target) || !(await isDirectory(target))) {
    throw new AIChatLinkError("INVALID_ENVELOPE", `Workspace path is not a directory: ${target}`);
  }
  try {
    dependencies.reveal(target);
  } catch {
    throw new AIChatLinkError("SESSION_NOT_AVAILABLE", "Unable to open the system file manager");
  }
  return parseWorkspaceRevealResponse({ opened: true, path: target });
}

/** Runtime adapter used by both the setup server and the room server. */
export function createSetupWorkspaceApi(
  dependencies: WorkspaceDependencies = systemWorkspaceDependencies
): SetupWorkspaceApi {
  return {
    list: (requested, signal) => {
      signal.throwIfAborted();
      return listWorkspaceDirectories(requested, dependencies);
    },
    reveal: (requested, signal) => {
      signal.throwIfAborted();
      return revealWorkspaceDirectory(requested, dependencies);
    }
  };
}
