/**
 * Empty-pane voices — the one line a role says while its lane is still silent.
 *
 * These lines are original to AIChatLink, not quotations, so they are keyed by
 * the role word in an Agent's configured display name and never attributed to a
 * real person. A renamed Agent keeps its voice ("提案 · Codex" still says the
 * proposer's line); an unknown name gets nothing rather than a false byline.
 */

export interface EmptyVoice {
  /** The role's line, without the surrounding 「」 the view adds. */
  quote: string;
  /** The playful byline under the line. */
  source: string;
}

/** Fresh room: nothing has been asked yet, so the first word is the operator's. */
export const ROOM_VOICE: EmptyVoice = {
  quote: "这间屋子里没人先开口，因为第一句只能是你。",
  source: "空房间，第一次发言之前"
};

/**
 * A configured but disabled Agent: expected silence, not an error. This one is a
 * note rather than an epigraph — the pane already has a heading to carry it.
 */
export const DISABLED_NOTE = "它还没被叫醒；历史输出仍可查看，启用后才会接新回合。";

const ROLE_VOICES: ReadonlyArray<{ role: string; voice: EmptyVoice }> = [
  {
    role: "提案",
    voice: {
      quote: "先把惯例剥掉，剩下的才配叫事实。",
      source: "提案，第 0 号方案"
    }
  },
  {
    role: "批判",
    voice: {
      quote: "共识，只是还没被反驳的流行。",
      source: "批判，代表未来"
    }
  },
  {
    role: "设计",
    voice: {
      quote: "留白不是空着，是给呼吸留的位置。",
      source: "设计，按 8pt 计"
    }
  },
  {
    role: "总管",
    voice: {
      quote: "终裁不是最后一句，是第一个可执行的分工。",
      source: "总管，第 0 次派单"
    }
  },
  {
    role: "审查",
    voice: {
      quote: "最锋利的审查，长在最体谅的读法里。",
      source: "审查，替你说完好话之后"
    }
  },
  {
    role: "核验",
    voice: {
      quote: "查不到就说查不到——这是核验唯一的特权。",
      source: "核验，可信度待定"
    }
  }
];

/**
 * Resolve a display name to its role voice. The room's six roles are distinct
 * words, so a plain substring test is enough; names outside the roster return
 * `undefined` and the pane keeps its functional copy only.
 */
export function emptyVoiceFor(displayName: string): EmptyVoice | undefined {
  const name = displayName.trim();
  if (name.length === 0) {
    return undefined;
  }
  for (const entry of ROLE_VOICES) {
    if (name.includes(entry.role)) {
      return entry.voice;
    }
  }
  return undefined;
}
