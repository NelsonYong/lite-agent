// lite agent

import Anthropic from "@anthropic-ai/sdk";
import { MessageParam, Model, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { BASH_TOOL_SCHEMA, runBash } from "../tools/bash";
import { editFile, FILE_TOOL_SCHEMA, readFile, writeFile } from "../tools/file";
import { TODO, TODO_TOOL_SCHEMA, TodoInput } from "../tools/todo";

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      baseURL: process.env["ANTHROPIC_BASE_URL"],
    });
  }
  return anthropic;
}


// 目的是控制参数传递，后续可以对它进行校验，不用进入到 agent 内部让模型判断
const toolHandlers = {
  "bash": ({ command }: { command: string }) => runBash(command),
  "read_file": ({ path, limit }: { path: string, limit: number }) => readFile(path, limit),
  "write_file": ({ path, content }: { path: string, content: string }) => writeFile(path, content),
  "edit_file": ({ path, old_text, new_text }: { path: string, old_text: string, new_text: string }) => editFile(path, old_text, new_text),
  "todo": ({ items }: { items: TodoInput[] }) => TODO.update(items),
}


// 主函数
export async function liteAgent({
  messages,
  system,
  forceTool,
}: {
  messages: MessageParam[];
  system?: string;
  forceTool?: string
}) {
  // 记录上次 todo 工具使用到现在的轮次
  let roundsSinceTodo = 0;
  while (true) {

    const response = await getClient().messages.create({
      messages,
      model: process.env["MODEL_ID"] as Model,
      max_tokens: 8000,
      system,
      tools: [BASH_TOOL_SCHEMA, ...FILE_TOOL_SCHEMA, TODO_TOOL_SCHEMA],
      tool_choice: forceTool ? { type: "tool", name: forceTool } : undefined,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results: (ToolResultBlockParam | TextBlockParam)[] = [];
    let usedTodo = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const input = block.input as any
        try {
          console.log("block.name", block.name);

          const handler = toolHandlers[block.name as keyof typeof toolHandlers];
          const output = handler ? await handler(input) : `Error: Handler not found for tool ${block.name}`;
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
          // 记录 todo 工具使用到现在的轮次
          if (block.name === "todo") {
            usedTodo = true;
          }
        } catch (e: any) {
          const output = `Error: ${e.message}`;
          console.log(`> ${block.name}: ${output}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        }
      }
    }
    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
      });
    }
    messages.push({ role: "user", content: results });
  }
}