import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

const STATUS_MARKER: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  completed: '[x]',
};

const TASKS_DIR = join(process.cwd(), '.tasks');

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    try {
      const ids = readdirSync(this.dir)
        .filter((f) => f.startsWith('task_') && f.endsWith('.json'))
        .map((f) => parseInt(f.split('_')[1]))
        .filter((n) => !isNaN(n));
      return ids.length ? Math.max(...ids) : 0;
    } catch {
      return 0;
    }
  }

  private load(taskId: number): Task {
    const path = join(this.dir, `task_${taskId}.json`);
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Task;
    } catch {
      throw new Error(`Task ${taskId} not found`);
    }
  }

  private save(task: Task): void {
    const path = join(this.dir, `task_${task.id}.json`);
    writeFileSync(path, JSON.stringify(task, null, 2));
  }

  private clearDependency(completedId: number): void {
    try {
      for (const file of readdirSync(this.dir)) {
        if (!file.startsWith('task_') || !file.endsWith('.json')) continue;
        const task = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as Task;
        if (task.blockedBy?.includes(completedId)) {
          task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
          this.save(task);
        }
      }
    } catch { }
  }

  /** 创建新任务 */
  create(subject: string, description = ''): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: 'pending',
      blockedBy: [],
      blocks: [],
      owner: '',
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  /** 获取任务详情 */
  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  /** 更新任务状态或依赖关系 */
  update(
    taskId: number,
    status: TaskStatus | null = null,
    addBlockedBy: number[] | null = null,
    addBlocks: number[] | null = null,
  ): string {
    const task = this.load(taskId);

    if (status) {
      if (!(['pending', 'in_progress', 'completed'] as TaskStatus[]).includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
      if (status === 'completed') this.clearDependency(taskId);
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this.save(blocked);
          }
        } catch { }
      }
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /** 列出所有任务 */
  listAll(): string {
    try {
      const tasks = readdirSync(this.dir)
        .filter((f) => f.startsWith('task_') && f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Task)
        .sort((a, b) => a.id - b.id);

      if (!tasks.length) return 'No tasks.';

      return tasks.map((t) => {
        const marker = STATUS_MARKER[t.status] ?? '[?]';
        const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy})` : '';
        return `${marker} #${t.id}: ${t.subject}${blocked}`;
      }).join('\n');
    } catch {
      return 'No tasks.';
    }
  }
}

export const TASKS = new TaskManager(TASKS_DIR);
