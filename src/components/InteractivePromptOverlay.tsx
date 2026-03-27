import { useState, useEffect, useRef, useCallback } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { BottomSheet } from './BottomSheet';
import { Send } from 'lucide-react';

export interface InteractivePromptData {
  requestId: string;
  promptType: string; // 'permission' | 'question' | 'plan' | 'loop-detected'
  title: string;
  description: string;
  toolName?: string;
  toolInput?: any;
  options?: { value: string; label: string }[];
  textInput?: { placeholder?: string };
}

interface Props {
  prompt: InteractivePromptData;
  onRespond: (requestId: string, selectedOption?: string, textValue?: string) => void;
}

const BADGE_COLORS: Record<string, string> = {
  permission: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  question: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  plan: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  'loop-detected': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
};

function formatToolInput(toolName: string, input: any): string {
  if (!input) return '';
  if (toolName === 'Bash' && input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.path) return input.path;
  if (input.command) return input.command;
  const str = JSON.stringify(input, null, 2);
  return str.length > 300 ? str.slice(0, 300) + '...' : str;
}

export function InteractivePromptOverlay({ prompt, onRespond }: Props) {
  const [textValue, setTextValue] = useState('');
  const [countdown, setCountdown] = useState(120);
  const onRespondRef = useRef(onRespond);
  onRespondRef.current = onRespond;
  const requestIdRef = useRef(prompt.requestId);
  requestIdRef.current = prompt.requestId;

  // 120s countdown for permission type
  useEffect(() => {
    if (prompt.promptType !== 'permission') return;
    setCountdown(120);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          onRespondRef.current(requestIdRef.current, 'deny');
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [prompt.requestId, prompt.promptType]);

  // Reset text when prompt changes
  useEffect(() => {
    setTextValue('');
  }, [prompt.requestId]);

  const handleOptionClick = useCallback((value: string) => {
    onRespond(prompt.requestId, value);
  }, [onRespond, prompt.requestId]);

  const handleTextSubmit = useCallback(() => {
    if (!textValue.trim()) return;
    onRespond(prompt.requestId, undefined, textValue.trim());
  }, [onRespond, prompt.requestId, textValue]);

  const badgeClass = BADGE_COLORS[prompt.promptType] || BADGE_COLORS.question;

  return (
    <BottomSheet
      visible
      onClose={() => onRespond(prompt.requestId, 'deny')}
      zIndex="z-40"
      backdropClassName="backdrop-blur-sm"
      className="p-5"
      showHandle={false}
    >
      {/* Title bar */}
      <div className="flex items-center justify-between mb-4">
        <span className={`text-xs font-medium px-2 py-0.5 rounded border ${badgeClass}`}>
          {prompt.title || prompt.promptType}
        </span>
        {prompt.promptType === 'permission' && (
          <span className="text-xs text-text-dim font-mono">{countdown}s</span>
        )}
      </div>

      {/* Description */}
      {prompt.description && (
        <p className="text-sm text-text mb-3 whitespace-pre-wrap">{prompt.description}</p>
      )}

      {/* Tool info card */}
      {prompt.toolName && (
        <div className="bg-bg rounded-md p-3 mb-4 max-h-40 overflow-y-auto">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="mono">{prompt.toolName}</Badge>
          </div>
          {prompt.toolInput && (
            <pre className="font-mono text-xs text-text whitespace-pre-wrap break-all">
              {formatToolInput(prompt.toolName, prompt.toolInput)}
            </pre>
          )}
        </div>
      )}

      {/* Options — vertical button list */}
      {prompt.options && prompt.options.length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
          {prompt.options.map((opt, i) => (
            <Button
              key={i}
              variant={i === 0 ? 'default' : i === prompt.options!.length - 1 ? 'ghost' : 'secondary'}
              onClick={() => handleOptionClick(opt.value)}
              className="w-full"
            >
              {opt.label}
            </Button>
          ))}
        </div>
      )}

      {/* Text input */}
      {prompt.textInput && (
        <div className="flex gap-2">
          <textarea
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleTextSubmit();
              }
            }}
            placeholder={prompt.textInput.placeholder || 'Type your response...'}
            className="flex-1 bg-bg border border-border rounded-md px-3 py-2 text-text text-sm focus:outline-none focus:border-accent resize-none min-h-[60px]"
            autoFocus={!prompt.options}
            rows={2}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={handleTextSubmit}
            disabled={!textValue.trim()}
            className="self-end"
          >
            <Send className="size-4" />
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
