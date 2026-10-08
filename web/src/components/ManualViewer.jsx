import { useEffect, useRef } from 'react';

// Manual do usuário (PDF original: "MANUAL USUARIO LIFTY MAPPER.pdf"),
// pré-renderizado em JPEG (public/manual/p-NN.jpg, 1 por página) em vez de
// embutir o PDF: o Chrome do Android não tem leitor de PDF embutido (baixa o
// arquivo e ignora #page=N), e assim funciona igual em qualquer tablet, sem
// biblioteca nenhuma. As imagens carregam sob demanda (lazy) e cada página
// reserva a altura antes de carregar (aspect-ratio), então dá pra pular
// direto pra página certa sem o layout "pular" depois.
//
// Rola de cima pra baixo com o dedo; X no canto (ou toque fora / Esc) fecha.
//
// Dois manuais: 'user' (operador, 31 páginas, public/manual/) e 'admin'
// (administradores, 8 páginas, public/manual-admin/). `target` = { manual, page }.
export const MANUALS = {
  user: { dir: '/manual', pages: 31 },
  admin: { dir: '/manual-admin', pages: 8 },
};

export default function ManualViewer({ target, onClose }) {
  const page = target ? target.page : null;
  const manualKey = target && MANUALS[target.manual] ? target.manual : 'user';
  const manual = MANUALS[manualKey];
  const scrollRef = useRef(null);
  // onClose chega como função nova a cada render do app (que re-renderiza a
  // cada poll de 4s) — se ela entrasse nas dependências do efeito abaixo, o
  // scroll voltava pra página de abertura de tempos em tempos. Fica numa ref.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Só ao ABRIR (ou trocar de página-alvo): pula pra página da seção.
  useEffect(() => {
    if (!page) return undefined;
    const el = scrollRef.current && scrollRef.current.querySelector('[data-page="' + page + '"]');
    if (el) scrollRef.current.scrollTop = el.offsetTop - 10; // scroll é o offsetParent (position: relative); 10 = padding
    function onKey(e) { if (e.key === 'Escape') onCloseRef.current(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, manualKey]);

  if (!page) return null;

  const pages = Array.from({ length: manual.pages }, (_, i) => i + 1);
  return (
    <div className="manual-viewer__backdrop" onClick={onClose}>
      <div className="manual-viewer" role="dialog" aria-label="Manual do usuário" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="manual-viewer__close" aria-label="Fechar o manual" onClick={onClose}>✕</button>
        <div className="manual-viewer__scroll" ref={scrollRef}>
          {pages.map((n) => (
            <img
              key={n}
              data-page={n}
              className="manual-viewer__page"
              src={manual.dir + '/p-' + String(n).padStart(2, '0') + '.jpg'}
              alt={'Manual, página ' + n}
              loading="lazy"
              draggable="false"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
