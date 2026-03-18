import { STORAGE } from './storage-keys';

const BASE = '';

function getToken(): string | null {
  return localStorage.getItem(STORAGE.TOKEN);
}

export function setToken(token: string) {
  localStorage.setItem(STORAGE.TOKEN, token);
}

export function clearToken() {
  localStorage.removeItem(STORAGE.TOKEN);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  const refreshed = res.headers.get('X-Refreshed-Token');
  if (refreshed) {
    setToken(refreshed);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  login: (password: string) =>
    request<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  sessions: (dir?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (dir) params.set('dir', dir);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return request<any[]>(`/api/sessions${qs ? `?${qs}` : ''}`);
  },

  sessionMessages: (id: string, dir?: string) => {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    return request<{ messages: any[]; lastModified: string | null }>(`/api/sessions/${id}/messages${qs}`);
  },

  uploadImage: async (file: File): Promise<{ path: string; filename: string }> => {
    const token = getToken();
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },

  browse: (path?: string) => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    return request<{ name: string; path: string; hasChildren: boolean }[]>(
      `/api/browse${qs}`
    );
  },

  adapters: () =>
    request<{ id: string; displayName: string; available: boolean }[]>('/api/adapters'),

  adapterConfig: (name: string) =>
    request<{
      models: { value: string; label: string; contextWindow: number }[];
      permissionModes: { value: string; label: string }[];
      effortLevels: { value: string; label: string }[];
      effortLabel: string;
      capabilities?: {
        supportsPermissionModes: boolean;
        permissionModeType?: 'cycle' | 'toggle';
      };
    }>(`/api/adapter/${name}/config`),

  activeSessions: () =>
    request<any[]>('/api/active-sessions'),

  destroySession: (sessionId: string, adapter?: string) => {
    const qs = adapter ? `?adapter=${adapter}` : '';
    return request<{ ok: boolean }>(`/api/active-sessions/${sessionId}${qs}`, { method: 'DELETE' });
  },

  vapidPublicKey: () =>
    request<{ publicKey: string }>('/api/push/vapid-public-key'),

  pushSubscribe: (subscription: PushSubscriptionJSON) =>
    request<{ ok: boolean }>('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription }),
    }),

  pushUnsubscribe: (endpoint: string) =>
    request<{ ok: boolean }>('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),

  pushPending: () =>
    request<Record<string, number>>('/api/push/pending'),

  registerReview: (parentCliSessionId: string, childSessionId: string, targetAdapter: string, anchorMessageId: string, prompt: string, title: string) =>
    request<{ reviewId: string }>('/api/reviews/register', {
      method: 'POST',
      body: JSON.stringify({ parentCliSessionId, childSessionId, targetAdapter, anchorMessageId, prompt, title }),
    }),

  endReview: (reviewId: string, endAnchorMessageId?: string) =>
    request<{ ok: boolean }>(`/api/reviews/${reviewId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endAnchorMessageId }),
    }),

  sendBackToParent: (reviewId: string, message: string) =>
    request<{ ok: boolean }>(`/api/reviews/${reviewId}/send-back`, { method: 'POST', body: JSON.stringify({ message }) }),

  getReviews: (parentCliSessionId: string) =>
    request<any[]>(`/api/reviews?parentCliSessionId=${encodeURIComponent(parentCliSessionId)}`),

  getInstructions: () =>
    request<{ id: string; label: string; instruction: string; created_at: string }[]>('/api/instructions'),

  createInstruction: (label: string, instruction: string) =>
    request<{ id: string; label: string; instruction: string }>('/api/instructions', {
      method: 'POST',
      body: JSON.stringify({ label, instruction }),
    }),

  deleteInstruction: (id: string) =>
    request<void>(`/api/instructions/${id}`, { method: 'DELETE' }),
};
