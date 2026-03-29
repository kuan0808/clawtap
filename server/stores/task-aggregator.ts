/**
 * Pure aggregator: processes tool_use blocks (TaskCreate, TaskUpdate, TodoWrite)
 * and produces a unified AggregatedTask[] snapshot with round-based grouping.
 *
 * A new "round" starts when all tasks were completed and a new TaskCreate arrives.
 * The snapshot exposes both the current round (for FAB) and all tasks (for sheet history).
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
  round: number;
}

export interface TaskSnapshot {
  /** All tasks across all rounds */
  tasks: AggregatedTask[];
  /** Current round tasks only (for FAB display) */
  currentRound: AggregatedTask[];
  /** Completed count in current round */
  completed: number;
  /** Total count in current round */
  total: number;
  /** Current round number (0-based) */
  round: number;
  /** Whether there are previous rounds (for sheet "history" section) */
  hasHistory: boolean;
}

/** Tool names that produce task state changes. */
export const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
/** Subset handled on tool-start (TaskCreate needs result text, so it's deferred to tool-done). */
export const TASK_TOOLS_ON_START = new Set(['TaskUpdate', 'TodoWrite']);

export class TaskAggregator {
  private taskApiTasks = new Map<string, AggregatedTask>();
  private todoWriteTasks = new Map<string, AggregatedTask>();
  private cachedSnapshot: TaskSnapshot | null = null;
  private currentRound = 0;
  private allCompletedBeforeCreate = true; // tracks if all tasks were done before last TaskCreate

  /** Process a single tool_use block. Returns true if state changed. */
  processToolUse(toolName: string, input: Record<string, unknown>, resultText?: string): boolean {
    switch (toolName) {
      case 'TaskCreate': {
        // Start a new round if all previous tasks were completed
        if (this.taskApiTasks.size > 0 && this.allCompletedBeforeCreate) {
          this.currentRound++;
        }
        this.allCompletedBeforeCreate = false;

        const match = resultText?.match(/Task #(\d+)/);
        const id = match?.[1] || String(this.taskApiTasks.size + 1);
        this.taskApiTasks.set(id, {
          id,
          subject: (input.subject as string) || '',
          description: (input.description as string) || undefined,
          activeForm: (input.activeForm as string) || undefined,
          status: 'pending',
          source: 'task-api',
          round: this.currentRound,
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
          this.updateCompletionState();
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
        this.updateCompletionState();
        return true;
      }

      case 'TodoWrite': {
        // TodoWrite always starts a new round (replaces entire todo list)
        if (this.todoWriteTasks.size > 0 || this.taskApiTasks.size > 0) {
          const allDone = this.allTasksCompleted();
          if (allDone) this.currentRound++;
        }
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
            round: this.currentRound,
          });
        }
        this.cachedSnapshot = null;
        this.updateCompletionState();
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
    const currentRound = tasks.filter(t => t.round === this.currentRound);
    const completed = currentRound.filter(t => t.status === 'completed').length;
    this.cachedSnapshot = {
      tasks,
      currentRound,
      completed,
      total: currentRound.length,
      round: this.currentRound,
      hasHistory: this.currentRound > 0,
    };
    return this.cachedSnapshot;
  }

  get hasTasks(): boolean {
    return this.taskApiTasks.size > 0 || this.todoWriteTasks.size > 0;
  }

  clear(): void {
    this.taskApiTasks.clear();
    this.todoWriteTasks.clear();
    this.cachedSnapshot = null;
    this.currentRound = 0;
    this.allCompletedBeforeCreate = true;
  }

  private allTasksCompleted(): boolean {
    for (const t of this.taskApiTasks.values()) {
      if (t.status !== 'completed') return false;
    }
    for (const t of this.todoWriteTasks.values()) {
      if (t.status !== 'completed') return false;
    }
    return true;
  }

  /** Update the flag that tracks whether all tasks are done (for round detection). */
  private updateCompletionState(): void {
    this.allCompletedBeforeCreate = this.allTasksCompleted();
  }
}
