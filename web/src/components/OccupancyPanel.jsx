export default function OccupancyPanel({ occupied, onToggle }) {
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
              <span className="ptp-bar__slot-value">{name}</span>
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
