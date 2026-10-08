// Mesmo retângulo semitransparente do RobotStatusBanner/CloseUpStatusBanner
// (ver esses arquivos) — indica que um cancelamento foi solicitado mas
// ainda NÃO aconteceu de verdade, porque o robô não tem espaço pra girar
// agora (ver server.py, "Cancelamento adiado até giro seguro" no
// CONTEXT.md). Fica visível o tempo que for preciso — some sozinho quando
// o servidor cancela de fato (o próximo poll de /api/live-state já vem
// com cancelPending=false) ou quando a rota termina por conta própria
// antes de existir uma janela segura.
//
// `variant` ('warning' padrão, âmbar — ou 'danger', vermelho pulsando):
// "Alerta de robô parado" (ver server.py, robotStalledMessage) usa
// 'danger' — é uma anomalia (caminho obstruído/desviou da rota) que pede
// ação do operador, diferente das esperas normais (âmbar) que o sistema
// resolve sozinho.
//
// Som: 'warning' toca notiftrue.webm UMA vez a cada aviso novo; 'danger'
// toca warningtrue.webm em LOOP até o aviso sumir. Navegador pode bloquear
// áudio sem gesto prévio do usuário — nesse caso tenta de novo no 1º toque.
import { useEffect } from 'react';

const SOUND_ONCE = '/sounds/notiftrue.webm';
const SOUND_LOOP = '/sounds/warningtrue.webm';

export default function CancelPendingBanner({ message, variant = 'warning' }) {
  const active = !!message;
  // Warning: re-toca quando o TEXTO muda (aviso novo); danger: só liga/desliga.
  const key = variant === 'danger' ? 'danger' : message;
  useEffect(() => {
    if (!active) return undefined;
    const loop = variant === 'danger';
    let audio;
    let retry = null;
    try {
      audio = new Audio(loop ? SOUND_LOOP : SOUND_ONCE);
      audio.loop = loop;
      const p = audio.play();
      if (p && p.catch) {
        p.catch(() => {
          retry = () => { audio.play().catch(() => {}); };
          window.addEventListener('pointerdown', retry, { once: true });
        });
      }
    } catch { /* sem áudio: segue só o visual */ }
    return () => {
      if (retry) window.removeEventListener('pointerdown', retry);
      if (audio) { audio.pause(); audio.src = ''; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  if (!message) return null;

  return (
    <div className={'cancel-pending-banner cancel-pending-banner--' + variant} role="status">
      {message}
    </div>
  );
}
