import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { X, Send } from 'lucide-react';

export function PlanMode({ input, onApprove, onApproveYolo, onReject, onSendFeedback }: {
  input: any; onApprove: () => void; onApproveYolo?: () => void; onReject: (feedback: string) => void; onSendFeedback?: (feedback: string) => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const [feedback, setFeedback] = useState('');
  const planText = input?.plan || input?.content || input?.text || '';
  const truncated = planText.length > 500 ? planText.slice(0, 500) + '...' : planText;

  const feedbackInput = (
    <div className="flex gap-2 items-center">
      <input
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Feedback..."
        className="flex-1 bg-bg border border-border rounded-md px-3 py-2 text-text text-sm focus:outline-none focus:border-accent"
      />
      {onSendFeedback && (
        <Button
          variant="ghost"
          size="icon"
          disabled={!feedback.trim()}
          onClick={() => { onSendFeedback(feedback); setFeedback(''); }}
          className="shrink-0"
        >
          <Send className="size-4" />
        </Button>
      )}
    </div>
  );

  const controls = (
    <div className="flex flex-col gap-2 mt-3">
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => onReject(feedback || 'Rejected')} className="flex-1 text-danger">
          Reject
        </Button>
        <Button variant="default" onClick={onApprove} className="flex-1">
          Approve
        </Button>
      </div>
      {onApproveYolo && (
        <Button variant="outline" onClick={onApproveYolo} className="w-full text-xs">
          Approve (YOLO)
        </Button>
      )}
    </div>
  );

  if (showFull) {
    return (
      <div className="fixed inset-0 bg-bg z-50 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 safe-top">
          <Badge className="font-mono">PLAN</Badge>
          <Button variant="ghost" size="icon" onClick={() => setShowFull(false)}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{planText}</ReactMarkdown>
          </div>
        </div>
        <div className="shrink-0 px-4 py-3 border-t border-border safe-bottom">
          {feedbackInput}
          {controls}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="border-l-4 border-accent bg-surface rounded-md p-4">
        <div className="flex items-center justify-between mb-3">
          <Badge className="font-mono">PLAN</Badge>
          <button onClick={() => setShowFull(true)} className="text-xs text-accent-light hover:underline">
            Expand
          </button>
        </div>
        <div className="prose prose-invert prose-sm max-w-none mb-2 max-h-48 overflow-hidden">
          <ReactMarkdown>{truncated}</ReactMarkdown>
        </div>
        {feedbackInput}
        {controls}
      </div>
    </div>
  );
}
