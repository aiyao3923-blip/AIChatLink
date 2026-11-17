/**
 * Lightweight Markdown rendering for agent messages.
 *
 * Dependency-free and CSP-safe: everything is built with createElement /
 * textContent, never innerHTML. Parsing is pure (`segmentBlocks` / `segmentInline`)
 * so it can be unit-tested in node; `renderRichContent` is only a thin DOM
 * mapping over those results.
 *
 * The grammar is deliberately small: fenced code, ATX headings, ordered and
 * unordered lists (nested by indent), blockquotes, thematic breaks, pipe tables,
 * paragraphs, and inline strong/emphasis/strikethrough/code/link. Everything the
 * grammar does not recognise stays literal text — a chat log must never silently
 * eat what a model wrote.
 */

const MAX_INLINE_DEPTH = 3;

export type InlinePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }
  | { readonly kind: "strong"; readonly parts: InlinePart[] }
  | { readonly kind: "em"; readonly parts: InlinePart[] }
  | { readonly kind: "del"; readonly parts: InlinePart[] };

export interface RichListItem {
  readonly text: string;
  readonly children: RichBlock[];
}

export type RichBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number; readonly items: RichListItem[] }
  | { readonly kind: "quote"; readonly blocks: RichBlock[] }
  | { readonly kind: "divider" }
  | { readonly kind: "code"; readonly language: string; readonly code: string }
  | { readonly kind: "table"; readonly header: string[]; readonly rows: string[][] };

export interface RichCodeBlock {
  readonly language: string;
  readonly code: string;
}

const FENCE_OPEN_PATTERN = /^```([^\s`]*)\s*$/;
const FENCE_CLOSE = "```";
const LANGUAGE_PATTERN = /^[A-Za-z0-9+#._-]{1,24}$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;
const DIVIDER_PATTERN = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const QUOTE_PATTERN = /^\s{0,3}>\s?/u;
const LIST_ITEM_PATTERN = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/u;
const CELL_SPLIT_PATTERN = /\|/u;
const RAW_URL_STOP_PATTERN = /[\s<>"'`\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F]/u;
const BLANK_PATTERN = /^\s*$/u;

interface EmphasisMarker {
  readonly marker: string;
  readonly kind: "strong" | "em" | "del";
}

// Longest markers first: `**` must win over `*`.
const EMPHASIS_MARKERS: readonly EmphasisMarker[] = [
  { marker: "**", kind: "strong" },
  { marker: "__", kind: "strong" },
  { marker: "~~", kind: "del" },
  { marker: "*", kind: "em" },
  { marker: "_", kind: "em" }
];

/**
 * Chat cards never own the document outline: `#`/`##` land on h3 and the deepest
 * levels share h6. `data-level` keeps the original level for styling.
 */
export function headingTagName(level: number): "h3" | "h4" | "h5" | "h6" {
  const clamped = Math.min(Math.max(Math.trunc(level) || 1, 1), 6);
  if (clamped <= 2) return "h3";
  if (clamped === 3) return "h4";
  if (clamped === 4) return "h5";
  return "h6";
}

function sanitizeLanguage(raw: string): string {
  return LANGUAGE_PATTERN.test(raw) ? raw : "";
}

function isBlank(line: string): boolean {
  return BLANK_PATTERN.test(line);
}

function indentOf(line: string): number {
  const match = /^\s*/u.exec(line);
  return match?.[0].length ?? 0;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9\u4e00-\u9fff]/u.test(character);
}

/** `| a | b |` → ["a", "b"]; a missing trailing pipe is tolerated. */
function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split(CELL_SPLIT_PATTERN).map((cell) => cell.trim());
}

function startsTable(lines: readonly string[], index: number): boolean {
  const header = lines[index] ?? "";
  const separator = lines[index + 1] ?? "";
  return header.includes("|") && !isBlank(separator) && TABLE_SEPARATOR_PATTERN.test(separator);
}

/** True when `line` opens a block other than a paragraph. */
function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (isBlank(line)) return false;
  if (FENCE_OPEN_PATTERN.test(line.trimEnd())) return true;
  if (HEADING_PATTERN.test(line)) return true;
  if (DIVIDER_PATTERN.test(line)) return true;
  if (QUOTE_PATTERN.test(line)) return true;
  if (LIST_ITEM_PATTERN.test(line)) return true;
  return startsTable(lines, index);
}

interface ParsedList {
  readonly block: RichBlock;
  readonly next: number;
}

/**
 * Parse one contiguous list, nesting by indentation. A single blank line between
 * items keeps the list alive, because model output routinely separates bullets
 * with an empty line.
 */
function parseList(lines: readonly string[], start: number): ParsedList {
  const first = LIST_ITEM_PATTERN.exec(lines[start] ?? "");
  const ordered = first !== null && /\d/u.test(first[2] ?? "");
  const startNumber = ordered ? Number.parseInt((first?.[2] ?? "1").trim(), 10) : 1;
  const baseIndent = first?.[1]?.length ?? 0;
  const items: RichListItem[] = [];
  let index = start;

  while (index < lines.length) {
    let cursor = index;
    // allow one or more blank lines inside a list, but only if a sibling follows
    while (cursor < lines.length && isBlank(lines[cursor] ?? "")) cursor += 1;
    const line = lines[cursor] ?? "";
    const match = LIST_ITEM_PATTERN.exec(line);

    if (match === null) {
      if (cursor > index || line.length === 0) {
        break;
      }
      // continuation text of the previous item (indented, not a new block)
      const last = items.at(-1);
      if (last === undefined || indentOf(line) <= baseIndent || startsBlock(lines, cursor)) {
        break;
      }
      items[items.length - 1] = { ...last, text: `${last.text}\n${line.trim()}` };
      index = cursor + 1;
      continue;
    }

    const indent = (match[1] ?? "").length;
    const itemOrdered = /\d/u.test(match[2] ?? "");
    if (indent < baseIndent || (indent === baseIndent && itemOrdered !== ordered)) break;

    if (indent > baseIndent) {
      const nested = parseList(lines, cursor);
      const last = items.at(-1);
      if (last === undefined) break;
      items[items.length - 1] = { ...last, children: [...last.children, nested.block] };
      index = nested.next;
      continue;
    }

    items.push({ text: (match[3] ?? "").trimEnd(), children: [] });
    index = cursor + 1;
  }

  return {
    block: { kind: "list", ordered, start: startNumber, items },
    next: index
  };
}

/**
 * Split a message into block-level structures. Unclosed fences and unterminated
 * constructs degrade to literal text instead of dropping content.
 */
export function segmentBlocks(text: string): RichBlock[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: RichBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE_OPEN_PATTERN.exec(line.trimEnd());
    if (fence !== null) {
      const language = sanitizeLanguage(fence[1] ?? "");
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const codeLine = lines[index] ?? "";
        if (codeLine.trim() === FENCE_CLOSE) {
          index += 1;
          break;
        }
        codeLines.push(codeLine);
        index += 1;
      }
      blocks.push({ kind: "code", language, code: codeLines.join("\n") });
      continue;
    }

    if (DIVIDER_PATTERN.test(line)) {
      blocks.push({ kind: "divider" });
      index += 1;
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, text: (heading[2] ?? "").trim() });
      index += 1;
      continue;
    }

    if (QUOTE_PATTERN.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const quoteLine = lines[index] ?? "";
        if (!QUOTE_PATTERN.test(quoteLine)) break;
        if (isBlank(quoteLine)) break;
        quoted.push(quoteLine.replace(QUOTE_PATTERN, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: segmentBlocks(quoted.join("\n")) });
      continue;
    }

    if (startsTable(lines, index)) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index] ?? "";
        if (isBlank(rowLine) || !rowLine.includes("|")) break;
        const cells = splitTableRow(rowLine);
        rows.push(header.map((_, column) => cells[column] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (LIST_ITEM_PATTERN.test(line)) {
      const parsed = parseList(lines, index);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? "";
      if (isBlank(paragraphLine)) break;
      if (paragraph.length > 0 && startsBlock(lines, index)) break;
      paragraph.push(paragraphLine.trimEnd());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

/** Trim punctuation that commonly follows a URL in prose but is not part of it. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"<>`\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011\u300A\u300B]+$/u, "");
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"]
  ];
  for (const [open, close] of pairs) {
    while (url.endsWith(close)) {
      const opens = url.split(open).length - 1;
      const closes = url.split(close).length - 1;
      if (closes <= opens) {
        break;
      }
      url = url.slice(0, -1);
    }
  }
  return url;
}

interface ParsedMarkdownLink {
  readonly end: number;
  readonly href: string;
  readonly label: string;
}

function parseMarkdownLinkAt(text: string, start: number): ParsedMarkdownLink | undefined {
  if (text[start] !== "[") {
    return undefined;
  }
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd <= start + 1 || text.slice(start + 1, labelEnd).includes("\n")) {
    return undefined;
  }
  const urlStart = labelEnd + 2;
  if (!text.startsWith("http://", urlStart) && !text.startsWith("https://", urlStart)) {
    return undefined;
  }

  let parenthesisDepth = 0;
  for (let cursor = urlStart; cursor < text.length; cursor += 1) {
    const character = text[cursor] ?? "";
    if (RAW_URL_STOP_PATTERN.test(character)) {
      return undefined;
    }
    if (character === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (character !== ")") {
      continue;
    }
    if (parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      continue;
    }
    const href = text.slice(urlStart, cursor);
    return href.length === 0
      ? undefined
      : { end: cursor + 1, href, label: text.slice(start + 1, labelEnd) };
  }
  return undefined;
}

function rawUrlEnd(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && !RAW_URL_STOP_PATTERN.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function segmentLinks(text: string, output: InlinePart[]): void {
  let cursor = 0;
  let plainStart = 0;
  while (cursor < text.length) {
    const markdown = parseMarkdownLinkAt(text, cursor);
    if (markdown !== undefined) {
      if (cursor > plainStart) {
        output.push({ kind: "text", text: text.slice(plainStart, cursor) });
      }
      output.push({ kind: "link", text: markdown.label, href: markdown.href });
      cursor = markdown.end;
      plainStart = cursor;
      continue;
    }

    const isRawUrl = text.startsWith("http://", cursor) || text.startsWith("https://", cursor);
    if (!isRawUrl) {
      cursor += 1;
      continue;
    }
    if (cursor > plainStart) {
      output.push({ kind: "text", text: text.slice(plainStart, cursor) });
    }
    const end = rawUrlEnd(text, cursor);
    const raw = text.slice(cursor, end);
    const href = trimUrl(raw);
    if (href.length > 0) {
      output.push({ kind: "link", text: href, href });
      if (href.length < raw.length) {
        output.push({ kind: "text", text: raw.slice(href.length) });
      }
    } else {
      output.push({ kind: "text", text: raw });
    }
    cursor = end;
    plainStart = cursor;
  }
  if (plainStart < text.length) {
    output.push({ kind: "text", text: text.slice(plainStart) });
  }
}

interface ParsedEmphasis {
  readonly end: number;
  readonly part: InlinePart;
}

/**
 * Match `**bold**`, `__bold__`, `~~gone~~`, `*em*` and `_em_` within one line.
 * Anything ambiguous stays literal: a chat log must not invent emphasis.
 */
function parseEmphasisAt(text: string, start: number, depth: number): ParsedEmphasis | undefined {
  for (const { marker, kind } of EMPHASIS_MARKERS) {
    if (!text.startsWith(marker, start)) continue;
    const contentStart = start + marker.length;
    const opening = text[contentStart];
    if (opening === undefined || /\s/u.test(opening)) continue;
    if (marker.length === 1) {
      // a lone `*`/`_` must not be half of a longer run
      if (opening === marker) continue;
      if (marker === "_" && isWordCharacter(text[start - 1])) continue;
    }
    let search = contentStart;
    while (search < text.length) {
      const close = text.indexOf(marker, search);
      if (close === -1) break;
      const inner = text.slice(contentStart, close);
      if (inner.includes("\n")) break;
      if (inner.length === 0) {
        search = close + marker.length;
        continue;
      }
      const beforeClose = text[close - 1] ?? "";
      if (/\s/u.test(beforeClose)) {
        search = close + marker.length;
        continue;
      }
      if (marker.length === 1) {
        if ((text[close + 1] ?? "") === marker) {
          search = close + marker.length;
          continue;
        }
        if (marker === "_" && isWordCharacter(text[close + 1])) {
          search = close + marker.length;
          continue;
        }
      }
      return {
        end: close + marker.length,
        part: { kind, parts: segmentInlineRange(inner, depth + 1) }
      };
    }
  }
  return undefined;
}

function segmentInlineRange(text: string, depth: number): InlinePart[] {
  const output: InlinePart[] = [];
  let cursor = 0;
  let plainStart = 0;

  const flushPlain = (end: number): void => {
    if (end > plainStart) {
      segmentLinks(text.slice(plainStart, end), output);
    }
  };

  while (cursor < text.length) {
    const character = text[cursor] ?? "";

    if (character === "`") {
      const close = text.indexOf("`", cursor + 1);
      if (close > cursor + 1) {
        flushPlain(cursor);
        output.push({ kind: "code", text: text.slice(cursor + 1, close) });
        cursor = close + 1;
        plainStart = cursor;
        continue;
      }
    }

    const link = parseMarkdownLinkAt(text, cursor);
    if (link !== undefined) {
      flushPlain(cursor);
      output.push({ kind: "link", text: link.label, href: link.href });
      cursor = link.end;
      plainStart = cursor;
      continue;
    }

    if (character === "h" && (text.startsWith("http://", cursor) || text.startsWith("https://", cursor))) {
      flushPlain(cursor);
      const end = rawUrlEnd(text, cursor);
      const raw = text.slice(cursor, end);
      const href = trimUrl(raw);
      if (href.length > 0) {
        output.push({ kind: "link", text: href, href });
        if (href.length < raw.length) {
          output.push({ kind: "text", text: raw.slice(href.length) });
        }
      } else {
        output.push({ kind: "text", text: raw });
      }
      cursor = end;
      plainStart = cursor;
      continue;
    }

    if (depth < MAX_INLINE_DEPTH && (character === "*" || character === "_" || character === "~")) {
      const emphasis = parseEmphasisAt(text, cursor, depth);
      if (emphasis !== undefined) {
        flushPlain(cursor);
        output.push(emphasis.part);
        cursor = emphasis.end;
        plainStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  flushPlain(text.length);
  return output;
}

/**
 * Split one block's text into inline parts: code spans, emphasis and http/https
 * links. URLs inside backtick spans stay literal. Only http/https is linked, so
 * schemes like javascript: can never become anchors.
 */
export function segmentInline(text: string): InlinePart[] {
  return segmentInlineRange(text, 0);
}

/** Copy text to the clipboard; resolves to whether the copy succeeded. */
export async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "true");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Flash a transient label on a button (e.g. "已复制"), then restore it. */
export function flashButtonLabel(button: HTMLButtonElement, label: string, restoreMs = 1_200): void {
  const original = button.textContent ?? "";
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = original;
  }, restoreMs);
}

function createCodeBlock(segment: RichCodeBlock): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";

  const header = document.createElement("div");
  header.className = "code-block-header";
  const language = document.createElement("span");
  language.className = "code-lang";
  language.textContent = segment.language || "code";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.textContent = "复制";
  copy.addEventListener("click", () => {
    void copyPlainText(segment.code).then((ok) => {
      flashButtonLabel(copy, ok ? "已复制" : "复制失败");
    });
  });
  header.append(language, copy);

  const pre = document.createElement("pre");
  pre.className = "code-block-body";
  const code = document.createElement("code");
  code.textContent = segment.code;
  pre.append(code);
  wrapper.append(header, pre);
  return wrapper;
}

function appendInlineParts(container: HTMLElement, text: string): void {
  appendParts(container, segmentInline(text));
}

function appendParts(container: HTMLElement, parts: readonly InlinePart[]): void {
  for (const part of parts) {
    if (part.kind === "text") {
      container.append(document.createTextNode(part.text));
    } else if (part.kind === "code") {
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = part.text;
      container.append(code);
    } else if (part.kind === "link") {
      const link = document.createElement("a");
      link.className = "inline-link";
      link.href = part.href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.textContent = part.text;
      container.append(link);
    } else {
      const tag = part.kind === "strong" ? "strong" : part.kind === "em" ? "em" : "del";
      const element = document.createElement(tag);
      element.className = `rt-${part.kind}`;
      appendParts(element, part.parts);
      container.append(element);
    }
  }
}

function createList(block: Extract<RichBlock, { kind: "list" }>, depth: number): HTMLElement {
  const list: HTMLElement = block.ordered
    ? document.createElement("ol")
    : document.createElement("ul");
  list.className = `rt-list rt-list-${block.ordered ? "ordered" : "bullet"}`;
  if (block.ordered && block.start !== 1) (list as HTMLOListElement).start = block.start;
  if (depth > 0) list.dataset.depth = String(depth);
  for (const item of block.items) {
    const li = document.createElement("li");
    li.className = "rt-li";
    appendInlineParts(li, item.text);
    for (const child of item.children) {
      li.append(createBlock(child, depth + 1));
    }
    list.append(li);
  }
  return list;
}

function createTable(block: Extract<RichBlock, { kind: "table" }>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "rt-table-wrap";
  const table = document.createElement("table");
  table.className = "rt-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of block.header) {
    const th = document.createElement("th");
    th.scope = "col";
    appendInlineParts(th, cell);
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of block.rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      appendInlineParts(td, cell);
      tr.append(td);
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function createBlock(block: RichBlock, depth = 0): HTMLElement {
  switch (block.kind) {
    case "code":
      return createCodeBlock(block);
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const heading = document.createElement(headingTagName(level));
      heading.className = "rt-h";
      heading.dataset.level = String(level);
      appendInlineParts(heading, block.text);
      return heading;
    }
    case "list":
      return createList(block, depth);
    case "quote": {
      const quote = document.createElement("blockquote");
      quote.className = "rt-quote";
      for (const child of block.blocks) quote.append(createBlock(child, depth));
      return quote;
    }
    case "divider": {
      const divider = document.createElement("hr");
      divider.className = "rt-hr";
      return divider;
    }
    case "table":
      return createTable(block);
    case "paragraph":
    default: {
      const paragraph = document.createElement("p");
      paragraph.className = "rt-p";
      appendInlineParts(paragraph, block.text);
      return paragraph;
    }
  }
}

/**
 * Render message text into a container. Code fences become block-level code
 * blocks with a language label and copy button; other text keeps its paragraph,
 * list, quote, heading and table structure instead of collapsing into one run.
 */
export function renderRichContent(container: HTMLElement, text: string): void {
  container.replaceChildren();
  for (const block of segmentBlocks(text)) {
    container.append(createBlock(block));
  }
}
