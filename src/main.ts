import dotenv from "dotenv";
import { liteAgent } from "./agent";
import { MessageParam } from "@anthropic-ai/sdk/resources";
import { resolve } from "node:path";
import { buildMainAgentPrompt } from "./prompt/system";
dotenv.config();

// 确定工作空间，不让 agent 逃逸出工作空间
const WORKDIR = process.cwd();

const SYSTEM = buildMainAgentPrompt(WORKDIR);


// 操作文件一定只能操作工作空间内的文件
export function safePath(p: string) {
  const path = resolve(WORKDIR, p);
  if (!path.startsWith(WORKDIR))
    throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

async function main() {
  const history: MessageParam[] = [];
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () =>
    new Promise<string>((resolve) => rl.question("\x1b[36mlite-agent >> \x1b[0m", resolve));

  while (true) {
    const query = await prompt();
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;

    const forceTool = query.startsWith("/todo") ? "todo" : undefined;
    history.push({ role: "user", content: query.replace("/todo", "").trim() || "Update todos." });
    await liteAgent({
      messages: history,
      system: SYSTEM,
      forceTool
    });

    // 取出最后一个消息的 content
    const lastContent = history[history.length - 1].content;

    //  打印最后一个消息的 content
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") console.log(block.text);
      }
    } else
      console.log(lastContent);
  }
  rl.close();
}

main().catch(console.error);
