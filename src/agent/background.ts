import { exec } from "child_process";

const WORKDIR = process.cwd();
const debug = (...args: unknown[]) =>
  process.stderr.write(`[debug] ${args.join(" ")}\n`);

type TaskStatus = "running" | "completed" | "error" | "timeout";

interface BackgroundTask {
  status: TaskStatus;
  result: string | null;
  command: string;
}

interface Notification {
  task_id: string;
  status: TaskStatus;
  command: string;
  result: string;
}

export const BG_TOOL_SCHEMA = [
  {
    name: "background_run",
    description: "Run command in background. Returns task_id immediately.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "string" } },
    },
  },
];

// 后台执行长时间命令，异步通知结果
class BackgroundManager {
  private tasks: Record<string, BackgroundTask> = {};
  private notificationQueue: Notification[] = [];

  // 后台运行命令
  run(command: string): string {
    const taskId = Math.random().toString(36).slice(2, 10);
    this.tasks[taskId] = { status: "running", result: null, command };
    debug(`Starting background task ${taskId}: ${command.slice(0, 60)}`);

    exec(
      command,
      { cwd: WORKDIR, timeout: 300000, maxBuffer: 50000000 },
      (error, stdout, stderr) => {
        const output = (stdout + stderr).trim().slice(0, 50000);
        const status: TaskStatus = error
          ? error.killed
            ? "timeout"
            : "error"
          : "completed";
        this.tasks[taskId].status = status;
        this.tasks[taskId].result = output || "(no output)";
        debug(`Background task ${taskId} ${status}`);
        this.notificationQueue.push({
          task_id: taskId,
          status,
          command: command.slice(0, 80),
          result: (output || "(no output)").slice(0, 500),
        });
      },
    );

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  // 检查后台任务状态
  check(taskId: string | null = null): string {
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) return `Error: Unknown task ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result ?? "(running)"}`;
    }
    const lines = Object.entries(this.tasks).map(
      ([tid, t]) => `${tid}: [${t.status}] ${t.command.slice(0, 60)}`,
    );
    return lines.length ? lines.join("\n") : "No background tasks.";
  }

  // 获取并清空通知队列
  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}

export const BG = new BackgroundManager();
