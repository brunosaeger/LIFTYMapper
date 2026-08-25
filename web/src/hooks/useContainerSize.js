import { useEffect, useState } from 'react';

// Mede o tamanho disponível de um container via ResizeObserver, pra Konva
// Stage sempre caber no espaço real da tela (tablet, notebook, o que for).
export function useContainerSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
