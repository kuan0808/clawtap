/**
 * PermissionManager — manages pending permission and question requests.
 *
 * Extracted from TmuxAdapter to allow reuse across adapters.
 * Handles timeouts, session-scoped indexing, and bulk operations.
 */

export interface PendingPermission {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingQuestion {
  sessionId: string;
  requestId: string;
  originalInput: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionManager {
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  /** sessionId -> Set<requestId> for fast session-scoped lookups */
  private sessionPendingIds = new Map<string, Set<string>>();
  private timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  // === Permissions ===

  addPermission(requestId: string, sessionId: string, data: { toolName: string; input: Record<string, unknown> }): void {
    const timer = setTimeout(() => {
      this.pendingPermissions.delete(requestId);
      this._removePendingId(sessionId, requestId);
    }, this.timeoutMs);

    this.pendingPermissions.set(requestId, {
      sessionId,
      requestId,
      toolName: data.toolName,
      input: data.input,
      timer,
    });
    this._trackPendingId(sessionId, requestId);
  }

  resolvePermission(requestId: string): PendingPermission | undefined {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    this._removePendingId(pending.sessionId, requestId);
    return pending;
  }

  // === Questions ===

  addQuestion(requestId: string, sessionId: string, data: { originalInput: Record<string, unknown> }): void {
    const timer = setTimeout(() => {
      this.pendingQuestions.delete(requestId);
      this._removePendingId(sessionId, requestId);
    }, this.timeoutMs);

    this.pendingQuestions.set(requestId, {
      sessionId,
      requestId,
      originalInput: data.originalInput,
      timer,
    });
    this._trackPendingId(sessionId, requestId);
  }

  resolveQuestion(requestId: string): PendingQuestion | undefined {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pendingQuestions.delete(requestId);
    this._removePendingId(pending.sessionId, requestId);
    return pending;
  }

  // === Session-scoped Operations ===

  /** Get all pending permissions for a session (for reconnect replay). */
  getPendingForSession(sessionId: string): PendingPermission[] {
    const ids = this.sessionPendingIds.get(sessionId);
    if (!ids) return [];
    const result: PendingPermission[] = [];
    for (const reqId of ids) {
      const perm = this.pendingPermissions.get(reqId);
      if (perm) result.push(perm);
    }
    return result;
  }

  /** Get all pending questions for a session (for reconnect replay). */
  getQuestionsForSession(sessionId: string): PendingQuestion[] {
    const ids = this.sessionPendingIds.get(sessionId);
    if (!ids) return [];
    const result: PendingQuestion[] = [];
    for (const reqId of ids) {
      const q = this.pendingQuestions.get(reqId);
      if (q) result.push(q);
    }
    return result;
  }

  /** Clear all pending requests for a session (e.g., when all clients disconnect or turn ends). */
  dismissAll(sessionId: string): void {
    const ids = this.sessionPendingIds.get(sessionId);
    if (!ids) return;
    for (const reqId of ids) {
      const perm = this.pendingPermissions.get(reqId);
      if (perm) { clearTimeout(perm.timer); this.pendingPermissions.delete(reqId); }
      const q = this.pendingQuestions.get(reqId);
      if (q) { clearTimeout(q.timer); this.pendingQuestions.delete(reqId); }
    }
    this.sessionPendingIds.delete(sessionId);
  }

  /**
   * Resolve all pending permissions for a session as a given behavior.
   * Returns the list of resolved permission requestIds (caller handles the actual response).
   */
  resolveAllAs(sessionId: string, _behavior: string): string[] {
    const ids = this.sessionPendingIds.get(sessionId);
    if (!ids) return [];
    const resolved: string[] = [];
    for (const reqId of ids) {
      const perm = this.pendingPermissions.get(reqId);
      if (perm) {
        clearTimeout(perm.timer);
        this.pendingPermissions.delete(reqId);
        resolved.push(reqId);
      }
      const q = this.pendingQuestions.get(reqId);
      if (q) { clearTimeout(q.timer); this.pendingQuestions.delete(reqId); }
    }
    this.sessionPendingIds.delete(sessionId);
    return resolved;
  }

  // === Internal ===

  private _trackPendingId(sessionId: string, requestId: string): void {
    let ids = this.sessionPendingIds.get(sessionId);
    if (!ids) { ids = new Set(); this.sessionPendingIds.set(sessionId, ids); }
    ids.add(requestId);
  }

  private _removePendingId(sessionId: string, requestId: string): void {
    const ids = this.sessionPendingIds.get(sessionId);
    if (ids) { ids.delete(requestId); if (ids.size === 0) this.sessionPendingIds.delete(sessionId); }
  }
}
