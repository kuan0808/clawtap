export interface TextPattern {
  type: string;
  regex: RegExp;
}

export interface TextSegment {
  type: string;
  text: string;
}

export function splitTextSegments(text: string, patterns: TextPattern[]): TextSegment[] {
  if (!text || patterns.length === 0) return [{ type: 'markdown', text }];

  // Fast pre-check: skip regex if text has no backticks (insight delimiters use backticks)
  if (!text.includes('`')) return [{ type: 'markdown', text }];

  const matches: { type: string; start: number; end: number; captured: string }[] = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0; // Reset stateful /g flag instead of cloning
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      matches.push({
        type: pattern.type,
        start: m.index,
        end: m.index + m[0].length,
        captured: m[1] ?? m[0],
      });
    }
  }

  if (matches.length === 0) return [{ type: 'markdown', text }];

  matches.sort((a, b) => a.start - b.start);
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) {
      const before = text.slice(cursor, match.start).trim();
      if (before) segments.push({ type: 'markdown', text: before });
    }
    segments.push({ type: match.type, text: match.captured.trim() });
    cursor = match.end;
  }

  if (cursor < text.length) {
    const after = text.slice(cursor).trim();
    if (after) segments.push({ type: 'markdown', text: after });
  }

  return segments;
}
