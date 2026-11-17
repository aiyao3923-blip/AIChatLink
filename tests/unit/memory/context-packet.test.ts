import { afterEach, describe, expect, it } from "vitest";

import { AIChatLinkError } from "../../../src/core/errors.js";
import {
  ContextPacketBuilder,
  renderContextPacket
} from "../../../src/memory/context-packet.js";
import { AIChatLinkMemoryService } from "../../../src/memory/service.js";
import type { ContextPacketSections, MemoryClock } from "../../../src/memory/types.js";
import {
  appendMessage,
  cleanupMemoryTestFixtures,
  createMemoryTestFixture,
  type MemoryTestFixture
} from "./test-fixture.js";

const fixedClock: MemoryClock = { now: () => "2026-08-11T10:00:00.000Z" };

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AIChatLinkError);
    expect((error as AIChatLinkError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AIChatLinkError(${code})`);
}

function seedContext(fixture: MemoryTestFixture) {
  const root = appendMessage(fixture, {
    eventId: "evt_root",
    actorId: "user:web",
    content: "root question",
    targets: ["agent:grok"],
    occurredAt: "2026-08-11T00:01:00.000Z"
  });
  const reply = appendMessage(fixture, {
    eventId: "evt_reply",
    actorId: "agent:grok",
    content: "reply from Grok",
    targets: ["user:web"],
    replyToEventId: root.eventId,
    occurredAt: "2026-08-11T00:02:00.000Z"
  });
  const unreadOld = appendMessage(fixture, {
    eventId: "evt_unread_old",
    actorId: "agent:kimi",
    content: "older unread public message",
    occurredAt: "2026-08-11T00:03:00.000Z"
  });
  const unreadNew = appendMessage(fixture, {
    eventId: "evt_unread_new",
    actorId: "user:web",
    content: "newer unread public message",
    targets: ["agent:kimi"],
    occurredAt: "2026-08-11T00:04:00.000Z"
  });
  const current = appendMessage(fixture, {
    eventId: "evt_current",
    actorId: "user:web",
    content: "<payload>literal & unchanged</payload>",
    targets: ["agent:codex"],
    replyToEventId: reply.eventId,
    occurredAt: "2026-08-11T00:05:00.000Z"
  });
  const future = appendMessage(fixture, {
    eventId: "evt_future",
    actorId: "agent:kimi",
    content: "future message outside throughSeq",
    occurredAt: "2026-08-11T00:06:00.000Z"
  });

  fixture.store.advanceDeliveryCursor("agent:codex", "room:main", root.seq);
  const memory = new AIChatLinkMemoryService(fixture.store, fixedClock);
  memory.remember({
    memoryId: "memory_public",
    scopeType: "room",
    scopeId: "room:main",
    kind: "decision",
    authorActorId: "user:web",
    content: "Public decision",
    sourceEventId: root.eventId,
    sourceKind: "web"
  });
  memory.remember({
    memoryId: "memory_agent_codex",
    scopeType: "agent",
    scopeId: "agent:codex",
    agentMemoryType: "core",
    kind: "instruction",
    authorActorId: "user:web",
    subjectActorId: "agent:codex",
    content: "Codex private core memory",
    sourceKind: "web"
  });
  memory.remember({
    memoryId: "memory_agent_codex_dated",
    scopeType: "agent",
    scopeId: "agent:codex",
    agentMemoryType: "dated",
    kind: "note",
    authorActorId: "agent:codex",
    subjectActorId: "agent:codex",
    content: "Codex automatic dated memory",
    sourceKind: "automatic_turn"
  });
  memory.remember({
    memoryId: "memory_agent_grok",
    scopeType: "agent",
    scopeId: "agent:grok",
    agentMemoryType: "core",
    kind: "note",
    authorActorId: "user:web",
    subjectActorId: "agent:grok",
    content: "Grok-only memory",
    sourceKind: "web"
  });
  const inactive = memory.remember({
    memoryId: "memory_inactive",
    scopeType: "room",
    scopeId: "room:main",
    kind: "note",
    authorActorId: "agent:kimi",
    content: "Retracted public memory",
    sourceKind: "mcp"
  });
  memory.retract(inactive.memoryId);

  memory.rememberSelfIdentity({
    identityId: "identity_self",
    callingActorId: "agent:codex",
    kind: "preference",
    content: "Self-stated preference"
  });
  memory.rememberUserAuthoredIdentity({
    identityId: "identity_user",
    authorActorId: "user:web",
    subjectActorId: "agent:codex",
    kind: "instruction",
    content: "User-assigned room role"
  });
  memory.rememberObservedIdentity({
    identityId: "identity_observed",
    authorActorId: "agent:grok",
    subjectActorId: "agent:codex",
    content: "Grok's observation about Codex"
  });

  return { root, reply, unreadOld, unreadNew, current, future };
}

afterEach(cleanupMemoryTestFixtures);

describe("ContextPacketBuilder provenance and cursor semantics", () => {
  it("keeps durable reasoning and tool progress records out of Agent context", () => {
    const fixture = createMemoryTestFixture();
    appendMessage(fixture, {
      eventId: "evt_reasoning_history",
      actorId: "user:web",
      content: "public history"
    });
    fixture.store.appendDurableEvent({
      eventId: "evt_reasoning_record",
      roomId: "room:main",
      eventType: "turn.reasoning.recorded",
      actorId: "agent:codex",
      correlationId: "corr_reasoning_context",
      body: {
        turnId: "turn_reasoning_context",
        content: "PRIVATE_REASONING_MUST_NOT_ENTER_CONTEXT",
        terminalStatus: "completed"
      }
    });
    fixture.store.appendDurableEvent({
      eventId: "evt_tool_progress_record",
      roomId: "room:main",
      eventType: "tool.progress.recorded",
      actorId: "agent:codex",
      correlationId: "corr_reasoning_context",
      body: {
        turnId: "turn_reasoning_context",
        nativeType: "tool.completed",
        toolCallId: "call-context",
        details: { output: "PRIVATE_TOOL_PROGRESS_MUST_NOT_ENTER_CONTEXT" }
      }
    });
    const current = appendMessage(fixture, {
      eventId: "evt_reasoning_current",
      actorId: "user:web",
      content: "current request",
      targets: ["agent:codex"]
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: current,
      throughSeq: current.seq,
      maxChars: 100_000
    });

    expect(packet.text).toContain("public history");
    expect(packet.text).not.toContain("PRIVATE_REASONING_MUST_NOT_ENTER_CONTEXT");
    expect(packet.text).not.toContain("PRIVATE_TOOL_PROGRESS_MUST_NOT_ENTER_CONTEXT");
    const unreadIds = packet.sections.unreadTranscript.map((entry) => entry.id);
    expect(unreadIds).not.toContain("evt_reasoning_record");
    expect(unreadIds).not.toContain("evt_tool_progress_record");
  });

  it("builds current/reply/unread/memory/identity sections with explicit provenance", () => {
    const fixture = createMemoryTestFixture();
    const seeded = seedContext(fixture);
    const builder = new ContextPacketBuilder(fixture.store);
    const eventCount = fixture.store.countEvents();
    const memoryCount = fixture.store.searchMemory({ includeHistory: true }).length;
    const identityCount = fixture.store.readIdentity({ includeHistory: true }).length;

    const packet = builder.buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      configuredIdentity: "Stable reviewer identity from aichatlink.json",
      currentEvent: seeded.current,
      throughSeq: seeded.current.seq,
      maxChars: 100_000
    });

    expect(packet.afterSeq).toBe(seeded.root.seq);
    expect(packet.throughSeq).toBe(seeded.current.seq);
    expect(packet.charCount).toBe(packet.text.length);
    expect(packet.charCount).toBeLessThanOrEqual(packet.maxChars);
    expect(packet.text).toContain(
      "note=Final/publish wake no agent"
    );
    expect(packet.text).toContain("No coordinator or rounds");
    expect(packet.text).toContain("Active same-correlation peer: publish/read");
    expect(packet.text).toContain("send/ask only for a later turn");
    expect(packet.text).toContain("New work may route");
    expect(packet.text).not.toContain("coordinator asks/collects");
    expect(packet.sections.currentMessage).toMatchObject({
      id: "evt_current",
      authorActorId: "user:web",
      subject: "agent:codex",
      content: "<payload>literal & unchanged</payload>"
    });
    expect(packet.sections.replyChain.map((entry) => entry.id)).toEqual([
      "evt_root",
      "evt_reply"
    ]);
    expect(packet.sections.unreadTranscript.map((entry) => entry.id)).toEqual([
      "evt_unread_old",
      "evt_unread_new"
    ]);
    expect(packet.text).not.toContain("future message outside throughSeq");
    expect(packet.sections.publicMemory).toEqual([
      expect.objectContaining({
        id: "memory_public",
        authorActorId: "user:web",
        subject: "room:main",
        content: "Public decision"
      })
    ]);
    expect(packet.sections.configuredIdentity).toEqual([
      expect.objectContaining({
        id: "config:agent:codex",
        subject: "agent:codex",
        perspective: "configured",
        content: "Stable reviewer identity from aichatlink.json"
      })
    ]);
    expect(packet.sections.agentCoreMemory).toEqual([
      expect.objectContaining({
        id: "memory_agent_codex",
        subject: "agent:codex",
        content: "Codex private core memory"
      })
    ]);
    expect(packet.sections.agentDatedMemory).toEqual([
      expect.objectContaining({
        id: "memory_agent_codex_dated",
        subject: "agent:codex",
        content: "Codex automatic dated memory"
      })
    ]);
    expect(packet.text).toContain("[configured_agent_identity]");
    expect(packet.text).toContain("[agent_core_memory]");
    expect(packet.text).toContain("[agent_dated_memory]");
    expect(packet.text).not.toContain("Grok-only memory");
    expect(packet.text).not.toContain("Retracted public memory");

    expect(packet.sections.selfIdentity).toEqual([
      expect.objectContaining({
        id: "identity_self",
        authorActorId: "agent:codex",
        subject: "agent:codex",
        perspective: "self"
      })
    ]);
    expect(packet.sections.userAuthoredIdentity).toEqual([
      expect.objectContaining({
        id: "identity_user",
        authorActorId: "user:web",
        subject: "agent:codex",
        perspective: "user-authored"
      })
    ]);
    expect(packet.sections.observedIdentity).toEqual([
      expect.objectContaining({
        id: "identity_observed",
        authorActorId: "agent:grok",
        subject: "agent:codex",
        perspective: "observed"
      })
    ]);
    expect(packet.text).toContain("[observed_identity]");
    expect(packet.text).toContain(
      "author=agent:grok subject=agent:codex source=adapter;record=identity_observed"
    );
    expect(packet.text).toContain("<payload>literal & unchanged</payload>");

    // Context construction is read-only and cannot promote chat into memory.
    expect(fixture.store.countEvents()).toBe(eventCount);
    expect(fixture.store.searchMemory({ includeHistory: true })).toHaveLength(memoryCount);
    expect(fixture.store.readIdentity({ includeHistory: true })).toHaveLength(identityCount);
  });

  it("supports an explicit currentMessage without persisting or rewriting it", () => {
    const fixture = createMemoryTestFixture();
    const seeded = seedContext(fixture);
    const builder = new ContextPacketBuilder(fixture.store);
    const beforeEvents = fixture.store.countEvents();
    const content = "direct plain text <not-sanitized>";

    const packet = builder.buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:kimi",
      currentMessage: {
        authorActorId: "user:web",
        authorDisplayName: "You",
        content,
        sourceKind: "web",
        replyToEventId: seeded.root.eventId
      },
      throughSeq: seeded.future.seq,
      maxChars: 100_000
    });

    expect(packet.sections.currentMessage).toMatchObject({
      id: "current_message",
      authorActorId: "user:web",
      authorDisplayName: "You",
      content
    });
    expect(packet.sections.replyChain.map((entry) => entry.id)).toEqual(["evt_root"]);
    expect(packet.text).toContain(content);
    expect(fixture.store.countEvents()).toBe(beforeEvents);
  });

  it("does not duplicate automatic dated memory while its response is already in transcript", () => {
    const fixture = createMemoryTestFixture();
    const seeded = seedContext(fixture);
    const memory = new AIChatLinkMemoryService(fixture.store, fixedClock);
    memory.remember({
      memoryId: "memory_dated_duplicate",
      scopeType: "agent",
      scopeId: "agent:codex",
      agentMemoryType: "dated",
      kind: "note",
      authorActorId: "agent:codex",
      subjectActorId: "agent:codex",
      content: "duplicate of unread response",
      sourceEventId: "evt_unread_new",
      sourceKind: "automatic_turn"
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: seeded.current,
      throughSeq: seeded.current.seq,
      maxChars: 100_000
    });

    expect(packet.sections.unreadTranscript.map((entry) => entry.id)).toContain(
      "evt_unread_new"
    );
    expect(packet.sections.agentDatedMemory.map((entry) => entry.id)).not.toContain(
      "memory_dated_duplicate"
    );
  });

  it("keeps a semantic daily rollup eligible even when its latest response is still unread", () => {
    const fixture = createMemoryTestFixture();
    const seeded = seedContext(fixture);
    const memory = new AIChatLinkMemoryService(fixture.store, fixedClock);
    memory.remember({
      memoryId: "memory_daily_rollup",
      scopeType: "agent",
      scopeId: "agent:codex",
      agentMemoryType: "dated",
      kind: "summary",
      authorActorId: "agent:codex",
      subjectActorId: "agent:codex",
      content: "semantic facts from several successful Turns",
      sourceEventId: "evt_unread_new",
      sourceKind: "automatic_rollup"
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: seeded.current,
      throughSeq: seeded.current.seq,
      maxChars: 100_000
    });

    expect(packet.sections.unreadTranscript.map((entry) => entry.id)).toContain("evt_unread_new");
    expect(packet.sections.agentDatedMemory.map((entry) => entry.id)).toContain(
      "memory_daily_rollup"
    );
  });
});

describe("ContextPacketBuilder deterministic budget", () => {
  it("keeps current message and the complete reply chain, then omits lower-priority entries", () => {
    const fixture = createMemoryTestFixture();
    const seeded = seedContext(fixture);
    const builder = new ContextPacketBuilder(fixture.store);
    const full = builder.buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: seeded.current,
      throughSeq: seeded.current.seq,
      maxChars: 100_000
    });
    const mandatorySections: ContextPacketSections = {
      configuredIdentity: [],
      selfIdentity: [],
      userAuthoredIdentity: [],
      observedIdentity: [],
      agentCoreMemory: [],
      agentDatedMemory: [],
      publicMemory: [],
      generatedSummary: [],
      resumedTranscript: [],
      unreadTranscript: [],
      replyChain: full.sections.replyChain,
      currentMessage: full.sections.currentMessage
    };
    const mandatoryText = renderContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      afterSeq: seeded.root.seq,
      throughSeq: seeded.current.seq,
      sections: mandatorySections
    });

    const constrained = builder.buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: seeded.current,
      throughSeq: seeded.current.seq,
      maxChars: mandatoryText.length
    });
    expect(constrained.text).toBe(mandatoryText);
    expect(constrained.sections.replyChain.map((entry) => entry.id)).toEqual([
      "evt_root",
      "evt_reply"
    ]);
    expect(constrained.sections.currentMessage.content).toBe(
      "<payload>literal & unchanged</payload>"
    );
    expect(constrained.sections.unreadTranscript).toEqual([]);
    expect(constrained.sections.publicMemory).toEqual([]);
    expect(constrained.sections.selfIdentity).toEqual([]);
    expect(constrained.omitted).toEqual({
      selfIdentity: 1,
      userAuthoredIdentity: 1,
      observedIdentity: 1,
      agentCoreMemory: 1,
      agentDatedMemory: 1,
      publicMemory: 1,
      generatedSummary: 0,
      resumedTranscript: 0,
      unreadTranscript: 2
    });

    expectCode(
      () =>
        builder.buildContextPacket({
          roomId: "room:main",
          targetActorId: "agent:codex",
          currentEvent: seeded.current,
          throughSeq: seeded.current.seq,
          maxChars: mandatoryText.length - 1
        }),
      "CONTEXT_BUDGET_EXCEEDED"
    );
  });

  it("selects core memory before dated memory, transcript, public memory and identity", () => {
    const fixture = createMemoryTestFixture();
    const seeded = seedContext(fixture);
    const builder = new ContextPacketBuilder(fixture.store);
    const full = builder.buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: seeded.current,
      throughSeq: seeded.current.seq,
      maxChars: 100_000
    });
    const coreMemory = full.sections.agentCoreMemory[0]!;
    const oneCoreText = renderContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      afterSeq: seeded.root.seq,
      throughSeq: seeded.current.seq,
      sections: {
        configuredIdentity: [],
        selfIdentity: [],
        userAuthoredIdentity: [],
        observedIdentity: [],
        agentCoreMemory: [coreMemory],
        agentDatedMemory: [],
        publicMemory: [],
        generatedSummary: [],
        resumedTranscript: [],
        unreadTranscript: [],
        replyChain: full.sections.replyChain,
        currentMessage: full.sections.currentMessage
      }
    });

    const packet = builder.buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: seeded.current,
      throughSeq: seeded.current.seq,
      maxChars: oneCoreText.length
    });
    expect(packet.sections.agentCoreMemory.map((entry) => entry.id)).toEqual([
      "memory_agent_codex"
    ]);
    expect(packet.sections.agentDatedMemory).toEqual([]);
    expect(packet.sections.unreadTranscript).toEqual([]);
    expect(packet.sections.publicMemory).toEqual([]);
    expect(packet.sections.selfIdentity).toEqual([]);
    expect(packet.text).toBe(oneCoreText);
  });
});

describe("ContextPacketBuilder resumed conversations", () => {
  it("replays the closed range as seeded context and never as unread transcript", () => {
    const fixture = createMemoryTestFixture();
    const first = appendMessage(fixture, {
      eventId: "evt_resume_first",
      actorId: "user:web",
      content: "first task",
      targets: ["agent:codex"]
    });
    appendMessage(fixture, {
      eventId: "evt_resume_answer",
      actorId: "agent:codex",
      content: "first answer",
      targets: ["user:web"]
    });
    const last = appendMessage(fixture, {
      eventId: "evt_resume_followup",
      actorId: "user:web",
      content: "follow-up question",
      targets: ["agent:codex"]
    });
    fixture.store.recordContextReset({ roomId: "room:main", throughSeq: last.seq });
    const other = appendMessage(fixture, {
      eventId: "evt_resume_other",
      actorId: "user:web",
      content: "unrelated later conversation",
      targets: ["agent:codex"]
    });
    const boundary = fixture.store.recordContextReset({
      roomId: "room:main",
      throughSeq: other.seq,
      resume: { conversationId: "conv:1", fromSeq: first.seq, throughSeq: last.seq }
    });
    const current = appendMessage(fixture, {
      eventId: "evt_resume_current",
      actorId: "user:web",
      content: "continue that task",
      targets: ["agent:codex"]
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: current,
      throughSeq: current.seq,
      maxChars: 100_000
    });

    expect(packet.resumedConversation).toEqual({
      conversationId: "conv:1",
      fromSeq: first.seq,
      throughSeq: last.seq
    });
    expect(packet.sections.resumedTranscript.map((entry) => entry.id)).toEqual([
      "evt_resume_first",
      "evt_resume_answer",
      "evt_resume_followup"
    ]);
    expect(packet.sections.unreadTranscript).toEqual([]);
    expect(packet.text).toContain("[resumed_conversation]");
    expect(packet.text).toContain("first task");
    expect(packet.text).toContain(`resumed_range=${first.seq}-${last.seq}`);
    expect(packet.text).not.toContain("unrelated later conversation");
    expect(packet.omitted.resumedTranscript).toBe(0);
    expect(boundary.resume?.conversationId).toBe("conv:1");

    // A later plain reset drops the seed: the epoch no longer continues it.
    fixture.store.recordContextReset({ roomId: "room:main", throughSeq: current.seq });
    const afterReset = appendMessage(fixture, {
      eventId: "evt_resume_after_reset",
      actorId: "user:web",
      content: "brand new start",
      targets: ["agent:codex"]
    });
    const fresh = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: afterReset,
      throughSeq: afterReset.seq,
      maxChars: 100_000
    });
    expect(fresh.resumedConversation).toBeUndefined();
    expect(fresh.sections.resumedTranscript).toEqual([]);
    expect(fresh.text).not.toContain("[resumed_conversation]");
  });

  it("drops seed entries under budget pressure and reports how many were omitted", () => {
    const fixture = createMemoryTestFixture();
    const first = appendMessage(fixture, {
      eventId: "evt_resume_big_1",
      actorId: "user:web",
      content: `huge seed one ${"s".repeat(2_000)}`
    });
    const last = appendMessage(fixture, {
      eventId: "evt_resume_big_2",
      actorId: "agent:codex",
      content: `huge seed two ${"t".repeat(2_000)}`
    });
    const other = appendMessage(fixture, {
      eventId: "evt_resume_small_other",
      actorId: "user:web",
      content: "a later conversation before resuming"
    });
    fixture.store.recordContextReset({
      roomId: "room:main",
      throughSeq: other.seq,
      resume: { conversationId: "conv:1", fromSeq: first.seq, throughSeq: last.seq }
    });
    const current = appendMessage(fixture, {
      eventId: "evt_resume_small_current",
      actorId: "user:web",
      content: "continue",
      targets: ["agent:codex"]
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: current,
      throughSeq: current.seq,
      maxChars: 800
    });

    expect(packet.sections.resumedTranscript).toEqual([]);
    expect(packet.omitted.resumedTranscript).toBe(2);
    expect(packet.text).toContain("resume_omitted=2");
  });
});

describe("ContextPacketBuilder durable room checkpoint", () => {
  it("injects an active summary and reads transcript only after its boundary", () => {
    const fixture = createMemoryTestFixture();
    const old = appendMessage(fixture, {
      eventId: "evt_summary_old",
      actorId: "user:web",
      content: "old transcript represented by checkpoint"
    });
    const boundary = appendMessage(fixture, {
      eventId: "evt_summary_boundary",
      actorId: "agent:grok",
      content: "last compacted message"
    });
    const recent = appendMessage(fixture, {
      eventId: "evt_summary_recent",
      actorId: "agent:kimi",
      content: "recent uncompressed message"
    });
    const current = appendMessage(fixture, {
      eventId: "evt_summary_current",
      actorId: "user:web",
      content: "current request",
      targets: ["agent:codex"]
    });
    fixture.store.replaceActiveSummary({
      summaryId: "summary:context",
      roomId: "room:main",
      fromSeq: old.seq,
      throughSeq: boundary.seq,
      content: "Checkpoint preserves the important old decision.",
      generatorActorId: "agent:grok"
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      currentEvent: current,
      throughSeq: current.seq,
      maxChars: 100_000
    });
    expect(packet.schema).toBe("aichatlink.context/0.5");
    expect(packet.sections.generatedSummary).toEqual([
      expect.objectContaining({
        id: "summary:context",
        entryType: "summary",
        seq: boundary.seq,
        content: "Checkpoint preserves the important old decision."
      })
    ]);
    expect(packet.sections.unreadTranscript.map((entry) => entry.id)).toEqual([
      recent.eventId
    ]);
    expect(packet.text).toContain("[room_checkpoint_summary]");
    expect(packet.text).not.toContain("old transcript represented by checkpoint");
  });
});
