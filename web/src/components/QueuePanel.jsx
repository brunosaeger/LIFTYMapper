import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { displayCellName } from '../hooks/useCalibration';

// Mesmos tempos/tolerâncias do StagedTasksPanel (arrasto já validado lá) —
// ver esse arquivo pros comentários completos do porquê de cada valor.
const HOLD_TO_DRAG_MS = 280;
const MOVE_TOLERANCE_PX = 8;
const DROP_MARGIN_PX = 24;

// Agrupa rotas consecutivas do mesmo "Lotes em sequência" (mesmo groupId)
// pra desenhar o tracejado laranja ao redor, igual ao painel "Tarefas
// aguardando envio" (pedido do usuário, 2026-10-05). Rotas de um grupo
// sempre ficam adjacentes na fila — nascem juntas no envio, nunca se
// intercalam com uma rota independente no meio.
//
// Só opera sobre `routeQueue` (nunca a pendingRoute, ver QueuePanel
// abaixo) — mesmo se a pendingRoute tecnicamente compartilhar groupId com
// o resto do grupo (1ª perna já promovida), ela é tratada como item à
// parte: simplifica o arrasto (a pendingRoute nunca é arrastável) ao
// custo de, nesse caso raro, o contorno laranja não incluir ela — só o
// resto do grupo que ainda está na fila de verdade.
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

// `onClick` (quando passado) vai direto no <li> RAIZ, nunca num botão
// interno — pedido técnico do arrasto: um ancestral com
// `setPointerCapture` ativo (ver QueuePanel, handlePointerDown) faz o
// clique sintetizado não alcançar de forma confiável um botão
// DESCENDENTE nesse WebView — mesmo problema, mesma solução do
// StagedTasksPanel (handleClickUnit no <li>, não num botão de dentro).
// Dentro de um grupo, cada rota NÃO recebe `onClick` própria — quem
// escuta é o <li> externo do grupo (ver QueueUnit), por delegação via
// `data-route-id` (sempre presente aqui, com ou sem onClick direto).
function QueueRoute({ id, pickup, dropoff, unloadOnly, user, lots, points, variant, selected, onClick, onCancel, cancelLabel, cancelPending, dragHandlers, extraClassName = '', dragStyle, innerRef }) {
  // Cancelamento adiado (ver CONTEXT.md, "Cancelamento adiado até giro
  // seguro") — só existe pra rota EM ANDAMENTO (variant "current"); as
  // outras (pending/queued na fila) não têm essa espera, cancelam na hora
  // como sempre. Clicar de novo enquanto pending é inofensivo (servidor
  // idempotente), então o botão continua clicável — só troca o
  // rótulo/ícone pra deixar claro que já foi pedido e está esperando.
  const pendingLabel = 'Aguardando giro seguro para cancelar...';
  return (
    <li
      ref={innerRef}
      data-route-id={id}
      className={'queue-route queue-route--' + variant + (selected ? ' is-selected' : '') + extraClassName}
      style={dragStyle}
      onClick={onClick}
      {...dragHandlers}
    >
      <div className="queue-route__main">
        {/* Substituição puramente visual (ver useCalibration.js,
            displayCellName) — pickup/dropoff continuam sendo os nomes
            técnicos que vieram do servidor, usados em onClick/onCancel
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
      </div>
      {onCancel && (
        <button
          type="button"
          className={'queue-route__cancel' + (cancelPending ? ' queue-route__cancel--pending' : '')}
          aria-label={cancelPending ? pendingLabel : cancelLabel}
          title={cancelPending ? pendingLabel : cancelLabel}
          // Não pode iniciar o gesto de arrastar (ver liProps acima) nem
          // borbulhar pro onClick do <li> (que selecionaria a rota junto
          // com cancelar, já que agora o <li> escuta clique também).
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onCancel(e); }}
        >
          {cancelPending ? '⏳' : '✕'}
        </button>
      )}
    </li>
  );
}

// Conteúdo de uma unidade arrastável de "Próximas rotas": uma rota
// avulsa, ou um grupo inteiro de "Lotes em sequência" (tracejado laranja,
// move junto) — mesmo espírito do StagedTasksPanel/UnitContent. Os
// handlers/estilo de arrasto (dragHandlers/extraClassName/dragStyle/
// innerRef) sempre vão no elemento <li> RAIZ da unidade — pra uma rota
// avulsa, é o próprio <li> do QueueRoute; pra um grupo, é o <li> externo
// que envolve o bloco tracejado inteiro (as rotas de dentro do grupo não
// recebem esses handlers individualmente, só a unidade como um todo).
//
// `onUnitClick` é o MESMO handler em ambos os casos (ver QueuePanel,
// handleUnitClick) — ele acha QUAL rota foi tocada por `data-route-id`
// via closest(), então funciona tanto pra rota avulsa (acha o próprio
// <li>) quanto por delegação dentro de um grupo (acha o membro certo),
// igual StagedTasksPanel/handleClickUnit.
function QueueUnit({ unit, lots, points, selectedRouteId, onUnitClick, onRemoveQueued, cancelLabelOf, dragHandlers, extraClassName, dragStyle, innerRef }) {
  if (unit.routes.length === 1) {
    const route = unit.routes[0];
    return (
      <QueueRoute
        id={route.id}
        pickup={route.pickup}
        dropoff={route.dropoff}
        user={route.user}
        lots={lots}
        points={points}
        variant="waiting"
        selected={selectedRouteId === route.id}
        onClick={onUnitClick}
        onCancel={() => onRemoveQueued(route.id)}
        cancelLabel={cancelLabelOf(route.id)}
        dragHandlers={dragHandlers}
        extraClassName={extraClassName}
        dragStyle={dragStyle}
        innerRef={innerRef}
      />
    );
  }
  return (
    <li ref={innerRef} className={'queue-panel__group' + (extraClassName || '')} style={dragStyle} onClick={onUnitClick} {...dragHandlers}>
      <div className="staged-group">
        <span className="staged-group__label">Lotes em sequência</span>
        <ul className="queue-panel__list">
          {unit.routes.map((route) => (
            <QueueRoute
              key={route.id}
              id={route.id}
              pickup={route.pickup}
              dropoff={route.dropoff}
              user={route.user}
              lots={lots}
              points={points}
              variant="waiting"
              selected={selectedRouteId === route.id}
              onCancel={() => onRemoveQueued(route.id)}
              cancelLabel={cancelLabelOf(route.id)}
            />
          ))}
        </ul>
      </div>
    </li>
  );
}

// Painel "Fila" — antes vivia dentro do modo Ponto a Ponto (RouteQueue.jsx),
// agora é seu próprio modo (botão "índice" no mapa, ver FloorPlanCanvas). A
// LÓGICA de fila/cancelamento/prioridade não mudou nada, é toda do servidor
// (ver CONTEXT.md, "Fila de rotas compartilhada") — este componente só lê
// currentRoute/waitingRoutes e manda intenções pra cima (cancelar, remover,
// selecionar pra ver no mapa, reordenar).
//
// "Rota em andamento": a task rodando agora no robô (no máximo uma).
// Cancelar aqui cancela SÓ ela — a próxima da fila assume o lugar na hora.
// "Próximas rotas": a 1ª pode já ter sido disparada pro dispatch como
// "próxima" (pendingRoute) e o resto é fila local; cancelar qualquer uma
// não afeta a rota em andamento.
//
// selectedRouteId: qual rota está "isolada" no mapa com zoom/banner agora —
// null (padrão, mostra a rota em andamento sem banner), 'current' (rota em
// andamento isolada EXPLICITAMENTE, com zoom/banner) ou um id de "Próximas
// rotas". Clicar em qualquer uma alterna a seleção (ver MainApp.jsx,
// handleSelectQueueRoute/mapPickupNames).
//
// Arrastar-e-soltar (pedido do usuário, 2026-10-05): só a parte "pura
// fila" é arrastável — a pendingRoute (1ª de "Próximas rotas", já
// RESERVADA como próxima a disparar pro robô) fica fixa, igual a "Rota em
// andamento" já é. Segurar nela mostra um aviso em vez de arrastar. A
// permissão por kanban e a validação de ocupação são conferidas no
// SERVIDOR (ver server.py, _queue_reorder) — aqui só o gesto; se o
// servidor recusar, o `onReorder` (MainApp.jsx) mostra o erro por toast e
// a lista volta pro estado real no próximo refresh.
export default function QueuePanel({ currentRoute, waitingRoutes, lots, points, selectedRouteId, onSelectRoute, onCancelCurrent, onRemoveQueued, onReorder, hasPendingRoute, cancelPending, showToast }) {
  const listRef = useRef(null);
  const unitRefs = useRef(new Map());
  const pressRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [drag, setDragState] = useState(null);
  const dragRef = useRef(null);
  const [settling, setSettling] = useState(false);
  const scrollerRef = useRef(null);
  const rafRef = useRef(null);

  function setDrag(next) {
    dragRef.current = typeof next === 'function' ? next(dragRef.current) : next;
    setDragState(dragRef.current);
  }

  function blockTouchScroll(e) {
    if (e.cancelable) e.preventDefault();
  }

  function stopDragSideEffects() {
    document.removeEventListener('touchmove', blockTouchScroll);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  useEffect(() => () => {
    clearTimeout(pressRef.current?.timer);
    stopDragSideEffects();
  }, []);

  const pendingEntry = hasPendingRoute ? waitingRoutes[0] : null;
  const queueOnly = hasPendingRoute ? waitingRoutes.slice(1) : waitingRoutes;
  const dragUnits = groupWaitingRoutes(queueOnly);

  // Rótulo de cancelar/remover: "Cancelar próxima rota" só pra quem está
  // na posição GLOBAL 0 de "Próximas rotas" (a pendingRoute, se houver —
  // senão a 1ª da fila pura); o resto é sempre "Remover da fila". Mesma
  // regra de sempre, só reescrita em função do id pra funcionar dentro de
  // QueueUnit (que não sabe o índice global).
  const firstWaitingId = pendingEntry ? pendingEntry.id : (dragUnits[0]?.routes[0]?.id ?? null);
  function cancelLabelOf(routeId) {
    return routeId === firstWaitingId ? 'Cancelar próxima rota' : 'Remover da fila';
  }

  function activateDrag(index) {
    const press = pressRef.current;
    if (!press || press.index !== index) return;
    const rects = dragUnits.map((u) => unitRefs.current.get(u.routes[0].id)?.getBoundingClientRect() || null);
    const rect = rects[index];
    if (!rect) return;
    const gap = 6; // mesmo gap de .queue-panel__list
    press.active = true;
    navigator.vibrate?.(15);
    const scroller = listRef.current?.closest('.sidebar') || null;
    scrollerRef.current = scroller;
    document.addEventListener('touchmove', blockTouchScroll, { passive: false });
    setDrag({
      index,
      targetIndex: index,
      rects,
      rect,
      shift: rect.height + gap,
      offsetY: press.startY - rect.top,
      pointerX: press.startX,
      pointerY: press.startY,
      scrollStart: scroller ? scroller.scrollTop : 0,
      moved: false,
    });
    rafRef.current = requestAnimationFrame(autoScroll);
  }

  function retarget(d, pointerX = d.pointerX) {
    if (!isInsideList(pointerX, d.pointerY)) return { ...d, pointerX, targetIndex: d.index };
    const scrolled = (scrollerRef.current?.scrollTop ?? d.scrollStart) - d.scrollStart;
    const rects = d.rects.map((r) => (r ? { top: r.top - scrolled, height: r.height } : null));
    const ghostTop = d.pointerY - d.offsetY;
    return { ...d, pointerX, targetIndex: computeTarget(d.index, rects, ghostTop, d.rect.height) };
  }

  function isInsideList(x, y) {
    const r = listRef.current?.getBoundingClientRect();
    return !!r && x != null
      && x >= r.left - DROP_MARGIN_PX && x <= r.right + DROP_MARGIN_PX
      && y >= r.top - DROP_MARGIN_PX && y <= r.bottom + DROP_MARGIN_PX;
  }

  const EDGE_PX = 70;
  const MAX_AUTOSCROLL_PX = 14;

  function autoScroll() {
    const d = dragRef.current;
    const scroller = scrollerRef.current;
    if (!d || !scroller) return;
    if (d.moved) {
      const r = scroller.getBoundingClientRect();
      let v = 0;
      if (d.pointerY < r.top + EDGE_PX) v = -MAX_AUTOSCROLL_PX * (1 - Math.max(0, d.pointerY - r.top) / EDGE_PX);
      else if (d.pointerY > r.bottom - EDGE_PX) v = MAX_AUTOSCROLL_PX * (1 - Math.max(0, r.bottom - d.pointerY) / EDGE_PX);
      if (v) {
        const before = scroller.scrollTop;
        scroller.scrollTop += v;
        if (scroller.scrollTop !== before) setDrag(retarget(d));
      }
    }
    rafRef.current = requestAnimationFrame(autoScroll);
  }

  // `index` null = essa é a pendingRoute (1ª posição, travada) — o
  // "segurar" só mostra o aviso, nunca ativa um arrasto de verdade.
  function handlePointerDown(e, index) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    suppressClickRef.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pressRef.current = {
      index,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      timer: setTimeout(() => {
        if (index === null) {
          showToast?.('Essa rota já está reservada como a próxima a rodar — não dá pra reordenar ela.', 'error');
          return;
        }
        activateDrag(index);
      }, HOLD_TO_DRAG_MS),
    };
  }

  function computeTarget(from, rects, ghostTop, ghostHeight) {
    const ghostBottom = ghostTop + ghostHeight;
    let target = from;
    rects.forEach((r, i) => {
      if (i === from || !r) return;
      const mid = r.top + r.height / 2;
      if (i < from && ghostTop < mid) target -= 1;
      if (i > from && ghostBottom > mid) target += 1;
    });
    return target;
  }

  function handlePointerMove(e) {
    const press = pressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    const dx = e.clientX - press.startX;
    const dy = e.clientY - press.startY;
    if (!press.active) {
      if (Math.abs(dx) > MOVE_TOLERANCE_PX || Math.abs(dy) > MOVE_TOLERANCE_PX) {
        clearTimeout(press.timer);
        suppressClickRef.current = true;
      }
      return;
    }
    setDrag((d) => (d ? retarget({ ...d, pointerY: e.clientY, moved: true }, e.clientX) : d));
  }

  function finishPress(e, cancelled) {
    const press = pressRef.current;
    if (!press || (e && press.pointerId !== e.pointerId)) return;
    clearTimeout(press.timer);
    pressRef.current = null;
    if (!press.active) return;
    stopDragSideEffects();
    suppressClickRef.current = true;
    const d = dragRef.current;
    setDrag(null);
    if (cancelled || !d || !d.moved) return;
    if (!isInsideList(e.clientX, e.clientY) || d.targetIndex === d.index) return;
    // Otimista: já anima "assentar" na hora (resposta rápida, igual o modo
    // preparação) — o servidor é quem decide de verdade (kanban, cadeia de
    // ocupação); se recusar, o onReorder mostra o erro e a lista volta ao
    // normal sozinha no próximo refresh.
    const taskId = dragUnits[d.index].routes[0].id;
    onReorder(taskId, d.targetIndex);
    setSettling(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
  }

  // Mesmo handler pra toda "Próximas rotas" (rota avulsa OU grupo, ver
  // QueueUnit) — acha qual rota foi tocada por `data-route-id` (ver
  // QueueRoute) via closest(), igual StagedTasksPanel/handleClickUnit. Se
  // acabou de soltar um arrasto de verdade, engole o clique pra não
  // alternar a seleção junto (mesmo problema que o mouse tem lá).
  function handleUnitClick(e) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const routeId = e.target instanceof Element ? e.target.closest('[data-route-id]')?.dataset.routeId : null;
    if (routeId) onSelectRoute(selectedRouteId === routeId ? null : routeId);
  }

  function siblingShift(i) {
    if (!drag || i === drag.index) return 0;
    const { index: from, targetIndex: to, shift } = drag;
    if (from < to && i > from && i <= to) return -shift;
    if (from > to && i >= to && i < from) return shift;
    return 0;
  }

  const draggedUnit = drag ? dragUnits[drag.index] : null;

  return (
    <div className="queue-panel">
      <section className="queue-panel__section">
        <h2 className="points-panel__title">Rota em andamento</h2>
        {currentRoute ? (
          <ul className="queue-panel__list">
            <QueueRoute
              id="current"
              pickup={currentRoute.pickup}
              dropoff={currentRoute.dropoff}
              unloadOnly={currentRoute.unloadOnly}
              user={currentRoute.user}
              lots={lots}
              points={points}
              variant="current"
              selected={!selectedRouteId || selectedRouteId === 'current'}
              onClick={handleUnitClick}
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
          <>
            {dragUnits.length > 0 && (
              <p className="ptp-bar__hint staged-panel__hint">Segure e arraste pra mudar a ordem.</p>
            )}
            <ul className={'queue-panel__list queue-panel__list--scroll' + (drag ? ' is-dragging' : '') + (settling ? ' is-settling' : '')} ref={listRef}>
              {pendingEntry && (
                <QueueRoute
                  id={pendingEntry.id}
                  pickup={pendingEntry.pickup}
                  dropoff={pendingEntry.dropoff}
                  user={pendingEntry.user}
                  lots={lots}
                  points={points}
                  variant="waiting"
                  selected={selectedRouteId === pendingEntry.id}
                  onClick={handleUnitClick}
                  onCancel={() => onRemoveQueued(pendingEntry.id)}
                  cancelLabel={cancelLabelOf(pendingEntry.id)}
                  dragHandlers={{
                    onPointerDown: (e) => handlePointerDown(e, null),
                    onPointerUp: (e) => finishPress(e, false),
                    onPointerCancel: (e) => finishPress(e, true),
                    onContextMenu: (e) => e.preventDefault(),
                  }}
                />
              )}
              {dragUnits.map((unit, i) => (
                <QueueUnit
                  key={unit.routes[0].id}
                  unit={unit}
                  lots={lots}
                  points={points}
                  selectedRouteId={selectedRouteId}
                  onUnitClick={handleUnitClick}
                  onRemoveQueued={onRemoveQueued}
                  cancelLabelOf={cancelLabelOf}
                  innerRef={(el) => { if (el) unitRefs.current.set(unit.routes[0].id, el); else unitRefs.current.delete(unit.routes[0].id); }}
                  extraClassName={drag && drag.index === i ? ' is-placeholder' : ''}
                  dragStyle={{ transform: siblingShift(i) ? `translateY(${siblingShift(i)}px)` : undefined }}
                  dragHandlers={{
                    onPointerDown: (e) => handlePointerDown(e, i),
                    onPointerMove: handlePointerMove,
                    onPointerUp: (e) => finishPress(e, false),
                    onPointerCancel: (e) => finishPress(e, true),
                    onContextMenu: (e) => e.preventDefault(),
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {drag && draggedUnit && createPortal(
        <div
          className={'staged-ghost' + (drag.moved ? ' is-moving' : '')}
          style={{ left: drag.rect.left, top: drag.pointerY - drag.offsetY, width: drag.rect.width }}
          aria-hidden="true"
        >
          <ul className="queue-panel__list">
            <QueueUnit
              unit={draggedUnit}
              lots={lots}
              points={points}
              selectedRouteId={null}
              onUnitClick={() => {}}
              onRemoveQueued={() => {}}
              cancelLabelOf={() => ''}
            />
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
