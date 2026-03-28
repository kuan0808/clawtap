import React, { useRef, useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ChatMessage, ToolStatus } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { ToolCallCard } from './ToolCallCard';
import { SubagentGroup } from './SubagentGroup';
import { ShimmerInput } from './ShimmerInput';

export type LiveStatus = { type: 'thinking'; text: string } | { type: 'streaming'; text: string };

export interface ChatBodyProps {
  messages: ChatMessage[];
  streaming: boolean;
  pendingResponse?: boolean;
  liveStatus: LiveStatus | null;
  toolStatuses: Map<string, ToolStatus>;
  onSend: (text: string) => void;
  onStop: () => void;
  interrupted: boolean;
  sendTargets?: { adapter: string; label: string }[];
  onSendTo?: (messageId: string, adapter?: string) => void;
  onSendBack?: (messageId: string) => void;
  className?: string;
  /** Optional extra content rendered after specific messages (e.g., review markers) */
  renderAfterMessage?: (messageId: string, index: number) => React.ReactNode;
  /** Optional extra content rendered before the input (e.g., queued messages) */
  renderBeforeInput?: () => React.ReactNode;
  /** Optional plan rendering — ChatView supplies PlanMode with respondPlan callbacks */
  renderPlanBlock?: (planInput: any, hasUserAfter: boolean, key: string | number) => React.ReactNode;
  /** Pre-filled text for the input (e.g., when editing a queued message) */
  initialInputText?: string;
  /** Content rendered between the scroll area and input (e.g., StatusBar) */
  renderAboveInput?: () => React.ReactNode;
  /** Custom placeholder text for the input */
  inputPlaceholder?: string;
  /** Hide the input area and show a read-only notice instead */
  hideInput?: boolean;
  /** External ref to the scroll container (for auto-hide header etc.) */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export function ChatBody({
  messages,
  streaming,
  pendingResponse = false,
  liveStatus,
  toolStatuses,
  onSend,
  onStop,
  interrupted,
  sendTargets,
  onSendTo,
  onSendBack,
  className,
  renderAfterMessage,
  renderBeforeInput,
  renderPlanBlock,
  initialInputText,
  renderAboveInput,
  inputPlaceholder,
  hideInput,
  scrollContainerRef,
}: ChatBodyProps) {
  const internalRef = useRef<HTMLDivElement>(null);
  const scrollRef = scrollContainerRef || internalRef;
  const [userScrolled, setUserScrolled] = useState(false);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [scrollRef]);

  // Auto-scroll when new content arrives
  useEffect(() => {
    if (!userScrolled) {
      scrollToBottom();
    }
  }, [messages, streaming, userScrolled, scrollToBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const scrolled = el.scrollHeight - el.scrollTop - el.clientHeight >= 100;
    setUserScrolled((prev) => prev !== scrolled ? scrolled : prev);
  }

  const lastUserIdx = useMemo(
    () => messages.reduce((acc, m, i) => m.role === 'user' ? i : acc, -1),
    [messages],
  );

  function renderContentBlocks(content: any[], isLastAssistant: boolean, hasPlanResponse: boolean) {
    const elements: React.JSX.Element[] = [];
    const toolBlocks = content.filter((b: any) => b.type === 'tool_use');
    // Build a set of tool IDs that have a tool_result in this message's content
    // — these tools have definitely completed and should show 'success' even during streaming
    const completedToolIds = content.some((b: any) => b.type === 'tool_result')
      ? new Set(content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id))
      : null;

    const planBlocks = toolBlocks.filter((b: any) => b.name === 'ExitPlanMode' && b.input?.plan);
    const regularTools = toolBlocks.filter(
      (b: any) => !['TodoWrite', 'TaskCreate', 'TaskUpdate', 'EnterPlanMode', 'ExitPlanMode'].includes(b.name),
    );

    const subagentGroups = new Map<string, any[]>();
    const topLevelTools: any[] = [];
    for (const tool of regularTools) {
      if (tool.parent_tool_use_id) {
        const group = subagentGroups.get(tool.parent_tool_use_id) || [];
        group.push(tool);
        subagentGroups.set(tool.parent_tool_use_id, group);
      } else {
        topLevelTools.push(tool);
      }
    }

    // Also gather sub-tools from toolStatuses (live streaming path —
    // progress entries arrive in later batches after the Agent message was already sent)
    for (const [id, status] of toolStatuses) {
      if (!status.parentToolUseId) continue;
      // Skip if already added from content blocks
      const existing = subagentGroups.get(status.parentToolUseId);
      if (existing?.some((t: any) => t.id === id)) continue;
      const group = existing || [];
      group.push({
        type: 'tool_use',
        id: status.toolUseId,
        name: status.toolName,
        input: status.input,
        parent_tool_use_id: status.parentToolUseId,
      });
      subagentGroups.set(status.parentToolUseId, group);
    }

    for (const tool of topLevelTools) {
      const status = toolStatuses.get(tool.id);
      const subTools = subagentGroups.get(tool.id);
      // A tool with a matching tool_result is definitively complete — don't show 'running'
      const hasResult = completedToolIds?.has(tool.id) ?? false;
      if ((tool.name === 'Agent' || tool.name === 'Task') && subTools) {
        elements.push(
          <SubagentGroup key={tool.id} agentTool={tool} subTools={subTools} toolStatuses={toolStatuses} />,
        );
      } else {
        const fallbackStatus = hasResult ? 'success'
          : isLastAssistant && streaming ? 'running'
          : isLastAssistant && interrupted ? 'interrupted'
          : 'success';
        elements.push(
          <ToolCallCard key={tool.id} toolName={tool.name} input={tool.input} status={status?.status || fallbackStatus} result={status?.result || tool._result} />,
        );
      }
    }

    for (const plan of planBlocks) {
      if (renderPlanBlock) {
        const node = renderPlanBlock(plan, hasPlanResponse, plan.id);
        if (node) elements.push(node as React.JSX.Element);
      }
    }

    return elements;
  }

  return (
    <div className={className ? `flex flex-col min-h-0 ${className}` : 'flex flex-col min-h-0 flex-1'}>
      {/* Scroll container */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !streaming && (
          <div className="text-text-dim text-sm text-center py-20 font-mono">Send a message to start</div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === 'interrupted') {
            return (
              <div key={i} className="flex justify-start mb-3 pl-1">
                <div className="flex items-center gap-1.5 text-xs text-text-dim">
                  <span className="text-text-dim/40">{'\u238F'}</span>
                  <span className="italic">Interrupted · What should Claude do instead?</span>
                </div>
              </div>
            );
          }
          if (msg.role === 'plan') {
            const planText = msg.content?.find((b: any) => b.type === 'text')?.text || '';
            if (renderPlanBlock) {
              return <Fragment key={i}>{renderPlanBlock({ plan: planText }, false, i)}</Fragment>;
            }
            return null;
          }
          // An assistant message is "last" if it's at the end, or if the only thing after it is an interrupt marker
          const isLastAssistant = msg.role === 'assistant' && (
            i === messages.length - 1 ||
            (i === messages.length - 2 && messages[messages.length - 1]?.role === 'interrupted')
          );
          const hasUserAfter = msg.role === 'assistant' && i < lastUserIdx;
          const toolElements = msg.role === 'assistant' ? renderContentBlocks(msg.content, isLastAssistant, hasUserAfter) : [];
          return (
            <Fragment key={msg.id || i}>
              <div>
                <MessageBubble
                  role={msg.role as 'user' | 'assistant'}
                  content={msg.content}
                  isStreaming={isLastAssistant && streaming}
                  messageId={msg.id}
                  showActions={msg.role === 'assistant' && !streaming && (!!onSendBack || (!!sendTargets && sendTargets.length > 0))}
                  sendTargets={sendTargets}
                  onSendTo={onSendTo}
                  onSendBack={onSendBack}
                />
                {toolElements}
              </div>
              {msg.id && renderAfterMessage?.(msg.id, i)}
            </Fragment>
          );
        })}

        {renderBeforeInput?.()}

        {streaming && pendingResponse && (
          <div className="flex justify-start mb-3">
            <div className="bg-surface border border-border rounded-xl rounded-bl-sm px-4 py-2.5 max-w-[85%]">
              <div className="flex items-center gap-2">
                <span className="typing-dot w-1.5 h-1.5 bg-accent rounded-full shrink-0" />
                <span className="text-xs text-text-dim italic font-mono">
                  {liveStatus?.type === 'thinking'
                    ? liveStatus.text
                    : liveStatus?.type === 'streaming'
                      ? 'Responding...'
                      : 'Working...'}
                </span>
              </div>
              {liveStatus?.type === 'streaming' && liveStatus.text && (
                <p className="text-xs text-text-dim/60 mt-1.5 line-clamp-3 break-words">
                  {liveStatus.text.substring(0, 200)}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Scroll-to-bottom button */}
      {userScrolled && (
        <button
          onClick={() => { setUserScrolled(false); scrollToBottom(); }}
          className="absolute bottom-20 right-4 w-8 h-8 rounded-full bg-surface border border-border flex items-center justify-center shadow-lg hover:bg-surface-light transition-colors z-10"
          aria-label="Scroll to bottom"
        >
          <ChevronDown className="w-4 h-4 text-text-secondary" />
        </button>
      )}

      {renderAboveInput?.()}

      {/* Input */}
      <div className="shrink-0 px-4 py-2 safe-bottom">
        {!hideInput ? (
          <ShimmerInput onSend={onSend} onStop={onStop} disabled={false} streaming={streaming} interrupted={interrupted} initialText={initialInputText} placeholder={inputPlaceholder} />
        ) : (
          <div className="px-4 py-3 text-center text-text-dim/40 text-xs italic">
            Review ended — read only
          </div>
        )}
      </div>
    </div>
  );
}
