import { displayCellName } from '../hooks/useCalibration';

function QueueRoute({ pickup, dropoff, lots, points, variant, selected, onSelect, onCancel, cancelLabel }) {
  return (
    <li className={'queue-route queue-route--' + variant + (selected ? ' is-selected' : '')}>
      <button type="button" className="queue-route__main" onClick={onSelect}>
        {/* Substituição puramente visual (ver useCalibration.js,
            displayCellName) — pickup/dropoff continuam sendo os nomes
            técnicos que vieram do servidor, usados em onSelect/onCancel
            acima sem nenhuma mudança. */}
        <span className="queue-route__name">{displayCellName(pickup, lots, points)} → {displayCellName(dropoff, lots, points)}</span>
        {variant === 'current' && (
          <span className="queue-route__bar" aria-hidden="true">
            <span className="queue-route__bar-fill" />
          </span>
        )}
      </button>
      {onCancel && (
        <button type="button" className="queue-route__cancel" aria-label={cancelLabel} title={cancelLabel} onClick={onCancel}>
          ✕
        </button>
      )}
    </li>
  );
}

// Painel "Fila" — antes vivia dentro do modo Ponto a Ponto (RouteQueue.jsx),
// agora é seu próprio modo (botão "índice" no mapa, ver FloorPlanCanvas). A
// LÓGICA de fila/cancelamento/prioridade não mudou nada, é toda do servidor
// (ver CONTEXT.md, "Fila de rotas compartilhada") — este componente só lê
// currentRoute/waitingRoutes e manda intenções pra cima (cancelar, remover,
// selecionar pra ver no mapa).
//
// "Rota em andamento": a task rodando agora no robô (no máximo uma).
// Cancelar aqui cancela SÓ ela — a próxima da fila assume o lugar na hora.
// "Próximas rotas": a 1ª pode já ter sido disparada pro robô como "próxima"
// (pendingRoute) e o resto é fila local; cancelar qualquer uma não afeta a
// rota em andamento.
//
// selectedRouteId: qual rota da lista de espera está "isolada" no mapa agora
// (null = mostrando a rota em andamento, o padrão). Clicar numa rota alterna
// a seleção; clicar na rota em andamento sempre volta pro padrão (ver
// MainApp.jsx, handleSelectQueueRoute/mapPickupNames).
export default function QueuePanel({ currentRoute, waitingRoutes, lots, points, selectedRouteId, onSelectRoute, onCancelCurrent, onRemoveQueued }) {
  return (
    <div className="queue-panel">
      <section className="queue-panel__section">
        <h2 className="points-panel__title">Rota em andamento</h2>
        {currentRoute ? (
          <ul className="queue-panel__list">
            <QueueRoute
              pickup={currentRoute.pickup}
              dropoff={currentRoute.dropoff}
              lots={lots}
              points={points}
              variant="current"
              selected={!selectedRouteId}
              onSelect={() => onSelectRoute(null)}
              onCancel={onCancelCurrent}
              cancelLabel="Cancelar rota em andamento (a próxima assume)"
            />
          </ul>
        ) : (
          <p className="points-panel__empty">Nenhuma rota em andamento.</p>
        )}
      </section>

      <section className="queue-panel__section">
        <h2 className="points-panel__title">Próximas rotas ({waitingRoutes.length})</h2>
        {waitingRoutes.length === 0 ? (
          <p className="points-panel__empty">Fila vazia.</p>
        ) : (
          <ul className="queue-panel__list queue-panel__list--scroll">
            {waitingRoutes.map((route, i) => (
              <QueueRoute
                key={route.id}
                pickup={route.pickup}
                dropoff={route.dropoff}
                lots={lots}
                points={points}
                variant="waiting"
                selected={selectedRouteId === route.id}
                onSelect={() => onSelectRoute(selectedRouteId === route.id ? null : route.id)}
                onCancel={() => onRemoveQueued(route.id)}
                cancelLabel={i === 0 ? 'Cancelar próxima rota' : 'Remover da fila'}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
