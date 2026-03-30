# agentTeam.ts 详解

## 概述

`agentTeam.ts` 实现了一个 **自治型多 Agent 协作系统**，允许主 Agent（Lead）动态生成（spawn）多个自治子 Agent（teammate）。teammate 不仅能接受 lead 指派的任务，还能**自主扫描任务看板、认领未分配的任务**，实现真正的自组织。

核心能力：
- **自治循环** — teammate 完成工作后进入 idle 轮询阶段，自动从任务看板认领新任务
- **消息总线** — 基于 JSONL 文件的异步通信（MessageBus）
- **治理协议** — Plan Approval（事前审批）+ 两级 Shutdown（优雅请求 / 强制终止）
- **身份重注入** — 上下文压缩后自动恢复 teammate 的身份信息

整体架构：

```
┌─────────────┐     spawn      ┌──────────────┐     scan/claim    ┌──────────────┐
│  Lead Agent │ ──────────────▶│ Teammate A   │ ◀──────────────── │  Task Board  │
│             │  plan_approval │ (autonomous) │                   │  (.tasks/)   │
│             │ ◀──────────────│              │                   └──────────────┘
│             │                └──────┬───────┘
│             │                       │ send_message / idle / claim_task
│             │                       ▼
│             │                ┌──────────────┐
│             │                │  MessageBus  │  ← 基于 JSONL 文件
│             │                │  (.inbox/)   │
│             │                └──────┬───────┘
│             │                       │
│             │                ┌──────────────┐
│             │                │ Teammate B   │
│             │                │ (autonomous) │
└─────────────┘                └──────────────┘
```

---

## 目录结构

运行时会在工作目录下自动创建以下隐藏目录：

| 目录 | 用途 |
|------|------|
| `.inbox/` | 消息总线存储目录，每个 agent 一个 `{name}.jsonl` 文件作为收件箱 |
| `.team/` | 团队配置目录，包含 `config.json` 记录所有成员信息 |
| `.tasks/` | 任务看板目录，每个任务一个 `task_{id}.json` 文件（由 `task.ts` 管理） |

---

## 核心类型定义

### MessageType

支持 6 种消息类型：

| 类型 | 说明 | 方向 |
|------|------|------|
| `message` | 普通点对点消息（默认） | 双向 |
| `broadcast` | 广播消息，发给所有队友 | Lead → 全体 |
| `shutdown_request` | 关闭请求，lead 请求 teammate 停止工作 | Lead → Teammate |
| `shutdown_response` | 关闭响应，teammate 回复 approve/reject | Teammate → Lead |
| `plan_submission` | 计划提交，teammate 提交计划等待审批 | Teammate → Lead |
| `plan_approval_response` | 计划审批结果，lead 批准或拒绝计划 | Lead → Teammate |

### BusMessage

消息体结构：

```ts
{
  type: MessageType;      // 消息类型
  from: string;           // 发送者名称
  content: string;        // 消息内容
  timestamp: number;      // 时间戳（毫秒）
  request_id?: string;    // 请求关联 ID（shutdown/plan_approval 场景）
  approve?: boolean;      // 是否批准（shutdown_response 场景）
  plan?: string;          // 计划内容（plan_submission 场景）
  [key: string]: unknown; // 其他扩展字段
}
```

### TeamMember

团队成员结构：

```ts
{
  name: string;                            // 成员名称（唯一标识）
  role: string;                            // 角色描述
  status: "working" | "idle" | "shutdown"; // 当前状态
}
```

---

## 全局状态与常量

### 自治循环配置

```ts
const MAX_RETRIES = 2;        // API 调用最大重试次数
const RETRY_DELAY_MS = 2000;  // 重试基础延迟（毫秒），按次数递增
const POLL_INTERVAL = 5000;   // idle 阶段轮询间隔（毫秒）
const IDLE_TIMEOUT = 60000;   // idle 阶段超时（毫秒），超时后自动 shutdown
```

### shutdownRequests

```ts
const shutdownRequests: Record<string, { target: string; status: string }> = {};
```

以 `request_id` 为 key，跟踪每个关闭请求的状态变迁：

```
pending → approved   （teammate 同意关闭）
pending → rejected   （teammate 拒绝关闭）
```

### planRequests

```ts
const planRequests: Record<string, { from: string; plan: string; status: string }> = {};
```

以 `request_id` 为 key，记录每个计划审批请求：

| 字段 | 说明 |
|------|------|
| `from` | 提交计划的 teammate 名称 |
| `plan` | 计划内容文本 |
| `status` | 审批状态：`pending` / `approved` / `rejected` |

`request_id` 由 `crypto.randomBytes(4).toString("hex")` 生成，保证唯一性。

---

## 类详解

### 1. MessageBus

基于 JSONL 文件的消息总线，负责 Agent 间的异步通信。

#### 存储机制

每个 agent 拥有一个独立的收件箱文件 `.inbox/{name}.jsonl`，消息以 JSON 行格式追加写入。

#### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `send` | `(sender, to, content, msgType?, extra?) → string` | 向指定 agent 的收件箱追加一条消息，`extra` 可携带 `request_id` 等扩展字段 |
| `readInbox` | `(name) → BusMessage[]` | 读取并**清空**指定 agent 的收件箱（一次性消费） |
| `broadcast` | `(sender, content, teammates) → string` | 向除自己外的所有队友发送广播 |

#### 关键设计

- **读即清空**：`readInbox` 读取后立即清空文件，确保消息不会被重复消费
- **文件级持久化**：使用 `appendFileSync` 保证消息不丢失
- **类型校验**：发送前检查 `msgType` 是否在合法集合内
- **方向语义**：`plan_submission`（teammate→lead）与 `plan_approval_response`（lead→teammate）区分消息方向，debug 日志一目了然
- **扩展字段透传**：`extra` 参数通过展开运算符 `...extra` 合并到消息体，支持 `request_id`、`approve`、`plan` 等协议字段

---

### 2. TeammateManager

团队管理器，负责 teammate 的自治生命周期管理。

#### 配置持久化

团队信息存储在 `.team/config.json`：

```json
{
  "team_name": "default",
  "members": [
    { "name": "coder", "role": "TypeScript developer", "status": "working" },
    { "name": "reviewer", "role": "Code reviewer", "status": "idle" },
    { "name": "designer", "role": "UI designer", "status": "shutdown" }
  ]
}
```

#### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `spawn` | `(name, role, prompt) → string` | 创建或重启一个 teammate，启动自治循环 |
| `forceShutdown` | `(name) → string` | 强制终止指定 teammate |
| `listAll` | `() → string` | 列出所有团队成员及其状态 |
| `memberNames` | `() → string[]` | 返回所有成员名称数组 |

#### spawn 流程

```
spawn("coder", "TypeScript developer", "实现登录功能")
  │
  ├─ 1. 检查是否已存在同名成员
  │     ├─ 存在且 idle/shutdown → 重新激活，更新 role
  │     ├─ 存在且 working → 返回错误（防止重复启动）
  │     └─ 不存在 → 创建新成员
  │
  ├─ 2. 更新状态为 "working"，保存配置
  │
  └─ 3. 异步启动 _loop，带 crash 处理
        .catch → 记录错误日志，状态设为 "idle"
```

---

### 3. _loop — 自治循环（核心）

这是每个 teammate 的主循环，实现 **work → idle → poll → work** 的自治闭环。

#### System Prompt

```
You are '{name}', role: {role}, team: {teamName}, at {WORKDIR}.
Use idle tool when you have no more work. You will auto-claim new tasks.

MANDATORY PROTOCOLS — you MUST follow these without exception:
1. Before starting any major work, you MUST call the plan_approval tool to submit
   your plan. NEVER write plans to files or send them as messages — only use the
   plan_approval tool. Wait for lead approval before proceeding.
2. When you receive a shutdown_request message, you MUST respond using the
   shutdown_response tool with the provided request_id.
```

System prompt 告知 teammate 它是自治的：完成工作后使用 `idle` 工具进入轮询，系统会自动分配新任务。

#### 循环流程

```
┌────────────────────────────────────────────────────────────────┐
│                        _loop (外层 while true)                 │
│                                                                │
│  ┌─── Work Phase (内层 for, 最多 50 轮) ──────────────────┐   │
│  │                                                         │   │
│  │  1. 检查 _forceShutdowns → 命中则立即 return           │   │
│  │  2. 读取收件箱                                          │   │
│  │     - shutdown_request → 立即 return                    │   │
│  │     - 其他消息 → 注入为 user message                    │   │
│  │  3. 调用 Claude API（带 tools，5xx 自动重试）           │   │
│  │  4. 将 assistant response 加入历史                      │   │
│  │  5. 如果 stop_reason ≠ "tool_use" → break              │   │
│  │  6. 遍历 tool_use blocks：                             │   │
│  │     - idle → 标记 idleRequested = true                  │   │
│  │     - 其他 → 执行工具（_exec），收集 tool_result        │   │
│  │  7. 将 tool_results 加入历史                            │   │
│  │  8. 如果 idleRequested → break                          │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           ↓                                    │
│  ┌─── Idle Phase (轮询, 每 5s 一次, 最多 60s) ───────────┐   │
│  │                                                         │   │
│  │  状态设为 "idle"                                        │   │
│  │                                                         │   │
│  │  每轮轮询:                                              │   │
│  │    1. 检查 _forceShutdowns → 命中则 return              │   │
│  │    2. 读取收件箱                                        │   │
│  │       - shutdown_request → return                       │   │
│  │       - 有消息 → resume = true, break                   │   │
│  │    3. 扫描任务看板 (TASKS.scanUnclaimed)                │   │
│  │       - 有未认领任务 → claimTask + 身份重注入           │   │
│  │       → resume = true, break                            │   │
│  │                                                         │   │
│  │  轮询结束:                                              │   │
│  │    resume = true  → 状态设为 "working", 继续外层循环    │   │
│  │    resume = false → idle 超时, 自动 shutdown, return    │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

#### 关键特性

- **自治闭环**：work → idle → poll → work，无需 lead 持续干预
- **任务自动认领**：idle 阶段扫描 `.tasks/` 目录，自动认领 `status=pending` 且无 `owner` 的任务
- **身份重注入**：认领新任务时，如果消息历史很短（≤3 条，可能经过压缩），自动注入 `<identity>` 块恢复身份
- **空闲超时**：`IDLE_TIMEOUT`（60 秒）内无新任务或消息，自动 shutdown，避免空转浪费
- **最大 50 轮迭代**：单个 work phase 防止无限循环
- **错误重试**：API 5xx 错误自动重试（最多 `MAX_RETRIES` 次，递增退避），并记录日志
- **crash 恢复**：`_loop` 的 `.catch` 记录错误并将状态设为 `idle`（而非静默吞掉）
- **强制协议**：system prompt 以强制语气要求 teammate 必须通过 `plan_approval` 工具提交计划

---

### 4. 身份重注入（makeIdentityBlock）

解决的问题：上下文压缩（compact）后，消息历史被精简，teammate 可能丢失自身身份信息。

```ts
function makeIdentityBlock(name, role, teamName): MessageParam {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`
  };
}
```

触发条件：`messages.length <= 3`（说明历史很短，可能刚被压缩）。此时在消息开头注入 identity 块 + assistant 确认。

```
注入后的消息历史:
  [0] user:      <identity>You are 'coder', role: TS developer, team: default...</identity>
  [1] assistant: I am coder. Continuing.
  [2] user:      <auto-claimed>Task #3: 重构配置模块...</auto-claimed>
  [3] assistant: Claimed task #3. Working on it.
```

---

### 5. _exec — 工具执行分发

将 Claude 返回的 tool_use 请求分发到具体的工具实现：

#### 基础工具

| 工具名 | 功能 | 调用 |
|--------|------|------|
| `bash` | 执行 shell 命令 | `runBash(command)` |
| `read_file` | 读取文件内容（上限 50KB） | `readFileSync` |
| `write_file` | 写入文件 | `writeFile(path, content)` |
| `edit_file` | 替换文件中的文本 | `editFile(path, old_text, new_text)` |
| `send_message` | 发送消息给队友 | `BUS.send(...)` |
| `read_inbox` | 读取自己的收件箱 | `BUS.readInbox(...)` |

#### 自治工具

| 工具名 | 功能 | 详细说明 |
|--------|------|----------|
| `idle` | 进入空闲阶段 | 不由 `_exec` 处理，在循环中特殊处理。返回提示信息后 break work phase |
| `claim_task` | 手动认领任务 | 调用 `TASKS.claimTask(taskId, sender)`，将任务状态改为 `in_progress` |

#### 协议工具

| 工具名 | 功能 | 详细说明 |
|--------|------|----------|
| `shutdown_response` | 响应关闭请求 | 接收 `request_id` + `approve` + 可选 `reason`。更新 `shutdownRequests` 状态表，向 lead 发送 `shutdown_response` 类型消息 |
| `plan_approval` | 提交工作计划 | 接收 `plan` 文本。自动生成 `request_id`，在 `planRequests` 中记录状态为 `pending`，向 lead 发送 `plan_submission` 类型消息 |

---

## Lead 侧工具（AGENT_TEAM_SCHEMA）

Lead Agent 通过以下工具管理团队：

### 基础管理

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `spawn_teammate` | 创建新 teammate | `name`, `role`, `prompt` |
| `list_teammates` | 列出所有成员及状态 | 无 |
| `send_message` | 向指定 teammate 发消息 | `to`, `content`, `msg_type?` |
| `read_inbox` | 读取 lead 的收件箱 | 无 |
| `broadcast` | 向所有 teammate 广播消息 | `content` |

### 治理协议

| 工具名 | 功能 | 参数 | 说明 |
|--------|------|------|------|
| `shutdown_request` | 请求 teammate 关闭 | `teammate` | 向指定 teammate 发送关闭请求，返回 `request_id` 用于追踪 |
| `shutdown_response` | 查询关闭请求状态 | `request_id` | 通过 `request_id` 查询 teammate 是否已响应（approved/rejected） |
| `force_shutdown` | 强制关闭 teammate | `teammate` | 绕过优雅关闭协议，在 teammate 下一轮循环迭代时立即终止。支持 `working` 和 `idle` 状态 |
| `plan_approval` | 审批 teammate 的计划 | `request_id`, `approve`, `feedback?` | 批准或拒绝 teammate 提交的工作计划，可附带反馈意见 |

---

## 协议详解

### Plan Approval 协议（计划审批）

解决的问题：teammate 自主行动时，lead 无法在执行前审核方案，可能导致偏离方向。

#### 完整流程

```
┌──────────┐                    ┌──────────────┐                    ┌──────────┐
│  Lead    │                    │  MessageBus  │                    │ Teammate │
└────┬─────┘                    └──────┬───────┘                    └────┬─────┘
     │                                 │                                 │
     │  spawn(name, role, prompt)      │                                 │
     │────────────────────────────────▶│────────────────────────────────▶│
     │                                 │                                 │
     │                                 │   plan_approval(plan)           │
     │                                 │◀────────────────────────────────│
     │                                 │                                 │
     │  read_inbox()                   │   生成 request_id               │
     │  ← plan_submission              │   planRequests[id] = pending    │
     │◀────────────────────────────────│                                 │
     │                                 │                                 │
     │  plan_approval(request_id,      │                                 │
     │    approve: true/false,         │                                 │
     │    feedback: "...")             │                                 │
     │────────────────────────────────▶│────────────────────────────────▶│
     │                                 │                                 │
     │                                 │   （收到审批结果后继续或调整）    │
     │                                 │                                 │
```

#### 状态流转

```
teammate 提交计划 → planRequests[request_id].status = "pending"
lead 批准         → planRequests[request_id].status = "approved"
lead 拒绝         → planRequests[request_id].status = "rejected"
```

---

### Shutdown 协议（两级关闭）

Lead 拥有两级关闭能力：

| 级别 | 工具 | 性质 | teammate 可拒绝 |
|------|------|------|-----------------|
| L1 | `shutdown_request` | 优雅请求 | 是 |
| L2 | `force_shutdown` | 强制终止 | 否 |

#### L1：优雅关闭

```
┌──────────┐                    ┌──────────────┐                    ┌──────────┐
│  Lead    │                    │  MessageBus  │                    │ Teammate │
└────┬─────┘                    └──────┬───────┘                    └────┬─────┘
     │  shutdown_request(teammate)     │                                 │
     │────────────────────────────────▶│────────────────────────────────▶│
     │  返回 request_id               │                                 │
     │                                 │   shutdown_response(approve)    │
     │  read_inbox()                   │◀────────────────────────────────│
     │  ← shutdown_response            │                                 │
     │◀────────────────────────────────│                                 │
     │                                 │                                 │
     │  approve=true  → teammate shutdown                               │
     │  approve=false → teammate 继续工作                                │
     │                 → lead 可升级为 force_shutdown                     │
```

#### L2：强制关闭

```
Lead: force_shutdown("bob")
  → _forceShutdowns.add("bob")
  → teammate 在下一轮循环（work phase 或 idle phase）立即退出
  → 状态设为 "shutdown"
```

**实现机制：**

- `TeammateManager` 维护内存集合 `_forceShutdowns: Set<string>`
- `forceShutdown(name)` 校验 teammate 状态为 `working` 或 `idle` 后加入集合
- `_loop` 的 work phase 和 idle phase **都**检查 `_forceShutdowns`，命中则立即 return
- 不经过消息总线，不依赖模型行为，lead 单方面生效

#### 状态流转

```
lead 发起关闭   → shutdownRequests[request_id].status = "pending"
teammate 同意   → "approved" → member.status = "shutdown"
teammate 拒绝   → "rejected" → member.status 保持 "working"
lead 强制关闭   → _forceShutdowns.add(name) → member.status = "shutdown"
idle 超时       → 自动 shutdown → member.status = "shutdown"
```

---

## Teammate 生命周期

```
                    spawn(name, role, prompt)
                           │
                           ▼
                    ┌──────────────┐
          ┌────────│   working     │◀──────────────────┐
          │        └──────┬───────┘                    │
          │               │                             │
          │    idle tool / end_turn / 50 轮耗尽         │ 收到消息 / 认领任务
          │               │                             │
          │               ▼                             │
          │        ┌──────────────┐                     │
          │        │    idle      │─────────────────────┘
          │        └──────┬───────┘
          │               │
          │        60 秒无任务/消息
          │               │
          ▼               ▼
   ┌──────────────────────────────┐
   │         shutdown             │
   │  (shutdown_request /         │
   │   force_shutdown /           │
   │   idle timeout /             │
   │   API error)                 │
   └──────────────────────────────┘
```

---

## 完整交互示例

### 示例 1：自治工作流（自动认领任务）

```
Lead 调用:
  task_create("实现用户注册 API")        → task #1
  task_create("编写注册接口单元测试")     → task #2
  TEAM.spawn("backend", "Node.js developer", "你是后端开发者，查看任务看板开始工作")

→ _loop Work Phase 第 1 轮:
    Claude 看到 prompt，调用 claim_task(task_id=1)
    执行: TASKS.claimTask(1, "backend") → task #1 owner=backend, status=in_progress

→ _loop Work Phase 第 2 轮:
    Claude 调用 plan_approval(plan="1. 创建路由 2. 实现控制器 3. 添加验证")
    向 lead 发送 plan_submission
    等待审批...

→ Lead:
    read_inbox() → 收到 plan_submission
    plan_approval(request_id="a1b2c3d4", approve=true)

→ _loop Work Phase 后续轮次:
    收到审批通过，开始编码
    完成后调用 idle 工具
    → 进入 Idle Phase

→ _loop Idle Phase:
    每 5 秒轮询一次
    第 2 次轮询: scanUnclaimed() → 发现 task #2
    自动认领: claimTask(2, "backend")
    身份重注入（如果消息历史很短）
    → 回到 Work Phase，开始处理 task #2

→ _loop Idle Phase（task #2 完成后）:
    60 秒内无新任务
    → 自动 shutdown
```

### 示例 2：多 teammate 并行

```
Lead 调用:
  task_create("重构用户模块")       → task #1
  task_create("重构订单模块")       → task #2
  TEAM.spawn("alice", "developer", "查看任务看板开始工作")
  TEAM.spawn("bob", "developer", "查看任务看板开始工作")

→ alice 的 _loop:
    claim_task(1) → 认领 task #1
    在主工作目录修改文件...

→ bob 的 _loop:
    claim_task(1) → Error: Task #1 already owned by alice（锁机制）
    claim_task(2) → 认领 task #2
    在主工作目录修改文件...

注意: 此场景下如果两人修改同一文件会冲突，
需配合 worktree 隔离（见 worktree.md）
```

### 示例 3：拒绝关闭 → 强制关闭

```
Lead 调用:
  shutdown_request(teammate="backend")
  → 返回 request_id="x1y2z3w4"

→ _loop（backend）Work Phase:
    收件箱读到 shutdown_request → 立即 shutdown（自治模式下直接退出）

或者（如果需要 lead 强制介入）:
  force_shutdown("backend")
  → _forceShutdowns.add("backend")
  → backend 在下一轮循环立即退出
```

---

## 与 Task 系统的集成

teammate 通过 `TASKS`（来自 `task.ts`）与任务看板交互：

| 调用 | 场景 |
|------|------|
| `TASKS.scanUnclaimed()` | idle 阶段自动扫描未认领任务 |
| `TASKS.claimTask(id, name)` | 认领任务（带锁防并发冲突） |
| `claim_task` 工具 | teammate 手动认领指定任务 |

任务认领条件：`status === "pending"` 且 `owner` 为空 且 `blockedBy` 为空。

---

## 导出

```ts
export const AGENT_TEAM_SCHEMA = [...];  // Lead 侧工具定义（7 个）
export const BUS = new MessageBus(INBOX_DIR);  // 消息总线单例
export const TEAM = new TeammateManager(TEAM_DIR);  // 团队管理器单例
export const shutdownRequests = {...};  // 关闭请求状态表
export const planRequests = {...};  // 计划审批状态表
export { handleShutdownRequest, handlePlanReview };  // 协议处理函数
```
