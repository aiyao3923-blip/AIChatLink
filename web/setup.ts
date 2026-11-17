import { collectCursorPages } from "./pagination.js";

type AgentDriver = "codex" | "grok" | "claude" | "pi" | "workbuddy" | "kimi" | "hermes";

interface AgentModelCatalog {
  source: "cc-switch" | "pi" | "driver";
  provider?: string;
  defaultModel?: string;
  models: string[];
  thinkingLevels: string[];
  note?: string;
}

interface AgentDraft {
  id: string;
  driver: AgentDriver;
  name: string;
  identity?: string;
  model?: string;
  thinking?: string;
  /** pi only: share the user's own ~/.pi/agent instead of the isolated copy. */
  piConfig?: "isolated" | "shared";
  command: {
    executable: string;
    prefixArgs: string[];
  };
  /** Absent means "follow the room workspace". */
  cwd?: string;
  enabled: boolean;
}

interface AssistantDraft {
  enabled: boolean;
  name: string;
  brain: {
    driver: AgentDriver;
    command: {
      executable: string;
      prefixArgs: string[];
    };
    /** Absent means "follow the room workspace". */
    cwd?: string;
  };
  extraInstructions?: string;
}

interface ConfigDraft {
  serverPort: number;
  workspace?: string;
  storagePath: string;
  agents: AgentDraft[];
  assistant?: AssistantDraft;
}

interface SetupSnapshot {
  configPath: string;
  existing: boolean;
  runtimeActive: boolean;
  workspaceResolved?: string;
  drivers: Array<{ driver: AgentDriver; found: boolean }>;
  config: ConfigDraft;
  agentCatalogs?: Record<string, AgentModelCatalog>;
  driverCatalogs?: Partial<Record<AgentDriver, AgentModelCatalog>>;
  existingConfigError?: string;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  isRepository: boolean;
}

interface WorkspaceListing {
  path: string;
  parent: string | null;
  shortcuts: WorkspaceEntry[];
  entries: WorkspaceEntry[];
  truncated: boolean;
}

interface SaveResponse {
  saved: true;
  configPath: string;
  agentCount: number;
  enabledAgentCount: number;
  restartRequired: boolean;
}

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
    details?: {
      issues?: Array<{ path?: string; code?: string }>;
    };
  };
}

interface DriverMeta {
  label: string;
  rail: string;
  short: string;
  tone: string;
  /** AIChatLink can only forward a model for drivers that implement it. */
  model: boolean;
}

interface AgentMemoryRecord {
  memoryId: string;
  actorId: string;
  agentMemoryType: "core" | "dated";
  kind: string;
  content: string;
  createdAt: string;
  status: string;
}

const DRIVER_META: Readonly<Record<AgentDriver, DriverMeta>> = {
  codex: { label: "Codex App Server", rail: "Codex", short: "CO", tone: "var(--tone-codex)", model: true },
  grok: { label: "Grok ACP", rail: "Grok", short: "GR", tone: "var(--tone-grok)", model: false },
  claude: { label: "Claude Code stream-json", rail: "Claude", short: "CL", tone: "var(--tone-claude)", model: true },
  pi: { label: "pi RPC", rail: "pi", short: "PI", tone: "var(--tone-pi)", model: true },
  workbuddy: {
    label: "WorkBuddy stream-json",
    rail: "WorkBuddy",
    short: "WB",
    tone: "var(--tone-workbuddy)",
    model: true
  },
  // Legacy: kept loadable so an existing aichatlink.json still opens, but the
  // supported adapter set is codex/grok/claude/pi/workbuddy.
  kimi: { label: "Kimi ACP (legacy)", rail: "Kimi", short: "KI", tone: "var(--tone-kimi)", model: false },
  hermes: { label: "Hermes ACP (legacy)", rail: "Hermes", short: "HE", tone: "var(--tone-hermes)", model: false }
};

/**
 * Reasoning levels each driver actually forwards (mirrors
 * `src/adapters/codex/codex-app-server-adapter.ts` and
 * `src/adapters/claude/protocol.ts`). Offering a level the driver drops would
 * silently fall back to its default, so the select is built per driver.
 */
const THINKING_LEVELS: Readonly<Record<AgentDriver, readonly string[]>> = {
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  workbuddy: ["low", "medium", "high", "xhigh", "max"],
  grok: [],
  kimi: [],
  hermes: []
};

const THEME_KEY = "aichatlink-theme";
const loadingState = requiredElement<HTMLDivElement>("loading-state");
const form = requiredElement<HTMLFormElement>("setup-form");
const agentList = requiredElement<HTMLDivElement>("agent-list");
const template = requiredElement<HTMLTemplateElement>("agent-card-template");
const formError = requiredElement<HTMLDivElement>("form-error");
const existingBanner = requiredElement<HTMLDivElement>("existing-banner");
const driverProbes = requiredElement<HTMLDivElement>("driver-probes");
const serverPort = requiredElement<HTMLInputElement>("server-port");
const storagePath = requiredElement<HTMLInputElement>("storage-path");
const configPath = requiredElement<HTMLSpanElement>("config-path");
const saveButton = requiredElement<HTMLButtonElement>("save-button");
const backRoom = requiredElement<HTMLAnchorElement>("back-room");
const successState = requiredElement<HTMLElement>("success-state");
const successMark = requiredElement<HTMLElement>("success-mark");
const successEyebrow = requiredElement<HTMLParagraphElement>("success-eyebrow");
const successTitle = requiredElement<HTMLHeadingElement>("success-title");
const successCopy = requiredElement<HTMLParagraphElement>("success-copy");
const savedPath = requiredElement<HTMLElement>("saved-path");
const successRoomLink = requiredElement<HTMLAnchorElement>("success-room-link");
const editAgain = requiredElement<HTMLButtonElement>("edit-again");
const themeToggle = requiredElement<HTMLButtonElement>("theme-toggle");
const assistantEnabled = requiredElement<HTMLInputElement>("assistant-enabled");
const assistantName = requiredElement<HTMLInputElement>("assistant-name");
const assistantDriver = requiredElement<HTMLSelectElement>("assistant-driver");
const assistantCwd = requiredElement<HTMLInputElement>("assistant-cwd");
const assistantCommand = requiredElement<HTMLInputElement>("assistant-command");
const assistantEntrypoint = requiredElement<HTMLInputElement>("assistant-entrypoint");
const assistantExtra = requiredElement<HTMLTextAreaElement>("assistant-extra");
const assistantCard = requiredElement<HTMLElement>("assistant");
const agentNav = requiredElement<HTMLElement>("agent-nav");
const assistantNav = requiredElement<HTMLButtonElement>("assistant-nav");
const rosterCount = requiredElement<HTMLElement>("roster-count");
const workspacePath = requiredElement<HTMLInputElement>("workspace-path");
const workspacePick = requiredElement<HTMLButtonElement>("workspace-pick");
const workspaceReveal = requiredElement<HTMLButtonElement>("workspace-reveal");
const workspaceHint = requiredElement<HTMLElement>("workspace-hint");
const workspaceDialog = requiredElement<HTMLDialogElement>("workspace-dialog");
const workspaceDialogPath = requiredElement<HTMLElement>("workspace-dialog-path");
const workspaceDialogStatus = requiredElement<HTMLElement>("workspace-dialog-status");
const workspaceShortcuts = requiredElement<HTMLElement>("workspace-shortcuts");
const workspaceEntries = requiredElement<HTMLUListElement>("workspace-entries");
const workspaceUp = requiredElement<HTMLButtonElement>("workspace-up");
const workspaceConfirm = requiredElement<HTMLButtonElement>("workspace-confirm");
const workspaceCancel = requiredElement<HTMLButtonElement>("workspace-cancel");
const workspaceDialogClose = requiredElement<HTMLButtonElement>("workspace-dialog-close");

let snapshot: SetupSnapshot | undefined;
let agents: AgentDraft[] = [];
let assistant: AssistantDraft = {
  enabled: false,
  name: "房间助理",
  brain: {
    driver: "codex",
    command: { executable: "codex", prefixArgs: [] },
    cwd: "."
  }
};
let saving = false;
let agentMemoriesLoading = false;
let agentMemoriesLoaded = false;
let agentMemoriesError = "";
const runtimeAgentIds = new Set<string>();
const agentMemories = new Map<string, AgentMemoryRecord>();
const replacingMemoryIds = new Map<string, string>();
const memoryRetryIds = new Map<string, string>();
const driverProbeState = new Map<AgentDriver, boolean>();
let selectedAgentIndex = 0;
let assistantSelected = false;
let workspace = "";
let workspaceDisplay = "";
let workspaceListing: WorkspaceListing | undefined;
let workspaceLoading = false;

interface SetupLaunchState {
  status: "waiting" | "ready" | "failed";
  origin?: string;
  message?: string;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing setup element: ${id}`);
  }
  return element as T;
}

function isDriver(value: string): value is AgentDriver {
  return Object.hasOwn(DRIVER_META, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function actorIdForAgent(agent: AgentDraft): string {
  return `agent:${agent.id}`;
}

function makeClientCommandId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function retryableMemoryCommandId(key: string, prefix: string): string {
  const existing = memoryRetryIds.get(key);
  if (existing) return existing;
  const created = makeClientCommandId(prefix);
  memoryRetryIds.set(key, created);
  return created;
}

function catalogsForAgent(agent: AgentDraft): AgentModelCatalog | undefined {
  return snapshot?.agentCatalogs?.[agent.id] ?? snapshot?.driverCatalogs?.[agent.driver];
}

/** One shared suggestion list: custom ids stay typeable, catalog values are hints. */
function populateModelDatalist(): void {
  const datalist = document.getElementById("agent-model-options");
  if (!datalist) return;
  const values = new Set<string>();
  for (const catalog of Object.values(snapshot?.agentCatalogs ?? {})) {
    for (const model of catalog.models) values.add(model);
  }
  for (const catalog of Object.values(snapshot?.driverCatalogs ?? {})) {
    for (const model of catalog.models) values.add(model);
  }
  datalist.replaceChildren();
  for (const value of [...values].sort()) {
    const option = document.createElement("option");
    option.value = value;
    datalist.append(option);
  }
}

function cloneAgent(agent: AgentDraft): AgentDraft {
  return {
    ...agent,
    command: { executable: agent.command.executable, prefixArgs: [...agent.command.prefixArgs] }
  };
}

function cloneAssistant(value: AssistantDraft): AssistantDraft {
  return {
    enabled: value.enabled,
    name: value.name,
    brain: {
      driver: value.brain.driver,
      command: {
        executable: value.brain.command.executable,
        prefixArgs: [...value.brain.command.prefixArgs]
      },
      ...(value.brain.cwd === undefined ? {} : { cwd: value.brain.cwd })
    },
    ...(value.extraInstructions === undefined ? {} : { extraInstructions: value.extraInstructions })
  };
}

function defaultAssistant(drivers: SetupSnapshot["drivers"]): AssistantDraft {
  const driver = drivers.find((probe) => probe.found)?.driver ?? "codex";
  return {
    enabled: false,
    name: "房间助理",
    brain: {
      driver,
      command: { executable: driver, prefixArgs: [] }
    }
  };
}

function syncAssistantNav(): void {
  const dot = assistantNav.querySelector<HTMLElement>(".nav-dot");
  if (dot) dot.dataset.enabled = String(assistant.enabled);
}

function fillAssistantForm(): void {
  assistantEnabled.checked = assistant.enabled;
  assistantName.value = assistant.name;
  assistantDriver.value = assistant.brain.driver;
  const followsWorkspace = assistantFollowsWorkspace();
  assistantCwd.disabled = followsWorkspace;
  assistantCwd.value = followsWorkspace ? "" : assistant.brain.cwd ?? "";
  assistantCwd.placeholder = followsWorkspace
    ? workspaceEffectivePath() || "跟随房间工作目录"
    : "D:/MyProject 或 .";
  assistantCommand.value = assistant.brain.command.executable;
  assistantEntrypoint.value = assistant.brain.command.prefixArgs[0] ?? "";
  assistantExtra.value = assistant.extraInstructions ?? "";
  assistantCard.classList.toggle("is-disabled", !assistant.enabled);
  syncAssistantNav();
}

function uniqueId(driver: AgentDriver): string {
  const used = new Set(agents.map((agent) => agent.id));
  if (!used.has(driver)) return driver;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${driver}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${driver}-${Date.now()}`;
}

function addAgent(driver: AgentDriver): void {
  agents.push({
    id: uniqueId(driver),
    driver,
    name: "",
    identity: "",
    model: "",
    command: { executable: driver, prefixArgs: [] },
    enabled: true
  });
  assistantSelected = false;
  selectedAgentIndex = agents.length - 1;
  renderAgents();
  const card = agentList.lastElementChild;
  card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  card?.querySelector<HTMLInputElement>(".agent-name")?.focus();
}

function updateCardHeading(card: HTMLElement, agent: AgentDraft): void {
  const meta = DRIVER_META[agent.driver];
  const avatar = card.querySelector<HTMLElement>(".agent-avatar");
  const title = card.querySelector<HTMLElement>(".agent-card-title strong");
  const actor = card.querySelector<HTMLElement>(".actor-preview");
  if (avatar) {
    avatar.textContent = meta.short;
    avatar.style.setProperty("--agent-tone", meta.tone);
  }
  if (title) title.textContent = agent.name.trim() || meta.label;
  if (actor) actor.textContent = `agent:${agent.id || "…"}`;
}

function validateDuplicateIds(): boolean {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
  let valid = true;
  for (const input of agentList.querySelectorAll<HTMLInputElement>(".agent-id")) {
    const duplicate = (counts.get(input.value) ?? 0) > 1;
    input.setCustomValidity(duplicate ? "稳定 ID 不能重复" : "");
    if (duplicate) valid = false;
  }
  return valid;
}

function normalizeAgentMemory(value: unknown): AgentMemoryRecord | null {
  if (!isRecord(value) || !isRecord(value.scope)) return null;
  const memoryId = readStringField(value, "memoryId");
  const actorId = readStringField(value.scope, "id");
  const content = readStringField(value, "content");
  if (!memoryId || !actorId.startsWith("agent:") || !content) return null;
  return {
    memoryId,
    actorId,
    agentMemoryType: readStringField(value, "agentMemoryType") === "dated" ? "dated" : "core",
    kind: readStringField(value, "kind") || "note",
    content,
    createdAt: readStringField(value, "createdAt"),
    status: readStringField(value, "status") || "active"
  };
}

function extractMemoryItems(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  return Array.isArray(value.items) ? value.items : [];
}

function nextMemoryCursor(value: unknown): number | undefined {
  if (!isRecord(value) || value.nextCursor === undefined) return undefined;
  return typeof value.nextCursor === "number" && Number.isSafeInteger(value.nextCursor) && value.nextCursor >= 0
    ? value.nextCursor
    : undefined;
}

async function requestJson(path: string, options: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<unknown>;
}

function localDateHeading(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  const now = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (day === today) return "今天";
  if (day === today - 86_400_000) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function memoriesForActor(actorId: string): AgentMemoryRecord[] {
  return Array.from(agentMemories.values())
    .filter((record) => record.status === "active" && record.actorId === actorId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function renderAgentMemoryCard(card: HTMLElement, agent: AgentDraft): void {
  const actorId = actorIdForAgent(agent);
  const status = card.querySelector<HTMLElement>(".agent-memory-status");
  const count = card.querySelector<HTMLElement>(".agent-memory-count");
  const groups = card.querySelector<HTMLElement>(".agent-memory-groups");
  const editor = card.querySelector<HTMLElement>(".agent-memory-editor");
  const kind = card.querySelector<HTMLSelectElement>(".agent-memory-kind");
  const input = card.querySelector<HTMLTextAreaElement>(".agent-memory-input");
  const submit = card.querySelector<HTMLButtonElement>(".agent-memory-submit");
  const banner = card.querySelector<HTMLElement>(".agent-memory-replace-banner");
  const cancel = card.querySelector<HTMLButtonElement>(".agent-memory-replace-cancel");
  if (!status || !count || !groups || !editor || !kind || !input || !submit || !banner || !cancel) {
    throw new Error("Incomplete Agent memory template");
  }
  const records = memoriesForActor(actorId);
  count.textContent = String(records.length);
  groups.replaceChildren();
  const available = snapshot?.runtimeActive === true && runtimeAgentIds.has(agent.id);
  editor.hidden = !available;
  if (!snapshot?.runtimeActive) {
    status.textContent = "首次启动后可在这里管理核心记忆，并查看自动日期记忆。";
  } else if (!runtimeAgentIds.has(agent.id)) {
    status.textContent = "这是新增或改名的 Agent；保存并重启后即可使用两层记忆。";
  } else if (agentMemoriesLoading) {
    status.textContent = "正在读取独立记忆…";
  } else if (agentMemoriesError) {
    status.textContent = agentMemoriesError;
  } else if (records.length === 0) {
    status.textContent = "还没有核心记忆或自动日期记忆。";
  } else {
    status.textContent = "核心记忆长期保留；成功回合会在安静窗口后批量整理为每日记忆。两者都只进入这个 Agent 的上下文。";
  }

  const appendRecord = (
    list: HTMLUListElement,
    record: AgentMemoryRecord,
    allowReplace: boolean
  ): void => {
    const item = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "agent-memory-record-meta";
    const badge = document.createElement("span");
    badge.textContent = record.kind;
    const actions = document.createElement("span");
    if (allowReplace) {
      const replace = document.createElement("button");
      replace.type = "button";
      replace.textContent = "替换";
      replace.addEventListener("click", () => {
        replacingMemoryIds.set(actorId, record.memoryId);
        kind.value = record.kind;
        input.value = record.content;
        banner.hidden = false;
        submit.textContent = "保存替换";
        input.focus();
      });
      actions.append(replace);
    }
    const retract = document.createElement("button");
    retract.type = "button";
    retract.textContent = "移除";
    let retractArmed = false;
    let retractTimer: number | undefined;
    retract.addEventListener("click", () => {
      if (!retractArmed) {
        retractArmed = true;
        retract.textContent = "确认移除";
        retractTimer = window.setTimeout(() => {
          retractArmed = false;
          retract.textContent = "移除";
        }, 3_000);
        return;
      }
      if (retractTimer !== undefined) window.clearTimeout(retractTimer);
      void retractAgentMemory(record);
    });
    actions.append(retract);
    meta.append(badge, actions);
    const content = document.createElement("p");
    content.textContent = record.content;
    item.append(meta, content);
    list.append(item);
  };

  const coreRecords = records.filter((record) => record.agentMemoryType === "core");
  const datedRecords = records.filter((record) => record.agentMemoryType === "dated");
  if (coreRecords.length > 0) {
    const section = document.createElement("section");
    section.className = "agent-memory-date-group agent-memory-core-group";
    const title = document.createElement("h4");
    title.textContent = "核心记忆";
    const list = document.createElement("ul");
    for (const record of coreRecords) appendRecord(list, record, true);
    section.append(title, list);
    groups.append(section);
  }

  const datedHeading = document.createElement("h4");
  datedHeading.className = "agent-memory-layer-heading";
  datedHeading.textContent = "按日期自动记忆";
  if (datedRecords.length > 0) groups.append(datedHeading);
  const byDate = new Map<string, AgentMemoryRecord[]>();
  for (const record of datedRecords) {
    const heading = localDateHeading(record.createdAt);
    const group = byDate.get(heading) ?? [];
    group.push(record);
    byDate.set(heading, group);
  }
  for (const [heading, recordsForDate] of byDate) {
    const section = document.createElement("section");
    section.className = "agent-memory-date-group";
    const title = document.createElement("h4");
    title.textContent = heading;
    const list = document.createElement("ul");
    for (const record of recordsForDate) appendRecord(list, record, false);
    section.append(title, list);
    groups.append(section);
  }

  cancel.onclick = () => {
    replacingMemoryIds.delete(actorId);
    banner.hidden = true;
    submit.textContent = "保存核心记忆";
    input.value = "";
  };
  submit.onclick = () => void saveAgentMemory(agent, { kind, input, submit, banner });
}

function refreshRenderedAgentMemoryCards(): void {
  const cards = Array.from(agentList.querySelectorAll<HTMLElement>(".agent-editor-card"));
  cards.forEach((card, index) => {
    const agent = agents[index];
    if (agent) renderAgentMemoryCard(card, agent);
  });
}

async function loadAgentMemories(): Promise<void> {
  if (agentMemoriesLoaded || agentMemoriesLoading || snapshot?.runtimeActive !== true) return;
  agentMemoriesLoading = true;
  refreshRenderedAgentMemoryCards();
  try {
    const values = await collectCursorPages(async (cursor) => {
      const query = new URLSearchParams({ scopeType: "agent" });
      if (cursor !== undefined) query.set("cursor", String(cursor));
      const page = await requestJson(`/api/memory?${query.toString()}`);
      const nextCursor = nextMemoryCursor(page);
      return nextCursor === undefined
        ? { items: extractMemoryItems(page) }
        : { items: extractMemoryItems(page), nextCursor };
    });
    agentMemories.clear();
    for (const value of values) {
      const record = normalizeAgentMemory(value);
      if (record) agentMemories.set(record.memoryId, record);
    }
    agentMemoriesLoaded = true;
    agentMemoriesError = "";
  } catch (error) {
    agentMemoriesError = error instanceof Error ? `独立记忆读取失败：${error.message}` : "独立记忆读取失败";
  } finally {
    agentMemoriesLoading = false;
    refreshRenderedAgentMemoryCards();
  }
}

async function saveAgentMemory(
  agent: AgentDraft,
  controls: { kind: HTMLSelectElement; input: HTMLTextAreaElement; submit: HTMLButtonElement; banner: HTMLElement }
): Promise<void> {
  const actorId = actorIdForAgent(agent);
  const content = controls.input.value.trim();
  if (!content || !runtimeAgentIds.has(agent.id)) {
    controls.input.focus();
    return;
  }
  const replacingId = replacingMemoryIds.get(actorId);
  const retryKey = replacingId
    ? `setup-supersede:${replacingId}:${controls.kind.value}:${content}`
    : `setup-memory:${actorId}:${controls.kind.value}:${content}`;
  controls.submit.disabled = true;
  try {
    const response = await requestJson(
      replacingId ? `/api/memory/${encodeURIComponent(replacingId)}/supersede` : "/api/memory",
      {
        method: "POST",
        body: JSON.stringify(replacingId
          ? { clientCommandId: retryableMemoryCommandId(retryKey, "setup-memory-replace"), kind: controls.kind.value, content }
          : {
              clientCommandId: retryableMemoryCommandId(retryKey, "setup-agent-memory"),
              scope: { type: "agent", id: actorId },
              subjectActorId: actorId,
              kind: controls.kind.value,
              content
            })
      }
    );
    const memory = isRecord(response) ? normalizeAgentMemory(response.memory) : null;
    if (memory) {
      if (replacingId) agentMemories.delete(replacingId);
      agentMemories.set(memory.memoryId, memory);
    }
    memoryRetryIds.delete(retryKey);
    replacingMemoryIds.delete(actorId);
    controls.input.value = "";
    controls.banner.hidden = true;
    controls.submit.textContent = "保存核心记忆";
    refreshRenderedAgentMemoryCards();
  } catch (error) {
    showError(error instanceof Error ? error.message : "保存 Agent 记忆失败");
  } finally {
    controls.submit.disabled = false;
  }
}

async function retractAgentMemory(record: AgentMemoryRecord): Promise<void> {
  const retryKey = `setup-retract:${record.memoryId}`;
  try {
    await requestJson(`/api/memory/${encodeURIComponent(record.memoryId)}/retract`, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableMemoryCommandId(retryKey, "setup-memory-retract") })
    });
    memoryRetryIds.delete(retryKey);
    agentMemories.delete(record.memoryId);
    replacingMemoryIds.delete(record.actorId);
    refreshRenderedAgentMemoryCards();
  } catch (error) {
    showError(error instanceof Error ? error.message : "移除 Agent 记忆失败");
  }
}

function applySelection(): void {
  const cards = Array.from(agentList.querySelectorAll<HTMLElement>(".agent-editor-card"));
  if (selectedAgentIndex > cards.length - 1) selectedAgentIndex = Math.max(0, cards.length - 1);
  cards.forEach((card, index) => {
    card.hidden = assistantSelected || index !== selectedAgentIndex;
  });
  assistantCard.hidden = !assistantSelected;
  for (const item of agentNav.querySelectorAll<HTMLElement>(".nav-item")) {
    item.setAttribute(
      "aria-current",
      String(!assistantSelected && Number(item.dataset.index) === selectedAgentIndex)
    );
  }
  assistantNav.setAttribute("aria-current", String(assistantSelected));
}

function renderNav(): void {
  agentNav.replaceChildren();
  agents.forEach((agent, index) => {
    const meta = DRIVER_META[agent.driver];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "nav-item";
    item.dataset.index = String(index);

    const avatar = document.createElement("span");
    avatar.className = "nav-avatar";
    avatar.textContent = meta.short;
    avatar.style.setProperty("--agent-tone", meta.tone);
    avatar.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "nav-text";
    const name = document.createElement("strong");
    name.textContent = agent.name.trim() || meta.label;
    const id = document.createElement("small");
    const model = meta.model ? (agent.model ?? "").trim() : "";
    id.textContent = model.length === 0 ? meta.rail : `${meta.rail} · ${model}`;
    id.title = `agent:${agent.id || "…"}${model.length === 0 ? "" : ` · ${model}`}`;
    text.append(name, id);

    const dot = document.createElement("span");
    dot.className = "nav-dot";
    dot.dataset.enabled = String(agent.enabled);

    item.append(avatar, text, dot);
    item.addEventListener("click", () => {
      assistantSelected = false;
      selectedAgentIndex = index;
      applySelection();
    });
    agentNav.append(item);
  });
  const enabled = agents.filter((agent) => agent.enabled).length;
  rosterCount.textContent = `${enabled}/${agents.length}`;
  rosterCount.title = `${agents.length} 个 Agent，${enabled} 个启用`;
  applySelection();
}

function revealInvalidControl(): void {
  const invalid = form.querySelector<HTMLElement>(":invalid");
  if (!invalid) return;
  const card = invalid.closest<HTMLElement>(".agent-editor-card");
  if (card) {
    const index = Array.from(agentList.querySelectorAll(".agent-editor-card")).indexOf(card);
    if (index >= 0) {
      assistantSelected = false;
      selectedAgentIndex = index;
      applySelection();
    }
  } else if (invalid.closest("#assistant")) {
    assistantSelected = true;
    applySelection();
  }
  invalid.focus();
}

function workspaceEffectivePath(): string {
  const typed = workspacePath.value.trim();
  return typed.length === 0 ? workspace.trim() : typed;
}

function agentFollowsWorkspace(agent: AgentDraft): boolean {
  return (agent.cwd ?? "").trim().length === 0;
}

function assistantFollowsWorkspace(): boolean {
  return (assistant.brain.cwd ?? "").trim().length === 0;
}

function updateWorkspaceHint(): void {
  const followed =
    agents.filter(agentFollowsWorkspace).length + (assistantFollowsWorkspace() ? 1 : 0);
  const total = agents.length + 1;
  const target = workspaceEffectivePath();
  const shown = workspaceDisplay || target;
  workspaceHint.textContent =
    shown.length === 0
      ? "未设置工作目录：每个 Agent 使用自己的 cwd（都留空则用配置文件所在目录）。"
      : `${shown} · ${followed}/${total} 个角色跟随；改动要重启 AIChatLink 才对原生 CLI 生效。其他目录在房间输入器的「＋ 工作目录」里管理。`;
  workspaceHint.title = shown;
}

function renderWorkspaceListing(): void {
  const listing = workspaceListing;
  if (listing === undefined) return;
  workspaceDialogPath.textContent = listing.path;
  workspaceDialogPath.title = listing.path;
  workspaceUp.disabled = listing.parent === null;
  workspaceConfirm.disabled = false;
  workspaceShortcuts.replaceChildren();
  for (const shortcut of listing.shortcuts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-chip";
    button.textContent = shortcut.name;
    button.title = shortcut.path;
    button.addEventListener("click", () => void loadWorkspaceListing(shortcut.path));
    workspaceShortcuts.append(button);
  }
  workspaceShortcuts.hidden = listing.shortcuts.length === 0;
  workspaceEntries.replaceChildren();
  if (listing.entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "workspace-empty";
    empty.textContent = "这里没有子目录；可以直接使用当前文件夹。";
    workspaceEntries.append(empty);
  }
  for (const entry of listing.entries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-entry";
    button.title = entry.path;
    const name = document.createElement("span");
    name.textContent = entry.name;
    button.append(name);
    if (entry.isRepository) {
      const badge = document.createElement("span");
      badge.className = "workspace-badge";
      badge.textContent = "git";
      button.append(badge);
    }
    button.addEventListener("click", () => void loadWorkspaceListing(entry.path));
    item.append(button);
    workspaceEntries.append(item);
  }
  workspaceDialogStatus.textContent = listing.truncated
    ? `目录过多：仅显示前 ${listing.entries.length} 项`
    : `${listing.entries.length} 个子目录`;
}

async function loadWorkspaceListing(target?: string): Promise<void> {
  if (workspaceLoading) return;
  workspaceLoading = true;
  workspaceDialogStatus.textContent = "正在读取目录…";
  try {
    const query = new URLSearchParams();
    const requested = target ?? (workspaceEffectivePath() || workspaceListing?.path || "");
    if (requested.length > 0) query.set("path", requested);
    const suffix = query.toString().length === 0 ? "" : `?${query.toString()}`;
    const response = await fetch(`/api/setup/workspace${suffix}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(await readError(response));
    workspaceListing = await response.json() as WorkspaceListing;
    renderWorkspaceListing();
  } catch (error) {
    workspaceDialogStatus.textContent = error instanceof Error ? error.message : "无法读取目录";
  } finally {
    workspaceLoading = false;
  }
}

function applyWorkspace(path: string): void {
  workspace = path;
  workspacePath.value = path;
  workspaceDisplay = path;
  updateWorkspaceHint();
  for (const input of agentList.querySelectorAll<HTMLInputElement>(".agent-cwd")) {
    if (input.disabled) input.placeholder = path;
  }
}

function openWorkspaceDialog(): void {
  workspaceConfirm.disabled = true;
  workspaceListing = undefined;
  workspaceEntries.replaceChildren();
  workspaceShortcuts.replaceChildren();
  if (typeof workspaceDialog.showModal === "function") workspaceDialog.showModal();
  else workspaceDialog.setAttribute("open", "");
  void loadWorkspaceListing(workspaceEffectivePath() || undefined);
}

function closeWorkspaceDialog(): void {
  if (typeof workspaceDialog.close === "function") workspaceDialog.close();
  else workspaceDialog.removeAttribute("open");
}

async function revealWorkspace(): Promise<void> {
  const target = workspaceEffectivePath();
  if (target.length === 0) {
    showError("先填写或选择一个工作目录，才能在资源管理器中打开。");
    return;
  }
  try {
    const response = await fetch("/api/setup/workspace/reveal", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-aichatlink-setup": "1"
      },
      body: JSON.stringify({ path: target })
    });
    if (!response.ok) throw new Error(await readError(response));
    workspaceHint.textContent = `已在资源管理器中打开：${target}`;
  } catch (error) {
    showError(error instanceof Error ? error.message : "无法打开资源管理器");
  }
}

function renderAgents(): void {
  agentList.replaceChildren();
  agents.forEach((agent, index) => {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const card = fragment.querySelector<HTMLElement>(".agent-editor-card");
    if (!card) throw new Error("Invalid Agent card template");
    const driverInput = card.querySelector<HTMLSelectElement>(".agent-driver");
    const idInput = card.querySelector<HTMLInputElement>(".agent-id");
    const nameInput = card.querySelector<HTMLInputElement>(".agent-name");
    const identityInput = card.querySelector<HTMLTextAreaElement>(".agent-identity");
    const modelInput = card.querySelector<HTMLInputElement>(".agent-model");
    const thinkingInput = card.querySelector<HTMLSelectElement>(".agent-thinking");
    const piConfigInput = card.querySelector<HTMLSelectElement>(".agent-pi-config");
    const piConfigHint = card.querySelector<HTMLElement>(".agent-pi-config-hint");
    const modelHint = card.querySelector<HTMLElement>(".agent-model-hint");
    const cwdInput = card.querySelector<HTMLInputElement>(".agent-cwd");
    const cwdFollowInput = card.querySelector<HTMLInputElement>(".agent-cwd-follow");
    const commandInput = card.querySelector<HTMLInputElement>(".agent-command");
    const entrypointInput = card.querySelector<HTMLInputElement>(".agent-entrypoint");
    const enabledInput = card.querySelector<HTMLInputElement>(".agent-enabled");
    const removeButton = card.querySelector<HTMLButtonElement>(".remove-agent");
    if (!driverInput || !idInput || !nameInput || !identityInput || !modelInput || !thinkingInput || !piConfigInput || !modelHint || !cwdInput || !cwdFollowInput || !commandInput || !entrypointInput || !enabledInput || !removeButton) {
      throw new Error("Incomplete Agent card template");
    }

    driverInput.value = agent.driver;
    const probeBadge = card.querySelector<HTMLElement>(".driver-probe");
    if (probeBadge) {
      const found = driverProbeState.get(agent.driver);
      probeBadge.textContent = found === undefined ? "" : found ? "已找到" : "未找到";
      probeBadge.dataset.found = found === undefined ? "unknown" : String(found);
      probeBadge.title = `${DRIVER_META[agent.driver].label}：${found === undefined ? "未探测" : found ? "本机命令可用" : "本机未找到命令"}`;
    }
    idInput.value = agent.id;
    nameInput.value = agent.name;
    identityInput.value = agent.identity ?? "";
    const meta = DRIVER_META[agent.driver];
    const levels = THINKING_LEVELS[agent.driver];
    modelInput.value = agent.model ?? "";
    modelInput.disabled = !meta.model;
    thinkingInput.replaceChildren();
    thinkingInput.append(new Option("驱动默认", ""));
    for (const level of levels) thinkingInput.append(new Option(level, level));
    if ((agent.thinking ?? "").length > 0 && !levels.includes(agent.thinking ?? "")) {
      thinkingInput.append(new Option(`${agent.thinking}（该 driver 不支持）`, agent.thinking ?? ""));
    }
    thinkingInput.value = agent.thinking ?? "";
    thinkingInput.disabled = levels.length === 0;
    piConfigInput.value = agent.piConfig ?? "isolated";
    piConfigInput.disabled = agent.driver !== "pi";
    if (piConfigHint) {
      piConfigHint.textContent =
        agent.driver === "pi"
          ? "共享后房间沿用本机 pi 的 settings / 扩展 / 子 agent 名册；MCP 绑定仍按 Agent 隔离。"
          : "仅 driver = pi RPC 时生效";
    }
    const modelLabel = card.querySelector<HTMLElement>(".model-label");
    if (modelLabel) {
      modelLabel.textContent = meta.model ? "留空即跟随 CLI / CC Switch" : "由原生 CLI 决定";
    }
    const catalog = catalogsForAgent(agent);
    const modelListId = `agent-model-list-${index}`;
    const modelList = document.createElement("datalist");
    modelList.id = modelListId;
    for (const value of catalog?.models ?? []) modelList.append(new Option(value, value));
    card.append(modelList);
    modelInput.setAttribute("list", modelListId);
    if (!meta.model) {
      const stored = (agent.model ?? "").trim();
      modelInput.placeholder = "该 driver 不支持在 AIChatLink 侧指定模型";
      modelHint.textContent = stored.length === 0
        ? "模型与思考强度由原生 CLI / 账号设置决定"
        : `已保存的 ${stored} 不会生效：该 driver 由原生 CLI / 账号决定`;
    } else {
      modelInput.placeholder =
        catalog?.defaultModel === undefined
          ? "留空 = 用 CLI / CC Switch 当前默认"
          : `留空 = ${catalog.defaultModel}`;
      modelHint.textContent = catalog === undefined
        ? "该驱动未暴露模型列表，可直接填模型 id"
        : [
            catalog.provider === undefined ? undefined : `CC Switch：${catalog.provider}`,
            catalog.note
          ].filter(Boolean).join(" · ") || `来源：${catalog.source}`;
    }
    const follows = agentFollowsWorkspace(agent);
    cwdFollowInput.checked = follows;
    cwdInput.disabled = follows;
    cwdInput.value = follows ? "" : agent.cwd ?? "";
    cwdInput.placeholder = follows
      ? workspaceEffectivePath() || "跟随房间工作目录"
      : "D:/MyProject 或 .";
    commandInput.value = agent.command.executable;
    entrypointInput.value = agent.command.prefixArgs[0] ?? "";
    enabledInput.checked = agent.enabled;
    removeButton.disabled = agents.length === 1;
    updateCardHeading(card, agent);

    driverInput.addEventListener("change", () => {
      if (!isDriver(driverInput.value)) return;
      const previous = agent.driver;
      agent.driver = driverInput.value;
      if (agent.command.executable === previous && agent.command.prefixArgs.length === 0) {
        agent.command.executable = agent.driver;
      }
      if (agent.id === previous || new RegExp(`^${previous}-\\d+$`, "u").test(agent.id)) {
        agent.id = uniqueId(agent.driver);
      }
      renderAgents();
    });
    idInput.addEventListener("input", () => {
      agent.id = idInput.value;
      validateDuplicateIds();
      updateCardHeading(card, agent);
      renderAgentMemoryCard(card, agent);
      renderNav();
    });
    nameInput.addEventListener("input", () => {
      agent.name = nameInput.value;
      updateCardHeading(card, agent);
      renderNav();
    });
    identityInput.addEventListener("input", () => {
      agent.identity = identityInput.value;
    });
    modelInput.addEventListener("input", () => {
      agent.model = modelInput.value;
      renderNav();
    });
    thinkingInput.addEventListener("change", () => {
      if (thinkingInput.value.length === 0) delete agent.thinking;
      else agent.thinking = thinkingInput.value;
    });
    piConfigInput.addEventListener("change", () => {
      if (piConfigInput.value === "shared") agent.piConfig = "shared";
      else delete agent.piConfig;
    });
    cwdFollowInput.addEventListener("change", () => {
      const follow = cwdFollowInput.checked;
      cwdInput.disabled = follow;
      if (follow) {
        delete agent.cwd;
        cwdInput.value = "";
      } else {
        agent.cwd = cwdInput.value.trim().length === 0 ? workspaceEffectivePath() || "." : cwdInput.value;
        cwdInput.value = agent.cwd;
      }
      cwdInput.placeholder = follow
        ? workspaceEffectivePath() || "跟随房间工作目录"
        : "D:/MyProject 或 .";
      updateWorkspaceHint();
    });
    cwdInput.addEventListener("input", () => {
      agent.cwd = cwdInput.value;
      updateWorkspaceHint();
    });
    commandInput.addEventListener("input", () => {
      agent.command.executable = commandInput.value;
    });
    entrypointInput.addEventListener("input", () => {
      agent.command.prefixArgs = entrypointInput.value.trim().length === 0 ? [] : [entrypointInput.value];
    });
    enabledInput.addEventListener("change", () => {
      agent.enabled = enabledInput.checked;
      card.classList.toggle("is-disabled", !agent.enabled);
      renderNav();
    });
    removeButton.addEventListener("click", () => {
      if (agents.length === 1) return;
      agents.splice(index, 1);
      if (selectedAgentIndex >= agents.length) selectedAgentIndex = agents.length - 1;
      renderAgents();
    });
    card.classList.toggle("is-disabled", !agent.enabled);
    renderAgentMemoryCard(card, agent);
    agentList.append(fragment);
  });
  validateDuplicateIds();
  renderNav();
}

function renderProbes(probes: SetupSnapshot["drivers"]): void {
  driverProbes.replaceChildren();
  driverProbeState.clear();
  for (const probe of probes) {
    driverProbeState.set(probe.driver, probe.found);
    const item = document.createElement("span");
    item.className = `probe${probe.found ? " is-found" : ""}`;
    item.textContent = `${DRIVER_META[probe.driver].label} · ${probe.found ? "已找到" : "未找到"}`;
    driverProbes.append(item);
  }
}

function showError(message: string): void {
  formError.textContent = message;
  formError.hidden = false;
  formError.scrollIntoView({ block: "nearest" });
}

function clearError(): void {
  formError.textContent = "";
  formError.hidden = true;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as ErrorResponse;
    const issues = body.error?.details?.issues
      ?.map((issue) => {
        const code = issue.code === undefined ? undefined : COMMAND_ERROR_LABELS[issue.code] ?? issue.code;
        return [issue.path, code].filter(Boolean).join(": ");
      })
      .filter((issue) => issue.length > 0);
    if (issues && issues.length > 0) return issues.join("；");
    return body.error?.message ?? `保存失败（HTTP ${response.status}）`;
  } catch {
    return `保存失败（HTTP ${response.status}）`;
  }
}

function isLoopbackOrigin(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port.length > 0;
  } catch {
    return false;
  }
}

async function waitForLaunch(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("/api/setup/launch", {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (response.ok) {
        const state = await response.json() as SetupLaunchState;
        if (state.status === "ready" && isLoopbackOrigin(state.origin)) {
          successMark.classList.remove("is-loading");
          successMark.textContent = "✓";
          successEyebrow.textContent = "AIChatLink ready";
          successTitle.textContent = "房间已启动";
          successCopy.textContent = "正在进入群聊…";
          window.location.replace(`${new URL(state.origin).origin}/`);
          return;
        }
        if (state.status === "failed") {
          successMark.classList.remove("is-loading");
          successMark.classList.add("is-error");
          successMark.textContent = "!";
          successEyebrow.textContent = "Launch failed";
          successTitle.textContent = "配置已保存，但启动失败";
          successCopy.textContent = state.message ?? "请查看终端中的诊断信息，然后运行 aichatlink start。";
          return;
        }
      }
    } catch {
      // The temporary setup server may briefly hand over to the main runtime.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
  }
  successMark.classList.remove("is-loading");
  successMark.classList.add("is-error");
  successMark.textContent = "!";
  successEyebrow.textContent = "Launch timeout";
  successTitle.textContent = "等待启动超时";
  successCopy.textContent = "配置已经保存。请查看终端诊断，或运行 aichatlink start 后进入群聊。";
}

const COMMAND_ERROR_LABELS: Readonly<Record<string, string>> = {
  executable_not_found: "未找到可执行文件",
  native_executable_not_found: "未找到原生 CLI 可执行文件",
  npm_entrypoint_not_found: "未找到全局 npm CLI 入口",
  node_runtime_not_found: "未找到可用 Node.js runtime",
  node_entrypoint_required: "Node.js 命令需要填写 CLI 入口",
  entrypoint_not_found: "未找到 Node CLI 入口",
  javascript_entrypoint_required: "CLI 入口必须是 .js/.mjs/.cjs 文件",
  prefix_args_require_node: "只有 Node.js 命令可以填写 CLI 入口",
  shell_wrapper_forbidden: "不能使用 .cmd/.bat/.ps1 shell wrapper"
};

async function loadSetup(): Promise<void> {
  try {
    const response = await fetch("/api/setup", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(await readError(response));
    snapshot = await response.json() as SetupSnapshot;
    agents = snapshot.config.agents.map(cloneAgent);
    workspace = (snapshot.config.workspace ?? "").trim();
    workspaceDisplay = snapshot.workspaceResolved ?? workspace;
    workspacePath.value = workspace;
    assistant = snapshot.config.assistant
      ? cloneAssistant(snapshot.config.assistant)
      : defaultAssistant(snapshot.drivers);
    populateModelDatalist();
    runtimeAgentIds.clear();
    for (const agent of snapshot.config.agents) runtimeAgentIds.add(agent.id);
    serverPort.value = String(snapshot.config.serverPort);
    storagePath.value = snapshot.config.storagePath;
    configPath.textContent = snapshot.configPath;
    configPath.title = snapshot.configPath;
    renderProbes(snapshot.drivers);
    renderAgents();
    fillAssistantForm();
    updateWorkspaceHint();
    if (snapshot.runtimeActive) {
      backRoom.hidden = false;
      successRoomLink.hidden = false;
    }
    if (snapshot.existingConfigError !== undefined) {
      existingBanner.textContent = snapshot.existingConfigError;
      existingBanner.hidden = false;
    }
    loadingState.hidden = true;
    form.hidden = false;
    if (window.location.hash === "#assistant") {
      assistantSelected = true;
      applySelection();
    }
    void loadAgentMemories();
  } catch (error) {
    loadingState.hidden = true;
    form.hidden = false;
    showError(error instanceof Error ? error.message : "无法读取 AIChatLink 配置");
  }
}

async function saveSetup(): Promise<void> {
  if (!snapshot || saving) return;
  clearError();
  validateDuplicateIds();
  if (!form.checkValidity()) {
    revealInvalidControl();
    form.reportValidity();
    return;
  }
  if (!agents.some((agent) => agent.enabled)) {
    showError("至少启用一个 Agent。你也可以保留其他 Agent 为停用状态。");
    return;
  }
  const port = Number(serverPort.value);
  const extra = assistantExtra.value.trim();
  const workspaceValue = workspacePath.value.trim();
  const config: ConfigDraft = {
    serverPort: port,
    ...(workspaceValue.length === 0 ? {} : { workspace: workspaceValue }),
    storagePath: storagePath.value,
    agents: agents.map(cloneAgent),
    assistant: {
      enabled: assistant.enabled,
      name: assistantName.value.trim() || "房间助理",
      brain: {
        driver: assistant.brain.driver,
        command: {
          executable: assistantCommand.value.trim() || assistant.brain.driver,
          prefixArgs: assistantEntrypoint.value.trim().length === 0 ? [] : [assistantEntrypoint.value.trim()]
        },
        ...(assistantFollowsWorkspace() || assistantCwd.value.trim().length === 0
          ? {}
          : { cwd: assistantCwd.value.trim() })
      },
      ...(extra.length === 0 ? {} : { extraInstructions: extra })
    }
  };
  saving = true;
  saveButton.disabled = true;
  saveButton.textContent = "正在验证并保存…";
  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ config })
    });
    if (!response.ok) throw new Error(await readError(response));
    const result = await response.json() as SaveResponse;
    form.hidden = true;
    successState.hidden = false;
    savedPath.textContent = result.configPath;
    savedPath.title = result.configPath;
    if (result.restartRequired) {
      successCopy.textContent = `已保存 ${result.agentCount} 个 Agent（${result.enabledAgentCount} 个启用）。返回群聊会立即显示新名册：新增 Agent 标记为等待重启，被停用的 Agent 立即不能再发送，重启 AIChatLink 后移出房间。`;
      editAgain.hidden = false;
    } else {
      successMark.textContent = "";
      successMark.classList.add("is-loading");
      successEyebrow.textContent = "Starting AIChatLink";
      successTitle.textContent = "配置已保存，正在启动房间";
      successCopy.textContent = `已保存 ${result.agentCount} 个 Agent（${result.enabledAgentCount} 个启用）。服务就绪后会自动进入群聊。`;
      editAgain.hidden = true;
      void waitForLaunch();
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "保存失败");
  } finally {
    saving = false;
    saveButton.disabled = false;
    saveButton.textContent = "保存配置";
  }
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === "dark" ? "☀" : "☾";
  themeToggle.setAttribute("aria-label", theme === "dark" ? "切换到日间模式" : "切换到夜间模式");
}

function initializeTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  applyTheme(stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light");
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSetup();
});
document.querySelectorAll<HTMLButtonElement>("[data-add-driver]").forEach((button) => {
  button.addEventListener("click", () => {
    const driver = button.dataset.addDriver;
    if (driver && isDriver(driver)) addAgent(driver);
  });
});
requiredElement<HTMLButtonElement>("add-agent").addEventListener("click", () => addAgent("codex"));

workspacePath.addEventListener("input", () => {
  workspace = workspacePath.value.trim();
  workspaceDisplay = "";
  updateWorkspaceHint();
  for (const input of agentList.querySelectorAll<HTMLInputElement>(".agent-cwd")) {
    if (input.disabled) input.placeholder = workspace || "跟随房间工作目录";
  }
  if (assistantCwd.disabled) assistantCwd.placeholder = workspace || "跟随房间工作目录";
});
workspacePick.addEventListener("click", () => openWorkspaceDialog());
workspaceReveal.addEventListener("click", () => void revealWorkspace());
workspaceUp.addEventListener("click", () => {
  if (workspaceListing?.parent) void loadWorkspaceListing(workspaceListing.parent);
});
workspaceConfirm.addEventListener("click", () => {
  if (workspaceListing === undefined) return;
  applyWorkspace(workspaceListing.path);
  closeWorkspaceDialog();
});
workspaceCancel.addEventListener("click", () => closeWorkspaceDialog());
workspaceDialogClose.addEventListener("click", () => closeWorkspaceDialog());
workspaceDialog.addEventListener("close", () => {
  workspaceLoading = false;
});
assistantEnabled.addEventListener("change", () => {
  assistant.enabled = assistantEnabled.checked;
  assistantCard.classList.toggle("is-disabled", !assistant.enabled);
  syncAssistantNav();
});
assistantName.addEventListener("input", () => {
  assistant.name = assistantName.value;
});
assistantDriver.addEventListener("change", () => {
  if (!isDriver(assistantDriver.value)) return;
  const previous = assistant.brain.driver;
  assistant.brain.driver = assistantDriver.value;
  if (assistantCommand.value === previous && assistantEntrypoint.value.trim().length === 0) {
    assistant.brain.command.executable = assistant.brain.driver;
    assistantCommand.value = assistant.brain.driver;
  }
});
assistantCwd.addEventListener("input", () => {
  const value = assistantCwd.value.trim();
  if (value.length === 0) delete assistant.brain.cwd;
  else assistant.brain.cwd = assistantCwd.value;
  updateWorkspaceHint();
});
assistantCommand.addEventListener("input", () => {
  assistant.brain.command.executable = assistantCommand.value;
});
assistantEntrypoint.addEventListener("input", () => {
  assistant.brain.command.prefixArgs = assistantEntrypoint.value.trim().length === 0
    ? []
    : [assistantEntrypoint.value.trim()];
});
assistantExtra.addEventListener("input", () => {
  const extra = assistantExtra.value.trim();
  if (extra.length === 0) {
    delete assistant.extraInstructions;
  } else {
    assistant.extraInstructions = extra;
  }
});
editAgain.addEventListener("click", () => {
  successState.hidden = true;
  form.hidden = false;
  clearError();
});


initializeTheme();
void loadSetup();
