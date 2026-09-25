import { assertTaskAgentDispatch, recordAgentDispatch, type AgentDispatchInput } from "./agents.js";
import { mutateRunManifest } from "./manifest-transaction.js";
import { loadRun } from "./runs.js";
import { prepareTransitionContext, transitionTask } from "./transitions.js";

/** Bridges a successful host launch to the existing audited dispatch/start sequence. Never spawns an agent. */
export async function activateTask(root: string, runId: string, taskId: string, input: AgentDispatchInput, reason: string, at = new Date().toISOString()) {
  if (!reason.trim()) throw new Error("activation requires a reason");
  const manifest = await loadRun(root, runId);
  const task = manifest.tasks.find((entry) => entry.id === taskId);
  if (task === undefined) throw new Error(`unknown task: ${taskId}`);
  const last = task.agent_dispatches?.at(-1);
  if (task.status === "running" && last?.agent_id === input.agent_id && JSON.stringify(last.plan) === JSON.stringify(input.plan)
    && last.actual_model === input.actual_model && last.actual_reasoning_effort === input.actual_reasoning_effort && last.observation_source === input.observation_source) {
    assertTaskAgentDispatch(manifest, task);
    return { task_id: taskId, status: task.status, agent_id: last.agent_id, already_active: true };
  }
  if (task.status !== "ready") throw new Error("activate-task requires a ready task; use the existing resume dispatch flow for an already running task");
  if (input.plan.task_id !== taskId || input.plan.run_id !== runId) throw new Error("dispatch plan identity does not match activation");
  const dispatch = await recordAgentDispatch(root, runId, taskId, input, at);
  const transaction = await mutateRunManifest(root, runId, async (current) => {
    const active = current.tasks.find((entry) => entry.id === taskId);
    if (active?.agent_dispatches?.at(-1)?.agent_id !== dispatch.agent_id) throw new Error("dispatch changed before activation");
    const request = { taskId, to: "running" as const, actor: "pm", reason, at };
    Object.assign(current, transitionTask(current, request, await prepareTransitionContext(root, runId, current, request)));
  });
  return { task_id: taskId, status: transaction.manifest.tasks.find((entry) => entry.id === taskId)!.status, agent_id: dispatch.agent_id, already_active: false };
}
