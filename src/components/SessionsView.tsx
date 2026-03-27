import { useState, useEffect, useRef } from 'react';
import { useSessions } from '../hooks/useSessions';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { DirectoryBrowser } from './DirectoryBrowser';
import { BottomSheet } from './BottomSheet';
import { AdapterTabs } from './AdapterTabs';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { LoadingAnimation } from './ui/LoadingAnimation';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Bell, BellOff, ArrowRightLeft, ClipboardList, MoreVertical } from 'lucide-react';
import { timeAgo, dirName, PERMISSION_MODES } from '@/lib/utils';
import { api } from '@/lib/api';
import { getBrand, ADAPTER_BRANDS } from '@/lib/adapter-brands';

export function SessionsView({
  onOpenChat,
  onLogout,
  onOpenSettings,
  installPrompt,
  onInstall,
  onDismissInstall,
}: {
  onOpenChat: (sessionId?: string, cwd?: string, adapter?: string) => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  installPrompt?: unknown;
  onInstall?: () => void;
  onDismissInstall?: () => void;
}) {
  const {
    sessions,
    projects,
    selectedProjectDir,
    selectProject,
    sessionCounts,
    loading,
    refresh,
    activeTab,
    setActiveTab,
    activeSessions,
    activeSessionIds,
    refreshActive,
  } = useSessions();
  const { supported: pushSupported, subscribed, subscribe, unsubscribe } = usePushNotifications();
  const [showBrowser, setShowBrowser] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [adapterFilter, setAdapterFilter] = useState('all');
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    adapter: string;
    isActive: boolean;
  } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLongPressStart = (session: any, isActive: boolean) => {
    longPressTimer.current = setTimeout(() => {
      setContextMenu({
        sessionId: session.sessionId,
        adapter: session.adapter || 'claude',
        isActive,
      });
    }, 500);
  };

  const handleLongPressEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  // Fetch pending notification counts — initial fetch + debounced real-time via SW postMessage
  useEffect(() => {
    if (!subscribed) { setPending({}); return; }
    api.pushPending().then(setPending).catch(() => {});
    let debounceTimer: ReturnType<typeof setTimeout>;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'PUSH_RECEIVED') {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          api.pushPending().then(setPending).catch(() => {});
        }, 300);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => {
      clearTimeout(debounceTimer);
      navigator.serviceWorker?.removeEventListener('message', handler);
    };
  }, [subscribed]);

  const handleBrowseSelect = (path: string) => {
    setShowBrowser(false);
    onOpenChat(undefined, path);
  };

  const handleNewChat = () => onOpenChat(undefined, selectedProjectDir || undefined);

  const contextMenuSheet = contextMenu && (() => {
    const otherAdapterId = Object.keys(ADAPTER_BRANDS).find(id => id !== contextMenu.adapter) || 'claude';
    const otherBrand = getBrand(otherAdapterId);
    return (
      <BottomSheet visible onClose={() => setContextMenu(null)} zIndex="z-40" backdropClassName="bg-black/60" className="p-4 pb-8">
          <div className="space-y-2">
            {contextMenu.isActive && (
              <button
                className="w-full flex items-center gap-3 p-3 rounded-md hover:bg-white/5 transition-colors"
                onClick={() => { /* TODO: cross-adapter hand-off */ setContextMenu(null); }}
              >
                <ArrowRightLeft className="w-5 h-5 text-text-dim" />
                <div className="text-left">
                  <div className="text-sm font-medium">Hand off to {otherBrand.displayName}</div>
                  <div className="text-xs text-text-dim">Continue with {otherBrand.displayName}</div>
                </div>
              </button>
            )}
            <button
              className="w-full flex items-center gap-3 p-3 rounded-md hover:bg-white/5 transition-colors"
              onClick={() => { /* TODO: use as reference */ setContextMenu(null); }}
            >
              <ClipboardList className="w-5 h-5 text-text-dim" />
              <div className="text-left">
                <div className="text-sm font-medium">Use as reference in {otherBrand.displayName}</div>
                <div className="text-xs text-text-dim">Start new chat with context</div>
              </div>
            </button>
          </div>
      </BottomSheet>
    );
  })();

  // --- Sessions list (drill-down into a project) ---
  if (selectedProjectDir) {
    return (
      <div className="min-h-screen bg-bg flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => selectProject(null)}
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <span className="text-sm font-medium text-text truncate">
              {dirName(selectedProjectDir)}
            </span>
          </div>
          <Button onClick={handleNewChat} size="sm">
            New Chat
          </Button>
        </div>

        <AdapterTabs active={adapterFilter} onChange={setAdapterFilter} />

        <div className="flex-1 overflow-y-auto">
          {(() => {
            const filteredSessions = adapterFilter === 'all'
              ? sessions
              : sessions.filter((s: any) => s.adapter === adapterFilter);
            return loading && sessions.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <LoadingAnimation size="md" label="Loading sessions..." />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-text-dim text-sm">No sessions yet.</p>
                {adapterFilter === 'all' && (
                  <Button variant="link" onClick={handleNewChat} className="mt-2">
                    Start a new chat
                  </Button>
                )}
              </div>
            ) : (
              <div>
                {filteredSessions.map((session: any) => {
                  const brand = getBrand(session.adapter);
                  const isActive = activeSessionIds.has(session.sessionId);
                  return (
                    <button
                      key={session.sessionId}
                      onClick={() => onOpenChat(session.sessionId, session.cwd, session.adapter)}
                      onTouchStart={() => handleLongPressStart(session, isActive)}
                      onTouchEnd={handleLongPressEnd}
                      onMouseDown={() => handleLongPressStart(session, isActive)}
                      onMouseUp={handleLongPressEnd}
                      onMouseLeave={handleLongPressEnd}
                      className="w-full text-left px-4 py-3 border-b border-border hover:bg-surface transition-colors"
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-sm text-text truncate flex-1 mr-3 flex items-center gap-1.5">
                          {isActive && (
                            <span className="inline-block w-2 h-2 rounded-full bg-success shrink-0" />
                          )}
                          <span
                            style={{ color: brand.color, backgroundColor: brand.colorBg }}
                            className="text-[10px] font-semibold px-1.5 rounded shrink-0"
                          >
                            {brand.displayName}
                          </span>
                          {session.firstPrompt || 'Untitled session'}
                        </span>
                        <span className="text-xs text-text-dim whitespace-nowrap shrink-0 font-mono">
                          {session.lastModified ? timeAgo(session.lastModified) : ''}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-text-dim truncate">
                        {session.sessionId}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })()}

          <div className="px-4 py-3">
            <Button variant="ghost" onClick={refresh} className="w-full gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </Button>
          </div>
        </div>
        {contextMenuSheet}
      </div>
    );
  }

  // --- Projects list (default view) ---
  return (
    <div className="min-h-screen bg-bg flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="flex items-center gap-1.5 text-lg font-medium text-text font-mono tracking-wider">
          <svg width="20" height="15" viewBox="0 0 8 6" style={{ imageRendering: 'pixelated' }} className="text-accent">
            <rect x="4" y="0" width="4" height="1" fill="currentColor"/>
            <rect x="3" y="1" width="2" height="1" fill="currentColor"/>
            <rect x="0" y="2" width="4" height="2" fill="currentColor"/>
            <rect x="4" y="2" width="1" height="2" fill="currentColor" opacity="0.5"/>
            <rect x="3" y="4" width="2" height="1" fill="currentColor"/>
            <rect x="4" y="5" width="4" height="1" fill="currentColor"/>
          </svg>
          ClawTap
        </span>
        <div className="flex items-center gap-1.5">
          <Button onClick={() => setShowBrowser(true)} size="sm">
            <Plus className="w-4 h-4 mr-1" />
            New Project
          </Button>
          <div className="relative">
            <button
              onClick={() => setShowHeaderMenu(prev => !prev)}
              className="p-2 rounded-md hover:bg-surface transition-colors"
            >
              <MoreVertical className="w-4 h-4 text-text-dim" />
            </button>
            {showHeaderMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowHeaderMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded-lg py-1 min-w-[180px] shadow-lg">
                  {pushSupported && (
                    <button
                      onClick={() => { (subscribed ? unsubscribe() : subscribe()).catch(() => {}); setShowHeaderMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-text-dim hover:text-text hover:bg-white/5 transition-colors"
                    >
                      {subscribed ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
                      {subscribed ? 'Disable notifications' : 'Enable notifications'}
                    </button>
                  )}
                  <button
                    onClick={() => { onOpenSettings(); setShowHeaderMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-text-dim hover:text-text hover:bg-white/5 transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
                    </svg>
                    Settings
                  </button>
                  <div className="border-t border-border my-1" />
                  <button
                    onClick={() => { onLogout(); setShowHeaderMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-danger hover:bg-white/5 transition-colors"
                  >
                    Logout
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {!!installPrompt && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-accent/10 border-b border-accent/20">
          <span className="text-xs text-text flex-1 font-mono">Install ClawTap for a better experience</span>
          <button onClick={onInstall} className="text-xs font-medium text-accent hover:text-accent-light cursor-pointer">Install</button>
          <button onClick={onDismissInstall} className="text-xs text-text-dim hover:text-text cursor-pointer">Dismiss</button>
        </div>
      )}

      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('projects')}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors font-mono tracking-wide ${
            activeTab === 'projects' ? 'text-accent border-b-2 border-accent' : 'text-text-dim'
          }`}
        >
          Projects
        </button>
        <button
          onClick={() => setActiveTab('active')}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors font-mono tracking-wide ${
            activeTab === 'active' ? 'text-accent border-b-2 border-accent' : 'text-text-dim'
          }`}
        >
          Active ({activeSessions.length})
        </button>
      </div>

      {activeTab === 'active' ? (
        <div className="flex-1 overflow-y-auto">
          {activeSessions.length === 0 ? (
            <div className="text-text-dim text-sm text-center py-12">No active sessions</div>
          ) : (
            <div>
              {activeSessions.map((session: any) => {
                const isExpanded = expandedId === session.sessionId;
                return (
                  <div key={session.sessionId} className="border-b border-border">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : session.sessionId)}
                      onTouchStart={() => handleLongPressStart(session, true)}
                      onTouchEnd={handleLongPressEnd}
                      onMouseDown={() => handleLongPressStart(session, true)}
                      onMouseUp={handleLongPressEnd}
                      onMouseLeave={handleLongPressEnd}
                      className="w-full text-left px-4 py-3 hover:bg-surface transition-colors"
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-sm text-text truncate flex-1 mr-3">
                          <span className="inline-block w-2 h-2 rounded-full bg-success mr-1.5 shrink-0" />
                          {session.adapter && (
                            <span
                              className="text-[10px] font-semibold px-1.5 rounded shrink-0 mr-1"
                              style={{ color: getBrand(session.adapter).color, backgroundColor: `${getBrand(session.adapter).color}20` }}
                            >
                              {getBrand(session.adapter).displayName}
                            </span>
                          )}
                          {session.firstPrompt || session.sessionId}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          {pending[session.sessionId] > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-danger text-white text-xs font-medium">
                              {pending[session.sessionId]}
                            </span>
                          )}
                          <span className="text-xs text-text-dim whitespace-nowrap font-mono">
                            {session.lastActivity ? timeAgo(session.lastActivity) : ''}
                          </span>
                        </div>
                      </div>
                      <div className="text-[10px] text-text-dim truncate flex items-center gap-1.5">
                        <span>{dirName(session.cwd || '')}</span>
                        <span>·</span>
                        <span>{PERMISSION_MODES.find(m => m.value === session.permissionMode)?.label ?? session.permissionMode}</span>
                        {(session.hasDesktop || session.hasClients) && (
                          <>
                            <span>·</span>
                            <span>{[session.hasDesktop && 'desktop', session.clientCount > 0 && `${session.clientCount} connected`].filter(Boolean).join(' · ')}</span>
                          </>
                        )}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="px-4 pb-3 flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => onOpenChat(session.sessionId, session.cwd, session.adapter)}
                        >
                          Connect
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-400 hover:text-red-300"
                          onClick={async () => {
                            try {
                              await api.destroySession(session.sessionId, session.adapter);
                              setExpandedId(null);
                              refreshActive();
                            } catch (e) {
                              console.error('Failed to disconnect:', e);
                            }
                          }}
                        >
                          Disconnect
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="px-4 py-3">
            <Button variant="ghost" onClick={refreshActive} className="w-full gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {loading && projects.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <LoadingAnimation size="md" label="Loading projects..." />
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-text-dim text-sm">No projects yet.</p>
              <Button variant="link" onClick={() => setShowBrowser(true)} className="mt-2">
                Browse for a directory to start
              </Button>
            </div>
          ) : (
            <div>
              {projects.map((project) => (
                <button
                  key={project}
                  onClick={() => selectProject(project)}
                  className="w-full text-left px-4 py-3 border-b border-border hover:bg-surface transition-colors flex items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-text truncate font-mono">{dirName(project)}</div>
                    <div className="text-xs text-text-dim truncate mt-0.5 font-mono">{project}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <Badge variant="secondary">
                      {sessionCounts[project] || 0}
                    </Badge>
                    <ChevronRight className="w-4 h-4 text-text-dim" />
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="px-4 py-3">
            <Button variant="ghost" onClick={refresh} className="w-full gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </Button>
          </div>
        </div>
      )}

      {showBrowser && (
        <DirectoryBrowser
          onSelect={handleBrowseSelect}
          onClose={() => setShowBrowser(false)}
        />
      )}

      {contextMenuSheet}
    </div>
  );
}
