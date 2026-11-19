import { describe, expect, it } from "vitest";

import {
  DRAFT_STORAGE_PREFIX,
  draftScopeFrom,
  draftStorageKey,
  readDraft,
  writeDraft
} from "../../../web/draft-scope.js";

/** A `sessionStorage` stand-in that records the exact keys written. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key)
  };
}

describe("composer draft scope", () => {
  it("scopes a draft to the workspace and the conversation on screen", () => {
    const live = draftScopeFrom("");
    expect(live).toEqual({ workspace: "primary", conversation: "live" });
    expect(draftStorageKey(live)).toBe(`${DRAFT_STORAGE_PREFIX}:primary:live`);

    const other = draftScopeFrom("?ws=ws_abc&conv=conv%3A12");
    expect(other).toEqual({ workspace: "ws_abc", conversation: "conv:12" });
    expect(draftStorageKey(other)).not.toBe(draftStorageKey(live));
  });

  it("keeps each view's text where it was typed", () => {
    const storage = memoryStorage();
    const roomA = draftScopeFrom("?ws=ws_a");
    const roomB = draftScopeFrom("?ws=ws_b");

    writeDraft(storage, roomA, "在 A 写的半句话");
    // Room B's composer must start empty: it has its own key, not the tab's.
    expect(readDraft(storage, roomB)).toBe("");
    // Coming back to A restores exactly what was there.
    expect(readDraft(storage, roomA)).toBe("在 A 写的半句话");

    writeDraft(storage, roomB, "B 的草稿");
    expect(readDraft(storage, roomA)).toBe("在 A 写的半句话");
    expect(readDraft(storage, roomB)).toBe("B 的草稿");
  });

  it("separates the live epoch from a replayed conversation in the same room", () => {
    const storage = memoryStorage();
    const live = draftScopeFrom("");
    const replay = draftScopeFrom("?conv=conv%3A3");

    writeDraft(storage, live, "live draft");
    expect(readDraft(storage, replay)).toBe("");
    writeDraft(storage, replay, "replay draft");
    expect(readDraft(storage, live)).toBe("live draft");
  });

  it("drops the key for an empty draft so nothing can be inherited later", () => {
    const storage = memoryStorage();
    const scope = draftScopeFrom("?ws=ws_a");
    writeDraft(storage, scope, "text");
    writeDraft(storage, scope, "");
    expect(storage.map.size).toBe(0);
    expect(readDraft(storage, scope)).toBe("");
  });

  it("survives a storage that refuses to read or write", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      }
    };
    const scope = draftScopeFrom("");
    expect(readDraft(broken, scope)).toBe("");
    expect(() => writeDraft(broken, scope, "x")).not.toThrow();
  });
});
