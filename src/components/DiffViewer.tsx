import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function DiffViewer({ filePath, oldString, newString, onClose }: {
  filePath: string; oldString: string; newString: string; onClose: () => void;
}) {
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  return (
    <div className="fixed inset-0 bg-bg z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3 overflow-hidden">
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
          <span className="font-mono text-xs text-text truncate">{filePath}</span>
        </div>
        <div className="flex gap-2 text-xs shrink-0">
          <span className="text-danger">-{oldLines.length}</span>
          <span className="text-success">+{newLines.length}</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 font-mono text-xs">
        <div className="min-w-0">
          {oldLines.map((line, i) => (
            <div key={`d-${i}`} className="flex bg-danger/10 whitespace-pre">
              <span className="text-text-dim w-8 shrink-0 text-right pr-2 select-none">{i + 1}</span>
              <span className="text-danger">- {line}</span>
            </div>
          ))}
          <div className="my-2 border-t border-border" />
          {newLines.map((line, i) => (
            <div key={`a-${i}`} className="flex bg-success/10 whitespace-pre">
              <span className="text-text-dim w-8 shrink-0 text-right pr-2 select-none">{i + 1}</span>
              <span className="text-success">+ {line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
