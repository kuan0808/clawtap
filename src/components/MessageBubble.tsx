import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { cn } from '@/lib/utils';
import { splitTextSegments } from '@/lib/text-transforms';
import { extractTextFromBlocks } from '@/lib/content-utils';
import { Copy, Check, Send, CornerDownLeft } from 'lucide-react';
import { CLAUDE_PATTERNS } from './adapters/claude/patterns';
import { InsightBlock } from './adapters/claude/InsightBlock';

// Hoisted to module scope to avoid recreating on every render (ReactMarkdown is expensive)
const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');
    if (match) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          customStyle={{ margin: 0, borderRadius: '0.5rem', fontSize: '0.8rem' }}
        >
          {code}
        </SyntaxHighlighter>
      );
    }
    return <code className={className} {...props}>{children}</code>;
  },
};

// --- SendDropdown component ---

/** Send-to button — always opens ReviewActionMenu (which handles adapter selection) */
function SendButton({
  messageId,
  onSendTo,
}: {
  messageId: string;
  onSendTo: (messageId: string, adapter?: string) => void;
}) {
  return (
    <button
      onClick={() => onSendTo(messageId)}
      className="flex items-center justify-center w-6 h-6 text-accent/40 hover:text-accent hover:bg-accent/10 rounded transition-colors"
      title="Send to..."
    >
      <Send className="w-3 h-3" />
    </button>
  );
}

// --- MessageBubble ---

export function MessageBubble({
  role,
  content,
  isStreaming = false,
  messageId,
  showActions = false,
  sendTargets,
  onSendTo,
  onSendBack,
}: {
  role: 'user' | 'assistant';
  content: any[];
  isStreaming?: boolean;
  messageId?: string;
  showActions?: boolean;
  sendTargets?: { adapter: string; label: string }[];
  onSendTo?: (messageId: string, adapter?: string) => void;
  onSendBack?: (messageId: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const textContent = content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  const segments = role === 'assistant' ? splitTextSegments(textContent, CLAUDE_PATTERNS) : null;

  if (!textContent && !isStreaming) return null;

  if (role === 'user') {
    return (
      <div className="flex justify-end mb-3">
        <div className="bg-user-bubble text-user-bubble-text rounded-xl rounded-br-sm px-4 py-2 max-w-[85%] break-words text-sm">
          {textContent}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[85%]">
        <div className="bg-surface border border-border rounded-xl rounded-bl-sm px-4 py-2 break-words overflow-hidden text-sm">
          <div className={cn(
            'prose prose-invert prose-sm max-w-none font-mono',
            '[&_pre]:bg-bg [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto',
            '[&_code]:text-accent-light',
            '[&_a]:text-accent-light',
            '[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5',
            '[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:mt-2 [&_h3]:mb-1',
          )}>
            {segments!.map((seg, i) =>
              seg.type === 'insight'
                ? <div key={i} className="not-prose"><InsightBlock text={seg.text} /></div>
                : <ReactMarkdown key={i} components={markdownComponents}>{seg.text}</ReactMarkdown>
            )}
          </div>
          {isStreaming && <span className="cursor-blink" />}
        </div>
        {showActions && !isStreaming && (
          <div className="flex gap-1.5 mt-1.5">
            <button
              onClick={() => { navigator.clipboard.writeText(extractTextFromBlocks(content)); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className={`flex items-center justify-center w-6 h-6 rounded transition-colors ${
                copied ? 'text-accent' : 'text-text-dim/40 hover:text-text-dim hover:bg-white/5'
              }`}
              title="Copy"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
            {messageId && onSendBack && (
              <button
                onClick={() => onSendBack(messageId)}
                className="flex items-center justify-center w-6 h-6 text-accent/40 hover:text-accent hover:bg-accent/10 rounded transition-colors"
                title="Send back"
              >
                <CornerDownLeft className="w-3 h-3" />
              </button>
            )}
            {messageId && !onSendBack && sendTargets && sendTargets.length > 0 && onSendTo && (
              <SendButton
                messageId={messageId}
                onSendTo={onSendTo}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
