/**
 * Pure aggregator: processes tool_use blocks (TaskCreate, TaskUpdate, TodoWrite)
 * and produces a unified AggregatedTask[] snapshot.
 *
 * Stateful — call processToolUse() for each relevant tool call in order.
 * Call getSnapshot() to read current state (cached, invalidated on changes).
 */

export interface AggregatedTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy?: string[];
  blocks?: string[];
  source: 'task-api' | 'todo-write';
}

export interface TaskSnapshot {
  tasks: AggregatedTask[];
  completed: number;
  total: number;
}

/** Tool names that produce task state changes. */
export const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
/** Subset handled on tool-start (TaskCreate needs result text, so it's deferred to tool-done). */
export const TASK_TOOLS_ON_START = new Set(['TaskUpdate', 'TodoWrite']);

export class TaskAggregator {
  private taskApiTasks = new Map<string, AggregatedTask>();
  private todoWriteTasks = new Map<string, AggregatedTask>();
  private cachedSnapshot: TaskSnapshot | null = null;

  /** Process a single tool_use block. Returns true if state changed. */
  processToolUse(toolName: string, input: Record<string, unknown>, resultText?: string): boolean {
    switch (toolName) {
      case 'TaskCreate': {
        const match = resultText?.match(/Task #(\d+)/);
        const id = match?.[1] || String(this.taskApiTasks.size + 1);
        this.taskApiTasks.set(id, {
          id,
          subject: (input.subject as string) || '',
          description: (input.description as string) || undefined,
          activeForm: (input.activeForm as string) || undefined,
          status: 'pending',
          source: 'task-api',
        });
        this.cachedSnapshot = null;
        return true;
      }

      case 'TaskUpdate': {
        const taskId = input.taskId as string;
        if (!taskId) return false;
        const existing = this.taskApiTasks.get(taskId);
        if (!existing) return false;
        if (input.status === 'deleted') {
          this.taskApiTasks.delete(taskId);
          this.cachedSnapshot = null;
          return true;
        }
        const updated: AggregatedTask = { ...existing };
        if (input.status) updated.status = input.status as AggregatedTask['status'];
        if (input.subject) updated.subject = input.subject as string;
        if (input.description) updated.description = input.description as string;
        if (input.activeForm) updated.activeForm = input.activeForm as string;
        if (input.addBlockedBy) {
          updated.blockedBy = [...(updated.blockedBy || []), ...(input.addBlockedBy as string[])];
        }
        if (input.addBlocks) {
          updated.blocks = [...(updated.blocks || []), ...(input.addBlocks as string[])];
        }
        this.taskApiTasks.set(taskId, updated);
        this.cachedSnapshot = null;
        return true;
      }

      case 'TodoWrite': {
        this.todoWriteTasks.clear();
        const tasks = (input.tasks || input.todos || []) as Array<{
          id: string;
          content: string;
          status: string;
        }>;
        for (const t of tasks) {
          this.todoWriteTasks.set(t.id, {
            id: t.id,
            subject: t.content || '',
            status: (t.status as AggregatedTask['status']) || 'pending',
            source: 'todo-write',
          });
        }
        this.cachedSnapshot = null;
        return true;
      }

      default:
        return false;
    }
  }

  getSnapshot(): TaskSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const tasks: AggregatedTask[] = [
      ...this.taskApiTasks.values(),
      ...this.todoWriteTasks.values(),
    ];
    const completed = tasks.filter(t => t.status === 'completed').length;
    this.cachedSnapshot = { tasks, completed, total: tasks.length };
    return this.cachedSnapshot;
  }

  get hasTasks(): boolean {
    return this.taskApiTasks.size > 0 || this.todoWriteTasks.size > 0;
  }

  clear(): void {
    this.taskApiTasks.clear();
    this.todoWriteTasks.clear();
    this.cachedSnapshot = null;
  }
}
