import { ClaudeCliAdapter, CLAUDE_STREAM_PROFILE, type ClaudeCliAdapterOptions } from "../claude/index.js";
import type { ClaudeStreamProfile } from "../claude/protocol.js";

/**
 * WorkBuddy (Tencent Genie desktop) bundles the CodeBuddy CLI, whose structured
 * stdio surface is the same `--print --input-format stream-json` shape as
 * Claude Code. It is its own vendor entrypoint, not a protocol shim.
 *
 * Two observed differences drive this profile:
 *
 * 1. `control_request`/`initialize` succeeds but does not report
 *    `current_permission_mode`.
 * 2. `control_request`/`set_permission_mode` fails with
 *    `Session not found: current` until the first user message creates the
 *    native session.
 *
 * Unrestricted access is therefore requested by argv and verified against the
 * first `system`/`init` frame (which reports `session_id`, `cwd`, and
 * `permissionMode`). A downgrade fails the Turn closed.
 */
export const WORKBUDDY_PROTOCOL = "workbuddy-codebuddy-stream-json-v1";

export const WORKBUDDY_STREAM_PROFILE: ClaudeStreamProfile = {
  protocol: WORKBUDDY_PROTOCOL,
  label: "WorkBuddy",
  baseArgv: CLAUDE_STREAM_PROFILE.baseArgv,
  permissionModeEstablishment: "argv"
};

export interface WorkBuddyCliAdapterOptions extends ClaudeCliAdapterOptions {}

/** ACP is not reachable in the shipped WorkBuddy lite bundle, so stream-json is the only surface. */
export class WorkBuddyCliAdapter extends ClaudeCliAdapter {
  constructor(options: WorkBuddyCliAdapterOptions = {}) {
    super({
      targetCliVersion: "2.165.0",
      ...options,
      agentId: options.agentId ?? "workbuddy",
      streamProfile: WORKBUDDY_STREAM_PROFILE
    });
  }
}
