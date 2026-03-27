import dotenv from "dotenv";
import { liteAgent } from "./agent";
import { MessageParam } from "@anthropic-ai/sdk/resources";
dotenv.config();

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

    history.push({ role: "user", content: query });
    await liteAgent(history);

    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") console.log(block.text);
      }
    }
    console.log();
  }
  rl.close();
}

main().catch(console.error);
