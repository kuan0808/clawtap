import { useState, useMemo } from 'react';
import { Loader2, Check, X, Ban, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { parseAskQuestionInput } from '@/lib/ask-question-utils';
import { DiffViewer } from './DiffViewer';

const STATUS_CONFIG: Record<string, { icon: React.ReactNode }> = {
  running: { icon: <Loader2 className="size-4 animate-spin text-text-dim" /> },
  success: { icon: <Check className="size-4 text-success" /> },
  error: { icon: <X className="size-4 text-danger" /> },
  interrupted: { icon: <Ban className="size-4 text-text-dim" /> },
};

function matchesAskOption(answer: string | null, o: { label: string; value?: string }): boolean {
  return !!answer && (o.label === answer || o.value === answer || answer.includes(o.label));
}

function toolSummary(toolName: string, input: any, result?: any): string {
  if (toolName === 'AskUserQuestion') {
    const { question, options } = parseAskQuestionInput(input);
    const rawAnswer = getResultText(result);
    const matchedOpt = options?.find(o => matchesAskOption(rawAnswer, o));
    const answer = matchedOpt?.label || (rawAnswer && rawAnswer.length > 60 ? null : rawAnswer);
    const q = question.length > 40 ? question.slice(0, 40) + '...' : question;
    return answer ? `${q} → ${answer.length > 30 ? answer.slice(0, 30) + '...' : answer}` : q;
  }
  if (toolName === 'Bash' && input?.command) {
    return input.command.length > 60 ? input.command.slice(0, 60) + '...' : input.command;
  }
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && input?.file_path) {
    return input.file_path;
  }
  if (toolName === 'Glob' && input?.pattern) return input.pattern;
  if (toolName === 'Grep' && input?.pattern) return input.pattern;
  if ((toolName === 'Agent' || toolName === 'Task') && input?.description) return input.description;
  if (toolName === 'WebFetch' && input?.url) return input.url;
  if (toolName === 'WebSearch' && input?.query) return input.query;

  // Fallback: return first non-empty string value from input (notchi pattern)
  if (input && typeof input === 'object') {
    for (const value of Object.values(input)) {
      if (typeof value === 'string' && value.trim()) {
        return value.length > 80 ? value.slice(0, 80) + '...' : value;
      }
    }
  }
  return '';
}

function hasDiff(toolName: string, input: any): boolean {
  return toolName === 'Edit' && input?.old_string != null && input?.new_string != null;
}

function hasNewFile(toolName: string): boolean {
  return toolName === 'Write';
}

function getResultText(result: any): string | null {
  if (!result) return null;
  if (typeof result.content === 'string') return result.content;
  if (typeof result === 'string') return result;
  if (result.content) return JSON.stringify(result.content, null, 2);
  return null;
}

export function ToolCallCard({ toolName, input, status, result }: {
  toolName: string; input: any; status: 'running' | 'success' | 'error' | 'interrupted'; result?: any;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const { icon } = STATUS_CONFIG[status];
  const summary = toolSummary(toolName, input, result);
  const isDiff = hasDiff(toolName, input);
  const isNewFile = hasNewFile(toolName);
  const askData = useMemo(
    () => toolName === 'AskUserQuestion' ? parseAskQuestionInput(input) : null,
    [toolName, input],
  );

  return (
    <>
      <div className="mb-2 border-l-2 border-accent/30">
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'w-full text-left hover:bg-surface/50 px-3 py-2 transition-colors',
            expanded ? 'rounded-t-md' : 'rounded-md',
          )}
        >
          <div className="flex items-center gap-2">
            {icon}
            <Badge variant="mono">{toolName}</Badge>
            {summary && <span className="text-xs text-text-dim truncate flex-1">{summary}</span>}
            {expanded
              ? <ChevronUp className="size-3.5 text-text-dim shrink-0" />
              : <ChevronDown className="size-3.5 text-text-dim shrink-0" />
            }
          </div>
          {!expanded && isDiff && (
            <div className="mt-1.5 font-mono text-xs leading-relaxed overflow-hidden max-h-20">
              {input.old_string?.split('\n').slice(0, 2).map((line: string, i: number) => (
                <div key={`d-${i}`} className="text-danger/70 truncate">- {line}</div>
              ))}
              {input.new_string?.split('\n').slice(0, 2).map((line: string, i: number) => (
                <div key={`a-${i}`} className="text-success/70 truncate">+ {line}</div>
              ))}
            </div>
          )}
        </button>
        {expanded && (
          <div className="bg-surface/30 rounded-b-md px-3 py-2 text-xs font-mono overflow-x-auto">
            {isDiff ? (
              <>
                <div className="space-y-0.5 max-h-48 overflow-y-auto">
                  {input.old_string?.split('\n').map((line: string, i: number) => (
                    <div key={`d-${i}`} className="text-danger">- {line}</div>
                  ))}
                  {input.new_string?.split('\n').map((line: string, i: number) => (
                    <div key={`a-${i}`} className="text-success">+ {line}</div>
                  ))}
                </div>
                <button onClick={() => setShowFullDiff(true)} className="text-accent-light text-xs mt-2 hover:underline">View full diff</button>
              </>
            ) : isNewFile ? (
              <div className="max-h-48 overflow-y-auto">
                <div className="text-text-dim mb-1">{input.file_path}</div>
                <pre className="text-text whitespace-pre-wrap">{input.content?.slice(0, 500)}</pre>
                {input.content?.length > 500 && <div className="text-text-dim mt-1">...{input.content.split('\n').length} lines</div>}
              </div>
            ) : (() => {
              const resultStr = getResultText(result);
              if (toolName === 'Read' && input?.file_path) return (
                <div className="max-h-48 overflow-y-auto">
                  <div className="text-text-dim mb-1 truncate">{input.file_path}</div>
                  {resultStr && <pre className="text-text whitespace-pre-wrap text-[11px] leading-relaxed">{resultStr.slice(0, 2000)}</pre>}
                </div>
              );
              if (toolName === 'Bash') return (
                <div className="max-h-48 overflow-y-auto">
                  {input?.description && <div className="text-text-dim mb-1">{input.description}</div>}
                  <pre className="text-accent-light whitespace-pre-wrap mb-2">$ {input?.command}</pre>
                  {resultStr && (
                    <>
                      <div className="text-text-dim mb-1">Output:</div>
                      <pre className="text-text whitespace-pre-wrap text-[11px]">{resultStr.slice(0, 2000)}</pre>
                    </>
                  )}
                </div>
              );
              if ((toolName === 'Grep' || toolName === 'Glob') && input?.pattern) return (
                <div className="max-h-48 overflow-y-auto">
                  <div className="text-text-dim mb-1">
                    Pattern: <span className="text-accent-light">{input.pattern}</span>
                    {input.path && <span className="ml-2">in {input.path}</span>}
                  </div>
                  {resultStr && <pre className="text-text whitespace-pre-wrap text-[11px]">{resultStr.slice(0, 2000)}</pre>}
                </div>
              );
              if ((toolName === 'Agent' || toolName === 'Task') && input?.description) return (
                <div className="max-h-48 overflow-y-auto">
                  <div className="text-text mb-1 font-medium">{input.description}</div>
                  {input.prompt && (
                    <pre className="text-text-dim whitespace-pre-wrap text-[11px] mt-1">{input.prompt.slice(0, 500)}{input.prompt.length > 500 ? '...' : ''}</pre>
                  )}
                  {resultStr && (
                    <>
                      <div className="text-text-dim mb-1 mt-2">Result:</div>
                      <pre className="text-text whitespace-pre-wrap text-[11px]">{resultStr.slice(0, 1000)}</pre>
                    </>
                  )}
                </div>
              );
              if (askData) {
                const { question, options } = askData;
                const answer = resultStr;
                const isOptionAnswer = options?.some(o => matchesAskOption(answer, o));
                return (
                  <div className="max-h-48 overflow-y-auto font-sans">
                    <div className="flex items-start gap-1.5 mb-1">
                      <span className="text-purple-400">{'\u2753'}</span>
                      <span className="text-text font-semibold text-[13px]">{question}</span>
                    </div>
                    {options && (
                      <div className="flex flex-col gap-1 mt-2 ml-5">
                        {options.map((o, i) => {
                          const selected = matchesAskOption(answer, o) || (!!answer && String(i) === answer);
                          return (
                            <div key={i} className={cn('flex items-center gap-1.5', selected ? 'opacity-100' : 'opacity-40')}>
                              <span className={cn('text-[10px]', selected ? 'text-green-500' : 'text-zinc-500')}>{selected ? '\u25CF' : '\u25CB'}</span>
                              <span className={cn('text-[12px]', selected ? 'text-green-500' : 'text-zinc-500')}>{o.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {answer && !isOptionAnswer && (
                      <div className="mt-2 ml-5 border-l-2 border-green-500 pl-2.5">
                        <span className="text-[12px] text-green-500">{'\u300C'}{answer}{'\u300D'}</span>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <>
                  <div className="text-text-dim mb-1">Input:</div>
                  <pre className="text-text whitespace-pre-wrap mb-2 max-h-32 overflow-y-auto">{JSON.stringify(input, null, 2)}</pre>
                  {resultStr && (
                    <>
                      <div className="text-text-dim mb-1">Output:</div>
                      <pre className="text-text whitespace-pre-wrap max-h-32 overflow-y-auto">{resultStr.slice(0, 1000)}</pre>
                    </>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
      {showFullDiff && isDiff && (
        <DiffViewer filePath={input.file_path} oldString={input.old_string} newString={input.new_string} onClose={() => setShowFullDiff(false)} />
      )}
    </>
  );
}
