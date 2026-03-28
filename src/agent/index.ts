import { MessageParam, Model, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { getClient } from "./client";
import { runSubagent } from "./subagent";
import { mainAgentTools, toolHandlers } from "../tools";
import { autoCompact, microCompact } from "./compact";


const COMPACT_MAX_TOKENS_THRESHOLD = 150_000;

export async function liteAgent({
  messages: initialMessages,
  system,
  forceTool,
}: {
  messages: MessageParam[];
  system?: string;
  forceTool?: string;
}) {
  let messages = initialMessages;
  let lastInputTokens = 0;
  let roundsSinceTodo = 0;

  while (true) {
    // 每次调用 llm 都将 tool result 替换成标识符
    messages = microCompact(messages, lastInputTokens);

    // 超过 150k 时触发深度压缩：调用 LLM 生成摘要，替换全部历史消息
    if (lastInputTokens > COMPACT_MAX_TOKENS_THRESHOLD) {
      console.log('[auto_compact triggered]');
      messages = await autoCompact(messages);
    }

    // 调用 llm
    const response = await getClient().messages.create({
      messages,
      model: process.env["MODEL_ID"] as Model,
      max_tokens: 8000,
      system,
      tools: mainAgentTools,
      tool_choice: forceTool ? { type: "tool", name: forceTool } : undefined,
    });
    lastInputTokens = response.usage.input_tokens;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results: (ToolResultBlockParam | TextBlockParam)[] = [];
    let usedTodo = false;
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const input = block.input as any;
      let output: string;

      try {
        if (block.name === 'compact') {
          manualCompact = true;
          output = 'Compressing...';
        }
        else if (block.name === "task") {
          const desc = input.description || "subtask";
          console.log(`> task (${desc}): ${input.prompt.slice(0, 80)}`);
          output = await runSubagent(input.prompt);
        } else {
          const handler = toolHandlers[block.name];
          output = handler
            ? await handler(input)
            : `Error: Handler not found for tool ${block.name}`;
          if (block.name === "todo") usedTodo = true;
        }
      } catch (e: any) {
        output = `Error: ${e.message}`;
        console.log(`> ${block.name}: ${output}`);
      }

      results.push({ type: "tool_result", tool_use_id: block.id, content: output! });
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
      });
    }

    if (manualCompact) {
      console.log('[manual compact]');
      messages.splice(0, messages.length, ...await autoCompact(messages));
    }

    messages.push({ role: "user", content: results });
  }
}
