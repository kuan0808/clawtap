import { useState, useCallback, useEffect, useRef } from 'react';
import { STORAGE } from './lib/storage-keys';
import { isAuthenticated, clearToken } from './lib/api';
import { LoginView } from './components/LoginView';
import { SessionsView } from './components/SessionsView';
import { ChatView } from './components/ChatView';
import { SettingsView } from './components/SettingsView';
import { NewChatView } from './components/NewChatView';
import { OfflineView } from './components/OfflineView';
import { LoadingAnimation } from './components/ui/LoadingAnimation';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type View =
  | { name: 'sessions' }
  | { name: 'newchat'; cwd: string }
  | { name: 'chat'; sessionId?: string; cwd?: string; initialPrompt?: string; adapter?: string }
  | { name: 'settings' };

function loadView(): View {
  try {
    const saved = sessionStorage.getItem('currentView');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.name === 'chat' && parsed.sessionId) return parsed;
      if (parsed.name === 'newchat' && parsed.cwd) return parsed;
    }
  } catch {}
  return { name: 'sessions' };
}

function persistView(view: View) {
  sessionStorage.setItem('currentView', JSON.stringify(view));
}

function navigateTo(view: View) {
  persistView(view);
  let url = '/';
  if (view.name === 'chat' && view.sessionId) {
    url = `/?view=chat&session=${view.sessionId}`;
    if (view.adapter) url += `&adapter=${view.adapter}`;
  } else if (view.name === 'settings') {
    url = '/?view=settings';
  }
  window.history.pushState({ view }, '', url);
}

export function App() {
  const [authed, setAuthed] = useState(isAuthenticated());
  const [view, setView] = useState<View>(loadView);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [deviceOnline, setDeviceOnline] = useState(navigator.onLine);
  const consecutiveFails = useRef(0);
  const initialized = useRef(false);

  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(
    () => localStorage.getItem(STORAGE.INSTALL_DISMISSED) === 'true'
  );
  const dismissInstall = useCallback(() => {
    setInstallPrompt(null);
    setInstallDismissed(true);
    localStorage.setItem(STORAGE.INSTALL_DISMISSED, 'true');
  }, []);

  const [swUpdateAvailable, setSwUpdateAvailable] = useState(false);

  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const result = await installPrompt.userChoice;
    if (result.outcome === 'accepted') dismissInstall();
  }, [installPrompt, dismissInstall]);

  const handleLogin = useCallback(() => setAuthed(true), []);

  const handleLogout = useCallback(() => {
    clearToken();
    sessionStorage.removeItem('currentView');
    setAuthed(false);
  }, []);

  const openChat = useCallback((sessionId?: string, cwd?: string, adapter?: string) => {
    if (!sessionId && cwd) {
      const v: View = { name: 'newchat', cwd };
      navigateTo(v);
      setView(v);
    } else {
      const v: View = { name: 'chat', sessionId, cwd, adapter };
      navigateTo(v);
      setView(v);
    }
  }, []);

  // PWA: Android install prompt
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', dismissInstall);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', dismissInstall);
    };
  }, [dismissInstall]);

  // PWA: Service worker update notification
  useEffect(() => {
    const handleControllerChange = () => setSwUpdateAvailable(true);
    navigator.serviceWorker?.addEventListener('controllerchange', handleControllerChange);
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', handleControllerChange);
  }, []);

  // PWA: Clear app badge on focus
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        navigator.clearAppBadge?.();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (event.state?.view) {
        setView(event.state.view);
        persistView(event.state.view);
      } else {
        setView({ name: 'sessions' });
        persistView({ name: 'sessions' });
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Set initial history state (replaceState, not pushState, to avoid double entry)
  useEffect(() => {
    window.history.replaceState({ view }, '', window.location.pathname + window.location.search);
  }, []);

  const backToSessions = useCallback(() => {
    const v: View = { name: 'sessions' };
    navigateTo(v);
    setView(v);
  }, []);

  // Layer 1: Device network (instant)
  useEffect(() => {
    const goOnline = () => setDeviceOnline(true);
    const goOffline = () => setDeviceOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Layer 2: Server health check
  const checkHealth = useCallback(() => {
    fetch('/health', { signal: AbortSignal.timeout(5000) })
      .then(res => {
        if (res.ok) {
          consecutiveFails.current = 0;
          setServerOnline(true);
        } else {
          consecutiveFails.current++;
          if (!initialized.current || consecutiveFails.current >= 2) setServerOnline(false);
        }
      })
      .catch(() => {
        consecutiveFails.current++;
        if (!initialized.current || consecutiveFails.current >= 2) setServerOnline(false);
      });
  }, []);

  useEffect(() => {
    checkHealth();
    initialized.current = true;
    const interval = setInterval(checkHealth, 15000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  // Handle OPEN_SESSION messages from service worker (push notification clicks)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'OPEN_SESSION' && event.data.sessionId) {
        openChat(event.data.sessionId);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  }, [openChat]);

  // Handle URL parameters (?session= from notification click, ?action=newchat from PWA shortcut)
  const urlParamsHandled = useRef(false);
  useEffect(() => {
    if (urlParamsHandled.current || !authed) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    const action = params.get('action');
    if (sessionId) {
      urlParamsHandled.current = true;
      const adapter = params.get('adapter');
      openChat(sessionId, undefined, adapter || undefined);
      window.history.replaceState({}, '', '/');
    } else if (action === 'newchat') {
      urlParamsHandled.current = true;
      window.history.replaceState({}, '', '/');
    }
  }, [authed, openChat]);

  const startChat = useCallback((options: { adapter: string; model: string; permissionMode: string; effort: string; prompt: string }) => {
    // NewChatView.handleSend already saved adapter prefs via saveAdapterPrefs — just set the active adapter
    localStorage.setItem(STORAGE.ADAPTER, options.adapter);
    // Navigate to chat view with cwd — ChatView will pick up globals and send the prompt
    const chatCwd = view.name === 'newchat' ? view.cwd : undefined;
    const v: View = { name: 'chat', cwd: chatCwd, initialPrompt: options.prompt, adapter: options.adapter };
    navigateTo(v);
    setView(v);
  }, [view]);

  const isOffline = !deviceOnline || serverOnline === false;

  // Splash screen while first health check is pending
  if (serverOnline === null) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <LoadingAnimation size="lg" label="Connecting..." />
      </div>
    );
  }

  // Offline screen
  if (isOffline) {
    return <OfflineView onRetry={checkHealth} />;
  }

  if (!authed) {
    return <LoginView onLogin={handleLogin} />;
  }

  if (view.name === 'newchat') {
    return (
      <NewChatView
        cwd={view.cwd}
        onStartChat={startChat}
        onBack={backToSessions}
      />
    );
  }

  if (view.name === 'settings') {
    return <SettingsView onBack={() => setView({ name: 'sessions' })} />;
  }

  if (view.name === 'chat') {
    return (
      <ChatView
        sessionId={view.sessionId}
        cwd={view.cwd}
        initialPrompt={view.initialPrompt}
        adapter={view.adapter}
        onBack={backToSessions}
      />
    );
  }

  return (
    <>
      <SessionsView
        onOpenChat={openChat}
        onLogout={handleLogout}
        onOpenSettings={() => setView({ name: 'settings' })}
        installPrompt={!installDismissed ? installPrompt : null}
        onInstall={handleInstall}
        onDismissInstall={dismissInstall}
      />
      {swUpdateAvailable && (
        <div className="fixed bottom-6 left-4 right-4 bg-surface border border-accent/30 rounded-md px-4 py-3 flex items-center justify-between z-50 shadow-lg">
          <span className="text-sm text-text font-mono">New version available</span>
          <div className="flex gap-2">
            <button onClick={() => window.location.reload()} className="text-sm font-medium text-accent hover:text-accent-light cursor-pointer">Refresh</button>
            <button onClick={() => setSwUpdateAvailable(false)} className="text-sm text-text-dim hover:text-text cursor-pointer">Later</button>
          </div>
        </div>
      )}
    </>
  );
}
