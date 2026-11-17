#!/usr/bin/env node
// R12 acceptance: an in-flight turn must stop well inside AIChatLink's 10 s cancel
// timeout, and must settle as `cancelled` rather than `failed` or `completed`.
const BASE = process.env.AICHATLINK_BASE ?? "http://127.0.0.1:4310";
const target = process.env.INTERRUPT_TARGET ?? "agent:pi-architect";

const post = async (path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
const bootstrap = async () => (await fetch(`${BASE}/api/bootstrap`)).json();

const accepted = await post("/api/messages", {
  clientCommandId: `interrupt-${Date.now()}`,
  to: [target],
  content: "请用 bash 工具执行 sleep 30，等它结束后再回答 OK。必须真的执行这条命令。",
});
const turnId = accepted.turns[0].turnId;
console.log(`turn ${turnId} accepted`);

// Let the native turn actually start before cancelling.
await new Promise((resolve) => setTimeout(resolve, 3_000));
const startedAt = Date.now();
const cancel = await post(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
  clientCommandId: `interrupt-cancel-${Date.now()}`,
});
console.log("cancel accepted:", JSON.stringify(cancel));

let status = "unknown";
for (let attempt = 0; attempt < 60; attempt += 1) {
  const data = await bootstrap();
  const event = data.recentEvents.find(
    (candidate) => candidate.body?.turnId === turnId && candidate.type.startsWith("turn."),
  );
  const active = data.activeTurns.find((candidate) => candidate.turnId === turnId);
  if (active) status = active.status;
  const terminal = data.recentEvents.filter(
    (candidate) =>
      candidate.body?.turnId === turnId &&
      ["turn.completed", "turn.cancelled", "turn.failed"].includes(candidate.type),
  );
  if (terminal.length > 0) status = terminal[terminal.length - 1].type.replace("turn.", "");
  if (["cancelled", "failed", "completed"].includes(status)) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const elapsed = Date.now() - startedAt;
console.log(`final status: ${status}`);
console.log(`elapsed after cancel request: ${elapsed} ms`);
console.log(elapsed < 10_000 && status === "cancelled" ? "PASS" : "FAIL");
