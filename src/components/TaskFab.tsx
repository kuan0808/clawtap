import { useState, useEffect } from 'react';
import type { TaskSnapshot } from '../hooks/useTaskState';

type FabState = 'hidden' | 'visible' | 'fading';

interface TaskFabProps {
  snapshot: TaskSnapshot;
  onClick: () => void;
}

export function TaskFab({ snapshot, onClick }: TaskFabProps) {
  const { completed, total } = snapshot;
  const [fabState, setFabState] = useState<FabState>('hidden');

  const allDone = total > 0 && completed === total;
  const pct = total > 0 ? completed / total : 0;

  useEffect(() => {
    if (total === 0) {
      setFabState('hidden');
      return;
    }
    setFabState('visible');
    if (allDone) {
      const timer = setTimeout(() => setFabState('fading'), 3000);
      return () => clearTimeout(timer);
    }
  }, [total, allDone]);

  useEffect(() => {
    if (fabState !== 'fading') return;
    const timer = setTimeout(() => setFabState('hidden'), 500);
    return () => clearTimeout(timer);
  }, [fabState]);

  if (fabState === 'hidden') return null;

  const size = 48;
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - pct);

  return (
    <button
      onClick={onClick}
      className="fixed bottom-20 right-4 z-20 safe-bottom transition-opacity duration-500"
      style={{ opacity: fabState === 'fading' ? 0 : 1 }}
      aria-label={`Tasks: ${completed} of ${total} completed`}
    >
      <svg width={size} height={size} className="drop-shadow-lg">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="var(--color-surface)"
          stroke="var(--color-border)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={allDone ? 'var(--color-success)' : 'var(--color-accent)'}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-all duration-500 ease-out"
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill={allDone ? 'var(--color-success)' : 'var(--color-text)'}
          fontSize="13"
          fontWeight="600"
          fontFamily="var(--font-mono, monospace)"
        >
          {completed}/{total}
        </text>
      </svg>
    </button>
  );
}
