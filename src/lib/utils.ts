import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function timeAgo(timestamp: number | string): string {
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diff = Date.now() - time;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function dirName(path: string): string {
  return path.split('/').pop() || path;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// Source of truth: server/adapters/claude/index.js
// These are duplicated here for UI convenience. Keep in sync with the server constants.
export const MODELS = [
  { value: 'sonnet', label: 'Sonnet', contextWindow: 200000 },
  { value: 'opus', label: 'Opus', contextWindow: 200000 },
  { value: 'haiku', label: 'Haiku', contextWindow: 200000 },
  { value: 'opus[1m]', label: 'Opus 1M', contextWindow: 1000000 },
  { value: 'sonnet[1m]', label: 'Sonnet 1M', contextWindow: 1000000 },
] as const;

// Source of truth: server/adapters/claude/index.js — keep in sync.
export const PERMISSION_MODES = [
  { value: 'default', label: 'Normal' },
  { value: 'acceptEdits', label: 'Auto-edit' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'YOLO' },
] as const;
