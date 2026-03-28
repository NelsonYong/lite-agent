import { MessageParam, Model, TextBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { getClient } from "./client";
import { runSubagent } from "./subagent";
import { mainAgentTools, toolHandlers } from "../tools";

export async function liteAgent({
  messages,
  system,
  forceTool,
}: {
  messages: MessageParam[];
  system?: string;
  forceTool?: string;
}) {
  let roundsSinceTodo = 0;

  while (true) {
    const response = await getClient().messages.create({
      messages,
      model: process.env["MODEL_ID"] as Model,
      max_tokens: 8000,
      system,
      tools: mainAgentTools,
      tool_choice: forceTool ? { type: "tool", name: forceTool } : undefined,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results: (ToolResultBlockParam | TextBlockParam)[] = [];
    let usedTodo = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const input = block.input as any;
      let output: string;

      try {
        if (block.name === "task") {
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

    messages.push({ role: "user", content: results });
  }
}
