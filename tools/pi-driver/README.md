# pi-driver：把 pi 作为一个角色接进 AIChatLink 房间

`tools/pi-driver/` 是一层**协议垫片**：AIChatLink 以为自己在跟 Claude Code 的
`stream-json` CLI 说话，实际对面是一个常驻的 `pi --mode rpc` 进程。

```
AIChatLink（driver:"claude"）
   │  node entries/pi-architect.mjs --print … --permission-mode bypassPermissions
   │       --mcp-config {…} (--session-id | --resume) <uuid>
   ▼
tools/pi-driver/entries/<role>.mjs → shim.mjs
   │  ① 忽略 AIChatLink 的 Claude 专属 argv，只取 session id 与 --mcp-config
   │  ② 为角色准备隔离目录 .aichatlink/pi-roles/<role>/
   │  ③ 拉起、守护、双向翻译
   ▼
node …/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
     --mode rpc --session-id <uuid> --provider <p> --model <m> --thinking <t>
```

V1 不承诺独立 TUI（RPC 没有 TUI）；对话在房间里以流式气泡呈现。

---

## 1. 安装

```bash
# 1) 依赖已就绪（AIChatLink 仓库根）
npm ci && npm run build
#    想直接用 aichatlink 命令（仓库尚未发布到 npm）：
npm link

# 2) 改角色清单：tools/pi-driver/ROLES.json
# 3) 生成每角色入口 + aichatlink.json 片段
node tools/pi-driver/make-entries.mjs
```

把打印出的 `agents` 片段合并进仓库根的 `aichatlink.json`（该文件已 gitignore），
然后：

```bash
node dist/src/cli.js stop
node dist/src/cli.js start --no-open     # 或 aichatlink start
```

`curl -s http://127.0.0.1:4310/api/health` 里应看到
`pi-architect / pi-reviewer / pi-contrarian` 全部 `ready`。

### 角色配置（`ROLES.json`）

```json
{
  "version": 1,
  "roles": {
    "pi-architect": {
      "model": "<model>",
      "provider": "<provider>",
      "thinking": "high",
      "tools": "all",
      "providers": ["<provider>"],
      "contextFiles": false
    }
  }
}
```

| 键 | 含义 |
| :--- | :--- |
| `model` / `provider` | 钉住的模型；必须是 `~/.pi/agent/models.json` 里存在的组合 |
| `thinking` | `off/minimal/low/medium/high/xhigh/max`，可能被模型 `thinkingLevelMap` 钳制 |
| `tools` | `"all"` 或 `{ "include": [...] }` / `{ "exclude": [...] }` |
| `providers` | **只把这些 provider 复制进角色目录**（缩小密钥暴露面） |
| `contextFiles` | `false` = 不加载工作目录的 `AGENTS.md` / `SYSTEM.md`（房间里由 identity 注入人设） |
| `workdir` | 角色的工作目录；默认**跟随房间 workspace**（AIChatLink 用它给本进程的 `cwd` 启动），相对路径按角色目录解析，显式填写才覆盖 |
| `piArgs` | 追加给 pi 的参数；`--model/--thinking/--session-id/...` 禁止覆盖 |

---

## 2. 模型控制

在房间里对这些角色说话即可（消息里以 `/` 开头，垫片本地执行，**不消耗模型回合**）：

| 指令 | 行为 |
| :--- | :--- |
| `/model <provider>/<model>` | `set_model`，**同一 session** 切模型，上下文保留；写 `.aichatlink/pi-roles/<role>.role.json` |
| `/model` | 显示当前用法与当前模型 |
| `/models` | 列出该角色可用的模型（前 40） |
| `/thinking <level>` | `set_thinking_level` 并持久化 |
| `/state` | 打印 `model / thinking / streaming / messageCount`（最强的事实核验手段） |

AIChatLink 会在用户文本前拼房间上下文包，垫片只按 `[current_message]` 之后的内容识别斜杠指令，
所以上下文里的 `/` 不会被误判。

每条 prompt 前垫片会注入一行宿主事实：

```
[host_agent]
role=pi-architect
provider=<provider>
model=<model>
thinking=high
```

所以角色被问"你是什么模型"时以这行为准，不再靠自述猜。房间"新对话"会把
`resetNativeSessions=true` 传给 AIChatLink，SessionManager 用 `restartFresh` 启动新的 pi session
（`--session-id` 变化），旧对话仍可在历史抽屉中只读回看。

### 模型优先级（setup 与房间 `/model` 的关系）

1. `aichatlink.json` 的 `agents.<role>.model` / `agents.<role>.thinking`（`/setup` 页面写入）
2. `.aichatlink/pi-roles/<role>.role.json`（房间内 `/model` 写的快照）
3. `tools/pi-driver/ROLES.json`

Claude 适配器会把 (1) 作为 `--model` / `--effort` 追加到垫片 argv；垫片解析后覆盖 (2) 与 (3)。
因此：**setup 里钉住的值在重启后生效，房间内 `/model` 只影响当前进程**。想恢复 setup 值，重启或再发一次 `/model`。
`--effort` 会被 pi 的 `thinkingLevelMap` 钳制（例如 `medium` 在该模型映射为 `high`），以 `/state` 为准。

---

## 3. 角色目录与密钥纪律

`.aichatlink/pi-roles/<role>/` 只会有：

| 文件 | 来源 |
| :--- | :--- |
| `models.json` | 从 `~/.pi/agent/models.json` 复制，**按 `providers` 裁剪** |
| `settings.json` | 垫片生成，只含 `defaultProvider/defaultModel/defaultThinkingLevel/compaction` |
| `mcp.json` | 由 AIChatLink 的 `--mcp-config` 翻译，通常只有 `aichatlink` 一个 server |
| `sessions/` | pi 自己的会话文件 |
| `work/` | 角色工作目录 |

绝不复制：`extensions/`、`agents/`、`skills/`、`SYSTEM.md`、`AGENTS.md`、`mcp-auth.json`。

> ⚠️ **角色目录含明文 API Key**（`models.json`）。它在 `.aichatlink/` 下、已 gitignore，
> 不要提交、不要打包、不要上传；删除角色时整目录删除。

---

## 4. 自检与验收

```bash
node --test tools/pi-driver/test/lines.test.mjs \
           tools/pi-driver/test/frames.test.mjs \
           tools/pi-driver/test/shim-smoke.test.mjs        # 34 项，全离线

node tools/pi-driver/dev/room.mjs send pi-architect "你好"
node tools/pi-driver/dev/room.mjs watch 60                 # 轮询房间事件
node tools/pi-driver/dev/room.mjs send-all "同一个问题"
node tools/pi-driver/dev/interrupt-test.mjs                # R12：打断 < 10 s
```

已在本机实测通过（2026-11-16，AIChatLink 0.1.16 / pi 0.99.2 / <model>）：

| 能力 | 证据 |
| :--- | :--- |
| 单角色成回合 | `turn.started → message.created → turn.completed` |
| 工具闭环 | `tool.started / tool.completed` 成对，`status:"completed"` |
| 中途换模型 | `/state` 返回 `model=<provider>/<model-c>`，`messages=25` |
| 上下文保留 | 换模型 + 运行时重启后仍答出旧暗号 `紫色-42` |
| MCP 互查 | pi 侧出现 `mcp__aichatlink__*`，`read` 返回 `seq 89..92` |
| 三角色并发 | 一条消息三个 target，三路各自 `completed` |
| 打断 | 取消请求后 **18 ms** 收敛为 `cancelled`，且下一轮可继续 |
| 隔离 | 角色只加载 `aichatlink` 一个 MCP；`~/.pi/agent` 无写入 |

---

## 5. 排错码表

| 现象 / 日志 | 含义 | 处理 |
| :--- | :--- | :--- |
| `UNKNOWN_TARGET`（发消息 404） | AIChatLink REST 合同用静态 target 白名单，不认识自定义 agent id | 本仓库已修：`knownTargets` 由 runtime 传入（见 §7）；若重新 clone 上游需重打 |
| `role_not_found` | `ROLES.json` 里没有入口文件写的角色 | `node make-entries.mjs` 重新生成 |
| `models_unreadable` / `provider_unknown` | 角色目录拿不到 provider 目录，或 `providers` 写了不存在的名字 | 检查 `~/.pi/agent/models.json` 与 `ROLES.json` |
| `mcp_config_invalid` | `--mcp-config` 结构不对（要求 `mcpServers`，`command` 绝对路径） | 看 AIChatLink 侧注入 |
| `pi_entry_not_found` | 找不到 pi 的 `dist/bundle/cli.js` | 设 `PI_SHIM_PI_ENTRY` |
| `line_too_large` | 单行超过 1 MiB | 已做聚合帧降级；若仍出现说明模型单条输出过大 |
| 房间显示 `turn.failed`（`TURN_INTERRUPTED`） | 原生模型调用失败（如换到不接受 `developer` 角色的模型） | 看 pi session 里的 `stopReason/errorMessage`；`/model` 切回可用模型 |
| 空回复但 `completed` | 旧版垫片把 `stopReason:"error"` 当成功 | 已修：现在会落 `turn.failed` |
| `session.id.mapped` | AIChatLink 传的 session id 不满足 pi 字符规则，垫片做了确定性哈希 | 正常，同一 id 始终映射到同一 session |
| `argvDropped: N` | Claude 专属 argv 被丢弃的数量 | 正常（`--print` / `--permission-mode` 等） |

---

## 6. 日志

- 垫片日志走 **stderr**（stdout 只有协议），一行一个 JSON，事件名如
  `role.prepared` / `pi.exit` / `turn.steer` / `pi.stdout.unparsable`。
- 原生 pi 的会话文件在 `.aichatlink/pi-roles/<role>/sessions/<cwd-slug>/*.jsonl`，
  排查 `stopReason`、`errorMessage`、`usage` 以它为准。

---

## 7. knownTargets：已并入产品（0.1.16）

早期版本里 `DEFAULT_KNOWN_TARGETS` 是静态列表（`agent:codex/grok/kimi/hermes/claude`），
任何额外 agent id（`agent:pi-architect` 等）都会被 `POST /api/messages` 以
`UNKNOWN_TARGET` 拒绝，而 MCP 通道却不拒绝。

**当前主线已修复**：`src/app/runtime.ts` 在建立 HTTP server 时把已注册 adapter 的 `actorId`
作为 `knownTargets` 传入，`src/web/server/server.ts` 在 `/api/messages`、`/api/memory`、
`/api/identity` 的解析处透传，`src/contracts/validation.ts` 只对「已注册 target」放行。
因此本仓库 clone 出来即可直接使用 pi 角色，**不需要再打补丁**。

只有在更老的 checkout（未包含 `knownTargets`）上才需要按下面三处补齐，然后 `npm run build`：

| 文件 | 改动 |
| :--- | :--- |
| `src/web/server/types.ts` | `AIChatLinkHttpServerOptions.knownTargets?: readonly string[]` |
| `src/web/server/server.ts` | 透传该选项，并在三处解析调用里传入 |
| `src/app/runtime.ts` | 把 adapters 的 `actorId` 列表传给 HTTP server |

---

## 8. 回滚

```bash
# 1) 停房间
node dist/src/cli.js stop

# 2) 移除 pi 角色（aichatlink.json 是 gitignore 的本地文件）
#    删掉 agents 里的 pi-architect / pi-reviewer / pi-contrarian 三块

# 3) 删除垫片与角色目录（角色目录里有密钥副本，整目录删）
rm -rf tools/pi-driver .aichatlink/pi-roles

# 4) 不需要回退 AIChatLink 源码：knownTargets 已是产品行为（见 §7）

# 5) 重启
node dist/src/cli.js start --no-open
```

`git status` 应只剩你自己的改动。
