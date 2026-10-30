import { displayCellName } from '../hooks/useCalibration';
import woodTexture from '../assets/pallet-wood.png';
import blueTexture from '../assets/pallet-blue.png';

import ManualInfoButton from './ManualInfoButton';

// Modo Marcação = pincel de material (2026-10-30; antes era o X sem
// material). Escolhido o material, tocar/arrastar nos quadrados marca o
// pallet daquele material (fundo vivo + textura) e já ocupa a posição;
// começar num quadrado que já tem esse material o esvazia. "Remover
// marcação" (ou nenhum material escolhido) esvazia o que tocar. O Ponto a Ponto
// usa esse material como o pallet da tarefa (ver MainApp, materialForPickup).
// Quadrados com X são marcações antigas, sem material: pintar por cima.
const MATERIALS = [
  { type: 'wood', label: 'Madeira', texture: woodTexture },
  { type: 'blue', label: 'Azul', texture: blueTexture },
];
const TEXTURE = { wood: woodTexture, blue: blueTexture };

export default function OccupancyPanel({
  onOpenManual, occupied, lots, points, onToggle, brushMaterial, onBrushMaterialChange, palletMaterials,
}) {
  const unknown = occupied.filter((n) => !palletMaterials[n]).length;
  return (
    <div className="points-panel">
      <h2 className="points-panel__title">
        Ocupação ({occupied.length})
        <ManualInfoButton page={26} onOpen={onOpenManual} />
      </h2>
      <div className="ptp-bar__pallet brush-panel">
        <h3 className="ptp-bar__pallet-title">Material do pallet</h3>
        <p className="ptp-bar__hint">Escolha o material de pallet que deseja marcar no lote.</p>
        <div className="ptp-bar__pallet-options">
          {MATERIALS.map((m) => (
            <button
              key={m.type}
              type="button"
              className={'ptp-bar__pallet-option' + (brushMaterial === m.type ? ' is-selected' : '')}
              onClick={() => onBrushMaterialChange(brushMaterial === m.type ? null : m.type)}
            >
              <span className="ptp-bar__pallet-swatch" style={{ backgroundImage: `url(${m.texture})` }} />
              <span className="ptp-bar__pallet-label">{m.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={'ptp-bar__pallet-option brush-erase' + (brushMaterial === 'erase' ? ' is-selected' : '')}
          onClick={() => onBrushMaterialChange(brushMaterial === 'erase' ? null : 'erase')}
        >
          <span className="brush-erase__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </span>
          <span className="ptp-bar__pallet-label">Remover marcação</span>
        </button>
        <p className="ptp-bar__hint brush-panel__note">
          {brushMaterial === 'wood' || brushMaterial === 'blue'
            ? 'Toque ou arraste nos quadrados pra marcar. Começar num quadrado que já tem esse material o esvazia.'
            : 'Toque ou arraste nos quadrados pra remover a marcação (posição vazia).'}
        </p>
        {unknown > 0 && (
          <p className="ptp-bar__hint brush-panel__warn">
            {unknown} posição(ões) com X são marcações antigas, sem material — pinte por cima com o material certo.
            Tarefas com origem nelas não podem ser enviadas.
          </p>
        )}
      </div>
      {occupied.length === 0 ? (
        <p className="points-panel__empty">Nenhum ponto marcado como ocupado.</p>
      ) : (
        <ul className="points-panel__list">
          {occupied.map((name) => (
            <li key={name} className="points-panel__row is-selected">
              {/* Substituição puramente visual — `name` (técnico) continua
                  sendo usado em onToggle/aria-label logo abaixo, sem
                  mudança nenhuma. */}
              <span
                className={'occupancy-swatch' + (palletMaterials[name] ? '' : ' is-unknown')}
                style={palletMaterials[name] ? { backgroundImage: `url(${TEXTURE[palletMaterials[name]]})` } : undefined}
                title={palletMaterials[name] === 'blue' ? 'Azul' : palletMaterials[name] === 'wood' ? 'Madeira' : 'Sem material'}
              >
                {palletMaterials[name] ? '' : '✕'}
              </span>
              <span className="ptp-bar__slot-value">{displayCellName(name, lots, points)}</span>
              <button
                type="button"
                className="points-panel__delete"
                aria-label={'Desmarcar ' + name}
                onClick={() => onToggle(name)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
