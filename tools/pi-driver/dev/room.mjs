#!/usr/bin/env node
// Dev helper for the pi-driver acceptance runs (S3-S7).
//
//   node dev/room.mjs send pi-architect "问题"
//   node dev/room.mjs send-all "问题"            (all pi roles)
//   node dev/room.mjs watch [seconds]            (poll bootstrap)
//   node dev/room.mjs events [sinceSeq]
//
// It only talks to the loopback REST API; it never touches the database.
const BASE = process.env.AICHATLINK_BASE ?? "http://127.0.0.1:4310";
const PI_ROLES = ["agent:pi-architect", "agent:pi-reviewer", "agent:pi-contrarian"];

const [, , command = "watch", ...rest] = process.argv;

async function json(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 400)}`);
  return text.length === 0 ? null : JSON.parse(text);
}

function summarize(event) {
  const body = event.body ?? {};
  const kind = body.kind ?? body.status ?? "";
  const actor =
    typeof event.actor === "string" ? event.actor : (event.actor?.actorId ?? "");
  const text = body.content ?? body.text ?? body.reason ?? "";
  const extra = body.status ?? (body.turnId ? String(body.turnId).slice(0, 14) : "");
  return `${String(event.seq).padStart(3)} ${String(actor).padEnd(20)} ${String(event.type).padEnd(26)} ${String(kind).padEnd(10)} ${String(extra).padEnd(14)} ${String(text).replace(/\s+/g, " ").slice(0, 110)}`;
}

async function send(targets, text) {
  const body = {
    clientCommandId: `dev-${Date.now()}`,
    to: targets,
    content: text,
  };
  const accepted = await json("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("accepted:", JSON.stringify(accepted));
  return accepted;
}

async function main() {
  if (command === "send") {
    const [target, ...words] = rest;
    await send([target.startsWith("agent:") ? target : `agent:${target}`], words.join(" "));
  } else if (command === "send-all") {
    await send(PI_ROLES, rest.join(" "));
  } else if (command === "events") {
    const since = Number(rest[0] ?? 0);
    const data = await json("/api/bootstrap");
    for (const event of data.recentEvents) if (event.seq > since) console.log(summarize(event));
    console.log(`throughSeq=${data.throughSeq} activeTurns=${JSON.stringify(data.activeTurns.map((t) => [t.target, t.status]))}`);
  } else {
    const seconds = Number(rest[0] ?? 30);
    const started = Date.now();
    let lastSeq = 0;
    while (Date.now() - started < seconds * 1000) {
      const data = await json("/api/bootstrap");
      for (const event of data.recentEvents) if (event.seq > lastSeq) console.log(summarize(event));
      if (data.recentEvents.length > 0) lastSeq = Math.max(lastSeq, data.recentEvents[data.recentEvents.length - 1].seq);
      const turns = data.activeTurns.map((turn) => `${turn.target}:${turn.status}`);
      process.stdout.write(`\r[${((Date.now() - started) / 1000).toFixed(1)}s] seq=${data.throughSeq} turns=${turns.join(",") || "-"}   `);
      if (turns.length === 0 && data.recentEvents.length > 0 && Date.now() - started > 4000) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    process.stdout.write("\n");
  }
}

await main();
