/**
 * Pane shell DOM: the chrome around one timeline (head, lens picker, status dot,
 * close) plus that pane's reading controls (message index + "back to latest").
 * Painting stays in app.ts — this module only owns structure, so the render
 * pipeline keeps a single implementation per card type.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Every pane carries its own pair of floating controls, so a lane or a grid
 * pane keeps the reading tools the room baseline always had. The index is a
 * projection of this pane's own nodes: a number must land in the pane it was
 * counted in, never in a sibling.
 */
export interface PaneToc {
  stack: HTMLElement;
  panel: HTMLElement;
  list: HTMLOListElement;
  button: HTMLButtonElement;
  close: HTMLButtonElement;
  jump: HTMLButtonElement;
  jumpCount: HTMLSpanElement;
}

export interface PaneShell {
  section: HTMLElement;
  head: HTMLElement;
  avatar: HTMLSpanElement;
  select: HTMLSelectElement;
  state: HTMLSpanElement;
  close: HTMLButtonElement;
  timeline: HTMLOListElement;
  empty: HTMLLIElement;
  toc: PaneToc;
}

export interface PaneShellOptions {
  id: string;
  primary: boolean;
  /** Primary panes reuse the static #timeline / #timeline-empty elements. */
  timeline?: HTMLOListElement;
  empty?: HTMLLIElement;
}

export function createTocStack(prefix: string): PaneToc {
  const stack = document.createElement("div");
  stack.className = "timeline-actions";

  const panel = document.createElement("section");
  panel.className = "toc-panel";
  panel.id = `${prefix}-toc-panel`;
  panel.setAttribute("aria-label", "对话目录");
  panel.hidden = true;

  const head = document.createElement("header");
  head.className = "toc-head";
  const titles = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "My messages";
  const heading = document.createElement("h2");
  heading.textContent = "对话目录";
  titles.append(eyebrow, heading);

  const close = document.createElement("button");
  close.className = "icon-button";
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "关闭对话目录");
  head.append(titles, close);

  const list = document.createElement("ol");
  list.className = "toc-list";
  panel.append(head, list);

  const button = document.createElement("button");
  button.id = `${prefix}-toc`;
  button.className = "floating-action";
  button.type = "button";
  button.title = "对话目录：只看我发过的消息，点击跳到原位置";
  button.setAttribute("aria-label", "对话目录");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", panel.id);
  button.hidden = true;
  const indexIcon = document.createElementNS(SVG_NS, "svg");
  indexIcon.setAttribute("class", "floating-action-icon");
  indexIcon.setAttribute("viewBox", "0 0 24 24");
  indexIcon.setAttribute("aria-hidden", "true");
  for (const cy of [7, 12, 17]) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", "5");
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "1.15");
    dot.setAttribute("fill", "currentColor");
    indexIcon.append(dot);
  }
  const lines = document.createElementNS(SVG_NS, "path");
  lines.setAttribute("d", "M9 7h10M9 12h10M9 17h10");
  lines.setAttribute("fill", "none");
  lines.setAttribute("stroke", "currentColor");
  lines.setAttribute("stroke-width", "1.6");
  lines.setAttribute("stroke-linecap", "round");
  indexIcon.append(lines);
  button.append(indexIcon);

  const jump = document.createElement("button");
  jump.id = `${prefix}-jump-latest`;
  jump.className = "floating-action jump-latest";
  jump.type = "button";
  jump.title = "回到最新进度";
  jump.setAttribute("aria-label", "回到最新进度");
  jump.hidden = true;
  const arrow = createArrowIcon();
  arrow.setAttribute("class", "jump-latest-arrow");
  const jumpCount = document.createElement("span");
  jumpCount.className = "jump-latest-count";
  jumpCount.hidden = true;
  jump.append(arrow, jumpCount);

  stack.append(panel, button, jump);
  return { stack, panel, list, button, close, jump, jumpCount };
}

/**
 * The lane header no longer carries its own arrow: every pane's floating stack
 * already targets that pane, and two arrows in one lane read as two states.
 */
function createArrowIcon(): SVGSVGElement {
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
  note.className = "pane-empty-note";
  // The epigraph stays last: the state message and its explanation come first,
  // the role's own voice is the closing line of a still-empty lane.
  const quote = document.createElement("p");
  quote.className = "pane-empty-quote";
  quote.hidden = true;
  const quoteText = document.createElement("span");
  quoteText.className = "pane-empty-quote-text";
  const quoteSource = document.createElement("span");
  quoteSource.className = "pane-empty-quote-source";
  quote.append(quoteText, quoteSource);
  item.append(orbit, heading, note, quote);
  return item;
}

function createHead(label: string): {
  head: HTMLElement;
  avatar: HTMLSpanElement;
  select: HTMLSelectElement;
  state: HTMLSpanElement;
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

  const close = document.createElement("button");
  close.type = "button";
  close.className = "pane-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "关闭该窗格");
  close.title = "关闭该窗格";

  head.append(avatar, select, state, close);
  return { head, avatar, select, state, close };
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
  const toc = createTocStack(options.primary ? "pane-0" : options.id);
  if (options.primary) {
    // The static <ol id="timeline"> already sits inside #pane-grid; wrap it
    // without changing its identity (event handlers and ids stay valid).
    timeline.before(section);
    section.append(chrome.head, timeline, toc.stack);
  } else {
    section.append(chrome.head, timeline, toc.stack);
  }

  return {
    section,
    head: chrome.head,
    avatar: chrome.avatar,
    select: chrome.select,
    state: chrome.state,
    close: chrome.close,
    timeline,
    empty,
    toc
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
