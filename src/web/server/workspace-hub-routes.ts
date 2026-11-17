import {
  parseCreateWorkspaceRequest,
  parseWorkspaceId
} from "../../contracts/index.js";
import { AIChatLinkError } from "../../core/errors.js";
import { WORKSPACE_REQUEST_HEADER } from "../setup/workspace-routes.js";
import type { WorkspaceHubApi } from "./types.js";

export type WorkspaceHubRouteOutcome =
  | { readonly kind: "handled"; readonly body: unknown }
  | { readonly kind: "method"; readonly allow: readonly string[] };

export interface WorkspaceHubRouteInput {
  readonly api: WorkspaceHubApi;
  readonly method: string;
  readonly url: URL;
  readonly signal: AbortSignal;
  header(name: string): string | undefined;
  readJson(): Promise<unknown>;
}

function requireSetupHeader(input: WorkspaceHubRouteInput): void {
  if (input.header(WORKSPACE_REQUEST_HEADER) !== "1") {
    throw new AIChatLinkError(
      "INVALID_ENVELOPE",
      "Workspace writes require the same-origin AIChatLink request header"
    );
  }
}

function decodeWorkspaceId(encoded: string): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new AIChatLinkError("INVALID_ENVELOPE", "Workspace id is not valid URL encoding");
  }
  return parseWorkspaceId(value);
}

/** Hub-only workspace routes; children never mount this surface. */
export async function serveWorkspaceHubRoute(
  input: WorkspaceHubRouteInput
): Promise<WorkspaceHubRouteOutcome | null> {
  const { api, method, url } = input;
  if (url.pathname === "/api/workspaces") {
    if (method === "GET") {
      return { kind: "handled", body: await api.list(input.signal) };
    }
    if (method === "POST") {
      requireSetupHeader(input);
      const request = parseCreateWorkspaceRequest(await input.readJson());
      return { kind: "handled", body: await api.create(request, input.signal) };
    }
    return { kind: "method", allow: ["GET", "POST"] };
  }

  const restartMatch = /^\/api\/workspaces\/([^/]+)\/restart$/u.exec(url.pathname);
  if (restartMatch?.[1] !== undefined) {
    if (method !== "POST") return { kind: "method", allow: ["POST"] };
    requireSetupHeader(input);
    return {
      kind: "handled",
      body: await api.restart(decodeWorkspaceId(restartMatch[1]), input.signal)
    };
  }

  const removeMatch = /^\/api\/workspaces\/([^/]+)$/u.exec(url.pathname);
  if (removeMatch?.[1] !== undefined) {
    if (method !== "DELETE") return { kind: "method", allow: ["DELETE"] };
    requireSetupHeader(input);
    return {
      kind: "handled",
      body: await api.remove(decodeWorkspaceId(removeMatch[1]), input.signal)
    };
  }

  return null;
}
