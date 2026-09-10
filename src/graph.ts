import type { Task } from "./types.js";

export class SdlcGraphError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SdlcGraphError";
  }
}

export function assertAcyclic(tasks: readonly Task[]): void {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (!taskById.has(dependencyId)) {
        throw new SdlcGraphError(`Task ${task.id} depends on missing task ${dependencyId}`);
      }
      if (dependencyId === task.id) {
        throw new SdlcGraphError(`Task ${task.id} cannot depend on itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      throw new SdlcGraphError(`Task dependency cycle: ${[...path.slice(cycleStart), taskId].join(" -> ")}`);
    }
    if (visited.has(taskId)) {
      return;
    }

    visiting.add(taskId);
    path.push(taskId);
    for (const dependencyId of taskById.get(taskId)!.dependencies) {
      visit(dependencyId);
    }
    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) {
    visit(task.id);
  }
}

export function findReadyTaskIds(tasks: readonly Task[]): string[] {
  assertAcyclic(tasks);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return tasks
    .filter((task) => task.status === "pending" && task.dependencies.every((id) => taskById.get(id)?.status === "completed"))
    .map((task) => task.id);
}
