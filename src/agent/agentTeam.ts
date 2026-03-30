import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Model } from "@anthropic-ai/sdk/resources";
import { getClient } from "./client";
import { runBash } from "../tools/bash";
import { writeFile, editFile } from "../tools/file";

const WORKDIR = process.cwd();
const INBOX_DIR = join(WORKDIR, ".inbox");
const TEAM_DIR = join(WORKDIR, ".team");
const MODEL = (process.env["MODEL_ID"] ?? "claude-sonnet-4-20250514") as Model;

const debug = (...args: unknown[]) =>
  process.stderr.write(`[debug] ${args.join(" ")}\n`);

// --- Types ---

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
] as const);

export const AGENT_TEAM_SCHEMA = [
  {
    name: "spawn_teammate",
    description: "Spawn a persistent teammate that runs in its own thread.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates with name, role, status.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate's inbox.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: {
      type: "object" as const,
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
];

type MessageType = typeof VALID_MSG_TYPES extends Set<infer T> ? T : never;

interface BusMessage {
  type: MessageType;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

interface TeamMember {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

type ToolInput = Record<string, string>;

// --- MessageBus: JSONL-based inbox system for agent communication ---

class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    mkdirSync(this.dir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType: MessageType = "message",
    extra: Record<string, unknown> = {},
  ): string {
    if (!VALID_MSG_TYPES.has(msgType))
      return `Error: Invalid type '${msgType}'`;
    const msg: BusMessage = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    const inboxPath = join(this.dir, `${to}.jsonl`);
    appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    debug(`Message sent: ${sender} -> ${to} [${msgType}]`);
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): BusMessage[] {
    const inboxPath = join(this.dir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) return [];
    const messages = readFileSync(inboxPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BusMessage);
    writeFileSync(inboxPath, "");
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

export const BUS = new MessageBus(INBOX_DIR);

// --- TeammateManager: manages team members, supports spawn and messaging ---

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;

  constructor(teamDir: string) {
    this.dir = teamDir;
    mkdirSync(this.dir, { recursive: true });
    this.configPath = join(this.dir, "config.json");
    this.config = this._loadConfig();
  }

  private _loadConfig(): TeamConfig {
    if (existsSync(this.configPath))
      return JSON.parse(readFileSync(this.configPath, "utf8")) as TeamConfig;
    return { team_name: "default", members: [] };
  }

  private _saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private _findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status))
        return `Error: '${name}' is currently ${member.status}`;
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this._saveConfig();
    debug(`Spawned teammate '${name}' with role '${role}'`);

    this._teammateLoop(name, role, prompt).catch(() => {});
    return `Spawned '${name}' (role: ${role})`;
  }

  private async _teammateLoop(
    name: string,
    role: string,
    prompt: string,
  ): Promise<void> {
    const client = getClient();
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    const tools = this._teammateTools();

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox)
        messages.push({ role: "user", content: JSON.stringify(msg) });

      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages,
          tools,
          max_tokens: 8000,
        });
      } catch {
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = this._exec(name, block.name, block.input as ToolInput);
          console.log(
            `  [${name}] ${block.name}: ${String(output).slice(0, 120)}`,
          );
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(output),
          });
        }
      }
      messages.push({ role: "user", content: results });
    }

    const member = this._findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this._saveConfig();
    }
  }

  private _exec(sender: string, toolName: string, args: ToolInput): string {
    if (toolName === "bash") return runBash(args.command);
    if (toolName === "read_file") {
      try {
        const lines = readFileSync(args.path, "utf8");
        return lines.slice(0, 50000);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
    if (toolName === "write_file") return writeFile(args.path, args.content);
    if (toolName === "edit_file")
      return editFile(args.path, args.old_text, args.new_text);
    if (toolName === "send_message")
      return BUS.send(
        sender,
        args.to,
        args.content,
        args.msg_type as MessageType,
      );
    if (toolName === "read_inbox")
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    return `Unknown tool: ${toolName}`;
  }

  private _teammateTools(): Anthropic.Tool[] {
    return [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
          type: "object" as const,
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
          type: "object" as const,
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object" as const,
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: {
              type: "string",
              enum: Array.from(VALID_MSG_TYPES),
            },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object" as const, properties: {} },
      },
    ];
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    const lines = [
      `Team: ${this.config.team_name}`,
      ...this.config.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`),
    ];
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

export const TEAM = new TeammateManager(TEAM_DIR);
