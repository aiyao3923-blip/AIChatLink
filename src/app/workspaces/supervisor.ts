import { realpathSync } from "node:fs";
import path from "node:path";

import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  RemoveWorkspaceResponse,
  RestartWorkspaceResponse,
  WorkspaceList,
  WorkspaceSummary
} from "../../contracts/index.js";
import type { AIChatLinkConfig } from "../../config.js";
import { AIChatLinkError, toAIChatLinkError } from "../../core/errors.js";
import type {
  WorkspaceHubApi,
  WorkspaceRouteTarget,
  WorkspaceRouting
} from "../../web/server/types.js";
import { startAIChatLinkRuntime } from "../runtime.js";
import { deriveWorkspaceConfig, primaryWorkspacePath, workspaceDataDirectory } from "./derive-config.js";
import {
  canonicalizeWorkspacePath,
  createWorkspaceRegistryEntry,
  MAX_WORKSPACES,
  readWorkspaceRegistry,
  workspaceIdForCanonicalPath,
  workspaceRegistryPath,
  writeWorkspaceRegistry,
  type CanonicalWorkspacePath,
  type WorkspaceRegistryEntry
} from "./registry.js";

export interface WorkspaceRuntimeHandle {
  readonly address: { readonly origin: string } | undefined;
  close(): Promise<void>;
}

export type WorkspaceRuntimeFactory = (
  config: AIChatLinkConfig,
  options: { readonly port: 0; readonly agentEnv: NodeJS.ProcessEnv }
) => Promise<WorkspaceRuntimeHandle>;

export interface WorkspaceSupervisorOptions {
  readonly config: AIChatLinkConfig;
  readonly configPath: string;
  /** Test seam: the default starts a real AIChatLinkRuntime on port 0. */
  readonly createRuntime?: WorkspaceRuntimeFactory;
  readonly closeTimeoutMs?: number;
  readonly onError?: (
    error: unknown,
    context: { readonly operation: "workspace"; readonly workspaceId?: string }
  ) => void;
}

type WorkspaceStatus = WorkspaceSummary["status"];

interface WorkspaceRecord {
  readonly entry: WorkspaceRegistryEntry;
  readonly canonical: CanonicalWorkspacePath;
  readonly agentCount: number;
  status: WorkspaceStatus;
  runtime: WorkspaceRuntimeHandle | undefined;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  startFlight: Promise<void> | undefined;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;
const START_CONCURRENCY = 2;

/** `realpathSync` expands Windows 8.3 short names before the id is hashed. */
function canonicalPrimaryPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return path.normalize(realpathSync.native(resolved));
  } catch {
    return path.normalize(resolved);
  }
}

function enabledAgentCount(config: AIChatLinkConfig): number {
  return Object.values(config.agents).filter((agent) => agent.enabled).length;
}

function defaultCreateRuntime(
  config: AIChatLinkConfig,
  options: { readonly port: 0; readonly agentEnv: NodeJS.ProcessEnv }
): Promise<WorkspaceRuntimeHandle> {
  return startAIChatLinkRuntime(config, {
    port: options.port,
    agentEnv: options.agentEnv
  });
}

function errorSummary(error: unknown): { errorCode: string; errorMessage: string } {
  const normalized = toAIChatLinkError(error, "ADAPTER_START_FAILED");
  return {
    errorCode: normalized.code,
    errorMessage: normalized.message.slice(0, 500)
  };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Owns one AIChatLinkRuntime per registered workspace directory. The primary
 * workspace is served by the hub runtime itself; every other workspace gets a
 * derived in-memory config, its own SQLite database, its own loopback HTTP
 * origin and its own Agent sessions. Closing the hub closes every child first.
 */
export class WorkspaceSupervisor implements WorkspaceHubApi, WorkspaceRouting {
  readonly primaryWorkspaceId: string;

  readonly #config: AIChatLinkConfig;
  readonly #dataRoot: string;
  readonly #registryPath: string;
  readonly #createRuntime: WorkspaceRuntimeFactory;
  readonly #closeTimeoutMs: number;
  readonly #onError: WorkspaceSupervisorOptions["onError"];
  readonly #primaryEntry: WorkspaceRegistryEntry;
  readonly #records = new Map<string, WorkspaceRecord>();
  readonly #registryWrites: { tail: Promise<void> } = { tail: Promise.resolve() };

  #primaryRuntime: WorkspaceRuntimeHandle | undefined;
  #initialized: Promise<void> | undefined;
  #startAll: Promise<void> | undefined;
  #closeAll: Promise<void> | undefined;
  #closing = false;

  constructor(options: WorkspaceSupervisorOptions) {
    this.#config = options.config;
    this.#dataRoot = path.dirname(path.resolve(options.config.storage.path));
    this.#registryPath = workspaceRegistryPath(options.config.storage.path);
    this.#createRuntime = options.createRuntime ?? defaultCreateRuntime;
    this.#closeTimeoutMs =
      options.closeTimeoutMs ?? Math.max(DEFAULT_CLOSE_TIMEOUT_MS, options.config.timeouts.closeMs * 3);
    this.#onError = options.onError;
    const primaryPath = canonicalPrimaryPath(
      primaryWorkspacePath(options.config) ?? path.dirname(path.resolve(options.configPath))
    );
    this.primaryWorkspaceId = workspaceIdForCanonicalPath(primaryPath);
    this.#primaryEntry = createWorkspaceRegistryEntry({
      path: primaryPath,
      workspaceId: this.primaryWorkspaceId
    });
  }

  /** Read the registry once. A malformed registry never blocks the primary room. */
  initialize(): Promise<void> {
    if (this.#initialized) return this.#initialized;
    this.#initialized = (async () => {
      try {
        const document = await readWorkspaceRegistry(this.#registryPath);
        for (const entry of document.workspaces.slice(0, MAX_WORKSPACES - 1)) {
          const canonical = await canonicalizeWorkspacePath(entry.path).catch(() => ({
            path: entry.path,
            workspaceId: workspaceIdForCanonicalPath(entry.path)
          }));
          const workspaceId = canonical.workspaceId;
          if (workspaceId === this.primaryWorkspaceId) continue;
          if (this.#records.has(workspaceId)) continue;
          const effectiveEntry =
            canonical.path === entry.path ? entry : { ...entry, path: canonical.path };
          const derived = deriveWorkspaceConfig(this.#config, canonical, this.#dataRoot);
          this.#records.set(workspaceId, {
            entry: effectiveEntry,
            canonical,
            agentCount: enabledAgentCount(derived),
            status: "stopped",
            runtime: undefined,
            errorCode: undefined,
            errorMessage: undefined,
            startFlight: undefined
          });
        }
      } catch (error) {
        this.#onError?.(error, { operation: "workspace" });
      }
    })();
    return this.#initialized;
  }

  attachPrimary(runtime: WorkspaceRuntimeHandle): void {
    this.#primaryRuntime = runtime;
  }

  /** Start every registered secondary in the background, bounded to two at a time. */
  startRegistered(): Promise<void> {
    if (this.#startAll) return this.#startAll;
    this.#startAll = (async () => {
      await this.initialize();
      const queue = [...this.#records.values()].filter(
        (record) => record.status === "stopped" || record.status === "failed"
      );
      const workers = Array.from(
        { length: Math.min(START_CONCURRENCY, queue.length) },
        async () => {
          for (;;) {
            if (this.#closing) return;
            const record = queue.shift();
            if (record === undefined) return;
            await this.#startRecord(record.canonical.workspaceId);
          }
        }
      );
      await Promise.all(workers);
    })();
    return this.#startAll;
  }

  list(signal: AbortSignal): WorkspaceList {
    signal.throwIfAborted();
    const workspaces: WorkspaceSummary[] = [this.#primarySummary()];
    for (const record of this.#records.values()) {
      workspaces.push(this.#summary(record));
    }
    return { workspaces };
  }

  async create(
    request: CreateWorkspaceRequest,
    signal: AbortSignal
  ): Promise<CreateWorkspaceResponse> {
    signal.throwIfAborted();
    await this.initialize();
    const canonical = await canonicalizeWorkspacePath(request.path);
    signal.throwIfAborted();
    if (canonical.workspaceId === this.primaryWorkspaceId) {
      return { workspace: this.#primarySummary(), created: false };
    }
    const existing = this.#records.get(canonical.workspaceId);
    if (existing !== undefined) {
      if (existing.status === "failed" || existing.status === "stopped") {
        void this.#startRecord(existing.canonical.workspaceId);
      }
      return { workspace: this.#summary(existing), created: false };
    }
    if (this.#records.size >= MAX_WORKSPACES - 1) {
      throw new AIChatLinkError(
        "INVALID_ENVELOPE",
        `At most ${MAX_WORKSPACES - 1} additional workspaces are supported`
      );
    }
    const entry = createWorkspaceRegistryEntry(canonical, {
      ...(request.label === undefined ? {} : { label: request.label })
    });
    const derived = deriveWorkspaceConfig(this.#config, canonical, this.#dataRoot);
    const record: WorkspaceRecord = {
      entry,
      canonical,
      agentCount: enabledAgentCount(derived),
      status: "starting",
      runtime: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      startFlight: undefined
    };
    this.#records.set(canonical.workspaceId, record);
    try {
      await this.#persist();
    } catch (error) {
      this.#records.delete(canonical.workspaceId);
      throw error;
    }
    // Kick the start before checking abort: a client that navigates away still
    // expects the registered workspace to come up in the background.
    void this.#startRecord(canonical.workspaceId);
    signal.throwIfAborted();
    return { workspace: this.#summary(record), created: true };
  }

  async remove(workspaceId: string, signal: AbortSignal): Promise<RemoveWorkspaceResponse> {
    signal.throwIfAborted();
    await this.initialize();
    if (workspaceId === this.primaryWorkspaceId) {
      throw new AIChatLinkError("STORE_CONFLICT", "The primary workspace cannot be removed");
    }
    const record = this.#records.get(workspaceId);
    if (record === undefined) {
      throw new AIChatLinkError("WORKSPACE_NOT_FOUND", "Workspace is not registered", {
        workspaceId
      });
    }
    await this.#stopRecord(workspaceId);
    this.#records.delete(workspaceId);
    await this.#persist();
    return { removed: workspaceId };
  }

  async restart(
    workspaceId: string,
    signal: AbortSignal
  ): Promise<RestartWorkspaceResponse> {
    signal.throwIfAborted();
    await this.initialize();
    if (workspaceId === this.primaryWorkspaceId) {
      throw new AIChatLinkError(
        "STORE_CONFLICT",
        "Use `aichatlink restart` to restart the primary workspace"
      );
    }
    const record = this.#records.get(workspaceId);
    if (record === undefined) {
      throw new AIChatLinkError("WORKSPACE_NOT_FOUND", "Workspace is not registered", {
        workspaceId
      });
    }
    void this.#restartRecord(workspaceId);
    return { workspace: this.#summary(record) };
  }

  resolve(workspaceId: string): WorkspaceRouteTarget | undefined {
    if (workspaceId === this.primaryWorkspaceId) return { kind: "primary" };
    const record = this.#records.get(workspaceId);
    if (record === undefined) return undefined;
    if (record.status === "ready" && record.runtime?.address !== undefined) {
      return { kind: "child", origin: record.runtime.address.origin };
    }
    if (record.status === "failed") {
      return {
        kind: "failed",
        ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode })
      };
    }
    return { kind: "pending" };
  }

  /** Called before the hub releases its listener; never throws. */
  closeAll(): Promise<void> {
    if (this.#closeAll) return this.#closeAll;
    this.#closeAll = (async () => {
      this.#closing = true;
      await withTimeout(
        (this.#startAll ?? Promise.resolve()).then(
          () => true,
          () => true
        ),
        this.#closeTimeoutMs
      );
      const ids = [...this.#records.keys()].reverse();
      for (const workspaceId of ids) {
        await this.#stopRecord(workspaceId).catch((error: unknown) => {
          this.#onError?.(error, { operation: "workspace", workspaceId });
        });
      }
    })();
    return this.#closeAll;
  }

  #primarySummary(): WorkspaceSummary {
    return {
      workspaceId: this.primaryWorkspaceId,
      label: this.#primaryEntry.label,
      path: this.#primaryEntry.path,
      kind: "primary",
      status: this.#primaryRuntime === undefined ? "starting" : "ready",
      agentCount: enabledAgentCount(this.#config)
    };
  }

  #summary(record: WorkspaceRecord): WorkspaceSummary {
    return {
      workspaceId: record.canonical.workspaceId,
      label: record.entry.label,
      path: record.canonical.path,
      kind: "added",
      status: record.status,
      agentCount: record.agentCount,
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
      ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage })
    };
  }

  #startRecord(workspaceId: string): Promise<void> {
    if (this.#closing) return Promise.resolve();
    const record = this.#records.get(workspaceId);
    if (record === undefined) return Promise.resolve();
    if (record.startFlight !== undefined) return record.startFlight;
    const flight = (async () => {
      record.status = "starting";
      record.errorCode = undefined;
      record.errorMessage = undefined;
      const derived = deriveWorkspaceConfig(this.#config, record.canonical, this.#dataRoot);
      try {
        const runtime = await this.#createRuntime(derived, {
          port: 0,
          agentEnv: {
            PI_SHIM_ROLES_ROOT: path.join(
              workspaceDataDirectory(this.#dataRoot, workspaceId),
              "pi-roles"
            )
          }
        });
        if (this.#closing || this.#records.get(workspaceId) !== record) {
          await runtime.close().catch(() => undefined);
          return;
        }
        record.runtime = runtime;
        record.status = "ready";
      } catch (error) {
        if (this.#records.get(workspaceId) !== record) return;
        record.status = "failed";
        const summary = errorSummary(error);
        record.errorCode = summary.errorCode;
        record.errorMessage = summary.errorMessage;
        this.#onError?.(error, { operation: "workspace", workspaceId });
      }
    })().finally(() => {
      if (record.startFlight === flight) record.startFlight = undefined;
      if (record.status === "starting") record.status = "stopped";
    });
    record.startFlight = flight;
    return flight;
  }

  async #restartRecord(workspaceId: string): Promise<void> {
    await this.#stopRecord(workspaceId);
    await this.#startRecord(workspaceId);
  }

  async #stopRecord(workspaceId: string): Promise<void> {
    const record = this.#records.get(workspaceId);
    if (record === undefined) return;
    await withTimeout(
      (record.startFlight ?? Promise.resolve()).then(
        () => true,
        () => true
      ),
      this.#closeTimeoutMs
    );
    const runtime = record.runtime;
    record.runtime = undefined;
    if (runtime === undefined) {
      if (record.status !== "failed") record.status = "stopped";
      return;
    }
    const closed = await withTimeout(
      runtime.close().then(() => true).catch(() => false),
      this.#closeTimeoutMs
    );
    if (closed === undefined) {
      record.status = "failed";
      record.errorCode = "TURN_INTERRUPTED";
      record.errorMessage = `Workspace runtime did not close within ${this.#closeTimeoutMs}ms`;
      this.#onError?.(
        new AIChatLinkError("TURN_INTERRUPTED", record.errorMessage),
        { operation: "workspace", workspaceId }
      );
      return;
    }
    if (closed === false) {
      record.status = "failed";
      record.errorCode = "TURN_INTERRUPTED";
      record.errorMessage = "Workspace runtime reported a close failure";
      return;
    }
    record.status = "stopped";
  }

  #persist(): Promise<void> {
    const operation = this.#registryWrites.tail.then(async () => {
      await writeWorkspaceRegistry(this.#registryPath, {
        version: 1,
        workspaces: [...this.#records.values()].map((record) => record.entry)
      });
    });
    this.#registryWrites.tail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}

export function createWorkspaceSupervisor(
  options: WorkspaceSupervisorOptions
): WorkspaceSupervisor {
  return new WorkspaceSupervisor(options);
}
