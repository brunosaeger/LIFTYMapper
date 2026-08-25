import woodTexture from '../assets/pallet-wood.png';
import blueTexture from '../assets/pallet-blue.png';

// Caso 4 (diferenciação de pallets, ver CONTEXT.md): o pallet azul (metálico)
// fica levemente elevado do chão em 4 pezinhos — o robô precisa de uma
// altura no ponto de PICKUP pra alinhar o garfo corretamente; o de madeira
// fica rente ao chão (altura 0, o comportamento que já existia antes dessa
// feature). Azul vem selecionado por padrão porque é o mais comum na planta.
export default function PointToPointBar({ pickupName, dropoffName, onClear, onSend, sending, willQueue, palletType, onPalletTypeChange }) {
  return (
    <div className="ptp-bar">
      <h2 className="points-panel__title">Ponto a Ponto</h2>
      <p className="ptp-bar__hint">Clique num ponto pra origem (coleta), depois noutro pra destino (entrega).</p>

      <div className="ptp-bar__slot">
        <span className="ptp-bar__slot-label ptp-bar__slot-label--pickup">Origem (PICKUP)</span>
        <span className="ptp-bar__slot-value">{pickupName || '—'}</span>
      </div>
      <div className="ptp-bar__slot">
        <span className="ptp-bar__slot-label ptp-bar__slot-label--dropoff">Destino (UNLOAD)</span>
        <span className="ptp-bar__slot-value">{dropoffName || '—'}</span>
      </div>

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
      </div>

      <div className="ptp-bar__actions">
        <button type="button" className="ptp-bar__clear" onClick={onClear} disabled={!pickupName && !dropoffName}>
          Limpar seleção
        </button>
        <button
          type="button"
          className="ptp-bar__send"
          onClick={onSend}
          disabled={!pickupName || !dropoffName || sending}
        >
          {sending ? 'Enviando…' : willQueue ? 'Adicionar à fila' : 'Enviar task'}
        </button>
      </div>
    </div>
  );
}
