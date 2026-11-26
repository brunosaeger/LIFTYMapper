import { displayCellName } from '../hooks/useCalibration';
import woodTexture from '../assets/pallet-wood.png';
import blueTexture from '../assets/pallet-blue.png';

// Menu "SOLICITAÇÃO DE PALLETS" (pedido do usuário, 2026-11-26 — ver
// server.py, "Solicitação de pallets"). Aberto pela mãozinha do chat. Escolhe
// o material (madeira/azul), toca nas posições vazias onde precisa de pallet
// (borda amarela girando no mapa), escreve uma mensagem opcional e envia. Só
// se sai daqui por "Enviar solicitação" ou "Remover solicitação" — tentar
// trocar de menu faz o botão vermelho pulsar (`callId` muda a cada tentativa).
const MATERIALS = [
  { type: 'wood', label: 'Madeira', texture: woodTexture },
  { type: 'blue', label: 'Azul', texture: blueTexture },
];
const TEXTURE = { wood: woodTexture, blue: blueTexture };

export default function PalletRequestPanel({
  material, onMaterialChange, positions, lots, points, text, onTextChange,
  onSend, onDiscard, sending, callId, zoomPicking,
}) {
  return (
    <div className="ptp-bar pallet-request">
      <h2 className="points-panel__title">Solicitação de pallets</h2>
      <p className="ptp-bar__hint">
        {zoomPicking
          ? 'Selecione o kanban que você deseja ampliar.'
          : 'Escolha o pallet e toque nas posições vazias onde precisa dele. Tocar de novo tira a posição.'}
      </p>

      <div className="ptp-bar__pallet-options">
        {MATERIALS.map((m) => (
          <button
            key={m.type}
            type="button"
            className={'ptp-bar__pallet-option' + (material === m.type ? ' is-selected' : '')}
            onClick={() => onMaterialChange(material === m.type ? null : m.type)}
          >
            <span className="ptp-bar__pallet-swatch" style={{ backgroundImage: `url(${m.texture})` }} />
            <span className="ptp-bar__pallet-label">{m.label}</span>
          </button>
        ))}
      </div>

      <div className="ptp-bar__slot pallet-request__slot">
        <span className="ptp-bar__slot-label pallet-request__slot-label">
          Lotes solicitados{positions.length ? ' (' + positions.length + ')' : ''}
        </span>
        {positions.length === 0 ? (
          <span className="ptp-bar__slot-value">—</span>
        ) : (
          <span className="pallet-request__chips">
            {positions.map((p) => (
              <span key={p.name} className="pallet-request__chip">
                <span className="pallet-request__chip-swatch" style={{ backgroundImage: `url(${TEXTURE[p.material]})` }} />
                {displayCellName(p.name, lots, points)}
              </span>
            ))}
          </span>
        )}
      </div>

      <textarea
        className="pallet-request__text"
        rows={3}
        maxLength={500}
        placeholder="Mensagem (opcional)…"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
      />

      <div className="ptp-bar__actions">
        <button
          key={callId}
          type="button"
          className={'pallet-request__discard' + (callId ? ' is-calling' : '')}
          onClick={onDiscard}
          disabled={sending}
        >
          Remover solicitação
        </button>
        <button
          type="button"
          className="pallet-request__send"
          onClick={onSend}
          disabled={!positions.length || sending}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" /></svg>
          Enviar solicitação
        </button>
      </div>
    </div>
  );
}
