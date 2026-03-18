import { LoadingAnimation } from './ui/LoadingAnimation';
import { Button } from './ui/button';
import { useState } from 'react';

interface Props {
  onRetry: () => void;
}

export function OfflineView({ onRetry }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard?.writeText('clawtap').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-6 gap-8">
      <LoadingAnimation size="lg" label="Connecting..." />

      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold text-text font-mono tracking-wider text-glow">ClawTap</h1>
        <p className="text-text-dim font-mono">Server not reachable</p>
      </div>

      <button
        onClick={handleCopy}
        className="w-full max-w-xs bg-surface rounded-md px-4 py-3 font-mono text-sm text-text hover:bg-surface/80 transition-colors text-left"
      >
        <span className="text-text-dim">$ </span>
        <span>clawtap</span>
        {copied && <span className="text-accent text-xs ml-2">Copied!</span>}
      </button>

      <p className="text-sm text-text-dim text-center max-w-xs">
        Run this command on your computer to start the ClawTap server.
      </p>

      <Button variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
