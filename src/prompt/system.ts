import { getSkillLoader } from "../agent/skill";

// 构建主 agent 提示词
export function buildMainAgentPrompt(workdir: string) {
  if (!workdir) {
    throw new Error("workdir is required");
  }

  return `You are a coding agent at ${workdir}.Use tools to solve tasks.

// TodoManager: Track tasks with status and nag reminders
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.
For any task with 3+ steps, ALWAYS call todo first to plan, then execute step by step.


Use load_skill to access specialized knowledge before tackling unfamiliar topics.
Skills available:
${getSkillLoader().getDescriptions()}
`
}

// 构建 subagent 提示词
export function buildSubagentPrompt(workdir: string) {
  if (!workdir) {
    throw new Error("workdir is required");
  }
  return `You are a coding subagent at ${workdir}. Complete the given task, then summarize your findings.`;
}