import { useState, useMemo } from 'react';
import { CheckCircle2, Circle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { Progress } from './ui/progress';
import { BottomSheet } from './BottomSheet';
import type { AggregatedTask, TaskSnapshot } from '../hooks/useTaskState';

interface TaskBottomSheetProps {
  snapshot: TaskSnapshot;
  open: boolean;
  onClose: () => void;
}

function TaskRow({ task, taskMap }: { task: AggregatedTask; taskMap: Map<string, AggregatedTask> }) {
  const [expanded, setExpanded] = useState(false);

  const blockers = useMemo(() => {
    if (!task.blockedBy?.length) return [];
    return task.blockedBy
      .map(id => taskMap.get(`${task.source}:${id}`))
      .filter((b): b is AggregatedTask => !!b && b.status !== 'completed');
  }, [task.blockedBy, task.source, taskMap]);

  const isBlocked = blockers.length > 0;
  const hasExpandable = task.description || task.activeForm;

  return (
    <div className={`py-2 border-b border-border/50 last:border-b-0 ${isBlocked ? 'opacity-50' : ''}`}>
      <div
        className={`flex items-start gap-2.5 ${hasExpandable ? 'cursor-pointer' : ''}`}
        onClick={() => hasExpandable && setExpanded(!expanded)}
      >
        <span className="mt-0.5 shrink-0">
          {task.status === 'completed' ? (
            <CheckCircle2 className="size-4 text-success" />
          ) : task.status === 'in_progress' ? (
            <Loader2 className="size-4 text-accent animate-spin" />
          ) : (
            <Circle className="size-4 text-text-dim" />
          )}
        </span>

        <span className={`text-sm flex-1 ${
          task.status === 'completed' ? 'text-text-dim line-through' :
          task.status === 'in_progress' ? 'text-text font-medium' :
          'text-text-secondary'
        }`}>
          {task.subject}
        </span>

        {isBlocked && (
          <span className="text-[10px] bg-warning/20 text-warning px-1.5 py-0.5 rounded shrink-0">
            blocked
          </span>
        )}

        {hasExpandable && (
          <span className="shrink-0 mt-0.5">
            {expanded ? (
              <ChevronUp className="size-3.5 text-text-dim" />
            ) : (
              <ChevronDown className="size-3.5 text-text-dim" />
            )}
          </span>
        )}
      </div>

      {task.status === 'in_progress' && task.activeForm && (
        <div className="ml-7 mt-1 text-xs text-accent italic">
          {task.activeForm}
        </div>
      )}

      {isBlocked && (
        <div className="ml-7 mt-1 text-[11px] text-text-dim">
          <span className="text-warning">↳</span> waiting: {blockers.map(b => b.subject).join(', ')}
        </div>
      )}

      {expanded && task.description && (
        <div className="ml-7 mt-2 px-2.5 py-2 bg-surface-light rounded-md text-xs text-text-secondary leading-relaxed">
          {task.description}
        </div>
      )}
    </div>
  );
}

function HistorySection({ tasks, taskMap }: { tasks: AggregatedTask[]; taskMap: Map<string, AggregatedTask> }) {
  const [expanded, setExpanded] = useState(false);
  const completed = tasks.filter(t => t.status === 'completed').length;

  return (
    <div className="border-t border-border/30 mt-2 pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-xs text-text-dim py-1"
      >
        <span>Previous tasks ({completed}/{tasks.length})</span>
        {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {expanded && tasks.map(task => (
        <TaskRow key={`${task.source}:${task.id}`} task={task} taskMap={taskMap} />
      ))}
    </div>
  );
}

export function TaskBottomSheet({ snapshot, open, onClose }: TaskBottomSheetProps) {
  const { tasks, currentRound, completed, total, hasHistory } = snapshot;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const taskMap = useMemo(() => {
    const map = new Map<string, AggregatedTask>();
    for (const t of tasks) map.set(`${t.source}:${t.id}`, t);
    return map;
  }, [tasks]);

  const historyTasks = useMemo(() => {
    if (!hasHistory) return [];
    const currentIds = new Set(currentRound.map(t => `${t.source}:${t.id}`));
    return tasks.filter(t => !currentIds.has(`${t.source}:${t.id}`));
  }, [tasks, currentRound, hasHistory]);

  return (
    <BottomSheet visible={open} onClose={onClose} className="max-h-[70vh] flex flex-col">
      <div className="flex items-center justify-between px-4 pb-2">
        <span className="text-sm font-semibold text-text">Tasks</span>
        <span className="text-xs text-success font-mono">{completed}/{total}</span>
      </div>

      <div className="px-4 pb-3">
        <Progress value={pct} className="h-1.5" />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {currentRound.map(task => (
          <TaskRow
            key={`${task.source}:${task.id}`}
            task={task}
            taskMap={taskMap}
          />
        ))}

        {historyTasks.length > 0 && (
          <HistorySection tasks={historyTasks} taskMap={taskMap} />
        )}
      </div>
    </BottomSheet>
  );
}
