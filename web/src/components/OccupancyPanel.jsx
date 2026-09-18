import { displayCellName } from '../hooks/useCalibration';

export default function OccupancyPanel({ occupied, lots, points, onToggle }) {
  return (
    <div className="points-panel">
      <h2 className="points-panel__title">Ocupação ({occupied.length})</h2>
      <p className="ptp-bar__hint">
        Clique num quadrado no mapa pra marcar (tem pallet ali agora) ou desmarcar (vazio). O X aparece na
        mesma cor do quadrado.
      </p>
      {occupied.length === 0 ? (
        <p className="points-panel__empty">Nenhum ponto marcado como ocupado.</p>
      ) : (
        <ul className="points-panel__list">
          {occupied.map((name) => (
            <li key={name} className="points-panel__row is-selected">
              {/* Substituição puramente visual — `name` (técnico) continua
                  sendo usado em onToggle/aria-label logo abaixo, sem
                  mudança nenhuma. */}
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
