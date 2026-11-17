import { describe, expect, it } from "vitest";

import { headingTagName, segmentBlocks, segmentInline } from "../../../web/rich-text.js";

describe("segmentBlocks", () => {
  it("keeps plain lines together as one paragraph and splits on blank lines", () => {
    expect(segmentBlocks("第一段第一行\n第一段第二行\n\n第二段")).toEqual([
      { kind: "paragraph", text: "第一段第一行\n第一段第二行" },
      { kind: "paragraph", text: "第二段" }
    ]);
  });

  it("extracts a fenced code block with its language", () => {
    expect(segmentBlocks("before\n```ts\nconst a = 1;\n```\nafter")).toEqual([
      { kind: "paragraph", text: "before" },
      { kind: "code", language: "ts", code: "const a = 1;" },
      { kind: "paragraph", text: "after" }
    ]);
  });

  it("defaults the language label for bare fences", () => {
    expect(segmentBlocks("```\nplain code\n```")).toEqual([{ kind: "code", language: "", code: "plain code" }]);
  });

  it("treats an unclosed fence as code until the end", () => {
    expect(segmentBlocks("intro\n```json\n{\"a\": 1}\nstill code")).toEqual([
      { kind: "paragraph", text: "intro" },
      { kind: "code", language: "json", code: "{\"a\": 1}\nstill code" }
    ]);
  });

  it("handles multiple fenced blocks and empty code bodies", () => {
    expect(segmentBlocks("```sh\nls\n```\nmiddle\n```\n```")).toEqual([
      { kind: "code", language: "sh", code: "ls" },
      { kind: "paragraph", text: "middle" },
      { kind: "code", language: "", code: "" }
    ]);
  });

  it("rejects unsafe language info strings", () => {
    expect(segmentBlocks("```ts;alert(1)\nx\n```")).toEqual([{ kind: "code", language: "", code: "x" }]);
  });

  it("parses ATX headings and keeps the level", () => {
    expect(segmentBlocks("## 方案骨架\n正文\n### 约束\n- 风控")).toEqual([
      { kind: "heading", level: 2, text: "方案骨架" },
      { kind: "paragraph", text: "正文" },
      { kind: "heading", level: 3, text: "约束" },
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [{ text: "风控", children: [] }]
      }
    ]);
  });

  it("parses bulleted lists without swallowing the following paragraph", () => {
    expect(segmentBlocks("- 第一条\n- 第二条\n\n结尾段")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          { text: "第一条", children: [] },
          { text: "第二条", children: [] }
        ]
      },
      { kind: "paragraph", text: "结尾段" }
    ]);
  });

  it("keeps a list alive across blank lines between items", () => {
    expect(segmentBlocks("- 甲\n\n- 乙")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          { text: "甲", children: [] },
          { text: "乙", children: [] }
        ]
      }
    ]);
  });

  it("parses ordered lists with their starting number", () => {
    expect(segmentBlocks("1. 一\n2. 二")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          { text: "一", children: [] },
          { text: "二", children: [] }
        ]
      }
    ]);
    expect(segmentBlocks("3. 三\n4. 四")).toEqual([
      expect.objectContaining({ kind: "list", ordered: true, start: 3 })
    ]);
  });

  it("nests indented list items under their parent", () => {
    expect(segmentBlocks("- 父项\n  - 子项一\n  - 子项二\n- 下一个父项")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          {
            text: "父项",
            children: [
              {
                kind: "list",
                ordered: false,
                start: 1,
                items: [
                  { text: "子项一", children: [] },
                  { text: "子项二", children: [] }
                ]
              }
            ]
          },
          { text: "下一个父项", children: [] }
        ]
      }
    ]);
  });

  it("folds indented continuation lines into the item text", () => {
    expect(segmentBlocks("- 第一行\n  续行")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [{ text: "第一行\n续行", children: [] }]
      }
    ]);
  });

  it("parses blockquotes and thematic breaks", () => {
    expect(segmentBlocks("> 引用一\n> 引用二\n\n---\n\n结尾")).toEqual([
      { kind: "quote", blocks: [{ kind: "paragraph", text: "引用一\n引用二" }] },
      { kind: "divider" },
      { kind: "paragraph", text: "结尾" }
    ]);
  });

  it("parses pipe tables and pads missing cells", () => {
    expect(segmentBlocks("| 指标 | 值 |\n| --- | --- |\n| mIoU | 82.1 |\n| F1 |")).toEqual([
      {
        kind: "table",
        header: ["指标", "值"],
        rows: [
          ["mIoU", "82.1"],
          ["F1", ""]
        ]
      }
    ]);
  });

  it("starts a new block after a heading without a blank line", () => {
    expect(segmentBlocks("【假设】\n- 属于方法类投稿").map((block) => block.kind)).toEqual([
      "paragraph",
      "list"
    ]);
  });

  it("renders a real wen-chat answer as structure instead of one run", () => {
    const answer = [
      "【假设】",
      "- 假设你的工作属于 TGRS 主流“方法类”投稿，而非纯应用论文。",
      "- 假设实验数值只存在于若干 agent 会话和零散 log 中。",
      "",
      "【方案骨架】结论：**先写一页 Claim-Evidence 表**，再动笔。",
      "1. 先写 Claim-Evidence 表（90 分钟）",
      "2. 再写 Experiment Ledger",
      "",
      "| 步骤 | 产出 |",
      "| --- | --- |",
      "| 1 | 一页表 |",
      "",
      "```text",
      "claim -> evidence -> figure",
      "```"
    ].join("\n");

    expect(segmentBlocks(answer).map((block) => block.kind)).toEqual([
      "paragraph",
      "list",
      "paragraph",
      "list",
      "table",
      "code"
    ]);
    expect(segmentBlocks(answer)[0]).toEqual({ kind: "paragraph", text: "【假设】" });
  });

  it("treats CRLF input as plain newlines", () => {
    expect(segmentBlocks("a\r\n\r\nb")).toEqual([
      { kind: "paragraph", text: "a" },
      { kind: "paragraph", text: "b" }
    ]);
  });
});

describe("segmentInline", () => {
  it("returns plain text unchanged", () => {
    expect(segmentInline("no markup here")).toEqual([{ kind: "text", text: "no markup here" }]);
  });

  it("extracts inline code spans", () => {
    expect(segmentInline("run `npm test` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " now" }
    ]);
  });

  it("parses strong, emphasis and strikethrough markers", () => {
    expect(segmentInline("**加粗** 与 *斜体* 与 ~~删除~~")).toEqual([
      { kind: "strong", parts: [{ kind: "text", text: "加粗" }] },
      { kind: "text", text: " 与 " },
      { kind: "em", parts: [{ kind: "text", text: "斜体" }] },
      { kind: "text", text: " 与 " },
      { kind: "del", parts: [{ kind: "text", text: "删除" }] }
    ]);
  });

  it("supports underscore emphasis only at word boundaries", () => {
    expect(segmentInline("_斜体_")).toEqual([{ kind: "em", parts: [{ kind: "text", text: "斜体" }] }]);
    expect(segmentInline("pi_architect")).toEqual([{ kind: "text", text: "pi_architect" }]);
  });

  it("nests emphasis inside strong", () => {
    expect(segmentInline("**要点：*value* 优先**")).toEqual([
      {
        kind: "strong",
        parts: [
          { kind: "text", text: "要点：" },
          { kind: "em", parts: [{ kind: "text", text: "value" }] },
          { kind: "text", text: " 优先" }
        ]
      }
    ]);
  });

  it("keeps unmatched markers literal instead of swallowing text", () => {
    expect(segmentInline("** 三条贡献 bullet，** 未闭合")).toEqual([
      { kind: "text", text: "** 三条贡献 bullet，** 未闭合" }
    ]);
    expect(segmentInline("a * b * c")).toEqual([{ kind: "text", text: "a * b * c" }]);
  });

  it("does not emphasise across a newline", () => {
    expect(segmentInline("**开头\n结尾**")).toEqual([{ kind: "text", text: "**开头\n结尾**" }]);
  });

  it("linkifies http/https URLs and trims trailing punctuation", () => {
    expect(segmentInline("see https://example.com/a,b.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://example.com/a,b", href: "https://example.com/a,b" },
      { kind: "text", text: "." }
    ]);
  });

  it("trims unbalanced closing brackets from URLs", () => {
    expect(segmentInline("(https://example.com/x))")).toEqual([
      { kind: "text", text: "(" },
      { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
      { kind: "text", text: "))" }
    ]);
    expect(segmentInline("https://example.com/a_(b) end")).toEqual([
      { kind: "link", text: "https://example.com/a_(b)", href: "https://example.com/a_(b)" },
      { kind: "text", text: " end" }
    ]);
  });

  it("trims CJK punctuation following URLs", () => {
    expect(segmentInline("见 https://example.com/docs。")).toEqual([
      { kind: "text", text: "见 " },
      { kind: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
      { kind: "text", text: "。" }
    ]);
  });

  it("parses adjacent Markdown links without merging their destinations", () => {
    expect(
      segmentInline(
        "预报：[Timeanddate](https://www.timeanddate.com/weather/china/beijing/ext)、[AccuWeather](https://www.accuweather.com/zh/cn/beijing/101924/weather-forecast/1812_poi)。"
      )
    ).toEqual([
      { kind: "text", text: "预报：" },
      {
        kind: "link",
        text: "Timeanddate",
        href: "https://www.timeanddate.com/weather/china/beijing/ext"
      },
      { kind: "text", text: "、" },
      {
        kind: "link",
        text: "AccuWeather",
        href: "https://www.accuweather.com/zh/cn/beijing/101924/weather-forecast/1812_poi"
      },
      { kind: "text", text: "。" }
    ]);
  });

  it("keeps balanced parentheses inside Markdown-link URLs", () => {
    expect(segmentInline("[docs](https://example.com/a_(b)) end")).toEqual([
      { kind: "link", text: "docs", href: "https://example.com/a_(b)" },
      { kind: "text", text: " end" }
    ]);
  });

  it("keeps URLs inside inline code literal", () => {
    expect(segmentInline("`https://example.com`")).toEqual([{ kind: "code", text: "https://example.com" }]);
  });

  it("never linkifies non-http schemes", () => {
    expect(segmentInline("javascript:alert(1) stays text")).toEqual([
      { kind: "text", text: "javascript:alert(1) stays text" }
    ]);
  });

  it("keeps markup-looking text as literal text", () => {
    expect(segmentInline("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)>" }
    ]);
  });
});

describe("headingTagName", () => {
  it("never emits h1/h2 from message content", () => {
    expect([1, 2, 3, 4, 5, 6].map(headingTagName)).toEqual(["h3", "h3", "h4", "h5", "h6", "h6"]);
  });

  it("clamps nonsense levels instead of throwing", () => {
    expect([0, -3, 99, Number.NaN].map(headingTagName)).toEqual(["h3", "h3", "h6", "h3"]);
  });
});
