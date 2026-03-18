import { useState } from 'react';
import { Button } from './ui/button';
import { Send } from 'lucide-react';

export function AskQuestion({ toolUseId, input, onRespond }: {
  toolUseId: string; input: any; onRespond: (toolUseId: string, response: string) => void;
}) {
  const [customText, setCustomText] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [answered, setAnswered] = useState(false);
  // SDK AskUserQuestion uses questions[0].question/options structure
  const firstQ = input?.questions?.[0];
  const question = firstQ?.question || input?.question || input?.text || 'Choose an option';
  const options: Array<{ value: string; label: string; description?: string }> = firstQ?.options || input?.options || input?.choices || [];

  function select(value: string) { if (answered) return; setAnswered(true); onRespond(toolUseId, value); }
  function submitCustom() { if (!customText.trim() || answered) return; setAnswered(true); onRespond(toolUseId, customText.trim()); }

  if (answered) return (
    <div className="mb-3">
      <p className="text-text-dim text-sm italic">Question answered</p>
    </div>
  );

  return (
    <div className="mb-3">
      <p className="text-sm font-medium font-mono text-text mb-3">{question}</p>
      <div className="space-y-2">
        {options.map((opt, i) => (
          <Button
            key={i}
            variant="outline"
            onClick={() => select(opt.value || opt.label)}
            className="w-full justify-start text-left h-auto py-3 px-4"
          >
            <div>
              <div className="text-sm font-medium">{opt.label || opt.value}</div>
              {opt.description && <div className="text-text-dim text-xs mt-0.5">{opt.description}</div>}
            </div>
          </Button>
        ))}
        {!showCustom ? (
          <Button variant="ghost" onClick={() => setShowCustom(true)} className="w-full text-sm">
            Other...
          </Button>
        ) : (
          <div className="flex gap-2">
            <input
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCustom()}
              placeholder="Type your answer..."
              className="flex-1 bg-bg border border-border rounded-md px-3 py-2 text-text text-sm focus:outline-none focus:border-accent"
              autoFocus
            />
            <Button variant="ghost" size="icon" onClick={submitCustom} disabled={!customText.trim()}>
              <Send className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
