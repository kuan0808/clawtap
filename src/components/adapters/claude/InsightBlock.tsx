// src/components/adapters/claude/InsightBlock.tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';

export function InsightBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const summary = text.split('\n').find(l => l.trim())?.trim() || 'Insight';
  const truncated = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;

  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'w-full text-left px-3 py-2 transition-colors',
          'bg-surface/30 border border-border/50 hover:bg-surface/60',
          expanded ? 'rounded-t-md' : 'rounded-md',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-accent-light text-sm shrink-0">★</span>
          <span className="text-xs text-accent-light font-medium shrink-0">Insight</span>
          {!expanded && (
            <span className="text-xs text-text-dim truncate flex-1">{truncated}</span>
          )}
          {expanded
            ? <ChevronUp className="size-3.5 text-text-dim shrink-0 ml-auto" />
            : <ChevronDown className="size-3.5 text-text-dim shrink-0 ml-auto" />
          }
        </div>
      </button>
      {expanded && (
        <div className={cn(
          'bg-surface/20 border border-t-0 border-border/50 rounded-b-md px-3 py-2',
          'prose prose-invert prose-sm max-w-none',
          '[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5',
          '[&_code]:text-accent-light [&_code]:text-xs',
        )}>
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
