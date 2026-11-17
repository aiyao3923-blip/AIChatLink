import { z } from "zod";

import { parseContractOutput, parseWriteRequest } from "./validation.js";

/**
 * A workspace is one working directory the room can run in. The primary
 * workspace comes from `aichatlink.json`; every other entry is a registered
 * directory with its own runtime, SQLite database and Agent sessions.
 */
export const WorkspaceIdSchema = z
  .string()
  .regex(/^ws_[a-f0-9]{12}$/u, "invalid workspace id");

export const WorkspaceStatusSchema = z.enum(["starting", "ready", "failed", "stopped"]);

export const WorkspaceSummarySchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  label: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(4_096),
  kind: z.enum(["primary", "added"]),
  status: WorkspaceStatusSchema,
  /** Enabled configured Agents in this workspace's derived roster. */
  agentCount: z.number().int().min(0).max(10_000),
  errorCode: z.string().min(1).max(64).optional(),
  errorMessage: z.string().min(1).max(500).optional()
});

export const WorkspaceListSchema = z.strictObject({
  workspaces: z.array(WorkspaceSummarySchema).max(8)
});

export const CreateWorkspaceRequestSchema = z.strictObject({
  path: z.string().trim().min(1).max(4_096),
  label: z.string().trim().min(1).max(120).optional()
});

export const CreateWorkspaceResponseSchema = z.strictObject({
  workspace: WorkspaceSummarySchema,
  created: z.boolean()
});

export const RemoveWorkspaceResponseSchema = z.strictObject({
  removed: WorkspaceIdSchema
});

export const RestartWorkspaceResponseSchema = z.strictObject({
  workspace: WorkspaceSummarySchema
});

export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type WorkspaceList = z.infer<typeof WorkspaceListSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;
export type RemoveWorkspaceResponse = z.infer<typeof RemoveWorkspaceResponseSchema>;
export type RestartWorkspaceResponse = z.infer<typeof RestartWorkspaceResponseSchema>;

export function parseWorkspaceList(input: unknown): WorkspaceList {
  return parseContractOutput(WorkspaceListSchema, input);
}

export function parseCreateWorkspaceRequest(input: unknown): CreateWorkspaceRequest {
  return parseWriteRequest(CreateWorkspaceRequestSchema, input);
}

export function parseCreateWorkspaceResponse(input: unknown): CreateWorkspaceResponse {
  return parseContractOutput(CreateWorkspaceResponseSchema, input);
}

export function parseRemoveWorkspaceResponse(input: unknown): RemoveWorkspaceResponse {
  return parseContractOutput(RemoveWorkspaceResponseSchema, input);
}

export function parseRestartWorkspaceResponse(input: unknown): RestartWorkspaceResponse {
  return parseContractOutput(RestartWorkspaceResponseSchema, input);
}

export function parseWorkspaceId(input: unknown): string {
  return parseContractOutput(WorkspaceIdSchema, input);
}
