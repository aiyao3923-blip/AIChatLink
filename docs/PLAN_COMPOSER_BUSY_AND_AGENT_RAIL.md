# 计划书：输入器忙碌态 + 右侧 Agent 活动栏

| 项 | 值 |
| :--- | :--- |
| 状态 | **已实施并通过验收（2026-11-18）；本文件保留为设计、对抗评审与验收依据** |
| 目标仓库 | 仓库根（基线：`099c782` + 未提交 D-042 改动） |
| 日期 | 2026-11-18 |
| 触发证据 | 用户截图 `PixPin_2026-11-18_17-09-58.png`：6 个 Agent 已完成一轮，输入器仍是普通「发送」，顶部名册离输入动作太远 |
| 用户确认 | ①忙碌时发送键转圈**并禁用**；②图标可点击跳到该 Agent 最新回复并高亮；③只显示已启用 Agent |
| 关联决策 | D-009（每 Agent 单飞、不同 Agent 并行）、D-032（纸与墨）、D-040（workspace 壳层）、D-042（回放/选中态） |
| 非目标 | 不改协议、存储、路由、`unrestricted` 合同；不改房间助理的独立发送器；不新增审批层 |

---

## 0. 一句话实施

> 把 `<form id="composer">` 放进一个 `.composer-dock` 横向 dock：左侧输入器按右侧活动栏宽度收窄，
> 右侧渲染「已启用 Agent」的 30px 头像栏；任一当前对话 Turn 未到终态时，发送键显示旋转环并禁用，
> 对应 Agent 头像外圈旋转；Turn 到终态时给头像加「刚完成」小点，点头像滚到该 Agent 最新可见回复并高亮。

---

## 1. 用户需求与被忽略的语义

### 1.1 原始需求

1. 当前对话仍有任务在完成时，「发送」按键变成转圈按键；
2. 对话框左右压缩，右侧并排列放不同 Agent 的图标；
3. 该 Agent 工作时图标转圈，方便快速确认哪个 Agent 率先完成，并直接查看。

### 1.2 三条被截图掩盖的语义

| # | 问题 | 事实 | 结论 |
| :--- | :--- | :--- | :--- |
| S1 | 「有任务在完成」是看全局健康还是当前视图？ | `/api/health.activeTurns` 是所有 workspace / 所有对话的全局数；`state.turns` 只保存当前时间线可见的 Turn，`context.reset` 会清空它 | 用**当前视图的 `state.turns`**，不轮询 health；否则另一目录的活会锁住本对话 |
| S2 | 「转圈」是发送动作在飞，还是 Agent 在工作？ | `state.submitting` 只覆盖一次 POST；Turn 生命周期由 `turn.queued/started/...terminal` 驱动 | 两者共用同一个视觉忙碌态，但语义由 `title` / `aria-busy` 区分 |
| S3 | 「率先完成」在同时完成多个时如何看见？ | 转圈一停，若用户没盯着看，就分不出先后 | 终态跃迁留一个「刚完成」小点，点该头像或下一次成功发送时清除 |

---

## 2. 苏格拉底式提问（逐条给出可执行答案）

**Q1：为什么不直接禁用输入框，而只禁用发送键？**
A：用户要的是「本轮结束才可再发」，不是「本轮结束才能打字」。保留 textarea 让操作员先把下一句写好，
只锁提交；这也避免 `setComposerBusy(true)` 把正在输入的内容遮掉。POST 在飞时仍沿用既有
`messageInput.disabled = busy`（毫秒级），Turn 进行中只锁按钮。

**Q2：发送键转圈但禁用，会不会看起来像「卡住」？**
A：会，如果不给解释。因此按钮同时设置 `aria-busy="true"`、`title="Agent 仍在工作；本轮结束后才能发送"`，
并在 `composer-status` 被 Enter/表单绕过时给出一次文字反馈。转圈环是「房间在干活」，不是「按钮在提交」。

**Q3：为什么忙碌判定用未知状态 fail-safe？**
A：新增一个非终态（例如将来的 `paused`）时，如果按白名单判断活动，界面会提前解锁并允许再发，
造成排队积压。`web/agent-activity.ts` 只把 `completed/failed/cancelled/interrupted` 视为终态，
其余一律视为「未结束」；未知状态最多多锁一会儿，不会误放。

**Q4：历史回放（`?conv=`）要不要也锁？**
A：不锁。回放里只有已终态的 Turn；`conversationView !== null` 时明确返回非忙碌。
回放态发送本来就是「以这段历史为种子开新纪元」，不应被当前活纪元的 Turn 拦住。
代价：从历史回放续聊时，当前活纪元可能仍有 Turn 在跑；旧 Turn 会被 `retiredTurnIds` 隐藏，
新纪元从零开始，这是既有语义，不新增行为。

**Q5：`context.reset`（新建对话/压缩/续聊）时旧 Turn 还在跑，新纪元要不要继续锁？**
A：不锁。`clearTimelineView()` 清空 `state.turns`，旧 Turn 被标记为 retired；新纪元是「另一段对话」，
它的输入器必须可用。旧 Turn 的终态仍会写进新纪元但被隐藏，这是 D-034 既有行为。
如果将来要把 retired Turn 也计入忙碌，必须先改纪元语义，不在本次范围。

**Q6：为什么 AP​​I 返回的 turns 要立刻渲染？**
A：POST 202 与 SSE `turn.queued` 之间存在一个可观测空窗（SSE 重连时更长）。如果不种下 Turn，
按钮会在「已接受」后短暂解锁，用户可以再点一次，绕过本轮禁用。用 `seedOnly` 渲染 POST 返回的
`{turnId,target,status}`，让锁在响应落地时立即成立；SSE 到达后按 turnId 原位替换，不产生重复卡片。

**Q7：为什么活动栏不放在顶栏，让名册直接转圈？**
A：顶栏是名册/配置面，横向宽度随名字变化，转圈会导致整行抖动；用户此时的决定发生在输入器
（「我现在还能不能发」「谁先回完了」）。把工作态放在发送键旁边，语义距离最短，也避免把
`⟳` 重启/`⚙` 配置这些低频动作和实时状态混在同一组图标里。

**Q8：为什么图标转的是外圈而不是头像本身？**
A：旋转汉字/字母会破坏可读性与身份识别；转圈用外圈传达「进行中」，monogram 保持静止。
这也符合 D-032 的「tone 只用于身份，不做装饰」：环仍取 `--tone`，面积约 30px。

**Q9：为什么「刚完成」点不是常驻未读系统？**
A：用户要的是「这一轮谁先完成」，不是跨会话未读。点保留在内存，点图标/下一次成功发送/切换对话即清；
刷新后不恢复。这样不需要新增已读持久化，也不会和侧栏会话的「当前/进行中」语义打架。

**Q10：为什么要限制只显示已启用 Agent，却保留 failed？**
A：`pending_restart` 与 `enabled:false` 根本不会接活，占位置只会制造「为什么它不转」的疑问；
`failed` 的 Agent 仍是房间成员，保留图标并让 title 说明失败原因，用户可以去顶栏重启。
（用户已选择「只显示已启用」，这里把「已启用」落到「能接活」的口径。）

---

## 3. 专家会诊

| 角色 | 结论 | 对设计的约束 |
| :--- | :--- | :--- |
| 产品 / 协议 | 这是**输入节奏**，不是权限或审批；不得引入第二个 approval/sandbox | 只改 `disabled` 与提示；取消按钮仍在 Turn 卡片上，不禁用；不改 MCP 侧排队能力 |
| 交互 / 视觉 | 转圈必须低面积、单一强调；不能新增第三种表面 | 30px 头像 + 2px 环；环取 `--tone`；完成点取 `--accent`/`--danger`；不新增字号/hex |
| 前端实现 | `state.turns` 已是当前视图的单一事实源，不要新建第二份 Turn 状态 | 纯函数 `activeTurnActorIds()`；DOM 只做投影；POST 用 `seedOnly` 合并 |
| 可靠性 | 三个竞态必须处理：POST 与 SSE 乱序、终态事件缺 target、SSE 断线 | `seedOnly`；terminal 事件优先复用已有 `targetActorId`；离线时保持锁（宁可多锁） |
| 可访问性 | 旋转只是视觉，读屏需要文字状态 | `aria-busy` + 动态 `aria-label`/`title` + 隐藏 `aria-live` 通报终态 |
| QA | 不接受「截图看起来对」作为唯一证据 | 纯逻辑单测 + 真实实例截图 + 键盘/Enter 手测 + 三档宽度 + 明暗 |

**会诊分歧与裁决：**

- 交互建议「忙碌时保留可发送，只把图标变灰」，产品建议「按用户明确选择禁用」→ **采纳用户选择**。
- 前端建议「直接轮询 `/api/health` 的 `activeTurns`」→ **否决**：全局数会锁住别的对话/目录，且无法映射到 Agent。
- QA 建议「完成点做持久未读」→ **否决**：超出本轮需求，且需要新的存储语义；内存点足够回答「谁先完成」。

---

## 4. 横纵分析

### 4.1 横向（同类界面的两种范式，外部观察，非本仓库验收证据）

| 范式 | 代表交互 | 优点 | 代价 | 本项目取舍 |
| :--- | :--- | :--- | :--- | :--- |
| 生成中保留输入、显示停止键 | 阅读型聊天界面常见 | 可连续追问 | 用户容易在长任务中堆消息 | 用户明确选择禁用；保留草稿 |
| 每个 Agent 一个活动指示 | 多 Agent 编排面板常见 | 并行进度可读 | 图标栏会与名册重复 | 只保留头像+转圈+完成点，不复制名字/配置 |
| 顶部全局忙碌点 | 后台任务面板常见 | 实现最小 | 定位不到「谁」 | 否决；改为输入器旁的活动栏 |
| 消息列表自动贴底 + 角标 | 本仓库已有 | 不打断阅读 | 找不到刚完成的 Agent | 活动栏点击复用 `jumpToEvent` 高亮 |

结论：同类产品的共同点是**把「还能不能发」与「谁在跑」分开表达**。本设计也用两个载体：
发送键回答前者，活动栏回答后者；不把两者塞进一个旋转图标。

### 4.2 纵向（本仓库演化）

1. **D-032 之前**：输入器是 18 版样式的堆积，发送键只是黑色药丸，没有忙碌反馈；
2. **D-032**：纸与墨，输入器单行操作条，状态槽只留错误与提交中反馈；Agent 状态只在顶栏名册的 6px 点上；
3. **D-040**：顶栏名册成为 workspace 的权威名册；输入器加工作目录按钮；
4. **D-042**：回放与选中态分离；输入器宽度仍等于阅读列；
5. **本次**：阅读列不变，输入器卡片让出右侧宽度给活动栏；Turn 生命周期第一次进入输入器的视觉状态。
   这不是新增「第二个名册」，而是把已有 `state.turns` 投影到离输入动作最近的位置。

---

## 5. 设计

### 5.1 布局

```
┌─────────────────────────── .conversation-panel (container: room) ───────────────────────────┐
│  timeline                                                                                   │
│                                                                                             │
│  ┌──────────────── .composer-dock (width = --column, 居中) ────────────────┐                 │
│  │ ┌──────────── .composer (flex:1, 收窄) ────────────┐  ┌─ .composer-agents ─┐ │
│  │ │ textarea                                        │  │ (提) (批) (设)    │ │
│  │ │ 发送给 @all  ＋工作目录     上下文  压缩  发送  │  │ (总) (审) (核)    │ │
│  │ │                                                 │  │ 30px×2 排，转圈环 │ │
│  │ └─────────────────────────────────────────────────┘  └────────────────────┘ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

- 阅读列 `--column` 不变；只压缩 `.composer` 卡片，右侧释放的宽度交给活动栏；dock 整体仍与阅读列左右对齐。
- 活动栏是 **两排网格**：列数 `ceil(N/2)`，第一排 1..k、第二排 k+1..N（行优先，读序与顶栏一致）；
  6 个 Agent 时 3 列 × 2 排，宽度约 106px。`max-width: min(240px, 27%)`，列数超出时横向滚动、
  始终只占两排；图标固定 30px，不压缩。
- `@container room (max-width: 900px)` 时 dock 改为纵向：输入器占满，活动栏落到下方右对齐；
  避免 1280 开侧栏 / 900 开助理抽屉时把输入器压到不可用。
- `.conversation-panel` 增加 `container-type: inline-size; container-name: room`；现有 `.composer`
  的 `container-type: inline-size` 继续服务条内牺牲顺序。

### 5.2 发送键状态机

| 条件 | 视觉 | 可点 | 说明 |
| :--- | :--- | :--- | :--- |
| 空草稿、无 Turn | 纸灰药丸 + 纸飞机 | 否 | 现状 |
| 有草稿、无 Turn | 墨色药丸 + 纸飞机 | 是 | 现状 |
| 提交 POST 在飞 | 旋转环，`aria-busy` | 否 | 既有 `state.submitting` |
| 当前视图有非终态 Turn | 旋转环，`aria-busy` | 否 | 本次新增；`title` 说明等本轮结束 |
| 当前视图有终态 Turn + 空草稿 | 纸灰药丸 + 纸飞机 | 否 | 回到现状 |

- 旋转环复用 `@keyframes spin`，13px，`currentColor`。
- 禁用态背景改 `--paper-2`、前景 `--ink-2`、`opacity: 1`；否则全局 `button:disabled{opacity:.45}`
  会把环压成几乎不可见（原 `--faint` 同样过淡）。
- `prefers-reduced-motion: reduce` 时环不旋转，改为静态双色环；状态仍由 `aria-busy`/文字表达。

### 5.3 Agent 活动栏

- 只收 `agent.enabled === true && agent.status !== "pending_restart"`；按 `actorId` 排序，与顶栏一致。
- **两排网格**：`grid-template-columns: repeat(ceil(N/2), 30px)`，`grid-auto-rows: 30px`，
  行优先排布；6 个 Agent 为 3×2，5 个为 3+2，7 个为 4+3。
- 每项是 `<button type="button">`，30px 圆，monogram 与顶栏同规则（ASCII 取 2 字母，中文取 1 字），
  tone 取 `cardToneClass()`。
- `data-working="true"`：外圈 `2px` 环，`border-top-color: var(--tone)`，其余 25% tone，`spin 900ms`。
- `data-finished="completed|failed|cancelled|interrupted"`：右下 7px 点；`completed` 用 `--accent`，
  `failed` 用 `--danger`，其余 `--faint`；环用 `--canvas` 区分底色。
- 点击：
  1. 清该 Agent 的完成点；
  2. 在 `state.messages` 中找该 Agent **最新且有 DOM 节点**的 `message.created`；
  3. 有 → 复用 `jumpToEvent()`（暂停跟随、平滑居中、1.4s 高亮）；
  4. 无 → `composer-status` 显示「「名字」在本对话还没有可见回复」，不报错、不弹窗。
- 键盘：按钮天然可 Tab/Enter/Space；`:focus-visible` 沿用全局描边。
- 读屏：`aria-label="查看 {名字} 的最新回复（{状态}）"`，`aria-busy` 表工作态；
  另设 `.sr-only` `aria-live="polite"` 区域，在终态跃迁时播报「{名字} 已完成/失败/已取消」。

### 5.4 完成点生命周期

```
turn 非终态 --(终态事件，且该 turn 在视图内)--> finishedAgents.set(agent, status)
点击该图标 / 成功发送新消息 / clearTimelineView() --> 删除
```

- 只在 `renderTurn()` 内、`previous.status` 非终态且 `next.status` 终态时写入；`renderTurn` 只会在
  `envelopeInView()` 为真时被调用，因此回放/retired Turn 不会误报。
- 内存 Map，不写 localStorage/DB；刷新即清空，这是「本轮提示」而非未读系统。
- 若该 Agent 已从名册移除/停用，`syncAgentActivity()` 顺手剪掉，避免无主状态。

---

## 6. 逐文件实施规格

### 6.1 新增 `web/agent-activity.ts`

```ts
export const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed", "failed", "cancelled", "interrupted"
]);

export function isTerminalTurnStatus(status: string): boolean {
  return TERMINAL_TURN_STATUSES.has(status);
}

/** 未结束的 Turn 目标；未知状态按未结束处理（fail-safe）。 */
export function activeTurnActorIds(
  turns: Iterable<{ targetActorId: string; status: string }>
): string[];

/** 只有「非终态 -> 终态」才算一次完成跃迁。 */
export function isFinishedTransition(previous: string | undefined, next: string): boolean;
```

- `activeTurnActorIds` 去重、忽略空 `targetActorId`、保持首次出现顺序。
- 不 import 任何 DOM/Node 模块，可直接单测。

### 6.2 `web/index.html`

```html
<div class="composer-dock">
  <form id="composer" class="composer"> … 原内容不变 … </form>
  <aside id="composer-agents" class="composer-agents" aria-label="Agent 工作状态" hidden></aside>
</div>
<span id="agent-activity-live" class="sr-only" aria-live="polite"></span>
```

- 发送键内新增 `<span class="send-spinner" aria-hidden="true"></span>`，与 `.send-icon` 并列；
  label 仍是「发送」。
- 活动栏和 live 区域都放在 `</main>` 内，不改变 `timeline-actions` 的绝对定位基准。

### 6.3 `web/styles.css`

新增/修改：

| 选择器 | 作用 |
| :--- | :--- |
| `.conversation-panel` | `container-type: inline-size; container-name: room` |
| `.composer-dock` | `width: var(--column); margin: 0 auto 10px; display:flex; align-items:flex-end; gap:10px` |
| `.composer` | `width:auto; flex:1 1 auto; min-width:0; margin:0`（原 width/margin 移到 dock） |
| `.composer-agents` | 两排 grid、`gap:5px`、`max-width:min(240px,27%)`、`overflow-x:auto`、`padding:4px 3px 8px` |
| `.composer-agent` | 30px 圆、relative、hover/focus 提亮、`data-working`/`data-finished` |
| `.send-spinner` | 13px 环；`.send-button.is-working` 切换纸飞机/环；禁用态可见 |
| `@container room (max-width:900px)` | dock 纵向、活动栏下移右对齐（仍两排） |
| `@media (max-width:760px)` | `.composer` 的宽度/边距规则迁到 `.composer-dock` |
| `prefers-reduced-motion` | 停掉环旋转 |

禁止：新增 hex、新增字号、给活动栏加文字标签、给图标加边框+阴影+圆角三件套。

### 6.4 `web/app.ts`

1. import `activeTurnActorIds`、`isFinishedTransition`、`isTerminalTurnStatus`；
   删本地 `TERMINAL_TURN_STATUSES`（改为引用模块集合），保留 `IN_FLIGHT_TURN_STATUSES`。
2. 新 DOM 引用：`composerDock`、`composerAgents`、`agentActivityLive`。
3. `syncSendButton()`：加入 `isRoomWorking()`，切换 `.is-working` / `aria-busy` / `title` / `disabled`。
4. `isRoomWorking()`：`conversationView === null && activeTurnActorIds(state.turns.values()).length > 0`。
5. `submitMessage()` 开头：若 `isRoomWorking()` → `setComposerStatus("Agent 仍在工作；本轮结束后才能发送")` 并返回。
   POST 成功后遍历 `accepted.turns`，`normalizeTurn` + `renderTurn(turn, { seedOnly: true })`；
   seed **只写入 `state.turns` 上锁，不建 DOM 卡片**，卡片仍由 SSE `turn.queued` 在 `message.created` 之后创建，避免顺序倒置。
6. `renderTurn(turn, { seedOnly, markFinished })`：
   - `seedOnly && state.turns.has(turnId)` → 直接返回；
   - 记录 `previous`，写入 `state.turns`；
   - `markFinished && isFinishedTransition(previous?.status, turn.status)` →
     `finishedAgents.set(target, { status, turnId })`；
   - 末尾 `syncAgentActivity()`。
7. `renderTurnEnvelope(envelope, markFinished)`：`targetActorId = body.targetActorId/target || previous?.targetActorId || to[0] || actor`；
   `markFinished` 只由 `acceptEnvelope(source==="live")` 传 true。bootstrap activeTurns 与 POST seed 传 false。
8. `renderAgents()` 末尾调用 `renderComposerAgents()`；`renderComposerAgents()` 用
   actorId+displayName 签名避免每次 session 事件重建 DOM（保焦点），然后 `syncAgentActivity()`。
9. `syncAgentActivity()`：算活动集合、剪掉不再显示 Agent 或已重新开工的完成点、更新 `data-*`/title/aria、
   调 `syncSendButton()`；live 终态跃迁时写 live 区域。
10. `jumpToAgentLatest(actorId)`：清完成点 → completed 找最新可见消息 → `jumpToEvent()`；
    非 completed 优先 `jumpToNode(turnNodes.get(turnId))`，失败则回退消息/状态提示。
11. `clearTimelineView()` 末尾：`finishedAgents.clear()` + `syncAgentActivity()`。
12. `syncJumpLatestGeometry()` 改用 `composerDock` 的矩形；`ResizeObserver` 观察 dock。

### 6.5 `src/web/server/server.ts`

`StaticAsset["fileName"]` 联合类型与 `STATIC_ASSETS` 增加 `agent-activity.js`。
`src/web/setup/server.ts` 不登记（setup 不 import 该模块）。

### 6.6 文档

- `docs/WEB_UI.md` §四：输入器改为 dock + 活动栏；§七：禁止把活动栏做成第二名册；
  §八：新增验收项。
- `docs/DECISIONS.md`：新增 **D-044：输入器忙碌锁与 Agent 活动栏**，写明用户选择、忙碌口径、
  fail-safe、回滚边界。

---

## 7. 反向拆解（从验收倒推每一步）

| 验收项 | 必要条件 | 可能断点 | 预防 |
| :--- | :--- | :--- | :--- |
| 转圈出现 | `state.turns` 有非终态 + `syncSendButton` 被调用 | 只在 `renderTurn` 调，POST 空窗不锁 | `seedOnly` 种 Turn + `submitMessage` 调 sync |
| 转圈消失 | 终态事件进入视图 | terminal 事件 target 缺失、被 seed 卡覆盖 | 保留 previous target；`seedOnly` 不覆盖已有 |
| 发送禁用 | `disabled` 包含 working | Enter 调 `form.requestSubmit()` 绕过按钮 | `submitMessage` 内守卫 |
| 右侧活动栏 | dock 横向 + rail 宽度 | 1280 开侧栏/抽屉时输入器过窄 | `@container room (max-width:900px)` 纵向堆叠 |
| 图标转圈 | active set 命中 actor | `turn.interrupted` 被记成 `system` | 保留 previous target |
| 点击跳转 | 最新可见消息 | 被折叠/裁剪的节点失效 | 只收 `eventNodes.has()` 的消息 |
| 完成点 | 非终态→终态 | 回放/retired Turn 误报；刷新把旧完成全点亮 | `renderTurn` 只在视图内调用 + `markFinished` 仅 live + previous 判定 |
| 浮标不压活动栏 | geometry 取 dock 右缘 | 仍用 `composer` 矩形 → 浮标落在图标上 | 改用 `composerDock` + 观察 dock |
| 移动端不横向滚动 | dock 纵向、rail 可滚 | `.composer` 旧的 `calc(100% - 24px)` 与新 dock 冲突 | 迁到 `.composer-dock` |
| 历史回放不锁 | `conversationView === null` | 回放里有非终态（异常数据） | 明确 gate |
| 刷新后仍锁 | bootstrap activeTurns 渲染 | activeTurns 被 recentEvents 覆盖成终态 | `seedOnly` 只用于 POST，不用于 bootstrap |
| 测试/构建 | 新模块登记 | server 白名单 404 | 同步改 `server.ts` |

---

## 8. 双向钢人论证

### 8.1 正方（替方案补到最强）

1. **语义最短**：用户的两个决定（还能不能发 / 谁先完成）都发生在输入器，反馈就该在那里；
2. **单一事实源**：`state.turns` 已经由 SSE / bootstrap / POST 三路维护，活动态只是投影，没有第二份 Turn 状态；
3. **失败安全**：未知状态按未结束处理；POST 窗口用 `seedOnly` 补齐，避免绕过锁；
4. **零协议改动**：不改 Broker、REST、存储、队列；MCP/Agent 的排队能力完全保留；
5. **可逆**：若禁用被证明碍事，去掉 `isRoomWorking()` 参与 `disabled` 与 submit 守卫两行即可，
   转圈与活动栏可独立保留；
6. **可测**：活动判定是纯函数；UI 状态可由截图 + DOM 属性验证，不依赖模型输出。

### 8.2 反方（最致命的反面）

1. **禁用发送直接削掉「边跑边追加」的工作方式**：对于长任务，用户可能想补充约束；现在只能等或取消；
2. **转圈 + 禁用容易被误读为网络卡住**：转圈通常表示「正在发送」，而不是「对方在忙」；
3. **活动栏与顶栏名册重复**：6 个头像在顶栏已有，输入器再出现一次，增加视觉噪音；
4. **完成点引入新的「未读」语义**：用户可能以为它会持久化，刷新后消失会困惑；
5. **容器查询/浮动按钮几何是连带伤害区**：dock 改变几何后，`timeline-actions` 可能压到图标栏；
6. **POST 种子可能让历史 Turn 卡片闪一下**：若 SSE 很快，用户会看到卡片先 queued 再 running；
7. **刷新页面会把最近窗口里的旧完成全部点灯**：bootstrap/replay 也走 `renderTurn`，若按「非终态→终态」
   无条件标记，就会把历史当成刚刚发生。

### 8.3 裁决与缓解

| 反方 | 裁决 | 缓解 |
| :--- | :--- | :--- |
| 1 | **接受，按用户明确选择** | 保留草稿；取消按钮仍在 Turn 卡片；`title` 说明等本轮；回滚只需两行 |
| 2 | 接受风险 | 环取 `--tone`、按钮文字仍是「发送」、`aria-busy` + title；禁用态环不闪烁 |
| 3 | 接受但限制面积 | 活动栏只放 30px 头像，无名字/无配置；顶栏仍是唯一名册与重启入口 |
| 4 | 接受但限定生命周期 | 只存内存；点图标/下一次发送/换对话即清；不承诺未读 |
| 5 | 必须修 | geometry 改用 dock；真实实例截图检查浮标与 rail 不重叠 |
| 6 | 可接受 | `seedOnly` 只入 state、不建卡片；SSE 到达后按 seq 建卡；顺序与高度都不跳 |
| 7 | **必须修** | 完成点只在 `source==="live"` 时写；bootstrap 的 activeTurns 与 replay 只重建状态 |

**结论：方案通过。** 反对意见没有推翻用户的两个明确选择；所有可修的技术风险已进入 §7 的预防表。

---

## 9. 验收清单（完整闭环）

### 9.1 自动化

```bash
npm run typecheck
npx vitest run
npm run build
```

- 新增 `tests/unit/web/agent-activity.test.ts` 全绿；
- 既有 739+ 测试不回归；
- `dist/web/agent-activity.js` 存在，`GET /agent-activity.js` 200。

### 9.2 真实实例（独立端口 + 独立库，不碰用户全局实例）

1. 启动验证实例（如 4311），6 个 pi Agent 全部 ready；
2. Playwright 打开 `/`，确认：
   - 输入器右侧出现 6 个图标，按 3×2 两排（仅 enabled，无 pending_restart）；
   - dock 与阅读列左右对齐，无横向滚动；
   - 1600×1000、1280×800、430×900 三档均不重叠、不裁切；
   - 暗色模式环与完成点可辨；
   - 键盘 Tab 可达每个图标与发送键。
3. 发送一条极短消息给 `@all`：
   - 发送瞬间按钮出现旋转环并 `disabled`；
   - 每个目标图标出现旋转环；
   - 在输入框输入文字（textarea 可用），Enter 被守卫拦下并提示；
   - 截图为证。
4. 等待终态：
   - 转圈停止，发送键按草稿是否为空恢复；
   - 完成的 Agent 出现完成点；
   - 点其中一个图标 → 时间线滚到其最新回复并高亮 1.4s，完成点消失；
   - 截图为证。
5. 点开侧栏一条历史对话：
   - 输入器不因活纪元的 Turn 被锁；
   - 返回当前对话后恢复实际忙碌态。
6. 刷新页面（Turn 进行中）：
   - bootstrap 的 activeTurns 让按钮与对应图标继续转圈；
   - 终态到达后正确解锁。

### 9.3 回归

- `timeline-actions`（对话目录 / 回到最新）浮在 dock 右上方，不压住活动栏；
- 输入器容器查询：860/800/560 的牺牲顺序仍生效；
- `context.reset` 后发送键解锁、活动栏不残留完成点；
- 房间助理抽屉的发送器完全不受影响。

---

## 10. 实施顺序

1. `web/agent-activity.ts` + 单测（先红后绿）；
2. `index.html` dock + 发送键 spinner + live 区域；
3. `styles.css` 布局、环、完成点、响应式、减弱动效；
4. `app.ts` 状态机、rail 渲染、跳转、几何、seed；
5. `server.ts` 白名单；
6. `WEB_UI.md` / `DECISIONS.md`；
7. typecheck → 单测 → build；
8. 真实实例截图与交互验收；
9. 输出闭环报告（通过/未观察项）。

## 11. 回滚边界

| 想撤回 | 操作 |
| :--- | :--- |
| 只取消「禁用」 | `syncSendButton()` 去掉 `working` 参与 `disabled`；`submitMessage()` 去掉忙碌守卫；保留转圈 |
| 只取消活动栏 | 删除 `<aside>`/CSS/`renderComposerAgents`；dock 恢复单列宽度 |
| 全部回滚 | 还原 `web/index.html`、`web/styles.css`、`web/app.ts`、`web/agent-activity.ts`、`server.ts`；文档 D-044 标记 Reverted |

不涉及数据库迁移、不涉及协议版本、不需要重启用户全局实例。

---

## 12. 验收记录（2026-11-18）

验证实例：仓库构建产物在 `127.0.0.1:4311` 启动，独立配置/库（`_tmp/verify-ui/`），6 个 pi Agent 全部 `ready`；
用户全局实例（4310，npm 全局包）未被重启或改动。

| # | 验收项 | 结果 | 证据 |
| :--- | :--- | :--- | :--- |
| 1 | `npm run typecheck` | 🟢 通过 | 无输出错误 |
| 2 | `npx vitest run` | 🟢 753/753 通过（71 文件） | 含新增 `tests/unit/web/agent-activity.test.ts` |
| 3 | `npm run build` | 🟢 通过 | `dist/web/agent-activity.js` 生成 |
| 4 | 静态资源 | 🟢 `GET /agent-activity.js` 200，`application/javascript` | 白名单已登记 |
| 5 | 1600×1000 空闲 | 🟢 composer 924 / dock 1040 / rail 106（3×2 两排）；无横向滚动 | `_tmp/verify-ui/shots/tworow-1600-idle.png` |
| 6 | 1600×1000 忙碌 | 🟢 POST 后 eval 实测 6/6 头像 `data-working=true`；发送键 spinner + `disabled` + `aria-busy`；textarea 仍可输入。截图抓拍时部分 Agent 已转终态，`desktop-busy.png` 为 2 转圈 + 4 完成点，`final-1600-busy.png` 为单 Agent 转圈 + 5 完成点 | `_tmp/verify-ui/shots/tworow-1600-busy.png`、`tworow-dock-busy.png`、`desktop-busy.png` |
| 7 | 忙碌时 Enter | 🟢 不提交，状态槽显示「Agent 仍在工作；本轮结束后才能发送」 | Playwright eval 实测 |
| 8 | 终态解锁 | 🟢 发送键停止转圈并按草稿恢复；busy 文案自动清空 | Playwright eval 实测 |
| 9 | 完成点 | 🟢 全部终态后 eval 实测 6/6 `data-finished=completed`；live 终态才点亮；刷新后历史不点灯。`desktop-finished-jump.png` 是点击提案后（该点已清）的 5 点画面 | `desktop-busy.png`、`desktop-finished-jump.png`、刷新 eval |
| 10 | 点击跳转 | 🟢 提案 → 最新可见回复 `.is-highlighted`；完成点消失 | `desktop-finished-jump.png` |
| 11 | 失败终态 | 🟢 `failed` 点点亮；点击高亮 `.turn-card[data-status="failed"]` | Playwright eval |
| 12 | 刷新中途 | 🟢 bootstrap activeTurns 让发送键与对应头像继续转圈 | Playwright eval |
| 13 | 历史回放 | 🟢 输入器不因活纪元 Turn 被锁；有草稿即可发送 | `?conv=conv%3A1` eval |
| 14 | 1280×800 | 🟢 dock 与 rail 并排，rail 106（3×2），浮标不压 rail，无横向滚动 | `_tmp/verify-ui/shots/tworow-1280-idle.png` |
| 15 | 430×900 | 🟢 rail 落到卡片下方右对齐，仍 3×2；dock 底 892 < 900；无横向滚动；发送键收成 30px 圆 | `_tmp/verify-ui/shots/tworow-430-idle.png` |
| 16 | 暗色 | 🟢 环、完成点、busy 键可辨 | `_tmp/verify-ui/shots/1600-dark.png`、`1600-dark-busy.png` |
| 17 | 移动端 busy 图标 | 🟢 ≤520px 标签隐藏时 spinner 仍显示（修正 `:not(.send-spinner)`）；`opacity:1` + `--ink-2` 修正了 `button:disabled{opacity:.45}` 导致的过淡 | `_tmp/verify-ui/shots/final-430-busy-button.png` |
| 18 | 顺序 | 🟢 POST seed 不建卡片；timeline 顺序为 USER → 6×TURN | Playwright eval |
| 19 | 窄桌面堆叠 | 🟢 1000 侧栏开：room 728、dock 632 纵向，rail 3×2 右对齐，无横向滚动 | `_tmp/verify-ui/shots/tworow-1000-stacked.png` |

**未观察项**：①没有构造 `turn.interrupted` / `cancelled` 的真实样本；代码路径按「复用 previous target + 异常终态点」实现，
单测覆盖状态分类，真实中断路径沿用既有取消测试。②验证实例没有 `pending_restart` Agent，活动栏的
「enabled 且非 pending_restart」过滤只做了代码审查，未在真实运行中构造。③`prefers-reduced-motion` 只做了 CSS 规则，
未在真实浏览器切换系统设置验证。④一次 pi 回合耗时超过 2 分钟属模型延迟，不是输入器忙碌态缺陷。
