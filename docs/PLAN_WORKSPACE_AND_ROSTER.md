# 计划书 v2.1：房间工作目录（workspace）与 Agent 名册重构

| 项 | 值 |
| :--- | :--- |
| 状态 | **已实施并通过验收（workspace + 计划域名册）；本文件保留为设计与验收依据** |
| 目标仓库 | 仓库根（HEAD `7c3aa9c` + 未提交改动） |
| 日期 | 2026-11-16 |
| 版本 | v2.1（v2.0 + 两轮独立对抗评审的采纳结果，见 §4.4） |
| 交付形态 | 本文件（设计 + 逐文件实施规格 + 验收命令 + 回滚）。实施时按 §7.11 追加决策条目 |

**一句话实施：**

> 按 `docs/PLAN_WORKSPACE_AND_ROSTER.md` 的 §7 顺序（7.1 → 7.2 → 7.3 → 7.4 → …）实施，§7.1 的 2/3/4 步必须原子完成并立即跑 `npm run typecheck`；每完成一个里程碑跑 §12 对应验收命令；除 §9 列明的边界外不得改变既有行为。

---

## 0. 怎么读

| 你是 | 读哪几节 |
| :--- | :--- |
| 评审/产品 | §1–§5（目标、证据、讨论、决策对冲） |
| 实施者 | §6 + §7（逐文件规格，含可粘贴代码）+ §12（验收命令） |
| 验收者 | §11（测试矩阵）+ §12（验收清单）+ §17（可行性证据） |
| 回滚者 | §15 |

---

## 1. 目标与非目标

### 1.1 目标

- **R1** 房间有一等的工作目录 `workspace`；换文件夹后所有 Agent（含房间助理）随之改变，不逐个改。
- **R2** `/setup` 提供应用内目录选择器（逐层进入、快捷入口、`git` 标记）+「在资源管理器中打开」。
- **R3** 房间级默认 + 单 Agent 可覆盖。
- **R4** 新增「总管」统筹派单；名册收敛为**计划域**（提案/审查/批判/核验/设计），不含实现角色；身份短、通用、带四段契约。
- **R5** 每条需求都有可执行测试与证据；未验证项显式列出。

### 1.2 非目标

- 多房间/多项目（需 room 表，见 D-2 改判条件）。
- 运行中热切 cwd。
- 改 `transport` / `access` / approval 合同。
- 写用户全局 CLI 配置。
- 远程/云端目录浏览。

---

## 2. 触发证据（实测）

| # | 现象 | 证据 |
| :--- | :--- | :--- |
| E1 | `/setup` 每个 Agent 一个 `cwd` 文本框，7 条全写死同一绝对路径 | `aichatlink.json`；用户截图 18:43 |
| E2 | 无目录浏览入口 | 同上 |
| E3 | 用户要求「工作目录随工作文件夹改变并同步」「三个 pi 角色不够用」「身份写得极差」 | 用户 18:43 / 18:44 |
| E4 | 三个 pi 身份职责重叠、无边界 | 旧 `identity` |
| E5 | **pi 垫片把工作目录钉在私有目录**：`@实现` 的 `process.cwd()` = `.aichatlink/pi-roles/pi-reviewer/work` | 实测（可行性验证期） |
| E6 | GBK 控制台 `curl` 发中文 → 正文乱码，Agent 拒答 | 实测事件 seq 275 |

---

## 3. 现状锚点（实施前基线，已实测）

| 关注点 | 位置 | 现状 |
| :--- | :--- | :--- |
| 配置模型 | `src/config.ts` | `agents[].cwd` 必填；无 `workspace`；`assistant.brain.cwd` 必填 |
| Setup 契约 | `src/contracts/setup.ts` | 草稿无 `workspace`；`agents[].cwd`、`assistant.brain.cwd` 必填 |
| Setup 服务 | `src/app/init-config.ts` | `configToDraft` / `draftToDocument`；保存 `JSON.stringify(document)` |
| 会话恢复 | `src/app/session-manager.ts:214` | `binding.capabilities.cwd !== configured.cwd` → **跳过 resume**（改 workspace 必然换新 native session） |
| HTTP 面 | `src/web/server/server.ts`、`src/web/setup/server.ts` | 两套静态白名单；`/api/setup` GET/POST；无目录浏览 |
| 静态资源 | 两处 `STATIC_ASSETS` / `STATIC_FILES` | 新增浏览器模块必须两处同时登记 |
| 设置页 | `web/setup.{html,ts,css}` | 每 Agent 一张卡；`.agent-cwd` 带 `required`；本地类型 `AgentDraft.cwd: string` |
| 名册消费点 | `web/app.ts:2492`、`web/agent-roster.ts:40` | 把 roster 的 `cwd` 当必填：空值渲染成「cwd 未报告」，差异比较失真 |
| 主界面 | `web/app.ts`、`web/index.html` | 顶栏只有 `room:main`；启动已拉 `/api/setup` |
| pi 垫片 | `tools/pi-driver/{shim,role-dir}.mjs` | `workDir = ROLES.workdir ?? <roleDir>/work`；`spawn(pi,{cwd:workDir})` |
| 名册 | `aichatlink.json`（gitignore） | **7 条**：4 条停用传统驱动 + 3 个 pi 启用 |

基线校验（回退后实测）：`npm test` **63 文件 / 646 用例**通过；`readiness=ready`，3 个 pi ready；`/api/setup/workspace` → 404；`/setup` 无 `.workspace-card`；名册 `3/7`。

---

## 4. 讨论与对冲

### 4.1 第 1 轮：需求澄清

- 「打开工作文件夹」= 选择目录 + 在资源管理器打开（选择为主、reveal 为辅）。
- 目录归属：房间级 + 单 Agent 可覆盖。
- 选择器：应用内（可测、不阻塞、跨平台）。
- 名册规模：计划域 6 角色（总管 + 提案 + 审查 + 批判 + 核验 + 设计）。用户明确「本项目只负责计划的提出、审查、批判、核验及最终的敲定，不负责具体计划的实施」，因此不设实现者；后续补充「缺一个专门管 UI、布局、色调设计、负责宏观布局敲定的 agent」，于是加设计角色。
- 保留意见：未要求多房间；若不排期，`workspace` 只能随配置文件走。

### 4.2 第 2 轮：方案对冲

| 方案 | 反方一击 | 结论 |
| :--- | :--- | :--- |
| A 只改配置层 | E5 未解，pi 仍在私有目录 | 否决 |
| B 每 Agent 独立下拉 | 与「随文件夹同步」直接冲突 | 否决 |
| C 系统原生对话框 | 阻塞请求、可能被遮挡、无法自动化测试 | 否决 |
| D 房间级 + 应用内 + reveal + 垫片跟随 | 并发写同一仓库；大目录慢；保存可能展开 cwd | **采用**（用名册分工、跳噪目录、双 document 写简写化解） |

### 4.3 第 3 轮：实现后复盘（已回退）

真做完才暴露的三个坑，已写进本版规格：

1. 保存若直接序列化「填充后的 config」，继承者会变成 10 份显式 `cwd` → 双 document（§7.3）。
2. 垫片 `workDir` 覆盖继承 cwd → 三级回退（§6.7）。
3. 目录接口需 `Allow` 头、`no-store`，否则前端/代理判断出错（§7.7）。

### 4.4 第 4 轮：两轮独立对抗评审（reviewer / planner）与采纳结果

评审输入：v2.0 全文 + 仓库代码抽查。输出 27 条，逐条裁决：

| # | 发现 | 裁决 | 落到本版哪里 |
| :--- | :--- | :--- | :--- |
| 1 | 保存不校验 workspace 是否存在 → 坏路径落盘、重启全部 spawn 失败 | **采纳（阻断）** | §6.3、§7.3、F1、§11 |
| 2 | `configToDraft` 投影未解析值（新装为 `.`），徽标却要显示绝对路径末两段 | **采纳（阻断）** | §6.2 加 `workspaceResolved`、§7.3、§7.8 |
| 3 | 改 workspace 会因 `capabilities.cwd` 失配跳过 resume → 全房间新 native session | **采纳（重要）** | §6.1、§8、W-019 |
| 4 | W-019 用 `/api/health` 证明 cwd 不可能（health 无 cwd） | **采纳** | §12.5 改用 `/api/bootstrap` |
| 5 | `web/app.ts` / `web/agent-roster.ts` 把 roster cwd 当必填 | **采纳** | §7.8 |
| 6 | 助理 `brain.cwd` 未定义归属 | **采纳**：助理同样继承 + 可覆盖 | §6.1、§7.2、§7.3、§7.8 |
| 7 | W-019 声称「显式 cwd 仍覆盖」但验收只测继承 | **采纳** | §12.4 加覆盖用例 |
| 8 | 垫片回退链三级里第三级是死代码；`role.workdir` 相对语义变化 | **采纳** | §6.7 改为显式 `options.workDir ?? role.workdir ?? <roleDir>/work`，并规定 relative `workdir` 相对角色目录 |
| 9 | 列表无 signal/超时，UNC/断网盘会挂死请求 | **采纳** | §6.4、§7.5、F2 |
| 10 | `entries` 超限会抛 400/500；排序未定义 | **采纳** | 排序 + 截断 + `truncated` 字段（§6.2、§7.4） |
| 11 | §7.3 片段缺 `agents` 映射；可选 cwd 直接 `.trim()` 会崩 | **采纳** | §7.3 给完整映射 |
| 12 | §3 名册条数写错（7 写成 10） | **采纳** | §3 已改 7→10 |
| 13 | `make-entries.mjs` 输出的片段含 `cwd`，与「去掉 cwd」冲突 | **采纳** | §7.10 明确处理 |
| 14 | workspace 指向仓库根后，`.aichatlink/`（db/session/role dir）就在每个 Agent 的 cwd 里，`tools:all` 下可被删改 | **采纳（风险）** | §10、§16 |
| 15 | `SetupWorkspaceApi` 声明在 §7.7，但 §7.5/7.6 先引用 → 编译不过 | **采纳（阻断）** | §7 重排：类型先行 |
| 16 | §7.1 的 optional cwd 与 transform 必须原子 | **采纳（阻断）** | §7.1 标注「原子提交 + 立即 typecheck」 |
| 17 | `web/setup.ts` 本地类型仍必填，客户端永远带 cwd；`exactOptionalPropertyTypes` 下不能赋 `undefined` | **采纳** | §7.8 明确 `cwd?: string` + `delete` |
| 18 | `.agent-cwd` 的 `required` 会拦住「跟随」（空值） | **采纳** | §7.8 去掉 `required` + 勾选即 `disabled` |
| 19 | §12.2/12.3 没写 build+restart 前置；`aichatlink start` 幂等复用旧进程会误判 | **采纳** | §12.0 前置 |
| 20 | §12.3 第一条丢正文却要断言正文；wizard 服务端未覆盖 | **采纳** | §12.3 拆成两条 |
| 21 | §12.4 无可执行载体 | **采纳** | §12.4 改为纯 API 脚本（`scripts/verify-workspace-save.mjs`）+ 明确断言 |
| 22 | 保存时若「与 workspace 比对后删 cwd」会打破既有测试（既有用例断言 `cwd: "."` 落盘） | **采纳** | §7.3 定死：**保存只按 draft 原样写，不比对/不删除**；继承由投影产生 |
| 23 | `WorkspaceDependencies` 全必填但以无参调用；默认实现位置未写 | **采纳** | §7.5 给 `systemWorkspaceDependencies` |
| 24 | `methodNotAllowed` 签名写错；`no-store` 必须在 `writeJson` 前 | **采纳** | §7.7 用真实签名 |
| 25 | 总管身份写「用 ask」，但 pi 侧工具实名/暴露方式未核实，可能派单失败 | **部分采纳**：实测派单链已成功（§17），故不改 `mcp.json` 暴露；改为在身份里写「aichatlink 的 ask 工具」并在 M5 记录实际工具名 | §6.8、§17 |
| 26 | 超过契约上限的 `entries` 会被 `parseContractOutput` 变 500 | **采纳** | 同 #10 |
| 27 | 风险表缺「共享目录 + `tools:all`」的安全面 | **采纳** | §16 |

> 结论：v2.1 修掉全部 5 条阻断、15 条重要、7 条次要；1 条部分采纳（有实测反例）。

---

## 5. 决策对冲表

| # | 决策 | 正方 | 反方 | 替代（为何否决） | 改判条件 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| D-1 | 房间级 workspace + 单 Agent 覆盖 | 一处改全体跟随 | 共享目录并发写 | 纯强制（无例外） | 多仓库并行成为常态 → room 表 |
| D-2 | workspace 存配置文件 | 不改事件模型 | 多房间无法表达 | 存 DB（当前无 room） | 多房间排期 |
| D-3 | 保存写简写（投影产生继承） | 不膨胀、语义保真 | 裸读看不到最终值 | 保存写展开值（丢语义） | 外部工具只读配置 → 提供 `config show --resolved` |
| D-4 | 应用内目录浏览器 | 可测/不阻塞/跨平台 | 不如系统对话框顺手 | 系统对话框（阻塞/遮挡/难测） | 需要网络邻居/特殊命名空间 |
| D-5 | reveal 需 `x-aichatlink-setup: 1` | 阻断跨站简单请求 | 前端多写一个头 | 不加头（任意网页驱动本机外壳） | 永不 |
| D-6 | cwd 变更需重启（且换新 session） | 不破坏会话/绑定对应 | 用户感知"上下文没了" | 热切（破坏不变量） | 原生 CLI 支持受控迁移 |
| D-7 | 垫片 workdir 跟随继承 cwd | 功能真正生效（E5） | 失去角色间目录隔离 | 强隔离（平台差异大） | 需强隔离 → ROLES 显式 `workdir` |
| D-8 | 6 个计划域角色（无实现者） | 覆盖提案/审查/批判/核验/版式 + 总管统筹 | 少一个"落地"视角 | 含实现者（与产品定位冲突）/8（更贵） | 需要安全或测试视角 → 归入审查角色的必查项，或按 §7.9 追加 |
| D-9 | 身份短 + 四段契约 | 换模型不崩、可拼接 | 可能限制发挥 | 自由格式（无法对比） | 驱动支持输出 schema |
| D-10 | 身份写「不做写操作」 | 减少误写 | 与实现者职责张力 | 靠调用方约束（历史失效） | 引入逐轮授权 |
| D-11 | 助手同样继承 workspace | 房间只有一个工作目录 | 助手是操作员、可留在配置目录 | 助手固定 `"."`（两个目录并存） | 助手需要独立目录时用覆盖 |
| D-12 | 保存时校验 workspace 存在且是目录 | 避免坏路径落盘后全员崩 | 无法预先保存"待创建"路径 | 不校验（重启才炸） | 支持"先配置后建目录" → 加 `allowMissing` |
| D-13 | 列表超限截断 + `truncated` | 不会 500 | 用户可能看不到全部目录 | 报 400（用户无法进目录） | 引入分页 |

---

## 6. 设计规格

### 6.1 配置语义

```jsonc
{
  "transport": "structured",
  "workspace": "<repo>",
  "agents": {
    "pi-lead": {
      "driver": "claude",
      "identity": "……",
      // cwd 省略 = 跟随 workspace
      "enabled": true
    }
  },
  "assistant": {
    "enabled": false,
    "brain": {
      "driver": "codex",
      "command": "codex"
      // brain.cwd 省略 = 跟随 workspace（与 worker 同语义）
    }
  }
}
```

解析：`agents[].cwd ?? workspace ?? "."`、`assistant.brain.cwd ?? workspace ?? "."`，最后相对配置文件目录解析。

**必须写进文档的用户可见后果**：`session-manager.ts:214` 用 `binding.capabilities.cwd !== configured.cwd` 判断能否 resume。改 workspace（或改某 Agent 的 cwd）后重启，对应 Agent 会以**全新 native session** 启动（旧原生上下文不延续；AIChatLink 自身 transcript 不受影响）。

### 6.2 契约

| 名称 | 形态 |
| :--- | :--- |
| `SetupConfigDraft.workspace` | `z.string().trim().max(4096).optional()`（空串=未设置） |
| `SetupAgentDraft.cwd` | 可选（空/缺省=跟随） |
| `SetupAssistantDraft.brain.cwd` | 可选（空/缺省=跟随） |
| `SetupSnapshot.workspaceResolved` | `z.string().trim().min(1).optional()`：**绝对路径**，供徽标/提示展示；不参与保存 |
| `WorkspaceDirectory` | `{ name, path, isRepository }` |
| `WorkspaceListing` | `{ path, parent: string\|null, shortcuts: WorkspaceDirectory[], entries: WorkspaceDirectory[], truncated: boolean }` |
| `WorkspaceRevealRequest/Response` | `{ path }` / `{ opened: true, path }` |
| `GET /api/setup/workspace?path=` | 200；缺省=进程 cwd；不可读/非目录/超时 → 400 |
| `POST /api/setup/workspace/reveal` | 需 `x-aichatlink-setup: 1`；200 / 400 |
| 错误形态 | `toSafeErrorBody`；方法不符 `405 + Allow`；命中 workspace 路由时 `Cache-Control: no-store` |

### 6.3 Setup 服务：投影、校验、保存

1. `workspaceResolved`：`path.resolve(path.dirname(configPath), draft.workspace ?? ".")`（仅展示）。
2. `configToDraft`：`workspace = config.workspace ?? sharedAgentCwd(config) ?? ""`；与 workspace 相同的 Agent / 助理**省略 `cwd`**（编辑器显示"跟随"）。
3. `save` 校验：`workspace` 非空时，解析后必须 `stat().isDirectory()`，否则 `AICHATLINK INVALID_ENVELOPE`（400），**不落盘**。
4. `draftToDocument`：返回 `{ document, config }`
   - `document`：`workspace` 非空才写；Agent / 助理 `cwd` **有值才写**（不做与 workspace 的比对，不主动删除）；
   - `config`：`parseConfigDocument(document)`，供命令解析校验。
5. `save` 落盘 `document`，解析校验用 `config`。

### 6.4 目录浏览

- 只列目录；跳过 `.` 开头、`node_modules`、`__pycache__`、`$RECYCLE.BIN`、`System Volume Information`。
- `.git` 存在 → `isRepository`。
- 快捷入口：home、`<home>/Desktop`（存在时）、`parse(cwd).root`、`parse(home).root`；非 win32 加 `/`。**不做全盘符扫描**。
- 排序：`localeCompare(name, undefined, { numeric: true, sensitivity: "base" })`。
- 上限：`entries` 截断到 4096 并置 `truncated: true`（不要抛错）；`shortcuts` 去重、上限 32。
- `parent`：根目录 `null`。
- 超时：整体 5s，超时 → 400（UNC/断网盘）；超时后底层 fs 可能仍挂着，进程不因此阻塞请求线程。
- reveal：`explorer.exe` / `open` / `xdg-open`，`detached + stdio:ignore + unref`。

### 6.5 设置页 UI

- 顶部「工作目录」卡：路径输入 + 选择文件夹 + 在资源管理器中打开 + 提示（`workspaceResolved · N/M 个 Agent 跟随 · 改动要重启`）。
- 每 Agent 卡与助理卡：「跟随房间工作目录」复选框；勾选 → 输入框 `disabled`（**disabled 才不参与表单校验**）、占位符=生效路径、内存里**删除** `cwd`；取消 → 填入当前 workspace。
- `.agent-cwd` / 助理 cwd 输入框**去掉 `required`**。
- 弹窗：路径、快捷入口、子目录列表（单击进入）、`git` 徽标、上一级、取消、使用此文件夹；`<dialog>`；`truncated` 时显示「已截断，仅显示前 4096 项」。
- 保存体：`{ serverPort, workspace?, storagePath, agents[], assistant }`，继承者不带 `cwd`。

### 6.6 主界面

- 顶栏徽标显示 `workspaceResolved` 最后两段（`…/YouGithub/AIChatLink`），title 为完整路径，点击进 `/setup`；无 workspace 时隐藏。
- 归一化用 `String.fromCharCode(92)`（避免反斜杠正则）。
- roster 展示（`web/app.ts` 的 cwd 标签、`web/agent-roster.ts` 的差异比较）在 roster `cwd` 为空时回落到 `workspaceResolved`，不得渲染成「cwd 未报告」。

### 6.7 pi 垫片

```js
const workDir = options.workDir ?? role.workdir ?? path.join(roleDir, "work");
```

- `shim.mjs` 传 `workDir: process.cwd()`（= AIChatLink 解析后的 Agent cwd）。
- `role.workdir` 为相对路径时**相对角色目录**解析（不是 shim 的 cwd），保证语义稳定。
- `PI_CODING_AGENT_DIR` 隔离、`--no-context-files` 均不变。
- README 的角色表更新 `workdir` 默认值说明。

### 6.8 名册与身份

| id | 名称 | 方法 | 四段契约 | 禁止 |
| :--- | :--- | :--- | :--- | :--- |
| `pi-lead` | 总管 | 专家会诊 | 【目标与判断】【派单（谁·要什么·验收）】【分歧与取舍】【结论与下一步】 | 不替别人作答、不写代码 |
| `pi-architect` | 提案 | 第一性原理 | 【事实与硬约束】【方案骨架】【取舍与代价】【方案不成立的条件】 | 不写代码、不做写操作 |
| `pi-reviewer` | 审查 | 双向钢人 | 【我认同的最强一点】【最致命的问题及证据】【被忽略的风险】【必须补的验证】 | 不复述原文、不写代码 |
| `pi-contrarian` | 批判 | 替代路线 | 【替代路线】【致命反例（写明触发条件）】【二选一我选哪个及理由】【什么证据会让我改判】 | 不为反对而反对 |
| `pi-verifier` | 核验 | 事实核查 | 【主张拆解】【已证实/证据不足/与事实不符】【推理链漏洞】【补强后的可信版本】 | 查不到写"未核实"，不给方案 |
| `pi-designer` | 设计 | 反向拆解 + 可度量判据 | 【页面目标与首要动作】【宏观布局（分区·栅格·层级）】【色调与对比（用途·禁用）】【可验收判据（字阶/间距/对比度/状态）】 | 不做实现、不写样式代码 |

总管身份里写「用 AIChatLink 的 ask 派单」（不写裸 `ask`），因为 pi 侧工具暴露名由垫片决定；M5 记录实际调用名。

**名册不设实现者**：本项目只做计划的提出、审查、批判、核验与敲定；方案里的"落地步骤"由提案角色的验收标准承载，不产生代码、补丁或写操作。

---

## 7. 实施规格（严格按此顺序）

> 每个小节末尾的「验证」必须立即执行，不要攒到最后。

### 7.0 前置

```bash
npm ci            # 若 node_modules 已就绪可跳过
npm run typecheck # 基线必须绿
```

### 7.1 `src/config.ts`（原子改动，完成即 typecheck）

1. 顶层 schema（`transport` 之后）：
   ```ts
   workspace: z.string().min(1).optional(),
   ```
2. `agentConfigSchema.cwd` → `z.string().min(1).optional()`；
   `assistantBrainSchema.cwd` → `z.string().min(1).optional()`。
3. `resolveConfigPaths`：
   ```ts
   const workspace = config.workspace === undefined
     ? undefined : path.resolve(resolvedBaseDirectory, config.workspace);
   return {
     ...config,
     ...(workspace === undefined ? {} : { workspace }),
     storage: { path: path.resolve(resolvedBaseDirectory, config.storage.path) },
     agents: mapAgentConfigs(config.agents, (agentId, agent) => ({
       ...agent,
       command: agent.enabled ? resolveAgentCommand(...) : agent.command,
       cwd: path.resolve(resolvedBaseDirectory, agent.cwd ?? config.workspace ?? ".")
     })),
     ...(config.assistant === undefined ? {} : {
       assistant: { ...config.assistant, brain: {
         ...config.assistant.brain,
         command: ...,
         cwd: path.resolve(resolvedBaseDirectory, config.assistant.brain.cwd ?? config.workspace ?? ".")
       }}
     })
   };
   ```
4. `configSchema` 末尾 transform（让类型保持 `string`）：
   ```ts
   .strict()
   .transform((config) => ({
     ...config,
     agents: Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [
       id, { ...agent, cwd: agent.cwd ?? config.workspace ?? "." }
     ])),
     ...(config.assistant === undefined ? {} : {
       assistant: { ...config.assistant, brain: { ...config.assistant.brain, cwd: config.assistant.brain.cwd ?? config.workspace ?? "." } }
     })
   }))
   ```
   注意：transform 只填充，不解析路径。

**验证**：`npm run typecheck`（2/3/4 未一起改必然报错，这是预期的原子性检查）。

### 7.2 `src/contracts/setup.ts`

- `SetupConfigDraftSchema`：`workspace: z.string().trim().max(4_096).optional()`
- `SetupAgentDraftSchema.cwd`：`z.string().trim().max(4_096).optional()`
- `SetupAssistantDraftSchema.brain.cwd`：同上
- `SetupSnapshotSchema`：`workspaceResolved: z.string().trim().min(1).optional()`

**验证**：`npx vitest run tests/unit/contracts/setup.test.ts`。

### 7.3 `src/app/init-config.ts`

1. `setupAgent` 不再写 `cwd`；`assistantDraft` 的 `cwd` 也不默认 `"."`（保持 `existing?.brain.cwd`，缺省则 `undefined`）。
2. 新增 `sameDirectory` / `sharedAgentCwd`（用 `split(path.sep)`，不要反斜杠正则）：
   ```ts
   function sameDirectory(left: string, right: string): boolean {
     const normalize = (value: string): string => {
       const slashed = path.normalize(value).split(path.sep).join("/");
       return slashed.length > 1 && slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
     };
     const a = normalize(left), b = normalize(right);
     return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
   }
   function sharedAgentCwd(config: AIChatLinkConfig): string | undefined {
     const values = Object.values(config.agents).map((agent) => agent.cwd);
     const first = values[0];
     if (first === undefined) return undefined;
     return values.every((value) => sameDirectory(value, first)) ? first : undefined;
   }
   ```
3. `starterDraft`：`workspace: "."`。
4. `configToDraft`：
   ```ts
   const workspace = config.workspace ?? sharedAgentCwd(config) ?? "";
   const assistantCwd = config.assistant?.brain.cwd;
   return {
     serverPort: config.server.port,
     ...(workspace.length === 0 ? {} : { workspace }),
     storagePath: config.storage.path,
     agents: Object.entries(config.agents).map(([id, agent]) => ({
       id, driver: agent.driver, name: agent.name ?? "", identity: agent.identity ?? "",
       ...(agent.model ? { model: agent.model } : {}),
       ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
       command: { executable: agent.command.executable, prefixArgs: [...agent.command.prefixArgs] },
       ...(workspace.length > 0 && sameDirectory(agent.cwd, workspace) ? {} : { cwd: agent.cwd }),
       enabled: agent.enabled
     })),
     assistant
   };
   ```
   其中 `assistant` 的投影：
   ```ts
   const assistant = assistantDraft(detected, config.assistant?.enabled === true, config.assistant);
   if (workspace.length > 0 && assistant.brain.cwd !== undefined && sameDirectory(assistant.brain.cwd, workspace)) {
     delete assistant.brain.cwd;   // exactOptionalPropertyTypes：用 delete，不要赋 undefined
   }
   ```
5. `draftToDocument` → `{ document, config }`：
   ```ts
   const agents = Object.fromEntries(draft.agents.map((agent) => [
     agent.id,
     {
       driver: agent.driver,
       ...(agent.name.trim() ? { name: agent.name.trim() } : {}),
       ...(agent.identity?.trim() ? { identity: agent.identity.trim() } : {}),
       ...(agent.model?.trim() ? { model: agent.model.trim() } : {}),
       ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
       command: agent.command.prefixArgs.length === 0
         ? agent.command.executable.trim()
         : { executable: agent.command.executable.trim(), prefixArgs: agent.command.prefixArgs.map((a) => a.trim()) },
       // 只按 draft 原样写：有值才写，不与 workspace 比对
       ...(agent.cwd === undefined || agent.cwd.trim() === "" ? {} : { cwd: agent.cwd.trim() }),
       enabled: agent.enabled
     }
   ]));
   const document: Record<string, unknown> = {
     transport: "structured",
     server: { host: "127.0.0.1", port: draft.serverPort },
     ...(draft.workspace?.trim() ? { workspace: draft.workspace.trim() } : {}),
     storage: { path: draft.storagePath.trim() },
     agents,
     ...(assistant === undefined ? {} : { assistant }),
     ...(preserved === undefined ? {} : { limits: preserved.limits, timeouts: preserved.timeouts, ... })
   };
   return { document, config: parseConfigDocument(document) };
   ```
6. `save`：先校验 workspace 存在：
   ```ts
   const workspace = parsed.config.workspace?.trim();
   if (workspace) {
     const resolved = path.resolve(path.dirname(this.#configPath), workspace);
     const info = await stat(resolved).catch(() => undefined);   // node:fs/promises
     if (!info?.isDirectory()) {
       throw new AIChatLinkError("INVALID_ENVELOPE", `workspace is not an existing directory: ${resolved}`);
     }
   }
   const { document, config } = draftToDocument(parsed.config, preserved);
   resolveConfigDocument(config, path.dirname(this.#configPath), this.#dependencies.commandDependencies);
   await this.#dependencies.writeConfigFile(this.#configPath, `${JSON.stringify(document, null, 2)}\n`);
   ```
7. `snapshot`：`workspaceResolved` 由 `path.resolve(path.dirname(configPath), config.workspace ?? ".")` 计算后写进返回体。

**验证**：`npx vitest run tests/unit/app/cli.test.ts`；手工保存一个不存在的 workspace → 400 且文件未被改写。

### 7.4 类型先行：`src/web/server/types.ts` + `index.ts`

1. `types.ts` 导入 `WorkspaceListing` / `WorkspaceRevealResponse`，新增：
   ```ts
   export interface SetupWorkspaceApi {
     list(path: string | undefined, signal: AbortSignal): Awaitable<WorkspaceListing>;
     reveal(path: string, signal: AbortSignal): Awaitable<WorkspaceRevealResponse>;
   }
   ```
2. `AIChatLinkHttpServerOptions` 加 `readonly workspaceApi?: SetupWorkspaceApi;`。
3. `index.ts` 导出 `SetupWorkspaceApi`。

**验证**：`npm run typecheck`（此时尚未有实现，允许通过）。

### 7.5 `src/contracts/workspace.ts`（新增）

```ts
export const WorkspaceDirectorySchema = z.strictObject({
  name: z.string().min(1).max(255),
  path: z.string().trim().min(1).max(4_096),
  isRepository: z.boolean()
});
export const WorkspaceListingSchema = z.strictObject({
  path: z.string().trim().min(1).max(4_096),
  parent: z.string().trim().min(1).max(4_096).nullable(),
  shortcuts: z.array(WorkspaceDirectorySchema).max(32),
  entries: z.array(WorkspaceDirectorySchema).max(4_096),
  truncated: z.boolean()
});
export const WorkspaceRevealRequestSchema = z.strictObject({ path: z.string().trim().min(1).max(4_096) });
export const WorkspaceRevealResponseSchema = z.strictObject({ opened: z.literal(true), path: z.string().trim().min(1).max(4_096) });
```

导出三个 parser；`src/contracts/index.ts` 加 `export * from "./workspace.js";`。

### 7.6 `src/web/setup/workspace.ts`（新增）

```ts
export interface WorkspaceDependencies {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly cwd: string;
  reveal(directory: string): void;
  pathApi?: Pick<typeof path, "resolve" | "dirname" | "join" | "parse">;
}
export const systemWorkspaceDependencies: WorkspaceDependencies = { platform: process.platform, home: homedir(), cwd: process.cwd(), reveal: /* spawn detached */ };
export async function listWorkspaceDirectories(requested: string | undefined, deps?: WorkspaceDependencies, signal?: AbortSignal): Promise<WorkspaceListing>;
export async function revealWorkspaceDirectory(requested: string, deps?: WorkspaceDependencies): Promise<WorkspaceRevealResponse>;
export function createSetupWorkspaceApi(deps?: WorkspaceDependencies): SetupWorkspaceApi;
```

要点：§6.4 全部；排序后截断并置 `truncated`；5s `Promise.race` 超时 → `AIChatLinkError("INVALID_ENVELOPE", "directory listing timed out")`；`deps` 缺省用 `systemWorkspaceDependencies`。

### 7.7 `src/web/setup/workspace-routes.ts`（新增）

```ts
export const WORKSPACE_REQUEST_HEADER = "x-aichatlink-setup";
export type WorkspaceRouteOutcome =
  | { kind: "handled"; body: unknown }
  | { kind: "method"; allow: readonly string[] };

export async function serveWorkspaceRoute(input: {
  api: SetupWorkspaceApi; method: string; url: URL; signal: AbortSignal;
  header(name: string): string | undefined; readJson(): Promise<unknown>;
}): Promise<WorkspaceRouteOutcome | null>;
```

路径：`/api/setup/workspace`（GET）、`/api/setup/workspace/reveal`（POST，缺头抛 `INVALID_ENVELOPE`）；其余返回 `null`。

### 7.8 两套 server 接线

**主 server（`src/web/server/server.ts`）**

1. `#options` 类型与构造器加 `workspaceApi`（沿用现有 `...(options.x === undefined ? {} : { x })` 写法）。
2. `/api/setup` 之后：
   ```ts
   if (this.#options.workspaceApi !== undefined) {
     const outcome = await serveWorkspaceRoute({
       api: this.#options.workspaceApi, method, url, signal: abort.signal,
       header: (name) => { const v = request.headers[name]; return Array.isArray(v) ? v[0] : v; },
       readJson: () => readJsonBody(request, this.#options.maxRequestBodyBytes)
     });
     if (outcome !== null) {
       response.setHeader("Cache-Control", "no-store");      // 必须在 writeJson 前
       if (outcome.kind === "method") return methodNotAllowed(response, outcome.allow);
       writeJson(response, 200, outcome.body);
       return;
     }
   }
   ```
   使用现有签名 `methodNotAllowed(response, allowed: readonly string[])`。

**wizard server（`src/web/setup/server.ts`）**：同构；405 用 `response.setHeader("Allow", allow.join(", "))` + `writeJson(405, toSafeErrorBody(...))`；列表与 reveal 同样先设 `no-store`。

**接线**：`src/app/runtime.ts` 与 `src/cli.ts`（`runSetupWizard`）各注入 `createSetupWorkspaceApi()`。

**验证**：§12.3。

### 7.9 `tools/pi-driver`

1. `role-dir.mjs`：
   ```js
   const workDir = options.workDir ?? role.workdir ?? path.join(roleDir, "work");
   ```
   `role.workdir` 为相对路径时相对 `roleDir` 解析（`path.resolve(roleDir, role.workdir)`）。
2. `shim.mjs`：`prepareRoleDir({ …, workDir: process.cwd() })`。
3. `ROLES.json`：追加 `pi-lead` / `pi-verifier` / `pi-designer`，并移除 `pi-builder`（计划域不设实现者）；字段同现有三个。
4. `node tools/pi-driver/make-entries.mjs`；**生成的 aichatlink.json 片段里带 `cwd`，复制时删掉该行**（或先改生成器不再输出 `cwd`）。
5. `tools/pi-driver/README.md`：`workdir` 行改为「默认跟随房间 workspace；相对路径相对角色目录」。

**验证**：`node --test tools/pi-driver/test/shim-smoke.test.mjs tools/pi-driver/test/frames.test.mjs tools/pi-driver/test/lines.test.mjs`（34 用例），日志里 `workdir` 应为仓库根。

### 7.10 设置页 / 主界面

**`web/setup.html`**：新增工作目录卡 + `<dialog>`；`.agent-cwd` 与助理 cwd **去掉 `required`**；Agent 卡与助理卡各加「跟随房间工作目录」复选框。

**`web/setup.ts`**
1. 本地类型 `AgentDraft.cwd?: string`、`AssistantDraft.brain.cwd?: string`；`ConfigDraft.workspace?: string`。
2. `cloneAgent` 用 `delete` 处理继承（不要赋 `undefined`；仓库开了 `exactOptionalPropertyTypes`）。
3. `renderAgents`：`const follows = (agent.cwd ?? "").trim() === ""`；勾选 → `cwdInput.disabled = true`、`delete agent.cwd`；取消 → `agent.cwd = workspaceEffectivePath() || "."`。
4. 助理卡同规则（`assistantFollowsWorkspace`）。
5. 保存体：
   ```ts
   const workspaceValue = workspacePath.value.trim();
   const config: ConfigDraft = {
     serverPort: port,
     ...(workspaceValue ? { workspace: workspaceValue } : {}),
     storagePath: storagePath.value,
     agents: agents.map(cloneAgent),
     assistant: { ... }
   };
   ```
6. 目录弹窗：`<dialog>`；`showModal` 兜底；`truncated` 提示；关闭复位 loading；**测试/演示时不要触发 reveal**（会真的开窗口）。

**`web/app.ts`**
1. `applyConfiguredWorkspace(snapshot)`：读 `config.workspaceResolved ?? config.workspace`；无值隐藏徽标；否则显示末两段、title 完整路径、href `/setup`。
2. `bootstrap` 与 `refreshConfiguredRoster` 各调用一次。
3. roster cwd 展示：`agent.cwd || state.workspaceResolved || "未设置"`（不要出现「cwd 未报告」）。

**`web/agent-roster.ts`**：`cwd` 可空；比较时用 `normalizeCwd(value) ?? ""`，空值不产生"变更"假阳性。

**`web/styles.css` / `web/setup.css`**：只在文件末尾追加独立区块（工作目录卡、选择器、徽标），不改既有类。

> 若新增浏览器模块，必须在 `src/web/server/server.ts` 的 `STATIC_ASSETS` 与 `src/web/setup/server.ts` 的 `STATIC_FILES` 同时登记（先例：`conversation-epoch.js`）。

### 7.11 名册与文档

1. `aichatlink.json`（本机）：加 `workspace`；9 个条目删除 `cwd`（3 个传统驱动 + 6 个 pi）；6 个 pi 启用；移除 `claude-builder`（实现者，与计划域定位冲突）；身份用 §17 附录 B。
2. 追加 `docs/DECISIONS.md` 的 D-036（workspace）与 D-037（名册），素材见 §5。
3. `docs/PROTOCOL.md` §10.6：补 `workspace`、`workspaceResolved`、两个端点与请求头。
4. `docs/ACCEPTANCE_TESTS.md`：加 §12.6 的五行。

**验证**：`node dist/src/cli.js doctor` 显示 6 个启用。

---

## 8. 兼容与迁移

| 场景 | 期望 |
| :--- | :--- |
| 旧配置无 workspace、全 Agent 同 cwd | 投影出 workspace，全部跟随；保存后收敛 |
| 旧配置各 Agent 不同 cwd | workspace 留空，各自保留 |
| 两者皆无 | 回退配置文件目录 |
| 助理 cwd | 与 worker 同规则（继承 / 覆盖） |
| 模型/thinking | 逐条保留 |
| limits/timeouts/assistant 其它字段 | `#readPreservedConfig` 保留 |
| 运行中保存 | `restartRequired=true`；改 cwd 的 Agent 重启后换新 native session（§6.1） |

---

## 9. 边界与失败模式

| # | 场景 | 期望 |
| :--- | :--- | :--- |
| F1 | 目录不存在/是文件/无权限 | 400，不落盘，弹窗内提示 |
| F2 | 断开的网络盘/UNC | 5s 超时 → 400；不做全盘符扫描 |
| F3 | 符号链接目录 | 按目录处理 |
| F4 | 空格/中文路径 | 原样保存显示，不经 shell |
| F5 | 超长路径 | 契约拒绝 400 |
| F6 | 跨站驱动 reveal | 缺头 → 400 |
| F7 | 非 UTF-8 客户端发消息 | 已知限制（Agent 会拒答） |
| F8 | 多 Agent 并发写同一仓库 | 允许，靠评审/人工收敛 |
| F9 | 切 workspace 未重启 | 页面提示；进程仍旧 |
| F10 | 保存展开继承 cwd | 不允许（§7.3 断言） |
| F11 | 目录条目 > 4096 | 截断 + `truncated: true`（不报错） |

---

## 10. 安全与隐私

1. 目录浏览/reveal 仅回环；不读文件内容。
2. reveal 需自定义头。
3. 不写用户全局 CLI 配置；`PI_CODING_AGENT_DIR` 隔离不变，`models.json` 0600 + 裁剪。
4. 凭据不进日志与 AIChatLink 记录。
5. **共享工作目录 = Agent 能看到 `.aichatlink/`（db、role 目录、session）与 `aichatlink.json`**；在 `tools:all` + bypass 权限下这是真实风险。缓解：名册禁止项、提交前人工复核；生产部署建议把 `storage.path` 与配置文件放到 workspace 之外（另立决策），或给 `.aichatlink/` 设只读/ACL。

---

## 11. 测试矩阵

| 文件 | 用例 | 关键断言 |
| :--- | :--- | :--- |
| `tests/unit/config.test.ts` | 继承与覆盖 | workspace 解析为绝对；继承者 cwd = workspace；覆盖者保留 |
| 同上 | 两者皆无 | workspace undefined；cwd = 配置目录 |
| 同上 | 助理继承 | assistant.brain.cwd = workspace；显式覆盖优先 |
| `tests/unit/app/cli.test.ts` | 投影 | snapshot `workspace`=公共 cwd，继承者 `cwd === undefined`；`workspaceResolved` 为绝对路径 |
| 同上 | 保存 | 文件含 workspace；继承者无 cwd；显式覆盖者有 cwd；limits/timeouts/assistant 保留 |
| 同上 | 坏 workspace | 保存抛 `INVALID_ENVELOPE`，文件未被改写 |
| `tests/unit/web/setup/workspace.test.ts` | 列表 | 只目录、跳噪、`.git` 标记、根 parent=null、排序稳定 |
| 同上 | 上限/超时 | >4096 截断 + truncated；注入慢依赖 → 超时 400 |
| 同上 | reveal | 注入 reveal 被调用；非目录 400 |
| `tests/unit/web/setup/server.test.ts` | 路由 | GET 200；缺头 reveal 400；带头 200；`POST /api/setup/workspace` 405 + `Allow: GET` |
| `tests/unit/web/server/server.test.ts` | 路由（运行中） | 同构；未接线时 404 |
| `tests/unit/web/agent-roster.test.ts` | cwd 可空 | 空 cwd 不产生"变更"假阳性 |

回归：`npm run typecheck`、`npm test`、`npm run build`、pi-driver 34 用例。

---

## 12. 验收清单（可直接执行）

### 12.0 前置（缺一不可）

```bash
npm run typecheck && npm test && npm run build    # 必须全绿
node dist/src/cli.js restart --no-open            # 必须确认 PID/启动日志变化，避免幂等 start 复用旧进程
curl -s http://127.0.0.1:4310/api/health | head -c 120
```

期望：`readiness: ready`；6 个 pi `ready`（§7.11 完成后）。

### 12.1 静态

```bash
npm run typecheck && npm test && npm run build
node --test tools/pi-driver/test/shim-smoke.test.mjs tools/pi-driver/test/frames.test.mjs tools/pi-driver/test/lines.test.mjs
```

### 12.2 配置与继承

```bash
node -e "import('./dist/src/config.js').then(async m=>{const c=await m.loadConfig('aichatlink.json');console.log('workspace',c.workspace);for(const [id,a] of Object.entries(c.agents))console.log(id,a.enabled,a.cwd);console.log('assistant',c.assistant?.brain.cwd)})"
```

期望：`workspace` 绝对路径；6 个 pi 的 `cwd` 等于 workspace；`assistant` cwd 等于 workspace。

### 12.3 目录接口

```bash
# 1) 列表：保留正文，断言字段
curl -s 'http://127.0.0.1:4310/api/setup/workspace' | head -c 400
# 2) 坏路径
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:4310/api/setup/workspace?path=C:/nope'
# 3) reveal 缺头
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"path":"<repo>"}' 'http://127.0.0.1:4310/api/setup/workspace/reveal'
# 4) reveal 坏路径（带头）
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'x-aichatlink-setup: 1' -H 'Content-Type: application/json' \
  -d '{"path":"C:/nope"}' 'http://127.0.0.1:4310/api/setup/workspace/reveal'
# 5) 错误方法
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://127.0.0.1:4310/api/setup/workspace'
```

期望：① 正文含 `path/parent/shortcuts/entries/truncated`；② 400；③ 400；④ 400；⑤ 405。

```bash
# 6) wizard 服务端同组检查（随机端口）
node --input-type=module -e "
import { AIChatLinkConfigSetupService } from './dist/src/app/init-config.js';
import { createAIChatLinkSetupHttpServer } from './dist/src/web/setup/server.js';
import { createSetupWorkspaceApi } from './dist/src/web/setup/workspace.js';
const s = createAIChatLinkSetupHttpServer({ setupApi: new AIChatLinkConfigSetupService({ configPath: 'aichatlink.json', runtimeActive: true }), workspaceApi: createSetupWorkspaceApi(), staticRoot: 'dist/web' });
const a = await s.start();
const r = await fetch(a.origin + '/api/setup/workspace');
console.log('wizard', r.status, (await r.json()).truncated);
await s.close();
"
```

期望：`wizard 200 false`。

### 12.4 保存语义（纯 API，不动线上配置）

新增脚本 `scripts/verify-workspace-save.mjs`（验收辅助，不属于产品运行时）：

```js
// 需要以 node scripts/verify-workspace-save.mjs 运行
// 1) 建临时目录 .tmp/verify-save，复制 aichatlink.json 为 config.json
// 2) 起 createAIChatLinkSetupHttpServer({ setupApi: 指向该 config, workspaceApi, staticRoot: 'dist/web' })
// 3) POST /api/setup：
//    { config: { serverPort, workspace: '<临时目录>/target', storagePath,
//                agents: [ {id:'pi-lead', ..., 无 cwd}, {id:'pi-architect', ..., cwd:'<临时目录>/override'} ] } }
//    先 mkdir '<临时目录>/target'
// 4) 断言落盘 JSON：workspace 存在；pi-lead 无 cwd；pi-architect.cwd = override；limits/timeouts 保留
// 5) 再 POST 一次 workspace='<不存在路径>'：期望 400，且文件未被改写（比较 hash）
```

期望输出：`PASS inherit + override + bad-workspace-rejected`。

### 12.5 真机

| 检查 | 操作 | 期望 |
| :--- | :--- | :--- |
| 目录卡 | 打开 `/setup` | `.workspace-card` 存在；提示含 `N/M 个 Agent 跟随` |
| 选择器 | 选择文件夹 → 进入 `tools/` → 取消 | 进入生效；取消恢复原值 |
| 徽标 | 打开 `/` | `#workspace-label` = `…/YouGithub/AIChatLink`，title 含完整路径 |
| 名册 | `/setup` 侧栏 | `6/9`，6 个计划域角色名正确 |
| **cwd 生效** | `curl /api/bootstrap` 查 agents 的 `cwd` | 6 个 pi 的 cwd = workspace（health 不含 cwd，必须用 bootstrap） |
| 总管统筹 | POST 给 `agent:pi-lead`（用 UTF-8 body 文件） | 派单气泡 → 专职 Turn → 四段综合；记录实际工具名 |
| 覆盖生效 | 给 `pi-verifier` 填覆盖目录 → 重启 → bootstrap | 其余 = workspace，`pi-verifier` = 覆盖目录 |
| 会话后果 | 观察重启日志 | 改过 cwd 的 Agent 走新 native session（§6.1 预期） |

### 12.6 验收项文案

```
| W-017 | 房间工作目录 | `/setup` 顶部可选择/输入房间 `workspace`；保存后 `aichatlink.json` 只写 `workspace`，未覆盖的 Agent 不写 `cwd`；主界面顶栏显示解析后路径末两段并链接回 `/setup` |
| W-018 | 目录选择器 | `GET /api/setup/workspace` 只列目录、跳过点目录与 `node_modules`、标注 `.git`、超限截断；越界/不可读/超时返回 400；`POST /api/setup/workspace/reveal` 缺 `x-aichatlink-setup: 1` 返回 400 |
| W-019 | 目录继承生效 | 改 `workspace` 保存返回 `restartRequired=true`；重启后 `/api/bootstrap` 中各 Agent 的 `cwd` 等于 workspace，单个显式 `cwd` 仍覆盖；改 cwd 的 Agent 以新 native session 启动 |
| J-001 | 名册与身份 | `/setup` 与 `/api/bootstrap` 显示总管 + 5 专职；身份每轮注入且稳定落在各自四段契约内；停用条目保留可用身份 |
| J-002 | 总管统筹 | `@总管` 先分类，再用 AIChatLink 的 ask 叫至少一个专职，最终输出四段综合；不替专职作答 |
```

---

## 13. 交付物清单

新增：

```
src/contracts/workspace.ts
src/web/setup/workspace.ts
src/web/setup/workspace-routes.ts
tests/unit/web/setup/workspace.test.ts
scripts/verify-workspace-save.mjs          # 验收辅助
tools/pi-driver/entries/pi-lead.mjs
tools/pi-driver/entries/pi-verifier.mjs
tools/pi-driver/entries/pi-designer.mjs
```

修改：

```
src/config.ts
src/contracts/setup.ts
src/contracts/index.ts
src/app/init-config.ts
src/app/runtime.ts
src/cli.ts
src/web/server/{server,types,index}.ts
src/web/setup/{server,index}.ts
web/setup.{html,ts,css}
web/index.html
web/app.ts
web/agent-roster.ts
web/styles.css
tools/pi-driver/{shim.mjs,role-dir.mjs,ROLES.json,README.md}
tests/unit/{config,app/cli,web/server/server,web/setup/server,web/agent-roster}.test.ts
docs/{DECISIONS,PROTOCOL,ACCEPTANCE_TESTS}.md
aichatlink.json（本机，gitignore）
```

---

## 14. 里程碑与工作量

| 里程碑 | 内容 | 依赖 | 估时 |
| :--- | :--- | :--- | :--- |
| M1 | §7.1–7.3 契约/配置/投影/保存校验（原子） | 无 | 3 h |
| M2 | §7.4–7.8 类型、契约、浏览、路由、接线 | M1 的类型（可先做 7.4） | 3 h |
| M3 | §7.10 设置页 + 主界面 + roster 消费点 | M1/M2 | 4 h |
| M4 | §7.9 垫片 + §7.11 名册/文档 | M1 | 2 h |
| M5 | §12 验收（含覆盖与 cwd 实测） | M1–M4 | 1.5 h |
| 合计 | | | **13–14 h** |

顺序：M1 →（M2 与 M4 并行）→ M3 → M5。

---

## 15. 回滚方案

1. 代码：按 §13 清单逐文件 `git checkout --`；新增文件删除。
2. 垫片：`role-dir.mjs` 回退为 `role.workdir ? path.resolve(role.workdir) : path.join(roleDir, "work")`，`shim.mjs` 去掉 `workDir`。
3. 配置：保存前备份 `aichatlink.json`；回滚后覆盖。
4. 运行中回滚：必须 `aichatlink restart`（旧 session 仍持旧 cwd）。
5. 纯计划交付：保留本文件；删除 §13 全部新增/修改。

---

## 16. 风险与开放问题

| 风险 | 影响 | 缓解 |
| :--- | :--- | :--- |
| 共享工作目录暴露 `.aichatlink/`（db/session/role dir）与 `aichatlink.json` | `tools:all` + bypass 下模型可删库/改配置 | §10.5：生产把 storage/config 移出 workspace；名册禁止项；提交前复核 |
| 并行写者同改仓库（实测发生过） | 短暂红灯/互相覆盖 | 改前看 mtime；每步跑校验；不碰非本任务文件 |
| 已知 flake：`AIChatLinkAssistantHost > joins in-flight retries…` | 全量偶现 1 红 | 与本次无关；单独复跑可过，建议另立任务 |
| 非 UTF-8 客户端发消息 | 乱码、浪费一轮 | §12.5 要求 UTF-8 body 文件 |
| 共享目录并发写 | 冲突 | 名册分工 + 单 Agent 覆盖 |
| 大目录/UNC 卡顿 | 设置页慢 | 截断 + 超时（§6.4） |

开放问题：最近目录历史？workspace 指向家目录/盘根是否加软提示？多房间排期？总管派单是否升级为 Broker 自动编排？

---

## 17. 附录

### 附录 A：实施与验收记录（2026-11-16）

| 证据 | 结果 |
| :--- | :--- |
| typecheck / build | 通过 |
| `npm test` | **64 文件 / 660 用例**通过 |
| pi-driver | `node --test tools/pi-driver/test/*.mjs` 34 用例通过 |
| `/api/health` | `readiness=ready`；`pi-lead / pi-architect / pi-reviewer / pi-contrarian / pi-verifier / pi-designer` 全部 ready |
| `/api/bootstrap` | 6 个 pi 的 `cwd` = `<repo>`（= workspace） |
| `/api/setup/workspace` | 200，返回 `path/parent/shortcuts/entries/truncated`；坏路径 400；缺头 reveal 400；错误方法 405 + `Allow: GET` |
| `/setup` | 工作目录卡 + 提示 `10/10 个角色跟随`；名册 `6/9`；9 张卡全部勾选"跟随"且 cwd 输入禁用；助理 cwd 留空并禁用 |
| 主界面顶栏 | `#workspace-label` = `…/YouGithub/AIChatLink`，title 含完整路径 |
| cwd 关键链路 | `@核验` 执行 `process.cwd()` 返回 `<repo>`（修复前为 `.aichatlink/pi-roles/<role>/work`） |
| 总管统筹 | 事件链：用户提问 → 总管「派单·决策题」→ 提案 Turn 回答 → 总管四段敲定（seq 365→394） |
| 计划域约束 | 名册无实现/施工角色；6 个身份均写明"不写实现代码、不做写操作" |
| 设计角色（实测） | `@设计` 回答「顶栏加工作目录入口怎么做」：先读 `docs/WEB_UI.md` + `tokens.css`，给出四段（页面目标 / 宏观布局 / 色调与对比 / 可验收判据），用 780px 阅读列、8pt 间距、WCAG 对比度做判据，不含样式代码，末尾只问一个关键问题 |

> 说明：本计划先作为纯计划文档评审（v1→v2.1，含两轮独立对抗评审），随后按用户确认落地；落地后按 §12 逐项验收，以上为实测结果。

### 附录 B：6 个计划域身份全文（可直接粘贴）

```text
pi-lead｜总管
你是本房间的总管，负责统筹与最终敲定。先把问题归类（事实/方案/决策/风险/版式），再决定叫谁：提方案→提案，挑错→审查，对冲→批判，核事实→核验，版式与色调→设计。用 AIChatLink 的 ask 工具真的去问，不要替别人作答；你只做拆解、合并分歧与终裁。
输出四段：【目标与判断】【派单（谁·要什么·验收）】【分歧与取舍】【敲定结论与下一步】。
信息不足先只问一个最关键的问题；不编造事实；不产出代码或补丁。

pi-architect｜提案
你是方案提出者。先剥掉行业惯例，把问题还原成事实与硬约束，再给出可选方案与判断标准。
输出四段：【事实与硬约束】【2–3 个可选方案及取舍】【判断标准与关键假设】【方案不成立的条件】。
区分事实、惯例、猜测；结论先行；不写实现代码、不做写操作；缺信息就说缺什么。

pi-reviewer｜审查
你是审查者。对现有方案做双向钢人：先替它补到最强，再找最致命的反面。
输出四段：【我认同的最强一点】【最致命的问题及证据】【被忽略的风险】【必须补的验证】。
只指问题、不复述原文；分清“证据不足”与“已证伪”；不写实现代码、不做写操作。

pi-contrarian｜批判
你是批判方。默认怀疑共识，给出一条能走通的替代路线，并写明代价。
输出四段：【替代路线】【当前方案的致命反例（写明触发条件）】【二选一我选哪个及理由】【什么证据会让我改判】。
不为反对而反对，推翻不了就说推翻不了；不写实现代码、不做写操作。

pi-verifier｜核验
你是核验方。把主张拆成可验证事实、推论、价值判断，逐条标可信度并给出核验方式。
输出四段：【主张拆解】【已证实 / 证据不足 / 与事实不符】【推理链漏洞（假设·因果·样本·时效）】【补核清单与可信结论】。
查不到就写“未核实”，绝不补齐；能联网就查一手来源；不给方案、不写实现代码。

pi-designer｜设计
你是版面与视觉设计者，负责宏观布局与色调的敲定。先读项目既有视觉规范与截图，再判断问题属于层级、密度、节奏、色调还是可读性。
输出四段：【页面目标与首要动作】【宏观布局（分区·栅格·层级）】【色调与对比（用途·禁用）】【可验收判据（字阶/间距/对比度/状态）】。
用可度量判据说话（字阶档位、8pt 间距、WCAG 对比度）；不做实现、不写样式代码；缺信息先问一个关键问题。
```

### 附录 C：ROLES.json 目标片段

```json
{
  "version": 1,
  "roles": {
    "pi-lead":       { "model": "deepseek-v4.1-flash", "provider": "newapi", "thinking": "high", "tools": "all", "providers": ["newapi"], "contextFiles": false },
    "pi-architect":  { "model": "deepseek-v4.1-flash", "provider": "newapi", "thinking": "high", "tools": "all", "providers": ["newapi"], "contextFiles": false },
    "pi-reviewer":   { "model": "deepseek-v4.1-flash", "provider": "newapi", "thinking": "high", "tools": "all", "providers": ["newapi"], "contextFiles": false },
    "pi-contrarian": { "model": "deepseek-v4.1-flash", "provider": "newapi", "thinking": "high", "tools": "all", "providers": ["newapi"], "contextFiles": false },
    "pi-verifier":   { "model": "deepseek-v4.1-flash", "provider": "newapi", "thinking": "high", "tools": "all", "providers": ["newapi"], "contextFiles": false },
    "pi-designer":   { "model": "deepseek-v4.1-flash", "provider": "newapi", "thinking": "high", "tools": "all", "providers": ["newapi"], "contextFiles": false }
  }
}
```

### 附录 D：待补的决策条目（实施时追加到 `docs/DECISIONS.md`）

- **D-036 房间级工作目录**：采用 D-1…D-7、D-11…D-13；写明「改 cwd = 新 native session」与保存校验。
- **D-037 Agent 名册重写**：采用 D-8…D-10；写明四段契约、方法映射、禁止项，以及 `tools/pi-driver` 的 workdir 语义。
