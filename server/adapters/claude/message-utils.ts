/** A content block within a Claude message */
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

/** A sub-tool block extracted from agent_progress entries */
export interface SubToolBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  parent_tool_use_id: string;
}

/** Result of extractSubTools */
export interface SubToolsResult {
  parentId: string;
  subTools: SubToolBlock[];
}

// TODO: type properly — JSONL entries have various shapes
export interface JsonlEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    [key: string]: unknown;
  };
  content?: string | ContentBlock[];
  data?: {
    type?: string;
    message?: {
      message?: {
        role?: string;
        content?: ContentBlock[];
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  parentToolUseID?: string;
  cwd?: string;
  model?: string;
  version?: string;
  [key: string]: unknown;
}

const PLAN_PREFIX = /^Implement the following plan:\s*/i;

export const SYSTEM_PATTERNS: RegExp[] = [
  /^(Base directory for this skill:|Continue from where you left off)/i,
  /<(command-message|command-name|command-args|local-command|task-notification|system-reminder)/i,
];

export function extractText(content: string | ContentBlock[] | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: ContentBlock) => b.type === 'text')
      .map((b: ContentBlock) => b.text)
      .join('\n');
  }
  return '';
}

export function isSystemMessage(text: string, content: string | ContentBlock[] | unknown): boolean {
  if (!text.trim()) return true;
  if (Array.isArray(content) && content.every((b: ContentBlock) => b.type === 'tool_result')) return true;
  for (const pattern of SYSTEM_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Returns plan body text if this is a plan message, null otherwise. */
export function extractPlanContent(text: string): string | null {
  return PLAN_PREFIX.test(text) ? text.replace(PLAN_PREFIX, '') : null;
}

export function isNoResponseMessage(text: string): boolean {
  return /^No response requested/i.test(text.trim());
}

/** Extract sub-tool blocks from an agent_progress JSONL entry. */
export function extractSubTools(progressEntry: JsonlEntry): SubToolsResult | null {
  const parentId = progressEntry.parentToolUseID;
  const msg = progressEntry.data?.message?.message;
  if (!parentId || !msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return null;
  const subTools: SubToolBlock[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      subTools.push({ type: 'tool_use', id: block.id!, name: block.name!, input: block.input as Record<string, unknown>, parent_tool_use_id: parentId });
    }
  }
  return subTools.length > 0 ? { parentId, subTools } : null;
}
