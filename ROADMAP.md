# Roadmap

## 并发 subagent + 任务归属

当前 `runSubagent` 是阻塞调用且没有身份标识——main agent 派发 subagent 后同步等待结果。`owner` 字段已从 `Task` 中删除，因为在这种模型下没有实际意义。

要让 `owner` 有价值，需要 subagent 支持：

- **唯一 ID** — 在 spawn 时分配，注入到 subagent 的上下文中
- **非阻塞派发** — main agent 并发启动多个 subagent
- **任务认领** — subagent 开始执行前调用 `task_update(id, owner=self_id, status="in_progress")`
- **轮询/完成信号** — main agent 监听 `task_list`，直到所有认领的任务变为 `completed`

架构升级后，在 `Task` 接口中恢复 `owner: string`，并在 `task_update` schema 中暴露该字段。
