import React, { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useChat } from '../hooks/useChat';
import { ChatBody } from './ChatBody';
import { InteractivePromptOverlay } from './InteractivePromptOverlay';
import { getBrand } from '@/lib/adapter-brands';
import { extractTextFromBlocks } from '@/lib/content-utils';
import { api } from '@/lib/api';

// ===== Types =====

export interface ReviewEntry {
  reviewId: string;
  childSessionId: string;
  childAdapter: string;
  reviewTitle?: string;
  prompt?: string;
  permissionMode?: string;
}

interface ReviewPanelProps {
  reviews: ReviewEntry[];
  onEnd: (reviewId: string) => void;
  onMinimize: () => void;
  cwd?: string;
  onSessionCreated?: (reviewId: string, childSessionId: string) => void;
  readOnly?: boolean;
}

export interface ReviewPanelHandle {
  sendToReview: (reviewId: string, text: string) => void;
}

// ===== ReviewTab (one per review, keeps useChat hook alive) =====

const ReviewTab = React.memo(function ReviewTab({ review, cwd, onSessionCreated, isActive, readOnly, sendRef }: {
  review: ReviewEntry;
  cwd?: string;
  onSessionCreated?: (reviewId: string, sid: string) => void;
  isActive: boolean;
  readOnly?: boolean;
  sendRef?: React.MutableRefObject<Map<string, (text: string) => void>>;
}) {
  const {
    messages, streaming, pendingResponse, liveStatus, toolStatuses,
    sendMessage, abort, sessionId: chatSessionId,
    interactivePrompt, respondPrompt,
  } = useChat(
    review.childSessionId || undefined,
    cwd,
    review.childAdapter,
    review.prompt,
    review.permissionMode,
  );

  // Notify parent when child session is created
  const sessionCreatedRef = useRef(false);
  useEffect(() => {
    if (chatSessionId && !review.childSessionId && onSessionCreated && !sessionCreatedRef.current) {
      sessionCreatedRef.current = true;
      onSessionCreated(review.reviewId, chatSessionId);
    }
  }, [chatSessionId, review.childSessionId, onSessionCreated, review.reviewId]);

  // Register sendMessage in parent's ref map for sendToReview
  useEffect(() => {
    if (sendRef && review.reviewId) {
      sendRef.current.set(review.reviewId, sendMessage);
      return () => { sendRef.current.delete(review.reviewId); };
    }
  }, [sendRef, review.reviewId, sendMessage]);

  const brand = getBrand(review.childAdapter);

  // Send-back handler: extract text from message and send to parent via API
  const handleSendBack = useCallback(async (messageId: string) => {
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    const text = extractTextFromBlocks(msg.content);
    if (!review.reviewId) {
      console.warn('Send back unavailable: review not yet registered');
      return;
    }
    try {
      await api.sendBackToParent(review.reviewId, text);
    } catch (err: any) {
      console.error('Send back failed:', err.message || err);
    }
  }, [messages, review.reviewId]);

  return (
    <div style={{ display: isActive ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <ChatBody
        messages={messages}
        streaming={streaming}
        pendingResponse={pendingResponse}
        liveStatus={liveStatus}
        toolStatuses={toolStatuses || new Map()}
        onSend={sendMessage}
        onStop={abort}
        interrupted={false}
        onSendBack={readOnly ? undefined : handleSendBack}
        hideInput={readOnly}
        inputPlaceholder={`Reply to ${brand.displayName} review...`}
        className="flex-1"
      />
      {interactivePrompt && (
        <InteractivePromptOverlay
          prompt={interactivePrompt}
          onRespond={respondPrompt}
        />
      )}
    </div>
  );
});

// ===== Main Panel =====

export const FloatingReviewPanel = forwardRef<ReviewPanelHandle, ReviewPanelProps>(
  function FloatingReviewPanel({ reviews, onEnd, onMinimize, cwd, onSessionCreated, readOnly }, ref) {
    const [activeTabIndex, setActiveTabIndex] = useState(Math.max(0, reviews.length - 1));

    // Keep activeTabIndex in bounds
    useEffect(() => {
      if (activeTabIndex >= reviews.length) {
        setActiveTabIndex(Math.max(0, reviews.length - 1));
      }
    }, [reviews.length, activeTabIndex]);

    // Auto-focus newest tab when a review is added
    const prevCountRef = useRef(reviews.length);
    useEffect(() => {
      if (reviews.length > prevCountRef.current) {
        setActiveTabIndex(reviews.length - 1);
      }
      prevCountRef.current = reviews.length;
    }, [reviews.length]);

    // Ref map: reviewId → sendMessage function (populated by each ReviewTab)
    const sendRefs = useRef<Map<string, (text: string) => void>>(new Map());

    useImperativeHandle(ref, () => ({
      sendToReview(reviewId: string, text: string) {
        const send = sendRefs.current.get(reviewId);
        if (send) send(text);
        const idx = reviews.findIndex(r => r.reviewId === reviewId);
        if (idx >= 0) setActiveTabIndex(idx);
      },
    }), [reviews]);

    const activeReview = reviews[activeTabIndex] || reviews[0];
    if (!activeReview) return null;

    const brand = getBrand(activeReview.childAdapter);

    return (
      <div
        className="absolute bottom-0 left-0 right-0 z-10 flex flex-col rounded-t-xl review-panel-compact"
        style={{ height: '55%', backgroundColor: '#0f0f11', borderTop: `2px solid ${brand.color}40` }}
      >
        {/* Handle bar */}
        <div className="cursor-pointer mx-auto my-2" onClick={onMinimize}>
          <div className="w-8 h-0.5 rounded-sm bg-border" />
        </div>

        {/* Tab bar (multiple reviews) or single-review header */}
        {reviews.length > 1 ? (
          <div className="flex items-center border-b border-border">
            <div className="flex gap-0.5 px-3 flex-1 overflow-x-auto">
              {reviews.map((r, i) => {
                const b = getBrand(r.childAdapter);
                const tabActive = i === activeTabIndex;
                return (
                  <div
                    key={r.reviewId}
                    className="flex items-center gap-0.5 text-xs whitespace-nowrap"
                    style={{
                      color: tabActive ? b.color : '#71717a',
                      borderBottom: tabActive ? `2px solid ${b.color}` : '2px solid transparent',
                    }}
                  >
                    <button
                      onClick={() => setActiveTabIndex(i)}
                      className="flex items-center gap-1 px-2 py-2 transition-colors"
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: b.color }} />
                      {b.displayName}
                    </button>
                    {!readOnly && (
                      <button
                        className="px-1 py-2 text-[10px] hover:text-red-400 transition-colors"
                        onClick={() => onEnd(r.reviewId)}
                        aria-label={`End ${b.displayName} review`}
                      >{'\u2715'}</button>
                    )}
                  </div>
                );
              })}
            </div>
            {!readOnly && (
              <button
                onClick={onMinimize}
                className="text-xs text-text-dim/50 hover:text-text-dim px-3 py-2"
              >{'\u25BC'}</button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 pb-2">
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded"
              style={{
                backgroundColor: readOnly ? '#88888820' : `${brand.color}20`,
                color: readOnly ? '#888' : brand.color,
              }}
            >
              {brand.displayName}
            </span>
            <span className="text-xs text-text-dim flex-1 truncate">
              {activeReview.reviewTitle || 'Review Session'}
              {readOnly && <span className="ml-1 text-text-dim/50">(ended)</span>}
            </span>
            <button
              onClick={onMinimize}
              className="text-xs text-text-dim/50 hover:text-text-dim px-1 py-0.5 rounded hover:bg-white/5 transition-colors"
              title="Minimize"
            >{'\u25BC'}</button>
            <button
              onClick={() => onEnd(activeReview.reviewId)}
              className={readOnly
                ? 'text-xs text-text-dim/60 hover:text-text-dim px-2 py-1 rounded hover:bg-white/5 transition-colors'
                : 'text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-400/10 transition-colors'
              }
            >
              {readOnly ? '\u2715' : 'End'}
            </button>
          </div>
        )}

        {/* Tabs — ALL rendered to keep hooks alive, only active one visible via CSS */}
        {reviews.map((r, i) => (
          <ReviewTab
            key={r.reviewId}
            review={r}
            cwd={cwd}
            onSessionCreated={!r.childSessionId ? onSessionCreated : undefined}
            isActive={i === activeTabIndex}
            readOnly={readOnly}
            sendRef={sendRefs}
          />
        ))}
      </div>
    );
  }
);
