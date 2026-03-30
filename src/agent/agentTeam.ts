import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
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

export const shutdownRequests: Record<string, { target: string; status: string }> = {};
export const planRequests: Record<
  string,
  { from: string; plan: string; status: string }
> = {};

// 处理关闭请求：生成request_id并发送给teammate
export function handleShutdownRequest(teammate: string) {
  const reqId = randomBytes(4).toString("hex");
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  debug(`Shutdown request ${reqId} sent to '${teammate}'`);
  BUS.send(
    "lead",
    teammate,
    "Please shut down gracefully.",
    "shutdown_request",
    { request_id: reqId },
  );
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

// 处理计划审批：批准或拒绝teammate的计划
export function handlePlanReview(requestId: string, approve: boolean, feedback = "") {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

// --- Types ---

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_submission",
  "plan_approval_response",
] as const);

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

export const AGENT_TEAM_SCHEMA = [
  {
    name: "send_message",
    description: "Send a message to a teammate.",
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
  {
    name: "shutdown_request",
    description:
      "Request a teammate to shut down gracefully. Returns a request_id for tracking.",
    input_schema: {
      type: "object" as const,
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "shutdown_response",
    description: "Check the status of a shutdown request by request_id.",
    input_schema: {
      type: "object" as const,
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "force_shutdown",
    description:
      "Force a teammate to stop immediately, bypassing the graceful shutdown protocol. Use only after a teammate rejects a shutdown_request.",
    input_schema: {
      type: "object" as const,
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "plan_approval",
    description:
      "Approve or reject a teammate's plan. Provide request_id + approve + optional feedback.",
    input_schema: {
      type: "object" as const,
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
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
  private _forceShutdowns = new Set<string>();

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
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}.

MANDATORY PROTOCOLS — you MUST follow these without exception:
1. Before starting any major work, you MUST call the plan_approval tool to submit your plan. NEVER write plans to files or send them as messages — only use the plan_approval tool. Wait for lead approval before proceeding.
2. When you receive a shutdown_request message, you MUST respond using the shutdown_response tool with the provided request_id.`;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    const tools = this._teammateTools();
    let shouldExit = false;

    for (let i = 0; i < 50; i++) {
      if (this._forceShutdowns.has(name)) {
        this._forceShutdowns.delete(name);
        debug(`[${name}] Force shutdown triggered, exiting loop`);
        shouldExit = true;
        break;
      }
      const inbox = BUS.readInbox(name);
      for (const msg of inbox)
        messages.push({ role: "user", content: JSON.stringify(msg) });
      if (shouldExit) break;

      let response: Anthropic.Message | undefined;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          response = await client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools,
            max_tokens: 8000,
          });
          break;
        } catch (e: any) {
          const status = e?.status ?? e?.error?.status;
          debug(`[${name}] API error (attempt ${retry + 1}/${MAX_RETRIES + 1}): ${e.message}`);
          if (status >= 500 && retry < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (retry + 1)));
            continue;
          }
          break;
        }
      }
      if (!response) break;

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
          if (
            block.name === "shutdown_response" &&
            (block.input as ToolInput).approve
          )
            shouldExit = true;
        }
      }
      messages.push({ role: "user", content: results });
    }

    const member = this._findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
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
    if (toolName === "shutdown_response") {
      const reqId = args.request_id;
      const approve = args.approve === "true";
      if (shutdownRequests[reqId])
        shutdownRequests[reqId].status = approve ? "approved" : "rejected";
      BUS.send(sender, "lead", args.reason || "", "shutdown_response", {
        request_id: reqId,
        approve,
      });
      return `Shutdown ${approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const planText = args.plan || "";
      const reqId = randomBytes(4).toString("hex");
      planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
      BUS.send(sender, "lead", planText, "plan_submission", {
        request_id: reqId,
        plan: planText,
      });
      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }
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
      {
        name: "shutdown_response",
        description:
          "Respond to a shutdown request. Approve to shut down, reject to keep working.",
        input_schema: {
          type: "object" as const,
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval. Provide plan text.",
        input_schema: {
          type: "object" as const,
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
    ];
  }

  forceShutdown(name: string): string {
    const member = this._findMember(name);
    if (!member) return `Error: Unknown teammate '${name}'`;
    if (member.status !== "working") return `Error: '${name}' is not working (status: ${member.status})`;
    this._forceShutdowns.add(name);
    debug(`Force shutdown issued for '${name}'`);
    return `Force shutdown issued for '${name}'. Will terminate at next loop iteration.`;
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
