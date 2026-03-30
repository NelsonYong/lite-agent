# agentTeam.ts 详解

## 概述

`agentTeam.ts` 实现了一个 **多 Agent 协作系统**，允许主 Agent（Lead）动态生成（spawn）多个子 Agent（称为 teammate），这些 teammate 各自独立运行，通过基于文件的消息总线（MessageBus）进行异步通信。

系统内置两套治理协议：
- **Plan Approval 协议** — 事前控制，teammate 在执行重大工作前需提交计划，等待 lead 审批
- **Shutdown 协议** — 事后控制，lead 可向 teammate 发起优雅关闭请求，teammate 可接受或拒绝

两套协议均基于 `request_id` 关联机制，使异步消息总线具备请求-响应追踪能力。

整体架构如下：

```
┌─────────────┐     spawn      ┌──────────────┐
│  Lead Agent │ ──────────────▶│ Teammate A   │
│             │  plan_approval │ (role: coder)│
│             │ ◀──────────────│              │
│             │  approve/reject│              │
│             │ ──────────────▶│              │
│             │                └──────┬───────┘
│             │  shutdown_request     │ send_message
│             │ ──────────────▶       ▼
│             │                ┌──────────────┐
│             │                │  MessageBus  │  ← 基于 JSONL 文件
│             │                │  (.inbox/)   │
│             │                └──────┬───────┘
│             │  shutdown_response    │ readInbox
│             │ ◀──────────────       ▼
│             │                ┌──────────────┐
│             │                │ Teammate B   │
│             │                │ (role: reviewer)
└─────────────┘                └──────────────┘
```

---

## 目录结构

运行时会在工作目录下自动创建两个隐藏目录：

| 目录 | 用途 |
|------|------|
| `.inbox/` | 消息总线存储目录，每个 agent 一个 `{name}.jsonl` 文件作为收件箱 |
| `.team/` | 团队配置目录，包含 `config.json` 记录所有成员信息 |

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
  plan?: string;          // 计划内容（plan_approval_response 场景）
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

### 重试配置

```ts
const MAX_RETRIES = 2;       // API 调用最大重试次数
const RETRY_DELAY_MS = 2000; // 重试基础延迟（毫秒），按次数递增
```

teammate 的 API 调用遇到 5xx 错误时会自动重试，延迟为 `RETRY_DELAY_MS * (retry + 1)`（递增退避）。

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

团队管理器，负责 teammate 的生命周期管理和任务执行。

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
| `spawn` | `(name, role, prompt) → string` | 创建或重启一个 teammate，启动其 agentic loop |
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
  └─ 3. 异步启动 _teammateLoop（fire-and-forget）
```

---

### 3. _teammateLoop — Agentic 循环（核心）

这是每个 teammate 的主循环，实现了完整的 Agent 执行流程。

#### System Prompt

```
You are '{name}', role: {role}, at {WORKDIR}.

MANDATORY PROTOCOLS — you MUST follow these without exception:
1. Before starting any major work, you MUST call the plan_approval tool to submit
   your plan. NEVER write plans to files or send them as messages — only use the
   plan_approval tool. Wait for lead approval before proceeding.
2. When you receive a shutdown_request message, you MUST respond using the
   shutdown_response tool with the provided request_id.
```

System prompt 以 **强制协议** 形式要求 teammate 遵守两套协议，明确禁止通过写文件或发消息等方式绕过 `plan_approval` 工具。

#### 循环流程

```
┌──────────────────────────────────────────────────────┐
│              _teammateLoop                            │
│                                                       │
│  let shouldExit = false                               │
│                                                       │
│  for (最多 50 轮) {                                   │
│    1. 读取收件箱 → 注入为 user message                │
│    2. 如果 shouldExit == true → 跳出循环              │
│    3. 调用 Claude API（带 tools，失败时重试）          │
│       - 5xx 错误最多重试 MAX_RETRIES 次               │
│       - 每次重试延迟递增（RETRY_DELAY_MS * n）        │
│       - 非 5xx 错误或重试耗尽 → 退出循环              │
│    4. 将 assistant response 加入历史                   │
│    5. 如果 stop_reason ≠ "tool_use" → 结束            │
│    6. 遍历 tool_use blocks：                          │
│       - 执行工具（_exec）                              │
│       - 收集 tool_result                              │
│       - 如果是 shutdown_response 且 approve → 标记    │
│         shouldExit = true                             │
│    7. 将 tool_results 加入历史                        │
│  }                                                    │
│                                                       │
│  循环结束 →                                           │
│    shouldExit ? 状态设为 "shutdown"                    │
│             : 状态设为 "idle"                          │
└──────────────────────────────────────────────────────┘
```

#### 关键特性

- **最大 50 轮迭代**：防止无限循环
- **收件箱轮询**：每轮循环开始时检查收件箱，将新消息注入对话历史，实现 agent 间实时通信
- **错误重试**：API 调用遇到 5xx 错误时自动重试（最多 `MAX_RETRIES` 次，递增延迟），非 5xx 错误或重试耗尽后记录日志并退出循环
- **优雅关闭**：teammate approve shutdown 后，不会立即中断当前轮次，而是先处理完收件箱中的剩余消息，再在下一轮循环开始时退出
- **状态区分**：退出时根据 `shouldExit` 标志明确区分 `"shutdown"`（被请求关闭）和 `"idle"`（自然结束），便于 lead 了解退出原因
- **强制协议**：system prompt 以强制语气要求 teammate 必须通过 `plan_approval` 工具提交计划，禁止写文件或发消息绕过

---

### 4. _exec — 工具执行分发

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

#### 协议工具（新增）

| 工具名 | 功能 | 详细说明 |
|--------|------|----------|
| `shutdown_response` | 响应关闭请求 | 接收 `request_id` + `approve` + 可选 `reason`。更新 `shutdownRequests` 状态表，向 lead 发送 `shutdown_response` 类型消息（携带 `request_id` 和 `approve`）。如果 approve 为 true，teammate 将在下一轮循环退出 |
| `plan_approval` | 提交工作计划 | 接收 `plan` 文本。自动生成 `request_id`（`randomBytes(4).toString("hex")`），在 `planRequests` 中记录状态为 `pending`，向 lead 发送 `plan_submission` 类型消息（携带 `request_id` 和 `plan`）。返回 `request_id` 供后续追踪 |

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
| `force_shutdown` | 强制关闭 teammate | `teammate` | 绕过优雅关闭协议，在 teammate 下一轮循环迭代时立即终止。用于 teammate 拒绝 `shutdown_request` 后的兜底手段 |
| `plan_approval` | 审批 teammate 的计划 | `request_id`, `approve`, `feedback?` | 批准或拒绝 teammate 提交的工作计划，可附带反馈意见 |

---

## 协议详解

### Plan Approval 协议（计划审批）

解决的问题：原来 teammate spawn 后自主行动，lead 无法在执行前审核方案，可能导致 teammate 做无用功或偏离方向。

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

解决的问题：原来 teammate 只能自然结束（50 轮耗尽或模型不再调用工具），无法被 lead 主动、安全地停止。

Lead 拥有两级关闭能力：

| 级别 | 工具 | 性质 | teammate 可拒绝 |
|------|------|------|-----------------|
| L1 | `shutdown_request` | 优雅请求 | 是 |
| L2 | `force_shutdown` | 强制终止 | 否 |

#### L1：优雅关闭流程

```
┌──────────┐                    ┌──────────────┐                    ┌──────────┐
│  Lead    │                    │  MessageBus  │                    │ Teammate │
└────┬─────┘                    └──────┬───────┘                    └────┬─────┘
     │                                 │                                 │
     │  shutdown_request(teammate)     │                                 │
     │────────────────────────────────▶│────────────────────────────────▶│
     │                                 │   生成 request_id               │
     │  返回 request_id               │   shutdownRequests[id]=pending  │
     │                                 │                                 │
     │                                 │   （teammate 下一轮循环读取     │
     │                                 │    收件箱，看到 shutdown_request）│
     │                                 │                                 │
     │                                 │   shutdown_response(            │
     │                                 │     request_id, approve, reason)│
     │  read_inbox()                   │◀────────────────────────────────│
     │  ← shutdown_response            │                                 │
     │◀────────────────────────────────│                                 │
     │                                 │                                 │
     │  （如果 approve = true）         │   shouldExit = true             │
     │                                 │   → 下一轮循环退出              │
     │                                 │   → 状态设为 "shutdown"         │
     │                                 │                                 │
     │  （如果 approve = false）        │   继续工作                      │
     │                                 │   → 状态保持 "working"          │
     │                                 │                                 │
     │  ┌─ L2 升级（可选）─────────┐   │                                 │
     │  │ force_shutdown(teammate) │   │                                 │
     │  │ → 见下方 L2 流程         │   │                                 │
     │  └──────────────────────────┘   │                                 │
```

#### L2：强制关闭流程

当 teammate 拒绝 `shutdown_request` 后，lead 可升级为 `force_shutdown`：

```
┌──────────┐                                          ┌──────────┐
│  Lead    │                                          │ Teammate │
└────┬─────┘                                          └────┬─────┘
     │                                                     │
     │  force_shutdown("bob")                              │
     │  → _forceShutdowns.add("bob")                       │
     │  → 返回确认消息                                      │
     │                                                     │
     │                                     _teammateLoop 下一轮迭代:
     │                                       检查 _forceShutdowns
     │                                       → 命中，立即 break
     │                                       → 状态设为 "shutdown"
     │                                                     │
```

**实现机制：**

- `TeammateManager` 维护一个内存集合 `_forceShutdowns: Set<string>`
- `forceShutdown(name)` 方法校验 teammate 状态为 `working` 后，将其加入集合
- `_teammateLoop` 每轮迭代**最先**检查 `_forceShutdowns`（优先于收件箱读取），命中则立即退出
- 不经过消息总线，不依赖模型行为，lead 单方面生效

#### 状态流转

```
lead 发起关闭   → shutdownRequests[request_id].status = "pending"
teammate 同意   → shutdownRequests[request_id].status = "approved"
                  shouldExit = true → 优雅退出 → member.status = "shutdown"
teammate 拒绝   → shutdownRequests[request_id].status = "rejected"
                  继续工作 → member.status 保持 "working"
lead 强制关闭   → _forceShutdowns.add(name)
                  → 下一轮迭代立即退出 → member.status = "shutdown"
```

#### 优雅退出细节（L1 approve 场景）

teammate approve shutdown 后的退出顺序：

1. `_exec` 返回 `"Shutdown approved"`，`shouldExit` 标记为 `true`
2. 当前轮次的其他 tool_use 继续正常执行（不中断）
3. 当前轮次的 tool_results 正常写入消息历史
4. 下一轮循环开始时，先读取收件箱（处理可能的剩余消息）
5. 检测到 `shouldExit === true`，跳出循环
6. 状态设为 `"shutdown"`，写入配置

#### 强制退出细节（L2 场景）

1. `_forceShutdowns` 检查在收件箱读取**之前**，确保不会再执行任何工具
2. 当前正在执行的 API 调用/工具会完成（无法中断进行中的操作），但不会发起新的调用
3. 状态直接设为 `"shutdown"`，写入配置

---

## 完整交互示例

### 示例 1：基础工作流（含计划审批）

```
Lead 调用:
  TEAM.spawn("frontend", "React developer", "用 React 实现一个 TodoList 组件")

→ TeammateManager:
    创建成员 { name: "frontend", role: "React developer", status: "working" }
    启动 _teammateLoop

→ _teammateLoop 第 1 轮:
    Claude API 返回: tool_use [plan_approval: "1. 创建 TodoList 组件 2. 添加增删功能 3. 样式美化"]
    执行: plan_approval → 生成 request_id="a1b2c3d4"
    向 lead 收件箱发送 plan_submission
    返回: "Plan submitted (request_id=a1b2c3d4). Waiting for lead approval."

→ Lead:
    read_inbox() → 收到 plan_submission
    plan_approval(request_id="a1b2c3d4", approve=true, feedback="先做核心功能，样式放后面")

→ _teammateLoop 第 2 轮:
    收件箱收到 lead 的审批结果
    Claude API 返回: tool_use [write_file: src/TodoList.tsx]
    执行: writeFile("src/TodoList.tsx", "...")
    继续循环

→ _teammateLoop 第 3 轮:
    Claude API 返回: end_turn（无 tool_use）
    循环结束，状态设为 "idle"
```

### 示例 2：优雅关闭

```
Lead 调用:
  shutdown_request(teammate="frontend")
  → 向 frontend 收件箱发送 shutdown_request 消息
  → 返回 request_id="e5f6g7h8"

→ _teammateLoop（frontend）下一轮:
    收件箱读到 shutdown_request 消息
    Claude 判断当前无未完成工作
    Claude API 返回: tool_use [shutdown_response: { request_id: "e5f6g7h8", approve: true, reason: "任务已完成" }]
    执行: shutdown_response → shutdownRequests["e5f6g7h8"].status = "approved"
    shouldExit = true

→ _teammateLoop 下一轮:
    读取收件箱（处理剩余消息）
    shouldExit === true → 跳出循环
    状态设为 "shutdown"

→ Lead:
    read_inbox() → 收到 shutdown_response（approve: true, reason: "任务已完成"）
    确认 frontend 已关闭
```

### 示例 3：拒绝关闭 → 强制关闭

```
Lead 调用:
  shutdown_request(teammate="backend")
  → 返回 request_id="x1y2z3w4"

→ _teammateLoop（backend）下一轮:
    收件箱读到 shutdown_request 消息
    Claude 判断当前还有未完成的数据库迁移
    Claude API 返回: tool_use [shutdown_response: { request_id: "x1y2z3w4", approve: false, reason: "数据库迁移进行中，预计还需 2 轮" }]
    执行: shutdown_response → shutdownRequests["x1y2z3w4"].status = "rejected"
    shouldExit 保持 false，继续工作

→ Lead:
    read_inbox() → 收到 shutdown_response（approve: false, reason: "数据库迁移进行中..."）

    方案 A — 等待: 决定等 backend 完成后再次请求关闭
    方案 B — 强制: 调用 force_shutdown(teammate="backend")

→ Lead 选择方案 B:
    force_shutdown("backend")
    → _forceShutdowns.add("backend")
    → 返回 "Force shutdown issued for 'backend'. Will terminate at next loop iteration."

→ _teammateLoop（backend）下一轮:
    检查 _forceShutdowns → 命中 "backend"
    立即跳出循环，不再读取收件箱或调用 API
    状态设为 "shutdown"
```

---

## 导出

```ts
export const AGENT_TEAM_SCHEMA = [...];  // Lead 侧工具定义
export const BUS = new MessageBus(INBOX_DIR);  // 消息总线单例
export const TEAM = new TeammateManager(TEAM_DIR);  // 团队管理器单例
```

模块导出三个核心对象：
- `AGENT_TEAM_SCHEMA`：供主 Agent 注册 lead 侧工具
- `BUS`：消息总线，供外部模块直接发送/读取消息
- `TEAM`：团队管理器，供主 Agent 调用 `TEAM.spawn()`、`TEAM.listAll()` 等方法
