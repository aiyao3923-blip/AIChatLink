# 计划书：大屏自适应显示 · 活动栏工作环 · 一键终止全部 Agent

状态：Proposed（待用户批准后实施）
日期：2026-11-19
影响面：`web/`（呈现层）与 `docs/`（视觉系统/决策/验收）；**不改**协议、存储、Adapter、unrestricted 合同与任何 native argv。

---

## 0. 一句话

用户换到大屏后暴露三件事：**界面按笔记本的物理尺寸写死**（1600px 以上不再增长）、**活动栏工作环在部分路径不转**、
**忙碌时的发送键只能看不能按**。本计划把「尺寸」变成一条可推导的尺度、把「在工作」变成不可丢的信号、
把「转圈」变成一次可执行的终止命令。

| # | 用户原话 | 可验收判据 |
| --- | --- | --- |
| S1 | 「对话框，右侧图标明显有点小了」 | 2560×1440 下根字号 ≥ 19px、活动栏格子 ≥ 36px、输入卡 ≥ 1248px，且 1280/1600 档**逐像素不变** |
| S2 | 「完成会话的时候右侧的 8 个小图标也不转动了」 | 任一未终态 Turn 存在时，8 个格子里对应 Agent 的 `data-working="true"` 且 `element.getAnimations()` 有运行中的 `spin`；含 reduced-motion 机器 |
| S3 | 「点击转圈后代表用户要终止此次任务，立刻终止所有 agent 的工作」 | 忙碌态发送键可点，一次点击对**全部**未终态 Turn 各发一条 `POST /api/turns/:id/cancel`，终态后自动解锁 |

---

## 1. 症状复述与边界

### 1.1 三条需求拆成六个疑问

1. **「适配屏幕尺寸」是放大内容，还是重排版？** → 两者都要，但顺序相反：先定尺度（物理观感），再让既有断点继续管重排版（几何关系）。
2. **「对话框」指输入卡还是消息列？** → 输入卡（`.composer`，`web/styles.css:1877`）。它的宽度有 `--column-max`，但**字号、内边距、按钮高、文本域自增高上限**都没随屏幕变。
3. **「右侧图标」是顶栏还是活动栏？** → 活动栏（`.composer-agents`，8 个 30px 圆，`web/styles.css:1903`）；顶栏 `.icon-action` 同为 30px，一并纳入尺度。
4. **「不转动」是需求变更还是缺陷？** → 现有设计**要求**它在工作时旋转（`docs/WEB_UI.md:113`、D-044 第 4 条），所以是缺陷。
5. **「终止」的粒度是整轮还是整房间？** → 用户原话是「所有 agent 的工作」，即**当前对话里全部未终态 Turn**（含 queued）。
6. **终止之后还能不能发？** → 沿用 D-044：现在视图里还有未终态 Turn 就锁发送。终止只把「等」变成「催」。

### 1.2 明确不在本次范围

- 不做全局字号/密度偏好面板（浏览器缩放与系统字号已经是那条逃生口，见 §6.1）；
- 不轮询 `/api/health.activeTurns`（D-044 第 2 条已否决：全局数会锁住别的目录/对话）；
- 不改多工作目录（`?ws=`）的其他 runtime —— 页面只能终止它自己那份 `state.turns`；
- 不加审批层、不加二次确认对话框（破坏性操作靠「明确的红色语义 + 可重试」而不是弹窗，理由见 §3 E5）。

---

## 2. 苏格拉底式提问（每问带分叉与本文取舍）

> 提问规则：只问**答案会改变实现**的问题；答案不影响代码的问题不写进计划。

**Q1. 为什么不能用 `zoom` 或一次性把 `html` 字号调大？**
- 若只调 `html` 字号：`rem` 的自适应（字号）会变，但 554 处 `px` 几何（头像 30、栏高 56、侧栏 296、列宽 1040）不变 → 字大到撑破 30px 头像。
- 若用 `zoom`：`position: fixed`（助理抽屉、浮标）、`dvh`、`100vw` 全部要重算，且 `vh` 与 zoom 组合在 Chrome/Firefox 上行为不一致。
- **取舍**：把 `px` 改成「设计像素」变量，让一个乘法同时驱动字与几何。

**Q2. 尺寸应该跟「视口宽度」还是「物理英寸」走？**
- Web 拿不到可靠的物理尺寸（`screen.width` 是 CSS px，DPR 只说明系统缩放）。
- 真实可用的代理量就是**视口 CSS 宽度**：27" 1440p @100% ≈ 2560 CSS px，15.6" 笔记本 ≈ 1920。
- **取舍**：以宽度为输入、以 1600px 为基准点做线性放大，1280–1600 完全不变（笔记本档零回归）。

**Q3. 放大上限是多少？会不会放大到「一屏只放得下三行」？**
- 若线性外推，3840px 会是 ×2.33 → 正文 35px，一屏 12 行，不可用。
- **取舍**：`clamp()` 上限 1.4（3840 时正文 22.4px），并在文档里写死「需要更大请用浏览器缩放」。

**Q4. 用户改了系统/浏览器字号，我们还该跟着放大吗？**
- 若我们用 `vw` 直接定字号，会踩 WCAG **F94**（只用视口单位，用户字号设置失效）。
- **取舍**：根字号写成 `clamp(1rem, calc(1rem + 斜率), 1.4rem)`——**基准是 `1rem`**（会跟系统字号走），视口只贡献增量。这也是 Chrome 现代 Web 指南的「fluid type 必须含 font-relative 分量」要求。

**Q5. 现有断点（1180/900/760/520）要不要跟着放大？**
- 若把断点也乘上尺度，等价于「同样的视觉密度」，但会破坏「窗口宽度」这个用户可理解的量。
- **取舍**：断点不动。数学上等价于「2560 屏 @1.2 尺度 = 2133 设计像素」，因此 2560 会看到 1180 档的收窄规则不触发——与真机 2133 宽一致，符合直觉。

**Q6. 工作环为什么会「不转」？先怀疑代码还是先怀疑环境？**
- 代码侧有一个**确凿的漏同步**（§5.2 证据 A）：Turn 账本只在「终态跃迁」时才调 `syncAgentActivity()`。
- 环境侧有一个**确凿的杀伤点**（§5.2 证据 B）：`prefers-reduced-motion: reduce` 下两条动画都被 `animation: none` 掐掉。
- 两者都能独立造成同一个症状，且症状在**换机器后出现**更像 B。
- **取舍**：两边都修（A 是逻辑漏洞，不修只是「碰巧不漏」；B 是设计取舍，改成慢速旋转而不是不动）。

**Q7. reduced-motion 用户到底要不要看到旋转？**
- 若彻底不动：用户失去唯一「还在跑」的视觉信号（MDN 明确说的是减少/替换，不是删除）。
- 若照旧 900ms：对大范围运动敏感的用户不友好。
- **取舍**：降到 2400ms（旋转位移不变但角速度降 62%），并在 `docs/WEB_UI.md` 登记这是**有意偏离**「reduce = 不动」，因为它是 13px 指示器而不是版面运动。同时保留非动画信号（`aria-busy`、`title`、完成点）。

**Q8. 忙碌键从「禁用」变成「可点」，会不会违反「不重复发送」的守卫？**
- 提交路径有两个入口：`form submit`（Enter/点击）与 `submitMessage()` 的内部守卫。
- 若把「点击 = 终止」写进 `submitMessage()`，那么**忙碌时按 Enter 也会取消全部**——这是灾难。
- **取舍**：只在 `sendButton` 的 `click` 上 `preventDefault()` 并触发终止；`submit` 仍走原守卫（忙碌时只提示文案）。`sendButton` 保持 `type="submit"`，因此 Enter 路径与今天完全一致。

**Q9. 「全部 Agent」的边界画在哪？**
- 若用 `/api/health.activeTurns` 或被隐藏窗格的 Turn 也算：会终止别的对话/目录（D-044 已否决）。
- 若只终止「当前发送目标」：用户说的是所有。
- **取舍**：`state.turns` 里**所有非终态、且未处于 `cancel_requested`** 的 Turn。它已经是 SSE/bootstrap/202 三路维护的单一事实源，跨目录与历史回放天然隔离（`conversationView !== null` 时不做停止键）。

**Q10. 终止失败要不要回滚 UI？**
- 现有 `cancelTurn()` 已经做了：乐观 `cancel_requested` → 失败时 `renderTurn(turn)` 回退 + 全局错误条。
- **取舍**：沿用；批量版把 N 条错误合并成一句「N 个取消失败：<code>」，不刷 N 个横幅。

**Q11. 终止后按钮该显示什么？**
- 若立刻恢复「发送」：Turn 还没终态，用户会以为可以再发（正是 D-044 要关的空窗）。
- 若一直转圈：用户不知道点击生效了。
- **取舍**：点击后进入 `stopping`，环继续转、文案变「正在终止 N 个 Agent…」，直到全部终态；若 8 秒内仍有未终态，文案降级为「已请求终止，等待 Agent 收尾」（不弹窗、不重试）。

**Q12. 需要新 API 吗？**
- 批量端点会引入一次「部分成功」的语义：Broker 的 `cancelTurn` 本身就是逐 Turn 幂等命令（`src/broker/broker.ts:888`），批量端点只是把循环搬进服务端，多一层失败聚合。
- **取舍**：不新增端点。客户端并行 `Promise.all` 逐 Turn 发既有 `POST /api/turns/:id/cancel`，每条带自己的 `clientCommandId`（`retryableCommandId('cancel:'+turnId)`），重试幂等、断线可恢复。

---

## 3. 专家会诊（七席，每人给判据而不是形容词）

| 席位 | 发现 | 对方案的要求 / 否决权 |
| --- | --- | --- |
| **E1 版式与阅读度量** | 阅读列 1040px + 正文 15px ≈ 69 个中文字/行；若只放大字号不放大列宽，行长降到 52 字（可以），但 30px 头像会与 19px 正文失衡。 | 字号与几何必须**同一乘数**，否则阅读节奏与密度会打架。**否决**「只调字体」。 |
| **E2 CSS 架构** | `tokens.css` 已经是唯一语义层（`--fs-*`/`--s-*`/`--r-*`），但 `styles.css` 里 554 处字面 `px` 分散在骨架与细节中。 | 只引入**一个**新原语 `--px`（1 个设计像素）；换算 `--s-*`/`--r-*` + 骨架几何；1px 发丝线与阴影不动。**否决**「全量 sed 替换」——会把 1px 边框变成 1.2px 的糊边。 |
| **E3 可访问性** | `styles.css:2555` 的 reduce 块把两个旋转指示器一并 `animation: none`；WCAG 2.3.3 针对的是「由交互触发的大面积运动」。 | 保留 reduce 语义但**降速不删除**；`aria-busy` 与 `title` 继续兜住语义；F94 要求字号含 rem 分量。 |
| **E4 浏览器兼容** | `clamp()`（Chrome 79+/Safari 13.1+）、`calc(N * var(--len))`、`color-mix`（已在本项目使用）均无新增门槛；`rem` 在根元素上按「初始值」解析，会跟随系统字号。 | 不用 `zoom`、不用 `@property`、不引入任何依赖。 |
| **E5 交互与破坏性操作** | 「转圈」当前是**状态**，点它是**命令**；两者共用一个控件必须靠形状以外的线索区分（颜色 + 文案 + hover）。 | `data-mode="stop"` 时按钮文字为「终止」，hover 走 `--danger` 语义，点击不弹确认框（D-044 已经否定审批层，且终止是**可恢复**动作：Turn 会进 `cancelled`，消息可重发）。**否决**「二次确认」。 |
| **E6 并发与协议** | `cancelTurn` 对 `queued` 用 `cancelQueuedTurn` CAS，对 `running` 走 `cancelling` + native cancel；同一 Turn 的并发取消由 `#cancelFlights` 合并。 | 客户端扇出必须**逐 Turn 去重**（跳过 `cancel_requested`），否则 8 条命令里有 5 条是无效重放。 |
| **E7 考古（决策与提交）** | D-044 第 3 条明写「发送键转圈并禁用」；`web/app.ts:1846` 的共享账本注释也说「否则忙碌锁与活动栏会漏掉」——**注释写了意图，代码只做了一半**。 | 必须新立决策条目（D-048/D-049）显式**取代** D-044 第 3 条的禁用语义，并在同一提交里改 `docs/WEB_UI.md:113`。 |

---

## 4. 横纵分析

### 4.1 横向：同类产品的两种路线

| 产品 / 规范 | 事实 | 对本项目的含义 |
| --- | --- | --- |
| ChatGPT / Claude 网页 | 消息列 ≈768px 固定，字号 16px 固定；大屏靠浏览器缩放 | 固定密度在 27" 上一定会「显小」；它们接受这个代价，因为用户会缩放 |
| Slack / Discord / VS Code | 全 px + 用户缩放/界面缩放设置 | 与 ChatGPT 同路线；VS Code 另有 `window.zoomLevel` |
| Linear / Vercel Geist | 语义 token 分阶，但仍是固定 px 密度 | token 化是**可缩放的前提**，本项目已有 |
| MDN `clamp()` / Chrome 现代 Web 指南 | fluid type 允许 `vw`，**但字号必须含 `rem`/`em` 分量**，否则违反 WCAG F94 | 决定根字号公式的形状（`1rem + 视口增量`） |
| MDN `prefers-reduced-motion` | 语义是「移除、减少或替换」运动，不是必须变为静止 | 允许「降速」这一档 |

**结论**：业界默认路线是「固定 + 缩放」，但本项目是**常驻在一台机器上、面向同一用户的多 CLI 房间**，用户不会为它单独记 Ctrl+`+`。
在「固定密度一定显小」与「全 fluid 会破坏断点直觉」之间，本项目选**中段**：1600px 以下完全固定，以上线性放大、封顶 1.4。

### 4.2 纵向：本项目自己的演化

| 时间 | 提交 / 决策 | 留下的约束 |
| --- | --- | --- |
| D-032 | 「纸与墨」视觉系统 | 一个强调色、7 级字阶、3 层表面；**新增样式先读禁止清单** |
| D-044 | 忙碌锁 + 活动栏 | 忙碌口径 = 当前视图未终态 Turn；活动栏「工作时外环旋转」。**本次要改的正是这里的第 3 条** |
| D-045（dock） | 宽度预算记在面板边距 | dock 宽 `min(1040, 100%-48)`，活动栏 30px 格子必须在同一坐标系里缩放 |
| 7ec36e0 | 多窗格 | Turn 账本变成「全局一次、各窗格各自投影」→ **活动栏同步必须挂在全局层**（§5.2 证据 A 的根因） |
| 1a54d28 | 名册 8 席 | 活动栏 4×2 网格，`gridTemplateColumns` 由 JS 写死 `30px` → 尺度改造必须同时改 JS |

纵向的教训：**这个项目的每个「不转/变形」缺陷，都是同一句注释的意图只实现了一半**。所以本计划把三条需求都写成「共享账本 + 单一尺度」的实现，而不是三处补丁。

---

## 5. 病灶判定（每条带证伪方法）

### S1 大屏显小 —— 判定：**设计范围缺口**（不是 bug）

证据：

1. `web/styles.css:9-15`：`--rail-w: 72px`、`--sidebar-w: 296px`、`--column-max: 1040px`、`--gutter: max(48px, …)` 全是绝对 px。
2. `web/tokens.css:69,80,92`：`--fs-15: 0.9375rem`、`--s-1: 4px`、`--r-lg: 16px` —— 字号是 `rem`（会跟根字号），间距/圆角是 `px`（不会）。
3. 全部 12 条 `@media`/`@container` 都是 `max-width` 断点（`styles.css` 内 2332/2338/2346/2852/2870/2887/3036/3843/3849/4162/4172/4186/4266/4656），**没有一条在 >1600px 时动作**。
4. `web/app.ts:843`：`autoresizeComposer()` 把文本域高度封在 `180px`（字面量），CSS 的 `max-height: 240px`（`styles.css:2467`）与之互相矛盾，且都不随屏幕变。

证伪方法：在 2560×1440 下读 `getComputedStyle(document.documentElement).fontSize` 与 `.composer-agent` 的 `width`；若已随屏幕变大，则本条不成立。**实测（无头 Chrome，1600 与 2560 两档）：根字号 16/16px、格子 30/30px —— 完全不随屏幕变化。**

### S2 工作环不转 —— 判定：**两个独立成因，都要修**

**证据 A（逻辑漏同步，确凿）**
- `web/app.ts:1846-1876` `trackTurnEnvelope()` 是「共享账本」，注释明写 *"so a Turn still enters `state.turns` when no pane happens to watch its Agent (otherwise the busy lock and the activity rail would miss it)"*；
- 但函数体只在 **`isFinishedTransition`（活 → 终态）** 分支里调 `syncAgentActivity()`（`:1871-1874`）；
- `web/app.ts:2347-2353` 的窗格投影用 `lensAccepts()` 过滤：**没有窗格接受这个 Turn 时，`renderTurn()` 不会跑**，而 `renderTurn()` 末尾的 `syncAgentActivity()`（`:1941`）是另一条同步路径。
- 结论：**「只有 Agent 车道窗格」或「目标 Agent 没有窗格」时，`state.turns` 更新了但活动栏不知道**。刷新/回放路径同样受影响（`state.turns` 不由 bootstrap 建立，`web/app.ts:836` 只读不写）。

**证据 B（reduce-motion 掐掉动画，确凿）**
- `web/styles.css:2555-2564`：
  ```css
  @media (prefers-reduced-motion: reduce) {
    .composer-agent[data-working="true"] .composer-agent-ring, .send-spinner { animation: none; }
    .composer-agent[data-working="true"] .composer-agent-ring { border-color: var(--tone, var(--accent)); }
  }
  ```
- Windows 11「设置 → 辅助功能 → 视觉效果 → 动画效果」关闭即让 Chromium 报 `prefers-reduced-motion: reduce`（来源见 §12 参考）。
- **实测（无头 Chrome + `emulateMedia({reducedMotion:'reduce'})`）**：同一份 `props` 下，`reduce` 关闭时 230ms 内两帧像素不同（动画可见），`reduce` 打开时两帧完全一致（静止）。

**证伪方法**：在真实实例上发一条 `@all`，用 DevTools 读 8 个格子的 `data-working` 与 `getAnimations().length`。
- 若 8 个都 `data-working=true` 但无动画 → B 成立、A 不成立；
- 若部分格子 `data-working=false` → A 成立。
本次无法在无 Agent 的环境里跑真实回合，因此**两边都修**，并额外增加一条自检（§7 T-3）。

### S3 转圈不可点 —— 判定：**需求变更**（旧决策被用户新要求取代）

证据：`web/app.ts:4704-4722` `syncSendButton()` 在 `busy` 时 `sendButton.disabled = true`；D-044 第 3 条把「禁用」写成了决策。
用户新要求：点击转圈 = 终止全部 Agent。→ 新决策取代旧决策的第 3 条，其余（口径、完成点、单一事实源）不变。

---

## 6. 方案设计

### 6.1 S1：一个设计像素 `--px` + 根字号斜坡

```css
/* tokens.css */
:root {
  /* 1 设计像素：16px 根字号时恰好 1px。整壳几何写成 calc(N * var(--px))，
     于是「字」与「几何」共用同一乘数。 */
  --px: 0.0625rem;
}
html {
  /* 1600 以下完全不变；之上线性放大；1.4rem 封顶（3840 ≈ ×1.4）。
     基准 1rem 保证系统/浏览器字号设置仍然生效（WCAG F94）。 */
  font-size: clamp(1rem, calc(1rem + (100vw - 1600px) / 300), 1.4rem);
}
```

换算表（节选，全部落在 `tokens.css` / `styles.css` / `setup.css`）：

| 位置 | 现值 | 新值 |
| --- | --- | --- |
| `--s-1..--s-7` | 4/8/12/16/24/32/48px | `calc(N * var(--px))` |
| `--r-xs/sm/md/lg/avatar` | 6/8/12/16/10px | `calc(N * var(--px))`（`--r-pill` 不动） |
| 顶栏行高 / `--rail-w` / `--sidebar-w` | 56 / 72 / 296、300 | `calc(N * var(--px))` |
| `--column-max` / `--drawer-w` / `--gutter` | 1040 / 380 / 48+1040 | 同上（含 `min()` 内层） |
| `.composer-agent` 格子、环 `inset`、行距 | 30 / 3 / 5 | 同上 |
| `.icon-action` / `.agent-avatar` / `.floating-action` | 30 / 36 / 34 | 同上（含其中 16/13/12px 的 SVG） |
| `.send-button` 高、`.send-icon/.send-spinner` | 30 / 13 | 同上 |
| `.composer textarea` 高、`max-height` | 48 / 240 | 同上 |
| 日志/空态/对话框宽度 | 560 / 620 / 720 / 760 | `min(calc(N * var(--px)), calc(100vw - 32px))` |
| **不动** | `1px` 发丝线、`--shadow-*`、`@media` 断点、`--r-pill` | — |

JS 侧：`web/app.ts` 新增 `designPx(n) = n * (parseFloat(getComputedStyle(document.documentElement).fontSize) / 16)`，
用于 `autoresizeComposer()` 的 180px 上限（改为 `designPx(180)`）与 `syncJumpLatestGeometry()` 的 12px 边距。
`renderComposerAgents()` 不再写 `repeat(k, 30px)`，改为写 CSS 变量 `--rail-cols`，列宽由 CSS 的 `var(--rail-cell)` 决定。

**为什么不给用户一个「字号」开关**：浏览器缩放与系统字号已经覆盖，且 `docs/WEB_UI.md` 第七节禁止无决策的常驻控件；
新增一个开关等于给「自动适配」加一个失败的借口。文档里写明逃生口即可。

### 6.2 S2：把「在工作」挂到共享账本，并把旋转做成保底

1. **同步位置**：`syncAgentActivity()` 从 `renderTurn()` 的末尾移到 `trackTurnEnvelope()` 的末尾（无条件），
   `renderTurn()` 里的调用保留成幂等（DOM 写入成本低），这样「窗格没接住这个 Turn」不再影响活动栏。
2. **bootstrrap/replay 也要过账本**：确认 replay 路径经 `dispatchEnvelope(live=false)` 进入 `trackTurnEnvelope`（已成立，`:2324`），
   同步因此发生在回放时，且完成点点灯仍只走 `live`（`isFinishedTransition` 不动）。
3. **动画保底**：reduce 块改为「降速 + 静态环兜底」：
   ```css
   @media (prefers-reduced-motion: reduce) {
     .composer-agent[data-working="true"] .composer-agent-ring,
     .send-spinner { animation-duration: 2400ms; } /* 不是 none */
   }
   ```
   并在 `docs/WEB_UI.md` 写明这是对「reduce = 静止」的有意偏离与理由（13px 指示器 + 语义另有 `aria-busy`/`title`/完成点）。
4. **自检（可观测性）**：`syncAgentActivity()` 结束时若 `working.size > 0 && composerAgents` 有工作环却
   `!composerAgents.querySelector('[data-working="true"]')`，写一条 `console.warn`（开发期定位用，不持久化、不进 UI）。
   > 该分支在正确实现下不可达；它是防止同一缺陷以第三种形态复发的看门狗。

### 6.3 S3：忙碌键 = 终止键

**状态机（纯函数，可单测）** — 新文件 `web/composer-state.ts`：

```ts
export type SendButtonMode = "send" | "stop" | "blocked";
export interface ComposerInput { submitting: boolean; working: number; draft: string; stopping: boolean; }
export interface ComposerButton { mode; disabled; ariaBusy; label; title; }
export function sendButtonState(input: ComposerInput): ComposerButton;
```
规则：
- `submitting`（POST 在飞）→ `blocked`，`aria-busy=true`，title「正在提交…」；
- `working > 0` → `stop`，**enabled**，`aria-busy=false`（它现在可操作），label「终止」，title「终止全部 N 个 Agent 的工作」；
- `stopping` 时 title「正在终止…」，仍可再点（幂等，只会补发未发出的 Turn）；
- 否则 → 草稿空为 `blocked`，非空为 `send`。

**取消集合（纯函数）** — `web/agent-activity.ts` 新增：

```ts
export function cancellableTurnIds(turns: Iterable<TurnActivityLike & { turnId: string }>): string[];
```
排除：终态、`cancel_requested`、空 id；同 Turn 去重、保持首次出现顺序（与 `activeTurnActorIds` 同风格）。

**执行** — `web/app.ts`：
- `cancelTurn(turnId)` 拆成 `requestTurnCancel(turnId): Promise<{ok:true}|{ok:false; message:string}>`（无横幅副作用）
  + `cancelTurn()`（单张卡片的「取消」按钮用，失败时 `showGlobalError`）；
- `stopAllAgentWork()`：取 `cancellableTurnIds(state.turns.values())`，`Promise.all` 发 `requestTurnCancel`，
  汇总失败为一句 `setComposerStatus(...)`，成功则「已请求终止 N 个 Agent…」，全部终态后自动清空（沿用 `syncSendButton` 的清空逻辑）；
- `sendButton.addEventListener("click", …)`：`mode === "stop"` 时 `preventDefault()` + `void stopAllAgentWork()`；
  `form submit` 与 Enter 路径**不变**（仍是 `submitMessage()` 的忙碌守卫）。

**呈现** — `web/styles.css`：`.send-button[data-mode="stop"]` 用 `--danger` 语义（hover 底色 `--danger-wash`、文字 `--danger`），
保留旋转环与「终止」二字；手臂长度（宽度）与「发送」一致，避免布局跳动。`aria-label` 随 mode 改写。

**为什么不做「终止后自动补发」**：违反不变量 14（prompt 一旦可能进入 native session 就不得自动重放）。

### 6.4 被否方案

| 方案 | 否决理由 |
| --- | --- |
| `body { zoom: 1.2 }` | 与 `position: fixed`、`dvh`、`vw` 的交互不可预测；文字栅格化质量下降 |
| 全量 `sed s/px/calc(N*var(--px))/` | 554 处含 1px 发丝线与阴影，会把清晰边框变成 1.2px 糊边 |
| 把断点乘尺度 | 用户对「窗口多宽」的心智模型被打乱；2560 屏会出现笔记本上看不到的折叠 |
| 只用 `vw` 定字号 | 违反 WCAG F94：系统字号设置失效 |
| 新增 `POST /api/turns/cancel-all` | 多一层「部分成功」语义；Broker 的逐 Turn 幂等命令已足够 |
| 忙碌时禁用 + 单独放一个「停止」按钮 | 用户明确要求「点击转圈」；两个并列控件会让右端更挤 |
| 终止前弹确认框 | 终止可恢复（Turn 记 `cancelled`，消息可重发）；弹窗与 D-044「不是审批层」冲突 |
| 在 `submitMessage()` 里做终止 | 忙碌时按 Enter 会误终止全部 |
| 用 `activeTurns` 全局计数判断忙碌 | D-044 第 2 条已否决：会锁别的目录/对话 |

---

## 7. 落地清单（文件级，按提交分组）

### 提交 1 — `feat(web): 显示尺度随屏幕等比放大`

| 文件 | 改动 |
| --- | --- |
| `web/tokens.css` | 新增 `--px`、`html{font-size:clamp(...)}`；`--s-*`/`--r-*` 改 `calc(N*var(--px))` |
| `web/styles.css` | 骨架/控件几何换算（§6.1 表）；`.composer-agents` 用 `--rail-cols`/`--rail-cell`；reduce 块修正留给提交 2 |
| `web/setup.css` | 顶栏 56、轨道 288、对话框 680/620 换算（与房间同尺度） |
| `web/app.ts` | `designPx()`；`autoresizeComposer()` 上限、`syncJumpLatestGeometry()` 边距；`renderComposerAgents()` 写 `--rail-cols` |
| `docs/WEB_UI.md` | 新增「§九 显示尺度」表：`--px`、根字号公式、换算边界（1px 不动）、逃生口（浏览器缩放）；§四度量表标注哪些量是尺度、哪些是断点 |

### 提交 2 — `fix(web): 活动栏工作环在任何 Turn 路径都同步并保底动画`

| 文件 | 改动 |
| --- | --- |
| `web/app.ts` | `syncAgentActivity()` 挂到 `trackTurnEnvelope()`；看门狗 `console.warn` |
| `web/styles.css` | reduce 块 `animation: none` → `animation-duration: 2400ms`（两处） |
| `docs/WEB_UI.md` | §四「忙碌态/Agent 活动栏」写明同步位置与 reduce 降速；§七禁止清单加一条「动画不得在 reduce 下被整体删除」 |
| `docs/DECISIONS.md` | D-048：工作环同步与 reduce 降速 |

### 提交 3 — `feat(web): 忙碌发送键改为终止全部 Agent`

| 文件 | 改动 |
| --- | --- |
| `web/composer-state.ts`（新） | `sendButtonState()` 纯函数；**必须登记** `src/web/server/server.ts` 的 `STATIC_ASSETS` |
| `web/agent-activity.ts` | `cancellableTurnIds()` |
| `web/app.ts` | `requestTurnCancel()` / `stopAllAgentWork()` / click 分支 / `syncSendButton()` 改写 |
| `web/index.html` | 发送键加 `aria-label`、去 `disabled` 初值不变；无需新节点 |
| `web/styles.css` | `.send-button[data-mode="stop"]` |
| `docs/WEB_UI.md` | §113 忙碌态改写；§202 验收第 6 条改写 |
| `docs/DECISIONS.md` | D-049：忙碌键=终止键（明确取代 D-044 第 3 条的「禁用」） |
| `docs/ACCEPTANCE_TESTS.md` | 新增 `U-0xx`/`W-0xx` 行：终止扇出、Enter 不误终止、终态解锁 |
| `tests/unit/web/composer-state.test.ts`（新） | 4 个 mode 分支 + stopping + 未知状态 fail-safe |
| `tests/unit/web/agent-activity.test.ts` | `cancellableTurnIds()` 排除终态/`cancel_requested`/空 id、顺序稳定 |

---

## 8. 验收判据

| ID | 判据 | 方式 |
| --- | --- | --- |
| A-1 | `npm run typecheck` 通过 | 命令 |
| A-2 | `npm test` 全通过（含新增 ≥8 条断言） | 命令 |
| A-3 | 1280×800 与 1600×1000 两档**根字号 16px、格子 30px、列宽 1040** 与改动前一致 | Playwright 读计算样式 |
| A-4 | 2560×1440 根字号 ≥19px、格子 ≥36px、无横向滚动（`scrollWidth<=clientWidth`） | 同上 |
| A-5 | 430×900 移动档：根字号 16px、单列、无横向滚动 | 同上 |
| A-6 | 明/暗两套正文对比度仍 ≥4.5:1（`--px` 不改颜色，抽查 `.event-content` 与 `--muted`） | 计算 |
| A-7 | 忙碌态 8 格 `data-working=true` 且每个 `getAnimations()` 含 `spin` running；`emulateMedia(reducedMotion:'reduce')` 下仍 running（`animation-duration: 2400ms`） | Playwright + stub 事件 |
| A-8 | 忙碌态发送键 `data-mode="stop"`、`disabled=false`、`aria-label` 含「终止」 | Playwright |
| A-9 | 点击后 `fetch` 收到 N 条 `POST /api/turns/<id>/cancel`（N = 未终态 Turn 数），每条 `clientCommandId` 不同；重复点击不增加已 `cancel_requested` 的 Turn 的命令数 | Playwright + 请求拦截 |
| A-10 | 忙碌时按 Enter **不**触发任何 cancel 请求 | Playwright |
| A-11 | 全部 Turn 终态后按钮回到「发送」/`blocked`，状态槽清空 | Playwright |
| A-12 | `/setup` 页面同尺度（顶栏 56→随尺度）且不横向滚动 | Playwright |

A-3…A-12 用**无头 Chrome + `_tmp/` 探针**（`web/` 静态服务 + `/api/*`、`/api/events` 桩），脚本不入库（`_tmp/` 已 gitignore），
结果写进提交正文作为 `probed` 证据。

---

## 9. 双向钢人论证

### 9.1 正向钢人：假设本计划完全正确、并被执行到位，用户会得到什么

1. 2560/3840 上界面按比例长大，阅读列、输入卡、8 个活动格、顶栏图标、对话框宽度全部同乘数 → 「显小」这一条从感知上消失；
2. 1280/1600 档**逐像素不变**，笔记本用户的观感与今天完全一致（不是「所有人一起变大」的粗暴修复）；
3. 系统字号/浏览器缩放依然生效（根字号含 `rem`），不会把可访问性改善锁死；
4. 工作环在**任何** Turn 路径（单窗格、纯 Agent 车道、刷新回放、多窗格混排）都由共享账本驱动 → 不再依赖「碰巧有窗格接住」；
5. 关闭 Windows 动画效果的用户也能看到在跑（降速而非静止），并有三重冗余语义（`aria-busy`、`title`、完成点）；
6. 忙碌时一键终止全部并行的 8 个 Agent，逐 Turn 幂等、可重试、失败可见，终态后自动解锁；
7. 协议层零改动：没有新端点、没有新配置项、没有新审批层，D-044 的单一事实源与不变量 14 全部保持。

### 9.2 反向钢人：假设本计划在某个关键处错了，最可能是哪几处、代价是什么

| 假设被推翻的可能 | 若成立会怎样 | 本计划的对冲 |
| --- | --- | --- |
| 用户所谓「显小」其实是**期望更大的字号**而不是等比放大（即想要 `+30%` 文字、几何不变） | 等比放大后仍觉得字小（2560 只到 19.2px） | 文档写明逃生口（Ctrl+`+`）；D-049 的变更条件里给出「若实测仍偏小，把斜率分母 300 调到 220（2560 → 20.7px）」 |
| `clamp()` 的 `1rem` 在某些浏览器/系统字号下解析成 16px 硬值 | 系统字号设置失效（可访问性回退） | 探针 A-4 同时读 `font-size` 与 `documentElement.style`；若发现 `1rem` 不跟随，改为 `font-size: calc(100% + …)` 形式（同样含 font-relative 分量） |
| 工作环不转的真因是**第三个**未知（例如用户跑的是陈旧 `dist/`） | 修了 A/B 仍然不转 | 探针 A-7 用同一份 `web/` 源驱动；交付说明里给出「`npm run build` 后才能看到」的提示 |
| 用户其实想要「点转圈 = 只终止我这次刚发的那一轮」 | 一键终止会误杀同房间其他在跑的 Turn | 卡片级「取消」按钮保留；D-049 写清语义边界与变更条件（改为按 `correlationId` 过滤） |
| `Promise.all` 的 8 条 cancel 让 Broker 的 lane 出现竞态 | 个别 Turn 停在 `cancelling` | `#cancelFlights` 已合并同 Turn 并发；探针 A-9 断言「重复点击不新增命令」；终态仍由 SSE 驱动，不做本地乐观终态 |
| 完成后才点转圈（竞态：Turn 刚终态但 UI 未刷新） | 点了没反应 | `stopAllAgentWork()` 在 `cancellableTurnIds` 为空时给「本轮已结束」文案而不是静默 |

### 9.3 钢人结论

计划在「**不破坏既有断点与既有决策口径**」这一点上站得住：三条需求各自都收敛到「单一尺度 / 单一账本 / 单一命令」，
没有引入第二份状态、第二个端点、第二套密度。最薄弱处是**S1 的主观感受阈值**（19.2px 够不够），
因此把「斜率分母」写进变更条件，使它是一次可调的参数而不是又一次重做。

---

## 10. 反向拆解（从验收判据倒推最小改动集）

从 §8 的 A-1…A-12 逐条倒推「必须改什么」，用来发现计划里的**缺口**：

| 判据 | 需要的最小改动 | 拆解时发现的缺口（已补进 §7） |
| --- | --- | --- |
| A-3/A-4 | `--px` + 根字号 clamp + 骨架换算 | **缺**：`renderComposerAgents()` 里 `repeat(k, 30px)` 是 JS 字面量，不改则格子永远是 30px → 已改为 `--rail-cols` |
| A-4 | 无横向滚动 | **缺**：`--gutter` 的 `max(48px, …)` 与 `--column` 的 `96px` 是嵌套在 `min()/calc()` 里的 px，容易漏 → 已列入换算表 |
| A-4 | 对话框不被裁切 | **缺**：`autoresizeComposer()` 的 180px 上限在 JS 里 → 需要 `designPx()` |
| A-7 | reduce 下仍在转 | **缺**：计划最初只改 CSS 一处，实际有**两个**选择器（工作环 + `.send-spinner`）→ 两处都改 |
| A-7 | 8 格全部 `data-working` | **缺**：只改 `trackTurnEnvelope()` 不够，`renderTurn(seedOnly)` 早退分支也不同步（`:1889-1894` 仅在新 Turn 时同步）→ 在账本末尾统一同步即可覆盖 |
| A-8/A-9 | 停止键可点 + 扇出 | **缺**：`sendButton` 是 `type="submit"`，不加 `preventDefault()` 会同时提交表单 → 已写进 §6.3 |
| A-9 | `clientCommandId` 唯一 | **缺**：`cancelTurn()` 复用了 `retryableCommandId('cancel:'+turnId)`（同一 Turn 复用同一 id）→ 批量路径必须**逐 Turn**建 key，不能共用一个 |
| A-10 | Enter 不误终止 | **缺**：若把终止写进 `submitMessage()`，Enter 会连坐 → 已写进 §6.3 |
| A-11 | 终态后解锁 | **缺**：`syncSendButton()` 里「清空 BUSY_SEND_STATUS」的逻辑要覆盖新的「正在终止…」文案，否则状态槽会留一句死文案 |
| A-12 | setup 同尺度 | **缺**：`setup.css:20,107` 的 56/288 与 `min(680px, …)` 对话框 |
| 文档 | 不变量与决策同步 | **缺**：`docs/WEB_UI.md:113,202`、`docs/DECISIONS.md` D-044 第 3 条必须显式被取代，否则下一个人会照着旧决策把它改回禁用 |
| 静态资源 | 新模块可用 | **缺**：`web/composer-state.ts` 必须在 `src/web/server/server.ts` 的 `STATIC_ASSETS` 登记（`tests/unit/web/static-assets.test.ts` 会兜住） |

**拆解结论**：计划的骨架（三条主线）没有变，但缺口集中在 **JS 里的字面 px / 双重选择器 / 表单提交副作用 / 静态资源登记 / 旧决策未退役**五类。
这五类已全部并入 §7 的落地清单，因此本计划可以进入实施。

---

## 11. 风险与回滚

| 风险 | 触发信号 | 回滚 |
| --- | --- | --- |
| 尺度改动导致某档出现横向滚动 | A-4/A-5 失败 | `--px` 定义改回 `1px`（一行），所有 `calc(N*var(--px))` 自动退化为原值 |
| `1rem` 基准在某些环境不跟随系统字号 | A-4 探针读到 ≠ 系统设置 | 根字号改 `calc(100% + (100vw - 1600px)/300)` |
| 工作环仍有第三种不转的路径 | 看门狗 `console.warn` 出现 | 说明 `state.turns` 之外的 Turn 来源未接入；按 D-048 变更条件补同步点 |
| 终止误杀 | 用户报告「只发了一个却全停」 | `cancellableTurnIds()` 加过滤器（按 `correlationId`）；逻辑集中在纯函数里，一处改 |
| 停止键与「发送」在窄屏混淆 | 520px 档只显示图标 | 停止态始终保留旋转环 + `aria-label`；520px 下图标形状不同（环 vs 纸飞机） |

---

## 12. 参考（本次判断的外部依据）

- W3C WAI，*Understanding SC 1.4.4 Resize Text* 与 *F94: Failure … due to incorrect use of viewport units to resize text* —— 只按 `vw` 定字号会让用户字号设置失效。
- Chrome *Modern Web Guidance: respect OS text scale* —— fluid type 允许 `vw`，但必须含 `rem`/`em` 分量。
- MDN，*`prefers-reduced-motion`* —— 语义是「移除、减少或替换」，不是必须静止。
- Windows 11「设置 → 辅助功能 → 视觉效果 → 动画效果」是 Chromium 上 `prefers-reduced-motion` 的系统开关来源之一。

---

## 13. 批准与实施顺序

1. 用户批准本计划（或指出 §6.1 斜率、§6.3 边界需要调整）；
2. 提交 1 → 校验 → 提交；提交 2 → 校验 → 提交；提交 3 → 校验 → 提交（严格按 `AGENTS.md` 的归档纪律，一个已验证改动一个提交）；
3. 每个提交正文写入实际执行的命令与 `probed` 证据；不允许把未验证的改动写成 `verified`；
4. 全部完成后按 §8 逐条复查，输出闭环结论。
