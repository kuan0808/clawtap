import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Square, ImagePlus, X, Mic } from 'lucide-react';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { STORAGE } from '@/lib/storage-keys';

const SHIMMER_KEYWORDS = ['ultrathink', 'megathink', 'think harder'];

function hasShimmerKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return SHIMMER_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Split text into segments, marking which ones are shimmer keywords */
function splitByKeywords(text: string): { text: string; shimmer: boolean }[] {
  const lower = text.toLowerCase();
  const segments: { text: string; shimmer: boolean }[] = [];
  let remaining = text;
  let pos = 0;

  while (pos < text.length) {
    let earliest = -1;
    let matchedKw = '';
    for (const kw of SHIMMER_KEYWORDS) {
      const idx = lower.indexOf(kw, pos);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        matchedKw = kw;
      }
    }
    if (earliest === -1) {
      segments.push({ text: text.slice(pos), shimmer: false });
      break;
    }
    if (earliest > pos) {
      segments.push({ text: text.slice(pos, earliest), shimmer: false });
    }
    segments.push({ text: text.slice(earliest, earliest + matchedKw.length), shimmer: true });
    pos = earliest + matchedKw.length;
  }
  return segments;
}

export function ShimmerInput({ onSend, onStop, disabled, streaming, interrupted, initialText = '', placeholder: placeholderProp }: {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled: boolean;
  streaming?: boolean;
  interrupted?: boolean;
  initialText?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { isRecording, interimText, toggleRecording, supported: voiceSupported } = useVoiceInput(
    (transcript) => {
      setText((prev) => prev + transcript);
    }
  );

  // Initialize text: initialText takes priority over saved draft
  useEffect(() => {
    if (initialText) {
      setText(initialText);
      textareaRef.current?.focus();
    } else {
      const saved = localStorage.getItem(STORAGE.DRAFT);
      if (saved) setText(saved);
    }
  }, [initialText]);

  // Debounce-save draft on text change
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(draftTimer.current);
    if (text.trim()) {
      draftTimer.current = setTimeout(() => {
        localStorage.setItem(STORAGE.DRAFT, text);
      }, 500);
    } else {
      localStorage.removeItem(STORAGE.DRAFT);
    }
    return () => clearTimeout(draftTimer.current);
  }, [text]);

  // Sync textarea value → React state for programmatic changes
  // (browser autofill, Playwright fill, accessibility tools, etc.)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const sync = () => {
      const v = el.value;
      setText(prev => prev !== v ? v : prev);
    };
    el.addEventListener('input', sync);
    return () => el.removeEventListener('input', sync);
  }, []);

  const isShimmer = hasShimmerKeyword(text);

  async function handleSend() {
    if (disabled || uploading) return;
    if (!text.trim() && !imageFile) return;

    let message = text.trim();

    // Upload image first if attached
    if (imageFile) {
      setUploading(true);
      try {
        const { path } = await api.uploadImage(imageFile);
        // Prepend image path to message so Claude can read it
        message = message
          ? `[Image: ${path}]\n\n${message}`
          : `Please analyze this image: ${path}`;
      } catch (err) {
        console.error('Image upload failed:', err);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    onSend(message);
    localStorage.removeItem(STORAGE.DRAFT);
    setText('');
    setImageFile(null);
    setImagePreview(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleInput() {
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
  }

  function attachImage(file: File) {
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    attachImage(file);
    e.target.value = '';
  }

  function removeImage() {
    setImageFile(null);
    setImagePreview(null);
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) attachImage(file);
          return;
        }
      }
      // items exist but no images — normal text paste, let it through
      return;
    }
    // Fallback: no clipboardData.items (some mobile browsers)
    try {
      const clipItems = await navigator.clipboard.read();
      for (const clipItem of clipItems) {
        const imageType = clipItem.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await clipItem.getType(imageType);
          const file = new File([blob], 'pasted-image.png', { type: imageType });
          attachImage(file);
          return;
        }
      }
    } catch {}
  }

  return (
    <div onPaste={handlePaste}>
      {/* Image preview */}
      {imagePreview && (
        <div className="flex items-center gap-2 mb-2 px-1">
          <div className="relative">
            <img src={imagePreview} alt="Upload" className="h-16 rounded-md border border-border object-cover" />
            <button
              onClick={removeImage}
              className="absolute -top-1.5 -right-1.5 bg-bg border border-border rounded-md p-0.5 hover:bg-surface cursor-pointer"
            >
              <X className="size-3" />
            </button>
          </div>
          <span className="text-xs text-text-dim">{imageFile?.name}</span>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        {/* Image button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="shrink-0 h-10 w-10"
        >
          <ImagePlus className="size-5" />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageSelect}
          className="hidden"
        />

        {voiceSupported && (
          <button
            type="button"
            onClick={toggleRecording}
            className={`p-2 rounded-md transition-colors ${
              isRecording
                ? 'text-red-500 bg-red-500/10 animate-pulse'
                : 'text-gray-400 hover:text-gray-300 hover:bg-white/5'
            }`}
            title={isRecording ? 'Stop recording' : 'Voice input'}
          >
            <Mic size={20} />
          </button>
        )}

        <div className="relative flex-1">
          {/* Overlay: renders keyword-only shimmer on top of transparent textarea text */}
          {isShimmer && (
            <div
              aria-hidden
              className="absolute inset-0 px-4 py-2.5 text-sm pointer-events-none whitespace-pre-wrap break-words overflow-hidden"
              style={{ maxHeight: 120 }}
            >
              {splitByKeywords(text).map((seg, i) =>
                seg.shimmer
                  ? <span key={i} className="shimmer-text text-transparent">{seg.text}</span>
                  : <span key={i} className="text-text">{seg.text}</span>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => { setText(e.target.value); handleInput(); }}
            placeholder={isRecording && interimText ? interimText : imageFile ? "Add a message (optional)..." : interrupted ? "What should Claude do instead?" : placeholderProp || "Send a message..."}
            rows={1}
            className={cn(
              'w-full bg-surface border border-border rounded-md px-4 py-2.5 text-sm text-text placeholder-text-dim font-mono resize-none',
              'focus:outline-none focus:border-accent focus:shadow-[0_0_6px_var(--color-accent-glow)] transition-colors',
              isShimmer && '!text-transparent caret-text',
            )}
            style={{ maxHeight: 120 }}
          />
        </div>
        {streaming && onStop && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onStop}
            className="shrink-0 h-10 w-10 text-danger"
          >
            <Square className="size-4 fill-current" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleSend}
          disabled={disabled || uploading || (!text.trim() && !imageFile)}
          className="shrink-0 h-10 w-10"
        >
          <Send className="size-5" />
        </Button>
      </div>
    </div>
  );
}
