# 计划书：多工作目录（workspaces）+ 会话优先界面

| 项 | 值 |
| :--- | :--- |
| 状态 | **已实施并通过验收（2026-11-17）** |
| 目标仓库 | 仓库根（基线 `73e7b86`） |
| 日期 | 2026-11-17 |
| 关联决策 | **D-040（本计划：多工作目录 hub + 会话优先壳层）**；D-038（旧对话续聊 + 对话目录）；D-034/D-035（会话纪元与只读回放）；D-036（房间 workspace）；D-037（计划域名册） |

## 1. 用户需求

1. 顶栏三个无效标签（实时连接 / `room:main` / 工作目录徽标）删除。
2. 输入器工作目录前加「＋」图标，点击在应用内快速切换工作目录，不再跳 `/setup` 后台选择。
3. **多个工作目录同时运行**，允许同时推进多份计划；切走不会停掉原目录里的 Agent。
4. 左侧 Agent 名册移到顶栏 `AIChatLink` 同一行；重启/配置改为两个小图标，不带文字。
5. 左侧整列让给对话；对话记录按工作目录分组。

## 2. 结论（专家会诊后的取舍）

**一个 hub origin + 每个目录一个完整 `AIChatLinkRuntime`（同进程）+ 反向代理。**

- 不共享 SQLite：每个 workspace 一个 `aichatlink.db`，`OPEN_FILE_DATABASES`、`recoverStaleRuntimeRecords`、`instance:web/binding:web` 都按库隔离，避免跨目录把对方的活 binding 标成 stale。
- 不共享 `AdapterRegistry`：adapter 是有状态单例，必须一 runtime 一套。
- 不给子 runtime `setupApi`：配置仍以主 `aichatlink.json` 为唯一事实源，子 runtime 的配置是内存派生，避免一次保存把主配置改写成派生 workspace。
- 子 runtime 用 `port: 0`，监听端口仍是「单 runtime 租约」；hub 只在内存中保存子 origin，不暴露给浏览器。
- 子 runtime identity 不带 `runtimeScopeKey`，`/api/runtime/shutdown` 在子 runtime 上 404；hub 对任何带 `ws` 的 shutdown 请求也 404。
- 切目录 = `/?ws=<id>` 整页重载。EventSource、seq 游标、`conversationView`、在飞提交一次性归零，杜绝跨 workspace 状态污染；原 workspace 的 runtime 继续在后台跑。
- 会话 id 在每个 workspace 内是本地自增（`conv:1`），因此隐藏集合、恢复请求都必须按 `(ws, conversationId)` 作用域化。

不选「多 room 重构」：`AgentSessionManager` 以 actor 为键、`roomId` 贯穿 broker/context/SSE，且会与未提交的 resume/TOC 改动正面冲突；留作未来真正的 room 表方案。

不选「子进程 supervisor」作为第一步：同一套 supervisor/proxy 接口后面可替换；先做同进程，减少 Windows 进程树与孤儿回收风险。崩溃隔离的代价在后续版本再付。

## 3. 后端模块

### 3.1 新增

| 文件 | 职责 |
| :--- | :--- |
| `src/contracts/workspaces.ts` | `WorkspaceSummary` / list / create / delete / restart 的 zod 合同与 parse 函数 |
| `src/app/workspaces/registry.ts` | `.aichatlink/workspaces.json` 读写；`workspaceIdForPath()`；realpath + win32 casefold；原子写；上限 8 |
| `src/app/workspaces/derive-config.ts` | 从主配置派生一个 workspace 配置：workspace、storage、agent/assistant cwd 重指向；不修改入参 |
| `src/app/workspaces/supervisor.ts` | 子 runtime 生命周期、start/stop flight 串行化、list/create/remove/restart、closeAll；proxy 目标解析 |
| `src/web/server/workspace-hub-routes.ts` | hub 路由：`GET/POST /api/workspaces`、`DELETE /api/workspaces/:id`、`POST /api/workspaces/:id/restart`；写路由要求 `x-aichatlink-setup: 1` |
| `src/web/server/workspace-proxy.ts` | 把 `?ws=` 请求转发到子 origin；剥掉 `ws`；SSE 流式；独立 socket 集合，不进入 drain 等待 |

### 3.2 修改

- `src/adapters/types.ts`：`LaunchProfile.env?: NodeJS.ProcessEnv`。
- ACP / Claude / Codex 三个 spawn 点：`env: input.env === undefined ? undefined : { ...process.env, ...input.env }`。
- `src/app/session-manager.ts`：新增 `launchEnv?`，`#launchProfile` 合并 env；仅当显式提供时设置，主 runtime 行为不变。
- `src/app/context-summarizer.ts` / `src/app/operator-runtime.ts`：同样的 `env` 透传，避免压缩/助理用回全局 pi 角色目录。
- `src/app/runtime.ts`：`AIChatLinkRuntimeOptions` 新增 `workspaceHub?`、`workspaceRouting?`、`agentEnv?`、`beforeClose?`；HTTP server 透传；`#performClose` 在 `beginClose()` 之后执行 `beforeClose`（子 runtime 先关，hub 监听保持租约）。
- `src/web/server/server.ts`：
  - `#handle` 开头处理 `/api/workspaces*`（hub 路由，带 `ws` 直接 404）。
  - 紧接着解析 `ws`：primary → 删除参数本地服务；child ready → 代理；child starting/failed → 503 `WORKSPACE_NOT_READY`；未知 → 404。
  - `/api/runtime/shutdown`、`/api/setup*`、`/mcp*` 带 `ws` 一律 404。
  - `beginClose()` 销毁代理 socket；代理不放入 `#requestControllers`，不阻塞 `drain()`。
- `src/core/errors.ts` + `src/contracts/validation.ts`：新增 `WORKSPACE_NOT_READY`（503）。
- `src/main.ts`：构造 `WorkspaceSupervisor`，注入 runtime；启动后 `void supervisor.startRegistered()`；SIGINT 仍只调 `runtime.close()`，由 `beforeClose` 级联子 runtime。
- `src/contracts/index.ts`：导出新合同。

### 3.3 派生配置规则

```
primaryWorkspace = config.workspace ?? 所有 agent 共同 cwd ?? 配置目录
child.workspace = entry.path
agent.cwd = sameDirectory(agent.cwd, primaryWorkspace) ? entry.path : agent.cwd
assistant.brain.cwd 同理
child.storage.path = <primaryStoreDir>/workspaces/<wsId>/aichatlink.db
child 不携带 setupApi
child runtime: { port: 0, agentEnv: { PI_SHIM_ROLES_ROOT: <primaryStoreDir>/workspaces/<wsId>/pi-roles } }
```

`workspaceId = "ws_" + sha256(realpath(path) 规范化后再 win32 casefold).slice(0,12)`；重复注册同一目录返回原 id，不新建数据库。

### 3.4 生命周期与失败语义

- 启动：registry 读失败 → 记日志并按空表启动（不阻塞主房间）；子 runtime 启动失败 → 条目保留，状态 `failed` + `errorCode`，`/api/workspaces` 可见，可 restart。
- 创建：目录不存在 / 不是目录 / 超过 8 个 / 路径等于主 workspace（返回主条目）分别给出明确结果；成功后立刻返回 `starting`，后台启动。
- 删除：主 workspace 409；子 runtime 先关（受 `timeouts.closeMs` 约束）再删 registry；数据目录保留。
- 代理：子 runtime 未 ready → 503；未知 id → 404；客户端断开 → 销毁上游请求。
- 关闭：hub `beginClose()` → 子 runtime 逆序 close（每个有界）→ 主 runtime 常规关闭 → 释放监听端口。`/api/runtime/shutdown` 与 SIGINT 走同一条路。

## 4. 前端状态

```
activeWorkspaceId  // 唯一事实源 = URL ?ws=；缺省 = primary
workspaces         // /api/workspaces
conversationsByWs  // Map<wsId, ConversationSummary[]>
conversationView   // 仍只属于当前页面/当前 workspace
state.lastDurableSeq / agents / turns // 仍只属于当前 workspace
```

- 首次加载：`GET /api/workspaces` → 决定 activeWs → 再并行 `/api/bootstrap?ws=`、`/api/setup`（仅 primary 用于名册待重启提示）、`/api/conversations?ws=`、其余 workspace 的会话列表。
- 切换：`location.assign("/?ws=<id>")`；跨 workspace 点会话：`/?ws=<id>&conv=<conversationId>`，加载后调用现有 `enterConversationView()`。seq 空间不互通，绝不回放源 workspace 的 range。
- 隐藏会话键：`<wsId>::<conversationId>`；旧的未加前缀键按 primary 兼容读取。
- 左栏：每个 workspace 一个 group（label、path、状态点、会话数）；primary 优先，其次 registry 顺序；失败组显示错误与「重试」；hover 显示「移除」（primary 不显示）。
- 顶栏：`[侧栏开关] [品牌] [agent chips…] [连接点] [公共记忆] [助理] [配置] [主题]`。
  - agent chip：头像 + 名称 + 状态点；hover/focus 显示 `⟳` 重启与 `⚙` 配置两个图标按钮（`aria-label`/`title` 完整说明，无文字）。
  - 公共记忆移入 `<dialog id="memory-dialog">`，由顶栏 `◆` 打开；左栏不再有记忆/名册/本地说明。
- 输入器：`＋` 工作目录按钮 → `#workspace-dialog`：
  - 已添加列表（点击切换/移除）；
  - 目录浏览：快捷入口、上级、子目录（git 标记）、当前目录「使用此目录」；
  - 新目录：`POST /api/workspaces` 后轮询 `/api/workspaces` 直到 `ready|failed`，ready 后跳转。
- 连接状态改为 7px 圆点（`data-state` + `title`/`aria-label`），无文字。

## 5. 文件级实施顺序

1. `contracts/workspaces.ts` + `app/workspaces/registry.ts` + `derive-config.ts` + 单测。
2. `LaunchProfile.env` + 三个 adapter + `session-manager` + 两个 out-of-band profile 构造器 + 单测（主 runtime 无 env 时 argv/spawn 不变）。
3. `app/workspaces/supervisor.ts`（注入 `createRuntime` 工厂）+ 生命周期单测。
4. `web/server/workspace-hub-routes.ts` + `workspace-proxy.ts` + server 接线 + 代理/SSE/503/404 测试。
5. `runtime.ts` / `main.ts` 接线 + 级联关闭测试。
6. `web/index.html` / `web/styles.css` 重排：顶栏名册、左栏会话、记忆 dialog、工作目录 dialog。
7. `web/app.ts`：workspace 状态、分组渲染、跨 workspace 点击、picker、连接点、事件 URL。
8. 文档：hub 决策条目、WEB_UI 布局与组件、PROTOCOL 的 hub 路由、STORAGE 的 per-workspace DB。
9. `npm run typecheck && npx vitest run && npm run build`；真实启动 + 两目录切换 + 会话隔离验收。

## 6. 验收

- [ ] 顶栏无 `实时连接` / `room:main` / 工作目录文字徽标；只有连接点。
- [ ] 名册在顶栏；每个 Agent 有 `⟳` 与 `⚙` 两个图标按钮，无文字。
- [ ] 左栏只有按 workspace 分组的会话；可点他组会话直接跳转并打开。
- [ ] 输入器 `＋` 可在应用内浏览目录、添加/切换/移除 workspace。
- [ ] 两个 workspace 同时运行；A 中发起的回合切到 B 再切回 A，A 的回合完成且时间线完整。
- [ ] pi 角色目录按 workspace 隔离：两个 workspace 的 `PI_SHIM_ROLES_ROOT` 不同，无 `mcp.json`/sessions 互写。
- [ ] 关闭 hub 后所有子 runtime 的端口不再应答、SQLite 可重新打开。
- [ ] `?ws=` 未知 404，未 ready 503，`/api/runtime/shutdown?ws=` 404。
- [ ] `npm run typecheck`、`npx vitest run`、`npm run build` 全绿；1600/1280/430 三档无横向滚动。

## 7. 回滚

- 删除 `workspaces.json` 即回到单 workspace；子数据库留在 `.aichatlink/workspaces/` 不删除。
- 后端新路由全部可选注入；不注入时 `/api/workspaces` 404，行为与 0.1.16 一致。
- 前端在 `/api/workspaces` 404 时自动退化为单 workspace（不显示分组头与 `＋` 弹层），保证旧 runtime 仍可用。
