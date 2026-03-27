/**
 * Find the session most likely showing an interactive prompt.
 * Checks for actively processing sessions first, then falls back to most recent.
 */
export function findActiveSession(
  sessions: Map<string, { isProcessing: boolean; lastActivity: number | null }>
): string | null {
  for (const [id, session] of sessions) {
    if (session.isProcessing) return id;
  }
  let latest: string | null = null;
  let latestTime = 0;
  for (const [id, session] of sessions) {
    if (session.lastActivity && session.lastActivity > latestTime) {
      latestTime = session.lastActivity;
      latest = id;
    }
  }
  return latest;
}
