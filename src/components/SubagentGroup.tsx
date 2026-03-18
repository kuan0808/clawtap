import { useState } from 'react';
import { ToolCallCard } from './ToolCallCard';
import { Badge } from './ui/badge';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import type { ToolStatus } from '../hooks/useChat';

export function SubagentGroup({ agentTool, subTools, toolStatuses }: {
  agentTool: any; subTools: any[]; toolStatuses: Map<string, ToolStatus>;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentStatus = toolStatuses.get(agentTool.id);
  const isRunning = agentStatus?.status === 'running';
  const completedCount = subTools.filter((t) => {
    const s = toolStatuses.get(t.id);
    return s?.status === 'success' || s?.status === 'error';
  }).length;
  const statusText = isRunning ? `${completedCount}/${subTools.length} tools` : `${subTools.length} tools completed`;

  return (
    <div className="border-l-2 border-border pl-3 mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="size-3.5 text-accent animate-spin" />
          ) : (
            <Badge variant="success">{completedCount}</Badge>
          )}
          <span className="font-mono text-xs text-text">{agentTool.name || 'Agent'}</span>
          <span className="text-xs text-text-dim flex-1">{statusText}</span>
          {expanded ? (
            <ChevronUp className="size-3.5 text-text-dim" />
          ) : (
            <ChevronDown className="size-3.5 text-text-dim" />
          )}
        </div>
        {agentTool.input?.description && (
          <div className="text-xs text-text-dim mt-1 ml-6">{agentTool.input.description}</div>
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {subTools.map((tool) => {
            const status = toolStatuses.get(tool.id);
            return (
              <div key={tool.id}>
                <ToolCallCard
                  toolName={tool.name}
                  input={tool.input}
                  status={status?.status || 'running'}
                  result={status?.result}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
