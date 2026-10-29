// Aviso central que só fecha no OK (nem clique fora, nem Esc) — o operador
// tem que ler. `tone`: 'error' (vermelho) ou 'warn' (amarelo). Estado local
// deste aparelho: só quem disparou a ação vê (ver MainApp, handleStageSelection
// e handleStartStaged).
export default function NoticeModal({ notice, onClose }) {
  if (!notice) return null;
  return (
    <div className="dev-modal__backdrop notice-modal__backdrop">
      <div className={'dev-modal notice-modal notice-modal--' + notice.tone} role="alertdialog" aria-modal="true">
        <p className="notice-modal__text">{notice.text}</p>
        <div className="dev-modal__actions notice-modal__actions">
          <button type="button" className="notice-modal__ok" onClick={onClose} autoFocus>OK</button>
        </div>
      </div>
    </div>
  );
}
