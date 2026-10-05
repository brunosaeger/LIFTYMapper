import { displayCellName } from '../hooks/useCalibration';

// Agrupa rotas consecutivas do mesmo "Lotes em sequência" (mesmo groupId)
// pra desenhar o tracejado laranja ao redor, igual ao painel "Tarefas
// aguardando envio" (pedido do usuário, 2026-10-05). Rotas de um grupo
// sempre ficam adjacentes na fila — nascem juntas no envio, nunca se
// intercalam com uma rota independente no meio.
function groupWaitingRoutes(routes) {
  const segments = [];
  for (const route of routes) {
    const last = segments[segments.length - 1];
    if (route.groupId && last && last.groupId === route.groupId) {
      last.routes.push(route);
    } else {
      segments.push({ groupId: route.groupId || null, routes: [route] });
    }
  }
  return segments;
}

function QueueRoute({ pickup, dropoff, unloadOnly, user, lots, points, variant, selected, onSelect, onCancel, cancelLabel, cancelPending }) {
  // Cancelamento adiado (ver CONTEXT.md, "Cancelamento adiado até giro
  // seguro") — só existe pra rota EM ANDAMENTO (variant "current"); as
  // outras (pending/queued na fila) não têm essa espera, cancelam na hora
  // como sempre. Clicar de novo enquanto pending é inofensivo (servidor
  // idempotente), então o botão continua clicável — só troca o
  // rótulo/ícone pra deixar claro que já foi pedido e está esperando.
  const pendingLabel = 'Aguardando giro seguro para cancelar...';
  return (
    <li className={'queue-route queue-route--' + variant + (selected ? ' is-selected' : '')}>
      <button type="button" className="queue-route__main" onClick={onSelect}>
        {/* Substituição puramente visual (ver useCalibration.js,
            displayCellName) — pickup/dropoff continuam sendo os nomes
            técnicos que vieram do servidor, usados em onSelect/onCancel
            acima sem nenhuma mudança.
            unloadOnly (ver CONTEXT.md, "Cancelamento pós-pickup"): tarefa
            isolada de UNLOAD criada depois de cancelar já com o pallet no
            garfo — não tem origem (já foi feita, cancelada), devolve o
            pallet ao ponto de ORIGEM da rota cancelada (dropoff aqui é o
            destino desta tarefa nova, não da rota original). */}
        <span className="queue-route__name">
          {unloadOnly
            ? 'DESCARREGANDO EM: ' + displayCellName(dropoff, lots, points)
            : displayCellName(pickup, lots, points) + ' → ' + displayCellName(dropoff, lots, points)}
        </span>
        {/* Pedido do usuário, 2026-10-01: mostrar quem solicitou, discreto
            (cinza, menor) — não compete visualmente com o nome da rota. */}
        {user && <span className="queue-route__user">Enviado por: {user}</span>}
        {variant === 'current' && (
          <span className="queue-route__bar" aria-hidden="true">
            <span className="queue-route__bar-fill" />
          </span>
        )}
      </button>
      {onCancel && (
        <button
          type="button"
          className={'queue-route__cancel' + (cancelPending ? ' queue-route__cancel--pending' : '')}
          aria-label={cancelPending ? pendingLabel : cancelLabel}
          title={cancelPending ? pendingLabel : cancelLabel}
          onClick={onCancel}
        >
          {cancelPending ? '⏳' : '✕'}
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
// selectedRouteId: qual rota está "isolada" no mapa com zoom/banner agora —
// null (padrão, mostra a rota em andamento sem banner), 'current' (rota em
// andamento isolada EXPLICITAMENTE, com zoom/banner — pedido do usuário,
// 2026-10-05) ou um id de "Próximas rotas". Clicar em qualquer uma alterna
// a seleção, inclusive a em andamento (ver MainApp.jsx,
// handleSelectQueueRoute/mapPickupNames).
export default function QueuePanel({ currentRoute, waitingRoutes, lots, points, selectedRouteId, onSelectRoute, onCancelCurrent, onRemoveQueued, cancelPending }) {
  return (
    <div className="queue-panel">
      <section className="queue-panel__section">
        <h2 className="points-panel__title">Rota em andamento</h2>
        {currentRoute ? (
          <ul className="queue-panel__list">
            <QueueRoute
              pickup={currentRoute.pickup}
              dropoff={currentRoute.dropoff}
              unloadOnly={currentRoute.unloadOnly}
              user={currentRoute.user}
              lots={lots}
              points={points}
              variant="current"
              selected={!selectedRouteId || selectedRouteId === 'current'}
              onSelect={() => onSelectRoute(selectedRouteId === 'current' ? null : 'current')}
              // Tarefa isolada de descarregar (ver CONTEXT.md, "Cancelamento
              // pós-pickup") não pode ser cancelada pela UI: cancelar ela de
              // novo só recriaria o mesmo problema que ela existe pra
              // resolver (pallet preso no garfo), possivelmente em posição
              // pior (no meio do movimento de descarregar).
              onCancel={currentRoute.unloadOnly ? null : onCancelCurrent}
              cancelLabel="Cancelar rota em andamento (a próxima assume)"
              cancelPending={cancelPending}
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
            {(() => {
              let globalIdx = 0;
              return groupWaitingRoutes(waitingRoutes).map((seg) => {
                const items = seg.routes.map((route) => {
                  const i = globalIdx++;
                  return (
                    <QueueRoute
                      key={route.id}
                      pickup={route.pickup}
                      dropoff={route.dropoff}
                      user={route.user}
                      lots={lots}
                      points={points}
                      variant="waiting"
                      selected={selectedRouteId === route.id}
                      onSelect={() => onSelectRoute(selectedRouteId === route.id ? null : route.id)}
                      onCancel={() => onRemoveQueued(route.id)}
                      cancelLabel={i === 0 ? 'Cancelar próxima rota' : 'Remover da fila'}
                    />
                  );
                });
                if (!seg.groupId) return items;
                return (
                  <li key={'group-' + seg.groupId} className="queue-panel__group">
                    <div className="staged-group">
                      <span className="staged-group__label">Lotes em sequência</span>
                      <ul className="queue-panel__list">{items}</ul>
                    </div>
                  </li>
                );
              });
            })()}
          </ul>
        )}
      </section>
    </div>
  );
}
