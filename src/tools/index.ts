import { BASH_TOOL_SCHEMA, runBash } from "./bash";
import { editFile, FILE_TOOL_SCHEMA, readFile, writeFile } from "./file";
import { TODO, TODO_TOOL_SCHEMA, TodoInput } from "./todo";

export const TASK_TOOL_SCHEMA = {
  name: "task",
  description:
    "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "The task prompt for the subagent" },
      description: { type: "string", description: "Short description of the task" },
    },
    required: ["prompt"],
  },
};

export const toolHandlers: Record<string, (input: any) => string | Promise<string>> = {
  bash: ({ command }: { command: string }) => runBash(command),
  read_file: ({ path, limit }: { path: string; limit: number }) => readFile(path, limit),
  write_file: ({ path, content }: { path: string; content: string }) => writeFile(path, content),
  edit_file: ({ path, old_text, new_text }: { path: string; old_text: string; new_text: string }) =>
    editFile(path, old_text, new_text),
  todo: ({ items }: { items: TodoInput[] }) => TODO.update(items),
};

export const baseTools = [BASH_TOOL_SCHEMA, ...FILE_TOOL_SCHEMA, TODO_TOOL_SCHEMA];

export const mainAgentTools = [...baseTools, TASK_TOOL_SCHEMA];

export const subagentTools = [...baseTools];
