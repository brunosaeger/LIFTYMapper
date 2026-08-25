import { LOT_COLORS } from '../theme';

const COLOR_KEYS = Object.keys(LOT_COLORS);

export default function LotsPanel({ lots, selectedLotId, onSelect, onRenamePrefix, onDelete, onSetColor, onToggleNames }) {
  if (lots.length === 0) return null;
  return (
    <div className="lots-panel">
      <h2 className="points-panel__title">Lotes ({lots.length})</h2>
      <ul className="points-panel__list">
        {lots.map((lot) => (
          <li key={lot.id} className="lots-panel__row">
            <div
              className={'points-panel__row lots-panel__row-main' + (lot.id === selectedLotId ? ' is-selected' : '')}
              onClick={() => onSelect(lot.id)}
            >
              <input
                className="points-panel__input"
                value={lot.prefix}
                onChange={(e) => onRenamePrefix(lot.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                aria-label="Prefixo do lote"
              />
              <span className="lots-panel__count">{lot.count}×</span>
              <button
                type="button"
                className="points-panel__delete"
                aria-label={'Remover lote ' + lot.prefix}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm('Remover o lote "' + lot.prefix + '" (' + lot.count + ' células)?')) onDelete(lot.id);
                }}
              >
                ✕
              </button>
            </div>
            <div className="lots-panel__swatches">
              {COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={'lots-panel__swatch' + (lot.color === key ? ' is-active' : '')}
                  style={{ '--swatch-color': LOT_COLORS[key] }}
                  aria-label={'Cor ' + key}
                  aria-pressed={lot.color === key}
                  onClick={() => onSetColor(lot.id, lot.color === key ? null : key)}
                />
              ))}
              <button
                type="button"
                className={'lots-panel__eye' + (lot.namesVisible ? ' is-active' : '')}
                aria-label={(lot.namesVisible ? 'Ocultar' : 'Mostrar') + ' nomes das células no mapa'}
                aria-pressed={!!lot.namesVisible}
                title="Mostrar/ocultar nomes das células no mapa"
                onClick={() => onToggleNames(lot.id)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
