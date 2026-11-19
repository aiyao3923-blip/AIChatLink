# 计划书：多窗格监看（pane grid）+ 单 Agent 车道

| 项 | 值 |
| :--- | :--- |
| 状态 | **已实施并通过验收（2026-11-18，763 项测试）；本文件保留为设计、对抗评审与验收依据** |
| 目标仓库 | 仓库根（基线 `099c782` + 未提交的 D-042/D-043/D-044 改动） |
| 日期 | 2026-11-18 |
| 触发证据 | 用户截图 `PixPin_2026-11-18_18-05-39.png`：单个阅读列 + 6 个 Agent 名册；用户描述「多 Agent 同时工作时不方便同时观看，因为一个对话会不断往上滚动对话历史」，并要求参考 Cherry Studio 的「多窗口并列 / 四方格」 |
| 用户选择 | 可以是并列，也可以是四方格；目标是「同时看多个 Agent 在干什么」，不是再造一套会话系统 |
| 关联决策 | D-009（不同 Agent 并行）、D-032（纸与墨）、D-034/D-035（纪元与视口）、D-040（workspace 壳层）、D-042（回放与选中态）、D-044（忙碌锁与活动栏） |
| 非目标 | 不改协议、存储、路由、Broker、`unrestricted` 合同；不新增审批层；不做跨 workspace 的同屏并列（见 §5.2 的硬约束） |
| 边界口径 | 一个页面 = 一个 workspace = 一个活纪元 = 一条 EventSource = 一份 `state`；窗格只是这份状态的**只读投影**，不是第二个 App 实例 |

---

## 0. 一句话实施

> 把主区改造为 CSS Grid 的 **窗格墙**：1 / 2 / 4 / 6 个窗格，每个窗格是一个镜片（`room` 或 `agent:<actorId>`），
> 共享同一条 SSE 与同一份 `state.turns/messages`，各自拥有独立的 DOM、滚动跟随、裁剪与「回到底部」；
> `agent` 镜片只画该 Agent 的回合卡、正文增量、推理与工具进度，用户提示默认折叠成一行；
> 布局与镜片写 `localStorage`，重启后恢复；单窗格 + `room` 时视觉与今天完全一致。

---

## 1. 需求语义拆解（被截图掩盖的四件事）

| # | 表面说法 | 事实 | 结论 |
| :--- | :--- | :--- | :--- |
| S1 | 「一个对话不断往上滚」 | 6 个 Agent 共用**一条** Room 时间线；`@all` 的 6 个回合、6 路 `turn.content.delta` 交错追加，`appendTimeline()` 每次贴底 | 痛点不是「历史太长」，而是**并发流的交错**：你盯着 A，B 的增量把 A 顶走 |
| S2 | 「多窗口并列」 | Cherry Studio 的窗口/标签是**多个独立 App 实例**（Electron 多窗口），每个话题一个；AIChatLink 的一页 = 一个 workspace = 一个活纪元 | 不能照搬「每窗格一个 runtime」：那会把 1 条 SSE 变成 4–6 条（见 §5.2） |
| S3 | 「四方格」 | 6 个 Agent 时 2×2 只放得下 4 个；3×2 才是全员 | 布局是**窗格数量**的函数（1/2/4/6），不是固定四格 |
| S4 | 「同时观看」 | 400px 宽的窗格里读 15px 中文长文是可行的（约 26 字/行），但不能同时出现 6 份完整用户长提示 | 车道里用户消息**默认折叠一行**，展开才显示全文；Agent 输出保持完整 |

### 1.1 需求边界（明确不做）

1. 不做「每个窗格一条 SSE」或「每个窗格一个 runtime」——见 §5.2。
2. 不做跨 workspace 同屏：workspace 切换是整页重载 + `?ws=` 事实源（D-040）；同屏并列会把两个 seq 空间塞进一份游标。
   跨目录监看用**浏览器多窗口**（每窗口天然一条 SSE），对话框里提供「在新窗口打开当前目录」入口。
3. 不做跨对话同屏：一个 workspace 只有当前纪元是 live，其它对话是历史回放；把历史塞进窗格需要第二套游标与回放状态机。
4. 不做窗格内独立输入器：一个房间一个输入器；窗格是观测面，发送仍只发生在底部 composer。
5. 不引入新依赖、新字号、新 hex、图标库。

---

## 2. 苏格拉底式提问（逐条给出可执行答案）

**Q1：用户要的是「多窗口」还是「多视角」？**
A：截图是**一条房间时间线 + 6 个 Agent**。用户说「不方便同时观看」——问题在**视角**，不在窗口数量。
因此第一版做「同一份实时状态的多个投影」，而不是「多个独立会话」。跨目录才回到窗口语义（浏览器多窗口），
两者互补且都不改协议。

**Q2：为什么窗格不能各自开一条 EventSource？**
A：现在的 `/` 就是「一个 workspace 一个活纪元一条 SSE」（`connectEventSource()` → `/api/events?afterSeq=`）。
如果每个窗格是 iframe / 独立实例，6 窗格 = 6 条长连接；Chrome/Firefox 对 HTTP/1.1 同源并发是 **6 条**，
Node `http` 服务没有 HTTP/2。6 条 SSE 会占满配额，后续 `/api/messages`、`/api/setup` 会排队到超时。
所以：**一条 SSE、一份 state、N 个只读投影**。这条约束也直接否决了「iframe 每格一个 App」的取巧方案。

**Q3：为什么窗格是「镜片」而不是「第二个时间线状态」？**
A：Turn 生命周期已经由 SSE / bootstrap / POST 三路写进 `state.turns`（D-044 的单一事实源）。
窗格若各自维护 Turn 状态，会出现「A 格已解锁、B 格还在转」的自相矛盾，也会把忙碌锁变成 6 份。
镜片只决定「这条已确认的事件画不画」，不决定「它是否存在」。

**Q4：`agent` 镜片要不要显示别人的消息？**
A：三类分开：
- **用户消息**：显示，但默认折叠为一行（`你 · 18:04 · 首行 60 字`），点开才是全文 + 回复/复制。
  否则 6 个车道各复制一份长提示，正好复现用户抱怨的「被顶走」。
- **该 Agent 自己的输出**：消息正文、推理记录、工具进度、Turn 卡（含取消）全部显示。
- **其他 Agent 的输出**：不显示。要看全局就把某个窗格设成 `房间（全部）`，那格就是今天的时间线。

**Q5：为什么镜片按 `turnId → targetActorId` 而不是按 `envelope.actor` 过滤？**
A：D-044 已经记录过：**终态事件本体不带 `targetActorId`**，`turn.interrupted` 的 actor 甚至是 `system`。
只按 actor 过滤会让「失败/中断」从车道里消失，而这恰恰是最需要看见的事件。
因此统一走 `resolveTurnTarget()`：`body.targetActorId` → `state.turns` 已有目标 → `envelope.to[0]` → `actor`。
解析结果随事件一起写进窗格回填日志，保证「新建窗格/切镜片」时同一事件仍落到同一车道。

**Q6：窗格什么时候回填？**
A：每个被接受的可见事件进入一条有界日志 `state.paneLog`（`PANE_LOG_MAX = 300`，只存 durable 事件，不存 delta）。
新建窗格、切换镜片、从单窗格扩成四方格时，按日志顺序重放，和房间时间线的顺序一致。
没有日志就会出现「中途加一格，前面全是空白，只有下一句话」。
日志上限与单窗格 DOM 上限（`TIMELINE_MAX_ITEMS = 500`）同一个量级，不新增内存合同。

**Q7：窗格独立滚动后，「回到最新」放哪？**
A：放在**窗格头**（右侧 `↓ N`），不放在底部浮标。原因：
1. 底部浮标依赖 `#timeline-actions` 的几何计算（相对 composer dock 的右缘），多窗格时它会横跨到邻格；
2. 头部是每个窗格恒定的锚点，6 格同时出现时也不会互相覆盖；
3. 单窗格 + `room` 仍沿用既有底部浮标（视觉零回归），只有「非基线模式」才切到头部按钮。
两条规则由 `html[data-panes="single-room|grid"]` 切换，不并存。

**Q8：窗格各自贴底，会不会 6 份自动滚动互相打架？**
A：不会。`createLatestFollower()` 本来就是「按容器实例」的：每个窗格一条 follower + 一个 `MutationObserver`。
「阅读优先」规则不变：滚轮/触摸/指针/翻页键暂停该格跟随，只有点该格 `↓`、滚回底部或自己发送才恢复。
窗格 A 的阅读不会被窗格 B 的增量打断。

**Q9：多窗格下，发送锁 / 活动栏 / 完成点还算谁的？**
A：仍是**房间的**。`isRoomWorking()` 读 `state.turns`，与窗格数量无关；活动栏和完成点也只属于房间。
窗格头只显示该 Agent 的**状态点**（ready / 工作中 / 失败 / 停用），不复刻完成点——完成点是「这一轮谁先结束」，
属于输入器旁边的活动栏（D-044），不能因为开了 4 格就变成 4 份。

**Q10：窗格数量和窗口宽度冲突时怎么办？**
A：宽度不是窗格数量的函数，反过来才是：`columns = count <= 1 ? 1 : count <= 4 ? 2 : 3`。
1600px 窗口开侧栏：内容区约 1200px，3 列 → 400px/格；不开侧栏约 1500px → 500px/格。
≤760px 时窗格墙改为**单列纵向滚动**（每格最小 320px 高），不与阅读列抢宽度，也不产生横向滚动。

**Q11：Agent 被移除/停用后，指向它的窗格怎么办？**
A：确定性地回落。`renderAgents()` 之后对每个 `agent` 镜片做一次对账：
不存在 → 改成 `room` 并持久化；存在但 `enabled=false` → 保留（仍能看历史输出），状态点显示「已停用」并给出说明。
不做「幽灵窗格」，也不静默丢掉用户的布局。

**Q12：为什么不做「拖动分隔条」和「窗格最大化」？**
A：拖动分隔条需要持久化每格像素宽度，并在 1/2/4/6 四套布局间维护比例，收益是「多 40px」；
最大化只是「单窗格 + 指定镜片」的一次点击，用对话框两下就能做到。
第一版把复杂度留给**过滤正确性**与**滚动独立性**，把这两件事做对；分隔条与专注模式列入「变更条件」。

**Q13：刷新后布局还在吗？会不会因为名册变化而错位？**
A：`localStorage["aichatlink:panes"] = {"count":4,"lenses":["agent:…","agent:…","room","agent:…"]}`。
读取时 `count` 夹到 1..6，`lenses` 补齐/截断到 `count`，非法值一律当 `room`；名册就绪后再对账（Q11）。
不写 URL：`?ws=` / `?conv=` 已经承担「哪一页」的事实源，布局是**本机偏好**，与 D-040 的折叠状态同类。

---

## 3. 专家会诊

| 角色 | 结论 | 对设计的约束 |
| :--- | :--- | :--- |
| 产品 / 协议 | 这是**观测面**，不是新的会话/权限模型；不得出现第二输入器、第二 Turn 状态 | 一个 composer、一份 `state.turns`；窗格只做投影 |
| 交互 / 视觉 | 6 格同时出现时，唯一允许的彩色是身份色（头像/名字）与状态点；不能用卡片阴影堆出「六块板」 | 窗格之间用 1px `--line` 发丝线，窗格头 `--paper-2`，正文仍是 `--canvas`；不新增字号/hex |
| 前端实现 | 现有渲染函数全部读模块级 DOM 单例（`timeline` / `eventNodes` / `roomFollow`…），最小改动是「可变渲染上下文」而不是把 1500 行改写成 class | `PaneContext` + `usePaneContext(pane)`；dispatch 逐格设置上下文，结束后恢复主格 |
| 可靠性 | 三处会丢事件：`context.reset` 清场、`delta` 批量 flush、`turn` 终态缺 target | reset 清所有格 + 清日志；delta 先累积一次再逐格写；target 解析随事件入日志 |
| 可访问性 | 6 个 `aria-live` 区域会重复播报 | 只有主格 `aria-live="polite"`，其余 `aria-live="off"`；窗格头用 `aria-label` 说明镜片 |
| QA | 不接受「看起来分栏了」作为证据 | 纯函数单测（镜片矩阵/列计划/持久化）+ 真实实例 eval（DOM 计数、滚动独立性、过滤结果）+ 三档宽度 + 明暗 |

**会诊分歧与裁决**

1. 交互建议「每格一个输入器，像 Cherry 的窗口」→ **否决**：一个房间一个输入器；多输入器会产生「从哪格发」的二义，
   并让忙碌锁与目标选择出现 6 份。跨会话发送应该换对话/换窗口，不是换格。
2. 前端建议「把时间线渲染重写成 `TimelinePane` 类」→ **条件接受**：先把渲染函数收敛到**单一可变上下文**（本次），
   类化重构留到下一次；本次不改变 `renderMessage/renderTurn` 的内部算法，只改变它们写到哪里。
3. QA 建议「每格一条 EventSource，避免共享状态」→ **否决**：HTTP/1.1 6 连接配额（§5.2）。
4. 产品建议「默认打开 6 格」→ **否决**：默认必须与今天一致（单格 `room`）；用户在对话框里主动选布局。

---

## 4. 横纵分析

### 4.1 横向（外部事实，非本仓库验收证据）

| 产品 | 事实 | 可迁移结论 | 不可迁移的部分 |
| :--- | :--- | :--- | :--- |
| **Cherry Studio 2.x** | 主窗口 = 侧栏 + 标签页 + 内容区；话题/Agent 任务可开多标签、可拆独立窗口、窗口置顶；同一问题可选多个模型并排比较（官方 Workbench 文档） | 「并列观看」的第一性需求成立；用户拿它当参照是合理的 | 它是**多实例 Electron 窗口**，AIChatLink 是**单页单 runtime**；照搬会撞 SSE 配额 |
| **Cherry Studio Issue #15258** | 「Agent 模式下多个 Agent 对话的平铺视图，用于并行观测」——closed / inactive；#15377 多窗口/分屏仍 open | 「Agent 级平铺」在成熟产品里也未被解决；本仓库的 room 拓扑反而更适合做 lane | 不把「上游没做」当成功理由；我们按自己的验收标准做 |
| **Sideview** | Split view 最多 4 个对话，可拖分隔条、双击均分、键盘调宽 | 「4 格」是阅读型界面的经验上限 | 它按**对话**分格；我们按**镜片**分格 |
| **Plexus** | 最多 6 个 Claude Code 会话并排；「同一会话里的两个 Agent 要看并排，就拆它的 Agents 标签」 | 双层语义：会话级并列 + 会话内 Agent 级并列 | 它每个 pane 是完整会话（自己的进程/流），我们共享一条流 |
| **Alter / Tesote** | 分屏用于「一边跑任务一边看资料」，强调上下文不复制 | 并列的价值是**同时可观测**，不是复制内容 | 不做跨会话桥接 |

结论：同类产品的共识是「并列是观测需求」，分歧在**并列的粒度**。AIChatLink 的房间拓扑决定了
本仓库最自然的粒度是**会话内的 Agent 车道**；跨目录/跨对话交给浏览器窗口。

### 4.2 纵向（本仓库演化）

1. **D-032**：确立单阅读列 1040px + 纸与墨；界面是阅读型，不是后台仪表盘。
2. **D-034/D-035**：对话 = `context.reset` 纪元投影；主时间线只画当前纪元；回放只读。
3. **D-040**：一目录一 runtime + hub 代理；`?ws=` 是唯一事实源；切换 = 整页重载（EventSource/seq 归零）。
4. **D-042**：`is-viewing` 与 `is-active` 分离；`?conv=` 双向同步。
5. **D-044**：输入器忙碌锁 + Agent 活动栏；Turn 生命周期第一次进入「离输入动作最近」的位置。
6. **本次**：第一次把**同一份实时状态**投影到多个并列容器。不是新增数据层，也不是新增网络层；
   是把「一个 `#timeline`」泛化成「N 个 pane context」，并给每个 context 一个过滤镜片。

---

## 5. 设计

### 5.1 布局

```
┌────────────────────────────── .conversation-panel ──────────────────────────────┐
│ ┌ pane-grid (data-count=4, gap:1px, bg:--line) ───────────────────────────────┐ │
│ │ ┌ pane 0 ───────────────┐ ┌ pane 1 ───────────────┐                        │ │
│ │ │ head: 提案 ▾  ●  ↓ 3 × │ │ head: 批判 ▾  ●       │                        │ │
│ │ │ timeline (own scroll)  │ │ timeline (own scroll)  │                        │ │
│ │ └────────────────────────┘ └────────────────────────┘                        │ │
│ │ ┌ pane 2 ───────────────┐ ┌ pane 3 ───────────────┐                        │ │
│ │ │ head: 设计 ▾  ●       │ │ head: 房间（全部）▾    │                        │ │
│ │ └────────────────────────┘ └────────────────────────┘                        │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│  composer dock（不变：一个输入器 + 活动栏）                                      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- 窗格墙：`display:grid; gap:1px; background:var(--line); min-height:0; flex:1 1 auto`。
- 列计划（纯函数，可单测）：

  | count | 轨道（6 轨） | 每格 span | 视觉 |
  | ---: | :--- | :--- | :--- |
  | 1 | 6 | `[6]` | 单窗格（基线） |
  | 2 | 6 | `[3,3]` | 左右并列 |
  | 3 | 6 | `[3,3,6]` | 上两格 + 下通栏 |
  | 4 | 6 | `[3,3,3,3]` | 四方格 |
  | 5 | 6 | `[2,2,2,3,3]` | 上三 + 下两（均分） |
  | 6 | 6 | `[2,2,2,2,2,2]` | 3×2 全员 |

- `grid-auto-rows: minmax(0, 1fr)`，每格 `min-height:0; min-width:0; overflow:hidden`。
- 窗格头：34px，`--paper-2`，底部 1px `--line`；左起 `[20px 头像] [lens select] [状态点]`，
  右侧 `[↓ N] [×]`。`×` 在 `count===1` 时隐藏；`↓` 只在离底 >120px 时出现。
- 空态：每格自己的 `<li class="pane-empty">`（不是 `#timeline-empty` 的克隆），文案按镜片区分（§5.4）。
- 单窗格 + `room`：`html[data-panes="single-room"]` → 隐藏窗格头、隐藏窗格墙的发丝线、显示既有
  `#timeline-actions`（对话目录 + 底部浮标）；其余模式 → 显示窗格头，**每格各有一套浮标栈**。
  > 2026-11-19 修订（D-062）：原计划的「其余模式隐藏浮标栈、由窗格头 `↓` 接管」已作废——
  > 用户在车道里也要这两个按键，且必须每格一套；窗格头不再放 `↓`。

### 5.2 被否决的方案（附硬约束）

| 方案 | 为什么看起来可行 | 为什么否决 |
| :--- | :--- | :--- |
| 每格 `<iframe src="/?ws=…&lanes=…">` | 零改造、天然隔离、每格可不同对话 | 每格 = 一个完整 App（bootstrap + conversations + **一条永久 SSE**）。4 格 = 5 条长连接，6 格 = 7 条；HTTP/1.1 同源上限 6，`/api/messages` 会排队到超时。Node `http` 无 HTTP/2（见 `src/web/server/server.ts`） |
| 每格一个 `AIChatLinkRuntime`（D-040 的 hub 分支） | 崩溃隔离、每格独立 seq | 4 个 runtime × 6 个 native CLI 进程 = 24 个会话；内存/端口/启动时间都不可接受，且与「同一房间 6 个 Agent」的产品语义冲突 |
| 把 6 个 Agent 拆成 6 个 conversation | 复用现有会话列表 | 破坏 D-009 的「同房间并行 + 互相 ask」拓扑；`@all`、监督配对、共享上下文全部失效 |
| CSS 多列 / `column-count` | 一行 CSS | 列按 DOM 顺序均衡，不按 actor 归类；同一 Agent 的增量仍分散在不同列 |
| 只在侧栏加 Agent 缩略流 | 改动最小 | 用户明确要「并列 / 四方格」，且 400px 的正文需要完整宽度；缩略流读不了 |

### 5.3 镜片（lens）语义

```
room        → 该窗格显示今天的主时间线（只受 envelopeInView 约束）
agent:<id>  → message.created: actor.kind === "user" || actor.actorId === <id>
              turn.*         : resolveTurnTarget(envelope) === <id>
              tool.progress* : resolveTurnTarget(envelope) === <id>
              context.reset  : 由全局清场处理（不进窗格）
              其它           : 不显示（supervision / operator.dispatch / memory.activity / generic）
```

- 用户消息在 `agent` 镜片里渲染为 `<details class="lane-prompt">`：summary = `你 · HH:mm · 首行 60 字`，
  展开后是完整正文 + 回复/复制动作。`room` 镜片保持今天的完整气泡。
- 每条 `message.created` 在车道里仍然替换同 turn 的流式节点（`existingArticle` 分支按窗格各做一次）。
- 终态 Turn 卡在车道里保留「失败原因 / 取消按钮」；车道的意义就是**看得见异常**。

### 5.4 空态文案

| 镜片 | 条件 | 标题 | 说明 |
| :--- | :--- | :--- | :--- |
| room | 当前纪元无内容 | 沿用今天的三套（房间已就绪 / 新对话已开始 / 这段对话没有可显示的消息） | 不变 |
| agent | Agent 存在，无输出 | 「还没有「X」的输出」 | 「本轮发给该 Agent 的内容会出现在这里。」 |
| agent | Agent 不在名册 | 「该 Agent 不在当前名册」 | 「用窗格标题或顶部 ▦ 换一个 Agent。」 |
| agent | Agent 已停用 | 「「X」已停用」 | 「历史输出仍可查看；启用后新回合才会出现在这里。」 |

### 5.5 交互

| 动作 | 入口 | 行为 |
| :--- | :--- | :--- |
| 打开多窗格 | 顶栏 `▦`（assistant 与配置之间） | 打开 `#panes-dialog` |
| 选布局 | 对话框 1 / 2 / 4 / 6 | 即时应用；新增的格子默认按名册顺序取 Agent；减少时保留前 N 个镜片 |
| 按 Agent 铺满 | 对话框按钮 | `count = min(可用 Agent 数, 6)`，按 `orderedAgents()` 顺序一格一个；不足 6 格补 `room` |
| 改单格镜片 | 窗格头 `<select>` 或对话框行 | 清空该格 DOM → 按日志回填 → 滚到底；持久化 |
| 关一格 | 窗格头 `×`（`count>1`） | 移除该镜片，后面的前移；重绘所有格（保持顺序一致）；持久化 |
| 回到该格最新 | 窗格头 `↓ N` | 恢复跟随 + 瞬时贴底 + 清角标；多格下这是**唯一**的滚动恢复入口（不再「滚回底部自动恢复」，见 §12 的实测竞态） |
| 重置 | 对话框「单窗格（房间）」 | `count=1, lenses=["room"]`；回到基线 |
| 新窗口 | 对话框「在新窗口打开当前目录」 | `window.open(location.href, "_blank", "noopener")`，用于跨目录/跨屏幕监看 |

键盘与读屏：`▦`、布局按钮、每格 `select`/`↓`/`×` 都是原生可聚焦元素；
窗格 `<section role="group" aria-label="窗格 N：<镜片名>">`；`↓` 的 `aria-label` 含未读条数。

### 5.6 持久化与恢复

```
localStorage["aichatlink:panes"] = {"count":4,"lenses":["agent:pi-architect","agent:pi-contrarian","agent:pi-designer","room"]}
```

- 解析失败 → `{count:1, lenses:["room"]}`，不抛错。
- 名册就绪后：`agent:<id>` 不存在 → `room`（并写回）；存在但停用 → 保留。
- 不写 URL、不写 DB：与 `aichatlink:sidebar` / `aichatlink:collapsed-workspaces` 同类。
- 回滚：删掉这个键即回到单窗格。

### 5.7 与现有能力的交叉

| 现有能力 | 多窗格下的行为 |
| :--- | :--- |
| 历史回放 `?conv=` | 所有窗格按同一 `conversationView` 回放；agent 车道只显示该 Agent 的历史段；`?conv=` 语义不变 |
| 忙碌锁 / 活动栏（D-044） | 完全不变：读 `state.turns`，与窗格数量无关；活动栏点击跳到**该 Agent 所在的车道**（没有车道就跳主格） |
| 对话目录（TOC） | 每个窗格各一套，只索引本格节点（2026-11-19 修订，D-062；原「只在 single-room 显示」作废） |
| `context.reset` | 清空所有窗格的 DOM/节点表/裁剪状态 + 清空回填日志；空态文案逐格刷新 |
| workspace 切换 | 整页重载（D-040 不变）；布局键跨目录共享（同一台机器的偏好） |
| 房间助理抽屉 | 不变；抽屉打开时窗格墙随主列收窄，`grid-auto-rows` 自然压缩 |
| 移动端 ≤760px | 窗格墙单列纵向滚动，每格最小 320px；对话框可操作；不产生横向滚动 |

---

## 6. 逐文件实施规格

### 6.1 新增 `web/pane-lens.ts`（纯逻辑，无 DOM）

```ts
export type PaneLens = { kind: "room" } | { kind: "agent"; actorId: string };
export const MAX_PANES = 6;
export const DEFAULT_PANES = { count: 1, lenses: [{ kind: "room" }] };

export function parsePaneLens(value: unknown): PaneLens | null;      // "room" | "agent:<id>"
export function formatPaneLens(lens: PaneLens): string;
export function normalizePanes(value: unknown): { count: number; lenses: PaneLens[] };
export function paneColumns(count: number): 1 | 2 | 3;
export function paneSpans(count: number): number[];                  // 6 轨下的 span
export function lensAccepts(
  lens: PaneLens,
  envelope: { type: string; actor: { kind: string; actorId: string } },
  targetActorId: string | null | undefined
): boolean;
```

`lensAccepts` 的矩阵必须覆盖：用户消息、本 Agent 消息、他 Agent 消息、`turn.*`（含终态、target 缺失）、
`turn.content.delta`、`turn.reasoning.*`、`tool.progress*`、`supervision.*`、`operator.dispatch`、
`memory.*`、`session.*`、未知类型。

### 6.2 新增 `web/pane-view.ts`（DOM 壳层）

```ts
export interface PaneShell {
  section: HTMLElement;      // <section class="pane" role="group">
  head: HTMLElement;         // <header class="pane-head">
  avatar: HTMLElement;
  select: HTMLSelectElement; // room + 每个 Agent
  stateDot: HTMLElement;
  jump: HTMLButtonElement;   // ↓ N
  close: HTMLButtonElement;  // ×
  timeline: HTMLOListElement;// <ol class="timeline">
  empty: HTMLLIElement;      // <li class="pane-empty">
}
export function createPaneShell(id: string, opts: { primary: boolean }): PaneShell;
export function fillPaneLensOptions(select: HTMLSelectElement, agents: readonly {actorId: string; displayName: string}[]): void;
```

主格（`primary: true`）复用 `#timeline` 与 `#timeline-empty`：`createPaneShell` 不再创建 `<ol>`，
而是接收现有的两个元素，并把 `<header>` 插到 `<ol>` 之前。

### 6.3 `web/index.html`

1. `<main>` 内、`#timeline-actions` 之前，插入：

```html
<div id="pane-grid" class="pane-grid" data-count="1">
  <ol id="timeline" …>…</ol>
  <!-- 动态窗格由 JS 插到 #pane-grid -->
</div>
```

主格的 `<header>` 由 JS 插入；`<ol id="timeline">` 保持原 id / role / aria-live，被包进 `section#pane-0`。
2. 顶栏 `header-actions` 增加 `#panes-toggle`（内联 SVG 四宫格，`aria-label="多窗格"`）。
3. 新增 `<dialog id="panes-dialog">`：布局芯片（1/2/4/6）、`#panes-assignments`（每行 select）、
   `#panes-fill-agents`、`#panes-reset`、`#panes-open-window`、`#panes-status`。

### 6.4 `web/styles.css`

| 选择器 | 作用 |
| :--- | :--- |
| `.pane-grid` | 6 轨 grid、`gap:1px`、`background:var(--line)`、`min-height:0`、`flex:1 1 auto` |
| `.pane` | `display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--canvas); overflow:hidden` |
| `.pane-head` | 34px、`--paper-2`、底部 1px `--line`、`padding:0 8px`、`gap:6px` |
| `.pane-lens` | 无边框 select、`--fs-12`、`--ink`、`:focus-visible` 走全局描边 |
| `.pane-state` | 6px 点：`--ok` / `--warn` / `--danger` / `--faint`（与名册同语义） |
| `.pane-jump` | 24px 圆、`--paper`、`--line-2`、`aria-hidden=false` 时显示；角标 mono `--fs-10` |
| `.pane-close` | 24px、`--muted` → `--danger` hover |
| `.pane .timeline` | `padding:12px 16px 20px`；取消 `--column` 居中（窗格内不做阅读列缩进） |
| `.pane-empty` | 居中、`--muted`、`--fs-13`、衬线标题 `--fs-20` |
| `.lane-prompt` | `--well` 底、`--r-sm`、summary 单行省略、`--fs-12` |
| `html[data-panes="single-room"] .pane-head` | `display:none` |
| `html[data-panes="single-room"] .pane-grid` | `gap:0; background:transparent` |
| `html[data-panes="grid"] .timeline-actions` | `display:none` |
| `@media (max-width:760px)` | `.pane-grid { grid-template-columns:1fr !important; grid-auto-rows:minmax(320px,auto); overflow-y:auto }` |

禁止：新增 hex / 字号 / 阴影；给窗格加 `border + shadow + radius` 三件套；用状态色做装饰。

### 6.5 `web/app.ts`

#### 6.5.1 渲染上下文

```ts
interface PaneContext {
  id: string;
  lens: PaneLens;
  shell: PaneShell;
  timeline: HTMLOListElement;      // 主格 = #timeline
  empty: HTMLLIElement;            // 主格 = #timeline-empty
  follow: LatestFollower;
  nodes: { events; turns; streams; toolProgress };
  jump: { pending: number };
  trim: { count: number; notice: HTMLLIElement | null };
  lastDate: string;
}
let panes: PaneContext[];          // panes[0] = 主格（静态 DOM）
let activePane: PaneContext;       // 渲染函数读到的上下文
function usePaneContext(pane: PaneContext): void; // 把 timeline/empty/nodes/follow/jump/trim 别名切过去
```

把现有 `const timeline = byId(...)`、`const eventNodes = new Map()`、`const roomFollow = createLatestFollower(...)`
等改为 `let` 别名，由 `usePaneContext()` 赋值；初始化时把主格装上。
**任何异步回调都不得依赖 `activePane`**：dispatch 末尾与每个同步循环结束后恢复主格。

#### 6.5.2 dispatch 分层

```ts
function dispatchEnvelope(envelope, live): void {
  if (!envelopeInView(envelope)) { /* reset 仍刷新侧栏 */ return; }
  const target = resolveTurnTarget(envelope);
  applyEnvelopeGlobals(envelope, live, target);   // state / rail / memory 列表 / unread / reset
  if (envelope.type === "context.reset" || envelope.type === "adapter.heartbeat") return;
  const entry = { envelope, targetActorId: target };
  state.paneLog.push(entry); trimPaneLog();
  for (const pane of panes) {
    if (!lensAccepts(pane.lens, envelope, target)) continue;
    usePaneContext(pane);
    paintEnvelope(envelope, live);
  }
  usePaneContext(panes[0]);
}
```

- `applyEnvelopeGlobals`：`state.messages` 写入、`updateAgentFromSessionEvent`、`renderRuntimeProgress`、
  memory map + `renderPublicMemoryRecords`、`unreadCount` + `document.title`、`openConversationEpoch`。
- `trackTurnEnvelope()`：Turn 生命周期的**共享状态**（`state.turns`、target 解析、`finishedAgents` 跃迁、
  活动栏通报与终态 delta 清理）在窗格循环之前只跑一次。这样即使 4 个窗格全是 Agent 车道、
  没有一个房间格，未上屏的 Turn 仍然进入忙碌锁与活动栏；`paintEnvelope` 不再写状态、不再判定完成点。
  实现时先按「逐格 paint」写，实测发现未上屏回合会被忙碌锁漏掉，才拆成全局/投影两层。
- `paintEnvelope`：原 `renderMessage / renderTurn / reasoning / tool.progress / supervision / operator.dispatch /
  recordActivity / generic` 分支；`session.*`、`memory.*` 的**纯全局部分**不再进入。
- `flushDeltaBuckets`：先一次性把 pieces 累积到 `state.transientText`，得到 `[{bucket,text}]`；
  再逐格 `usePaneContext` + `updateStreamingNode`。
- `finalizeStreamsForTurn`：`closedStreamKeys` / `deltaBuckets` 幂等清理一次，DOM 标记逐格执行。
- `clearTimelineView`：逐格清 DOM + 节点表 + trim + jump + lastDate；清 `state.paneLog`；全局状态照旧。
- `refreshEmptyStateCopy`：逐格按镜片写空态（§5.4）。
- `appendConversationBoundary` / TOC / `jumpToNode` / `latestVisibleMessageEventId`：只在主格（`usePaneContext(panes[0])`）。
- `jumpToAgentLatest`：优先该 Agent 的车道窗格；没有则主格。

#### 6.5.3 窗格管理

```ts
const PANES_STORAGE_KEY = "aichatlink:panes";
function restorePanes(): void;
function persistPanes(): void;
function applyPanes(lenses: PaneLens[]): void;   // 增/删/换 DOM，按需回填，重排 grid spans
function repaintPane(pane: PaneContext): void;   // 清 + 按 paneLog 回填 + resume
function hydratePane(pane: PaneContext): void;   // 日志回填（新建窗格/切镜片）
function syncPaneHeaders(): void;                // 头像/名字/状态点/select 选项/关闭按钮
function syncPaneChrome(): void;                 // data-panes、列计划、legacy 浮标显隐
function openPanesDialog(): void;
```

- `applyPanes`：`panes.length` 增加 → `createPaneShell` + 挂 follower/observer + `hydratePane`；
  减少 → `section.remove()`；同长度且镜片变化 → `repaintPane`。最后 `syncPaneChrome()` + `persistPanes()`。
- `hydratePane`：按 `state.paneLog` 顺序、`lensAccepts` 过滤后 `paintEnvelope`（`live=false`），
  不做 unread / finished 跃迁。
- `syncPaneHeaders`：`fillPaneLensOptions(select, agents)`；`select.value = formatPaneLens(lens)`；
  `change` → `applyPanes(lenses.with(index, parsed))`；状态点取 `state.agents` + `activeTurnActorIds`。
- `renderAgents()` 末尾调用 `syncPaneHeaders()`；若名册里找不到某个 `agent` 镜片 → 改成 `room` + 持久化 + 重绘。
- 主格 `select` 变更同样走 `applyPanes`（保持数组顺序）。

#### 6.5.4 主格兼容

`panes[0]` 始终存在且持有 `#timeline` / `#timeline-empty`。基线（`count===1 && lens.kind==="room"`）：
`data-panes="single-room"`，隐藏窗格头与 `#panes` 发丝线，保留 `#timeline-actions`、
`syncJumpLatestGeometry()` 的既有行为；非基线时 `data-panes="grid"`，每格仍有自己的
`.timeline-actions`，几何按格与 composer dock 计算（D-062）。

### 6.6 `src/web/server/server.ts`

`StaticAsset["fileName"]` 联合类型与 `STATIC_ASSETS` 增加 `pane-lens.js`、`pane-view.js`
（`scripts/copy-web.mjs` 已递归复制整个 `web/`，只需要白名单）。

### 6.7 测试

新增 `tests/unit/web/pane-lens.test.ts`：

1. `parsePaneLens` / `formatPaneLens` 往返；非法输入返回 `null`；`agent:` 空 id 拒绝。
2. `normalizePanes`：缺省 / count 夹取 1..6 / lenses 补齐与截断 / 非法项降级 room / 非对象输入。
3. `paneColumns` / `paneSpans`：1..6 的列数与 span 总和恒为 6；count 3 末格通栏；count 5 为 `[2,2,2,3,3]`。
4. `lensAccepts` 矩阵（§5.3 全表 + 未知类型 + `targetActorId` 缺失 + actor 为 `system` 的终态）。

已有 753 项测试不得回归；`web/app.ts` 的 DOM 行为由真实实例 E2E 覆盖（仓库 vitest 为 node 环境，不引入 jsdom）。

### 6.8 文档

- 本文件：计划 + 钢人 + 反向拆解 + 验收记录。
- `docs/WEB_UI.md`：新增 §13「多窗格（pane grid）」，登记布局度量、窗格头、镜片、禁止清单与验收。
- `docs/DECISIONS.md`：新增 **D-045：多窗格 = 同一实时状态的多个镜片投影**，写明触发证据、被否决方案（SSE 配额）、
  持久化、回滚边界。

---

## 7. 反向拆解（从验收倒推，找出会断的那一刀）

| 验收项 | 必要条件 | 可能的断点 | 预防 |
| :--- | :--- | :--- | :--- |
| 四方格出现 | `applyPanes` 建 3 个新 section + 列计划 | 动态 section 没挂 `.pane` 样式 → 堆成一列 | `createPaneShell` 单测不可行 → E2E 断言 `gridTemplateColumns` 与 section 数量 |
| 每格独立滚动 | 每格自己的 follower + observer | 复用了主格 `roomFollow` → 6 格一起跳 | `pane.follow` 独立实例；E2E：滚格 A，断言 B 的 `scrollTop` 不变 |
| 车道上只出现该 Agent | `lensAccepts` + `resolveTurnTarget` | 终态事件 actor=system 且 body 无 target → 失败卡消失 | target 随事件入 `paneLog`；单测覆盖缺 target |
| 失败/取消可见 | 车道接受 `turn.*` | `renderTurnEnvelope` 回退到 `actor.actorId` 导致 target=system | `resolveTurnTarget` 优先 `state.turns`；单测 |
| 用户提示不淹没车道 | lane prompt 折叠 | `renderMessage` 只走一条路径 → 车道也全展开 | `pane.lens.kind === "agent" && actor.kind === "user"` 分支；E2E 断言 `<details>` 存在且 `open=false` |
| 中途加一格有历史 | `paneLog` 回填 | 只回填 `state.messages` → Turn 卡顺序错乱/缺失 | 回填走日志；日志上限 300 |
| 切镜片不丢当前流 | 新格/改镜片后继续收 delta | `streamNodes` 是主格 Map → 新格不建流节点 | 节点表按格；`flushDeltaBuckets` 逐格写；E2E 在流式中切镜片 |
| 刷新恢复布局 | localStorage + 名册对账 | 名册异步加载，恢复时把 `agent:` 当非法降级 | 先按存储建格（头部用 actorId 兜底），`renderAgents()` 后再对账 |
| 单窗格零回归 | `data-panes="single-room"` | 窗格头占了 34px、浮标跳到面板右边 | CSS 基线隐藏头/间隙；`#timeline-actions` 显隐按模式；截图对照 |
| 忙碌锁仍是一份 | `isRoomWorking()` 不变 | 每格复制 Turn 状态导致锁不同步 | 不引入 per-pane Turn 状态；E2E 断言全部格子同时解锁 |
| 对话目录不串格 | TOC 只读主格 | `eventNodes` 切到别的格 → 跳到不存在的节点 | TOC 相关函数强制 `usePaneContext(panes[0])` |
| 回放不锁输入器 | 现有 gate | 车道的 turn 卡让 `state.turns` 看起来活跃 | D-044 的 `conversationView === null` gate 不变 |
| 6 条 SSE 的诱惑 | 架构约束 | 后续有人把窗格改成 iframe | 本文件 §5.2 + D-045 写明「一条 SSE」是决策，不是实现细节 |
| 静态资源 404 | server 白名单 | 新模块只在 `web/`，`dist/web` 复制了但没登记 | 6.6 + E2E `GET /pane-lens.js` 200 |
| 移动端横向滚动 | 单列纵向 | 6 轨 grid 在 430px 放 400px min → 溢出 | `@media` 单列 + `overflow-y:auto`；三档截图 |
| 暗色可读 | token only | 窗格头 `--paper-2` 与正文 `--canvas` 对比不足 | 明暗截图 + 不用 `--faint` 承载信息 |

---

## 8. 双向钢人论证

### 8.1 正方（替方案补到最强）

1. **不改协议、不改存储、不改路由**：所有新能力都在呈现层；Broker/MCP/CLI 完全不知情，回滚只删前端文件。
2. **单一事实源**：一条 SSE、一份 `state.turns/messages`；窗格只是投影，不会出现「两格对同一回合判断不同」。
3. **直接命中痛点**：`agent` 车道把「6 路交错」变成「6 条独立流」，且每格独立滚动/贴底，不再互相顶走。
4. **基线零回归**：默认单格 `room`，DOM/CSS 走 `data-panes="single-room"` 分支，截图与 D-044 验收一致。
5. **可测**：镜片矩阵、列计划、持久化归一都是纯函数；滚动独立性与 DOM 计数用真实浏览器 eval 断言。
6. **有界**：日志 300 条、DOM 500 条/格、最多 6 格；最坏 3000 个节点量级，与现有长对话同一数量级。
7. **可逆且渐进**：先做 1/2 格，再做 4/6 格；任何一步失败都能回到单格，不迁移数据。

### 8.2 反方（最致命的反面）

1. **6 格正文都太窄**：400px 格子里 15px 中文长文会频繁折行，读起来比单列更累——用户可能只是「想看进度」，不是「想读全文」。
2. **`agent` 车道丢掉了对话结构**：Agent A 的回复依赖 B 的上一条，车道上只看到 A 的答案，因果链被切断。
3. **一份日志回填不是真历史**：超过 300 条后新建窗格会缺前半段；用户会以为「这个 Agent 没说过」。
4. **渲染扇出放大回归面**：`renderMessage` / `renderTurn` 里任何依赖单例的隐藏假设（`eventNodes`、`jumpLatest`、date divider）
   都可能在多格下暴露成重复/漏画。
5. **滚动独立 = 用户要自己管 6 个滚动位置**：6 格都暂停跟随之后，「回到底部」要点 6 次。
6. **布局持久化会制造「我明明关过」的困惑**：换机器/清缓存后布局消失；多人共用浏览器配置时互相覆盖。
7. **移动端几乎不可用**：单列纵向 + 每格 320px，等于把 6 个格子叠成一条长页面，滚动嵌套。
8. **它没有回答「跨对话/跨目录同时看」**：用户提到 Cherry Studio 的多窗口，可能真正想要的是「两个项目同时跑」。

### 8.3 裁决与缓解

| 反面 | 裁决 | 缓解 |
| :--- | :--- | :--- |
| 1 | **接受，用默认值与布局上限缓解** | 默认 1 格；4 格 2 列 ≈600px；6 格只在用户主动选「全员」时出现；车道的用户提示折叠、正文保持 15px；`WEB_UI` 登记「6 格是监看，不是长文阅读」 |
| 2 | **接受，用「房间格」补因果** | 车道上保留该 Agent 自己的 Turn 卡（含 `回复 @…` 引用行）；用户可留一格 `room` 作为总览；不做跨格拼接（那会是第二套 transcript） |
| 3 | **接受，写明边界** | 日志 300 条 ≈ 现有 `TIMELINE_MAX_ITEMS` 的 60%；窗格头 `title` 说明「新建窗格只回填最近 300 条」；超长对话请用单格 room 或历史回放 |
| 4 | **必须修** | 逐函数审计单例读取；`flushDeltaBuckets` / `finalize` / `clear` / `trim` / date divider / jump 全部改为按格；E2E 用 6 格真实回合对照「每格只有自己的消息」 |
| 5 | **接受，给批量入口** | 顶部「↓」只作用于该格；`Shift`+点击任一 `↓` = 全部格回到底部（小成本，写进 §5.5） |
| 6 | **接受** | 与 `aichatlink:sidebar` 同类、键名可发现；对话框「重置为单窗格」一键回基线；不承诺跨设备同步 |
| 7 | **接受，降级为「单列可滚」** | ≤760px 不做多列；对话框在移动端可开；验收只要求「不横向滚动 + 可切回单格」 |
| 8 | **部分接受，给出口** | 对话框提供「在新窗口打开当前目录」（浏览器窗口 = 独立 SSE，天然跨目录）；跨对话同屏列入「变更条件」，不混进本次 |

**结论：方案通过。** 反方没有推翻「多镜片投影 + 一条 SSE」这个核心决定；所有技术性风险都已落到 §7 的预防表，
产品性风险用默认值、房间格与新窗口出口收敛。

---

## 9. 验收清单（完整闭环）

### 9.1 自动化

```bash
npm run typecheck
npx vitest run
npm run build
```

- 新增 `tests/unit/web/pane-lens.test.ts` 全绿；既有 753 项不回归。
- `dist/web/pane-lens.js`、`dist/web/pane-view.js` 存在；`GET /pane-lens.js`、`GET /pane-view.js` 返回 200。

### 9.2 真实实例（独立端口 + 独立库，不碰 4310 用户实例）

1. 复制 `.aichatlink/aichatlink.db*` 到 `_tmp/verify-panes/data/`，配置 `port=4311`，6 个 pi Agent 全部 `ready`。
2. Playwright 打开 `/`：
   - 默认单格 `room`，与改动前截图一致；`#timeline` 顶栏高度、浮标位置不变。
   - 顶栏 `▦` 打开对话框，选 4：出现 4 个 `.pane`，`gridTemplateColumns` 为 2 列，无横向滚动。
   - 「按 Agent 铺满」：6 格 3 列；每格 `select` 值与名册一致；`html[data-panes="grid"]`。
3. 车道正确性（用已有回放/新回合）：
   - 每格原生只有该 Agent 的 `message.created`（`data-event-id` 抽样比对 actor）；
   - 用户消息是 `details.lane-prompt` 且默认关闭；
   - `turn-card` 的 target 与格子一致；失败回合在同格可见。
4. 滚动独立性：
   - 滚格 A 200px，触发 B/C 的新增量，断言 A 的 `scrollTop` 不变、B 贴底；
   - 格 A 出现头部 `↓ N`，点击后 `scrollTop` 回到底部、角标消失。
5. 中途加格/切镜片：
   - 流式回合进行中把格 2 从 room 改为某 Agent，断言 `<details>`/流式节点出现且继续增长；
   - 切成另一个 Agent，旧 Agent 的节点消失。
6. 持久化：
   - 刷新后 `count`/`lenses` 保持；把某 Agent 从名册移除（或改配置）后，该格回落 `room`。
7. 基线零回归：
   - 切回「单窗格（房间）」：窗格头消失、浮标与对话目录与基线一致；多窗格时每格浮标与目录都在（D-062）；
   - 1600×1000 / 1280×800 / 430×900 三档无横向滚动；
   - 暗色下窗格头/状态点/折叠提示可辨。
8. 忙碌锁：
   - `@all` 发起一轮，发送键锁定；4 格/6 格同时观察，终态后一次解锁（不是逐格解锁）。
9. 历史回放：
   - `?conv=<id>` 在 4 格下回放，每格只显示该镜片范围；输入器不锁。
10. 资源：
    - `/pane-lens.js`、`/pane-view.js` 200；`/app.js` 引用的 import 不 404；CSP 无新放行项。

### 9.3 回归

- D-044：活动栏点击跳到该 Agent 的车道；浮标/活动栏不重叠（基线）。
- D-042：`is-viewing` 与 `?conv=` 不因窗格切换被改写。
- D-040：`?ws=` 切换整页重载，窗格布局从 localStorage 恢复；另一个 workspace 的 `conv:1` 不会串格。
- 房间助理抽屉：打开/关闭时 4 格随宽度收缩，无横向滚动。
- `context.reset`：所有格子清空、空态正确、日志清空；旧 Turn 不残留在任何格。

---

## 10. 实施顺序

1. `web/pane-lens.ts` + `tests/unit/web/pane-lens.test.ts`（先红后绿）。
2. `web/pane-view.ts` + `index.html` 骨架 + `styles.css` 窗格/头部/空态/折叠/响应式。
3. `app.ts`：`PaneContext` + `usePaneContext`（主格单例迁移，行为不变）。
4. `app.ts`：dispatch 分层、delta/finalize/clear/trim/date/jump 逐格化。
5. `app.ts`：`applyPanes` / 回填日志 / 头部同步 / 对话框 / 持久化 / 基线切换。
6. `server.ts` 白名单；`WEB_UI.md` §13；`DECISIONS.md` D-045。
7. `npm run typecheck` → `npx vitest run` → `npm run build`。
8. 独立实例 4311 真实回合 + Playwright 三档/明暗/滚动/过滤验收。
9. 把实测证据写进 §12，判定闭环；`未观察项` 如实登记。

**部署注意（2026-11-18 实测事故）**：本机全局包 `@aiyao/aichatlink` 是**指向本仓库的软链**，
静态文件按请求从 `dist/web` 读取，而后端静态白名单在进程启动时载入。因此 `npm run build` 会**立刻热替换**
运行中实例的前端；若不同步 `restart`，旧后端会把新增的 `pane-lens.js` / `pane-view.js` 当未知资源返回 404，
ES module 导入失败会让整个页面停在「房间准备中」（0 / 0 Agent，所有控件失效）。
**规则：构建与重启必须成对执行**（`npm run build && node dist/src/cli.js restart --no-open`），
或在用户实例运行期间避免构建。

---

## 11. 回滚边界

| 想撤回 | 操作 |
| :--- | :--- |
| 只回到单窗格 | 删 `localStorage["aichatlink:panes"]`，或对话框「单窗格（房间）」 |
| 只关掉多窗格入口 | 删除 `#panes-toggle` 与其监听；`applyPanes` 不会被调用，主格行为不变 |
| 全部回滚 | 还原 `web/index.html` / `web/styles.css` / `web/app.ts`；删除 `web/pane-lens.ts` / `web/pane-view.ts` / 单测；`server.ts` 白名单移除；D-045 标记 Reverted |

不涉及数据库迁移、协议版本、runtime 重启；用户 4310 实例不受影响。

---

## 12. 验收记录（2026-11-18）

验证实例：仓库构建产物在 `127.0.0.1:4311` 启动，独立配置与数据库副本（`_tmp/verify-panes/`），
6 个 pi Agent 全部 `ready`；用户全局实例（4310）未重启、未改动。浏览器：Playwright + Chromium 151
（`chromium-1234`），脚本与截图在 `_tmp/verify-panes/`。

| # | 验收项 | 结果 | 证据 |
| :--- | :--- | :--- | :--- |
| 1 | `npm run typecheck` | 🟢 通过 | 无输出 |
| 2 | `npx vitest run` | 🟢 **763/763**（72 文件），含新增 `tests/unit/web/pane-lens.test.ts` 10 项 | 终端输出 |
| 3 | `npm run build` | 🟢 通过 | `dist/web/pane-lens.js`、`dist/web/pane-view.js` |
| 4 | 静态资源 | 🟢 `/pane-lens.js` 200、`/pane-view.js` 200 | curl |
| 5 | 单窗格基线 | 🟢 `data-panes=single-room`，窗格头 `display:none`，1 个 `.pane` 占满 1300px，无横向滚动 | `shots/10-single.png`、`41-baseline-final.png` |
| 6 | 四方格 | 🟢 4 格 650×414，span `3,3,3,3`，头可见，→ `data-panes=grid` | `shots/12-four.png` |
| 7 | 全员六格 | 🟢 6 格 433×414，span `2×6` | `shots/13-six.png` |
| 8 | 五格 | 🟢 5 格 span `2,2,2,3,3`，下排 649/650px | `final.mjs` 输出 |
| 9 | 按 Agent 铺满 / 改镜片 / 关闭格 | 🟢 6 格按名册顺序；改第 2 格为「提案」；关闭第 3 格后 4 格；落盘 `agent:pi-architect`（单前缀） | `final.mjs`、`behavior.mjs` |
| 10 | 刷新恢复 | 🟢 6 格与镜片原样恢复（`localStorage`），名册对账后不降级 | `shots/15-reloaded.png` |
| 11 | 幽灵 Agent | 🟢 `agent:ghost` → 回落 `room`，并把 `{"count":2,"lenses":["room","room"]}` 写回 | `final.mjs` |
| 12 | 真实 3 Agent 回合（composer 发送） | 🟢 SSE 帧 `message.created#283 … turn.completed#298`；room 4 卡（user + 3 Agent）、3 个 Turn 卡；每个车道只有本 Agent 1 条消息 + 1 个折叠提示；忙碌锁在全部终态后一次解锁 | `live3.mjs`、`shots/30-live-composer.png` |
| 13 | 车道过滤精确 | 🟢 车道 `withActor` 分别只有 `agent:pi-architect` / `agent:pi-reviewer` / `agent:pi-contrarian`；room 含三者 | `live3.mjs` |
| 14 | 用户提示折叠 | 🟢 每车道 `lane-prompt` 1 个，默认 `open=false`，summary 为 `你 · HH:mm · 首行 60 字` | `live3.mjs` |
| 15 | 独立滚动 | 🟢 暂停 architect 车道（top 85→0）后，room 2493→2600、reviewer 1339→1446 继续贴底，architect 保持 **0**；`↓` 可见、角标 `1`；点击后 top 676（=底部） | `scroll3.mjs` |
| 16 | 扩格回填 | 🟢 单格 → 4 格后新格从日志回填：architect 3 卡、contrarian 3 卡、designer 2 个折叠提示 | `behavior.mjs` |
| 17 | 历史回放 | 🟢 `?conv=conv:248` + 4 格：room 9 卡 6 个 Turn、车道 5 卡 4 提示；顶部横幅显示；输入器未被忙碌锁住（发送键仅因空草稿禁用） | `behavior.mjs`、`shots/31-history-four.png` |
| 18 | `context.reset` | 🟢 4 格同时清空（cards/turns 全 0），空态按镜片分别显示「新对话已开始」/「还没有「X」的输出」 | `reset.mjs`、`shots/40-after-reset.png` |
| 19 | 1280×800 | 🟢 4 格 490×314，无横向滚动 | `shots/50-1280-four.png` |
| 20 | 430×900 | 🟢 6 格单列 430×300，`#pane-grid` 纵向滚动，无横向滚动；关侧栏后头不溢出 | `shots/53-430-six-no-sidebar.png` |
| 21 | 暗色 | 🟢 4 格窗格头/状态点/折叠提示可辨 | `shots/51-dark-four.png` |
| 22 | 新窗口入口 | 🟢 `#panes-open-window` 打开 `http://127.0.0.1:4311/` 弹出窗口 | `final.mjs` |
| 23 | 无 JS 错误 | 🟢 全部脚本 `pageerror` / console error 为空（CSP 的既有提示除外） | 各脚本输出 |
| 24 | 未上屏回合（4 个 Agent 车道，无房间格，发给不在车道里的 Agent） | 🟢 忙碌锁仍然上锁/解锁；活动栏该 Agent `working → finished=completed`；4 格无它的内容；把一格切到该 Agent 后从日志回填 2 卡 + completed Turn | `unwatched.mjs`、`shots/60-unwatched-lane.png` |

**未观察项（如实登记）**

1. **6 格同时流**只做了 3 个 Agent 的真实回合；6 格渲染与布局用 6 个镜片验证，但没有 6 路同时 delta 的实测。
2. **停用 Agent 的车道**：代码保留并显示「已停用 / 历史输出可看」，未在真实配置里构造 `enabled:false` 的现场。
3. **回填日志 300 条上限**与**每格 500 条 DOM 裁剪**：按代码与单测理解，未构造超长对话逐条验证。
4. **触摸滚动**：Playwright 用 `WheelEvent` 模拟 wheel 暂停；移动端触摸手势未在真机验证。
5. **拖动分隔条 / 窗格最大化**：明确不在本版范围（§2 Q12）。
6. **跨目录同屏**：明确不做（§5.2），以浏览器多窗口替代；只验证了「新窗口打开当前目录」。
7. **5 格的视觉细看**：只验证了 span/rect 与无横向滚动，未逐一截图审阅。
8. **`prefers-reduced-motion`**：本次未新增动效，沿用既有规则。

**实测发现的偏差（已修）**

- 多格下「滚回底部自动恢复跟随」会把用户暂停的格子重新贴底：程序化 `scrollToLatest` 产生的延迟
  `scroll` 事件在 wheel 之后到达，`isNearBottom()` 为真 → `resume(false)`。已在 `createLatestFollower`
  移除该自动恢复（暂停后只走该格 `↓` 或自己发送），并同步修订 `WEB_UI` §九 与 D-045 第 8 条。
- 车道镜片最初按 `agent:` + `actorId` 二次拼接，落盘成 `agent:agent:pi-architect`；已改为直接使用
  房间的完整 actor id（`agent:pi-architect`），单测同步。
- Turn 生命周期最初写在逐格 `renderTurn` 里；当 4 个窗格全是 Agent 车道且回合不属于其中任何一个时，
  该 Turn 不会进入 `state.turns`，忙碌锁与活动栏会漏掉它。已拆出全局 `trackTurnEnvelope()`（§6.5.2），
  并用「无房间格 + 不在车道里的 Agent」实测（第 24 项）。

