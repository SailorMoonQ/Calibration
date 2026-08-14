import { useEffect } from 'react';

// Dismiss an open topbar dropdown when the pointer goes down anywhere outside
// its anchor. Shared by the settings and tools menus so the two can't drift
// apart in when they close.
export function useOutsideClick(ref, active, onDismiss) {
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onDismiss?.();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, active, onDismiss]);
}
