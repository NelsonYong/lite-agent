import { randomBytes } from "crypto";
import {
  AGENT_TEAM_SCHEMA,
  BUS,
  handlePlanReview,
  handleShutdownRequest,
  shutdownRequests,
  TEAM,
} from "../agent/agentTeam";
import { BG, BG_TOOL_SCHEMA } from "../agent/background";
import { getSkillLoader } from "../agent/skill";
import { runSubagent } from "../agent/subagent";
import { BASH_TOOL_SCHEMA, runBash } from "./bash";
import { editFile, FILE_TOOL_SCHEMA, readFile, writeFile } from "./file";
import { TASK_OPERATIONS_SCHEMA, TASKS, TaskStatus } from "./task";
import { TODO, TODO_TOOL_SCHEMA, TodoInput } from "./todo";

export const AGENT_TOOL_SCHEMA = {
  name: "agent",
  description:
    "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "The task prompt for the subagent",
      },
      description: {
        type: "string",
        description: "Short description of the task",
      },
    },
    required: ["prompt"],
  },
};

export const COMPACT_TOOL_SCHEMA = {
  name: "compact",
  description: "Trigger manual conversation compression.",
  input_schema: {
    type: "object" as const,
    properties: {
      focus: { type: "string", description: "What to preserve in the summary" },
    },
  },
};

export const toolHandlers: Record<
  string,
  (input: any) => string | Promise<string>
> = {
  bash: ({ command }: { command: string }) => runBash(command),
  read_file: ({ path, limit }: { path: string; limit: number }) =>
    readFile(path, limit),
  write_file: ({ path, content }: { path: string; content: string }) =>
    writeFile(path, content),
  edit_file: ({
    path,
    old_text,
    new_text,
  }: {
    path: string;
    old_text: string;
    new_text: string;
  }) => editFile(path, old_text, new_text),
  todo: ({ items }: { items: TodoInput[] }) => TODO.update(items),
  load_skill: ({ name }: { name: string }) => getSkillLoader().getContent(name),
  agent: ({ prompt }: { prompt: string }) => runSubagent(prompt),

  // 创建新任务
  task_create: ({
    subject,
    description,
  }: {
    subject: string;
    description: string;
  }) => TASKS.create(subject, description),
  task_update: ({
    task_id,
    status,
    addBlockedBy,
    addBlocks,
  }: {
    task_id: number;
    status: TaskStatus;
    addBlockedBy: number[];
    addBlocks: number[];
  }) => TASKS.update(task_id, status, addBlockedBy, addBlocks),
  // 列出所有任务
  task_list: () => TASKS.listAll(),
  task_get: ({ task_id }: { task_id: number }) => TASKS.get(task_id),

  // 后台运行命令
  background_run: ({ command }: { command: string }) => BG.run(command),
  check_background: ({ task_id }: { task_id: string }) => BG.check(task_id),

  // agent team
  spawn_teammate: ({ name, role, prompt }) => TEAM.spawn(name, role, prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: ({ to, content, msg_type }) =>
    BUS.send("lead", to, content, msg_type),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: ({ content }) =>
    BUS.broadcast("lead", content, TEAM.memberNames()),

  shutdown_request: ({ teammate }) => handleShutdownRequest(teammate),
  shutdown_response: ({ request_id }) =>
    JSON.stringify(shutdownRequests[request_id] || { error: "not found" }),
  plan_approval: ({ request_id, approve, feedback }) =>
    handlePlanReview(request_id, approve, feedback),
};

export const baseTools = [
  BASH_TOOL_SCHEMA,
  ...FILE_TOOL_SCHEMA,
  TODO_TOOL_SCHEMA,
];

export const mainAgentTools = [
  ...baseTools,
  ...AGENT_TEAM_SCHEMA,
  AGENT_TOOL_SCHEMA,
  ...BG_TOOL_SCHEMA,
  ...TASK_OPERATIONS_SCHEMA,
  COMPACT_TOOL_SCHEMA,
];

export const subagentTools = [...baseTools];
