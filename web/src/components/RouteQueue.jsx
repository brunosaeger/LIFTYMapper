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

// "Rota em andamento": a task já disparada pro robô (no máximo uma por vez).
// Cancelar aqui para o robô de verdade (mesmo mecanismo do botão de
// emergência da versão anterior — cancela tudo no dispatch-service).
// "Próximas rotas": fila local, nunca chegou a ser enviada pro robô — cancelar
// aqui só tira da fila, não afeta nada em execução.
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
              removeLabel="Cancelar rota em andamento (para o robô)"
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
            {queue.map((route) => (
              <RouteRow
                key={route.id}
                pickup={route.pickup}
                dropoff={route.dropoff}
                removeLabel="Remover da fila"
                onRemove={() => onRemoveQueued(route.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
