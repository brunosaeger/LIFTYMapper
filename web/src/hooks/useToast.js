import { useCallback, useRef, useState } from 'react';

export function useToast() {
  const [toast, setToast] = useState(null); // { message, kind }
  const timer = useRef(null);

  const showToast = useCallback((message, kind = 'info') => {
    setToast({ message, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  return [toast, showToast];
}
