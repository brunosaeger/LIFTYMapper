export default function PointsPanel({ points, selectedId, onSelect, onRename, onDelete }) {
  return (
    <div className="points-panel">
      <h2 className="points-panel__title">Pontos avulsos ({points.length})</h2>
      {points.length === 0 && (
        <p className="points-panel__empty">
          Nenhum ponto ainda. Use “+ Ponto” e clique na planta pra criar o primeiro.
        </p>
      )}
      <ul className="points-panel__list">
        {points.map((p) => (
          <li
            key={p.id}
            className={'points-panel__row' + (p.id === selectedId ? ' is-selected' : '')}
            onClick={() => onSelect(p.id)}
          >
            <input
              className="points-panel__input"
              value={p.name}
              onChange={(e) => onRename(p.id, e.target.value)}
              onClick={(e) => e.stopPropagation()}
              aria-label={'Nome do ponto'}
            />
            <button
              type="button"
              className="points-panel__delete"
              aria-label={'Remover ' + p.name}
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm('Remover o ponto "' + p.name + '"?')) onDelete(p.id);
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <p className="points-panel__hint">
        O nome precisa ser <strong>idêntico</strong> ao ponto já calibrado no mapa do robô.
        Arraste o quadrado pra posicionar, use a alça pra girar (orientação do robô no ponto).
      </p>
    </div>
  );
}
