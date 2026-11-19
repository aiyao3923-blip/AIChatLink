/**
 * Draft identity for the composer.
 *
 * A draft belongs to the view the cursor is in — the workspace (room) plus the
 * conversation on screen, or `live` for the open epoch — not to the browser tab.
 * Deriving the scope from the URL is what makes a reload and a workspace switch
 * agree: no view can inherit another view's unsent text, and returning to a view
 * restores exactly what was typed there. Keeping this as a pure function means
 * the rule can be tested without a browser, like the busy lock (D-050).
 */

export interface DraftScope {
  readonly workspace: string;
  readonly conversation: string;
}

export const DRAFT_STORAGE_PREFIX = "aichatlink:draft";

/** The two URL parameters that identify a view: `?ws=` and `?conv=`. */
export function draftScopeFrom(search: string): DraftScope {
  const params = new URLSearchParams(search);
  return {
    workspace: params.get("ws") ?? "primary",
    conversation: params.get("conv") ?? "live"
  };
}

export function draftStorageKey(scope: DraftScope): string {
  return `${DRAFT_STORAGE_PREFIX}:${scope.workspace}:${scope.conversation}`;
}

/** Minimal storage surface: `sessionStorage` satisfies it, a `Map` stands in for tests. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readDraft(storage: DraftStorage, scope: DraftScope): string {
  try {
    return storage.getItem(draftStorageKey(scope)) ?? "";
  } catch {
    // Drafts are best-effort; a locked-down storage must not break the composer.
    return "";
  }
}

/** Empty text removes the key so a later view cannot inherit it. */
export function writeDraft(storage: DraftStorage, scope: DraftScope, value: string): void {
  try {
    if (value.length > 0) {
      storage.setItem(draftStorageKey(scope), value);
    } else {
      storage.removeItem(draftStorageKey(scope));
    }
  } catch {
    // Drafts are best-effort; nothing here may fail a send.
  }
}
