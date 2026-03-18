import { useState, useEffect, useCallback, Fragment } from 'react';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { X, Folder, ChevronRight } from 'lucide-react';

interface DirEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

export function DirectoryBrowser({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError('');
    try {
      const dirs = await api.browse(path);
      setEntries(dirs);
      // Derive current path from first entry's parent, or use the explicit path
      if (path) {
        setCurrentPath(path);
      } else if (dirs.length > 0) {
        const first = dirs[0].path;
        setCurrentPath(first.substring(0, first.lastIndexOf('/')));
      }
    } catch (err: any) {
      setError(err.message || 'Failed to browse directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    browse();
  }, [browse]);

  const breadcrumbs = currentPath
    ? currentPath.split('/').filter(Boolean)
    : [];

  const navigateToBreadcrumb = (index: number) => {
    const path = '/' + breadcrumbs.slice(0, index + 1).join('/');
    browse(path);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg border border-border rounded-md w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text">Select Directory</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Breadcrumbs */}
        <div className="px-4 py-2 border-b border-border flex items-center gap-1 text-xs font-mono overflow-x-auto">
          <button
            onClick={() => browse()}
            className="text-accent hover:text-accent-light whitespace-nowrap"
          >
            ~
          </button>
          {breadcrumbs.map((part, i) => (
            <Fragment key={i}>
              <span className="text-text-dim">/</span>
              <button
                onClick={() => navigateToBreadcrumb(i)}
                className="text-accent hover:text-accent-light whitespace-nowrap"
              >
                {part}
              </button>
            </Fragment>
          ))}
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="text-text-dim text-center py-8 text-sm">Loading...</div>
          ) : error ? (
            <div className="text-danger text-center py-8 text-sm">{error}</div>
          ) : entries.length === 0 ? (
            <div className="text-text-dim text-center py-8 text-sm">No subdirectories</div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => browse(entry.path)}
                className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-surface transition-colors"
              >
                <Folder className="size-4 text-text-dim shrink-0" />
                <span className="text-text text-sm truncate flex-1">{entry.name}</span>
                {entry.hasChildren && (
                  <ChevronRight className="size-4 text-text-dim shrink-0" />
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-3">
          <span className="text-xs text-text-dim font-mono truncate flex-1">
            {currentPath || '~'}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={() => currentPath && onSelect(currentPath)}
              disabled={!currentPath}
            >
              Select
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
