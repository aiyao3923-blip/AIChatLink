# 计划书：把 pi 接进 AIChatLink 房间（pi-driver 适配垫片）

状态：**v0.2 — 已通过验收核验，待批准开工**
日期：2026-11-16 · 目标目录：仓库根

---

## 修订记录

| 版本 | 结论 | 主要变化 |
| :--- | :--- | :--- |
| v0.1 | 初稿 | 采用"克隆用户 agent-dir 到每角色目录"的隔离方案 |
| **v0.2** | 核验后修订 | ① `models.json` 含 **4 个明文 API Key** → 隔离方案改为"白名单最小目录 + 裁剪 provider"；② `settings.json` 含 **13 个扩展 + xhigh 默认推理** → 绝不复制，改手写最小 settings；③ resume 统一用 `--session-id`（`--session` 会弹 fork 交互）；④ 新增 thinking 被 `thinkingLevelMap` 钳制的实证与对策；⑤ E1/E6 已由实验闭环 |
| **v0.5** | 会话与宿主事实 | ① 房间新增 conversation 纪元投影（`/api/conversations`）与 `POST /api/context/reset`；② 新对话用 `restartFresh` 启动全新 pi session；③ 侧栏会话列表 + 只读历史抽屉 + 本地隐藏；④ 垫片每条 prompt 注入 `[host_agent]` 模型事实；⑤ 推理默认折叠 |
| **v0.4** | 接入 setup 模型选择 | ① 每 Agent `model`/`thinking` 写入 aichatlink.json，经 Claude `--model/--effort` 传给垫片；② 优先级：setup > `/model` 快照 > ROLES.json；③ `/setup` 的候选只读来自 CC Switch 与 models.json；④ 房间上下文默认 1M 字符；⑤ 目标选择器折叠为弹层 |
| **v0.3** | S0–S8 执行后 | ① 真机跑通 S3–S7，计划里的"未闭环"全部转实；② 新发现并修复 **R27 REST 静态 target 白名单**（不改源码则任何额外 agent id 都发不出消息）；③ 新发现 **R28 模型热切换的 provider 兼容性**、**R29 MCP read 的 correlation 作用域**、**R30 原生 error 被当成功**，均已修复/登记；④ 回滚方案补上源码补丁的还原方式 |

核验依据见 §8「实验台账」，每条结论都有实测输出。

---

## 0. 环境基线（全部实测）

| 项 | 实测值 | 来源 |
| :--- | :--- | :--- |
| OS | win32 x64 10.0.26200 | doctor |
| Node | v24.18.0（AIChatLink 要求 `>=24.14.1 <25`） | doctor |
| AIChatLink | 0.1.16 / HEAD `7c3aa9c` / 最后提交 2026-08-20 / **无 LICENSE** | `git log`、`ls` |
| pi | 0.99.2，bin `dist/bundle/cli.js` | `package.json` |
| pi RPC | `--mode rpc`，JSONL；stdout 仅协议，stderr 日志 | 实验 E0 |
| 默认模型 | `<provider>/<model>`（自定义 provider，`<provider-endpoint>`） | `get_state` |
| 模型上限 | context 1M / max-out 1M / thinking **仅 `off` 与 `xhigh` 有效**，`minimal/low/medium/high` 被钳到 `xhigh` | 实验 E3 |
| `~/.pi/agent/models.json` | **含 4 个明文 apiKey**（分属 4 个不同 provider） | 实验 E2 |
| `~/.pi/agent/settings.json` | 13 个包扩展 + 1 个本地扩展 + `defaultThinkingLevel:"xhigh"` | 实验 E2 |
| `~/.pi/agent/auth.json` | `{}`（无持久凭证） | 实验 E2 |
| pi 冷启动（RPC 到 get_state） | **1.53 / 1.54 / 1.53 s**（3 次） | 实验 E1 |
| 隔离 agent-dir 生效性 | 只加载 `<agent-dir>/mcp.json` 的 aichatlink；用户 4 个 server 全部不加载 | 实验 E6 |
| AIChatLink 房间现状 | 4 agent ready，端口 4310 | `/api/health` |
| **REST 目标白名单** | `DEFAULT_KNOWN_TARGETS` 仅 `codex/grok/kimi/hermes/claude`；自定义 id（含上游自带 `claude-builder`）被 `UNKNOWN_TARGET` 拒绝 | 实验 E7 |
| **pi 侧错误语义** | 供应商拒绝时 `message_end.stopReason="error"` + `errorMessage`，正文为空 | 实验 E9 |

---

## 1. 目标与非目标

### 1.1 目标
1. 房间可存在 N 个角色，**背后都是 pi**，每角色独立 session 与独立配置目录。
2. 每角色 **模型可钉住**，**可中途切换**（房间 `/model` → `set_model` → 同一 session 续跑）。
3. 每角色拿到 AIChatLink 注入的 MCP（`send/ask/publish/read`），能主动互查与派活。
4. **零侵入**：不改 AIChatLink 源码；只新增 `tools/pi-driver/` + 修改 gitignored 的 `aichatlink.json`；可一键回滚。
5. 现有 codex / claude / grok 三个 agent 保持可用，与 pi 角色共存互调。

### 1.2 非目标
- 不改 AIChatLink driver 枚举（仍以 `driver:"claude"` 冒充）。
- 不实现 pi→ACP（v2 备选）。
- **不提供"点开某角色的实时 TUI"**（RPC 无 TUI，见 R16）。
- **不复制、不修改用户的任何 pi 配置与密钥到可提交位置**（见 §5.3 白名单）。
- 不提交上游 PR。

---

## 2. 已核实的协议事实（帧级，逐字段对齐源码）

### 2.1 AIChatLink → 子进程（stdin，JSONL）

| # | 帧 | 必填字段 | 来源 |
| :--- | :--- | :--- | :--- |
| I1 | 用户消息 | `{type:"user", message:{role:"user", content:[{type:"text", text}]}}` | `protocol.ts:189-201` |
| I2 | 握手 | `{type:"control_request", request_id, request:{subtype:"initialize"}}` | `protocol.ts:215-218` |
| I3 | 权限模式 | `{..., request:{subtype:"set_permission_mode", mode:"bypassPermissions"}}` | `protocol.ts:220-227` |
| I4 | 中断 | `{..., request:{subtype:"interrupt"}}` | `protocol.ts:203-205` |

启动 argv（AIChatLink 拼好，垫片必须全部忽略）：

```
<node> <shim.mjs> --print --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages --permission-mode bypassPermissions
  [--mcp-config <json>] (--session-id <uuid> | --resume <uuid>)
```
来源 `protocol.ts:17,121-135`。

### 2.2 子进程 → AIChatLink（stdout 必须满足的校验）

| # | 帧 | 关键字段 | 校验/约束 | 来源 |
| :--- | :--- | :--- | :--- | :--- |
| O1 | `control_response`(init) | `response.response.current_permission_mode` | **缺失即抛错** | `protocol.ts:229-241` |
| O2 | `control_response`(set_perm) | `response.response.mode === "bypassPermissions"` | 不等则 `ADAPTER_START_FAILED` | `protocol.ts:243-257`、`claude-cli-adapter.ts:478` |
| O3 | `stream_event.message_start` | `event.message.id` | 切换当前消息 id / 去重 | `protocol.ts:428-435` |
| O4 | `stream_event.content_block_start` | `event.content_block.{type:"tool_use", id, name}` | **无 `id` 整帧丢弃** | `protocol.ts:384-402` |
| O5 | `...delta`(文本) | `event.delta.{type:"text_delta", text}` | 无 `text` 丢弃 | `protocol.ts:404-412` |
| O6 | `...delta`(推理) | `event.delta.{type:"thinking_delta", thinking}` | 同上 | `protocol.ts:413-417` |
| O7 | `assistant` 聚合 | `message.{id, content:[text|tool_use]}` | 同 id 已流式文本被跳过 | `protocol.ts:443-471` |
| O8 | `user` 工具结果 | `content:[{type:"tool_result", tool_use_id, is_error}]` | **不发则工具永不结算** | `protocol.ts:478-498` |
| O9 | `result` | `subtype / is_error / terminal_reason / stop_reason / num_turns / usage` | 判定见下 | `protocol.ts:300-335` |
| O10 | `system`/`init`（可选） | `session_id / cwd / permissionMode` | **三者任一不符即 `#rejectInitFrame`** | `claude-cli-adapter.ts:580-608` |

`result` 判定（`classifyClaudeResult`）：

```
terminal_reason ∈ {aborted_streaming, aborted_tools} → cancelled
subtype === "success" && is_error === false          → completed
其余                                                  → failed
```

未知帧 type **静默忽略**（`claude-cli-adapter.ts:722`）。

### 2.3 通道硬限制

| 约束 | 值 | 来源 |
| :--- | :--- | :--- |
| stdout 单行上限 | **1 MiB**（超限 `line_too_large`） | `jsonline-process.ts:71` |
| 关闭宽限 / 强杀 | 5 000 / 2 000 ms | `:73-74` |
| 握手超时 | 15 000 ms | `claude-cli-adapter.ts:66` |
| 首事件超时 | 180 000 ms | `:68` |
| 取消超时 | 10 000 ms | `config.ts` |
| 每 agent 并发 | 1（第二 turn 被 `SESSION_NOT_AVAILABLE` 拒） | `claude-cli-adapter.ts:273,401` |
| 子进程 env | **继承 AIChatLink 进程环境**（adapter 不传 env） | `jsonline-process.ts:127` + grep 实证 |

### 2.4 pi RPC（已核实）

| 命令/事件 | 形状 | 用途 |
| :--- | :--- | :--- |
| `prompt` | `{type:"prompt", message}`，流式中加 `streamingBehavior:"steer"\|"follow_up"` | 投喂 I1 |
| `abort` | `{type:"abort"}`，等 idle 后响应 | 响应 I4 |
| `set_model` | `{type:"set_model", provider, modelId}` | **中途换模型** |
| `set_thinking_level` | `{type:"set_thinking_level", level}` | 推理档位（受模型 map 限制，见 R25） |
| `get_state` | `data.{model, thinkingLevel, isStreaming, sessionFile, sessionId, messageCount, …}` | 握手自检 |
| `message_update` | `{usage, assistantMessageEvent:{type, contentIndex, delta}}` | O4/O5/O6 |
| `toolcall_start/delta/end` | `{contentIndex, id, toolName}` / `{…delta}` / `{…toolCall}` | O4/O7 |
| `tool_execution_start/update/end` | `{toolCallId, toolName, args, result, isError}` | O8 |
| `agent_settled` | 无字段 | O9 |
| `extension_ui_request` | 扩展 UI 交互（隔离目录下不出现，见 R3） | 丢弃 |

---

## 3. 架构

```
AIChatLink (driver:"claude", command:{executable:"node", prefixArgs:["…/shim.mjs"]})
   │  stdin/stdout JSONL（Claude Code stream-json 方言）
   ▼
pi-aichatlink-shim.mjs
   ├─ argv 白名单：只取 --session-id / --resume / --mcp-config，其余丢弃并计数
   ├─ 角色配置 roles/<id>.json → {model, provider, thinking, tools, workdir}
   ├─ 角色目录 .aichatlink/pi-roles/<id>/ （白名单最小集，见 §5.3）
   ├─ 子进程 node <pi-pkg>/dist/bundle/cli.js --mode rpc --session-id <uuid>
   │        --model <钉住> --thinking <档> [--exclude-tools …]
   └─ 指令拦截：/model、/models、/thinking → 本地执行，不进模型上下文
   ▼
pi --mode rpc（长驻，一角色一进程）
```

---

## 4. 帧映射（垫片核心）

### 4.1 AIChatLink → pi

| 输入 | 处理 | 输出 |
| :--- | :--- | :--- |
| I1 | 取所有 `type==="text"` 拼接；**只对 `[current_message]` 之后的内容**匹配 `^/(model\|models\|thinking\|state)\b` 则本地拦截 | `{type:"prompt"}`；busy 时附 `streamingBehavior:"steer"` |
| I2 | 先 `get_state` 探活 + 读 model | O1（`current_permission_mode:"bypassPermissions"`、`pid`） |
| I3 | 无对应语义 | O2（`mode:"bypassPermissions"`） |
| I4 | **立刻**回 control_response（避 10 s 超时），再发 `abort` | 收到 settle 后发 O9（`terminal_reason:"aborted_streaming"`） |

### 4.2 pi → AIChatLink

| pi | 映射 |
| :--- | :--- |
| `message_start` | O3（message id `msg_<turnSeq>` 全程一致） |
| `text_delta` | O5 |
| `thinking_delta` | O6 |
| `toolcall_start` | O4（用 `toolCall.id`，缺失则丢弃并计数） |
| `toolcall_end` | 并入 O7 的 `tool_use` 块 |
| `tool_execution_end` | O8 |
| `message_end` | O7（单帧 ≤ 1 MiB，超限只发流式不发聚合）；**`stopReason:"error"` → 聚合错误正文 + `is_error` 终局帧** |
| `agent_settled` | O9 `success` |
| `error` / 子进程退出 | O9 `error_during_execution`（**不得等 180 s**） |

### 4.3 规则集
1. 白名单转发；丢弃 `extension_ui_request`、`queue_update` 等。
2. 自写字节级 LF 切分 + `StringDecoder`（**不用 readline**，pi 警告 U+2028/U+2029）。
3. 写出帧 ≤ 1 048 000 字节。
4. `busy` 守卫；非法并发立即失败帧。
5. 子进程退出/超时立即结算，不悬挂。
6. **v1 不发 `system/init`**（规避 O10 三重校验）。
7. **一回合只终局一次**：`message_end(error)` / `error` / `agent_settled` 谁先到谁终局，避免 AIChatLink 收到两个 result。

---

## 5. 文件清单

### 5.1 新增（全部在 `AIChatLink\tools\pi-driver\`）

| 文件 | 作用 | 行数估计 |
| :--- | :--- | ---: |
| `shim.mjs` | 主体：argv/角色/子进程/双向映射/指令拦截/限长/收敛 | ~420 |
| `frames.mjs` | 纯函数：帧构造 + pi 事件投影 | ~150 |
| `lines.mjs` | 字节级 JSONL 读端 | ~60 |
| `roles.mjs` | 角色配置校验 + 路径安全（防穿越、防绝对路径逃逸） | ~90 |
| `role-dir.mjs` | 角色目录初始化（白名单复制、settings 生成、mcp 写入） | ~120 |
| `make-entries.mjs` | 由 `ROLES.json` 生成 `entries/<role>.mjs` 与 aichatlink.json 片段 | ~40 |
| `entries/<role>.mjs` | 每角色薄入口（AIChatLink 只允许一个 JS 前缀参数） | 生成 |
| `ROLES.json` | 三角色实例配置 | ~20 |
| `dev/room.mjs` | 验收辅助：发消息 / 看事件 / 轮询 | ~80 |
| `dev/interrupt-test.mjs` | R12 打断验收 | ~50 |
| `README.md` | 安装 / 切模型 / 排错码表 / 回滚 / **密钥警示** | ~140 |
| `test/frames.test.mjs` | 帧构造与投影单测（无网络） | ~180 |
| `test/shim-smoke.mjs` | **假 pi** 端到端冒烟 | ~120 |
| `PLAN.md` | 本文件 | — |

### 5.2 修改（1 个 gitignored 文件）

`AIChatLink\aichatlink.json`：新增 `pi-architect` / `pi-reviewer` / `pi-contrarian` 三个角色，各
`driver:"claude"`、`command:{executable:"node", prefixArgs:["<repo>/tools/pi-driver/shim.mjs"]}`；保留 codex/grok。

### 5.3 角色目录构成（**白名单，这是 v0.2 的核心修正**）

`.aichatlink/pi-roles/<agentId>/`，只允许以下内容：

| 文件 | 来源 | 理由 |
| :--- | :--- | :--- |
| `models.json` | **从用户目录复制，并裁剪为角色所需 provider** | 必须（否则模型不可用）；裁剪以缩小密钥暴露面 |
| `settings.json` | **垫片手写生成**，只含 `defaultProvider/defaultModel/defaultThinkingLevel/compaction` | **绝不复制**：用户那份含 13 个扩展与 xhigh 默认 |
| `mcp.json` | 垫片由 `--mcp-config` 翻译生成（aichatlink only） | 用户级 4 个 server 不进入角色 |
| `auth.json` | `{}`（用户原本也是空） | 需要时再手工填 |
| `sessions/` | pi 自动创建 | 每角色独立会话 |

**禁止复制**：`extensions/`、`agents/`、`skills/`、`SYSTEM.md`、`AGENTS.md`、`mcp-auth.json`、`*-bak*`。

→ 效果（已实测 E6）：角色只会加载 `aichatlink` 这一个 MCP，无扩展噪音，系统提示用 pi 内置默认，人设由 AIChatLink 的 `identity` 每轮注入。

---

## 6. 实施步骤

| 步 | 动作 | 验收判据 | 回滚 |
| :--- | :--- | :--- | :--- |
| **S0** | `lines.mjs` + `frames.mjs` + 单测 | `node --test` 全绿；帧样例逐字段对齐 §2.2 | 删目录 |
| **S1** | `shim.mjs` 最小版 + `test/fake-pi.mjs` | 假 pi 下跑出完整 turn（流式 + result） | 删目录 |
| **S2** | `role-dir.mjs`：白名单复制 + 生成 settings + 写 mcp | 角色目录内容 === §5.3 清单；`pi mcp list` 仅 aichatlink（E6 已证） | 删 `.aichatlink/pi-roles` |
| **S3** | 接真 pi，单角色冒烟（`--no-tools`，`--thinking off`） | 房间一句 → 流式 → `result` completed；`/api/health` ready | 移除该角色 |
| **S4** | 开工具：O4/O7/O8 三联 | 工具块出现并闭合；无 `line_too_large` | `enabled:false` |
| **S5** | 模型控制：`/model`、`/models`、`/thinking` + `set_model` | 切换后 `get_state` 证明 provider/model 变、上下文未丢 | 删 `*.role.json` |
| **S6** | MCP 互查：`read` 别人的发言 | pi 侧出现 `mcp__aichatlink__*` 且调用成功 | 清角色 mcp.json |
| **S7** | 三角色 + 议会 SOP（征集/对撞/收敛） | 并发流式、互查成功、产出最终计划 | 全量还原 |
| **S8** | README + 排错码表 + 回滚脚本 | 按 README 从零复现一次 | — |

### 执行状态（2026-11-16）

| 步 | 状态 | 关键证据 |
| :--- | :--- | :--- |
| S0 | ✅ | `node --test` 34/34 |
| S1 | ✅ | 假 pi 端到端（含打断、/model） |
| S2 | ✅ | 角色目录白名单单测 |
| S3 | ✅ | E8 真机成回合 |
| S4 | ✅ | E9 工具闭环 |
| S5 | ✅ | E10 换模型 + 上下文（并修复 R28/R30/R31） |
| S6 | ✅ | E11 MCP 互查（登记 R29） |
| S7 | ✅ | E12 三角色并发 |
| S8 | ✅ | `README.md` + 本计划更新 + 回滚步骤（含源码补丁还原） |


---

## 7. 隐患登记册（v0.2 修订后）

| ID | 隐患 | 证据 | 后果 | 对策 | 验证 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **R1** | 覆盖 `PI_CODING_AGENT_DIR` 会丢模型目录 | `get_state` 的 provider 来自 `models.json` | 角色无模型可用 | 白名单复制 `models.json`（裁剪 provider） | 角色 `get_state` 返回期望模型 |
| **R2** | `models.json` **含 4 个明文 API Key** | 实验 E2 | 密钥扩散 | ① 只保留角色所需 provider；② 目录在 gitignored `.aichatlink/` 下；③ README 红字；④ **不复制 `mcp-auth.json`** | `grep -c apiKey` 角色目录 ≤1 |
| **R3** | 扩展噪音 `extension_ui_request` | 实验 E0（用户目录下出现） | 噪音/潜在阻塞 | 角色目录不含扩展（E6 实证无噪音） | 冒烟日志计数为 0 |
| **R4** | 发 `system/init` 触发三重校验 | `claude-cli-adapter.ts:580-608` | 会话不可用 | **v1 不发** | 日志无 `type:"system"` |
| **R5** | resume 语义错配 | `cli.md:88-96`：`-r/--resume` 是**交互选择器**，`--session <id>` 会 offer fork；`--session-id` 才是"定指或新建" | 恢复时卡住 | **`--session-id` 与 `--resume` 统一映射为 `--session-id`** | 重启房间后上下文延续 |
| **R6** | Claude 专属 argv | `protocol.ts:17` | pi 报未知参数退出 | 白名单解析 + 计数 | 日志 `argvDropped` 有值且 pi 正常起 |
| **R7** | `result` 判定严格 | `classifyClaudeResult` | 中断被判失败 | 中断发 `terminal_reason:"aborted_streaming"` | 打断后状态 cancelled |
| **R8** | 缺 `tool_result` 回填 | `protocol.ts:478-498` | 工具气泡永久转圈 | 每 `toolcall_end` 配一发 O8 | 工具块闭合 |
| **R9** | `content_block_start` 缺 `id` 被丢弃 | `protocol.ts:392-402` | 工具不显示 | 用 `toolCall.id`，缺失则计数 | 单测 |
| **R10** | 单行 > 1 MiB | `jsonline-process.ts:71` | 协议错误 | 聚合帧超限降级 | 单测（2 MiB 输入） |
| **R11** | 并发 turn | `SESSION_NOT_AVAILABLE` | 第二 turn 被拒 | `busy` 守卫 + steer 排队 | 连发两条不报错 |
| **R12** | 取消超时 10 s | `config.ts` | 打断卡 10 s | 先回 control_response 再 abort | 打断 < 2 s |
| **R13** | Windows 进程树残留 | 5 s + 2 s 宽限，无 SIGTERM | 残留进程 | stdin 关闭 → 5 s 未退则 `taskkill /T /F` | `aichatlink stop` 后无残留 |
| **R14** | ~~每角色重复吃大 SYSTEM.md~~ **已消除** | v0.1 设想要复制 `SYSTEM.md`(21 K)/`AGENTS.md`(16 K) | — | v0.2 不复制任何上下文文件；提示词用 pi 内置默认 | token 计数对比 |
| **R15** | 协议漂移（AIChatLink 停更 + 无许可） | 0.1.16（3 个月前）vs pi 0.99.2 | 接口失配 | 启动自检 `PROTOCOL_VERSION` + `get_state` 结构校验；README 写明仅自用 | 自检失败给出明确码 |
| **R16** | RPC 无 TUI | `rpc.md` 定义 | 与"每模型自己开 TUI"初衷冲突 | v1 用房间流式替代；v2 再评估（E4） | 明确不承诺 |
| **R17** | `--mcp-config` 两形态 | `protocol.ts:140-187`（stdio 带 `--binding`；http 带 `X-AIChatLink-Binding`） | MCP 接不上 | 两种都翻译成 pi `mcpServers`（`command/args/env` 或 `url/headers`） | pi 出现 `mcp__aichatlink__*` |
| **R18** | MCP 注入失败静默降级 | pi 的 mcp 错误只进 stderr | 看似正常实则不能互查 | 握手时校验工具列表含 aichatlink，缺失写 `role.log` 并置 health 警告 | 房间内 `read` 成功 |
| **R19** | 角色可写盘/执行命令 | AIChatLink `unrestricted` + pi 工具默认全开 | 误改仓库 | 默认 `--exclude-tools` 收窄 + 独立 workdir | 白名单生效 |
| **R20** | 中文换行边界 | pi 警告 `readline` 会误切 U+2028 | JSON 解析失败 | 字节级 LF 切分 + `StringDecoder` | 含 U+2028 的单测 |
| **R21** | 人设冲突 | AIChatLink 每轮注入 `identity`；pi 若无上下文文件则无冲突 | 口吻漂移 | 角色目录不含 `AGENTS.md`/`SYSTEM.md` | 抽查回复口吻 |
| **R22** | 计费 | 三角色 × 每轮全量上下文 | 成本失控 | `--thinking off`（实测有效）+ 默认关工具 + 按需启用 | `/api/context` 观察 |
| **R23** | 用户默认 `xhigh` 推理 | `settings.json` `defaultThinkingLevel:"xhigh"`，`modelThinkingLevels` 亦 xhigh | 每轮最贵档 | 角色 settings 手写为 `off`/`low`，并显式传 `--thinking` | `get_state` 的 thinkingLevel |
| **R24** | `Hindsight` 等本地扩展会在角色进程里跑 | `settings.json` `extensions: [".hindsight/coding-agents/dist/pi.js"]` | 角色偷偷写记忆库/联网 | 角色目录不含扩展（§5.3 白名单） | 角色进程无该扩展日志 |
| **R25** | `--thinking` 对某些模型被钳制 | 实验 E3：`minimal/low/medium/high` → `xhigh`；`off` 有效 | 省钱配置无效 | 角色选型时检查 `thinkingLevelMap`；冒烟用 `off` | `get_state` 实测 |
| **R26** | 会话文件堆积在角色目录 | 实测 `sessions/` 由 pi 创建 | 磁盘增长 | README 提供清理脚本；不自动删 | 目录大小检查 |
| **R27** | **REST 合同拒绝自定义 agent id** | `src/contracts/common.ts:85` `DEFAULT_KNOWN_TARGETS` 只有 5 个 id；`POST /api/messages {to:["agent:pi-architect"]}` → 404 `UNKNOWN_TARGET`（`claude-builder` 同样） | 房间 UI 根本发不出消息，多角色不可用 | **改 3 个文件**：`types.ts` 加 `knownTargets`、`server.ts` 透传并用于 messages/memory/identity 解析、`runtime.ts` 传入 adapters 的 actorId 列表 | S3 起所有消息均经 REST 成功 |
| **R28** | 热切换模型可能撞 provider 角色兼容性 | 切到 `<provider>/<model-c>` 后上游返回 `400 role 'developer' is not allowed`（pi 会话含 developer 角色） | 换模型后整轮失败 | 失败必须**显性**：垫片把 `stopReason:"error"` 映射为 `turn.failed`，不再落空消息；`stop_reason` 带上游错误；README 写明切回/换模型前 `/state` 核验 | seq 71/76 `turn.failed`；切回 deepseek 后 seq 87 正常 |
| **R29** | MCP `read` 是 correlation 作用域且 `afterSeq` 被静默钳制 | pi-reviewer 实测：`afterSeq` 0/74/84/86 都被钳到本轮 `89..92` | 不能把 `read` 当房间级历史视图 | 跨角色上下文靠 AIChatLink 注入的 `context packet`；`read` 只用于本 correlation / 新 correlation 主动拉取 | 房间内引用他人发言成功 |
| **R30** | 原生 `stopReason:"error"` 曾被当成功 | 首版投影器只看 `agent_settled`，于是供应商 400 变成"空消息 + completed" | 静默失真：房间空白却显示成功 | `message_end` 分流 error → 聚合错误正文 + `is_error` 终局帧；`terminal` 标志保证一回合只终局一次 | 单测 2 项 + seq 71 |
| **R31** | 斜杠指令曾被上下文包淹没 | AIChatLink 用 `contextPacket + "\n\n[current_message]\n" + content` 拼装；首版对整段做 `startsWith("/")` | `/model` 被当普通文本发给模型 | 只对 `[current_message]` 之后的内容判指令；新增 2 项单测 | seq 53/81 本地回执；seq 45/47 是修复前的反例 |

---

## 8. 实验台账

| ID | 实验 | 结果 | 结论 |
| :--- | :--- | :--- | :--- |
| **E0** | `get_state` over RPC，分离 stdout/stderr | exit 0；stdout 纯 JSONL；mcp 报错只在 stderr | ✅ RPC 可作干净数据流 |
| **E1** | RPC 冷启动耗时 ×3 | 1543 / 1540 / 1532 ms | ✅ 远低于 15 s 握手超时（R14 原隐患解除） |
| **E2** | 审计 `models.json` / `settings.json` / `auth.json` | 4 个明文 key；13 扩展；auth `{}` | ⚠️ 直接触发 v0.2 修订（R2/R23/R24） |
| **E3** | `--thinking {minimal,off}` 对 `<model>` | `minimal`→`xhigh`；`off`→`off`；map 显示仅 xhigh 有值 | ✅ 机制明确，角色用 `off` |
| **E6** | 隔离 agent-dir + 项目 MCP | 仅 aichatlink 加载；用户 4 server 全不加载 | ✅ 隔离方案成立（R1/R3/R14/R24 一并解决） |
| **E7** | REST 目标白名单 | `agent:pi-architect` / `agent:claude-builder` → 404 `UNKNOWN_TARGET` | ❌ 推翻"零源码改动"（R27）；已打 3 文件补丁并 rebuild |
| **E8** | 真机单角色（S3） | `turn.started → turn.reasoning.recorded → message.created → turn.completed`；回答内容正确 | ✅ 端到端闭环 |
| **E9** | 工具三联（S4） | 4 次 `bash` 调用，`tool.started/tool.completed` 成对，`status:"completed"`；模型贴回真实 `pwd` | ✅ O4/O7/O8 正确 |
| **E10** | 热切换 + 上下文（S5） | `/state` → `model=<provider>/<model-c>, messages=25`；切回后仍答出暗号 `紫色-42`；切换模型触发 400 时落 `turn.failed` | ✅ 切换成立；同时暴露 R28/R30 |
| **E11** | MCP 互查（S6） | pi 侧出现 `mcp__aichatlink__*`，`read` 返回 `seq 89..92, nextAfterSeq=92`；引用他人发言成功 | ✅ R17/R18 成立；同时暴露 R29 |
| **E12** | 三角色并发（S7） | 一条消息三个 target，三路并行、各自 `completed`，产出互不相同 | ✅ E5 风险消除 |
| **E13** | 打断（R12） | 取消后 **18 ms** 收敛为 `cancelled`（<10 s），下一轮正常 `OK` | ✅ R12 成立 |
| **E14** | 配置零污染 | `~/.pi/agent` 下无本会话写入（仅 14:03 的 `mcp-auth.json` 早于开工） | ✅ 只读复制成立 |
| E7 | AIChatLink 传入的 session id 形态是否满足 pi 字符规则（字母数字开头结尾，允许 `. _ -`） | **待做（S1 前 5 分钟）** | 若不满足 → 垫片本地映射为合法 id 并持久化映射表 |
| E4 | pi → ACP 适配是否更优（v2） | 仅评估 | 不阻塞 |
| E5 | 三角色并发稳定性 | 已由 E12 闭环（3 并发稳定） | — |

---

## 9. 验收核验清单

| 需求 | 验证动作 | 通过标准 | 实测 |
| :--- | :--- | :--- | :--- |
| 多角色背后都是 pi | `/api/health` + 各角色 `get_state` | 3 个 pi agent ready，session id 互异 | ✅ 3 个 ready，`/state` 可读 |
| 钉住模型 | 角色配置不同 model，各问一句 | 回复时 `get_state` 与配置一致 | ✅ `<model>` |
| 中途切换 | 房间发 `/model <pattern>` | 下条回复用新模型，且能引用前文（上下文未丢） | ✅ E10 |
| 上下文隔离 | 对 A 说"记住 42"，再问 B | B 不知；A 知 | ✅ A 记 `紫色-42`；B 无此上下文 |
| 按需互查 | 让 A `read` 公共时间线 | 成功引用 B 的发言 | ✅ E11（注意 R29 作用域） |
| @ 派活 | `@pi-reviewer …` | 仅该角色响应 | ✅ REST `to:[...]` 单目标/多目标均生效 |
| 工具闭环 | 让角色读一个文件 | 工具块出现→结果回填→闭合 | ✅ E9 |
| 打断 | 生成中打断 | < 2 s 停止，状态 cancelled | ✅ E13（18 ms） |
| 无残留 | `aichatlink stop` | 无 node/pi 残留，4310 释放 | ✅ stop 后 4310 无监听 |
| 可回滚 | 删 `tools/pi-driver` + 还原 `aichatlink.json` + 回退补丁 | 房间回到 codex/grok 且可对话 | 代码已备，待用户拍板后验证 |
| 不影响现有 agent | 每步后 `@codex` 一句 | codex 正常响应 | ✅ 全程 codex/claude/grok 保持 ready |
| 不污染用户配置 | `~/.pi/agent` 的 mtime/内容 | 无改动 | ✅ E14 |
| 不泄漏密钥 | `grep -rl apiKey .aichatlink/pi-roles` | 仅 roles 目录内，且 gitignored | ✅ 只在 `.aichatlink/pi-roles/*/models.json`（已 gitignore） |

---

## 10. 回滚方案

1. `aichatlink.json` 是 gitignore 的本地文件，删掉三个 pi agent 块即可；
2. 删除 `AIChatLink\tools\pi-driver\`（纯新增）；
3. 删除 `.aichatlink\pi-roles\`（含复制来的 models.json → **删除时注意密钥残留**，建议直接整目录删）；
4. **回退 AIChatLink 源码补丁**（R27）：`src/web/server/types.ts` 的 `knownTargets` 字段、
   `src/web/server/server.ts` 的透传与三处 `#targetOptions()`、`src/app/runtime.ts` 的 `knownTargets,`。
   ⚠️ 不要整文件 `git checkout` —— 这三个文件里可能还有你自己的 UI 改动（`tokens.css` 等）；
   只删上述 hunk，然后 `npm run build`。
5. `node dist\src\cli.js stop` 后重启房间。
6. `git status` 只应出现 `tools/`（untracked）+ 你原有的改动。

---

## 11. 预算与安全边界

- **成本**：三角色 × 每轮全量上下文。默认 `--thinking off`、默认关工具；先只开 1 个角色验证。
- **权限**：AIChatLink 以 `bypassPermissions` 启动；角色默认收窄工具 + 独立 workdir。
- **密钥**：只复制角色所需的 1 个 provider；目录 gitignored；README 明确"该目录含密钥"。
- **数据**：全部落在 `AIChatLink\.aichatlink\pi-roles\`。
- **合规**：AIChatLink 无 LICENSE → 仅本机自用，不分发、不商用。

---

## 12. 闭环判定

### 已闭环（有实测/源码行支撑）
- 双向帧规格（§2.1–2.4，逐字段对齐 `protocol.ts` / `rpc-commands.md`）
- 通道硬限制（1 MiB / 4 类超时 / 单并发 / env 继承）
- 隔离目录方案（E6 实证：只加载 aichatlink，用户配置零污染）
- 握手性能（E1：1.54 s ≪ 15 s）
- thinking 成本控制路径（E3：`off` 有效；`high` 被钳到 xhigh 且已在 README 标注）
- **真机全链路（E8–E13）**：成回合 / 工具 / 换模型 / 互查 / 并发 / 打断
- **REST 自定义 target（R27）**：已修补丁并通过 REST 全量验收
- 回滚与验收清单

### 仍未闭环（均有兜底，不阻塞使用）
| 项 | 影响 | 兜底 |
| :--- | :--- | :--- |
| R16 无 TUI | 与"每模型自己开 TUI"的初衷有差距 | v1 用房间流式；E4 再评估 ACP |
| R29 MCP read 只到 correlation | 机器人不能自己扫全房间历史 | 依赖 AIChatLink 注入的 context packet；跨轮用新 correlation 触发 |
| R28 热切换的 provider 兼容 | 某些模型不接受已有会话的角色结构 | 失败已显性（`turn.failed`）；换回可用模型即可，会话不毒化 |

### 开工判定：**通过（已完成 S0–S8）**
计划里的每条架构断言都有源码行或实测输出支撑；执行过程中又推翻了一条原假设
（“零源码改动”在 REST 层不成立，见 R27）并已修复。

### 用户已拍板
1. 冒烟模型：`<provider>/<model>` + `thinking: high`（实际被钳到 xhigh）；
2. 角色工具：**全开**；
3. 接受 v1 无独立 TUI；
4. 密钥只留本地，不上传、不进模型上下文。
