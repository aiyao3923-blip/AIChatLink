import { describe, expect, it } from "vitest";

import { disabledConfiguredActorIds, pendingConfiguredAgents } from "../../../web/agent-roster.js";

describe("pendingConfiguredAgents", () => {
  it("projects a newly saved enabled agent without replacing the active runtime roster", () => {
    const pending = pendingConfiguredAgents(
      {
        config: {
          agents: [
            { id: "codex", name: "Codex", cwd: "D:/AIChatLink", enabled: true },
            { id: "reviewer", name: "Review Agent", cwd: "D:/Review", enabled: true }
          ]
        }
      },
      new Set(["agent:codex"])
    );

    expect(pending).toEqual([
      {
        actorId: "agent:reviewer",
        displayName: "Review Agent",
        status: "pending_restart",
        driver: "",
        cwd: "D:/Review",
        enabled: true,
        capabilities: []
      }
    ]);
  });

  it("ignores disabled, malformed, duplicate and already active entries", () => {
    const pending = pendingConfiguredAgents(
      {
        config: {
          agents: [
            { id: "codex", enabled: true },
            { id: "disabled", enabled: false },
            { id: "bad id", enabled: true },
            { id: "new-agent", name: "", cwd: ".", enabled: true },
            { id: "new-agent", name: "Latest", cwd: "D:/Latest", enabled: true }
          ]
        }
      },
      new Set(["agent:codex"])
    );

    expect(pending).toEqual([
      expect.objectContaining({
        actorId: "agent:new-agent",
        displayName: "Latest",
        cwd: "D:/Latest"
      })
    ]);
  });

  it("fails closed to an empty projection for an invalid setup response", () => {
    expect(pendingConfiguredAgents({ config: { agents: "invalid" } }, new Set())).toEqual([]);
  });
});

describe("disabledConfiguredActorIds", () => {
  it("reports live agents the saved roster no longer enables", () => {
    const disabled = disabledConfiguredActorIds(
      {
        existing: true,
        config: {
          agents: [
            { id: "pi-architect", enabled: true },
            { id: "reviewer", enabled: false },
            { id: "grok", enabled: false }
          ]
        }
      },
      ["agent:pi-architect", "agent:reviewer", "agent:grok"]
    );

    expect([...(disabled ?? [])].sort()).toEqual(["agent:grok", "agent:reviewer"]);
  });

  it("treats a live agent dropped from the roster as disabled", () => {
    const disabled = disabledConfiguredActorIds(
      { existing: true, config: { agents: [{ id: "codex", enabled: true }] } },
      ["agent:codex", "agent:retired"]
    );

    expect([...(disabled ?? [])]).toEqual(["agent:retired"]);
  });

  it("keeps every live agent when the snapshot cannot answer", () => {
    expect(
      disabledConfiguredActorIds({ existing: true, config: { agents: "invalid" } }, ["agent:codex"])
    ).toBeUndefined();
    expect(disabledConfiguredActorIds(undefined, ["agent:codex"])).toBeUndefined();
    expect(
      disabledConfiguredActorIds({ existing: true, config: { agents: [] } }, ["agent:codex"])
    ).toBeUndefined();
    expect(
      disabledConfiguredActorIds({ existing: false, config: { agents: [{ id: "codex", enabled: false }] } }, [
        "agent:codex"
      ])
    ).toBeUndefined();
    expect(
      disabledConfiguredActorIds(
        {
          existing: true,
          existingConfigError: "unparsable",
          config: { agents: [{ id: "codex", enabled: false }] }
        },
        ["agent:codex"]
      )
    ).toBeUndefined();
  });

  it("re-enabling after a save puts the live agent back in the roster", () => {
    const snapshot = { existing: true, config: { agents: [{ id: "codex", enabled: true }] } };
    expect([...(disabledConfiguredActorIds(snapshot, ["agent:codex"]) ?? [])]).toEqual([]);
  });
});
