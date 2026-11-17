import { parseWorkspaceRevealRequest } from "../../contracts/index.js";
import { AIChatLinkError } from "../../core/errors.js";
import type { SetupWorkspaceApi } from "../server/types.js";

/** Header the same-origin setup page sends; a cross-site form post cannot add it. */
export const WORKSPACE_REQUEST_HEADER = "x-aichatlink-setup";

export type WorkspaceRouteOutcome =
  | { readonly kind: "handled"; readonly body: unknown }
  | { readonly kind: "method"; readonly allow: readonly string[] };

export interface WorkspaceRouteInput {
  readonly api: SetupWorkspaceApi;
  readonly method: string;
  readonly url: URL;
  readonly signal: AbortSignal;
  header(name: string): string | undefined;
  readJson(): Promise<unknown>;
}

/**
 * Shared by the standalone setup server and the running room server so both
 * expose exactly one workspace surface. Returns null for unrelated paths.
 */
export async function serveWorkspaceRoute(
  input: WorkspaceRouteInput
): Promise<WorkspaceRouteOutcome | null> {
  const { api, method, url } = input;
  if (url.pathname === "/api/setup/workspace") {
    if (method !== "GET") return { kind: "method", allow: ["GET"] };
    const requested = url.searchParams.get("path");
    const listing = await api.list(
      requested === null || requested === "" ? undefined : requested,
      input.signal
    );
    return { kind: "handled", body: listing };
  }
  if (url.pathname === "/api/setup/workspace/reveal") {
    if (method !== "POST") return { kind: "method", allow: ["POST"] };
    if (input.header(WORKSPACE_REQUEST_HEADER) !== "1") {
      throw new AIChatLinkError(
        "INVALID_ENVELOPE",
        "The workspace reveal request is missing its AIChatLink request header"
      );
    }
    const request = parseWorkspaceRevealRequest(await input.readJson());
    return { kind: "handled", body: await api.reveal(request.path, input.signal) };
  }
  return null;
}
