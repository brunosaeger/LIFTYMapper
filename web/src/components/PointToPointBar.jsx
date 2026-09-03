import woodTexture from '../assets/pallet-wood.png';
import blueTexture from '../assets/pallet-blue.png';

// Caso 4 (diferenciação de pallets, ver CONTEXT.md): o pallet azul (metálico)
// fica levemente elevado do chão em 4 pezinhos — o robô precisa de uma
// altura no ponto de PICKUP pra alinhar o garfo corretamente; o de madeira
// fica rente ao chão (altura 0, o comportamento que já existia antes dessa
// feature). Azul vem selecionado por padrão porque é o mais comum na planta.
export default function PointToPointBar({
  pickupNames, dropoffNames, onClear, onSend, sending, willQueue,
  palletType, onPalletTypeChange, palletTop, onPalletTopChange,
  sequenceMode, onToggleSequenceMode, activeSlot, onActiveSlotChange,
}) {
  const countsMatch = pickupNames.length === dropoffNames.length;
  const hasSelection = pickupNames.length > 0 || dropoffNames.length > 0;
  // Em sequência, exigir contagens iguais é o que garante que todo pallet
  // pego tem pra onde ir (ver CONTEXT.md, "Lotes em sequência") — decisão
  // do usuário: bloquear o envio até bater, em vez de mandar pela metade.
  const canSend = pickupNames.length > 0 && dropoffNames.length > 0 && countsMatch;
  const sendLabel = sending ? 'Enviando…'
    : willQueue ? 'Adicionar à fila'
    : pickupNames.length > 1 ? 'Enviar ' + pickupNames.length + ' tasks'
    : 'Enviar task';

  // Em modo sequência os slots viram BOTÕES (clicar troca qual está
  // recebendo as seleções do mapa); no modo normal continuam sendo só
  // visores passivos, como sempre foram.
  function renderSlot(kind, label, names) {
    const isActive = sequenceMode && activeSlot === kind;
    const className = 'ptp-bar__slot'
      + (sequenceMode ? ' ptp-bar__slot--clickable' : '')
      + (isActive ? ' is-active is-active--' + kind : '');
    const text = names.length ? names.join(', ') : '—';
    const content = (
      <>
        <span className={'ptp-bar__slot-label ptp-bar__slot-label--' + kind}>
          {label}{names.length > 1 ? ' (' + names.length + ')' : ''}
        </span>
        <span className="ptp-bar__slot-value">{text}</span>
      </>
    );
    if (!sequenceMode) return <div className={className}>{content}</div>;
    return (
      <button type="button" className={className} onClick={() => onActiveSlotChange(kind)}>
        {content}
      </button>
    );
  }

  return (
    <div className="ptp-bar">
      <h2 className="points-panel__title">Ponto a Ponto</h2>
      <p className="ptp-bar__hint">
        {sequenceMode
          ? 'Selecione as origens em ordem, clique em DESTINO e selecione os destinos na mesma quantidade.'
          : 'Clique num ponto pra origem (coleta), depois noutro pra destino (entrega).'}
      </p>

      {renderSlot('pickup', 'Origem (PICKUP)', pickupNames)}
      {renderSlot('dropoff', 'Destino (UNLOAD)', dropoffNames)}

      <label className="ptp-bar__sequence">
        <input type="checkbox" checked={sequenceMode} onChange={onToggleSequenceMode} />
        Lotes em sequência
      </label>
      {sequenceMode && hasSelection && !countsMatch && (
        <p className="ptp-bar__sequence-warn">
          {pickupNames.length} origem(ns) / {dropoffNames.length} destino(s) — precisa bater pra enviar.
        </p>
      )}

      <div className="ptp-bar__pallet">
        <h3 className="ptp-bar__pallet-title">Escolha o modelo de pallet</h3>
        <div className="ptp-bar__pallet-options">
          <button
            type="button"
            className={'ptp-bar__pallet-option' + (palletType === 'wood' ? ' is-selected' : '')}
            onClick={() => onPalletTypeChange('wood')}
          >
            <span className="ptp-bar__pallet-swatch" style={{ backgroundImage: `url(${woodTexture})` }} />
            <span className="ptp-bar__pallet-label">Madeira</span>
          </button>
          <button
            type="button"
            className={'ptp-bar__pallet-option' + (palletType === 'blue' ? ' is-selected' : '')}
            onClick={() => onPalletTypeChange('blue')}
          >
            <span className="ptp-bar__pallet-swatch" style={{ backgroundImage: `url(${blueTexture})` }} />
            <span className="ptp-bar__pallet-label">Azul</span>
          </button>
        </div>
        {/* Só pro azul: o pallet de dois níveis. Marcado = pega o 2º andar
            (layer 3, altura configurada no editor). Madeira não empilha. */}
        {palletType === 'blue' && (
          <label className="ptp-bar__pallet-top">
            <input
              type="checkbox"
              checked={!!palletTop}
              onChange={(e) => onPalletTopChange(e.target.checked)}
            />
            Pallet de cima
          </label>
        )}
      </div>

      <div className="ptp-bar__actions">
        <button type="button" className="ptp-bar__clear" onClick={onClear} disabled={!hasSelection}>
          Limpar seleção
        </button>
        <button
          type="button"
          className="ptp-bar__send"
          onClick={onSend}
          disabled={!canSend || sending}
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
