import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api';
import { STORAGE } from '../lib/storage-keys';

export function useSessions() {
  const [allSessions, setAllSessions] = useState<any[]>([]);
  const [selectedProjectDir, setSelectedProjectDir] = useState<string | null>(
    () => localStorage.getItem(STORAGE.PROJECT_DIR)
  );
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'projects' | 'active'>('projects');
  const [activeSessions, setActiveSessions] = useState<any[]>([]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const sessionsData = await api.sessions(undefined, 200);
      setAllSessions(sessionsData);
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const fetchActiveSessions = useCallback(async () => {
    try {
      const data = await api.activeSessions();
      // Skip setState if data unchanged — prevents re-render every 10s poll
      setActiveSessions(prev =>
        JSON.stringify(prev) === JSON.stringify(data) ? prev : data
      );
    } catch (err) {
      console.error('Failed to fetch active sessions:', err);
    }
  }, []);

  // Poll every 10s when Active tab is selected
  useEffect(() => {
    if (activeTab !== 'active') return;
    fetchActiveSessions();
    const interval = setInterval(fetchActiveSessions, 3000);
    return () => clearInterval(interval);
  }, [activeTab, fetchActiveSessions]);

  // Fetch once on mount for green dots in project view
  useEffect(() => {
    fetchActiveSessions();
  }, [fetchActiveSessions]);

  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of activeSessions) {
      if (s.sessionId) ids.add(s.sessionId);
    }
    return ids;
  }, [activeSessions]);

  const projects = useMemo(() => {
    const cwds = new Set<string>();
    for (const s of allSessions) {
      if (s.cwd) cwds.add(s.cwd);
    }
    return [...cwds].sort();
  }, [allSessions]);

  const sessionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of allSessions) {
      const dir = s.cwd || '';
      counts[dir] = (counts[dir] || 0) + 1;
    }
    return counts;
  }, [allSessions]);

  const filteredSessions = useMemo(() => {
    if (!selectedProjectDir) return [];
    return allSessions.filter((s) => s.cwd === selectedProjectDir);
  }, [allSessions, selectedProjectDir]);

  const selectProject = useCallback((dir: string | null) => {
    setSelectedProjectDir(dir);
    if (dir) {
      localStorage.setItem(STORAGE.PROJECT_DIR, dir);
    } else {
      localStorage.removeItem(STORAGE.PROJECT_DIR);
    }
  }, []);

  return {
    sessions: filteredSessions,
    projects,
    selectedProjectDir,
    selectProject,
    sessionCounts,
    loading,
    refresh: fetchAll,
    activeTab,
    setActiveTab,
    activeSessions,
    activeSessionIds,
    refreshActive: fetchActiveSessions,
  };
}
