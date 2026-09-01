function RouteRow({ pickup, dropoff, removeLabel, onRemove }) {
  return (
    <li className="route-row">
      <span className="route-row__label">{pickup} → {dropoff}</span>
      <button type="button" className="route-row__cancel" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
        ✕
      </button>
    </li>
  );
}

// "Rota em andamento": a task rodando agora no robô (no máximo uma). Cancelar
// aqui cancela SÓ ela — a próxima da fila assume o lugar na hora, o robô não
// para nem volta pra carga.
// "Próximas rotas": a 1ª pode já ter sido disparada pro robô como "próxima"
// (pendingRoute) e o resto é fila local; cancelar qualquer uma não afeta a
// rota em andamento.
export default function RouteQueue({ currentRoute, queue, onCancelCurrent, onRemoveQueued }) {
  return (
    <div className="route-queue">
      <section className="route-queue__section">
        <h2 className="points-panel__title">Rota em andamento</h2>
        {currentRoute ? (
          <ul className="route-queue__list">
            <RouteRow
              pickup={currentRoute.pickup}
              dropoff={currentRoute.dropoff}
              removeLabel="Cancelar rota em andamento (a próxima assume)"
              onRemove={onCancelCurrent}
            />
          </ul>
        ) : (
          <p className="points-panel__empty">Nenhuma rota em andamento.</p>
        )}
      </section>

      <section className="route-queue__section">
        <h2 className="points-panel__title">Próximas rotas ({queue.length})</h2>
        {queue.length === 0 ? (
          <p className="points-panel__empty">Fila vazia.</p>
        ) : (
          <ul className="route-queue__list route-queue__list--scroll">
            {queue.map((route, i) => (
              <RouteRow
                key={route.id}
                pickup={route.pickup}
                dropoff={route.dropoff}
                removeLabel={i === 0 ? 'Cancelar próxima rota' : 'Remover da fila'}
                onRemove={() => onRemoveQueued(route.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
