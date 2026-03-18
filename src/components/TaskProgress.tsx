import { useState } from 'react';
import { Progress } from './ui/progress';
import { Circle, CircleDot, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';

type TodoItem = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' };

export function TaskProgress({ input }: { input: any }) {
  const [collapsed, setCollapsed] = useState(false);
  const tasks: TodoItem[] = input?.tasks || input?.todos || [];
  if (tasks.length === 0) return null;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const pct = Math.round((completed / tasks.length) * 100);

  return (
    <div className="mb-3">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between mb-2"
      >
        <span className="text-xs text-text-dim">Tasks ({completed}/{tasks.length})</span>
        {collapsed ? (
          <ChevronDown className="size-3.5 text-text-dim" />
        ) : (
          <ChevronUp className="size-3.5 text-text-dim" />
        )}
      </button>
      <Progress value={pct} className="mb-2" />
      {!collapsed && (
        <div className="space-y-1.5">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-start gap-2">
              <span className="mt-0.5">
                {task.status === 'completed' ? (
                  <CheckCircle2 className="size-3.5 text-success" />
                ) : task.status === 'in_progress' ? (
                  <CircleDot className="size-3.5 text-accent" />
                ) : (
                  <Circle className="size-3.5 text-text-dim" />
                )}
              </span>
              <span className={`text-sm ${task.status === 'completed' ? 'text-text-dim line-through' : 'text-text'}`}>
                {task.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
