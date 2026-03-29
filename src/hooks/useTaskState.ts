import { useState, useCallback } from 'react';
import type { AggregatedTask, TaskSnapshot } from '../../server/stores/task-aggregator';

export type { AggregatedTask, TaskSnapshot };

const EMPTY_SNAPSHOT: TaskSnapshot = { tasks: [], currentRound: [], completed: 0, total: 0, round: 0, hasHistory: false };

export function useTaskState() {
  const [taskSnapshot, setTaskSnapshot] = useState<TaskSnapshot>(EMPTY_SNAPSHOT);

  const handleTaskState = useCallback((msg: TaskSnapshot) => {
    setTaskSnapshot(msg);
  }, []);

  const resetTasks = useCallback(() => {
    setTaskSnapshot(EMPTY_SNAPSHOT);
  }, []);

  return { taskSnapshot, handleTaskState, resetTasks };
}
