import { useState, useEffect, useRef } from 'react';
import type { PermissionRequest } from '../hooks/useChat';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { BottomSheet } from './BottomSheet';

function formatInput(toolName: string, input: any): string {
  if (toolName === 'Bash' && input?.command) return input.command;
  if (input?.file_path) return input.file_path;
  if (input?.pattern) return input.pattern;
  if (input?.path) return input.path;
  if (input?.command) return input.command;
  return JSON.stringify(input, null, 2).slice(0, 300);
}

export function PermissionOverlay({ request, onAllow, onAllowAll, onDeny }: {
  request: PermissionRequest; onAllow: () => void; onAllowAll: () => void; onDeny: (message?: string) => void;
}) {
  const [countdown, setCountdown] = useState(120);
  const onDenyRef = useRef(onDeny);
  onDenyRef.current = onDeny;

  useEffect(() => {
    setCountdown(120);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { onDenyRef.current('Permission timed out'); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [request.requestId]);

  return (
    <BottomSheet
      visible
      onClose={() => onDeny('Dismissed')}
      zIndex="z-40"
      backdropClassName="backdrop-blur-sm"
      className="p-5"
      showHandle={false}
    >
      <div className="flex items-center justify-between mb-4">
        <Badge variant="mono">{request.toolName}</Badge>
        <span className="text-xs text-text-dim font-mono">{countdown}s</span>
      </div>
      {request.decisionReason && (
        <p className="text-text-dim text-sm mb-3">{request.decisionReason}</p>
      )}
      <div className="bg-bg rounded-md p-3 mb-4 max-h-40 overflow-y-auto">
        <pre className="font-mono text-xs text-text whitespace-pre-wrap break-all">
          {formatInput(request.toolName, request.input)}
        </pre>
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="default" onClick={onAllow} className="w-full">
          Allow
        </Button>
        <Button variant="secondary" onClick={onAllowAll} className="w-full">
          Allow all for this session
        </Button>
        <Button variant="ghost" onClick={() => onDeny()} className="w-full">
          Deny
        </Button>
      </div>
    </BottomSheet>
  );
}
