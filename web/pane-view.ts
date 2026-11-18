/**
 * Pane shell DOM: the chrome around one timeline (head, lens picker, status dot,
 * "back to latest" and close). Painting stays in app.ts — this module only owns
 * structure, so the render pipeline keeps a single implementation per card type.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface PaneShell {
  section: HTMLElement;
  head: HTMLElement;
  avatar: HTMLSpanElement;
  select: HTMLSelectElement;
  state: HTMLSpanElement;
  jump: HTMLButtonElement;
  jumpCount: HTMLSpanElement;
  close: HTMLButtonElement;
  timeline: HTMLOListElement;
  empty: HTMLLIElement;
}

export interface PaneShellOptions {
  id: string;
  primary: boolean;
  /** Primary panes reuse the static #timeline / #timeline-empty elements. */
  timeline?: HTMLOListElement;
  empty?: HTMLLIElement;
}

function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M12 4.8v13.4m-5.6-5.6 5.6 5.6 5.6-5.6");
  svg.append(path);
  return svg;
}

function emptyState(): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "empty-state pane-empty";
  const orbit = document.createElement("span");
  orbit.className = "empty-orbit";
  orbit.setAttribute("aria-hidden", "true");
  orbit.textContent = "◎";
  const heading = document.createElement("h3");
  const note = document.createElement("p");
  item.append(orbit, heading, note);
  return item;
}

function createHead(label: string): {
  head: HTMLElement;
  avatar: HTMLSpanElement;
  select: HTMLSelectElement;
  state: HTMLSpanElement;
  jump: HTMLButtonElement;
  jumpCount: HTMLSpanElement;
  close: HTMLButtonElement;
} {
  const head = document.createElement("header");
  head.className = "pane-head";

  const avatar = document.createElement("span");
  avatar.className = "pane-avatar";
  avatar.setAttribute("aria-hidden", "true");

  const select = document.createElement("select");
  select.className = "pane-lens";
  select.setAttribute("aria-label", `${label}显示内容`);

  const state = document.createElement("span");
  state.className = "pane-state";
  state.dataset.state = "ready";
  state.setAttribute("aria-hidden", "true");

  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "pane-jump";
  jump.hidden = true;
  jump.setAttribute("aria-label", "回到该窗格最新");
  const count = document.createElement("span");
  count.className = "pane-jump-count";
  count.hidden = true;
  jump.append(arrowIcon(), count);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "pane-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "关闭该窗格");
  close.title = "关闭该窗格";

  head.append(avatar, select, state, jump, close);
  return { head, avatar, select, state, jump, jumpCount: count, close };
}

export function createPaneShell(options: PaneShellOptions): PaneShell {
  const section = document.createElement("section");
  section.className = "pane";
  section.dataset.paneId = options.id;
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", options.primary ? "主窗格" : "附加窗格");

  const timeline =
    options.timeline ??
    (() => {
      const list = document.createElement("ol");
      list.className = "timeline";
      list.setAttribute("role", "log");
      list.setAttribute("aria-live", "off");
      list.setAttribute("aria-relevant", "additions text");
      list.setAttribute("aria-label", "窗格消息与运行事件");
      return list;
    })();
  const empty = options.empty ?? emptyState();
  if (!empty.isConnected) {
    timeline.append(empty);
  }

  const chrome = createHead("窗格");
  if (options.primary) {
    // The static <ol id="timeline"> already sits inside #pane-grid; wrap it
    // without changing its identity (event handlers and ids stay valid).
    timeline.before(section);
    section.append(chrome.head, timeline);
  } else {
    section.append(chrome.head, timeline);
  }

  return {
    section,
    head: chrome.head,
    avatar: chrome.avatar,
    select: chrome.select,
    state: chrome.state,
    jump: chrome.jump,
    jumpCount: chrome.jumpCount,
    close: chrome.close,
    timeline,
    empty
  };
}

/**
 * Keep the picker in sync with the roster without losing the current choice.
 * While the roster is still loading, an already-persisted Agent gets a
 * placeholder option so the persisted layout is not rewritten by a race.
 */
export function fillPaneLensOptions(
  select: HTMLSelectElement,
  agents: readonly { actorId: string; displayName: string }[],
  current: string
): void {
  const previous = select.value || current;
  select.replaceChildren();

  const room = document.createElement("option");
  room.value = "room";
  room.textContent = "房间（全部）";
  select.append(room);

  let matched = previous === "room";
  for (const agent of agents) {
    const option = document.createElement("option");
    option.value = agent.actorId;
    option.textContent = agent.displayName || agent.actorId;
    select.append(option);
    if (option.value === previous) {
      matched = true;
    }
  }

  if (!matched && previous.startsWith("agent:")) {
    const fallback = document.createElement("option");
    fallback.value = previous;
    fallback.textContent = `${previous.slice("agent:".length) || "未知 Agent"}（未在名册）`;
    select.append(fallback);
  }

  select.value = previous === "" ? "room" : previous;
}
