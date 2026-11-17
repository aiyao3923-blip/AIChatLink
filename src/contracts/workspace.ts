import { z } from "zod";

import { parseContractOutput, parseWriteRequest } from "./validation.js";

/**
 * Workspace browsing is a local-only convenience for the setup editor: it lists
 * child directories so the operator can pick a room working folder without
 * typing an absolute path. It never reads file contents.
 */
export const WorkspaceDirectorySchema = z.strictObject({
  name: z.string().min(1).max(255),
  path: z.string().trim().min(1).max(4_096),
  /** True when the directory itself contains a `.git` entry. */
  isRepository: z.boolean()
});

export const WorkspaceListingSchema = z.strictObject({
  path: z.string().trim().min(1).max(4_096),
  parent: z.string().trim().min(1).max(4_096).nullable(),
  shortcuts: z.array(WorkspaceDirectorySchema).max(32),
  entries: z.array(WorkspaceDirectorySchema).max(4_096),
  /** True when more child directories exist than the contract can carry. */
  truncated: z.boolean()
});

export const WorkspaceRevealRequestSchema = z.strictObject({
  path: z.string().trim().min(1).max(4_096)
});

export const WorkspaceRevealResponseSchema = z.strictObject({
  opened: z.literal(true),
  path: z.string().trim().min(1).max(4_096)
});

export type WorkspaceDirectory = z.infer<typeof WorkspaceDirectorySchema>;
export type WorkspaceListing = z.infer<typeof WorkspaceListingSchema>;
export type WorkspaceRevealRequest = z.infer<typeof WorkspaceRevealRequestSchema>;
export type WorkspaceRevealResponse = z.infer<typeof WorkspaceRevealResponseSchema>;

export function parseWorkspaceListing(input: unknown): WorkspaceListing {
  return parseContractOutput(WorkspaceListingSchema, input);
}

export function parseWorkspaceRevealRequest(input: unknown): WorkspaceRevealRequest {
  return parseWriteRequest(WorkspaceRevealRequestSchema, input);
}

export function parseWorkspaceRevealResponse(input: unknown): WorkspaceRevealResponse {
  return parseContractOutput(WorkspaceRevealResponseSchema, input);
}
