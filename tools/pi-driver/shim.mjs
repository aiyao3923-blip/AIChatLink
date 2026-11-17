// pi-driver shim: presents a pi RPC session to AIChatLink as a Claude Code
// stream-json CLI.
//
// AIChatLink spawns (resolveAgentCommand allows exactly one JS prefix arg):
//   node <thisfile or an entry wrapper> --print --input-format stream-json \
//     --output-format stream-json --verbose --include-partial-messages \
//     --permission-mode bypassPermissions [--mcp-config <json>] \
//     (--session-id <uuid> | --resume <uuid>)
//
// Nothing about the role is taken from argv: AIChatLink owns every argument after
// the entrypoint, so the entry wrapper passes the role id programmatically.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLineReader, writeRecord } from "./lines.mjs";
import { CANCELLED, FAILED, createProjector, controlErrorResponse, initResponse, resultFrame, setPermissionModeResponse } from "./frames.mjs";
import { prepareRoleDir, writeSnapshot } from "./role-dir.mjs";
import { parseRolesFile, sanitizeSessionId } from "./roles.mjs";

const HANDSHAKE_TIMEOUT_MS = 8_000;
const SHUTDOWN_GRACE_MS = 5_000;
const MAX_LOG_TEXT = 400;

/** Extract the argv AIChatLink built. Everything unknown is dropped, not forwarded. */
export function parseAIChatLinkArgv(argv) {
  const out = { sessionId: null, resumeId: null, mcpConfig: null, model: null, effort: null, dropped: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--session-id") out.sessionId = next() ?? null;
    else if (arg === "--resume") out.resumeId = next() ?? null;
    else if (arg === "--mcp-config") out.mcpConfig = parseJsonOrNull(next());
    // AIChatLink appends the per-agent model/effort (aichatlink.json agents.<id>) to the
    // Claude argv. Native Claude consumes them; here they override ROLES.json.
    else if (arg === "--model") out.model = next() ?? null;
    else if (arg === "--effort") out.effort = next() ?? null;
    else out.dropped.push(arg);
  }
  return out;
}

/** Split `provider/model` (pi form) from a bare model id (native form). */
export function splitModelSelection(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) return null;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return { provider: null, model: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

export function extractPromptText(frame) {
  const content = frame?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * AIChatLink prefixes the room context packet and delimits the user's own text with
 * `[current_message]` (src/adapters/claude/protocol.ts buildClaudeUserMessage).
 * Slash commands must be matched against that tail, never against the packet.
 */
export const CURRENT_MESSAGE_MARKER = "[current_message]";

export function extractCurrentMessage(text) {
  const raw = typeof text === "string" ? text : "";
  const marker = `\n${CURRENT_MESSAGE_MARKER}\n`;
  const index = raw.lastIndexOf(marker);
  if (index !== -1) return raw.slice(index + marker.length);
  if (raw.startsWith(`${CURRENT_MESSAGE_MARKER}\n`)) return raw.slice(CURRENT_MESSAGE_MARKER.length + 1);
  return raw;
}

export function resolvePiEntry(env = process.env) {
  if (env.PI_SHIM_PI_ENTRY) return env.PI_SHIM_PI_ENTRY;
  const rel = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const home = os.homedir();
  const candidates = [
    env.APPDATA ? path.join(env.APPDATA, "npm", rel) : null,
    path.join(home, "AppData", "Roaming", "npm", rel),
    path.join(home, ".npm-global", "lib", rel),
    path.join("/usr/local/lib", rel),
    path.join("/usr/lib", rel),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw Object.assign(new Error("cannot locate the pi package; set PI_SHIM_PI_ENTRY"), {
    code: "pi_entry_not_found",
  });
}

/**
 * @param {{
 *   roleId: string, role: object, rolesRoot: string, userAgentDir: string,
 *   piEntry: string, argv: string[], input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
 *   spawnImpl?: typeof spawn, env?: Record<string,string|undefined>, log?: Function
 * }} options
 */
export async function runShim(options) {
  const { roleId, role, rolesRoot, userAgentDir, piEntry, argv, input, output } = options;
  const spawnImpl = options.spawnImpl ?? spawn;
  const baseEnv = options.env ?? process.env;
  const logs = [];
  const log = (event, detail = {}) => {
    const record = { at: new Date().toISOString(), roleId, event, ...detail };
    logs.push(record);
    options.log?.(record);
    // stderr only: stdout belongs to the AIChatLink protocol.
    process.stderr.write(`${JSON.stringify(record)}\n`);
  };

  const args = parseAIChatLinkArgv(argv);
  const sessionSeed = args.sessionId ?? args.resumeId ?? `${roleId}-${Date.now()}`;
  const sessionId = sanitizeSessionId(sessionSeed);
  if (sessionId !== sessionSeed) log("session.id.mapped", { from: String(sessionSeed).slice(0, 40), to: sessionId });

  // An explicit per-agent selection from aichatlink.json wins over the role file and
  // over a snapshot written by an in-room /model switch. Its provider must also
  // join the role's trimmed catalog, or pi could not resolve it.
  const selection = splitModelSelection(args.model);
  const providers =
    selection?.provider == null || role.providers == null
      ? role.providers
      : [...new Set([...role.providers, selection.provider])];
  const prepared = await prepareRoleDir({
    roleId,
    role: providers === role.providers ? role : { ...role, providers },
    rolesRoot,
    userAgentDir,
    mcpConfig: args.mcpConfig,
    workDir: process.cwd(),
    log,
  });
  if (selection !== null) {
    if (selection.provider !== null) prepared.provider = selection.provider;
    prepared.model = selection.model;
  }
  if (typeof args.effort === "string" && args.effort.trim().length > 0) {
    prepared.thinking = args.effort.trim();
  }
  log("role.prepared", {
    providers: prepared.providers,
    mcp: prepared.mcp,
    model: `${prepared.provider}/${prepared.model}`,
    thinking: prepared.thinking,
    workdir: prepared.workDir,
    argvDropped: args.dropped.length,
    ...(selection === null ? {} : { modelOverride: true }),
  });

  const piArgs = [
    piEntry,
    "--mode",
    "rpc",
    "--session-id",
    sessionId,
    "--provider",
    prepared.provider,
    "--model",
    prepared.model,
    "--thinking",
    prepared.thinking,
    ...(role.contextFiles === false ? ["--no-context-files"] : []),
    ...(role.piArgs ?? []),
  ];
  if (role.tools?.mode === "exclude") piArgs.push("--exclude-tools", role.tools.list.join(","));
  if (role.tools?.mode === "include") piArgs.push("--tools", role.tools.list.join(","));

  const child = spawnImpl(process.execPath, piArgs, {
    cwd: prepared.workDir,
    env: { ...baseEnv, ...prepared.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let closed = false;
  let busy = false;
  let pendingCancel = false;
  let writeQueue = Promise.resolve();
  const pending = new Map();
  const projector = createProjector();
  let requestSeq = 0;

  const emit = (frames) => {
    if (!frames || frames.length === 0) return;
    writeQueue = writeQueue.then(async () => {
      for (const frame of frames) {
        if (closed) return;
        await writeRecord(output, frame);
      }
    });
  };

  const send = (record) => {
    if (closed || !child.stdin.writable) return;
    writeQueue = writeQueue.then(() => writeRecord(child.stdin, record));
  };

  function request(command, payload = {}, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    requestSeq += 1;
    const id = `shim-${requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      send({ id, type: command, ...payload });
    });
  }

  function emitSyntheticTurn(text) {
    projector.beginTurn();
    emit([{ type: "stream_event", event: { type: "message_start", message: { id: `msg_${projector.turnSeq}_0`, role: "assistant", content: [] } } }]);
    emit([{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }]);
    emit([
      { type: "assistant", message: { id: `msg_${projector.turnSeq}_0`, role: "assistant", content: [{ type: "text", text }] } },
      resultFrame({ subtype: "success", isError: false, numTurns: 1 }),
    ]);
  }

  async function handleSlash(text) {
    const [command, ...rest] = text.trim().split(/\s+/);
    const argument = rest.join(" ").trim();
    if (command === "/model") {
      if (!argument) return emitSyntheticTurn(`用法：/model provider/model\n当前：${prepared.provider}/${prepared.model}`);
      const [provider, modelId] = argument.includes("/")
        ? [argument.slice(0, argument.indexOf("/")), argument.slice(argument.indexOf("/") + 1)]
        : [prepared.provider, argument];
      const result = await request("set_model", { provider, modelId });
      if (!result.ok) return emitSyntheticTurn(`切换失败：${result.error ?? result.data ?? "unknown"}`);
      prepared.provider = provider;
      prepared.model = modelId;
      await writeSnapshot(rolesRoot, roleId, { provider, model: modelId, thinking: prepared.thinking });
      return emitSyntheticTurn(`已切换到 ${provider}/${modelId}（同一 session，上下文保留）`);
    }
    if (command === "/thinking") {
      if (!argument) return emitSyntheticTurn(`当前推理档：${prepared.thinking}`);
      const result = await request("set_thinking_level", { level: argument });
      if (!result.ok) return emitSyntheticTurn(`设置失败：${result.error ?? "unknown"}`);
      prepared.thinking = argument;
      await writeSnapshot(rolesRoot, roleId, { provider: prepared.provider, model: prepared.model, thinking: argument });
      return emitSyntheticTurn(`推理档已设为 ${argument}`);
    }
    if (command === "/state") {
      const state = await request("get_state");
      const data = state.ok ? state.data : undefined;
      const summary = data
        ? `model=${data.model?.provider}/${data.model?.id} thinking=${data.thinkingLevel} streaming=${data.isStreaming} messages=${data.messageCount}`
        : `读取失败：${state.error ?? "unknown"}`;
      return emitSyntheticTurn(summary);
    }
    if (command === "/models") {
      const list = await request("get_available_models");
      const items = list.ok && Array.isArray(list.data?.models) ? list.data.models : [];
      const text = items.slice(0, 40).map((item) => `${item.provider}/${item.id}`).join("\n");
      return emitSyntheticTurn(text.length > 0 ? `可用模型（前 40）：\n${text}` : "未取到模型列表");
    }
    return emitSyntheticTurn(`未知指令：${command}`);
  }

  async function handleControlRequest(frame) {
    const requestId = typeof frame.request_id === "string" ? frame.request_id : undefined;
    const subtype = frame.request?.subtype;
    if (!requestId) return;
    if (subtype === "initialize") {
      const state = await request("get_state");
      emit([state.ok ? initResponse(requestId, { pid: child.pid }) : controlErrorResponse(requestId, state.error ?? "state_unavailable")]);
      return;
    }
    if (subtype === "set_permission_mode") {
      emit([setPermissionModeResponse(requestId)]);
      return;
    }
    if (subtype === "interrupt") {
      // Answer immediately: AIChatLink's cancel timeout is 10 s and pi's abort only
      // responds once the session is idle.
      emit([{ type: "control_response", response: { subtype: "success", request_id: requestId, response: {} } }]);
      pendingCancel = true;
      send({ type: "abort" });
      return;
    }
    emit([controlErrorResponse(requestId, `unsupported_control_${String(subtype)}`)]);
  }

  // Host facts travel with every prompt so the role can answer "which model are
  // you" from configuration instead of guessing from memory.
  const hostFacts = [
    "[host_agent]",
    `role=${roleId}`,
    `provider=${prepared.provider}`,
    `model=${prepared.model}`,
    `thinking=${prepared.thinking}`,
    "被问到模型身份时以本段为准：这是宿主下发的运行时事实。",
  ].join("\n");
  const withHostFacts = (text) => `${hostFacts}\n\n${text}`;

  async function handleAIChatLinkFrames(frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "control_request") return handleControlRequest(frame);
    if (frame.type !== "user") return;
    const text = extractPromptText(frame);
    // The room packet precedes the user's words, so the slash test looks at the
    // `[current_message]` tail only.
    const current = extractCurrentMessage(text).trim();
    if (current.startsWith("/")) return handleSlash(current);
    if (busy) {
      log("turn.steer", {});
      send({ type: "prompt", message: withHostFacts(text), streamingBehavior: "steer" });
      return;
    }
    busy = true;
    projector.beginTurn();
    send({ type: "prompt", message: withHostFacts(text) });
  }

  function handlePiRecord(record) {
    if (!record || typeof record !== "object") return;
    if (record.type === "response") {
      const waiter = pending.get(record.id);
      if (waiter) {
        pending.delete(record.id);
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: record.success === true, data: record.data, error: record.error });
      }
      return;
    }
    const frames = projector.push(record);
    if (record.type === "agent_settled") {
      busy = false;
      if (pendingCancel) {
        pendingCancel = false;
        emit([resultFrame({ ...CANCELLED, numTurns: 1 })]);
        return;
      }
    }
    emit(frames);
  }

  const reader = createLineReader(child.stdout, {
    onLine: (line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        log("pi.stdout.unparsable", { bytes: Buffer.byteLength(line, "utf8") });
        return;
      }
      handlePiRecord(record);
    },
    onError: (error) => log("pi.stdout.error", { code: error.code }),
  });

  createLineReader(child.stderr, {
    onLine: (line) => log("pi.stderr", { text: line.slice(0, MAX_LOG_TEXT) }),
    onError: () => {},
  });

  const linkReader = createLineReader(input, {
    onLine: (line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        log("aichatlink.stdin.unparsable", { bytes: Buffer.byteLength(line, "utf8") });
        return;
      }
      void handleAIChatLinkFrames(frame);
    },
    onError: (error) => log("aichatlink.stdin.error", { code: error.code }),
  });

  let exitCode = 0;
  const finished = new Promise((resolve) => {
    child.on("error", (error) => {
      log("pi.spawn.error", { code: error.code ?? "unknown", message: String(error.message).slice(0, MAX_LOG_TEXT) });
      if (busy) emit([resultFrame({ ...FAILED, numTurns: 1 })]);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      exitCode = code ?? 0;
      log("pi.exit", { code: exitCode, signal: signal ?? null, busy });
      if (busy) emit([resultFrame({ ...FAILED, numTurns: 1 })]);
      resolve(exitCode === 0 ? 0 : 1);
    });
  });

  function shutdown() {
    if (closed) return;
    closed = true;
    linkReader.dispose();
    reader.dispose();
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    const timer = setTimeout(() => {
      if (child.exitCode !== null) return;
      if (process.platform === "win32" && child.pid) {
        spawnImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, SHUTDOWN_GRACE_MS);
    timer.unref?.();
  }

  input.on("end", shutdown);
  process.on?.("SIGTERM", shutdown);
  process.on?.("SIGINT", shutdown);

  const code = await finished;
  closed = true;
  try {
    reader.dispose();
    linkReader.dispose();
  } catch {
    // ignore
  }
  return { code, sessionId, stats: projector.stats, logs };
}

/** Entry point used by generated entry wrappers. */
export async function main(roleId, overrides = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rolesFile = overrides.rolesFile ?? process.env.PI_SHIM_ROLES_FILE ?? path.join(here, "ROLES.json");
  const rolesRoot =
    overrides.rolesRoot ?? process.env.PI_SHIM_ROLES_ROOT ?? path.join(here, "..", "..", ".aichatlink", "pi-roles");
  const userAgentDir =
    overrides.userAgentDir ?? process.env.PI_SHIM_USER_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

  const roles = parseRolesFile(JSON.parse(await readFile(rolesFile, "utf8")));
  const role = roles.get(roleId);
  if (!role) throw Object.assign(new Error(`unknown role: ${roleId}`), { code: "role_not_found" });

  const result = await runShim({
    roleId,
    role,
    rolesRoot: path.resolve(rolesRoot),
    userAgentDir,
    piEntry: resolvePiEntry(),
    argv: process.argv.slice(2),
    input: process.stdin,
    output: process.stdout,
    env: process.env,
  });
  return result;
}

function parseJsonOrNull(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
