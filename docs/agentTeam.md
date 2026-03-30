# agentTeam.ts 详解

## 概述

`agentTeam.ts` 实现了一个 **多 Agent 协作系统**，允许主 Agent 动态生成（spawn）多个子 Agent（称为 teammate），这些 teammate 各自独立运行，通过基于文件的消息总线（MessageBus）进行异步通信。

整体架构如下：

```
┌─────────────┐     spawn      ┌──────────────┐
│  主 Agent    │ ──────────────▶│ Teammate A   │
│             │                │ (role: coder)│
└─────────────┘                └──────┬───────┘
                                      │ send_message
                                      ▼
                               ┌──────────────┐
                               │  MessageBus  │  ← 基于 JSONL 文件
                               │  (.inbox/)   │
                               └──────┬───────┘
                                      │ readInbox
                                      ▼
                               ┌──────────────┐
                               │ Teammate B   │
                               │ (role: reviewer)
                               └──────────────┘
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

支持 5 种消息类型：

| 类型 | 说明 |
|------|------|
| `message` | 普通点对点消息（默认） |
| `broadcast` | 广播消息，发给所有队友 |
| `shutdown_request` | 关闭请求 |
| `shutdown_response` | 关闭响应 |
| `plan_approval_response` | 计划审批响应 |

### BusMessage

消息体结构：

```ts
{
  type: MessageType;      // 消息类型
  from: string;           // 发送者名称
  content: string;        // 消息内容
  timestamp: number;      // 时间戳（毫秒）
  [key: string]: unknown; // 扩展字段
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

## 类详解

### 1. MessageBus

基于 JSONL 文件的消息总线，负责 Agent 间的异步通信。

#### 存储机制

每个 agent 拥有一个独立的收件箱文件 `.inbox/{name}.jsonl`，消息以 JSON 行格式追加写入。

#### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `send` | `(sender, to, content, msgType?, extra?) → string` | 向指定 agent 的收件箱追加一条消息 |
| `readInbox` | `(name) → BusMessage[]` | 读取并**清空**指定 agent 的收件箱（一次性消费） |
| `broadcast` | `(sender, content, teammates) → string` | 向除自己外的所有队友发送广播 |

#### 关键设计

- **读即清空**：`readInbox` 读取后立即清空文件，确保消息不会被重复消费
- **文件级持久化**：使用 `appendFileSync` 保证消息不丢失
- **类型校验**：发送前检查 `msgType` 是否在合法集合内

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
    { "name": "reviewer", "role": "Code reviewer", "status": "idle" }
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

这是每个 teammate 的主循环，实现了完整的 Agent 执行流程：

```
┌─────────────────────────────────────────────┐
│              _teammateLoop                   │
│                                              │
│  for (最多 50 轮) {                          │
│    1. 读取收件箱 → 注入为 user message       │
│    2. 调用 Claude API（带 tools）             │
│    3. 将 assistant response 加入历史          │
│    4. 如果 stop_reason ≠ "tool_use" → 结束   │
│    5. 遍历 tool_use blocks：                 │
│       - 执行工具（_exec）                     │
│       - 收集 tool_result                     │
│    6. 将 tool_results 加入历史               │
│  }                                           │
│                                              │
│  循环结束 → 状态设为 "idle"                   │
└─────────────────────────────────────────────┘
```

#### 关键特性

- **最大 50 轮迭代**：防止无限循环
- **收件箱轮询**：每轮循环开始时检查收件箱，将新消息注入对话历史，实现 agent 间实时通信
- **错误容忍**：API 调用失败时静默退出循环
- **自动回收**：循环结束后自动将状态设为 `idle`（除非已被标记为 `shutdown`）

---

### 4. _exec — 工具执行分发

将 Claude 返回的 tool_use 请求分发到具体的工具实现：

| 工具名 | 功能 | 调用 |
|--------|------|------|
| `bash` | 执行 shell 命令 | `runBash(command)` |
| `read_file` | 读取文件内容（上限 50KB） | `readFileSync` |
| `write_file` | 写入文件 | `writeFile(path, content)` |
| `edit_file` | 替换文件中的文本 | `editFile(path, old_text, new_text)` |
| `send_message` | 发送消息给队友 | `BUS.send(...)` |
| `read_inbox` | 读取自己的收件箱 | `BUS.readInbox(...)` |

---

## 完整交互示例

```
主 Agent 调用:
  TEAM.spawn("frontend", "React developer", "用 React 实现一个 TodoList 组件")

→ TeammateManager:
    创建成员 { name: "frontend", role: "React developer", status: "working" }
    启动 _teammateLoop

→ _teammateLoop 第 1 轮:
    Claude API 返回: tool_use [write_file: src/TodoList.tsx]
    执行: writeFile("src/TodoList.tsx", "...")
    继续循环

→ _teammateLoop 第 2 轮:
    收件箱收到来自 "reviewer" 的消息: "组件缺少 key prop"
    注入消息到对话历史
    Claude API 返回: tool_use [edit_file: src/TodoList.tsx]
    执行: editFile(...)
    继续循环

→ _teammateLoop 第 3 轮:
    Claude API 返回: end_turn（无 tool_use）
    循环结束，状态设为 "idle"
```

---

## 导出

```ts
export const TEAM = new TeammateManager(TEAM_DIR);
```

模块导出唯一的 `TEAM` 单例，供主 Agent 或其他模块调用 `TEAM.spawn()`、`TEAM.listAll()` 等方法。
