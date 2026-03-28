import { useState, useEffect, useRef } from 'react';

/**
 * Tracks window.visualViewport.height to work around iOS PWA
 * keyboard resize bugs where `dvh` units don't update correctly
 * after the virtual keyboard dismisses.
 *
 * Also forces window.scrollTo(0, 0) when the keyboard closes,
 * because iOS standalone PWA may leave the document scrolled up
 * after keyboard dismissal, creating a gap at the bottom.
 *
 * Returns the current visual viewport height in pixels, or
 * undefined on platforms that don't support the API (falls back to CSS dvh).
 */
export function useVisualViewport(): number | undefined {
  const [height, setHeight] = useState<number | undefined>(() =>
    typeof window !== 'undefined' && window.visualViewport
      ? window.visualViewport.height
      : undefined,
  );
  const prevHeight = useRef(height);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const KEYBOARD_CLOSE_THRESHOLD = 50;
    const update = () => {
      const h = vv.height;
      if (prevHeight.current && h > prevHeight.current + KEYBOARD_CLOSE_THRESHOLD) {
        window.scrollTo(0, 0);
      }
      if (h !== prevHeight.current) {
        prevHeight.current = h;
        setHeight(h);
      }
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return height;
}
