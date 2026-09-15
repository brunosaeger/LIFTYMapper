// Painel lateral do modo "Editar closes" (ver Toolbar.jsx/MainApp.jsx) —
// mesma forma de LotsPanel.jsx, sem swatches de cor: a área de Close Up é
// sempre desenhada no laranja fixo do tema (ver FloorPlanCanvas.jsx,
// CloseUpMarker), não é escolhida pelo desenvolvedor.
export default function CloseUpsPanel({ closeUps, selectedCloseUpId, addActive, onStartAdd, onCancelAdd, onSelect, onRename, onDelete }) {
  return (
    <div className="lots-panel">
      <h2 className="points-panel__title">Close Up ({closeUps.length})</h2>
      <button
        type="button"
        className={'closeups-panel__add' + (addActive ? ' is-active' : '')}
        onClick={() => (addActive ? onCancelAdd() : onStartAdd())}
      >
        {addActive ? 'Arraste na planta…' : '+ Close Up'}
      </button>
      {closeUps.length === 0 && !addActive && (
        <p className="points-panel__empty">Nenhuma área criada ainda.</p>
      )}
      <ul className="points-panel__list">
        {closeUps.map((c) => (
          <li key={c.id} className="lots-panel__row">
            <div
              className={'points-panel__row lots-panel__row-main' + (c.id === selectedCloseUpId ? ' is-selected' : '')}
              onClick={() => onSelect(c.id)}
            >
              <input
                className="points-panel__input"
                value={c.name}
                onChange={(e) => onRename(c.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                aria-label="Nome da área de Close Up"
              />
              <button
                type="button"
                className="points-panel__delete"
                aria-label={'Remover Close Up ' + c.name}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm('Remover a área "' + c.name + '"?')) onDelete(c.id);
                }}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="points-panel__hint">
        Cada área serve pra centralizar um zoom no modo Interação — o
        operador toca dentro dela e o mapa amplia automaticamente aquele
        grupo de kanban.
      </p>
    </div>
  );
}
