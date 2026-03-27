// lite agent

import Anthropic from "@anthropic-ai/sdk";
import { MessageParam, Model, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { BASH_TOOL_SCHEMA, runBash } from "../tools/bash";

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

export async function liteAgent(messages: MessageParam[]) {
  while (true) {
    const response = await getClient().messages.create({
      messages,
      model: process.env["MODEL_ID"] as Model,
      max_tokens: 8000,
      tools: [BASH_TOOL_SCHEMA],
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    const results: ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "bash") {
          const input = block.input as { command: string };
          console.log(`\x1b[33m$ ${input.command}\x1b[0m`);

          const output = runBash(input.command);

          console.log(output.slice(0, 200));

          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
          });
        }
      }
    }

    messages.push({ role: "user", content: results });
  }
}