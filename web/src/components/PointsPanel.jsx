export default function PointsPanel({ points, selectedId, onSelect, onRename, onDelete, onToggleNames }) {
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
            {/* Mesmo olho dos lotes (ver LotsPanel) — nome do ponto começa
                ESCONDIDO no mapa e só aparece se ligarem aqui. */}
            <button
              type="button"
              className={'lots-panel__eye' + (p.namesVisible ? ' is-active' : '')}
              aria-label={(p.namesVisible ? 'Ocultar' : 'Mostrar') + ' nome do ponto no mapa'}
              aria-pressed={!!p.namesVisible}
              title="Mostrar/ocultar nome do ponto no mapa"
              onClick={(e) => {
                e.stopPropagation();
                onToggleNames(p.id);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
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
