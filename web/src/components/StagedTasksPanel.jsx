import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import woodTexture from '../assets/pallet-wood.png';
import blueTexture from '../assets/pallet-blue.png';
import { displayCellName } from '../hooks/useCalibration';

// Segurar parado esse tempo antes de "levantar" a barrinha pra arrastar —
// distingue arrastar de tocar (selecionar/editar) e de deslizar o dedo pra
// rolar a lista.
const HOLD_TO_DRAG_MS = 280;
// Mexeu mais que isso antes do tempo de segurar acabar = é rolagem, não
// arrasto.
const MOVE_TOLERANCE_PX = 8;
// Soltar até essa distância fora da lista ainda conta como "dentro" — dedo
// não é preciso, e soltar rente à borda de baixo/cima é comum.
const DROP_MARGIN_PX = 24;

const TEXTURE = { wood: woodTexture, blue: blueTexture };

function PalletSwatch({ palletType, palletTop, onOpen }) {
  return (
    <button
      type="button"
      className="staged-task__pallet"
      style={{ backgroundImage: `url(${TEXTURE[palletType] || woodTexture})` }}
      aria-label={'Pallet ' + (palletType === 'blue' ? 'azul' : 'de madeira') + (palletTop ? ' (de cima)' : '') + ' — tocar pra trocar'}
      title="Trocar modelo de pallet"
      // Não pode iniciar o gesto de arrastar/selecionar da barrinha.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onOpen(e.currentTarget); }}
    >
      {palletTop && <span className="staged-task__pallet-top">2º</span>}
    </button>
  );
}

// Uma barrinha (uma tarefa). `order` é a posição GLOBAL na lista (o que o
// robô vai fazer em 1º, 2º...), não a posição dentro do grupo.
function TaskBar({ task, unit, order, lots, points, invalid, delay, onOpenPallet, onRemove }) {
  return (
    <div className="staged-task__row" data-task-id={task.id}>
      <div
        className={'staged-task' + (invalid ? ' is-invalid' : '')}
        style={{ '--staged-delay': delay + 'ms' }}
      >
        <span className="staged-task__order">{order}</span>
        <span className="staged-task__name">
          {displayCellName(task.pickup, lots, points)} → {displayCellName(task.dropoff, lots, points)}
        </span>
        <PalletSwatch
          palletType={unit.palletType}
          palletTop={unit.palletTop}
          onOpen={(anchor) => onOpenPallet(unit.id, anchor)}
        />
      </div>
      <button
        type="button"
        className="staged-task__remove"
        aria-label="Remover da lista de envio"
        title="Remover da lista de envio"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onRemove(unit.id, task.id); }}
      >
        ✕
      </button>
    </div>
  );
}

// Conteúdo visual de uma "unidade" arrastável: uma tarefa avulsa, ou um
// grupo inteiro de "Lotes em sequência" (tracejado laranja) — o grupo só
// se move junto, nunca uma tarefa dele sozinha.
function UnitContent({ unit, startOrder, lots, points, invalidTaskId, onOpenPallet, onRemove }) {
  const bars = unit.tasks.map((task, i) => (
    <TaskBar
      key={task.id}
      task={task}
      unit={unit}
      order={startOrder + i}
      lots={lots}
      points={points}
      invalid={task.id === invalidTaskId}
      delay={i * 70}
      onOpenPallet={onOpenPallet}
      onRemove={onRemove}
    />
  ));
  if (!unit.groupKey) return bars;
  return (
    <div className="staged-group">
      <span className="staged-group__label">Lotes em sequência</span>
      {bars}
    </div>
  );
}

function PalletPopover({ popover, unit, onChoose, onClose }) {
  if (!popover || !unit) return null;
  const width = 220;
  const left = Math.min(Math.max(8, popover.left - width + popover.width), window.innerWidth - width - 8);
  const top = Math.min(popover.top, window.innerHeight - 190);
  return createPortal(
    <div className="staged-popover__backdrop" onPointerDown={onClose}>
      <div
        className="staged-popover"
        style={{ left, top, width }}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Modelo de pallet"
      >
        <h3 className="ptp-bar__pallet-title">Modelo de pallet</h3>
        <div className="ptp-bar__pallet-options">
          {['wood', 'blue'].map((type) => (
            <button
              key={type}
              type="button"
              className={'ptp-bar__pallet-option' + (unit.palletType === type ? ' is-selected' : '')}
              onClick={() => { onChoose(unit.id, type, type === 'blue' && unit.palletTop); onClose(); }}
            >
              <span className="ptp-bar__pallet-swatch" style={{ backgroundImage: `url(${TEXTURE[type]})` }} />
              <span className="ptp-bar__pallet-label">{type === 'blue' ? 'Azul' : 'Madeira'}</span>
            </button>
          ))}
        </div>
        {unit.palletType === 'blue' && (
          <label className="ptp-bar__pallet-top">
            <input
              type="checkbox"
              checked={!!unit.palletTop}
              onChange={(e) => onChoose(unit.id, 'blue', e.target.checked)}
            />
            Pallet de cima
          </label>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 1.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}

// "Tarefas aguardando envio" (ver CONTEXT.md e MainApp.jsx): tarefas montadas
// no Ponto a Ponto ficam aqui antes de irem pro robô, pra dar tempo de
// conferir, reordenar, trocar pallet ou editar. Só "Iniciar tarefas" manda
// pro servidor. Toda a REGRA (validação de obstrução ao reordenar/remover,
// edição) mora no MainApp — este componente só cuida do gesto e do visual, e
// pergunta pra cima via onReorder se a nova ordem vale (true = aplicou).
export default function StagedTasksPanel({
  units, lots, points, editingUnitId, invalidTaskId, blockedReason,
  onSelectUnit, onRemoveTask, onReorder, onChangePallet, onStart, starting,
}) {
  const listRef = useRef(null);
  const unitRefs = useRef(new Map());
  const pressRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [drag, setDragState] = useState(null);
  // Espelho síncrono do estado de arrasto — o pointerup pode chegar antes do
  // re-render do último pointermove, e decidir o drop com um alvo velho.
  const dragRef = useRef(null);
  const [popover, setPopover] = useState(null);
  const [settling, setSettling] = useState(false);

  // Rolagem: quem rola é o MENU inteiro (.sidebar), nativo do navegador —
  // igual ao painel de marcações X, que o usuário aprovou. Antes do "segurar"
  // completar, deslizar o dedo numa barrinha rola normalmente (touch-action:
  // pan-y). Depois que levanta pro arrasto, a rolagem nativa é travada
  // (touchmove com preventDefault) e o menu passa a rolar sozinho quando a
  // prévia chega perto da borda de cima/baixo.
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

  // Limpa timer/trava/rolagem automática se o componente sumir no meio de um toque.
  useEffect(() => () => {
    clearTimeout(pressRef.current?.timer);
    stopDragSideEffects();
  }, []);

  const taskCount = units.reduce((n, u) => n + u.tasks.length, 0);

  function startOrderOf(index) {
    let n = 1;
    for (let i = 0; i < index; i++) n += units[i].tasks.length;
    return n;
  }

  function activateDrag(index) {
    const press = pressRef.current;
    if (!press || press.index !== index) return;
    const rects = units.map((u) => unitRefs.current.get(u.id)?.getBoundingClientRect() || null);
    const rect = rects[index];
    if (!rect) return;
    const gap = 8; // mesmo gap da .staged-list
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

  // As posições das barrinhas foram medidas ao levantar; se o menu rolou
  // desde então, elas subiram/desceram na tela na mesma medida.
  // Fora da lista (mapa, botão Iniciar, canto vazio do menu), soltar volta
  // pro lugar — então a prévia também mostra isso: as vizinhas voltam pro
  // lugar em vez de abrir espaço, pra não prometer uma posição que o soltar
  // não vai aplicar.
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

  function handlePointerDown(e, index) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (starting) return;
    // Gesto novo começa limpo: com mouse, o navegador dispara um clique no
    // fim do arrasto (que precisa ser ignorado), mas com o dedo não — sem
    // zerar aqui, a marca ficava pendurada e engolia o próximo toque.
    suppressClickRef.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pressRef.current = {
      index,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      timer: setTimeout(() => activateDrag(index), HOLD_TO_DRAG_MS),
    };
  }

  // Nova posição pela BORDA que está "empurrando": subindo, a de cima da
  // prévia passa do meio de uma vizinha de cima = troca com ela; descendo, a
  // de baixo. Usar o centro da prévia falhava com grupos (altos) — o centro
  // nunca chegava a passar da 1ª barrinha e o grupo não subia pro topo.
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
      // Ainda não levantou: mexeu = é rolagem (o navegador já está rolando o
      // menu, nativo) ou toque impreciso — não vira arrasto nem clique.
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
    // Soltou fora da lista (no mapa, num canto vazio do menu...) = volta pro
    // lugar de antes, sem mudar nada.
    if (!isInsideList(e.clientX, e.clientY) || d.targetIndex === d.index) return;
    if (onReorder(d.index, d.targetIndex)) {
      setSettling(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
    }
  }

  // Num grupo, cada barrinha é uma tarefa: manda também QUAL foi tocada (pra
  // "Visualizar tarefa" focar nela — ver MainApp, handleSelectStagedUnit).
  function handleClickUnit(e, unitId) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const taskId = e.target instanceof Element ? e.target.closest('[data-task-id]')?.dataset.taskId : null;
    onSelectUnit(unitId, taskId || null);
  }

  function siblingShift(i) {
    if (!drag || i === drag.index) return 0;
    const { index: from, targetIndex: to, shift } = drag;
    if (from < to && i > from && i <= to) return -shift;
    if (from > to && i >= to && i < from) return shift;
    return 0;
  }

  function openPallet(unitId, anchor) {
    const r = anchor.getBoundingClientRect();
    setPopover({ unitId, top: r.bottom + 6, left: r.left, width: r.width });
  }

  const draggedUnit = drag ? units[drag.index] : null;
  const canStart = units.length > 0 && !blockedReason && !starting;

  return (
    <section className="staged-panel">
      <h2 className="points-panel__title">Tarefas aguardando envio ({taskCount})</h2>
      {units.length === 0 ? (
        <p className="points-panel__empty">
          Nenhuma tarefa preparada. Monte uma rota acima e toque em Enviar tarefa.
        </p>
      ) : (
        <>
          <p className="ptp-bar__hint staged-panel__hint">
            Toque numa tarefa pra ver e editar no mapa. Segure e arraste pra mudar a ordem.
          </p>
          <ul className={'staged-list' + (drag ? ' is-dragging' : '') + (settling ? ' is-settling' : '')} ref={listRef}>
            {units.map((unit, i) => (
              <li
                key={unit.id}
                ref={(el) => { if (el) unitRefs.current.set(unit.id, el); else unitRefs.current.delete(unit.id); }}
                className={'staged-unit'
                  + (unit.id === editingUnitId ? ' is-selected' : '')
                  + (drag && drag.index === i ? ' is-placeholder' : '')}
                style={{ transform: siblingShift(i) ? `translateY(${siblingShift(i)}px)` : undefined }}
                onPointerDown={(e) => handlePointerDown(e, i)}
                onPointerMove={handlePointerMove}
                onPointerUp={(e) => finishPress(e, false)}
                onPointerCancel={(e) => finishPress(e, true)}
                // segurar o dedo não pode abrir menu de contexto/seleção do Android
                onContextMenu={(e) => e.preventDefault()}
                onClick={(e) => handleClickUnit(e, unit.id)}
              >
                <UnitContent
                  unit={unit}
                  startOrder={startOrderOf(i)}
                  lots={lots}
                  points={points}
                  invalidTaskId={invalidTaskId}
                  onOpenPallet={openPallet}
                  onRemove={onRemoveTask}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {blockedReason && units.length > 0 && (
        <p className={'staged-panel__warn staged-panel__warn--' + blockedReason.kind}>{blockedReason.text}</p>
      )}

      <button type="button" className="staged-panel__start" onClick={onStart} disabled={!canStart}>
        <PlayIcon />
        {starting ? 'Iniciando…' : 'Iniciar tarefas'}
      </button>

      {drag && draggedUnit && createPortal(
        <div
          className={'staged-ghost' + (drag.moved ? ' is-moving' : '')}
          style={{ left: drag.rect.left, top: drag.pointerY - drag.offsetY, width: drag.rect.width }}
          aria-hidden="true"
        >
          <UnitContent
            unit={draggedUnit}
            startOrder={startOrderOf(drag.index)}
            lots={lots}
            points={points}
            invalidTaskId={invalidTaskId}
            onOpenPallet={() => {}}
            onRemove={() => {}}
          />
        </div>,
        document.body,
      )}

      <PalletPopover
        popover={popover}
        unit={popover ? units.find((u) => u.id === popover.unitId) : null}
        onChoose={(unitId, type, top) => { onChangePallet(unitId, type, top); }}
        onClose={() => setPopover(null)}
      />
    </section>
  );
}
