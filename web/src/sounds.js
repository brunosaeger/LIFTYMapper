// Toca um efeito sonoro UMA vez. Navegador pode bloquear áudio antes de
// qualquer toque na tela — nesse caso falha em silêncio (o visual segue).
export function playOnce(url, volume = 1) {
  try {
    const a = new Audio(url);
    a.volume = volume;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch { /* sem áudio */ }
}

export const SOUND_FAILED_ROUTE = '/sounds/failedtrue.webm';
export const SOUND_FAILED_ROUTE_VOLUME = 0.6;
export const SOUND_CHARGE_READY = '/sounds/chargeready.webm';
export const SOUND_ROBOT_NOTICE = '/sounds/opoveshchenie.mp3';
