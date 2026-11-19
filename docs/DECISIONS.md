# AIChatLink 架构决策记录

状态说明：

- `Accepted`：实现必须遵守；变更需更新本文件和相关合同。
- `Provisional`：方向已定，但具体机制依赖 M0 证据。
- `Deferred`：明确推迟，不得在首版偷偷引入。

## 决策索引

| ID | 决策 | 状态 |
| --- | --- | --- |
| D-001 | 单机透明 Broker，而不是三个 CLI 物理 P2P | Accepted |
| D-002 | Web 使用 REST command + SSE event | Accepted |
| D-003 | Structured 是唯一 active/release transport；Direct deprecated，禁止自动 fallback | Accepted |
| D-004 | 内部 AIChatLink Envelope；A2A 作为以后边缘适配 | Accepted |
| D-005 | SQLite/WAL 是权威事实源，JSONL 仅导出 | Accepted |
| D-006 | Broker 根据通道绑定生成 sender identity | Accepted |
| D-007 | access 固定 unrestricted，只用原生进程/会话最大放开配置 | Accepted |
| D-008 | transcript、公共记忆、摘要、身份记忆分离 | Accepted |
| D-009 | 每 Agent lane 单飞，不同 Agent 并行 | Accepted |
| D-010 | AIChatLink MCP 提供异步 send 与同步 ask/read | Accepted |
| D-011 | 因果循环与资源限制属于可靠性，不属于权限 | Accepted |
| D-012 | Node/TypeScript 单进程、原生 Web UI | Accepted |
| D-013 | SQLite Node 驱动在 M0 后固定 | Provisional |
| D-014 | 完整 A2A Server、多房间、多用户 | Deferred |
| D-015 | AIChatLink 不构成安全边界，也不实现审批子系统 | Accepted |
| D-016 | 所选 transport 派发不确定时绝不自动重放或切换 | Accepted |
| D-017 | 配置驱动的 Agent 名册(driver/name/自定义 id)与 npm CLI 分发 | Accepted |
| D-018 | 推理记录可回放但不进入上下文 | Accepted |
| D-019 | 工具进度可回放但不进入上下文 | Accepted |
| D-020 | `aichatlink start` 复用同配置的现有 runtime | Accepted |
| D-021 | Agent 记忆拆分为显式核心记忆与自动日期记忆 | Accepted |
| D-022 | Hermes 作为独立 ACP driver 接入 Structured transport | Accepted |
| D-023 | Agent 日期记忆由逐 Turn 原文改为可恢复的每日批量 rollup | Accepted |
| D-024 | Claude Code 作为独立 stream-json driver 接入 Structured transport | Accepted |
| D-025 | ask 超时不加回送机制，harness 只以有界文本指导模型闭环 | Accepted |
| D-026 | 放宽消息 wire 上限（131,072）、运行超时与互调链路默认值 | Accepted |
| D-027 | 同步监督是房间协作配对，不是治理或审批层 | Accepted |
| D-028 | 房间助理是 user:assistant 操作员客户端，不是名册 worker | Accepted |
| D-029 | 无 schema 的协作闭环：publish、pending/collect、队列可见性与默认 reply chain | Accepted |
| D-030 | 协作工具保持拓扑中立，由 Agent 自主组织讨论与收敛 | Accepted |
| D-031 | `aichatlink stop` / `aichatlink restart` 以配置路径作用域优雅控制 runtime | Accepted |
| D-032 | Web UI 采用「纸与墨」视觉系统，tone 只用于身份而非装饰 | Accepted |

## D-001：透明 Broker

决定：所有 UI/CLI 消息通过一个本地 Broker。

原因：

- 多套 CLI 没有统一 peer server；
- 连接数保持 O(N)；
- 公共记忆和 sender provenance 只有一个事实源；
- 新增 Adapter 不需要修改现有 CLI；
- 本地转发开销相对模型耗时很小且可以测量。

变更条件：出现跨机器、高频二进制数据或 Broker 可靠性需求，允许大 payload 走直连/引用，但 Broker 仍保留控制面和事实账本。

## D-002：REST + SSE

决定：浏览器用 REST 提交命令，用 SSE 接收 durable/transient events。

原因：

- 命令与事件方向清晰；
- 浏览器原生重连和 `Last-Event-ID`；
- 比自定义 WebSocket command protocol 更少状态；
- cancel、memory 与 identity 写入天然适合 REST。

变更条件：需要浏览器端双向二进制或极高频交互时再增加 WebSocket，不替换现有 Envelope。

## D-003：Structured active，Direct deprecated

决定：v0.1 的存储/历史合同仍识别两个 transport 值，但公开运行入口只接受 Structured：

```yaml
transport: direct | structured
```

默认值为 `structured`，同一次 Broker 运行对全部已配置 Agent 使用同一选择：

- `structured`：Codex 使用 App Server，Grok/Kimi/Hermes 使用 ACP，维持长驻 session，支持原生事件、语义化取消、resume/load 和 AIChatLink MCP；
- `direct`：deprecated compatibility vocabulary。既有 one-shot/resume 源码和历史数据库记录保持可读；配置解析、Adapter factory 与 runtime constructor 均 fail-closed，不启动 Direct；不再新增能力、不维护 live Gate、不参与 release，也不作为 Structured 失败后的 fallback；
- 两者共用同一个 Broker、Envelope、sender provenance、Turn、记忆和 SSE 合同；
- 选择是显式的。任何启动、握手、执行或能力失败都在所选 transport 内收敛，不自动切换到另一 transport。

原因：产品目标已经收敛到 Codex App Server + ACP driver。保留 Direct enum/实现可避免破坏旧数据和已有调用方，但继续把它当 active 产品会重复维护 argv、wire、Gate 和能力说明。

M0 只维护 Structured active release baseline。Direct baseline、Agent 与适用 case 固定为 `DEPRECATED`；已有 Direct live/fixture evidence 仅作历史事实，`canSatisfyCurrentGate=false`。

## D-004：A2A 边缘化

决定：AIChatLink 内部不采用完整 A2A Task 模型。内部 Envelope 保留可映射字段，M3 以 Adapter 暴露/接入 A2A。

原因：本机配置名册不需要 discovery、远程认证和完整 Task/Artifact 生命周期；TendrilFlow 的当前 A2A 实现也采用外部适配到内部房间的边界。

## D-005：SQLite/WAL

决定：单 SQLite/WAL 数据库是唯一权威来源；Broker 唯一写入。JSONL 是导出，不是并发协调层。

原因：消息与多目标 Turn 需要事务；重启恢复、幂等、分页、状态查询和记忆索引都不应重新手工实现文件数据库。

## D-006：通道绑定身份

决定：`from` 由 Broker 根据 Adapter 进程/会话 binding 填写；API/工具不接受调用者设置 sender。

行为：正常 Adapter/会话通道内，Broker 从 binding registry 取得 actor，正文和工具参数没有设置 sender 的字段。

边界：binding 是来源关联和 correlation handle，不是 secret、认证或能力令牌。AIChatLink 不承诺抵御本机进程仿造 binding 或修改数据库。

## D-007：固定 native unrestricted

决定：v0.1 的 `access` 只有一个值 `unrestricted`，不进入公开配置，也不提供安全档位。AIChatLink 在进程、thread 或 session 范围固定应用各 CLI 的原生最大放开方式：

| Agent | Direct（deprecated reference，不可启动） | Structured |
| --- | --- | --- |
| Codex | 新会话：`codex --yolo --dangerously-bypass-hook-trust exec --json -`；续会话：同一前缀后 `exec resume --json <sessionId> -` | `codex --dangerously-bypass-hook-trust app-server --listen stdio://`；`thread/start`/`thread/resume` 使用 `approvalPolicy: "never"` 与 `sandbox: "danger-full-access"` |
| Grok | `grok --no-auto-update --permission-mode bypassPermissions --sandbox off --no-plan [--resume <sessionId>] --output-format streaming-json --single <prompt>`（`-p` 是短别名） | 同一全局前缀后追加 `agent stdio` |
| Kimi | deprecated Direct 参考实现保留只读配置预检后使用 `kimi [--session <id>] --prompt <prompt> --output-format stream-json` | 直接启动 `kimi acp`；不要求全局默认模式。每次 `session/new` 或 `session/load`（含 Adapter resume）后、首个 prompt 前调用 `session/set_mode`，`modeId="auto"`；mode 不持久化 |
| Hermes | 不提供 Direct 产品入口 | `hermes --yolo acp`；每次 `session/new` 或 `session/load` 后、首个 prompt 前调用 `session/set_mode`，`modeId="dont_ask"` |

Codex 0.147 的 thread-level `sandbox` 是 kebab-case 字符串 `danger-full-access`；camel-case `dangerFullAccess` 只出现在 `turn/start.sandboxPolicy.type` 这类不同 wire shape，不能写进 thread params。Codex child 的 OS cwd 使用 Agent 配置值，thread params 不重复发送 cwd，避免触发不必要的原生 trust 持久化。

AIChatLink 仍不写 Codex/Grok/Kimi/Hermes 的全局配置，不允许用户透传任意额外权限 argv，也不再实现第二套 AIChatLink 审批或沙箱判断。Active Structured Kimi 的 session mode 是 AIChatLink 唯一依据：官方默认 `manual` 不阻止 ACP 启动，随后必须以原生 `session/set_mode(auto)` 覆盖当前 session。Hermes 同时使用进程级 `--yolo` 与 session 级 `dont_ask`，但不追加会持久化用户选择的 hook allowlist 参数。明确 native policy 拒绝才失败；不会先要求用户修改全局配置。

Direct/Kimi one-shot 的旧 preflight 规则只保留作历史实现说明，不再构成产品能力。Active Structured Kimi 不执行 global-config preflight，但必须在每次 new/load 后重设 session auto mode。

“unrestricted”只在当前 Windows 用户已有权限内成立，不能绕过 UAC、文件 ACL、企业 requirements、服务端限制或 Kimi static deny。若原生结果明确表明外部策略阻止该模式，Turn 以 `NATIVE_POLICY_BLOCKED` 失败，Agent 状态显示 `native_policy_blocked`；AIChatLink 不修改、探测规避或绕过该策略。

## D-008：记忆分层

决定：

- transcript 是完整事件事实；
- public memory 是显式固定记录；
- summary 是可失效派生物；
- identity memory 是 AIChatLink 群内身份叠加；
- CLI 原生身份、instructions、配置和私有记忆不由 AIChatLink 覆盖。

纠错使用 supersede/tombstone，不原地抹除来源。

Room Context Engine 使用累计 checkpoint summary + 近期真实消息，默认 `256,000` 字符硬上限、约 `75%` 的压缩软目标。预算不是 token window；不同 CLI/模型窗口无需伪装成相同。触发压缩时按房间配置顺序使用第一个健康 Agent，不可用或输出无效时再尝试下一个。摘要持久化、attempt `summary_through_seq` 与 delivery cursor 的推进顺序必须保证：失败只会让当前 Turn 明确失败，绝不会以裁剪历史换取继续运行。

单房间 UI 可显示 checkpoint + 未压缩消息的字符估算并显式请求压缩。该命令仍由 Broker 接收、以 `clientCommandId` 单飞，复用自动压缩的摘要 CAS，保留最近 12 条消息；它不是清空会话或删除 transcript，也不把字符估算称为 token 数。

## D-009：并发

决定：每个 Structured Agent lane FIFO 单飞；不同 Agent 并行。`@all` 不串行等待。

原因：同一会话的上下文顺序比理论并发更重要；跨 Agent 并行保留效率和故障隔离。

## D-010：AIChatLink MCP 的 send、ask、read

决定：AIChatLink MCP 是 M2 的 Structured Agent 主动互调合同。Deprecated Direct 不存在可替代入口：

- `send` 持久化后异步返回；
- `ask` 等待目标 terminal response 并作为 MCP 工具结果返回；
- `read` 查询异步 correlation；
- 所有问答同时写入公共房间。

没有 ask 时，发送 Agent 在当前回合无法可靠看到目标回答；只看公共 UI 不等于回答进入发送方上下文。

Web/UI 的显式 recipients 可发起普通群聊；普通模型文本中的 `@某人` 不自动派发。若某个 Structured Adapter 无法附加 AIChatLink MCP 或无法完成真实工具调用，普通能力结论只能标为 `not_observed` 或 `unsupported`；只有独立 preflight/startup/session/mode 拒绝已经确立外部强制策略时，Agent 才能已处于 `native_policy_blocked`。对应 M2 验收不能标记完成；不得解析自然语言或恢复 Direct 冒充工具调用。

## D-011：因果循环与资源限制

决定：所有 child Turn 都必须严格验证 parent/root/hop 和父链完整性。只有进入 `waitsForChildren` 的同步 `mcp.ask` 不能把 active causal stack 中的祖先 actor 作为目标，返回 `CAUSAL_CYCLE`。异步 `mcp.send` 允许回发祖先，但显式长链仍受 hop/root-turn/actor-call/queue/timeout 限制，达到边界产生公开错误事件。

这不改变 CLI 的工具/文件/网络权限，只防止 Broker 死锁和无限资源占用。

## D-012：简单技术栈

决定：Node.js + TypeScript；单进程 Broker；首版原生 HTML/CSS/TypeScript UI。

首版不引入前端框架、消息队列服务、向量数据库、LangGraph 或插件市场。

## D-013：SQLite 驱动

方向：使用稳定、固定版本的 SQLite Node 驱动。

当前本机 Node `v24.14.1` 的 `node:sqlite` 仍输出 experimental warning，因此不在文档阶段锁定为默认。M0 比较安装可靠性、Node 24 兼容性、事务/WAL、备份和 CI 后决定。

## D-014：延期范围

延期：

- 完整 A2A server/discovery；
- 多用户登录/RBAC；
- LAN/互联网监听；
- 多房间 UI；
- 远程 Broker federation；
- 自动 Agent 自治循环；
- 向量数据库；
- 大型 artifact 数据面。

这些功能只能在 M0-M2 合同保持稳定后加入。

## D-015：无 AIChatLink 审批子系统

决定：AIChatLink 不构成安全边界。首版固定请求 CLI 以 unrestricted 运行，但 AIChatLink 不判断某个命令是否安全，也不提供 ApprovalService、审批表、审批 REST、审批 UI、批准/拒绝按钮或 `approval.*` 群组事件。

如果 native adapter 发出 approval、permission、`requestUserInput`、question 或 elicitation request，unrestricted 运行合同已经失效。Adapter 必须：

1. 不把 request 转发给 Web UI，也不选择 allow/deny；
2. 以协议允许的 cancellation/error 做有界收尾，避免子进程永久悬挂；该动作只是终止 Turn，不是审批决定；
3. 一律用 `UNEXPECTED_NATIVE_INTERACTION` 失败当前 Turn；interaction request 及其 options 绝不能被重分类为 `NATIVE_POLICY_BLOCKED`；
4. 不自动改 transport、不重放 prompt、不创建 pending 状态。

`NATIVE_POLICY_BLOCKED` 是独立的启动/会话失败路径：只有外部策略预检或 native 启动/session 拒绝明确证明 enterprise/server/static deny 时才能使用，并投影 `native_policy_blocked`。

首版也不引入认证 token、RBAC、capability token、Origin/DNS 防护或秘密内容扫描。loopback、sender binding、输入校验、幂等、队列/循环上限、事务和普通文本渲染都是产品范围或协议正确性措施，不代表安全保证。

AIChatLink 只按合同字段记录数据，不主动采集完整环境、CLI 配置或无界 stderr。用户或模型提交到普通消息/记忆中的内容会按产品语义持久化，AIChatLink 不承诺识别其中的凭据或秘密。

## D-016：派发不确定性、无重放、无 fallback

决定：Structured Adapter 初始化、能力协商或 session 建立失败且 prompt 尚未派发时，该 Turn 明确失败并记录 Adapter 错误；只能由用户或上层编排创建新 Turn 重试，不能启用 Direct。

一旦 prompt 已提交或可能已到达原生 session，连接丢失、超时、Broker 重启或终态不明时，AIChatLink 必须先通过已持久化的 native session/turn 引用进行有界恢复与对账，不得创建新 native turn 或自动重放 prompt。仍无法确认时，将交付确定性单独记录为 `unknown`，并以现有证据收敛到 terminal `interrupted` 或明确失败；保留 attempt、dispatch phase 与恢复证据，避免重复执行、重复工具调用或重复计费。

Structured resume/load 不能自动重放不确定 Turn。历史 Direct attempt 保留原交付确定性和 terminal 记录用于审计，但不会由当前 runtime 恢复或重新派发。

补充：当 Structured 业务 Turn 已经 durable 收敛为 `failed + PROTOCOL_INVALID_MESSAGE`，AIChatLink 可以自动替换已污染的 Adapter 进程/session，并优先 resume/load 原 native session 供后续 Turn 使用。并发的人工与自动恢复必须 single-flight。这个动作只恢复会话承载，不是失败 Turn 的 retry；原 prompt 永不自动重放。

## D-017：配置驱动的 Agent 名册与 npm CLI 分发

决定：`agents` 配置从固定名册改为显式房间名册。键即 agent id(actor `agent:<id>`)，每个条目声明 `driver`(codex/grok/kimi/hermes 原生 CLI 家族)、可选显示名 `name`、`command`、`cwd`、`enabled`。内置 id 省略 `driver` 时默认同名；自定义 id 必须显式给出 driver。名册写谁启动谁；为兼容现有安装，缺省整个 `agents` 字段仍等价于原有 Codex/Grok/Kimi 三 Agent，不自动启用后来新增的 Hermes 与 Claude。同一 driver 可挂多个实例，各自持有独立长驻 session。

runtime 启动时把名册中的自定义/改名 agent upsert 进 actors 表，显示名由此流入 durable 事件与 Web UI;Web UI 的目标 chips、Agent 卡片、身份记忆下拉全部按 bootstrap 名册动态渲染，非内置 id 按 actor id 哈希分配固定调色板色调。

分发形态为 npm 公共 scoped包 `@aiyao/aichatlink`,`bin.aichatlink` 指向 `dist/src/cli.js`，提供 `start`(默认，自动打开浏览器，可 `--no-open`)、`stop`(按 D-031 优雅停止同配置路径 runtime)、`restart`(按 D-031 优雅重载同配置路径 runtime)、`doctor`(系统/Node/CLI 检测)、`init`(浏览器 Agent 引导并在保存后启动/进入群聊)、`update`(查询 npm latest 并更新当前全局安装，可 `--check`)子命令。`update` 先读取 Registry 的稳定精确版本，再把该版本固定传给 npm 全局安装；已最新或本地版本更高时不重装/降级。Windows 通过当前 Node 执行 `npm-cli.js`，macOS/Linux 使用同安装入口或 PATH 中可执行 npm，全程 `shell:false`。首次 `start` 未找到配置时先进入引导页；引导页允许重复添加同一 driver、编辑稳定 id/name/cwd/command，并只写 AIChatLink 配置。standalone 保存后由临时同源 launch 状态等待正式 runtime ready，再在当前页面自动跳转；运行中的 `/setup` 可编辑现有名册，保存后明确要求重启，不自动跳转且不在运行中热换 session。静态资源根从进程 cwd 改为按模块位置解析(`dist/web`)，使全局安装后可在任意目录启动。进程管理与命令解析的跨平台分支(win32 taskkill / posix 负 pid 进程树、PATH 查找)已内置于 supervisor 与 launch 层,macOS/Linux 行为通过依赖注入测试覆盖。

正式 runtime 的 HTTP loopback bind 必须先于 stale session recovery。端口冲突代表另一个 runtime 可能仍在运行；失败进程不得修改现有 Agent instance/session lineage。该顺序防止重复执行 `aichatlink start` 将活跃 binding 错标为 interrupted，并使新消息永久停在 queued。

原因：

- 用户需要给 Agent 起群内显示名，也需要同一 CLI 的多个分身实例；
- 固定三键 schema 把房间成员硬编码进了解析层，扩展必须改协议代码；
- 全局 CLI 是"安装后任意目录启动"的最小分发闭环；npm 裸名 `aichatlink` 已被占用，故用 owner scope。

变更条件：新增 driver 家族需要新 Adapter、命令解析、setup/UI 投影和该 driver 自己的 evidence Gate；多房间/远程分发仍属 Deferred。

## D-018：推理记录可回放但不进入上下文

决定：`turn.reasoning.delta` 保持 transient，不逐 token 写库。Broker 在 native Turn 生命周期内按顺序聚合推理文本，并在 terminal transaction 中最多插入一条 durable `turn.reasoning.recorded`；它先于成功 response 和 terminal event 取得 seq，因此页面刷新、SSE 重连和历史回放都能恢复推理记录。

隔离：`turn.reasoning.recorded` 只属于本地时间线与审计投影，不是 `message.created`、MemoryRecord、IdentityRecord 或 Summary。Context Packet、reply chain、Room Context Engine 压缩和自动记忆必须只消费明确的消息/记忆数据，绝不能读取推理记录正文。

原因：逐 token 持久化会放大 SQLite 与 SSE 压力，而完全 transient 会让已展示的推理在刷新后消失。每 Turn 一条终态聚合记录同时保留可恢复 UX、事务顺序和上下文隔离。

迁移与回滚：不新增表或列；旧 reader 将未知 durable event 当通用事件忽略。回滚只停止生成新记录，已存事件仍可安全读取，且不会因回滚进入上下文。

## D-019：工具进度可回放但不进入上下文

决定：live `tool.progress` 继续是 transient。Broker 在 Turn 内保留 Adapter 已经投影的 `tool.started/tool.completed` 更新，并在 terminal transaction 中按观察顺序写为 durable `tool.progress.recorded`。Web 对 live/durable 两种事件都使用 `turnId + toolCallId` 合并，同一次工具调用刷新后仍只显示为 Agent 回复气泡内的一条折叠记录。

隔离：工具记录不是聊天消息、回复链、MemoryRecord、IdentityRecord 或 Summary。Context Packet、Room Context Engine 压缩和自动记忆只读取明确的 `message.created`/记忆输入，不读取工具名称、参数、状态或详情。

原因：工具进度完全 transient 会在刷新后消失；直接把它拼进 reasoning 或最终回复会混淆数据类型并可能污染后续上下文。独立 durable event 保留 UI 与审计价值，同时维持语义隔离。

迁移与回滚：不新增表或列。旧 reader 可忽略未知 event type；回滚停止生成新记录即可，既有事件仍不会成为上下文输入。

## D-020：`aichatlink start` 是幂等的启动或复用

决定：loopback HTTP listener 继续是单 runtime 的原子租约，CLI 不新增第二套锁文件。正式 runtime 的 `GET /api/health` 返回 `service="aichatlink"`、`protocol="aichatlink.runtime/1"` 和 `runtimeKey`；key 由 canonical config 与 canonical config path 做 SHA-256，只用于判断重复启动是否指向同一配置，不是 secret 或认证机制。

CLI 在创建 Store、Adapter 和 native session 前先探测目标 origin：

1. service/protocol/key 全部相同：打印现有 URL、按 `--no-open` 决定是否打开页面，然后以成功状态退出；
2. AIChatLink key 不同、旧版/不兼容 AIChatLink 或其他 HTTP listener：明确提示冲突；
3. listener 不可达：正常尝试 `listen`；若发生 `EADDRINUSE`，最多有界复查三次以收敛并发启动竞态；
4. AIChatLink 永不自动杀掉占用进程，也不自动选择下一个端口，因为那可能创建两个 Broker 共用一份 SQLite 与 native session lineage。

回滚边界：移除 CLI 预检只会恢复原始 `EADDRINUSE` UX；健康响应新增字段是向后兼容的 JSON 扩展，不改变 REST 写合同、数据库 schema 或 Agent 协议。

## D-021：Agent 核心记忆与按日期记忆分层

决定：每个 Agent 的私有记忆拆成两个不能互相冒充的数据层：

- `core` 是少量、长期、显式维护的核心记忆。Structured Agent 通过绑定到自身的 `core_memory_remember` 工具主动写入；工具输入不接受 scope、subject、author 或 binding，Broker 一律从当前 session binding 固定为调用 Agent 自己。Web Agent 设置可以追加、替换和撤回同一 Agent 的 core；
- `dated` 是成功 Turn 的自动工作记录层；其生成频率和持久检查点由 D-023 取代原逐 Turn 方案。失败、取消、中断或终态不明的 Turn 不成为 dated source；
- dated 的日期来自 Broker 持久化的本地日期，不是模型提供的正文或参数。自动记录不读取 reasoning、tool、stderr、native payload、公共记忆或完整历史；
- Context Packet 分别投影 `[agent_core_memory]` 与 `[agent_dated_memory]`。core 在可选记忆区段中优先；dated 是有界每日语义 rollup，并受字符预算约束；
- 公共房间记忆继续使用 room scope，和两个 Agent 层完全分离。普通聊天不会自动成为公共或 core MemoryRecord。

持久化：schema v6 在 `memory_records` 增加仅对 `scope_type=agent` 有效的 `agent_memory_type=core|dated`。升级前已有 Agent 记忆保守迁移为 `core`；room/correlation 记录保持空值。supersede 必须保留原层，不能借替换把 dated 转成 core 或反向转换。

原因：核心记忆需要 Agent 主动筛选，自动日期记忆需要保留连续工作事实；混为一类会让自动摘要稀释长期偏好，也会让 Web/工具误把系统生成记录当成 Agent 明确承诺。terminal transaction 只登记来源，MemoryRecord 的批量生成边界见 D-023。

回滚边界：停止生成新 dated 或隐藏 core tool 不会破坏已有记录。回滚代码仍必须把未知 `agent_memory_type` fail-closed，不能把 dated 无条件当 core 注入；若降级到 schema v5，需要显式导出/重建数据库，不做破坏性原地降级。

## D-022：Hermes ACP driver

决定：Hermes 以独立 `hermes` driver 接入现有 Structured ACP kernel。AIChatLink 固定使用 `hermes --yolo acp`，校验 initialize 的 `agentInfo.name="hermes-agent"`，在每次 new/load 后设置 `dont_ask`，并把 session binding 作为 sender provenance。Hermes 可和其他 driver 一样创建多个独立房间实例。

Hermes 0.20.1 的 initialize 当前未声明 `mcpCapabilities.http`，但官方实现明确接受 ACP `session/new`/`session/load` 中的 HTTP MCP descriptor。这个兼容例外只存在于 Hermes Adapter：共享 ACP kernel 对其他 driver 仍严格要求 capability advertisement；能力报告保留 raw initialize 事实，并把描述符接收标为 `documented/probed`，不能冒充模型实际 `tools/call` 已 verified。

本次边界内已完成本机 `hermes acp --check`、ACP v1 initialize、session/new、`session/set_mode(dont_ask)` 和跨进程 session/load 的无模型 probe。Hermes native 模型回复、AIChatLink MCP 实调、取消中实际模型回合等仍需独立 live evidence 后才能写成 `verified`；现有 Codex/Grok/Kimi M0 矩阵不会自动替 Hermes 背书。

## D-023：日期记忆使用可恢复的每日批量 rollup

触发证据：逐 completed Turn 直接写一条 dated MemoryRecord 会把同一 `@all` 用户消息复制到每个 Agent，`memory.*` event 又复制整条正文；长期房间会产生大量低价值问候、确认和测试记录，并让 Context Packet 在 500 条候选中反复筛选原始回合片段。完整 transcript 已经是逐回合权威事实源，日期记忆应承担语义工作日志而不是第二份 transcript。

决定：

- terminal immediate transaction 仍只在 completed 时登记 source/response 外键、本地日期和字符计数；业务 response/terminal 不等待模型摘要，也不创建 dated MemoryRecord/event；
- 每个 `room + Agent + local date` 最多一条 active 自动 dated rollup。达到 8 个待处理成功 Turn、约 16K 原始字符、日期切换，或 Room Context Engine 即将压缩越过 source 时触发；普通阈值需等待最后活动后的 5 分钟；
- 使用该 dated 所属 Agent 的独立、短生命周期、无 MCP Structured session。其他 Agent 不 fallback 代写个人工作记忆；临时失败最多立即重试 3 次，随后持久记录退避时间并延后恢复；
- 输入只从登记过的当前 `message.created` 和最终 response 回读。输出最多 8K，只保留重要进展、决定、偏好、约束和未完成事项；无语义价值批次只推进 checkpoint，不创建记录；
- 同日更新把前一条 daily memory 作为输入，以 active memory id CAS/supersede。生成、版本替换、source processed 标记和 `memory.remembered|superseded` event 在一个 SQLite immediate transaction 提交；原 transcript 不删除。

对原始需求的影响：公共群组记忆、Agent 身份、透明转发和 Structured CLI 通信边界不变；Agent 私有日期记忆更少、更稳定。core 仍只能由所属 Agent 工具或 Web 显式维护，不能被自动 rollup 冒充。

迁移：schema v7 新增 `agent_dated_memory_rollups` 与 `agent_dated_memory_sources`。不回填升级前已完成 Turn，避免把旧 transcript 重复生成记忆；已有 `automatic_turn` dated 记录保持可读，之后的新记录使用 `source_kind=automatic_rollup`。v6 的 `agent_memory_type` 语义不变。

复杂度与回滚：新增一个后台定时/single-flight 引擎、两个只保存外键/检查点的表和一个 compaction 前 best-effort hook。关闭引擎即可停止新 rollup；pending source 与 transcript 都可保留，不影响聊天恢复。降级 schema 需导出/重建，不做破坏性原地删除。

完成标准：存储测试证明 completed 只登记来源、失败 Turn 不登记、同日 CAS/空批次/崩溃重开幂等；引擎测试证明 8 Turn/16K/日期/压缩触发、5 分钟 debounce、owner-only、8K 上限和失败重试；Context Packet 与 compactor 测试继续证明 reasoning/tool 不进入任何自动记忆。

## D-024：Claude Code stream-json driver

触发证据：Claude Code CLI 没有 ACP 子命令。它的第一方结构化 stdio 面是 `--print --input-format stream-json --output-format stream-json`，一条 JSONL 消息流而不是 JSON-RPC。社区存在 ACP 桥（`@zed-industries/claude-code-acp`），复用现有 ACP kernel 只需约 40 行；但那是厂商之外的协议 shim，会让 Claude 成为唯一一个不走自己原生协议入口的 driver，并把 AIChatLink 的访问契约押在第三方包的版本上。

决定：Claude Code 以独立 `claude` driver 和独立 Adapter 家族（`src/adapters/claude/`）接入 Structured transport，直接架在通用 JSONL 进程层 `supervisor/jsonline-process.ts` 之上，不复用 `adapters/jsonline-rpc.ts`。protocol 串为 `claude-cli-stream-json-v1`。固定产品 argv 为 `--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions`，MCP 绑定追加 `--mcp-config`，会话追加 `--session-id <uuid>` 或 `--resume <uuid>`。native session id 由 AIChatLink 自己指派，不向 native 协商。

握手（本次接入的核心协议差异）：Claude Code 的 `system`/`init` 帧只在收到第一条 user 消息之后才发出，因此它不能充当握手。若 `start()` 等待该帧，会在没有任何模型回合的情况下永久挂起——这一点由实机 probe 直接观测确认（写入 stdin 后 35ms 才出现 init）。AIChatLink 改用 SDK 控制协议：`control_request`/`initialize` 证明进程存活并投影 `current_permission_mode`（观测值，部分 CLI 会回显用户 settings 默认模式，即使 argv 已要求 `bypassPermissions`），再用 `control_request`/`set_permission_mode` **建立** `bypassPermissions`。只有 set 被拒绝或降级才判 `NATIVE_POLICY_BLOCKED`；initialize 缺字段仍是 `PROTOCOL_INVALID_MESSAGE`。每次 start/resume 都重申 set，不因 initialize 已是目标模式而跳过。这是 Codex `configRequirements/read` 与 Kimi/Hermes `session/set_mode` 在 Claude 上的对应物。延后到首个 Turn 才到达的 `init` 帧仍要校验 `session_id`、`cwd` 与 `permissionMode`，不匹配则判该 Turn 失败。

`initialize` 响应同时携带 account、organization、model、command、plugin 清单。Adapter 只投影 `current_permission_mode` 与 `pid`，其余字段不进入任何 AIChatLink 记录或诊断（不变量 11）。取消走 `control_request`/`interrupt`，终态是 `result` 帧且中止原因有两个：流式输出中取消为 `aborted_streaming`，工具执行中取消为 `aborted_tools`（后者才是长 Turn 里最常见的取消点），两者都归一化为 `turn.cancelled`。实机确认取消后同一 stdio 进程仍可继续下一个 Turn，因此取消不污染 session。若 interrupt 输给了正在收敛的 Turn，CLI 仍会为该 interrupt 补发一个 `result`；Adapter 在 cancel 窗口内吸收这一帧，避免它终结下一个 Turn。注意 `result.num_turns` 是单次 prompt 内部的 agent 迭代计数而非会话级单调计数器，不能用来做跨 Turn 关联。

交互类 control request 一律在协议边界拒绝并以 `UNEXPECTED_NATIVE_INTERACTION` 失败当前 Turn：实测 CLI 的交互 subtype 为 `can_use_tool`、`elicitation` 与 `request_user_dialog`；`hook_callback`、`mcp_message`、`host_auth_token_refresh`、`oauth_token_refresh` 不是决策请求，只回协议错误而不失败 Turn。AIChatLink 仍然没有审批子系统。

本次边界内已完成实机 native-live 证据（Claude Code 2.1.233 / win32）：基础回合、流式增量、AIChatLink MCP `memory_search` 经 http binding 精确实调一次、runtime 重启后 `--resume` 会话恢复、干净关停、无残留进程、用户 settings 未被改写。证据独立存放于 `.aichatlink/evidence/claude-live/`，沿用 Hermes 先例，不进入 Codex/Grok/Kimi 三 Agent 的核心 M0 gate。已知并记录：Claude Code 会在任何调用下重写自己的 `~/.claude.json` 会话状态文件，这是原生 CLI 行为而非 AIChatLink 写入，因此该文件只作诊断记录、不作 gate。

回滚边界：`claude` 是加法接入。移除它只需从名册删条目；缺省 `agents` 字段本就不自动启用它，现有 Codex/Grok/Kimi/Hermes 房间不受影响。

完成标准：Adapter 测试覆盖固定 argv、无模型控制握手（initialize 观测 / set 建立，含 initialize 报 default 而 set 升级成功）、策略拒绝与降级、延后 init 帧的 session/cwd 校验、流式增量与完整消息去重、工具起止、取消与取消超时、首事件与空闲超时、畸形帧、进程中途退出、握手前退出的 stderr、`--resume` 重启，以及 `initialize` 载荷的字段投影边界。命令解析覆盖 Windows PATH（不依赖 APPDATA）、`%USERPROFILE%\\.local\\bin\\claude.exe`、npm 回退、拒绝 `.cmd` shim，以及 POSIX `~/.local/bin/claude`、当前 Node 前缀 / Homebrew / `/usr/local` 的 npm 回退。

## D-025：ask 超时不加回送机制，harness 只以有界文本指导模型闭环

触发证据：2026-08-17 一次真实审 PR 会话（用户库 `corr_9dd9b038d2c5462084fe781cfa7faeb0`）中，Claude 以默认 120s `ask` 询问 Codex，子 Turn 实际运行 11.3 分钟；超时后 Claude 读取一次即收工，Codex 终稿以 `to=[]` 落房，提问方永远不会再被唤醒，双方在未真正对齐的状态下完成了 PR 修改。逐层核对确认：ask 超时后没有任何回送路径；MCP instructions/工具描述完全没有说明「收工回复不唤醒任何人」「超时后目标仍在运行」等语义；`timeoutMs` 上限 600s 连想等也等不了。

决定：不引入 Broker 回送/续跑 Turn、兄弟终稿门禁或任何新派发来源，保持不变量 7（只有显式工具调用或用户路由派发 Turn）不变。harness 只做四处最小干预：

1. MCP server instructions 与 `send/ask/read` 工具描述写明唤醒、超时与上下文冻结语义；
2. `ask` 超时的目标结果附带有界 `note` 指导文本（合同新增可选字段，向后兼容）；
3. Context Packet `[aichatlink_protocol]` 头部固定一行路由提醒，覆盖所有 driver 的每一轮；
4. `ask` 的 `timeoutMs` 调用上限从 600,000 提升到 3,600,000 ms（与 `timeouts.askMs` 配置上界一致），默认值不变，等多久由调用模型自行决定。

对原始需求的影响：交付闭环依赖模型智能与用户在房间内的最终兜底，符合透明 Broker 定位（R3/R5/R7 不变）；不新增状态机、存储表或审批语义。

协议/存储迁移：无存储迁移。`AskResult.note` 为新增可选字段，属向后兼容；PROTOCOL.md §6.2 同步更新。

复杂度与回滚：全部改动为文本与两个合同常量/字段；回滚即恢复原文案与上限，不影响任何已持久化数据。

完成标准：工具描述与 instructions 含关键语义断言；ask 超时结果携带含 correlationId 的 note；Context Packet 头部含固定提醒行；`timeoutMs` 边界测试更新。若真实运行证明纯文本引导不足，再以新证据评估最小回送机制，且必须同步修订不变量 7。

## D-026：放宽消息 wire 上限、运行超时与互调链路默认值

触发证据：真实多 Agent 审查负载的审计发现三类对模型能力的硬约束：(a) Agent 经 `send/ask` 互发内容被固定 wire 上限 32,768 字符卡死，而收工回复本身不限长，长报告无法显式交接；(b) `idleMs=120s`/`firstEventMs=90s` 会误杀长静默工具执行与大上下文冷启动；(c) `hopCount 12 / actorCallsPerRoot 8 / rootTurns 24` 截断较长的多 Agent 协作链。上下文预算族维持 256,000/75%/8,000/120,000/12 不变（评估过 512k 方案后按用户决定还原）。

决定：

1. **消息 wire 上限**：`MAX_MESSAGE_CONTENT_LENGTH` 32,768 → **131,072** 字符，统一作用于 REST/MCP 消息、记忆与身份内容 schema。`limits.messageCharacters` 仍是固定 wire bound 的运行时快照（literal 131,072），schema 兼容解析旧 literal 32,768 并由加载器升级。连动：REST 默认 body 上限 256 KiB → **2 MiB**；`limits.sseBytes` 默认 524,288 → **2,097,152**，保证单条 durable 事件帧永远能装进 SSE 发送缓冲，避免超长消息触发重连死循环。
2. **运行超时默认**：`timeouts.firstEventMs` 90,000 → **180,000**；`timeouts.idleMs` 120,000 → **300,000**（含 Codex/Claude Adapter 回退常量）。idle 计时仍由任意原生事件重置，语义不变。
3. **互调链路默认**：`limits.hopCount` 12 → **24**、`limits.actorCallsPerRoot` 8 → **16**、`limits.rootTurns` 24 → **48**。仍是防失控回路的有界安全绳，触顶行为（公开 `routing.loop_stopped`/`turn.failed`）不变。
4. **迁移**：沿用 48k 上下文预算先例，`upgradeLegacyGeneratedDefaults` 只把恰好等于历史自动生成默认值的字段升级为当前默认（32,768→131,072、24→48、12→24、8→16、524,288→2,097,152、90,000→180,000、120,000→300,000、48,000→256,000），其他显式自定义值不动；`loadConfig` 与 setup 快照共用同一函数。

对原始需求的影响：R3/R5 不变——链路限制仍是可靠性边界而非权限；R7 的本地开销仍受有界队列与限额保护。更长消息与更长静默由用户模型自行决定是否利用，AIChatLink 不新增内容判断。

协议/存储迁移：无 schema 变化；错误码与状态机不变。SQLite 摘要 32,768 硬上限与消息内容无关，保持不变。

复杂度与回滚：常量/默认值与一个共享迁移函数；回滚即恢复旧常量，已升级的配置文件可手动改回。

完成标准：wire 边界测试随常量收敛（接受 131,072、拒绝 131,073）；旧 literal 32,768 配置可解析并升级；全部迁移字段的精确值升级与自定义保留测试通过；超时/链路新默认断言更新。

## D-027：同步监督是房间协作配对

触发：产品需要 worker 执行、supervisor 同步观察、并可打断整轮后写入公开指导。参考评测循环里的观察词汇可以借用；治理流水线、claim firewall、双否决门和 native 工具审批不能移植。

决定：

1. **第三条路由是配对，不是自然语言**。成员 MCP `send`/`ask` 的可选 `supervision: { observers, mode: "live_steer" }` 在同一 `rootCorrelationId` 下并行创建 worker Turn 与 `supervision.watch` Turn。`POST /api/messages` 与 `local-operator` 的 `send` / `worker_dispatch` / `worker_ask` / `dispatch_event` 也可带同一字段。Web composer 仍选择 worker（`@all` 或芯片），但不再提供监督开关或观察者芯片。Observer 不复用用户正文当执行提示。角色只写在本次配对行，不进入 Agent 名册枚举。`sourceKind: "supervision"` 由 Broker 写入；请求方不能自报监督者。调用方不能把自己放进 observers。无群气泡时，pair 的任务引用是 `operator.dispatch` event id。助理自己不当 observer，也没有 `watch`/`steer`。
2. **同步 = 并行 running + 有界里程碑**。`aichatlink.watch` 只在 Watch Turn 成功；等待 `next_milestone | terminal`，快照只含 status、deliveryCertainty、任务引用、公开消息摘要、工具名+status+toolCallId、steer 计数。不转发 token，不带推理正文或完整工具参数。
3. **打断 = 整段 Turn cancel + 新 Worker Turn**。`steer(interrupt)` 复用现有 cancel 对账，再以 supervisor 公开指导为 `current_message` 入队；`nudge` 不打断，只在当前 worker 自然结束后 FIFO 入队。不能取消 Turn 内部某一次 native 工具。已 `delivered`/`unknown` 的原 prompt 不重放（D-016）。
4. **steer ≠ approval**。不产生 `approval.*`，不出现允许/拒绝按钮，不改变 unrestricted argv/mode，不代答 `requestUserInput`。Watch Turn 对正在被观察的 worker 再 `ask`/`send` 返回 `SUPERVISION_STEER_REQUIRED`。
5. **观察是第四类可见数据**。`supervision.paired|observed|steered` 可回放，但不进入公共记忆、core/dated memory 或房间压缩输入。Watch brief 不进 Context Packet 的 unread transcript。Observer Turn 不登记 dated-memory source。Worker 的业务包不自动塞进监督评语。
6. **可靠性沿用 D-011**。Watch/steer 仍走 parent/root/hop/queue；另计 `steersPerSubjectTurn`（默认 3）。触顶可见失败。Broker 不在 steer 后自动再开监督循环第 N 轮。

对原始需求的影响：R2 增加一条显式协作路由，不改变「自然语言不派发」。R3 不变——监督不是安全或审批层。R4 增加独立观察数据类，不与记忆层合并。R5 不把 memsuOS 治理内核搬进 Broker。

协议/存储迁移：schema v8 增加 `supervision_pairs` / `supervision_pair_turns` / `supervision_steer_counts`；Envelope `sourceKind` 增加 `supervision`。schema v9 允许配对任务引用 `operator.dispatch`。

复杂度与回滚：配对只在 `send`/`ask`/operator/`POST /api/messages` 显式带 `supervision` 时创建。回滚可停用该字段与 watch/steer 工具面并停止写配对表，历史事件保留审计。

完成标准：fixture 证明并行观察、里程碑有界、interrupt 改道、steer 上限、自报角色无效、观察包不进记忆/压缩、不产生 `approval.*`、不改 unrestricted argv。不把「真实模型抓到了漂移」写成发布 Gate。操作员派活带 `supervision` 时复用同一 pair 合同，不新开审批面。

## D-028：房间助理是操作员客户端

触发：用户需要一个平级助手来控场和派活，但不能把它做成 Host Agent、第二房间或 Broker 内置模型。自然语言「清一下历史」不能直接触发房间命令。

决定：

1. **助理是 `user:assistant`，不是 `agent:assistant`**。binding 协议是 `local-operator`（`instance:operator` / `binding:operator`）。它与 `user:web` 平级，不进 `agents` 名册，不被 `@all` 唤醒，不吃 Context Packet，也不走成员当前回合 MCP。
2. **用户直连助理**。侧边对话走 `/api/assistant*`，不经 Broker composer，不先落房间 `message.created`，不创建 Agent Turn。默认提示词是产品常量，每次注入；`extraInstructions` 只能追加，不能绕过禁止项。
3. **控场默默做，派活留下有界来源**。cancel / compact / reset / restart / memory / setup 直接打 Broker，时间线没有助理发言。默认派活是 `worker_dispatch` / `worker_ask`：创建 Turn，写 durable `operator.dispatch`（可重放、可进目标 Context Packet、计入房间 usage/compact），不先造群聊气泡。禁止 prompt 只活在内存里。`send` 仅在用户明确要求发到群里时使用，作者不能伪造成 `user:web`。助理写入的 memory/identity 记录 `sourceKind` 是 `operator`，必须能经 REST/MCP 合同回读。`context.reset` 是后续上下文下限：压缩不得把 reset 前的 transcript 或检查点滚进新摘要；仅有 reset 审计事件、没有新的房间上下文时再次 reset 为 no-op。
4. **监督可启动，但不能自己观察**。派活或 `send` 可带与 Web 相同的 `supervision`。助理没有 `watch`/`steer`，也不能把自己放进 observers。
5. **配置在顶层 `assistant`**。禁止 `agents.assistant` 和保留 id `__assistant__`。首次引导默认启用；旧配置缺省该项时保持未启用。至少仍要有一个启用的房间 Agent。
6. **成员 MCP 面负责定向与监督**。`/mcp` 仍要求当前 Turn；`send`/`ask` 可带 `supervision`，watch/steer 仍只在 Watch Turn。`/mcp/operator` 是独立入口，不要求 Agent Turn。
7. **操作员 read 是有界公开投影**。默认 20 条，只回公开语义事件并摘录正文；推理与工具进度全文不进助理脑。成员 `aichatlink.read` 不变。协议行被撑爆后，私有脑可重启一次接上，不把该失败当成审批或改走 Direct。

对原始需求的影响：R1 增加一个用户表面入口，不把助理做成房间成员。R2 不变——自然语言仍不派发。R3 不变——助理不是安全或审批层。R5 增加独立 operator 客户端，不把 LLM 放进 Broker 内核。

协议/存储迁移：schema v9 增加 `assistant_conversation_messages` 与 `context_resets`；Envelope 增加 `operator.dispatch` / `context.reset`；`sourceKind` 增加 `operator`；预置 actor `user:assistant`。

复杂度与回滚：未启用助理时房间行为与 v0.1.14 相同。回滚可停 `/api/assistant` 与 `/mcp/operator`，历史 `operator.dispatch` 和侧边对话行保留审计。

完成标准：schema `documented`；无模型 fixture `probed`；用户→助理不经 `POST /api/messages`；派活可无群气泡但有可重放 `operator.dispatch`；作者是 `user:assistant`；`from`/`actor`/`provenance` 与 dated 写入失败；真实 operator `tools/call` 才 `verified`。

## D-029：无 schema 的协作闭环

更新：本决定第 5 项及旧的“单协调者两轮”完成标准已由 D-030 替代。第 1–4、6 项以及无 schema 的 publish/pending/collect/reply-chain 实现继续有效。

触发证据：2026-08-19 对 Clue Codec 三方评审真实 correlation 的审计显示，最终结论正确，但协作机制产生 28 个 Turns。14 条定向 Agent 消息中有 8 条没有 `replyToEventId`；一次 ask 和随后一次 read 各等待约 300 秒后失败，而同一语义已被 active root Turns 从房间读取并回答；最后又出现 12 条滞后的 Codex response。审计同时确认每 Agent FIFO、parent/root/hop 和 sender provenance 正常，问题集中在「公开进度也会唤醒」「busy lane 上同步等待」「ask 后重复派发」与「回复链默认缺失」，无需重做队列或数据模型。

本决定以该新证据取代 D-025 对成员 ask 超时返回、跟进方式和 3,600,000 ms 上限的选择；D-025 仍保留为当时的历史决策与证据记录。

决定：

1. **公开与唤醒拆开**。新增成员 MCP `publish`：经 Broker 幂等写 durable `message.created`，固定 `targets=[]`，不创建 Turn、不触发 Adapter。公开进度、阶段结论和协调者 checkpoint 使用 publish；send/ask 只用于确实需要目标 Agent 新行动的场景。
2. **ask 先暴露队列，再有界等待**。send 返回 `queuePosition/activeTurnId`。ask 新 child Turn 前方已有非 terminal 工作时立即返回 `state=pending`；否则最多等待 60 秒。未完成结果是 pending，不再把“停止等待”冒充目标 timeout 终态。
3. **pending 只续收，不重放**。新增 `collect(messageEventId)`，只按已有 `turns.source_event_id` 收集原 ask 的 exact child Turns；collect 不写命令、消息或 Turn。pending note 和工具说明要求调用方 collect，不得 resend/re-ask 同一问题。仍不增加自动回送或 Broker 自发 Turn，保持不变量 7。
4. **默认形成回复链**。成员 send/ask/publish 未显式给 `replyToEventId` 时，Broker API 使用当前 active Turn 的 `sourceEventId`。actor、causation、root/hop 仍由 binding/lifecycle 决定，模型不能自报来源。
5. **历史协作提示（已由 D-030 替代）**。本阶段最初把评审提示固定为单协调者 fan-out/collect/汇总，并限制 reviewer 互审。后续同场景核查证明该规则把可靠性优化误写成了讨论拓扑，现不再属于有效产品合同。
6. **不兼容旧 Agent 工具合同**。ask result 改为显式 `state`，每目标带 `turnId/queuePosition`，未完成状态改为 `pending`，MCP wait 上限改为 60 秒。运行中的旧 native session 需要随 runtime 重启重新发现工具；不为旧 descriptor/result 维持双协议。

对原始需求的影响：R1 的公共 transcript 保持完整但进度不再制造 Turn；R2 获得明确的发起、公开、续收三种语义；R3 的 unrestricted/无审批边界不变；R4 不新增记忆数据类；R5 复用 Broker、Envelope 和现有表；R6 sender 仍由 binding 决定；R7 减少长等待和重复 lane 工作。

协议/存储迁移：无 schema migration。`mcp.publish` 使用现有 `client_commands/events`；collect 使用现有 `turns.source_event_id`；queue metadata 从既有 `target_actor_id/enqueue_seq/status` 计算。历史事件和 Turn 原样可读。只有 MCP wire/tool instructions 是有意的破坏性升级。

复杂度与回滚：新增两个成员工具、一个 exact-source wait filter、一个 queue snapshot 和 active lifecycle 的 `sourceEventId`。不增加表、后台 scheduler、回送队列、`subsumed` 状态或 exactly-once 协调器。回滚可移除 publish/collect 和新结果字段；已写 publish event 仍是合法 `message.created`，无需数据清理。

完成标准（已由 D-030 修订）：聚焦合同/Store/Broker/MCP/Context tests 通过，类型检查与构建通过；同场景语义重放的快照、任务和评估口径以 D-030 为准。Turn 数不再作为优化目标。

## D-030：协作工具拓扑中立，Agent 自主组织讨论

触发证据：对同一 Clue Codec 任务的两次真实 correlation 复核发现，28→5 Turns 的算术成立，但两次任务并不等价。原场景从整份原始方案出发，三个 Agent 自行发起交叉质疑、修正和最终收敛；用户只指定 Codex 最后记录结论，没有指定协调者。后一次重放改成只读复核已生成的第 18 节，并在提示中加入“唯一协调者、不要互相讨论、固定两轮”，实际验证的是 ask/pending/collect 的机械链路，而不是原场景的自主讨论衔接。Turn 下降因此不能作为讨论质量改善的证据。

决定：

1. **Broker 提供协作工具，不规定协作拓扑**。AIChatLink 不指定唯一协调者、最终记录者、互评方向或讨论轮数，也不禁止 Agent 经 Broker 直接质疑、修正、委托或形成临时协调方式。用户可以在具体任务中指定最终记录者；“最终记录”不自动等于“负责调度”。
2. **工具提示只解释可观察效果**。final/publish 对房间可见但不唤醒；send/ask 创建目标 Turn；collect 只续收原 ask；read 补读冻结上下文之后的公共状态；replyTo 连接所回应的具体消息。Agent 根据任务自行组合这些能力。
3. **去重规则只约束同一请求**。pending ask 的同一逻辑请求使用 exact `messageEventId` collect，避免重复 Turn。实质不同的追问、反驳或新发现可以新建 send/ask；AIChatLink 不做语义去重，也不把“不要重发”扩大成“不要继续讨论”。
4. **运行中的同根讨论不排延迟回合**。send/ask 即使面对同一 correlation 中已有 running Turn 的目标，也会创建一个排队的独立后续 Turn；publish 则只公开消息。因此模型应先 read 状态，并用 publish/read 在各自当前 Turn 中交换进行中的质疑与回应；只有有意要求后续独立行动时才 send/ask。这是工具效果说明，不限制谁质疑谁、讨论顺序或轮数。
5. **显式触发边界不变**。公共消息和自然语言 `@name` 不自动唤醒 idle Agent；AIChatLink 不增加后台调度器、自动回送、共识状态机或隐式自治循环。运行中的参与者主动 read，idle 目标需要新行动时仍由 Agent 或用户显式 send/ask。
6. **同场景重放按语义而非 Turn 数验收**。测试必须使用相同源内容初始快照和相同任务语义，最好在隔离副本上运行。至少 80% 的重要观点需要得到另一 Agent 有理由的明确回应；关键分歧必须解决或显式保留；同时不得出现 pending 重发、过期回复错接和重复 Turn。总 Turn 数仅作诊断记录，不能作为减少目标。若原始快照无法恢复，只能标为近似复现，不能声称同场景重放。

对原始需求的影响：R1/R2 更贴近透明群聊——公开可见与显式唤醒仍分离，但讨论角色和路径交还模型智能；R3 的 unrestricted/无审批边界不变；R4 不新增记忆或共识数据类；R5 继续复用 Broker、Envelope 和现有表；R6 sender 仍由 binding 决定；R7 保留 exact collect、队列可见性、因果循环和资源上限，只删除过度的语义工作流限制。

协议/存储迁移：无 schema migration。只修订 MCP instructions、工具 description、pending note、Context Packet 路由提醒和验收文档。历史事件、Turn、publish 和 collect 结果原样可读；wire schema 与错误码不变。

复杂度与回滚：不增加表、状态、scheduler、语义去重器或自动 Agent。第一次同快照试跑证明，只写“拓扑中立”仍不足：三个 root Turn 已在 publish/read 中完成交叉回应并收敛，但早先互发的 targeted send 留下 14 个排队 child Turns，会在收敛后延迟重放。当前修订只把这个现有队列语义明确告诉模型；回滚会重新引入讨论拓扑偏置或延迟重复，因此不建议。

完成标准：聚焦 MCP/Context/pending note tests、类型检查与构建通过；相同快照与任务的真实三方重放达到上述 80% 语义标准，且无新增机械回归。模型是否每次选择同一讨论方式不是发布 Gate。

## D-031：`aichatlink stop` / `aichatlink restart` 以配置路径作用域优雅控制 runtime

触发证据：运行中从 Agent 设置保存新成员后，旧 runtime 有意不热换 Adapter/session，新成员只显示 `pending_restart`。但 `aichatlink start` 的幂等合同会复用完全相同的 runtime；配置内容已变化时又会按不同 `runtimeKey` 报冲突。用户只能回到拥有旧前台进程的终端按 `Ctrl+C`，既缺少从任意终端完成“关闭旧实例并加载最新名册”的产品命令，也缺少只优雅停止当前 runtime 的独立命令。

决定：

1. **新增显式 CLI 命令**。`aichatlink stop [--config <path>]` 与 `aichatlink restart [--config <path>] [--no-open]` 只处理已经在当前配置 `server.port` 上运行的正式 AIChatLink。实例本来未运行时 fail-closed；`restart` 提示启动应使用 `aichatlink start`，不会把它偷换成可能制造第二个 Store writer 的 start。`stop` 在完整关闭后结束，不创建替代 runtime。
2. **配置内容与配置路径分开相关**。现有 `runtimeKey` 继续由 canonical config + canonical config path 生成，服务 `start` 的精确复用；新增非秘密 `runtimeScopeKey` 只由 canonical config path 生成，使 Agent 名册保存后仍能确认旧、新 runtime 属于同一配置文件。它是 correlation handle，不是 credential、认证或第二套锁。
3. **只控制同作用域 runtime**。CLI 只有在 runtimeKey 完全相同，或旧 health 的 runtimeScopeKey 与当前 canonical path 相同时，才调用 `POST /api/runtime/shutdown`。另一配置文件、旧版/不兼容 AIChatLink、外部 listener 与 scope mismatch 均 fail-closed。若 `server.port` 同时改变，当前 origin 无法发现旧实例，必须先手动停止旧端口；不扫描端口或进程。
4. **listener 是完整关闭租约**。shutdown 的 202 响应完成后，HTTP 先进入 draining，关闭 SSE、拒绝新工作并等待已开始的 REST 请求，但不释放端口；随后有界关闭房间助理、MCP、Broker、Agent session、publisher/SSE 和 Store，最后才关闭 listener。CLI 需要连续观察不可达，避免一次连接抖动被当作退出；`stop` 此时完成，只有 `restart` 执行既有 start 竞态流程。
5. **不扩大恢复权限**。重载后的新进程仍走 D-016 与存储 5.1-5.3 的恢复：queued/明确未交付可恢复，已交付或不确定 Turn 不自动重放；Structured session resume/load 只服务后续 Turn。restart 不是当前 Turn retry。

对原始需求的影响：R1 的动态名册获得可操作的停止/加载闭环；R3 的 unrestricted 与无审批边界不变，runtimeScopeKey 也不构成安全机制；R4 的 transcript/记忆继续由同一 SQLite 事实源恢复；R5 只增加窄 CLI 命令并复用既有 loopback 生命周期面，不引入 daemon manager 或锁服务；R6 sender binding 在 restart 后按稳定 actor 重建；R7 以先完整关闭再启动避免双 Broker、双 session 与双 Store writer。

协议/存储迁移：`aichatlink.runtime/1` health 增加可选兼容字段 `runtimeScopeKey`，并增加严格的 `POST /api/runtime/shutdown` 请求/202 响应；draining health 为 503 + identity。没有 SQLite schema、event、`client_commands`、PID/lock 文件或配置迁移。运行中的旧版本没有端点时要求手动停止一次。

复杂度与回滚：增加一个路径 hash、一个受 scope 校验的 loopback handler、HTTP draining 阶段和 CLI 有界轮询；`stop` 与 `restart` 共用该路径。回滚可移除 stop/restart 命令与端点；已发布 health 的附加字段可被旧 reader 忽略，数据库无清理工作。不能回滚为按端口强杀、按 PID 当稳定身份或在旧 Store writer 退出前启动替代进程。

完成标准：单元测试覆盖同 path 配置变化、不同 path/占用者拒绝、旧端点缺失、连续不可达与关闭超时；HTTP 测试覆盖严格 scope 和 draining health；runtime integration 用被阻塞的 Adapter close 证明 listener 在 session 完整关闭前仍绑定；类型检查、全量测试和构建通过。


## D-032：Web UI 采用「纸与墨」视觉系统，tone 只用于身份而非装饰

触发证据：`web/styles.css` 经 18 版增量累积后出现 27 种字号（24 种 ≤ 0.72rem）、95 个 hex、72 个 token，74% 的对话区用无 `max-width` 的满宽文本，7 张 Agent 卡常驻路径/能力/重启按钮。次级文字对比度 2.84:1。每个改动局部合理，整体无秩序；用户对界面的判断是「丑」而不是「缺功能」。

决定：

1. **单一视觉语言**。`/` 与 `/setup` 共享 `web/tokens.css`：暖中性画布 + 纸面 + 一个强调色（陶土），品牌与区域标题用衬线，正文用系统无衬线。不加载网络字体（CSP 保持 `default-src 'self'`）。
2. **量上封闭**。字号 7 级（10/11/12/13/15/20/26-34）、表面 3 层、圆角 5 档、间距 4px 基数；新增值必须先改 token 并登记到 `docs/WEB_UI.md`。中文不小于 11px，正文 15px/1.8。
3. **tone 只做身份**。D-017 的色调分配机制不变，但色调只允许出现在头像底/名字/目标芯片/流式光标，不得用于卡片边框、状态圆点阵列或气泡背景。状态用 ok/warn/danger 三色单独表达。
4. **版式从「后台」改为「阅读」**。左侧参与者栏由顶栏专用按钮显式折叠/展开（72px 头像条 ↔ 296px 名册控制面，状态持久化），展开态逐行给出 driver 型号与重启/配置入口；阅读列改为 `min(1040px, 100% - 96px)` 的自适应列 + 与列同宽的输入卡，展开侧栏时收窄列而不是留下空白；助理抽屉在 ≥900px 时占独立列而不是遮挡输入器。设置页采用满视口「名册轨道 + 单卡详情」的 master-detail：一次只编辑一个 Agent，两栏各自滚动、保存条不再覆盖字段；driver 不转发的能力（ACP 的模型/思考强度、Claude 之外的思考档位）在 UI 上禁用并说明，绝不做静默保存；分步向导、整机探测清单、运行合同说明块与「已载入」提示条全部移除。
5. **呈现层改动不改合同**。DOM 只做必要重排（输入器把目标芯片与发送键下移成一行、轨道折叠），id 与事件绑定不变；不新增依赖、不改 REST/SSE 负载、不改 `aichatlink.json`。

原因：AIChatLink 的界面主体是长文本阅读（多 Agent 讨论），旧样式继承的是企业 IM 的密度假设；在 1600px 画布上同时暴露 24 处彩色信号与 27 种字号，读者无法建立层级。把颜色收回成「标点」、把密度收回成「阅读列」，是唯一能同时解决「挤」「灰」「花」三症状的改法，且不牺牲任何现有信息（路径、能力、重启仍在轨展开态可达）。

变更条件：新增视觉组件若需要第 8 级字号、第 4 层表面或第二个强调色，必须先更新 `docs/WEB_UI.md` 的 token 表与禁止清单，并说明为何现有层级无法表达。主题扩展（多配色、用户自定义 accent）不在当前范围。

完成标准：`npm run typecheck` 与全量测试通过（617 passed）；静态白名单同时登记 `tokens.css`；1600/1280/430 三档明暗截图无裁切、无横向滚动；正文字号与对比度满足 WEB_UI.md 第七节。

## D-033：每 Agent 模型/思考强度走 argv，房间上下文预算改为 1M 字符

触发证据：`/setup` 的 Agent 卡只有 Driver/ID/身份/cwd/命令，无法为同一 driver 的不同实例选择模型；用户实际使用 CC Switch 切换供应商，但 AIChatLink 无法把自己的选择带到房间里。另有一条上游限制：REST 合同的 `DEFAULT_KNOWN_TARGETS` 是静态列表，任何额外 agent id（`pi-architect`、上游自带的 `claude-builder`）都会被 `POST /api/messages` 以 `UNKNOWN_TARGET` 拒绝。同时输入器把 7 个目标芯片排成一行横向滚动，拖动困难；房间上下文硬上限 256k 字符低于当前模型的窗口。

决定：

1. **模型是 Agent 配置，不是全局配置**。`aichatlink.json` 的 `agents.<id>` 接受可选 `model` 与 `thinking`（`off|none|minimal|low|medium|high|xhigh|max|ultra`）。Adapter 只把它们放进本进程 argv / thread config：Claude 为 `--model`、`--effort`；Codex 为 `-c model="…"`、`-c model_reasoning_effort="…"`；pi 垫片从 Claude argv 读取并覆盖角色文件。**不写** `~/.claude`、`~/.codex`、`~/.pi/agent` 等用户全局文件。
2. **留空即跟随 CLI**。未设置时 AIChatLink 不追加任何参数，因此 CC Switch 当前写入的全局选择仍然生效；这满足「默认与 CC Switch 保持一致」，同时保留自定义模型名。
3. **选择项只读投影**。`/setup` 的候选来自 CC Switch 的 `~/.cc-switch/cc-switch.db`（is_current 供应商）与 `~/.pi/agent/models.json`，只投影 provider 名、模型 id、思考档；`settings_config` 里的 API Key 不进入任何 AIChatLink 记录、日志或响应。
4. **驱动不支持就不假装支持**。ACP（Grok/Kimi/Hermes）当前没有模型选择面，UI 明确显示「该驱动未暴露模型选择」；不支持的思考档由驱动回落，不报错。
5. **契约不再拒绝 `model`**。原测试把 `model` 与 `sandbox/approval/yolo/tools` 一起视为禁用覆盖；`model/thinking` 是本次新增的显式字段，`sandbox/approval/yolo/tools` 仍拒绝。
6. **目标选择器折叠成弹层**。输入器只保留一个「发送给 @…」按钮；展开后芯片按行换行（全选/清空），不再横向拖动。`target-picker` 的 DOM id 与事件绑定不变。
7. **房间上下文默认 1,000,000 字符**。`DEFAULT_CONTEXT_CHARACTERS` 从 256k 提升到 1M；旧的 48k 与 256k 自动生成默认在加载时升级，其他显式值保持不变。

原因：模型选择属于 Agent 实例而不是房间，放进 argv 才能同时满足多实例、可审计、不污染全局配置；静态 target 白名单会让「同一个 driver 添加多次」这一既有能力在 REST 上失效，属于实现缺口而不是产品边界。1M 预算是把「字符」当确定性上限，不对任何 provider 的 token 窗口作承诺。

变更条件：若某驱动后续通过自己的协议暴露模型选择（例如 ACP `session/set_model`），应优先用原生协议并在同一矩阵登记；若要支持「房间内临时切换后跨重启保留」，需要区分 setup 值与 `/model` 快照的优先级（当前为 setup 值优先）。

完成标准：`npm run typecheck`、全量测试、构建通过；`/api/setup` 返回每 Agent 目录且不含密钥；pi 角色在 setup 中选择 `<provider>/<model-b>` 后重启，`/state` 与 `--model` 一致并能完成回合；Claude/Codex argv 单测通过；目标弹层可开/关、外部点击与 Escape 关闭；`/api/context` 显示 1,000,000。

## D-034：对话列表由 context reset 纪元投影，新对话重启原生 session

触发证据：用户反馈主页面无法新开对话、无法删除旧对话、没有对话记录，且 Agent 无法回答"你是哪个模型"。参考本机开源 PI-Desktop（`vastsa/PI-Desktop`）的会话语义：session 是一等记录（title/title_source、model/thinking、messages 按 session 归属、软删除/归档），侧栏按会话分组。AIChatLink 现有事件与 turn 全部是 room 级，没有 session 表；但已有 `context_resets` 与 `context.reset` 事件，且 operator 的 reset 可以带 `resetNativeSessions`。

决定：

1. **对话 = context reset 纪元**。`GET /api/conversations` 把 `context_resets` 的 `through_seq` 边界投影为会话列表：标题取该纪元第一条用户消息（无消息时 `对话 N`），`startSeq/endSeq` 供历史回放，最后一个纪元 `active=true`。不新增表，不改事件模型。没有房间消息的已关闭纪元不投影（连续 reset 或 reset 后立刻续聊留下的空边界），活动纪元始终显示。
2. **新对话 = reset + 重启原生 session**。`POST /api/context/reset` 复用 `resetContextFromBinding`；当 `resetNativeSessions=true` 时，SessionManager 走 `restartFresh`（不 resume 旧 native session），否则沿用 `restart`。这样新对话的上下文与 Agent 原生记忆都从空开始；旧 transcript 与服务端审计仍完整保留。
3. **删除是隐藏，不是销毁**（已被 D-043 取代：删除改为带确认的本地永久清除）。事件是 append-only 审计事实；UI 的"删除"只把会话 id 写入 `localStorage` 并从列表隐藏，可恢复。UI 文案明确这一点，不假装硬删除。
4. **历史只读，发送即续聊**。旧纪元通过 `GET /api/events?afterSeq=` 回放；回放本身不写任何数据。后续修订（D-038）：在回放态发送会先经 `POST /api/conversations/resume` 把该对话续成新纪元，因此输入器不再禁用。
5. **思考默认折叠**。`turn.reasoning.recorded` 仍在时间线占一行，但正文默认不显示，点击"推理记录 · 展开"才显示。
6. **宿主下发模型事实**。pi 垫片在每条 prompt 前注入 `[host_agent] role/provider/model/thinking`；AIChatLink 对原生 driver 把同一事实拼进 `configured_agent_identity`。Agent 不再需要猜自己的模型，也禁止把猜测写成事实。

原因：用户要的是"像 pi-Desktop 那样的会话列表"，而不是再做一个假的 session 存储。AIChatLink 的 reset 纪元已经提供隔离上下文与历史边界，补上 fresh native session 后语义与"新会话"一致；把删除做成隐藏是对 append-only 审计的诚实让步。

变更条件："重新打开旧会话继续对话"已由 D-038 用「新纪元 + 只读种子」实现，因此不再要求 session 表；若后续需要按 session 路由 Turn、项目分组/置顶/搜索，或续聊必须排除中间纪元，则仍要引入真正的 session 表与多区间种子。

完成标准：`GET /api/conversations` 返回按纪元分组的标题与 seq 边界；`resetNativeSessions=true` 后 pi 进程的 `--session-id` 变化且旧 nonce 不可回忆；侧栏可新开/查看历史/隐藏；历史模式输入禁用；推理默认折叠；typecheck、419+ 测试与构建通过。

## D-035：主时间线只投影当前纪元，reset 时退役在飞回合

触发证据：用户在 0.1.16 点击"＋ 新对话"并确认后，侧栏出现了新的 `对话 5`（`startSeq=260`），但主时间线仍显示前一段对话的消息；同时页面顶部报 `Failed to execute 'insertBefore' on 'Node'`。核对 `room:main` 事件流确认两件独立事实：`context.reset` 落在 seq 260（`throughSeq=259`、`resetNativeSessions=true`），而 `/api/bootstrap` 的 `recentEvents` 是最新 100 条、不按纪元截断，所以刷新后 167–259 被重新渲染；另外 seq 261–266 是被 reset 中断的旧回合的 `turn.reasoning.recorded` / `tool.progress.recorded` / `turn.cancelled`，它们落在新纪元里，把旧内容又带回来了。崩溃则来自 `finalizeStreamsForTurn` 把 `.reply-reference` 插到 `.event-content` 之前，而后者是 `.event-body` 的子节点。

决定：

1. **主时间线是纪元的视图，不是 transcript 本身**。`web/conversation-epoch.ts` 提供纯投影：`activeEpochStartSeq()` 取 `/api/conversations` 里 `active=true` 的 `startSeq`，`epochStartAfterReset(throughSeq)` 给出下一个纪元的起点。bootstrap 用它过滤 `recentEvents`，live `context.reset` 用它推进边界。transcript、事件模型与 `/api/events` 不变，旧纪元仍从历史抽屉回放。
2. **reset 会退役在飞回合**。`context.reset` 只记录边界，正在跑的回合随后才落 teardown 事件，因此这些事件天然属于新纪元。UI 在纪元切换时把 `dispatching`/`running`/`cancelling` 的 turn id 记入 `retiredTurnIds`，并在重放窗口里按同样的状态机重算一遍（`seedRetiredTurnIds`）；退役回合的所有事件都不进时间线，直到其终止事件到达时释放。**必须按 turn id 而不是 correlationId**：一次并行 @all 广播共享同一个 correlation，按 correlation 退役会连带清掉同批已完成的回合。仅 `turn.queued` 未派发的回合不退役，它仍可能在新纪元执行并应当显示。
3. **空时间线给出明确文案**。`openEpochStartSeq > 1` 且无内容时，空态改为"新对话已开始 / 上下文与原生会话已重置…上一条对话在左侧列表里只读查看"，避免用户误判新对话没生效。
4. **静态资源白名单同步**。`web/conversation-epoch.js` 加入 `STATIC_ASSETS`，否则浏览器 import 404 会打挂整个 UI。

原因：D-034 把"新对话"定义成 reset 纪元 + fresh native session，但只改了服务端边界，没有把主视图收窄到该纪元，用户看到的就是"点了新对话还是旧对话"。把视图按纪元收窄，比事后"清屏"更诚实：历史仍在服务端与抽屉里，未被删除或改写。

变更条件：若改为真正的 session 表 + 按 session 路由 Turn，则时间线过滤改由 `session_id` 完成，`retiredTurnIds` 这个视图补丁随之删除。

完成标准：`tests/unit/web/conversation-epoch.test.ts` 覆盖边界与回合状态；`/` 在存在旧纪元时只渲染当前纪元事件，空纪元显示"新对话已开始"；历史抽屉仍可回放旧纪元且输入器禁用；`npm run typecheck`、全量测试与构建通过。

## D-036：房间级工作目录（workspace）+ 本机目录选择器

触发证据：用户反馈「系统缺少打开工作文件夹的功能」，并且「工作目录要随着工作文件夹的不同而发生改变和同步」。现状是 `/setup` 里每个 Agent 各有一个 `cwd` 文本框（7 条全写死同一个绝对路径），换仓库要逐个改、没有目录浏览器、也没有「当前工作目录」的展示。

决定：

1. **房间级 `workspace` + 单角色可覆盖**。`aichatlink.json` 顶层新增 `workspace`；Agent 与 `assistant.brain` 的 `cwd` 变为可选，省略即继承。填充发生在 schema 校验之前，因此解析后的配置里 `cwd` 仍是字符串，下游 adapter/session/MCP 没有第二套语义。
2. **保存写简写形式**。投影时把「与 workspace 相同」的 `cwd` 省略（编辑器显示"跟随"）；保存只按草稿原样写（有值才写），不做「与 workspace 比对后删除」——那会让继承语义依赖保存路径，并破坏既有测试对显式 `cwd` 的断言。
3. **保存前校验目录**。`workspace` 非空时必须指向已存在的目录，否则 400 且不落盘；否则坏路径会在重启时让所有 Agent spawn 失败。
4. **应用内目录选择器 + reveal**。`GET /api/setup/workspace` 列目录，`POST /api/setup/workspace/reveal` 调平台文件管理器（需 `x-aichatlink-setup: 1`）。不用系统对话框：会阻塞请求、可能被遮挡、无法自动化测试。列表只读、跳过噪音目录、排序、超限截断、5s 超时。
5. **cwd 改动需要重启，且换新 native session**。原生 CLI 的 cwd 在进程启动时固定；`session-manager` 用 `binding.capabilities.cwd !== configured.cwd` 判断能否 resume，所以改 workspace 或改某个角色 cwd 后重启，该角色以新 native session 启动（AIChatLink transcript 不受影响）。这是显式取舍，不假装热生效。
6. **pi 垫片跟随房间目录**。`tools/pi-driver` 原来把每个角色的工作目录钉在 `.aichatlink/pi-roles/<role>/work`，导致 `workspace` 只改了进程 cwd、模型工具仍在私有目录干活（实测 `pwd` = 私有目录）。现改为 `options.workDir ?? role.workdir ?? <roleDir>/work`：AIChatLink 启动垫片时传 `cwd`（即解析后的 workspace），`ROLES.json` 的 `workdir` 仍是显式覆盖（相对角色目录）。配置隔离仍由 `PI_CODING_AGENT_DIR` 保证。
7. **主界面只读展示**。顶栏徽标显示 `workspaceResolved` 末两段（完整路径进 title），点击进 `/setup`；主界面不提供修改入口。

原因：用户要的是"换一个文件夹，所有人都跟着换"。把目录升到房间级，既符合 AIChatLink 的 room 模型，也让配置从 N 份重复路径收敛成一处；保留单角色覆盖是为了"某个角色单独跑另一个沙箱"的真实需求。

变更条件：若将来支持多房间/多项目，`workspace` 必须随 room 记录而不是随配置文件，并引入 room 表；本决策的 UI 也要从"房间设置"变成"项目切换"。

完成标准：`tests/unit/config.test.ts` 覆盖 Agent 与助理的继承/覆盖；`tests/unit/app/cli.test.ts` 覆盖投影、保存简写与坏 workspace 拒绝；`tests/unit/web/setup/workspace.test.ts` 覆盖列目录/跳噪/根目录/截断/reveal；两套 HTTP server 的 workspace 路由测试通过；`/setup` 可选择目录并标记跟随；主界面顶栏显示工作目录；`@` 任一 pi 角色执行 `process.cwd()` 等于房间 workspace。

## D-037：Agent 名册收敛为「计划域」，总管统筹

触发证据：用户反馈现有三个 pi 角色「不太够用」、身份"写得极差"，并要求"本项目只负责计划的提出、审查、批判、核验及最终的敲定，不负责具体计划的实施"，新增反馈「还缺少一个专门管 UI、布局、色调设计的 agent，负责宏观布局的敲定」，所以要有一个总管统筹，身份要短、通用，并结合一份思考类 Prompt 手册让分析与对冲更深入。

研究依据：角色是**命名职责**（purpose/inputs/outputs/autonomy 缺一不可；dmccreary、danielvaughan）；系统提示必须同时承担 persona、constraints、output contract（knovo、behavior.engineering）；角色名不产生约束，**约束**才产生约束（Prompt 手册反模式清单）；最小闭环是 planner / critic / verifier，评审与验证必须独立于提案视角（thenewengineer）。

决定：

1. **六个计划域角色，不含实现者**：`pi-lead` 总管（统筹 + 敲定）、`pi-architect` 提案（第一性原理）、`pi-reviewer` 审查（双向钢人）、`pi-contrarian` 批判（替代路线）、`pi-verifier` 核验（事实核查）、`pi-designer` 设计（宏观布局 / 层级 / 色调 / 可读性，用字阶、间距、对比度等可度量判据敲定）。房间不产出代码与补丁——这是产品定位，不是能力限制。
   > 后续：**D-046 把名册扩为八个**（新增 `pi-intent` 意图 / `pi-plain` 人话，补上闭环两端）；**D-047 追加 `order` 显式排序**并声明同一 Agent 可在一次任务内被多次调用。本节其余结论不变。
2. **每个身份固定四段输出契约**，并把手册方法内嵌成方法约束；身份长度控制在一屏内（每轮注入）。
3. **统一禁止项**：不写实现代码、不做写操作；核验方查不到就写"未核实"；总管不替专职作答、不产出代码。
4. **总管用 AIChatLink 的 ask 派单**，在身份里写明（不写裸 `ask`，工具暴露名由垫片决定）。
5. **停用的传统驱动条目同步重写**（codex=提案、claude=审查、grok=批判），换驱动时可直接用；原 `claude-builder`（实现者）从名册移除，与"不做实施"的定位一致。设计角色没有对应的传统驱动条目，只在计划域 pi 名册中存在。
6. **身份在 `aichatlink.json`（每轮注入），模型参数在 `tools/pi-driver/ROLES.json`**；新增角色只需 ROLES.json + `make-entries.mjs` + 一条 aichatlink.json 条目。

原因：把"提案—审查—批判—核验"拆成独立角色，比让三个角色自由发挥更能形成对抗；固定契约让多角色输出可直接拼接与对比，换模型后行为稳定。总管存在的前提是它真的去问，否则只是多一层复述。

变更条件：若引入真正的编排（Broker 按计划自动派单），总管的"派单"要迁到 Broker，身份退化为"计划与裁决"；若驱动支持结构化输出 schema，四段契约可升级为字段契约。

完成标准：`/api/health` 中 6 个 pi 角色 `ready`；`@总管` 能对一个问题分别叫提案/审查/设计并给出四段综合；各角色输出稳定落在自己的四段标题内；名册中不存在实现/施工角色。


## D-038：旧对话续聊 = 新纪元 + 只读种子；对话目录只列用户消息

触发证据：用户给出三张截图并提出两件事——①「点击左侧以往的对话应该可以直接接着进入该对话继续接着这个对话的任务完成」；②在「箭头向下到最新对话」上方加一个列表图标，「点击该图标可以快速查看本次对话我发送的所有信息和要求，点击可以快速到达指定对话位置，只要显示我的要求和发送的对话内容即可」。现状是侧栏点开旧对话只能只读回放（D-034 第 4 条），没有「继续」它；时间线也没有任何消息索引，长对话只能自己滚。

决定：

1. **续聊不新建 session 表**。一个对话仍是 `context_resets` 的一个纪元；续聊 = 在当前 high-water 写一条**带续聊种子**的 `context.reset`，把源对话的 seq 区间登记在该边界上。transcript、`seq`、`/api/events` 全部不动，也不复制消息。
2. **种子只进入 Context Packet**。`aichatlink.context/0.5` 增加 `[resumed_conversation]` 区段与 `resumed_conversation` / `resumed_range` / `resume_omitted` 协议头字段；该区段按 `seq` 重放种子区间，受同一预算裁剪并计入 usage（`resumedMessageCount`）。它不进入 delivery cursor、摘要、记忆或压缩输入。
3. **`POST /api/conversations/resume` 是唯一入口**，接受 `{ clientCommandId, conversationId, resetNativeSessions? }`：只接受已关闭对话（`active` 对话返回 `INVALID_ENVELOPE`，未知 id 返回 `UNKNOWN_TARGET`），按 `clientCommandId` 单飞并重放结果；`resetNativeSessions` 默认 `true`，避免旧 native 上下文与新纪元种子叠加两遍。
4. **链式续聊不丢源**。种子起点取源对话 `resumedFrom.fromSeq`（没有则取自己的 `startSeq`），终点取 `endSeq`；因此「A → 续 A(即 D) → 新对话 → 再续 D」仍能回到 A。代价是：若 A 与 D 之间还夹着另一个纪元 B，B 会一并进入种子与回放。取舍是「宁可多给上下文，也不让续聊在第二跳静默断链」，并在本文与 `docs/STORAGE_AND_MEMORY.md` 记录；要精确排除 B 需引入多区间种子。
5. **UI：点开是回放，发送才是续聊**。点侧栏已关闭对话 → 回放 `resumedFrom + 自身` 区间、显示 `正在查看「…」` 条与 `回到当前对话`，此时零写入；第一条消息先 resume 再 `POST /api/messages`，时间线用「以上为…历史记录」「继续自…下面是这次的新消息」两条边界区分，侧栏新纪元显示 `续自 <源对话>`。点开就静默 reset 会造出一堆空纪元，因此明确禁止。
6. **对话目录只列「我说过什么」**。浮动按钮与 `回到最新` 同形、固定在它上方；面板按发送顺序列出用户消息（两行截断 + 序号），Agent 回复/系统事件/`operator.dispatch` 不进；点击关闭面板并居中滚动 + 1.4s 高亮。**每个序号必须能跳到真实节点**：已被「收起较早消息」折叠掉的气泡不列，宁可少一条也不给死链。

原因：用户要的是「像 pi-Desktop 一样点历史就能接着说」，不是复制一份对话。D-034 的纪元投影已经带着区间，缺的只是「把区间作为新纪元起点」这一步；用种子实现，代价是一条 reset 行的三个列，而不是一张新表 + 按 session 路由 Turn。对话目录则是对现有 `state.messages` 的纯投影，不引入第二套 transcript。

变更条件：若需要按 session 路由 Turn、对话搜索/置顶/深链，或续聊必须排除中间纪元，则改为真正的 session 表与多区间种子（`resume_ranges` JSON），`resumedFrom` 投影也随之升级。

完成标准：`POST /api/conversations/resume` 只关闭对话可续、幂等、默认重置 native session；`GET /api/conversations` 的 `resumedFrom` 与 `· 续` 标题正确；Context Packet 出现 `[resumed_conversation]` 与三个协议头字段，预算不足时 `resume_omitted` 计数；侧栏点旧对话可回放并在首条消息后进入新纪元；对话目录只列用户消息且每个序号都能跳转；`npm run typecheck`、全量测试与构建通过。


## D-039：支持集合收口为 claude / codex / workbuddy / pi / grok；pi 与 WorkBuddy 升为第一方 driver

触发证据：用户明确「本系统的适配 agent 为 claude、codex、workbuddy、pi、grok，其它 agent 暂时不需要适配」，并要求专家会诊、双人刚性论证、功能测试后再验收。本机实测（2026-11-17）：pi 0.99.2 的 `--mode rpc` 可完成 `get_state` → `prompt` → `agent_settled`，并在同一 `--session-id` 上恢复上下文；WorkBuddy 桌面版 5.9.3 内置的 CodeBuddy CLI 2.165.0 的 `--acp` 只打印 `serve 0` 后退出（不可用），但 `--print --input-format stream-json --output-format stream-json` 可用；它的 `initialize` control 响应不含 `current_permission_mode`，`set_permission_mode` 在首个会话前返回 `error: "Session not found: current"`；当前未登录，真实回合返回 `result/error_during_execution`。

决定：

1. **支持集合 = codex / grok / claude / pi / workbuddy**。`BUILTIN_AGENT_IDS` 追加 `pi`、`workbuddy`；`kimi`、`hermes` **保留**在枚举、工厂与源码中，仅用于加载旧 `aichatlink.json`，引导页与文档标为 legacy。不删除的原因：已发布 0.1.16 的配置可能显式写 `driver: "kimi"`，删除枚举会让升级直接 schema 失败。
2. **pi 升为第一方 `driver: "pi"`**，入口固定 `pi --mode rpc`。适配器为每个房间 Agent 生成 `.aichatlink/pi-agents/<agent-id>/`：**只复制一个 provider** 的 `models.json`（未显式选模型时取第一个 provider 及其首个模型，绝不整份复制所有 provider 的密钥）、最小 `settings.json`、带 `exposure: "direct"` 的 AIChatLink MCP 条目；目录自带 `.gitignore`，会话关闭时删除生成的凭据副本。通过 `PI_CODING_AGENT_DIR` 注入，不写 `~/.pi/agent`。session id 由 Broker 指派（`--session-id`）；resume 前先确认 `sessions/**/*_<id>.jsonl` 存在，`get_state.messageCount=0` 视为未加载并 fail-closed。终态只认 `agent_settled`；`agent_end`（含 `willRetry`）不终结 Turn；`stopReason="error"` 一律 `TURN_INTERRUPTED` 失败；交互式 `extension_ui_request` 以 `UNEXPECTED_NATIVE_INTERACTION` 失败并 teardown。旧的 `tools/pi-driver` 垫片保留为 legacy，不再代表 pi 的协议事实。
3. **WorkBuddy 升为第一方 `driver: "workbuddy"`**，复用 Claude stream-json 适配器的执行/取消/teardown 内核，但使用独立 profile：`protocol = workbuddy-codebuddy-stream-json-v1`、`permissionModeEstablishment = "argv"`。原因：该 CLI 在首个会话前没有可用的 `set_permission_mode`；若照搬 Claude 的 control 建立路径会 100% 启动失败。unrestricted 由固定 argv `--permission-mode bypassPermissions` 请求；`initialize` 允许缺少 `current_permission_mode`（若上报了非目标值仍立即 `NATIVE_POLICY_BLOCKED`）；能力报告在首帧前只到 `advertised`，首条 `system/init` 帧复核 `session_id`/`cwd`/`permissionMode` 通过后才升为 `probed`，不一致使当前 Turn 失败。`--acp` 不作为入口：本机 lite bundle 的 ACP server 不可用，且 ACP 路线无法解释桌面版升级后的入口漂移。
4. **Claude 适配器参数化但默认行为不变**。新增 `ClaudeStreamProfile`；默认仍是 `control` 建立模式，现有 Claude 测试与 live 合同不动。同时修正 Windows 默认命令解析：先前 `findOnPath("claude")` 会命中 npm 的**无扩展名 shell 脚本**，Node 无法 spawn；现在只接受 `.exe/.com`，再依次解析 `~/.local/bin/claude.exe`、npm 包内 `bin/claude.exe`、旧版 `cli.js`。
5. **默认命令解析 fail-closed**。`resolveDefaultAgentCommand` 为 pi / workbuddy 增加显式分支；原先「未知 id 回落到 Kimi entrypoint」的三元式改为 `unsupported_driver` 错误，避免新 driver 静默绑定到别的厂商二进制。
6. **默认名册从 codex/grok/kimi 改为 codex/grok/claude**；引导页 starter 仍按 `BUILTIN_AGENT_IDS` 的探测结果生成，本机会把五个支持项自动置为启用、legacy 两项置为禁用。

原因：用户要的是「这五个能用」，不是「代码里多两个 switch 分支」。pi 的垫片虽然已实测，但它不进 npm 包（`package.json.files` 不含 `tools/`）、伪造 control 握手、并在 capability 报告里说错协议；WorkBuddy 没有垫片可用，stream-json 是它唯一可运行的第一方入口。保留 legacy 枚举是升级兼容，不是继续适配。

变更条件：若 WorkBuddy 恢复可用的 ACP server 且能稳定标识版本，可改走 ACP；若 pi 的 RPC 协议出现破坏性变更且无兼容层，pi 适配器需按版本钉住；若确认不再需要加载旧配置，可在独立变更中删除 kimi/hermes 并迁移默认值与 M0 证据。

已知边界：pi 的 `abort` 按官方文档在 session 变为 idle 后才返回，因此 timeout 路径先用 abort 换取 settle，再失败 Turn；如果某个 Native 版本在 settle 之后仍产出帧（违反自身事件契约），适配器无法从无 turn id 的 JSONL 中区分，只能靠 `firstEventMs`/`idleMs` 兜底。只发 `agent_settled` 而不发任何运行事件的回合不会被视为合法模型回合，会按超时失败。

完成标准：五项目标 driver 在 `doctor` 中可解析；`pi` 真实房间回合 + MCP `read` 实调通过；WorkBuddy 真实进程握手成功且未登录时按 `turn.failed` 收敛；Claude 回归 fixture 全绿；新增 resolver/pi/workbuddy 单测与既有 708 项测试全通过；文档与 `AGENTS.md` 的驱动集合、权限建立方式、legacy 边界同步更新。


## D-040：多工作目录 = 一目录一 runtime + hub 代理；顶栏名册与会话优先侧栏

触发证据：用户给出四张界面截图并要求——①删除顶栏三个无作用标签（实时连接 / `room:main` / 工作目录徽标）；②输入器工作目录前加「＋」图标，在应用内快速切换目录，而不是跳 `/setup`；③**多个工作目录同时运行**，允许同时推进多份计划；④把左侧 Agent 名册移到顶栏 `AIChatLink` 同一行，重启/配置改为两个小图标；⑤左侧整列让给对话，并按工作目录分组；并要求先经专家会诊定稿、再实施、再验收。现状是单 room 单 runtime，`AgentSessionManager` 以 actor 为键、配置里只有一份 workspace，换目录必须重启且旧目录的 Agent 会被一起关掉。

决定：

1. **工作目录是一等运行单元，不是配置字段的别名**。主目录仍来自 `aichatlink.json` 的 `workspace`；其他目录登记在 `<primaryStoreDir>/workspaces.json`（`version: 1`，原子 tmp+rename，上限 8）。`workspaceId = "ws_" + sha256(realpath 规范化、win32 casefold 后的路径).slice(0,12)`，因此同一目录重复添加会复用原 id 与原数据库，而不是制造第二个 runtime。该注册表就是 D-036 变更条件里说的「room 表」的最小实现；主目录仍是配置事实，额外目录才是注册表记录。
2. **一目录一完整 `AIChatLinkRuntime`，同进程运行**。派生配置：`workspace=该目录`；`cwd` 等于主 workspace 的 Agent 与 `assistant.brain` 跟随新目录，显式 `cwd` 保留；`storage.path=<primaryStoreDir>/workspaces/<wsId>/aichatlink.db`；runtime 以 `port: 0` 启动，拥有自己的 SQLite、MCP、SSE、Agent session。子 runtime 不注入 `setupApi`，也不能注册/代理其他 workspace，避免一次保存把主配置改写成派生 workspace。共享 SQLite 被明确禁止：`recoverStaleRuntimeRecords` 会把兄弟 runtime 的活 binding 标成 stale，`instance:web`/`binding:web` 也会 `STORE_CONFLICT`。
3. **hub 路由 + `?ws=` 反向代理**。主 runtime 的 HTTP server 是唯一 origin：`GET/POST /api/workspaces`、`DELETE /api/workspaces/:id`、`POST /api/workspaces/:id/restart` 只在 hub 提供；写路由要求 `x-aichatlink-setup: 1`。带 `ws` 的房间请求（含 `/api/events` SSE）由 hub 转发到子 origin 并剥掉 `ws`；主 workspace 本地服务；未知 id 404 `WORKSPACE_NOT_FOUND`；子 runtime 未 ready 503 `WORKSPACE_NOT_READY`；`/api/setup*`、`/mcp*`、`/api/runtime/shutdown` 带 `ws` 一律 404。代理流单独跟踪，不进入 `drain()` 的请求计数，避免一条 SSE 拖死优雅关闭。
4. **关闭必须级联**。hub 的 `#performClose` 在 `beginClose()` 之后、释放监听端口之前执行 `beforeClose`；supervisor 逆序关闭子 runtime（每个有界），再由主 runtime 关闭自己的 session/store。`/api/runtime/shutdown` 与 SIGINT 走同一条路；子 runtime 的 identity 不带 `runtimeScopeKey`，不能单独被控制。
5. **pi 角色目录按 workspace 隔离**。`LaunchProfile` 增加可选 `env`；AgentSessionManager、上下文摘要器、日期记忆、房间助理都把它合并到 `process.env` 之上，绝不替换整个环境。子 runtime 注入 `PI_SHIM_ROLES_ROOT=<primaryStoreDir>/workspaces/<wsId>/pi-roles`；主 runtime 不注入，保持既有 `.aichatlink/pi-roles` 行为。否则两个 workspace 会共用同一 `mcp.json` 与 `sessions/`，后启动者覆盖先启动者。
6. **切换 = 定位到 `?ws=<id>`**。EventSource、seq 游标、`conversationView`、在飞提交一次性归零，杜绝跨 workspace 状态污染；被切走的 runtime 继续在后台跑。（原文写的是「整页重载」；隔离语义不变，改为同页重建见 D-058。）左栏按 workspace 分组拉取 `/api/conversations?ws=`；点他组会话 = `?ws=<目标>&conv=<conversationId>`，加载后调用既有的只读回放；seq 空间不互通，绝不回放源 workspace 的 range。隐藏会话键改为 `<wsId>::<conversationId>`，旧的无前缀键按主目录兼容读取。
7. **界面重排**。顶栏 = 侧栏开关 / 品牌 / Agent 名册（头像、名称、状态点；hover/focus 出现 `⟳` 重启与 `⚙` 配置两个无文字图标）/ 连接点 / 公共记忆 / 助理 / 配置 / 主题。左栏只保留按目录分组的对话；公共记忆移入 `<dialog>`；输入器工作目录改成「＋ 工作目录 …」按钮，打开应用内目录选择器（已添加列表 + 逐层浏览 + 使用此目录 + 移除），新目录创建后轮询 `/api/workspaces` 直到 `ready|failed` 再跳转。连接状态改为 7px 圆点，不再占文字标签。

原因：用户要的不是「切目录时重启整个应用」，而是「同一队 Agent 在几个项目里并行推进」。把每个目录做成独立 runtime，能直接复用既有的 room/epoch/Context Packet/session 语义，代价只是多几个 SQLite 与子进程；反过来在单 runtime 内做多 room，必须重写 `AgentSessionManager` 的 actor 键、broker/context/SSE 的 roomId 与全部 epoch 投影，风险远高于收益。整页重载是最便宜的隔离边界：它把「哪些客户端状态属于哪个 workspace」这个问题直接消掉。

变更条件：若要按 session 路由 Turn、跨 workspace 搜索/置顶/拖拽会话，或需要真正的 room 表与权限边界，则把注册表迁进主库并引入 room/session 表；若崩溃隔离成为硬需求，则把 supervisor 的 `createRuntime` 工厂换成子进程实现（同一套 hub 路由与代理不变），并为子进程增加孤儿回收。若未来允许每目录不同名册，则派生配置要从「共享主名册」升级为「目录级配置覆盖」。

完成标准：`npm run typecheck`、全量测试与 `npm run build` 通过；`tests/unit/app/workspaces.test.ts` 覆盖 id 稳定/去重、派生配置不改主配置、启动失败状态、级联关闭；`tests/unit/web/server/server.test.ts` 覆盖 hub 路由鉴权、`?ws=` 转发与 `ws` 剥离、SSE 代理、404/503、子路径封锁；真实启动两个目录，各自 `pi-lead` 回答的 cwd 分别为两个目录，两侧 `PI_SHIM_ROLES_ROOT` 不同，切走再切回原目录的回合仍完成；1600/1280/430 三档无横向滚动，明暗两套可读。

## D-041：原生 pi 的每 Agent `piConfig`（默认隔离，可共享本机配置）

触发证据：用户要求「配置不要更换，就用原生 pi」——房间里跑原生 `driver: "pi"`，但 Agent 必须沿用本机
`~/.pi/agent` 的扩展、子 agent 名册与模型目录，而不是只拿到一份裁剪副本。实测（2026-11-17，pi 0.99.2）：

- 用户 `settings.json` 的 12 个 `packages` + 1 个 `extensions` 全量加载时，`pi --mode rpc` 启动即失败：
  `Failed to load extension ...pi-open-tui...: pi.registerToolRenderer is not a function`（TUI-only API）；
  仅剔除 `pi-open-tui` 后，其余 11 个包 + hindsight + `extensions/` 全部正常，`get_state`/prompt 均可用。
- 角色目录里把 `extensions/`、`agents/` 链接到用户目录后，房间 Agent 的工具清单出现 `subagent`，
  且一次真实 `subagent` 调用成功返回了子 agent 结果（scout 列出了仓库顶层目录）。
- `mcp.json` 必须保持按 Agent 生成：`X-AIChatLink-Binding` 就是 actor 溯源，共享一份会让 6 个 Agent
  共用同一个 binding。`pi-mcp-extension` 会读 `$PI_CODING_AGENT_DIR/mcp.json`，与内置 MCP 二选一，两者都能连通房间。
- `npm/` 目录 114 MB，逐角色安装既慢又占盘；链接后各角色共用同一份已安装包。

决定：

1. `agentConfigSchema` 与 `SetupAgentDraftSchema` 增加可选 `piConfig: "isolated" | "shared"`；
   未写入时读取 `AICHATLINK_PI_CONFIG`，仍未设置则 `isolated`（保持 D-039 的默认与安全边界）。
2. `shared` 只改变**能力面**：复制 `settings.json`（剔除 `pi-open-tui`）、完整 `models.json`、
   `auth.json` / `mcp-auth.json` / `models-store.json`；链接 `extensions/`、`agents/`、`skills/`、`prompts/`、
   `themes/`、`npm/`。`mcp.json` 与 `sessions/` 永远按 Agent 本地生成，`~/.pi/agent` 只读不写（`auth` 等为复制）。
3. `AICHATLINK_PI_DROP_PACKAGES` 允许追加需要剔除的包名，避免每次 pi 版本变化都要改代码。
4. `/setup` 的 Agent 卡新增「pi 配置」选择器，仅在 `driver === "pi"` 时可选；保存走同一 strict schema，
   不会因为界面往返丢字段。

原因：用户要的是「同一个 pi」，不是「同名的另一个 pi」。把 `settings/extensions/agents` 对齐后，
房间 Agent 与本地 TUI 的能力面一致（含 `subagent`），同时保留两件必须按 Agent 隔离的东西：
MCP 绑定（溯源）与会话（并发写同一 session 文件会互相破坏）。

变更条件：若 pi 提供按会话注入 MCP 的稳定入口（如 `--mcp-config`），可把 `mcp.json` 也共享，
届时 `shared` 可退化为「不设 `PI_CODING_AGENT_DIR`」；若 `pi-open-tui` 修复 RPC 兼容，可移出默认剔除集。

完成标准：`npm run build`、739 项测试通过；房间 6 个 Agent 以 `driver:"pi"` + `piConfig:"shared"` 全部 `ready`；
`agent:pi-lead` 的真实回合能报告 `subagent` 与 `mcp__aichatlink__ask` 均可用，并成功派发一次子 agent。

## D-042：侧栏选中态跟主时间线，`?conv=` 跟回放走

触发证据：用户给出截图——`?ws=ws_a0a7b35d5129&conv=conv%3Aa1` 正在查看已关闭对话「数据结构作业1-…」，左栏强调却仍停在「作业1：大数据概述」（标着 `当前`），用户描述为「深色的永远是第一个对话，切不动」。根因两条：①`.conversation-item.is-active` 直接取自 `conversation.active`（进行中的纪元），`enterConversationView()` 只改主时间线、从不更新侧栏；②`exitConversationView()` 用 `location.reload()` 退出却保留 `?conv=`，首屏 `conv` 分支立刻把同一段历史重新打开，所以「回到当前对话」与点回 `当前` 都等于原地跳一下。实测还发现第三个：`conv:<n>` 只在目录内唯一，两个目录都有 `conv:1`，按会话 id 判等会同时点亮两行。

决定：

1. **两个状态分开，各管一件事**。`is-active` = 该目录进行中的纪元（弱标记：边加深到 `--line-2`，语义交给既有 `当前 / 进行中` 文案）；`is-viewing` = 主时间线正在显示的那一段（含历史回放），是全栏唯一的强调色：`--accent` 边 + 1px `--accent` 环 + `--accent-wash` 底。其余会话行只要「和分组底、和邻行分开」：`--paper` 底 + `--line` 边，hover 到 `--paper-2`。二者同时成立（看的就是当前纪元）时，强调边框仍然只有一行。
2. **选中态跟随 `conversationView`**，无回放时退回「当前目录进行中的纪元」。`syncConversationSelection()` 只切 class / `aria-current`，不重建列表，进入回放、退出回放、续聊成新纪元各调用一次；首屏渲染时由同一判定函数给出初始态。
3. **workspace 参与判等**。选中判定同时比 `data-workspace-id`，否则另一个目录里同号的 `conv:1` 会被一起点亮。
4. **`?conv=` 与回放双向同步**：进入回放 `replaceState` 写入，退出回放 / 续聊成新纪元 / 新建对话前删除。URL 里写下的东西必须能被撤掉，否则 URL 事实源和视图事实源互相打架。

原因：用户要的是「当前主页面展示的对话加一点格外显眼的边框，其它对话只需要和背景区分」。把「正在看」与「还在写」赋予两种视觉权重，既回答了「我在看哪一段」，也不再把 `当前` 这个词当成选中语义；随后把 `conv` 参数补成可进可出，切换才真的是切换。

变更条件：若将来需要第三种状态（置顶 / 多选批量操作），先改 `docs/WEB_UI.md` 的侧栏两级视觉登记再动手；若回放改为 `pushState` 导航（浏览器前进/后退可回放），退出必须走 `history` 语义而不只是删参数。

完成标准：`npm run typecheck`、739 项测试与 `npm run build` 通过；真实实例（4310）实测四条路径——URL 直达历史、点进行中退出、点历史进入、点「回到当前对话」退出——强调边框始终唯一且随主时间线移动，另一目录同号会话不再被点亮，退出后 URL 不再带 `conv`；明暗两套确认强调环可辨（回放态截图为证）。

## D-043：删除对话 = 带确认的永久清除（取代 D-034 第 3 条）

触发证据：用户反馈两点——①左侧「×」删除不确认，确认后本机仍保存着该对话；②把某个工作目录的对话全部删除后，点该工作目录仍然跳进最后一个已删对话。核对实现：`×` 只把 `<wsId>::<conversationId>` 写进 `localStorage`，`events` 一行没删；而 `/api/bootstrap` 的 `recentEvents` 不按纪元截断，活动纪元里那段「已删」对话照旧回放，于是点目录 = 回到它。

决定：

1. **删除是销毁，且先确认**。侧栏的 `×` 改成垃圾桶图标 + `window.confirm`，文案写明「消息、回合与工具记录会从本地数据库永久删除，不能恢复；Agent 已记录的记忆不会被删除」。取消 = 不发请求，按钮不改状态。
2. **服务端在一个事务里清除一个纪元**。`POST /api/conversations/delete`（严格 `{ clientCommandId, conversationId, resetNativeSessions? }`）按 `context_resets` 投影出的 `[startSeq, endSeq]` 删除：`events`、`turns`（含由 `parent_turn_id` 派生的子回合）、`turn_attempts`、`supervision_pairs` / `supervision_pair_turns` / `supervision_steer_counts`、`agent_dated_memory_sources`（并重算 `agent_dated_memory_rollups` 的 pending 计数）、覆盖该区间的 `summaries`；把 `memory_records` / `identity_records` 的 `source_event_id` 置空，把区间外 `events.reply_to_event_id` 置空。`context_resets` 行保留：边界不重写，`conversationId=conv:<startSeq>` 不会被复用。
3. **删除活动纪元 = 先 reset 再清除**。复用 `resetNow(resetNativeSessions)` 关闭当前纪元（写 `context.reset`，必要时 `restartFresh` 全部适配器），再清除旧区间。`seq` 单调且不复用（`sqlite_sequence` 不回退），房间随后正好剩一个空的开放纪元。
4. **有在飞回合就拒绝**。`queued / dispatching / running / cancelling` 任一存在时返回 `INVALID_ENVELOPE`，UI 报错并恢复按钮；不做「删一半再收尾」。
6. **不再有本地隐藏表**。移除 `aichatlink:hidden-conversations`、`显示已隐藏` 按钮与 `.is-hidden-conversation`；`?conv=` 指向已删对话时报「该对话不存在，或已被删除」。

**（2026-11-18 变更，用户截图 `PixPin_2026-11-18_17-16-22.png`）** 本决定原第 5 条写的是「空纪元不进侧栏」。用户删光某个目录的对话后，新开一段仍显示 `对话 3`，分组头也仍写 `5 / 3`。两条原因叠加：一是当时运行中的进程早于本功能（`POST /api/conversations/delete` 返回 404），删除从未落地，那两段只是旧本地隐藏集藏起来的；二是把空纪元藏掉之后，用户反而看不到「对话 1」。现按用户明确选择改为：**空纪元显示成 `对话 N`（`N = 现存对话数 + 1`），分组头计数只算实际渲染的行，为 0 时隐藏数字**。（2026-11-19 由 D-060 修订：有历史时空纪元不再渲染；删光后仍显示 `对话 1`。）

原因：用户要的是「删除就真的删掉」，不是把对话藏起来。append-only 是对**读与回放**的承诺（不改写、不重编号），不是拒绝用户清除自己数据的理由。删除后 `seq` 留下空洞，所有游标都是 `>` 比较，因此不需要重编号，也不需要迁移。

变更条件：若将来要「回收站 / 撤销」，必须新增 tombstone 与延后清除，而不是恢复 localStorage 隐藏；若按 session 表重构，删除改为按 session 删除，本决定的表清单随之失效。

完成标准：`npm run typecheck`、全量测试与 `npm run build` 通过；单测覆盖 store 清除（`PRAGMA foreign_key_check` 为空、`integrity_check=ok`、记忆来源置空、rollup pending 重算）、broker（关闭 / 活动纪元、在飞拒绝、`clientCommandId` 幂等）、HTTP 合同与 Web schema；真实实例中确认删除后该 `events` 行消失、`/api/conversations` 不再返回该对话、点该工作目录停留在空时间线。

## D-044：输入器忙碌锁与 Agent 活动栏

触发证据：用户截图 `PixPin_2026-11-18_17-09-58.png`——6 个 Agent 已完成一轮，输入器仍是普通「发送」，
顶栏名册离输入动作太远；用户明确选择：①有任务在跑时发送键转圈**并禁用**，回合结束才可再发；
②右侧 Agent 图标可点击跳到该 Agent 最新回复并高亮；③活动栏只显示已启用 Agent。

决定：

1. **输入器改为 dock**：`.composer-dock` 宽度仍取阅读列 `--column`；左侧 `.composer` 收窄，
   右侧 `.composer-agents` 渲染 30px 头像活动栏（两排网格，列数 `ceil(N/2)`）。阅读列不变；只压缩卡片，不压缩 transcript。
2. **忙碌口径 = 当前视图的未终态 Turn**。`isRoomWorking()` 只看 `conversationView === null` 时的
   `state.turns`；不轮询 `/api/health.activeTurns`（全局数会锁住别的目录/对话）。
   `web/agent-activity.ts` 把 `completed/failed/cancelled/interrupted` 视为终态，其余（含未知状态）
   按未结束处理，fail-safe。
3. **发送键状态机**：POST 在飞或当前视图有活 Turn 时，纸飞机换成 13px 旋转环、`disabled`、
   `aria-busy=true`，`title` 说明等本轮结束。Turn 全部终态后按草稿是否为空恢复；
   Enter/`requestSubmit` 在 `submitMessage()` 内走同一守卫，状态槽给出同一文案并在解锁时自动清空。
4. **活动栏不是第二名册**：只收 `enabled && status !== "pending_restart"`；两排网格、行优先；无名字、无 driver、
   无重启/配置。工作时 `--tone` 外环旋转；点击跳到该 Agent 在本对话最新**有 DOM 节点**的回复并
   1.4s 高亮；无回复时用 `composer-status` 说明。
5. **完成点只来自 live 终态跃迁**：`acceptEnvelope(source)` 把 `live` 传给 `dispatchEnvelope`，
   bootstrap/replay 只重建卡片不点灯，否则刷新会把最近窗口里的旧完成全部标成「刚完成」。
   `completed` 用 `--accent`，`failed` 用 `--danger`，其余 `--faint`；异常终态点击优先跳 Turn 卡片。
   点图标、成功发送、换对话、`clearTimelineView()` 即清；仅内存，不写 localStorage/DB。
6. **竞态处理**：POST 202 的 `turns` 以 `seedOnly` 种进 `state.turns`，关闭 202→SSE 空窗；
   若 SSE 已推进/终态则跳过，绝不把已完成的 Turn 回退成 `queued`。终态事件本体不带
   `targetActorId`，`renderTurnEnvelope()` 复用已有 Turn 的 target，避免 `turn.interrupted`
   被记成 `system`。

原因：用户要的是「还能不能发」与「谁先完成」两个明确判断，而不是装饰。发送键回答前者，活动栏回答后者；
`state.turns` 已是三路（SSE/bootstrap/POST）维护的单一事实源，活动态只做投影，不引入第二份 Turn 状态。
这不是审批层：草稿、取消、目标选择都保留，MCP/Agent 队列能力不变。

变更条件：若真实使用证明「边跑边追加」不可缺，回滚只需让 `isRoomWorking()` 不再参与
`sendButton.disabled` 与 `submitMessage()` 守卫两处，保留转圈与活动栏；若要持久未读，必须新增
已读存储语义并把完成点从本轮提示升级为跨会话未读，届时另立决策。

完成标准：`npm run typecheck`、`npx vitest run`（753 项，含新增 `web/agent-activity` 单测）、
`npm run build` 全通过；真实实例 1600×1000 / 1280×800 / 430×900 三档无横向滚动、浮标不压活动栏；
忙碌时发送键与目标头像转圈、发送禁用、Enter 被守卫、textarea 可继续写；终态后自动解锁、
完成点点亮；点图标跳到最新回复并高亮；刷新时活 Turn 继续锁、已完成历史不点灯；历史回放不锁输入器。

## D-045：dock 的宽度预算与 `＋ 工作目录` 的降级顺序

触发证据：用户截图 `PixPin_2026-11-18_18-01-04.png`（1280×800 实窗口）——输入器被右侧活动栏压窄，
操作条上只剩「发送给 @all | 上下文 | 压缩会话 | 发送」，工作目录按钮整块不见了，用户问「我的打开文件夹（工作目录）呢」，
并要求「对话框往左边拉伸一点」。核对实现：`.composer-dock` 仍取 `var(--column)`，于是活动栏的 116px
（6 个 Agent = 3×2 两排）全部从卡片里扣：1280×800 下卡片 768px；而 `@container (max-width: 800px)` 直接
`display:none` 掉 `.composer-workspace`，与 `docs/WEB_UI.md` 早已写明的「`＋` 始终保留」互相矛盾——
文档描述的是分级让步，代码实现的是整块删除。

决定：

1. **宽度预算记在面板边距上，不从卡片里扣**。`.app-shell` 新增 `--column-max: 1040px`；`.composer-dock`
   宽度改为 `min(var(--column-max), calc(100% - 48px))`。列宽被压缩（面板 < 1088px）时 dock 改用 24px
   外边距，卡片因此向左（并向右）各长 24px，而不是继续等比例缩窄；面板 ≥ 1088px 时与 `var(--column)` 完全等价，
   1600×1000 布局一字不变。副作用：卡片可以比消息列宽出至多 24px/侧，这是有意的——阅读列是消息的度量，
   不是输入器的上限。
2. **`＋ 工作目录` 按部件降级，永不整块隐藏**。≤860 隐藏 meter（原有）；≤800 隐藏路径文字；
   ≤700 隐藏「工作目录」标签并收成 24px 圆形加号（与 ≤760px 视口规则同形）；≤560 隐藏上下文估算（原有）。
   `updateComposerWorkspace()` 同时写 `aria-label`，因为标签和路径都可能不可见。
3. **活动栏位置不变**。仍在卡片右侧；`@container room (max-width: 900px)` 的纵向堆叠不变。

原因：活动栏是「谁在跑」的投影，工作目录切换器是导航入口；前者可以牺牲输入器的一点点宽度，但不能把后者挤出操作条。
两边都靠 container query 决定，所以修复必须落在同一个坐标系里（卡片内联宽度），而不是视口宽度——这正是原来
移动端规则能显示圆形加号、宽屏窄卡片却整块消失的原因。

变更条件：若用户要求卡片与消息列严格同宽（884px @1280），改为在 `@container room (max-width: 1136px)`
把活动栏落到卡片下方、dock 回到 `var(--column)`；这会把「谁在跑」从操作条同行移走，需重新验收 `timeline-actions` 几何。

完成标准：`npm run typecheck`、`npm run build` 通过；1280×800 实测卡片 816px、`＋ 工作目录` 可见、
路径已折叠、无横向滚动；1600×1000 与改动前逐像素一致；900/760/560 三档仍能看到 24px 圆形加号且 `aria-label` 非空。

## D-045：多窗格 = 同一实时状态的多个镜片投影

触发证据：用户截图 `PixPin_2026-11-18_18-05-39.png`——一个房间、6 个 Agent、一条阅读列；用户描述
「多 Agent 同时工作时不方便同时观看，因为一个对话会不断往上滚动对话历史」，并要求参考 Cherry Studio
的「多窗口并列 / 四方格」。核对实现：`/` 只有一条 EventSource、一份 `state`、一个 `#timeline`；
`@all` 的 6 路 `turn.content.delta` 交错追加，`appendTimeline()` 每次都贴底，盯住 A 会被 B 的增量顶走。
横向事实：Cherry Studio 2.x 的多窗口是**多个独立 App 实例**（Electron 窗口/标签），其仓库 issue #15258
（Agent 模式多会话平铺）关闭未做；Sideview 最多 4 个对话并列、Plexus 最多 6 个会话并列并建议
「同一会话看两个 Agent 就拆 Agents 标签」。结论：并列是观测需求，粒度由拓扑决定；本仓库最自然的粒度是
**会话内的 Agent 车道**，跨目录交给浏览器窗口。

决定：

1. **一个页面仍是一条 SSE、一份 `state`、一个活纪元。** 窗格是只读投影（镜片 `room` 或
   `agent:<actorId>`），不新增网络连接、不新增 Turn 状态、不新增输入器、不新增审批/权限/协议/存储。
2. **窗格数量 1/2/3/4/5/6，六轨 grid + 跨列计划**：`[6]` / `[3,3]` / `[3,3,6]` / `[3,3,3,3]` /
   `[2,2,2,3,3]` / `[2,2,2,2,2,2]`。列数只由窗格数决定（`paneColumns`），不按宽度猜。
3. **渲染上下文可变。** `PaneContext` 持有 `timeline`、四张节点表、follower、trim/date/jump 标量；
   `usePaneContext()` 切换模块级别名（渲染函数体不改算法）。dispatch 分两层：
   **全局副作用只跑一次**（`state.messages`、`trackTurnEnvelope()` 的 `state.turns` / 完成跃迁 / 终态 delta 清理、
   活动栏、记忆列表、未读、`context.reset`、session 事件），再逐格 `lensAccepts()` + `paintEnvelope()`；结束后恢复主格。
   Turn 状态必须属于全局层：4 个窗格全是 Agent 车道时，未上屏的 Turn 仍要进入忙碌锁与活动栏。
4. **车道过滤按 target 而不是按 sender。** 终态事件不带 `targetActorId`、`turn.interrupted` 的 actor 是
   `system`；`resolveTurnTarget()` 依次取 `body.targetActorId` → `state.turns` → `envelope.to` → actor。
   车道收：用户消息 + 本 Agent 的 `turn.*` / delta / `tool.progress*`；不收其他 Agent、监督、助理派活、
   记忆活动、session。用户消息在车道折叠为一行 `<details>`（全文 + 回复/复制在展开态）。
5. **回填日志有界 300 条**（只存可见、非 delta 的 `{envelope, targetActorId}`）。新建窗格、切镜片、
   1→4/6 格时按日志重放；每格 DOM 仍按 500 条裁剪。日志丢的只是「新建窗格能回看多早」，
   不影响任何格的实时增量。
6. **持久化 `localStorage["aichatlink:panes"]`**。解析失败/越界夹到 1..6 并补 `room`；`renderAgents()` 后对账：
   名册里不存在的 Agent **回落 `room` 并写回**，已停用的保留（可看历史输出）。不写 URL/DB/配置。
7. **基线零回归。** `count === 1 && lens === room` → `html[data-panes="single-room"]`：窗格头与格线隐藏，
   既有 `#timeline-actions`（对话目录 + 浮标）与 composer 几何不变。其余模式隐藏既有浮标栈，
   每格头部 `↓ N` 接管。
8. **滚动：每格独立 follower；多格下取消「滚回底部自动恢复跟随」。** 实测 4 格时，程序化跟随产生的
   延迟 `scroll` 事件会在用户 wheel 暂停之后到达，`isNearBottom()` 为真 → `resume(false)`，把阅读中的格子
   重新贴底。暂停后只通过该格 `↓` 或自己发送恢复；自己发送只恢复主格。这是对 WEB_UI §九 的一次修订。
9. **不做跨 workspace / 跨对话同屏。** 一页只有一个活纪元与一条 seq 游标（D-040 的整页重载语义）。
   跨目录用浏览器窗口（每窗口天然一条 SSE，仍在 HTTP/1.1 同源 6 连接预算内），对话框提供
   「在新窗口打开当前目录」。

被否决的方案：

| 方案 | 否决理由 |
| :--- | :--- |
| 每格一个 `<iframe src="/?ws=…">` | 每格 = 一个完整 App = 一条**永久 SSE**；4 格 5 条、6 格 7 条，超过 HTTP/1.1 同源 6 连接上限，后续 `/api/messages` 会排队超时；Node `http` 无 HTTP/2 |
| 每格一个 `AIChatLinkRuntime` | 4 个 runtime × 6 个 native CLI = 24 个会话；内存/端口/启动时间与「同房间 6 Agent」语义都不成立 |
| 把 6 个 Agent 拆成 6 个对话 | 破坏 D-009 的同房间并行、`@all`、监督配对与共享上下文 |
| 只加 CSS `column-count` | 列按 DOM 顺序均衡，不按 actor 归类，交错问题原样保留 |
| 每格第二个输入器 / 第二份 Turn 状态 | 忙碌锁与目标选择会出现 N 份，违反 D-044 的单一事实源 |

原因：用户要的是「同时看每个 Agent 在干什么」，不是「同时开 N 个房间」。在房间拓扑下，
一条 SSE + 一份 state + N 个投影既满足观测，又不把网络、进程、锁成倍放大；跨目录的窗口需求由浏览器
窗口正交满足。

变更条件：若将来 `web/server` 支持 HTTP/2，或 SSE 改为单连接多路复用（一条流携带多个 workspace），
可重新评估 iframe/跨目录窗格；若要窗格内分别发送，必须先改 D-044 的单一忙碌锁语义并重新验收；
若要「拖动分隔条 / 窗格最大化」，需要新增每格像素比例与布局栈，不能复用本次的 count+span 方案。

完成标准：`npm run typecheck`、`npx vitest run`（763 项，含新增 `web/pane-lens` 10 项）、`npm run build`
全通过；`/pane-lens.js`、`/pane-view.js` 200；真实实例（4311，6 个 pi Agent）4 格 + 3 Agent 真实回合
车道过滤精确、忙碌锁一次解锁；暂停车道在别人增长时 `scrollTop` 不变且 `↓` 角标计数、点击回底；
1/4/5/6 格在 1600/1280 的 span 与 rect 符合 D-045；430 单列无横向滚动；`context.reset` 清空所有格；
`?conv=` 4 格回放不锁输入器；名册缺失 Agent 回落 room 并写回；基线单格截图与 D-044 一致。

## D-046：名册 6 → 8，新增「意图」与「人话」两个非工程角色

触发证据：用户截图 `PixPin_2026-11-18_21-49-52.png`——顶栏与活动栏仍是 6 个席位，用户指出
「怎么才六个 agent」。此前的两个失效是真实发生的：① 用户只看得到**上一轮输出**，基于片面结果与当下
情绪指挥总管，导致返工；② Agent 收尾陈列术语与判据矩阵，用户读不懂，也无法判断「离目标还差多远」。
核对实现：闭环中间七道门（定标 → 会诊 → 派单 → 钢人 → 验证 → 判定）做得极严，但**两端敞开**——
定标直接假定用户已给出可度量目标，判定结束后无人负责翻译。

决定：

1. **名册由 6 增至 8**，新增 `pi-intent`（意图，`newapi/claude-opus-4-6`）与 `pi-plain`
   （人话，`newapi/gemini-3.8-flash`）。两者仍是**计划域角色**：不写实现代码、不做写操作、不产出补丁。
2. **意图在定标之前**，且不是「再写一份需求」，而是**只把真正需要拍板的点问出来**：
   硬上限 5 问、**每轮只问 1 个**、每问 2–3 个带后果的选项；只有同时满足「阻断（贴得出被阻塞的
   判据编号）/ 不可推定（已检索且两候选生成不同检查命令）/ 属用户所有」才配占用提问预算；
   命名、目录、库选型、实现顺序属工程内部，一律自决。目标已可度量时直接放行，不许为表演价值问诊。
3. **人话在判定之后**，只换表达不换事实：首行给判定并**带缺口计数**（否则用户会在「能用」处停读）；
   三档刻度只选一，禁用「基本 / 大部分 / 差不多」；`FAIL` 与 `NOT TESTED` 必须原样出现（**坏消息守恒**）；
   行号必须能核，找不到的行号等于编造；正文 ≤24 行。
4. **窗格上限 `MAX_PANES` 6 → 8**，六轨不变，新增排布：
   `7 → [2,2,2,2,2,2,6]`、`8 → [2,2,2,2,2,2,3,3]`（两者合计都是 18 = 3 整行）；
   布局对话框新增「全员八格」，原「全员六格」改称「六格」——否则第八个席位在监视墙上不可见。
5. **总管身份注入路由与反向条款**：说不清→意图，听不懂→人话；含糊输入先派意图，
   它每轮只问一个、总管**原样转发且不许合并成问卷**；收尾必须派人话、正文原样给用户、
   **不许在其后追加术语矩阵**。用户说「别问了」→ 记 `SKIPPED-BY-USER` 并开工；
   说「别总结了」→ 可跳过，但不许因此把失败项写成完成。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 把两人折叠进总管的 identity | 自问自答：定标者同时充当被判定者，与 G5/G6「执行者不等于判定者」是同一失效 |
| 只加配置、不改窗格上限 | 第八个席位在 `MAX_PANES=6` 下进不了监视墙，只能靠单窗格轮流看，等于没加 |
| 把两人各开一个独立对话 | 破坏 D-009 的同房间并行与共享上下文，用户又回到「不知道去哪个窗口看」 |
| 让意图一次抛出完整问卷 | 用户会敷衍（「都行」「你看着办」），提问变成走过场；一次一问才能让每个选项真正被权衡 |

原因：用户缺的不是更多工序，是**两端**。入口缺一次把大白话翻译成可验收判据的动作，
出口缺一次把判据翻译回人话的动作；中间工艺再严，两端不通就是「工艺闭环、用户未闭环」。

变更条件：若意图的单轮提问在真实使用中仍被跳过超过一半（以 `SKIPPED-BY-USER` 台账计），
应改为「默认放行 + 只在涉红线歧义时提问」；若人话开始出现改写判定或美化失败，
应剥掉它读证据的权限，退回纯转述。若将来房间超过 8 个席位，需先补轨道方案再调 `MAX_PANES`。

完成标准：`npm run typecheck`、`npx vitest run`（769 项，含 `pane-lens` 的 1..8 排布断言与
`empty-voice` 的 8 个角色台词）、`npm run build` 全通过；`/web/index.html` 含「全员八格」；
重启后 `/api/bootstrap` 的 8 个启用角色全部 `ready`，顶栏名册与活动栏各 8 项，
8 格在 1280 宽度下 span 合计为 3 整行且无横向滚动。

## D-047：名册显式排序，且「一人一次」不是派单规则

触发证据：用户要求 8 个席位按「意图 → 总管 → 提案 → 审查 → 核验 → 批判 → 设计 → 人话」排列；
并指出「每个 agent 可以调用多次，总管可以调用、指派全部 agent，提案/审查/核验/批判/人话等一次任务
完成可能涉及多次调用」。核对实现：名册与活动栏都按 `actorId` 字母序排（`orderedAgents()`），
所以 8 席呈现为 提案/批判/设计/意图/总管/人话/审查/核验，与工作顺序无关；
而多次调用**已经**可行（`limits.actorCallsPerRoot` 默认 16、`hopCount` 24），缺的是协议语言——
总管身份未声明可重复派同一个人，实际会按「一人一次」行事。

决定：

1. **排序由 `aichatlink.json` 的显式 `order` 决定**（整数，0–9999）：配置 → bootstrap 投影 →
   `compareRosterOrder`。未设 `order` 的角色排在有序角色之后，仍按 `actorId`，兼容旧配置。
   排序**只影响呈现**：派单、`@all`、ask 工具与限流都不看它。
2. **`order` 随 `/setup` 保存原样往返**：`AgentDraft` 透传该字段，不让一次设置页保存把顺序抹掉。
3. **重复调用写进总管身份**：声明「同一任务可以多次调用同一个 Agent，一人一次不是规则」，
   并给出典型往返（提案出两版 → 审查各审一遍 → 核验挑事实 → 批判给替代路线 → 设计落版式 → 人话收尾）；
   每次复叫必须写清「这次要它解决什么新问题」，禁止原封不动重发上一轮问句；
   派单段需标「对该 Agent 的第几次调用」，让往返是否必要可复盘。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 改 actorId 让字母序恰好对上 | id 是 actor 溯源与历史事件的一部分，为排序改名会断裂已有记录 |
| 在 UI 里硬编码角色顺序表 | 配置驱动失效；新增或改名一个角色就要改代码，与 D-046 的名册机制矛盾 |
| 把 `order` 当成派单优先级 | 会被误读为「不叫低序角色」，而实际语义是纯展示 |
| 用 `limits` 抬升调次上限来「支持多次」 | 默认 16/24 已经足够，抬上限只增加失控风险，不解决协议未声明的问题 |

原因：顺序是给人看的认知脚手架（入口 → 统筹 → 出方案 → 挑错 → 核事实 → 对冲 → 版式 → 说人话），
调次是任务拓扑的必然结果（同一人看到新证据就该再审一次）。两件事都不应改变房间的并发与配额语义。

变更条件：若将来需要每个工作区（workspace）各自的顺序，需把 `order` 从 agent 配置移到 workspace 级，
并处理「同一 Agent 在不同工作区不同位置」的呈现；若 `order` 重复，按 `actorId` 打破平局，不报错。

完成标准：`npm run typecheck`、`npx vitest run`（772 项，含 `agent-roster` 的 3 项排序断言）、
`npm run build` 全通过；重启后顶栏与活动栏均为意图/总管/提案/审查/核验/批判/设计/人话；
`/api/bootstrap` 的 agents 带上 `order`；`/setup` 保存后 `aichatlink.json` 的 `order` 不丢。

## D-048：显示尺度 = 一个设计像素 `--px` + 根字号斜坡

触发证据：2026-11-19 用户换到台式机大屏后反馈「对话框，右侧图标明显有点小了」。
核对实现：`--rail-w: 72px`、`--sidebar-w: 296px`、`--column-max: 1040px`、活动栏格子 30px、
顶栏 `.icon-action` 30px、`.send-button` 30px、`.composer textarea` 48px/240px 全是绝对 px；
`--fs-*` 是 `rem`（跟根字号），而根字号一直是浏览器默认的 16px；12 条 `@media`/`@container`
没有一条在 >1600px 时动作。实测（无头 Chrome）：1600 与 2560 两档的根字号、格子、列宽完全相同。

决定：

1. **一条原语 `--px: 0.0625rem`（一个设计像素）**。`tokens.css` 的 `--s-*`/`--r-*` 与 `styles.css`/
   `setup.css` 的骨架几何（顶栏 56、侧栏 296、阅读列 1040、活动栏 30、`.icon-action` 30、
   `.actor-avatar` 30/36、`.floating-action` 34、`.send-button` 30、文本域 48/240、对话框 620/720/760、
   助理抽屉 380）一律改写为 `calc(N * var(--px))`。字与几何因此共用同一乘数。
2. **根字号 `clamp(1rem, calc(1rem + (100vw - 1600px) / 300), 1.4rem)`**。≤1600px 恒 1×；
   1920 ≈ 1.067×；2560 = 1.2×；≥3520 封顶 1.4×（3840 时正文 22.4px）。
   基准取 `1rem` 而不是裸 `vw`：系统/浏览器字号设置必须继续生效（WCAG 2.2 SC 1.4.4 / F94）。
3. **不缩放**：`1px` 发丝线、`--shadow-*`、`@media`/`@container` 断点、`--r-pill`。
   发丝线乘 1.2 会发糊；断点必须继续表示窗口宽度，而不是 UI 宽度。
4. **JS 同乘数**：`designPx(n)` 用于文本域自增高上限（原写死 180px，与 CSS 的 240px 互相矛盾）
   与浮标几何边距；活动栏列数改由 CSS 变量 `--rail-cols` 决定，列宽 `--rail-cell`，
   不再由 `renderComposerAgents()` 写死 `repeat(k, 30px)`。
5. **不给「界面大小」开关**：浏览器缩放与系统字号已覆盖个体差异（§WEB_UI 十四.2），
   新增常驻控件会与「不设无决策常驻控件」冲突。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| `body { zoom: 1.2 }` | 与 `position: fixed`、`dvh`、`vw` 交互不可预测，文字栅格化质量下降 |
| 全量 sed 把 px 换成 calc | 554 处含 1px 发丝线与阴影，会把清晰边框变成 1.2px 糊边 |
| 把断点也乘尺度 | 用户对「窗口多宽」的心智模型被打乱，2560 会出现笔记本上看不到的折叠 |
| 只用 `vw` 定字号 | 违反 WCAG F94：用户字号设置失效 |
| 加「小/标准/大」开关 | 自动适配变成「你自己调」的借口；逃生口已存在（浏览器缩放） |

原因：这是「呈现层按笔记本毫米写死」的缺口，不是某个控件的 bug。修在尺度层，一处参数决定全站；
修在控件层就要逐个记住「这个也放大」，下一个新控件立刻复发。

变更条件：若真实使用仍觉偏小，只调斜率分母（300 → 220 时 2560 为 1.27×），不重做机制；
若 `1rem` 基准在某个环境不跟随系统字号，根字号改为 `calc(100% + (100vw - 1600px) / 300)`。

完成标准：`npm run typecheck`、`npx vitest run` 全通过；`npm run build` 通过；
1280×800 / 1600×1000 / 430×900 三档截图与改动前**逐像素一致**（PNG md5 相同）；
1920/2560 两档按上表增长且 `scrollWidth == clientWidth`；`/setup` 同尺度、无横向滚动。

## D-049：活动栏工作环挂在共享账本上，并在 reduced-motion 下改为降速

触发证据：2026-11-19 用户反馈「完成会话的时候右侧的 8 个小图标也不转动了」，且症状随换机出现。
审计发现**两个互相独立的成因**，任一单独成立都会让环不转：

1. **漏同步**：`trackTurnEnvelope()` 的注释写着「否则忙碌锁与活动栏会漏掉」，但函数体只在
   `isFinishedTransition`（活→终态）分支里调 `syncAgentActivity()`；另一条同步路径在
   `renderTurn()` 末尾，而 `renderTurn()` 只在**有窗格接受该 Turn** 时执行
   （`lensAccepts()` 对 `turn.*` 按 `targetActorId === lens.actorId` 过滤）。
   实测复现：两个 Agent 车道窗格 + 一个没有窗格的 Agent 收到 `turn.queued` → 该 Agent 的
   `data-working` 停在 `false`（卡片数 0，账本已更新）。
2. **动画被全局重置**：`tokens.css` 的 reduce 块是 `*` 级 `animation-duration: 0.01ms !important`
   + `animation-iteration-count: 1 !important`，`styles.css` 里那条 `animation: none` 只是第二道。
   Windows 11「辅助功能 → 视觉效果 → 动画效果」关闭即让 Chromium 报
   `prefers-reduced-motion: reduce`，于是环只跑 0.01ms 一次 = 看起来完全静止。
   实测（无头 Chrome，`emulateMedia({reducedMotion:'reduce'})`）：修复前环的
   `animation-duration` 为 `1e-05s`、`iteration-count` 为 `1`。

决定：

1. **同步点下移到共享账本**：`trackTurnEnvelope()` 末尾无条件调 `syncAgentActivity()`，
   `renderTurn()` 里的调用保留（幂等）。窗格接不接这个 Turn 不再影响活动栏与忙碌锁。
2. **工作环豁免全局 reduce 重置**：在 `tokens.css` 的重置块内紧跟着写豁免，
   `animation-duration: var(--dur-busy) !important`（2400ms）+ `infinite !important`；
   `--dur-busy` 定义在 `:root`。`styles.css` 不再重复声明，只留一句指向注释。
   理由：MDN 对 `prefers-reduced-motion` 的契约是「移除、减少或替换」，不是必须静止；
   13px 进度环是**活信号**（冻结会被读成控件卡死），且同一事实另有 `aria-busy`、`title`、
   完成点三条非动画通道。这是**有意偏离**「reduce = 不动」，登记在此以便复核。
3. **看门狗**：`syncAgentActivity()` 末尾若「有在跑的 eligible Agent」但轨道里没有任何
   `data-working="true"`，写一条 `console.warn`（不持久化、不进 UI）。正确实现下不可达，
   它只负责让同类缺陷以第三种形态复发时立刻可见。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 只修 `styles.css` 的 `animation: none` | 打不过 `tokens.css` 的 `*` + `!important`（本次实测确认） |
| 直接删掉全局 reduce 重置 | 会连带放开所有过渡与装饰动画，违反对前庭敏感用户的承诺 |
| reduce 下彻底不动 + 只靠 `title` | 用户失去唯一「还在跑」的视觉信号；`title` 要悬停才可见 |
| 用 JS `element.animate()` 绕过 CSS 媒体查询 | 引入第二套动画系统，与令牌/主题脱节 |

原因：活动栏回答「谁还在跑」。这个判断必须由 `state.turns` 直接投影，不能依赖「碰巧有窗格画了它」；
而「在跑」的视觉表达必须在任何系统动效设置下都成立，否则同一句注释会第三次只实现一半。

变更条件：若将来引入 `prefers-reduced-motion: reduce` 之外的无障碍模式（如强制对比度），
同样按「降速不删除」处理；若看门狗在真实使用中被触发，说明有第三处 Turn 来源绕过了
`trackTurnEnvelope()`，应先补同步点而不是放宽看门狗。

完成标准：`npm run typecheck`、`npx vitest run` 全通过；`npm run build` 通过；无头 Chrome 探针：
两个 Agent 车道窗格 + 无窗格 Agent 的 `turn.queued` → 该 Agent `data-working="true"`（修前为 `false`）；
`emulateMedia(reducedMotion:'reduce')` 下环 `animation-duration` 为 `2.4s`、`iteration-count: infinite`、
`getAnimations()` 有 1 条 `running`；`.send-spinner` 同为 2.4s。

## D-050：忙碌的发送键就是终止键（取代 D-044 第 3 条的「禁用」）

触发证据：2026-11-19 用户要求「完成对话时发送按键变成了转圈，我希望点击转圈后代表用户要终止此次任务，
立刻终止所有 agent 的工作」。D-044 第 3 条把「转圈并 `disabled`」写成了决策，因此这里显式取代该条，
D-044 的其余部分（忙碌口径 = 当前视图未终态 Turn、活动栏不是第二名册、完成点只来自 live 跃迁、
`state.turns` 单一事实源）全部保留。

决定：

1. **一个按钮，两种模式**：`web/composer-state.ts` 的纯函数 `sendButtonState()` 决定
   `send | stop | blocked`，DOM 只做投影（`data-mode`、`label`、`title`、`aria-label`、`aria-busy`）。
   `stop` 模式**可点且不禁用**，`aria-busy=false`（它是可操作的，不是阻塞的）。
2. **点击 = 终止当前对话里全部未终态 Turn**：`cancellableTurnIds(state.turns.values())` 过滤掉
   终态与已 `cancel_requested` 的 Turn，再并行逐 Turn 发既有 `POST /api/turns/:id/cancel`，
   每条带自己的 `clientCommandId`（`cancel:<turnId>`）。**不新增端点**：Broker 的 `cancelTurn`
   本身就是逐 Turn 幂等命令，批量端点只会多一层「部分成功」语义。
3. **Enter 不终止**：终止只绑在 `sendButton` 的 `click` 上并 `preventDefault()`；`submit` 事件
   仍走 `submitMessage()` 的原守卫（忙碌时只给文案）。忙碌时误按 Enter 不得终止 8 个 Agent。
4. **终止中与重复点击**：扇出期间 `stopping=true` 暂时禁用；扇出结束后若仍有未终态 Turn，
   按钮回到可点状态，但所有 Turn 已 `cancel_requested`，再点只会给出「已请求终止，等待 Agent 收尾」，
   不发第二条命令（幂等靠 `cancellableTurnIds()` + Broker 的 `(bindingId, clientCommandId)` receipt）。
5. **失败可见且可重试**：N 条失败折成一句「N 个取消失败：<code>；可再次点击重试」，走 `is-error`
   （输入变化才清）；成功的确认语在按钮离开 `stop` 模式时自动清空。
6. **不自动补发、不审批**：`turn.cancelled` 后不重放 prompt（不变量 14），终止前不弹确认框，
   卡片级「取消」按钮保留（单 Turn 粒度仍然存在）。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 新增 `POST /api/turns/cancel-all` | 多一层部分成功语义；逐 Turn 幂等命令已足够，且离线重放更简单 |
| 在 `submitMessage()` 里做终止 | 忙碌时按 Enter 会连坐终止全部 Agent |
| 忙碌时保留禁用，另加一个「停止」按钮 | 用户明确要求点转圈；两个并列控件会让操作条更挤 |
| 终止前弹 `confirm` | 终止可恢复（Turn 记 `cancelled`，消息可重发），与「无审批层」冲突 |
| 乐观把 Turn 标成 `cancelled` | 终态必须由 Broker/native 事件决定，否则会出现「UI 已停、进程还在跑」 |
| 用 `conversationView !== null` 也允许终止 | 历史回放里没有活 Turn，且 `isRoomWorking()` 已排除该场景 |

原因：忙碌态的手势语义应该是「我不要再等了」，而不是「请告诉我不能做任何事」。把同一个控件从
状态变成命令，用户不必先把视线移到卡片去找「取消」，也不必逐个点 8 次。

变更条件：若用户实际想要「只终止我刚发的那一轮」，改为按 `correlationId` 过滤（`cancellableTurnIds`
加一个谓词即可，逻辑集中在一处）；若将来 Broker 提供批量取消且能返回逐 Turn 结果，可替换扇出，
但必须保留相同的逐 Turn 幂等与错误聚合；若引入 `Esc` 快捷键，必须先解决输入法组合态与草稿场景。

完成标准：`npm run typecheck`、`npx vitest run`（含新增 `composer-state` 8 项与
`agent-activity` 的 `cancellableTurnIds` 4 项）、`npm run build` 全通过；无头 Chrome 探针
（`web/` 静态桩，不入库）：3 个在飞 Turn 时按钮 `data-mode=stop` 且可点、文案「终止」、
`aria-label` 含「终止全部 3 个 Agent」；点击后恰好 3 条 `POST /api/turns/<id>/cancel` 且
`clientCommandId` 互不相同；再点一次命令数仍为 3；忙碌时按 Enter 产生 0 条取消请求；
全部终态后按钮回到「发送」/`blocked` 且状态槽清空。

## D-052：终止是「改完再来」的入口——原任务回填输入框并复用一个回复链

触发证据：用户澄清需求「转圈代表正在运行任务和对话，我需要的是转圈的时候我如果觉得这次任务发错了，
或者需要补充，可以点击正在转圈的发送按键进行停止此次任务，要求补充完整后再发送继续完成任务」。
D-050 只做到「停」，停下之后输入框是空的：用户要改一句话必须先翻回上面复制原文，或者凭记忆重打；
「停了但没法接着改」不是一个闭环。

决定：

1. **停止成功后把这条 prompt 放回输入器**：`planResumeAfterStop()`（`web/composer-state.ts` 纯函数）
   从被取消 Turn 的 `correlationId` 反查当前纪元里**由用户发出、且属于这些 correlation 的最新一条**
   `message.created`，把它的原文填回 `#message-input`，光标置于末尾，并同步 `saveDraft()` /
   字数统计 / 自适应高度。**不自动发送**。
2. **追发挂成回复**：同时把 `replyToEventId` 指向那条原消息，于是 Agent 看到的是「我在修正/补充上一条」，
   而不是一个无关的新任务；回复链沿用既有 `reply-reference` 芯片，用户可一键清除。
3. **永不覆盖正在打的草稿**：若输入器已有非空草稿，只提示「已终止；你的草稿已保留」，不动内容、不加回复链
   （纯函数返回 `kept-draft`，由调用方分支）。
4. **找不到就直说**：若原 prompt 已不在当前视图（换了对话、做过 reset），返回 `no-message` 并只给终止确认，
   绝不回填一条不相干的消息。
5. **不引入「暂停态」**：Turn 的终态仍然是 `cancelled`，原生 session 保持可用（D-050 / G-016），
   所以下一次发送天然接着同一个 Agent 会话继续；AIChatLink 不新增 paused/waiting 存储字段。
6. 重复点击停止（所有 Turn 已 `cancel_requested`）不再触发回填，避免把用户正在改的内容再覆盖一次。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 停止后自动把原文本重新发送给同一批 Agent | 等于「用户没改就重放」，与不变量 14 及「显式命令」相悖 |
| 停止后直接清空并让用户重打 | 用户原话是「补充完整后继续」，清空等于让他重写一遍 |
| 引入 paused Turn + 恢复接口 | 需要新的持久状态与 native 恢复语义；取消 + 新 Turn 已能表达同一意图 |
| 回填时连 target 选择一起重置 | 目标选择本来就保留在输入器上，重置反而会让人多发/漏发 |
| 覆盖已有草稿 | 会吃掉用户已经写的内容，属数据丢失型交互 |

原因：「发错了」是操作员最常见的纠错场景，闭环应该是「停 → 改 → 再发」，而不是「停 → 重新回忆原文」。
把原文本与回复链一起接上，也让房间里的其他 Agent 读到正确的因果关系。

变更条件：若真实使用中回填被视为干扰（用户在停止后更想直接说新任务），把它降级为状态行里的一个
「取回上一条」按钮；若将来支持 Turn 级「暂停/继续」的 native 语义，可把本条改为复用该语义。

完成标准：`npm run typecheck`、`npx vitest run`（含 `planResumeAfterStop` 5 项）通过；
无头 Chrome 探针：发出「把发布说明按上周的格式重写一遍」并让 3 个 Agent 进入在飞状态 → 点终止后
输入器内容等于原文、`#reply-context` 可见且指向该消息、字数统计为 15、状态行为
「已终止；原任务已放回输入框，补充后可直接发送」；已有草稿时点终止则草稿一字不改。

## D-053：转圈只表示「现在真的有任务在跑」，终止被受理即释放

触发证据：2026-11-19 用户截图（`PixPin_2026-11-19_11-12-21.png`）——房间已空闲、
时间线全是「已完成」，输入器空草稿，发送键却是灰底 + 旋转环，而且一直转。
用户的原话：「转圈代表真的有任务在完成才会转圈……不是让你一直转圈。逻辑要合理啊？」

核对实现后发现**两个**错误，都属于「环的含义被稀释」：

1. `syncSendButton()` 写的是 `classList.toggle("is-working", next.mode !== "send")`：
   空草稿的 `blocked`（禁用发送）也被当成 busy，纸飞机被换成旋转环，于是**空闲页面永久转圈**。
   实测：`mode=blocked, disabled=true` 时 `is-working` 仍在、`.send-spinner` `display:block`
   且 `getAnimations()` 有 1 条 running。
2. 点了终止之后，Turn 在 store 里仍是 `cancel_requested`（要等 native 侧收敛），
   而忙碌口径把它算作在飞，于是**用户已经喊停，环还在转、发送还锁着**——这与「我停了它」
   的直觉相反，也堵住了 D-052 的「改完再发」。

决定：

1. **`spinning` 是状态机的显式字段**，不再由 CSS 类名推断：`send | blocked` 一律「纸飞机」，
   只有 `stop`（真有 Turn 在飞）与 `submitting`（POST 在途）为 `true`。
   空草稿的禁用态**永远是纸飞机**：禁用 ≠ 忙碌。
2. **`releasedTurnIds`：取消被受理即释放**。`requestTurnCancel()` 在 Broker 接受
   （`ok`）后把 turnId 记入释放集，`workingActorIds()`（按钮、活动栏、窗格头三处共用）
   跳过这些 Turn。于是点了终止 → 环立刻停、按钮立刻回到「发送」、原任务已在输入框里可继续补写。
   若取消**失败**，Turn 不释放，环继续转并在状态行报错（可重试）——这只在真出错时发生。
3. **释放不伪造终态**：Turn 仍是 `cancel_requested`，卡片继续显示「正在取消」，native 收敛后
   按真实事件写 `turn.cancelled`；释放集在该 Turn 进入终态或视图重置（`clearTimelineView`）时清空。
4. **不轮询 `/api/health.activeTurns`**（D-044 第 2 条仍然有效）：释放是本地命令回执，不是全局状态。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 保持锁定直到 `turn.cancelled` 落地 | 用户已喊停却还在转圈/锁发送，正是本次报告的症状；native 慢时体验最差 |
| 把禁用态的 `is-working` 只从 CSS 里删掉 | 不解决问题 2：点了终止仍会继续转，因为忙碌口径没变 |
| 取消后直接把 Turn 标成 `cancelled` | 伪造终态，违反「终态由 Broker/native 事件决定」 |
| 用轮询 health 判断「还有没有活」 | 全局数会锁住别的目录/对话，D-044 已否决 |

原因：「环」是这个界面上唯一表示**正在干活**的信号，它必须严格等价于「有在飞 Turn」。
一旦它在空闲时也转，用户就再也无法用它判断状态；而用户喊停之后，工作对操作员而言已经结束，
剩下的是 native 侧的收尾，不该继续占用输入器。

变更条件：若真实使用中 native 取消经常超时（取消受理后仍长时间占用 Agent 车道），
应在卡片上显示「已受理，等待 native 收尾」而不是恢复锁定；若 Broker 将来返回
「取消被拒」，则只有被拒的 Turn 保持未释放。

完成标准：`npm run typecheck`、`npx vitest run`（含 `sendButtonState.spinning` 与
`activeTurnActorIds({releasedTurnIds})` 断言）、`npm run build` 全通过；
无头 Chrome 探针四态：
空闲（空草稿）= `mode=blocked`、类名无 `is-working`、`.send-spinner` `display:none`、
`getAnimations()` 为空、环 0 个；
在飞 = `mode=stop`、spinner running、环数 = 在飞 Agent 数；
点终止后 = `mode=send`、spinner 消失、环 0、草稿为原文、状态行提示可继续；
后台 `turn.cancelled` 到达后 UI 不再变化。

## 决策变更规则

任何 Accepted 决策变更必须同时提供：

1. 触发它的真实证据；
2. 对用户五项原始需求的影响；
3. 协议/存储迁移方案；
4. 新增复杂度和回滚边界；
5. 更新后的测试与完成标准。

## D-051：收尾席位 `finishLast` —— 人话必须等审查/核验结算

触发证据：用户实测「和总管交流，他去分派任务，但每次审查或核验还没做完，人话就已经完成了任务」。
核对实现：Turn 队列是**按 Agent lane** FIFO（`turns_target_status_enqueue_idx` + `#runActorPump`），
不同 Agent 各自独立起跑；`send` 立即入队、`ask` 只等自己那一个目标。于是总管 `send` 审查、再 `send` 人话时，
人话（flash）几百毫秒就交稿，而审查还在跑命令——D-046 只写了「收尾必须派人话」，没有任何机制保证**先后**。
这不是总管记性问题：并发是 Broker 的既定语义，提示词约束不了它。

决定：

1. **新增 `agents.<id>.finishLast`（布尔，可选）为收尾席位**，语义是派单而非呈现（与 D-047 的 `order` 相反）：
   该 Agent 的 Turn 在**同一房间**仍有其它未 terminal Turn 时保持 `queued`，不 claim、不调原生 prompt；
   其它 Turn 全部 terminal 后由 Broker 自动放行（`#notifyTurnTerminal` 唤醒），
   所以 `turn.dispatched` 必然晚于上游 `turn.completed`。
2. **等待集排除派发者自身 Turn 及其祖先链**（`turns.parent_turn_id` 上溯）：上游正在自己的工具调用里
   等这个 Turn 回答，等它就是自造死锁。这是本决策的核心边界，不是优化。
3. **有界放行**：`timeouts.finishLastWaitMs`（默认 30 分钟）。到界即放行并 `#report` 一条异常，
   宁可给一份带缺口的汇报，也不让房间永久停摆；到界路径不静默。
4. **人话仍是普通 Turn**：消息照常持久化、`queuePosition` 照常可读、可 `cancel`、可 `steer`；
   只是 claim 晚一点。不新增审批/闸门概念，不改 unrestricted 合同，也不引入第二条访问策略。
5. **配置随 `/setup` 原样往返**（与 `order` 同一先例）：`AgentDraft` 透传 `finishLast`，
   一次设置页保存不会把席位抹掉；当前不新增专用开关控件。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 只在总管身份里写「先 ask 再派人话」 | 这次失效的正是提示词层；换模型、换措辞、换压缩上下文就复发 |
| 让所有 Agent 同批顺序执行 | 会消灭「提案/审查/批判并行」这一房间核心价值，等于用降级换顺序 |
| 按 `order` 推「最后一个就是收尾位」 | `order` 已明确是纯呈现（D-047），用位置推语义会让改版式就改行为 |
| 等全部 Turn（含派发者）terminal 才放行人话 | 派发者在自己的工具调用里等人话，双方互等，必然死锁 |
| 只在人话 prompt 里附「当前还在跑谁」 | 仍靠模型自觉，且 prompt 里的事实会随压缩与延迟失真 |
| 无上界地等下去 | 一个卡死的 peer 就能永久占住房子的收尾，用户连缺口都拿不到 |

原因：闭环的最后一环是「人话」，它读的是别人的结论。让汇总者与它的证据源赛跑，
得到的不是并发效率，而是**先交稿后补证据**的假完成——正是 D-046 要防的那类交付。

变更条件：若需要「多个收尾位」或按工作区分开配置，沿用同一字段（等待集按房间计算）；
若 `finishLast` 在多个实例间造成串行瓶颈，应先证明是房间结构问题，而不是放宽等待语义。

完成标准：`npm run typecheck`、`npm test`（74 文件 / 779 项）全通过；`tests/unit/broker/broker.test.ts`
新增 4 项（同房持有、到界放行、排除派发者链、空闲立即执行）；`tests/unit/storage` 覆盖
`listTurns({ roomId })`；`tests/unit/config.test.ts` 与 `tests/unit/app/cli.test.ts`
各覆盖解析与 `/setup` 往返。

## D-054：非终态 Turn 必须有限步收敛——会话替换前收尸，取消必须能结束它

触发证据：用户实测「一号对话发任务跑着，我去新建对话做别的事，上一个任务就一直显示运行中，
既没有输出，也无法继续发指令」。核对实现得到三个独立缺口：

1. `context/reset`、`conversations/resume`、`conversation/delete` 的 `resetNativeSessions` 分支
   会逐个 `restartFresh` 全部 Agent，但**从不 abort 在飞的 Turn**（全仓只有 `#performClose` 会
   abort `#active`）。native 进程被杀之后，该 Turn 唯一的出口是「来自已不存在进程的事件」。
2. `cancelTurn` 在 `#active` 里找不到该 Turn 时只读 DB 状态并原样返回 `running`
   ——「运行中」因此成为不可离开状态，同时房间级忙锁把输入器永久锁住。
3. `#prepareNext` 在 `sessions.resolve` 失败时 `return undefined`：Turn 保持 `queued`，
   既不落终态也不重试，只能等某个不相关事件碰巧唤醒这条 lane。
4. `recoverStaleRuntimeRecords` 只收敛 binding/instance；Turn 的启动对账在
   `store.recoverAfterRestart` 里**已有**（`dispatching/running/cancelling → interrupted`），
   所以重启能治好，但同一进程内卡住的 Turn 没有第二次机会。

决定：

1. **会话替换是有序的**：`#settleInFlightForSessionSwap` 在任何 `restartFresh` 之前执行——
   先 `abort` 该房间所有非终态 Turn 的 controller，在 `timeouts.closeMs` 内轮询等待落终态；
   超时则由新增的 `store.interruptTurns` 写 `turn.interrupted`（含 attempt 收敛、delivery cursor
   推进、terminal 事件），再执行重启。**新会话启动时，旧会话上的 Turn 必须已经是终态**。
2. **取消是兜底出口**：`#active` 缺失且 lane 已不存在时，`cancel` 定点收敛该 Turn 为
   `interrupted`（`reason=cancel_without_active_dispatch`）。两条守卫防止抢跑健康 lane：
   `#pumps` 仍持有该 actor 则不介入；claim 年轻于 `GHOST_TURN_GRACE_MS`（5s）或仍有未结
   attempt 时按「可能正在走向 `#execute`」处理。
3. **lane 不静默停摆**：`SESSION_NOT_AVAILABLE` 触发一次 `LANE_RETRY_MS`（2s）后的重查；
   重启循环结束后 `#nudgeRestartedActors` 主动唤醒全部 Agent，让排队 Turn 拿到新会话。
   这不是自动重放 prompt：重放门槛仍由 `markPromptInvoked` / delivery certainty 决定。
4. **被放弃的 pump 不得劫持 lane**：`#pumps` 的清理改为 identity-guarded；强行收敛一个
   忽略 abort 的原生流时，lane 立即释放给后续 Turn，孤儿 pump 只能写终态 no-op。
5. **持久化面只加一个方法**（`interruptTurns`），复用 `recoverAfterRestart` 已有的中断分支
   （抽为 `#interruptTurnRowUnsafe`），不新增第二套终态写法。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 忙碌时**拒绝**重置/续接 | 重置是用户显式动作，拒绝会把「我要开新对话」变成死路；真正要做的是先收尸再换会话 |
| 只靠启动对账（`recoverAfterRestart`） | 同一进程内卡住的 Turn 等不到下次重启；用户看到的正是这种 |
| 取消时无条件强杀非终态 Turn | 会抢在 FIFO claim 与 `#execute` 之间误杀健康 Turn（已有一条既有测试证明该窗口存在） |
| 给 `#prepareNext` 加重试上限后失败终态 | 会话重启是合法瞬态；把「等一下就好」判成失败会丢掉本可完成的工作 |
| 让 UI 乐观解锁绕过忙锁 | 忙锁是正确的事实投影；掩盖它会让真实的长期运行任务失去可见性 |

原因：Turn 的状态机只要存在「可以离开但没人负责推进」的状态，用户看到的就是「运行中」这种
既非成功也非失败的僵尸。收尸责任必须落在唯一权威写入者（Broker/Store）身上，
并且以「谁替换了承载它的进程」为触发条件，而不是以超时猜测。

变更条件：若将来允许同一 Agent 并发多 Turn（`IMPLEMENTATION.md:223` 目前禁止），
会话替换的等待集必须按 binding 而不是按房间重算，且 `GHOST_TURN_GRACE_MS` 需重新定义。

完成标准：`npm run typecheck` 通过；`npm test`（75 文件 / 803 项）通过；
`tests/unit/broker/broker.test.ts` 新增 4 项（stranded 取消收敛、新鲜 claim 不误杀、
重置前收尸且换会话后可继续派发、session 暂不可用后 lane 自愈）。

## D-055：草稿跟着光标，而不是跟着标签页

触发证据：用户「在一个对话框里粘贴了内容，切到新开的对话，粘贴的内容却跑到新对话去了」。
核对实现：草稿只有一个 key（`aichatlink:draft`），`restoreDraft()` 在每次页面启动时无条件注入输入器；
切房间/切对话都是整页 reload，于是上一个视图没发出去的文本被搬进新视图的输入框。

决定：

1. **作用域 = 视图**：`aichatlink:draft:<ws|primary>:<conv|live>`，由 URL 的 `?ws=` / `?conv=` 推导
   （`web/draft-scope.ts` 的纯函数，单测在 `tests/unit/web/draft-scope.test.ts`）。
2. **切换时显式搬运**：`enterConversationView` / `exitConversationView` 先 `saveDraft()` 出栈视图，
   再 `restoreDraft()` 入栈视图；切回同一视图恢复原文（这是「跟着光标」的完整含义，不是清空）。
3. **空草稿删 key**，不留空串，避免后来的视图继承一个「空但存在」的记录。
4. **存储不可用时静默降级**：读写抛异常只当草稿丢失，不得影响发送。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 只有一个全局 key（旧行为） | 整页 reload 会把 A 的未发文本注入 B，用户的直觉是「粘贴跟着光标」 |
| 切换视图就清空输入器 | 用户打一半切走看一眼再回来会丢稿；「跟着光标」不等于「一次性」 |
| 草稿写进 DB / 跟着消息持久化 | 草稿从未发送，不是房间记录；写库会把临时输入变成需要清理的权威数据 |

原因：粘贴落在光标所在处是对的，错的是**页面重载把上一个视图的文本先放了进去**。
把「哪里有内容」绑定到视图而不是浏览器会话，两个直觉（复制粘贴跟光标、切回来还在）才能同时成立。

完成标准：`npm run typecheck` 通过；`npm test`（76 文件 / 808 项）通过；
`tests/unit/web/draft-scope.test.ts` 覆盖同房间不同对话、跨房间、空草稿删 key、存储抛错四种情形。

## D-056：bootstrap 的未完成 Turn 带上已产出文本，切换视图才看得见「进度」

触发证据：用户「两个房间来回切着看进度」。核对实现：运行中每 `partialCheckpointChars`（4096）
会写一次 `turns.partial_text`（`broker.#handleNativeEvent`），但 `bootstrap()` 的 `activeTurns`
投影只取 `turnId/targetActorId/status/sourceEventId`，`TurnView` 也没有这个字段；而流式
`turn.content.delta` 是 transient、不持久化。于是切走再切回只剩一个写着「运行中」的空卡片，
已经输出的文字全部消失——看到的不是进度，只是「还活着」。

决定：

1. `bootstrap.activeTurns` 增加可选 `partialText`（**尾部**，上限 2000 字符）与
   `partialTextTruncated`。取尾部而不是头部，是为了接上「现在写到哪」，与切回后继续追加的语义一致。
2. 只是把**已存在的 checkpoint** 暴露出来，不新增持久化路径：仍然不落逐 token delta，
   `partial_text` 的写入时机与上限不变。
3. 前端在**非终态**卡片里渲染 `.turn-partial`（带 `已产出 / 已产出（前段省略）· 仍在运行` 标签）；
   一旦该 Turn 的 live 流开始（`ensureStreamingNode` + `clearTurnPartial`），checkpoint 立即让位，
   避免与流式气泡重复。
4. `trackTurnEnvelope` 保留 `partialText`：后续 lifecycle 帧（dispatched/streaming）不得把它擦掉。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 把 delta 持久化，切回直接重放 | 违反「不持久化逐 token delta」；存储与回放成本比收益大得多 |
| 只在客户端缓存 delta（内存） | 切房间是整页 reload，内存缓存必丢，解决不了用户的场景 |
| 返回完整 `partialText` | 检查点是全量累计，可能很长；bootstrap 必须保持有界 |
| 在卡片里显示「运行中 + 已用时长」 | 时长不回答「它写了什么」，而这正是用户切换回来要看的东西 |

原因：用户切回来要看的是**进度内容**，不是存活信号。DB 里已经有这份 checkpoint，
不暴露它等于让唯一的权威写入者替用户藏了最有用的信息。

完成标准：`npm run typecheck` 通过；`npm test`（76 文件 / 810 项）通过；
`tests/unit/broker/broker.test.ts` 新增 2 项（小文本原样投影、超限时取尾部并标记截断，
且终态后不再出现在 activeTurns）；契约 `TurnProjectionSchema` 覆盖新字段。

## D-057：被边界切断的 Turn，其尾巴仍归它发起的那段对话

触发证据：用户切回旧对话，看到「总管 · 运行中 [取消]」一张空卡片，问「问题分析解决的记录呢？现在啥都不显示了」。
核对真实库（`ws_5bfb37400d97`）得到：该 Turn 在 `12:06:03` 起跑，`12:06:15` 被 `turn.cancelled` 结束；
而 `context.reset`（`throughSeq=4`）落在 seq 5，于是 Turn 的
`turn.reasoning.recorded`（seq 6）、9 条 `tool.progress.recorded`（seq 7–15）与 `turn.cancelled`（seq 15）
全部写在边界之后，**物理上属于下一个纪元**。结果：
- 旧对话回放区间是 1..4，只能画出用户消息 + `turn.started` → 永远「运行中」；
- 新对话虽然包含 6..15，但 `retiredTurnIds`（`seedRetiredTurnIds`）把它们当作"已放弃回合"隐藏。

记录没丢，是**归档位置与可见性都错了**。

决定：

1. **对话投影向后延伸**：`listConversations` 对已关闭纪元取
   `endSeq = max(boundary, 该纪元内发起 Turn 的终态事件 seq)`（`store.latestTurnTerminalSeq`，
   一条聚合 SQL，不扫全表）。因此旧对话能回放自己的推理、工具记录与终态。
2. **只改读模型**：不重写事件、不移动下一纪元的 `startSeq`、不改 Context Packet 的归属。
   区间可以重叠，重叠正是"这些事件属于那段工作"的诚实表达。
3. **续聊仍然只到当前边界之前**：`conversations/resume` 在构造种子时把 `throughSeq` 夹到
   `highWater - 1`，避免延伸后的终点覆盖 live 纪元（`resumeNow` 的既有校验不变）。
4. **前端兜底**：进入已关闭对话后，回放结束时仍非终态的 Turn 一律渲染为「已中断」并释放忙锁
   —— 一段已关闭的对话不可能还在跑，这是旧数据（本次修复前写入的）唯一诚实的呈现。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 把尾巴事件的 seq 改写成边界内 | 破坏 append-only 与 seq 单调性，属于重写历史 |
| 让 `retiredTurnIds` 放行，尾巴显示在新对话里 | 新对话会凭空出现一段属于别人上下文的工作，且刷新后行为不稳定 |
| 旧对话只显示「已中断」不显示记录 | 用户要的是「分析记录」，藏起来等于仍然丢失 |
| 在 `turn.interrupted` 里补写 content | 该 Turn 从未产出正文（`partial_text` 为空），补写只能伪造内容 |

原因：对话是**工作**的容器，不是「seq 落在哪一段」的容器。一个 Turn 在边界前起跑，
它的全部证据就该跟它走；否则边界一次点击就能让证据从两侧同时消失。

完成标准：`npm run typecheck` 通过；`npm test`（76 文件 / 811 项）通过；
`tests/unit/broker/broker.test.ts` 新增 1 项（reset 切断的 Turn，其对话 `endSeq` 到达终态事件）；
用真实工作区库的副本验证 `conv:1` 由 `endSeq 4` 变为 `15`（含 reasoning/tool/cancel）。

---

## D-058：对话切换不整页重载——先取数，再一次重绘

触发证据：用户反馈「切换对话时一直频闪，做不到丝滑」。截图指向 Web 界面左栏对话列表。
核对实现得到两处空窗：`exitConversationView()` 用 `window.location.reload()` 回到活纪元
（整页白闪 + EventSource 重连 + 侧栏重建）；`enterConversationView()` 先 `clearTimelineView()`
再 `await loadEventRange()`（最长 6 秒的空列，回放内容逐条追加）。

决定：

1. **同房间的对话切换不重载**。`回到当前对话` 走 `rebuildLiveEpoch()`：先取 `/api/bootstrap`
   快照与 resume 种子，再清空并同步重绘；SSE 连接与 seq 游标保持不动。
2. **先取数，后清空**。进入回放同样先 `await` 完全部区间再 `clearTimelineView()`；
   清空与绘制之间不允许出现 `await`——那段空窗就是被看见的频闪。
3. **重建期间的 live 帧排队**。`liveEnvelopeBuffer` 把快照与重绘之间到达的帧按序补放，
   否则流式 delta 会在这段窗口里丢失（这是「不重载」必须付的代价）。
4. **重建 = 一次刷新**。`retiredTurnIds` 清空后由快照窗口重建；已见 `eventId` 在重绘前显式删除，
   否则 `acceptEnvelope` 的幂等去重会让整段活纪元画不出来。
5. **首次加载与原地重建共用 `paintLiveEpoch()`**。两条渲染路径只保留一份实现，避免刷新与切换漂移。
6. **跨 workspace 也原地切换**（修订 D-040 第 6 条的「整页重载」）：隔离语义保留——关闭旧 EventSource、`lastDurableSeq` 归零、`seenEventIds` / `memories` / `openEpochStartSeq` 重置——但不再重载页面。`switchWorkspace()` 复用 `bootstrap()`，`history.pushState` 记录目录切换，`popstate` 按 URL 重新应用视图，前进/后退同样不重载。
7. **兜底**：`/api/bootstrap` 失败时退回 `location.reload()`，原地重建只是优化，不是唯一路径。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 只加淡入淡出遮罩 | 白闪变灰闪，重载成本与 SSE 重连仍在 |
| 保留 reload，改用 View Transition | 跨文档不生效 |
| 只改 URL 不重建时间线 | 视图仍显示回放内容，与事实源不一致 |
| 重建期间关闭 EventSource 再重连 | 连接指示器抖动，且引入重连窗口 |

原因：视图切换不该再付一次整页启动的代价；但「不重载」不能建立在假设上，
必须让重建路径与刷新路径共用同一个渲染函数，并把 live 帧的竞态显式排队。

完成标准：`npm run typecheck` 通过；`npm test`（76 文件）通过；`npm run build` 通过。
真实实例（4310）实测——回放→活、活→回放、再回放→活、跨工作目录（含 `?conv=`）、浏览器后退：
`performance.getEntriesByType("navigation").length === 1`（无重载），
rAF 逐帧采样 `emptyFrames === 0`（时间线从未空帧），URL 的 `?ws=` / `?conv=` 与 `is-viewing` 同步正确。

## D-059：续聊最新那段对话，折回同一条，不新起一条「· 续」

触发证据：用户「我在旧对话里发送新指令，为什么总要给我新起一个对话？不能在旧对话里面继续完成？」

核对实现：对话没有独立身份，它是 `context_resets.through_seq` 切出的 seq 区间（D-034）。
时间线 append-only 且 seq 全局单调，所以任何新消息必然落在最后一个边界之后 = 新纪元；
而 `conversations/resume` 正是用「新纪元 + 只读种子」实现上下文续接（D-038），
于是 UI 里必然出现一条 `<原标题> · 续`。这不是 bug，是「对话 = 区间」这个模型的直接推论。

决定：

1. **续聊最新对话 = 折回同一行**：`listConversations` 在处理带续聊种子的纪元时，若
   `resume.conversationId` 就是当前列表里最新的一条（中间没有出现过带内容的对话），
   不发射新行，而是把该行 `endSeq` 延伸到本纪元、`active=true`、`resumedFrom=null`，
   标题保持不变。侧栏仍然只有一条，URL 仍是同一个 `conv:<startSeq>`。
2. **中间夹了有内容的对话时不折回**：那种情况下两段 seq 区间交错，硬合并会让时间线
   出现「跳过一段」的假连续；此时保留真正的第二段（`· 续`），如实表达"这是另一段"。
3. **只改投影**：不新增表、不改 `context_resets`、不改事件、不改 Context Packet 的种子
   （种子仍是 `[fromSeq, throughSeq]`）。折回后该对话的区间本就连续，种子与画面一致。
4. **不再写"· 续"标题** 只是折回路径的结果；第二段路径的措辞保持不变。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 让对话成为一等身份（事件打 `conversation_id`） | 能满足真正的分支时间线，但要迁移 schema 并改造所有范围查询/种子/删除/记忆；D-034 的变更条件要求先证明必需 |
| 直接改写旧对话的 `endSeq` 到最新 | 会让中间那段对话的事件落进两条对话的区间，回放重复、种子污染 |
| 续聊时不写 `context.reset`，直接往旧纪元追加 | 违反"新对话要重启原生 session"，且旧纪元的 native 上下文已经关闭 |
| 只靠前端把两条会话合并显示 | 服务端仍返回两条，刷新/URL/续聊链会再次分叉，属于假修 |

原因：用户的心智是「对话是容器，可以回去继续」，当前模型是「对话是区间」。对**最新一段**
折回，两者在绝大多数场景下等价，且零迁移；只有真的插入了另一段对话时才保留分段，
这是模型边界，不是实现缺陷。

变更条件：若需要「回到任意历史对话继续、且与中间对话并存」，就必须走 D-034 列出的
session 表 + 多区间种子路线（本项目仍未做）。

完成标准：`npm run typecheck` 通过；`npm test`（76 文件 / 813 项）通过；
`tests/unit/broker/broker.test.ts` 新增 2 项（折回同一行、中间有内容时保留第二段）；
`docs/PROTOCOL.md` 的对话投影规则同步。

## D-060：删除对话先落本地行；空纪元只在没有历史时出现

触发证据：用户截图 `PixPin_2026-11-19_20-20-36.png` / `20-20-48.png`，抱怨「删对话要么删完仍然存在，要么删完给我个新对话」。同一工作区的 `client_commands` 记录：

- `20:20:25.144` 第一次 `conversation.delete` 成功：`conv:132`，129 events / 18 turns。
- `20:20:40.212` 第二次 `conversation.delete` 只有空结果；`conv:132` 已不存在，Broker 抛 `UNKNOWN_TARGET`，客户端把它画成红色横幅（`One or more message targets are not registered.`）。

两条独立原因叠加：

1. **查看中的对话被删除时提前 return**。旧代码在 `conversationView` 命中后只调 `exitConversationView()`，没有先把行从本地列表移除，也没有 `await refreshConversations()`；下一次任意重绘仍从旧 `conversations` 重建该行，用户 11 秒后再点一次，才得到 `UNKNOWN_TARGET`。
2. **空的开放纪元一直在侧栏渲染**。它的标题按 `现存对话数 + 1` 计算（D-034 的 2026-11-18 变更），所以删掉任意一条更早的对话，这一行就从 `对话 3` 变成 `对话 2` —— 用户没有删它，却看到它改名/像新对话。`empty` 标记本来就是为了让侧栏把它藏起来；D-034 的变更把它改成“永远显示”，这次按新证据收回。

决定：

1. **空纪元只在组内没有其他对话时渲染**（`visibleConversations()`）。有历史时隐藏；删光后仍显示 `对话 1`（保留 D-034 的原始诉求）。分组头计数只算实际渲染的行。
2. **删除成功先落本地行**：POST 返回（或 `UNKNOWN_TARGET` 表示已经删过）后，立刻从 `conversations` / `conversationsByWorkspace` 移除并重绘，再 `await refreshConversations()`；查看中的对话被删则 `exitConversationView()`，`?conv` 指向被删 id 时清空。
3. **删除是幂等的**：同一行被重复点击时，Broker 的 `UNKNOWN_TARGET` 不画红条，按“已经删掉”处理；下一次重绘不会再造出该行。
4. **不改 Broker 的标题规则**：`对话 N` 仍按 `现存对话数 + 1` 计算；它现在只在“没有历史”时可见，因此不会再因删除别的行而改掉用户没删的那一行。不改 schema、不改 `context_resets`、不改事件。

| 被否决的方案 | 否决理由 |
| :--- | :--- |
| 把空纪元永远藏起来 | 删光一个目录后看不到 `对话 1`，正是 D-034 2026-11-18 变更要修的 |
| 把标题改成 `index + 1`（边界序号） | 删除后会出现 `对话 1 / 对话 5` 的空洞；且刷新后仍可能变 |
| 给 `context_resets` 加持久化序号 | 能做到完美稳定，但要迁移 schema；当前证据只要求“删别的行别改这一行”，先走投影层 |
| 只把删除按钮 disable 得更久 | 不解决重绘从旧列表重建该行；根因是本地列表没更新 |

完成标准：`npm run typecheck` 通过；`npm test`（76 文件 / 818 项）通过；`npm run build` 通过；
`tests/unit/web/conversation-epoch.test.ts` 覆盖 `visibleConversations()` 的 5 种输入；
真实实例复测：删除查看中的对话，行在同一帧消失、无红条；删除更早的对话，当前行标题不变。
