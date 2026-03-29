import React, { useState, useRef, useEffect, useCallback, useMemo, Fragment, type RefObject } from 'react';
import { useChat } from '../hooks/useChat';
import { PLAN_OPTION } from '../lib/ws-types';
import { InteractivePromptOverlay } from './InteractivePromptOverlay';
import { StatusBar } from './StatusBar';
import { PlanMode } from './PlanMode';
import { ChatBody } from './ChatBody';
import { FloatingReviewPanel, type ReviewPanelHandle } from './FloatingReviewPanel';
import { ReviewActionMenu } from './ReviewActionMenu';
import { SendToExistingSheet } from './SendToExistingSheet';
import { CollapsedReviewCard } from './CollapsedReviewCard';
import { BlockMarker } from './BlockMarker';
import { TaskFab } from './TaskFab';
import { TaskBottomSheet } from './TaskBottomSheet';
import { api } from '../lib/api';
import { getBrand } from '../lib/adapter-brands';
import { extractTextFromBlocks } from '../lib/content-utils';
import { patchAdapterPrefs } from '../lib/adapter-prefs';
import { LoadingAnimation } from './ui/LoadingAnimation';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ChevronLeft, Copy, Check, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';


function PlanViewer({ plan }: { plan: string }) {
  const [expanded, setExpanded] = useState(false);

  if (expanded) {
    return (
      <div className="fixed inset-0 bg-bg z-50 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 safe-top">
          <Badge>PLAN</Badge>
          <Button variant="ghost" size="icon" onClick={() => setExpanded(false)}>
            <X className="w-5 h-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 prose prose-invert prose-sm max-w-none">
          <ReactMarkdown>{plan}</ReactMarkdown>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-2 px-3 py-2 bg-surface border border-border rounded-md hover:bg-surface-light transition-colors cursor-pointer w-full"
      >
        <Badge>PLAN</Badge>
        <span className="text-xs text-text-secondary truncate flex-1 text-left">
          {plan.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 60) || 'View plan'}
        </span>
        <span className="text-xs text-accent-light">View</span>
      </button>
    </div>
  );
}

function ChatHeader({ sessionId, cwd }: { sessionId?: string; cwd?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!sessionId) return;
    navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [sessionId]);

  const projectName = cwd ? cwd.split('/').filter(Boolean).pop() : null;
  const truncatedId = sessionId && sessionId.length > 16
    ? sessionId.slice(0, 16) + '...'
    : sessionId;

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-text font-medium font-mono">
          {projectName || (sessionId ? 'Session' : 'New Chat')}
        </span>
        {sessionId && (
          <button
            onClick={handleCopy}
            className="text-[10px] text-text-dim font-mono truncate hover:text-text-secondary transition-colors flex items-center gap-1 cursor-pointer"
          >
            {truncatedId}
            {copied ? (
              <Check className="w-2.5 h-2.5 text-success shrink-0" />
            ) : (
              <Copy className="w-2.5 h-2.5 shrink-0" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}


/** Auto-hide header during scroll, show when scroll stops or at bottom. */
function useAutoHideHeader(scrollRef: RefObject<HTMLDivElement | null>) {
  const [hidden, setHidden] = useState(false);
  const lastScrollTop = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function onScroll() {
      const st = el!.scrollTop;
      const delta = st - lastScrollTop.current;
      lastScrollTop.current = st;

      // Don't hide when at the bottom (viewing latest messages)
      const atBottom = el!.scrollHeight - st - el!.clientHeight < 50;
      if (atBottom) {
        if (stopTimer.current) clearTimeout(stopTimer.current);
        setHidden(false);
        return;
      }

      if (Math.abs(delta) > 8) setHidden(true);

      // Show header after scroll stops
      if (stopTimer.current) clearTimeout(stopTimer.current);
      stopTimer.current = setTimeout(() => setHidden(false), 1000);
    }

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (stopTimer.current) clearTimeout(stopTimer.current);
    };
  }, [scrollRef]);

  return hidden;
}

export function ChatView({
  sessionId: initialSessionId,
  cwd,
  initialPrompt,
  adapter,
  onBack,
}: {
  sessionId?: string;
  cwd?: string;
  initialPrompt?: string;
  adapter?: string;
  onBack: () => void;
}) {
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const reviewPanelRef = useRef<ReviewPanelHandle>(null);
  const reviewRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerHidden = useAutoHideHeader(chatScrollRef);

  const {
    messages, toolStatuses, streaming, pendingResponse, wsStatus, sessionId, liveStatus,
    interrupted, sessionStatus, adapterConfig, selectedAdapter, interactivePrompt, model, permissionMode,
    queuedMessage, clearQueuedMessage,
    activeReviews, setActiveReviews, activeReviewPanel, setActiveReviewPanel,
    historyReview, setHistoryReview,
    taskSnapshot,
    sendMessage, respondPrompt, respondPlan, abort,
    updateModel, updatePermissionMode,
  } = useChat(initialSessionId, cwd, adapter, initialPrompt);

  const [taskSheetOpen, setTaskSheetOpen] = useState(false);
  const [availableAdapters, setAvailableAdapters] = useState<string[]>([]);
  useEffect(() => {
    api.adapters()
      .then(adapters => setAvailableAdapters(adapters.map(a => a.id)))
      .catch(console.error);
  }, []);

  const [editText, setEditText] = useState('');

  const handleEditQueued = useCallback(() => {
    if (queuedMessage) {
      setEditText(queuedMessage);
      clearQueuedMessage();
    }
  }, [queuedMessage, clearQueuedMessage]);

  const sendTargets = useMemo(() => {
    return availableAdapters
      .filter(a => a !== selectedAdapter)
      .map(a => ({ adapter: a, label: getBrand(a).displayName }));
  }, [availableAdapters, selectedAdapter]);

  const sendTargetMenuEntries = useMemo(() => {
    return sendTargets.map(t => ({ id: t.adapter, displayName: t.label }));
  }, [sendTargets]);

  const [reviewMenuMessageId, setReviewMenuMessageId] = useState<string | null>(null);
  const [sendToMessageId, setSendToMessageId] = useState<string | null>(null);

  interface ReviewRecord {
    id: string;
    child_adapter: string;
    anchor_message_id: string | null;
    review_title: string | null;
    ended_at: string | null;
    end_anchor_message_id: string | null;
  }
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);

  // Shared cleanup for ending/closing an active review
  const closeReview = useCallback(async (reviewId?: string) => {
    const targetId = reviewId || activeReviews[0]?.reviewId;
    if (!targetId) return;
    setActiveReviews(prev => prev.filter(r => r.reviewId !== targetId));
    setHistoryReview(null);
    const lastMsg = messages[messages.length - 1];
    const endAnchorMessageId = lastMsg?.id || undefined;
    try { await api.endReview(targetId, endAnchorMessageId); } catch {}
  }, [activeReviews, messages]);

  // Close history panel only (does not affect active review)
  const closeHistoryPanel = useCallback(() => {
    setHistoryReview(null);
  }, []);

  // Fetch review history for this session
  useEffect(() => {
    if (!sessionId) return;
    api.getReviews(sessionId).then(setReviews).catch(() => {});
  }, [sessionId]);

  // Keep reviews in sync with WS events
  const prevActiveReviewsRef = useRef(activeReviews);
  useEffect(() => {
    const prevIds = new Set(prevActiveReviewsRef.current.map(r => r.reviewId));
    const currIds = new Set(activeReviews.map(r => r.reviewId));

    // New reviews added — batch into a single setReviews call
    const newReviews = activeReviews.filter(r => !prevIds.has(r.reviewId));
    if (newReviews.length > 0) {
      console.log(`[reviewSync] ${newReviews.length} new review(s):`, newReviews.map(r => `${r.reviewId.slice(0,8)} anchor=${r.anchorMessageId}`));
      setReviews(prev => {
        const existingIds = new Set(prev.map(r => r.id));
        const toAdd = newReviews
          .filter(r => !existingIds.has(r.reviewId))
          .map(r => ({
            id: r.reviewId,
            child_adapter: r.childAdapter,
            anchor_message_id: r.anchorMessageId ?? null,
            review_title: r.reviewTitle ?? null,
            ended_at: null,
            end_anchor_message_id: null,
          }));
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
    }

    // Reviews removed — debounced re-fetch to get ended_at + end_anchor_message_id
    const hasRemoved = [...prevIds].some(id => !currIds.has(id));
    if (hasRemoved && sessionId) {
      if (reviewRefetchTimer.current) clearTimeout(reviewRefetchTimer.current);
      reviewRefetchTimer.current = setTimeout(() => {
        api.getReviews(sessionId).then(setReviews).catch(() => {});
      }, 500);
    }

    prevActiveReviewsRef.current = activeReviews;
  }, [activeReviews, sessionId]);

  const { startMarkersByAnchor, endMarkersByAnchor } = useMemo(() => {
    const startMap = new Map<string, ReviewRecord[]>();
    const endMap = new Map<string, ReviewRecord[]>();
    for (const r of reviews) {
      if (r.anchor_message_id) {
        const existing = startMap.get(r.anchor_message_id) || [];
        existing.push(r);
        startMap.set(r.anchor_message_id, existing);
      }
      if (r.ended_at) {
        const endKey = r.end_anchor_message_id || r.anchor_message_id;
        if (endKey) {
          const existing = endMap.get(endKey) || [];
          existing.push(r);
          endMap.set(endKey, existing);
        }
      }
    }
    return { startMarkersByAnchor: startMap, endMarkersByAnchor: endMap };
  }, [reviews]);

  const handleSendTo = useCallback((messageId: string, _adapter?: string) => {
    if (activeReviews.length > 0) {
      setSendToMessageId(messageId);
    } else {
      setReviewMenuMessageId(messageId);
    }
  }, [activeReviews]);

  const handleSendToExisting = useCallback((reviewId: string) => {
    if (!sendToMessageId) return;
    const msg = messages.find(m => m.id === sendToMessageId);
    if (!msg) return;
    const text = extractTextFromBlocks(msg.content);
    reviewPanelRef.current?.sendToReview(reviewId, text);
    setSendToMessageId(null);
    setActiveReviewPanel('expanded');
  }, [sendToMessageId, messages]);

  const handleStartNewFromSheet = useCallback(() => {
    if (sendToMessageId) {
      setReviewMenuMessageId(sendToMessageId);
      setSendToMessageId(null);
    }
  }, [sendToMessageId]);

  const [saveToast, setSaveToast] = useState<{ instruction: string; label: string } | null>(null);

  const openReview = useCallback((adapter: string, model: string, prompt: string, title: string) => {
    const anchorId = reviewMenuMessageId;
    setReviewMenuMessageId(null);
    if (!anchorId) return;
    const reviewId = crypto.randomUUID();
    console.log(`[openReview] creating review=${reviewId.slice(0,8)} adapter=${adapter} anchor=${anchorId} prompt=${prompt?.substring(0, 30)}`);
    patchAdapterPrefs(adapter, { model });
    setHistoryReview(null);
    setActiveReviews(prev => {
      console.log(`[openReview] activeReviews before: ${prev.length} entries, ids: ${prev.map(r => r.reviewId.slice(0,8)).join(',')}`);
      return [...prev, {
        reviewId,
        childSessionId: '',
        childCliSessionId: '',
        childAdapter: adapter,
        anchorMessageId: anchorId,
        reviewTitle: title,
        prompt,
        permissionMode: adapter === 'gemini' ? 'yolo' : 'bypassPermissions',
      }];
    });
    setActiveReviewPanel('expanded');
  }, [reviewMenuMessageId]);

  const handleDirectSend = useCallback((adapter: string, model: string) => {
    const anchorMsg = messages.find(m => m.id === reviewMenuMessageId);
    const rawText = anchorMsg ? extractTextFromBlocks(anchorMsg.content) : '';
    openReview(adapter, model, rawText, 'direct');
  }, [reviewMenuMessageId, messages, openReview]);

  const handleSendWithInstruction = useCallback((adapter: string, model: string, instruction: string, isCustom: boolean) => {
    const anchorMsg = messages.find(m => m.id === reviewMenuMessageId);
    const rawText = anchorMsg ? extractTextFromBlocks(anchorMsg.content) : '';
    openReview(adapter, model, `${instruction}\n\n${rawText}`, instruction.substring(0, 30));
    if (isCustom) {
      setSaveToast({ instruction, label: instruction.substring(0, 30) });
      setTimeout(() => setSaveToast(null), 3000);
    }
  }, [reviewMenuMessageId, messages, openReview]);

  const handleOpenReadOnlyReview = useCallback((review: ReviewRecord) => {
    setHistoryReview(review);
    if (activeReviews.length > 0) setActiveReviewPanel('minimized');
  }, [activeReviews]);

  const renderReviewMarkers = useCallback((messageId: string, _index: number): React.ReactNode => {
    const startReviews = startMarkersByAnchor.get(messageId);
    const endReviews = endMarkersByAnchor.get(messageId);
    if (!startReviews && !endReviews) return null;

    return (
      <>
        {startReviews?.map((review) => (
          <Fragment key={`start-${review.id}`}>
            <BlockMarker
              label={`${getBrand(review.child_adapter).displayName} ${review.review_title || 'Review'} started`}
              color={getBrand(review.child_adapter).color}
            />
            {review.ended_at ? (
              <CollapsedReviewCard
                adapter={review.child_adapter}
                title={review.review_title ?? undefined}
                summary="Tap to view review conversation"
                onClick={() => handleOpenReadOnlyReview(review)}
              />
            ) : (
              <BlockMarker
                label={`${getBrand(review.child_adapter).displayName} Review in progress...`}
                color={getBrand(review.child_adapter).color}
              />
            )}
          </Fragment>
        ))}
        {endReviews?.map((review) => (
          <BlockMarker
            key={`end-${review.id}`}
            label="Review ended"
            color={getBrand(review.child_adapter).color}
          />
        ))}
      </>
    );
  }, [startMarkersByAnchor, endMarkersByAnchor, handleOpenReadOnlyReview]);

  const renderPlanBlock = useCallback((planInput: any, hasUserAfter: boolean, key: string | number): React.ReactNode => {
    if (!hasUserAfter) {
      return (
        <PlanMode
          key={key}
          input={planInput.input ?? planInput}
          onApprove={() => respondPlan(PLAN_OPTION.MANUALLY_APPROVE)}
          onApproveYolo={() => respondPlan(PLAN_OPTION.BYPASS)}
          onReject={(feedback: string) => respondPlan(PLAN_OPTION.TEXT_FEEDBACK, feedback || 'Rejected')}
          onSendFeedback={(feedback: string) => respondPlan(PLAN_OPTION.TEXT_FEEDBACK, feedback)}
        />
      );
    }
    const planText = planInput.input?.plan || planInput.plan || '';
    return <PlanViewer key={key} plan={planText} />;
  }, [respondPlan]);

  const renderBeforeInput = useCallback((): React.ReactNode => {
    if (!queuedMessage) return null;
    return (
      <div className="flex justify-end mb-3">
        <div className="bg-user-bubble text-user-bubble-text/70 rounded-xl rounded-br-md px-3 py-2 max-w-[85%] text-sm">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded">Queued</span>
          </div>
          <div className="italic">{queuedMessage}</div>
          <div className="flex gap-2 mt-2">
            <button onClick={handleEditQueued} className="text-xs text-white/60 hover:text-white">Edit</button>
            <button onClick={clearQueuedMessage} className="text-xs text-white/60 hover:text-white">Cancel</button>
          </div>
        </div>
      </div>
    );
  }, [queuedMessage, handleEditQueued, clearQueuedMessage]);

  const renderAboveInput = useCallback((): React.ReactNode => (
    <>
      {activeReviews.length > 0 && (activeReviewPanel === 'minimized' || historyReview) && (
        <div
          className="flex items-center gap-1.5 px-4 py-2 border-t border-border cursor-pointer hover:bg-white/5 transition-colors"
          onClick={() => { setHistoryReview(null); setActiveReviewPanel('expanded'); }}
        >
          {activeReviews.map(r => (
            <span key={r.reviewId} className="w-1.5 h-1.5 rounded-full" style={{ background: getBrand(r.childAdapter).color }} />
          ))}
          <span className="text-xs text-text-dim flex-1 ml-1 font-mono">
            {activeReviews.length} review{activeReviews.length > 1 ? 's' : ''}: {activeReviews.map(r => getBrand(r.childAdapter).displayName).join(' \u00B7 ')}
          </span>
          <span className="text-xs text-text-dim/50">{'\u25B2'} Expand</span>
        </div>
      )}
      <StatusBar
        model={model}
        permissionMode={permissionMode}
        sessionStatus={sessionStatus}
        adapterConfig={adapterConfig}
        selectedAdapter={selectedAdapter!}
        streaming={streaming}
        onModelChange={updateModel}
        onPermissionModeChange={updatePermissionMode}
      />
    </>
  ), [activeReviews, activeReviewPanel, historyReview, model, permissionMode, sessionStatus, adapterConfig, selectedAdapter, streaming, updateModel, updatePermissionMode]);

  const isHistoryPanel = !!historyReview;

  const activeReviewsRef = useRef(activeReviews);
  activeReviewsRef.current = activeReviews;

  const onSessionCreatedCallback = useCallback(async (reviewId: string, childSid: string) => {
    console.log(`[onSessionCreated] reviewId=${reviewId.slice(0,8)} childSid=${childSid.slice(0,8)} parentSid=${sessionId?.slice(0,8)}`);
    if (!sessionId) return;
    const review = activeReviewsRef.current.find(r => r.reviewId === reviewId);
    if (!review) { console.log(`[onSessionCreated] review not found in activeReviews`); return; }
    try {
      console.log(`[onSessionCreated] calling api.registerReview...`);
      await api.registerReview({
        reviewId,
        parentCliSessionId: sessionId,
        childSessionId: childSid,
        targetAdapter: review.childAdapter,
        anchorMessageId: review.anchorMessageId || '',
        prompt: review.prompt || '',
        title: review.reviewTitle || '',
      });
    } catch (err) {
      console.error('Failed to register review:', err);
    }
  }, [sessionId]);

  if (!selectedAdapter) {
    return (
      <div className="flex flex-col h-dvh bg-bg items-center justify-center">
        <LoadingAnimation size="md" label="Connecting..." />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-dvh bg-bg relative overflow-hidden safe-top"
    >
      {/* Header — overlays content, slides up when scrolling */}
      <div className={`absolute top-0 left-0 right-0 flex items-center gap-2 px-4 py-3 border-b border-border bg-bg z-10 safe-top transition-transform duration-200 ${headerHidden ? '-translate-y-full' : 'translate-y-0'}`}>
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <ChatHeader sessionId={sessionId || initialSessionId} cwd={cwd} />
        {wsStatus === 'reconnecting' && (
          <span className="text-warning text-xs ml-auto shrink-0">Reconnecting...</span>
        )}
      </div>

      {/* Chat body — messages, tools, input */}
      <ChatBody
        messages={messages}
        streaming={streaming}
        pendingResponse={pendingResponse}
        liveStatus={liveStatus}
        toolStatuses={toolStatuses}
        onSend={sendMessage}
        onStop={abort}
        interrupted={interrupted}
        sendTargets={sendTargets}
        onSendTo={handleSendTo}
        renderAfterMessage={renderReviewMarkers}
        renderBeforeInput={renderBeforeInput}
        renderPlanBlock={renderPlanBlock}
        initialInputText={editText}
        renderAboveInput={renderAboveInput}
        scrollContainerRef={chatScrollRef}
        className="flex-1"
      />

      {/* Floating review panel — CSS-hidden when minimized to keep hooks alive */}
      {activeReviews.length > 0 && (
        <div style={{ display: activeReviewPanel === 'expanded' ? 'contents' : 'none' }}>
          <FloatingReviewPanel
            ref={reviewPanelRef}
            reviews={activeReviews.map(r => ({
              reviewId: r.reviewId,
              childSessionId: r.childSessionId,
              childAdapter: r.childAdapter,
              reviewTitle: r.reviewTitle,
              prompt: r.prompt,
              permissionMode: r.permissionMode,
            }))}
            onEnd={(reviewId) => closeReview(reviewId)}
            onMinimize={() => setActiveReviewPanel('minimized')}
            cwd={cwd}
            onSessionCreated={onSessionCreatedCallback}
          />
        </div>
      )}

      {/* Floating review panel — read-only history view */}
      {historyReview && (
        <FloatingReviewPanel
          reviews={[{
            reviewId: historyReview.id || historyReview.reviewId || '',
            childSessionId: historyReview.child_cli_session_id || historyReview.childSessionId || '',
            childAdapter: historyReview.child_adapter || historyReview.childAdapter,
            reviewTitle: historyReview.review_title || historyReview.reviewTitle,
          }]}
          onEnd={() => closeHistoryPanel()}
          onMinimize={() => closeHistoryPanel()}
          readOnly
        />
      )}

      {/* Send-to-existing bottom sheet — shown when active reviews exist */}
      <SendToExistingSheet
        visible={!!sendToMessageId}
        activeReviews={activeReviews}
        onSendToExisting={handleSendToExisting}
        onStartNew={handleStartNewFromSheet}
        onClose={() => setSendToMessageId(null)}
      />

      {/* Review action menu — two-step bottom sheet for adapter + action selection */}
      <ReviewActionMenu
        visible={!!reviewMenuMessageId}
        adapters={sendTargetMenuEntries}
        onDirectSend={handleDirectSend}
        onSendWithInstruction={handleSendWithInstruction}
        onClose={() => { setReviewMenuMessageId(null); }}
      />

      {/* Save-as-instruction toast */}
      {saveToast && (
        <div className="fixed bottom-20 left-4 right-4 bg-surface border border-border rounded-xl p-3 flex items-center justify-between z-30 safe-bottom">
          <span className="text-sm text-text-dim">存成常用？</span>
          <button
            className="text-sm text-accent font-medium px-3 py-1 rounded-md hover:bg-accent/10"
            onClick={() => {
              api.createInstruction(saveToast.label, saveToast.instruction);
              setSaveToast(null);
            }}
          >Save</button>
        </div>
      )}

      {/* Task progress FAB + bottom sheet */}
      <TaskFab snapshot={taskSnapshot} onClick={() => setTaskSheetOpen(true)} />
      <TaskBottomSheet snapshot={taskSnapshot} open={taskSheetOpen} onClose={() => setTaskSheetOpen(false)} />

      {/* Interactive prompt overlay (permissions, questions, plan approval, etc.) */}
      {interactivePrompt && (
        <InteractivePromptOverlay
          prompt={interactivePrompt}
          onRespond={respondPrompt}
        />
      )}
    </div>
  );
}
