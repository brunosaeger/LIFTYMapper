import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect, Text, Line, Group, Transformer } from 'react-konva';
import useImage from 'use-image';
import Konva from 'konva';
import { useContainerSize } from '../hooks/useContainerSize';
import { lotCellName } from '../hooks/useCalibration';
import { COLORS, LOT_COLORS, hexToRgba, darkenHex } from '../theme';
import topViewUrl from '../assets/floorplan.jpg';
import isoViewUrl from '../assets/isometric.jpg';

const VIEW_URLS = { top: topViewUrl, iso: isoViewUrl };

const ZOOM_STEP = 1.08;
const MAX_ZOOM_MULT = 8; // múltiplo do "encaixar na tela" — teto de quanto dá pra aproximar
const LOT_FILL_ALPHA = 0.32;
// Tamanho padrão de célula ao criar um lote novo (px "de conteúdo", ou seja,
// pixel real do floorplan.jpg, não pixel de tela). Extraído dos 3 lotes que
// já existiam no mapa (g/f/h, calibration.json) — o usuário ajustou os três
// manualmente até encaixar com o tamanho físico dos kanbans da planta, e
// bateram entre 11.67px e 12.29px. Usando a média pra não ter que
// redimensionar todo lote novo na mão.
const DEFAULT_CELL_SIZE = 11.97;
// Ponto a Ponto: duas escalas diferentes de "crescer" — uma persistente
// (célula é o pickup/dropoff atual, some só quando deixar de ser) e uma
// momentânea, um pouco maior ainda, por cima da persistente (mouse em cima
// ou dedo segurando/deslizando, até soltar pra confirmar).
const PTP_SELECTED_SCALE = 1.18;
const PTP_HOVER_SCALE = 1.32;
const PTP_HOVER_DURATION = 0.1;

function ptpTargetScale(isHovered, isSelectedEndpoint) {
  if (isHovered) return PTP_HOVER_SCALE;
  if (isSelectedEndpoint) return PTP_SELECTED_SCALE;
  return 1;
}

// Ponto a Ponto e Marcação de ocupação usam o mesmo gesto (crescer no
// hover/toque, confirmar só ao soltar — ver commitOnRelease) — só a AÇÃO no
// soltar muda (selecionar pickup/dropoff vs. marcar/desmarcar ocupado).
function usesHoverGesture(mode) {
  return mode === 'ptp' || mode === 'mark';
}

function markerColors(mode, { isSelected, isPickup, isDropoff }) {
  if (mode === 'ptp') {
    if (isPickup) return { fill: COLORS.accentCyanDim, stroke: COLORS.accentCyan };
    if (isDropoff) return { fill: COLORS.accentAmberDim, stroke: COLORS.accentAmber };
    return { fill: COLORS.panelRaised, stroke: COLORS.textMuted };
  }
  if (isSelected) return { fill: COLORS.panelRaisedHi, stroke: COLORS.accentAmber };
  return { fill: COLORS.panelRaised, stroke: COLORS.accentCyanDim };
}

// Cor de uma célula de lote: destaque de Ponto a Ponto (pickup/dropoff)
// sempre vence; senão, a cor escolhida pro lote (borda numa versão mais
// escura da cor, preenchimento semitransparente na cor cheia — mais
// contraste, divisão entre células grudadas fica mais evidente); senão, cai
// no esquema padrão (markerColors).
function lotCellColors(mode, lot, state) {
  if (mode === 'ptp' && state.isPickup) return { fill: COLORS.accentCyanDim, stroke: COLORS.accentCyan };
  if (mode === 'ptp' && state.isDropoff) return { fill: COLORS.accentAmberDim, stroke: COLORS.accentAmber };
  if (lot.color && LOT_COLORS[lot.color]) {
    const hex = LOT_COLORS[lot.color];
    return { fill: hexToRgba(hex, LOT_FILL_ALPHA), stroke: darkenHex(hex) };
  }
  return markerColors(mode, state);
}

// Cor do X de ocupação: a MESMA cor do quadrado (lote ou acento do modo),
// mas na versão cheia — nunca a diluída do fill (alpha, ver LOT_FILL_ALPHA)
// nem a escurecida do stroke (ver darkenHex) — fica visualmente acima das
// duas mesmo puxando pro mesmo tom. `lot` é null pra ponto avulso (sem cor
// própria, cai no par acento do modo).
function occupiedColor(mode, lot, state) {
  if (mode === 'ptp' && state.isPickup) return COLORS.accentCyan;
  if (mode === 'ptp' && state.isDropoff) return COLORS.accentAmber;
  if (lot && lot.color && LOT_COLORS[lot.color]) return LOT_COLORS[lot.color];
  if (state.isSelected) return COLORS.accentAmber;
  return COLORS.accentCyan;
}

// X geométrico (duas diagonais canto-a-canto, cruzando no centro) — em vez
// de um glifo de fonte, ocupa de verdade o interior do quadrado. `inset`
// evita que a ponta da diagonal se sobreponha ao stroke da borda. Outline
// (mesma cor da borda do quadrado) desenhada primeiro, mais grossa, atrás
// do traço principal — mesmo truque de "contorno" de texto: desenha as duas
// diagonais na cor de borda numa largura maior, depois por cima de novo na
// cor vibrante numa largura menor, deixando só a margem visível como
// contorno.
// opacity < 1 é usado pela prévia do gesto de "pintar arrastando" no modo
// mark (ver FloorPlanCanvas) — o X aparece translúcido nos quadrados
// tocados durante o arrasto, antes de soltar e confirmar de vez.
function XMark({ size, color, outlineColor, opacity = 1 }) {
  const half = size / 2 - Math.max(1.5, size * 0.06);
  const strokeWidth = Math.max(2, size * 0.16);
  const outlineWidth = strokeWidth + Math.max(1.5, size * 0.05) * 2;
  const diag1 = [-half, -half, half, half];
  const diag2 = [-half, half, half, -half];
  return (
    <>
      <Line points={diag1} stroke={outlineColor} strokeWidth={outlineWidth} lineCap="round" opacity={opacity} listening={false} />
      <Line points={diag2} stroke={outlineColor} strokeWidth={outlineWidth} lineCap="round" opacity={opacity} listening={false} />
      <Line points={diag1} stroke={color} strokeWidth={strokeWidth} lineCap="round" opacity={opacity} listening={false} />
      <Line points={diag2} stroke={color} strokeWidth={strokeWidth} lineCap="round" opacity={opacity} listening={false} />
    </>
  );
}

// Estado efetivo de ocupação já considerando a prévia do gesto de pintar
// arrastando: todo nome tocado durante o arrasto atual "vira" paintTarget
// (true=vai ocupar, false=vai desocupar) na exibição, antes mesmo do
// commit real acontecer ao soltar.
function computeEffectiveOccupied(occupiedNames, touched, target) {
  if (touched.size === 0 || target === null) return occupiedNames;
  const set = new Set(occupiedNames);
  for (const name of touched) {
    if (target) set.add(name); else set.delete(name);
  }
  return Array.from(set);
}

// Subconjunto dos tocados que vai de fato MUDAR de estado (ignora quem já
// estava no estado alvo) — é esse subconjunto que ganha o X translúcido;
// mostrar prévia em cima de quem não vai mudar nada seria ruído visual.
function computeChangingPreview(occupiedNames, touched, target) {
  if (touched.size === 0 || target === null) return touched;
  const changing = new Set();
  for (const name of touched) {
    if (occupiedNames.includes(name) !== target) changing.add(name);
  }
  return changing;
}

// Anima o node (via ref) até a escala alvo — usado no modo Ponto a Ponto pra
// crescer uma célula quando ela é o pickup/dropoff atual (persistente) e/ou
// está com o mouse em cima ou dedo segurando (momentâneo, some ao soltar).
function usePtpScale(nodeRef, targetScale) {
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // Konva desenha na ordem dos irmãos dentro do mesmo grupo — crescer
    // sozinho não basta, uma célula vizinha desenhada depois continua
    // cobrindo a que cresceu. moveToTop() traz pro topo da pilha só entre
    // os irmãos diretos (as outras células do mesmo lote, ou os outros
    // marcadores da mesma Layer), sem afetar lotes/pontos em outro lugar.
    if (targetScale > 1) {
      node.moveToTop();
      node.getLayer()?.batchDraw();
    }
    node.to({
      scaleX: targetScale,
      scaleY: targetScale,
      duration: PTP_HOVER_DURATION,
      easing: Konva.Easings.EaseOut,
    });
  }, [nodeRef, targetScale]);
}

function PointMarker({ point, size, mode, isSelected, isPickup, isDropoff, isHovered, isOccupied, isPreviewing, onSelect, onChange, onHoverEnter, onHoverLeave, onPressStart }) {
  const groupRef = useRef(null);
  const trRef = useRef(null);
  const editable = mode === 'edit';
  const gestureActive = usesHoverGesture(mode);

  useEffect(() => {
    if (editable && isSelected && trRef.current && groupRef.current) {
      trRef.current.nodes([groupRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [editable, isSelected]);

  usePtpScale(groupRef, gestureActive ? ptpTargetScale(isHovered, isPickup || isDropoff) : 1);

  const { fill, stroke } = markerColors(mode, { isSelected, isPickup, isDropoff });
  const xColor = occupiedColor(mode, null, { isSelected, isPickup, isDropoff });

  // Edição: clique seleciona na hora (comportamento de sempre). Ponto a
  // Ponto: seleção não acontece mais no clique — só ao soltar o
  // mouse/dedo, tratado no Stage (ver FloorPlanCanvas); aqui só o hover.
  function handleClick(e) {
    if (!editable) return;
    e.cancelBubble = true;
    onSelect(point.id);
  }

  return (
    <>
      <Group
        ref={groupRef}
        x={point.x}
        y={point.y}
        rotation={point.rotation}
        draggable={editable}
        onClick={handleClick}
        onTap={handleClick}
        onMouseEnter={gestureActive ? () => onHoverEnter(point.name) : undefined}
        onMouseLeave={gestureActive ? () => onHoverLeave(point.name) : undefined}
        onMouseDown={gestureActive ? () => onPressStart(point.name) : undefined}
        onTouchStart={gestureActive ? () => onPressStart(point.name) : undefined}
        onDragEnd={(e) => onChange(point.id, { x: e.target.x(), y: e.target.y() })}
        onTransformEnd={(e) => {
          const node = e.target;
          onChange(point.id, { x: node.x(), y: node.y(), rotation: node.rotation() });
        }}
      >
        <Rect
          x={-size / 2}
          y={-size / 2}
          width={size}
          height={size}
          cornerRadius={3}
          fill={fill}
          stroke={stroke}
          strokeWidth={2}
        />
        {isOccupied && <XMark size={size} color={xColor} outlineColor={stroke} opacity={isPreviewing ? 0.5 : 1} />}
        <Text
          text={point.name}
          fontFamily="ui-monospace, 'SF Mono', 'Cascadia Code', monospace"
          fontSize={12}
          fill={COLORS.textPrimary}
          align="center"
          width={size * 4}
          x={-size * 2}
          y={size / 2 + 6}
          rotation={-point.rotation}
          listening={false}
        />
      </Group>
      {editable && isSelected && (
        <Transformer
          ref={trRef}
          resizeEnabled={false}
          rotateEnabled={true}
          borderStroke={COLORS.accentAmber}
          anchorStroke={COLORS.accentAmber}
          anchorFill={COLORS.panelBase}
        />
      )}
    </>
  );
}

// Uma célula de lote — extraída em componente próprio (em vez de inline no
// .map() de LotMarker) porque precisa da sua própria ref+efeito pra animar o
// crescimento no modo Ponto a Ponto, e hooks não podem viver dentro de loop.
function LotCell({ name, index, cellSize, fill, stroke, xColor, showName, isOccupied, isPreviewing, lotRotation, lotScaleX, lotScaleY, gestureActive, isHovered, isSelectedEndpoint, onHoverEnter, onHoverLeave, onPressStart }) {
  const cellRef = useRef(null);
  usePtpScale(cellRef, gestureActive ? ptpTargetScale(isHovered, isSelectedEndpoint) : 1);

  return (
    <Group
      ref={cellRef}
      x={index * cellSize}
      y={0}
      onMouseEnter={gestureActive ? () => onHoverEnter(name) : undefined}
      onMouseLeave={gestureActive ? () => onHoverLeave(name) : undefined}
      onMouseDown={gestureActive ? () => onPressStart(name) : undefined}
      onTouchStart={gestureActive ? () => onPressStart(name) : undefined}
    >
      <Rect
        x={-cellSize / 2}
        y={-cellSize / 2}
        width={cellSize}
        height={cellSize}
        cornerRadius={3}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
      />
      {isOccupied && <XMark size={cellSize} color={xColor} outlineColor={stroke} opacity={isPreviewing ? 0.5 : 1} />}
      {showName && (
        <Text
          text={name}
          fontFamily="ui-monospace, 'SF Mono', 'Cascadia Code', monospace"
          fontSize={11}
          fill={COLORS.textPrimary}
          align="center"
          width={cellSize * 2}
          x={-cellSize}
          y={cellSize / 2 + 4}
          rotation={-lotRotation}
          scaleX={1 / lotScaleX}
          scaleY={1 / lotScaleY}
          listening={false}
        />
      )}
    </Group>
  );
}

// Lote: linha ou coluna de células grudadas (mesmo passo = cellSize), uma
// única unidade arrastável/rotacionável/redimensionável. Em Ponto a Ponto,
// cada célula tem sua própria animação de hover (ver LotCell) — a seleção em
// si acontece ao soltar o mouse/dedo, tratada no Stage.
function LotMarker({ lot, cellSize, mode, isSelected, pickupName, dropoffName, hoverName, occupiedNames, previewingNames, onSelectLot, onHoverEnter, onHoverLeave, onPressStart, onChange, isPreview }) {
  const groupRef = useRef(null);
  const trRef = useRef(null);
  const editable = mode === 'edit' && !isPreview;
  const gestureActive = usesHoverGesture(mode) && !isPreview;

  useEffect(() => {
    if (editable && isSelected && trRef.current && groupRef.current) {
      trRef.current.nodes([groupRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [editable, isSelected]);

  function handleLotClick(e) {
    e.cancelBubble = true;
    if (mode === 'edit' && !isPreview) onSelectLot(lot.id);
  }

  return (
    <>
      <Group
        ref={groupRef}
        x={lot.x}
        y={lot.y}
        rotation={lot.rotation}
        scaleX={lot.scaleX}
        scaleY={lot.scaleY}
        opacity={isPreview ? 0.55 : 1}
        draggable={editable}
        onClick={handleLotClick}
        onTap={handleLotClick}
        onDragEnd={(e) => onChange(lot.id, { x: e.target.x(), y: e.target.y() })}
        onTransformEnd={(e) => {
          const node = e.target;
          onChange(lot.id, {
            x: node.x(),
            y: node.y(),
            rotation: node.rotation(),
            scaleX: node.scaleX(),
            scaleY: node.scaleY(),
          });
        }}
      >
        {Array.from({ length: lot.count }).map((_, i) => {
          const name = lotCellName(lot.prefix, i);
          const isPickup = name === pickupName;
          const isDropoff = name === dropoffName;
          const { fill, stroke } = lotCellColors(mode, lot, { isSelected, isPickup, isDropoff });
          const xColor = occupiedColor(mode, lot, { isSelected, isPickup, isDropoff });
          return (
            <LotCell
              key={i}
              name={name}
              index={i}
              cellSize={cellSize}
              fill={fill}
              stroke={stroke}
              xColor={xColor}
              showName={lot.namesVisible || isPreview}
              isOccupied={occupiedNames.includes(name)}
              isPreviewing={!!previewingNames && previewingNames.has(name)}
              lotRotation={lot.rotation}
              lotScaleX={lot.scaleX}
              lotScaleY={lot.scaleY}
              gestureActive={gestureActive}
              isSelectedEndpoint={isPickup || isDropoff}
              isHovered={hoverName === name}
              onHoverEnter={onHoverEnter}
              onHoverLeave={onHoverLeave}
              onPressStart={onPressStart}
            />
          );
        })}
      </Group>
      {editable && isSelected && (
        <Transformer
          ref={trRef}
          resizeEnabled={true}
          rotateEnabled={true}
          keepRatio={false}
          borderStroke={COLORS.accentAmber}
          anchorStroke={COLORS.accentAmber}
          anchorFill={COLORS.panelBase}
        />
      )}
    </>
  );
}

export default function FloorPlanCanvas({
  points,
  lots,
  mode,
  addTool,
  pendingLotPrefix,
  onAddPoint,
  onAddLot,
  onUpdatePoint,
  onUpdateLot,
  selectedId,
  onSelectPoint,
  selectedLotId,
  onSelectLot,
  pickupName,
  dropoffName,
  onPointToPointClick,
  view,
  onToggleView,
  occupiedNames,
  onMarkOccupied,
  markModeActive,
  onToggleMarkMode,
  ptpModeActive,
  onTogglePtpMode,
}) {
  const containerRef = useRef(null);
  const { width: containerWidth, height: containerHeight } = useContainerSize(containerRef);
  const [image] = useImage(VIEW_URLS[view]);

  // Zoom/pan: o Stage cobre o container inteiro; scaleX/scaleY+x/y aplicam
  // zoom+pan a TODO o conteúdo (imagem e marcadores) de uma vez. Pontos/lotes
  // continuam guardados como fração [0,1] da imagem (não do stage), então
  // zoom/pan nunca precisa recalcular nada salvo — só a matemática de tela
  // pra converter clique↔fração muda.
  const [stageScale, setStageScale] = useState(0); // 0 = ainda não inicializado
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  // Guarda PRA QUAL vista o zoom/pan já foi centralizado — trocar de vista
  // (imagem diferente, dimensões diferentes) precisa reinicializar o
  // enquadramento, não só na primeira vez que a Stage aparece.
  const initializedForRef = useRef(null);

  const baseScale = image && containerWidth && containerHeight
    ? Math.min(containerWidth / image.width, containerHeight / image.height)
    : 0;

  useEffect(() => {
    if (!baseScale || initializedForRef.current === view) return;
    setStageScale(baseScale);
    setStagePos({
      x: (containerWidth - image.width * baseScale) / 2,
      y: (containerHeight - image.height * baseScale) / 2,
    });
    initializedForRef.current = view;
  }, [baseScale, containerWidth, containerHeight, image, view]);

  function clampScale(s) {
    const min = baseScale || 0.01;
    return Math.max(min, Math.min(s, min * MAX_ZOOM_MULT));
  }

  // lotDraftRef espelha lotDraft (estado, só pra re-renderizar o preview).
  // finishLotDrag lê do ref, não do state: precisa do valor mais recente de
  // forma síncrona (o listener de fallback no window guarda uma closure
  // antiga) e não pode chamar onAddLot de dentro de um updater funcional do
  // setState — o StrictMode invoca updaters duas vezes de propósito (pra
  // achar efeito colateral escondido), e onAddLot tem efeito colateral
  // (cria um lote novo a cada chamada) — foi isso que duplicava o lote.
  const [lotDraft, setLotDraft] = useState(null); // { anchorX, anchorY, rotation, count } em coordenadas de conteúdo (px da imagem)
  const lotDraftRef = useRef(null);

  function setDraft(next) {
    lotDraftRef.current = next;
    setLotDraft(next);
  }

  function finishLotDrag() {
    const draft = lotDraftRef.current;
    if (draft && image) {
      onAddLot({
        x: draft.anchorX / image.width,
        y: draft.anchorY / image.height,
        rotation: draft.rotation,
        count: draft.count,
        cellSize: DEFAULT_CELL_SIZE,
      });
    }
    setDraft(null);
  }

  // Ponto a Ponto e Marcação de ocupação: nome da célula "ativa" no momento
  // (mouse em cima, ou dedo segurando/deslizando). A ação de verdade só
  // acontece ao soltar (ver commitOnRelease) — nunca no toque/clique
  // inicial, pra evitar que o operador confirme sem querer no primeiro
  // toque errado.
  const [hoveredName, setHoveredName] = useState(null);

  // Marcação por arrasto (modo "mark"): em vez de precisar tocar quadrado a
  // quadrado, o operador pressiona e desliza o dedo/mouse por cima de
  // vários — cada um tocado durante o arrasto entra num CAMINHO ordenado
  // (paintPathRef, não um Set — a ordem importa, ver abaixo) e ganha uma
  // prévia visual (X translúcido, ver computeEffectiveOccupied/
  // computeChangingPreview). A AÇÃO (ocupar ou desocupar) é decidida uma
  // única vez, pelo estado do primeiro quadrado tocado no gesto (se tava
  // livre, o gesto inteiro marca; se já tava ocupado, o gesto inteiro
  // desmarca) — evita resultado ambíguo se o dedo passar por uma mistura de
  // ocupado/livre no caminho. Só ao soltar (commitOnRelease) tudo que ainda
  // está no caminho é aplicado de uma vez (onMarkOccupied, um único
  // setState em lote — ver setOccupiedMany).
  //
  // RETRAÇAR DESFAZ: se o dedo/mouse volta por cima de um quadrado que já
  // tava no caminho (sem soltar), tudo que foi tocado DEPOIS dele é
  // descartado — trunca o caminho de volta pra esse ponto. É o que permite
  // "desmarcar" a prévia sem soltar: arrastou de A até D (A,B,C,D no
  // caminho), voltou até B (o dedo passa por C de novo, mas indo pra trás)
  // → caminho vira [A,B], C e D saem da prévia. Índice 0 (o quadrado que
  // decidiu a ação) nunca sai assim — voltar até ele só encolhe o caminho
  // até ele, não some com ele.
  //
  // paintPathRef existe porque commitOnRelease precisa do valor mais
  // recente de forma síncrona (mesmo motivo do lotDraftRef, ver acima).
  const isPaintingRef = useRef(false);
  const paintTargetRef = useRef(null); // true=vai ocupar, false=vai desocupar, null=ainda não decidido
  const paintPathRef = useRef([]); // ordem de entrada, sem repetição — permite truncar ao retraçar
  const [paintPreview, setPaintPreview] = useState(new Set());
  const [paintTarget, setPaintTarget] = useState(null);
  // Espelha isPaintingRef só pra servir de dependência de efeito (fallback
  // de soltar fora do canvas, logo abaixo) — o ref sozinho não dispara
  // re-render/re-subscribe.
  const [isPaintingActive, setIsPaintingActive] = useState(false);

  // true se o Stage realmente chegou a se mover (pan) durante o gesto atual
  // — setado no onDragStart do Stage, resetado a cada novo mousedown. Usado
  // em commitOnRelease pra não confirmar uma seleção de Ponto a Ponto com
  // um hoveredName que pode estar desatualizado depois de um pan de
  // verdade (ver comentário lá).
  const wasPanningRef = useRef(false);

  function registerPaintTouch(name) {
    if (!isPaintingRef.current) return;
    const path = paintPathRef.current;
    if (path[path.length - 1] === name) return; // já é o topo do caminho, nada muda
    if (paintTargetRef.current === null) {
      const target = !occupiedNames.includes(name);
      paintTargetRef.current = target;
      setPaintTarget(target);
    }
    const idx = path.indexOf(name);
    paintPathRef.current = idx !== -1 ? path.slice(0, idx + 1) : [...path, name];
    setPaintPreview(new Set(paintPathRef.current));
  }

  function startPaintGesture() {
    isPaintingRef.current = true;
    setIsPaintingActive(true);
    paintTargetRef.current = null;
    paintPathRef.current = [];
    setPaintTarget(null);
    setPaintPreview(new Set());
  }

  function resetPaintGesture() {
    isPaintingRef.current = false;
    setIsPaintingActive(false);
    paintTargetRef.current = null;
    paintPathRef.current = [];
    setPaintTarget(null);
    setPaintPreview(new Set());
  }

  // Chamado no onMouseDown/onTouchStart de CADA marcador — dispara ANTES do
  // onMouseDown do Stage (bubbling filho->pai), e existe especificamente
  // pro touch: diferente do mouse (que já está "pairando" sobre o
  // quadrado antes de qualquer clique, então onMouseEnter sempre dispara
  // primeiro), um dedo simplesmente aparece em cima do quadrado — se o
  // toque não se move nem um pixel entre pousar e soltar, o Konva pode
  // nunca disparar o onMouseEnter sintético pra essa célula. Sem isso, um
  // toque parado (sem arrastar) não registrava nada — nem seleção de
  // Ponto a Ponto, nem início da pintura de ocupação. Usa `name` direto do
  // fechamento do marcador, não o estado `hoveredName` (que ainda não
  // teria atualizado a tempo, já que setState é assíncrono).
  function handleMarkerPressStart(name) {
    setHoveredName(name);
    if (mode === 'mark') {
      startPaintGesture();
      registerPaintTouch(name);
    }
  }

  function handleHoverEnter(name) {
    setHoveredName(name);
    if (mode === 'mark') registerPaintTouch(name);
  }
  function handleHoverLeave(name) {
    setHoveredName((h) => (h === name ? null : h));
  }

  function commitOnRelease() {
    finishLotDrag();
    if (mode === 'mark') {
      if (paintPathRef.current.length > 0 && paintTargetRef.current !== null) {
        onMarkOccupied(paintPathRef.current, paintTargetRef.current);
      }
      resetPaintGesture();
      setHoveredName(null);
      return;
    }
    // Um pan de verdade rolou nesse gesto (ver onDragStart/wasPanningRef) —
    // hoveredName pode estar sobrando de antes do arrasto começar (só é
    // limpo no onMouseLeave de um marcador, e o pan pode ter tirado o
    // ponteiro de cima de um sem passar por lá). Não confirma seleção de
    // Ponto a Ponto com um valor que pode não ser mais o que está embaixo
    // do dedo/mouse agora.
    if (wasPanningRef.current) {
      setHoveredName(null);
      return;
    }
    if (!hoveredName) return;
    if (mode === 'ptp') {
      onPointToPointClick(hoveredName);
      setHoveredName(null);
    }
  }

  // Fallback: se o usuário soltar o botão do mouse fora do canvas, o
  // onMouseUp do Stage nunca dispara — sem isso o arrasto ficaria "preso".
  useEffect(() => {
    if (!lotDraft) return;
    window.addEventListener('mouseup', finishLotDrag);
    window.addEventListener('touchend', finishLotDrag);
    return () => {
      window.removeEventListener('mouseup', finishLotDrag);
      window.removeEventListener('touchend', finishLotDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!lotDraft]);

  // Mesmo fallback acima, pro gesto de pintar arrastando (modo mark): se o
  // dedo/mouse soltar fora do canvas, o onMouseUp/onTouchEnd do Stage nunca
  // dispara — sem isso o "pincel" ficaria preso ligado, com a prévia presa
  // na tela. commitOnRelease aqui é o mesmo handler do soltar dentro do
  // canvas — aplica o que já foi tocado até então, exatamente como se
  // tivesse soltado em cima do último quadrado.
  useEffect(() => {
    if (!isPaintingActive) return;
    window.addEventListener('mouseup', commitOnRelease);
    window.addEventListener('touchend', commitOnRelease);
    return () => {
      window.removeEventListener('mouseup', commitOnRelease);
      window.removeEventListener('touchend', commitOnRelease);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaintingActive]);

  // Pointer de tela (relativo ao container) -> coordenadas de conteúdo (px
  // "reais" da imagem, antes de zoom/pan) — é nessa base que fração/cellSize
  // já operavam antes do zoom existir.
  function toContent(pos, stage) {
    return {
      x: (pos.x - stage.x()) / stage.scaleX(),
      y: (pos.y - stage.y()) / stage.scaleY(),
    };
  }

  function handleStageMouseDown(e) {
    wasPanningRef.current = false; // novo gesto começando — ver onDragStart do Stage
    const stage = e.target.getStage();
    const startedOnMarker = e.target !== stage;

    // Clicar e arrastar deve sempre poder mover o mapa (pan), em qualquer
    // modo — a Stage já é draggable por padrão agora (ver prop abaixo). A
    // ÚNICA exceção é o toque começar em cima de um ponto/célula nos modos
    // ptp/mark: aí arrastar É o gesto de selecionar rota ou pintar
    // ocupação (ver usesHoverGesture/registerPaintTouch), e os dois brigam
    // pelo mesmo gesto de arrasto se deixar os dois ativos — cancela o pan
    // nativo do Stage nesse caso específico, antes mesmo dele começar a se
    // mover (stopDrag chamado aqui, no mousedown, previne o pan no
    // mousemove seguinte). Se o toque começa em espaço vazio (mesmo em
    // ptp/mark), continua sendo pan normal — só conflita se realmente
    // começar em cima de um marcador.
    if (usesHoverGesture(mode) && startedOnMarker) {
      stage.stopDrag();
    }

    // O início do gesto de pintar arrastando (mode 'mark') já é tratado
    // direto no onMouseDown/onTouchStart de cada marcador
    // (handleMarkerPressStart, ver acima) — dispara antes deste handler
    // (bubbling filho->pai) e não depende do hover ter disparado primeiro.

    if (addTool === null) return; // sem ferramenta ativa: Stage.draggable cuida do pan (edição) ou nada (ponto a ponto)
    if (startedOnMarker) return; // clique caiu num marcador/lote, ele já tratou
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const pos = toContent(pointer, stage);
    if (mode === 'edit' && addTool === 'point' && image) {
      onAddPoint(pos.x / image.width, pos.y / image.height);
    } else if (mode === 'edit' && addTool === 'lot') {
      setDraft({ anchorX: pos.x, anchorY: pos.y, rotation: 0, count: 1 });
    }
  }

  function handleStageMouseMove(e) {
    const draft = lotDraftRef.current;
    if (!draft) return;
    const stage = e.target.getStage();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const pos = toContent(pointer, stage);
    const dx = pos.x - draft.anchorX;
    const dy = pos.y - draft.anchorY;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const dist = horizontal ? Math.abs(dx) : Math.abs(dy);
    const count = Math.max(1, Math.round(dist / DEFAULT_CELL_SIZE) + 1);
    const rotation = horizontal ? (dx >= 0 ? 0 : 180) : (dy >= 0 ? 90 : -90);
    setDraft({ ...draft, rotation, count });
  }

  function handleStageClick(e) {
    if (e.target !== e.target.getStage()) return; // clique num marcador, ele já tratou
    if (mode === 'edit' && addTool === null) {
      onSelectPoint(null);
      onSelectLot(null);
    }
  }

  // --- zoom: roda do mouse, centrado no cursor ------------------------------
  function handleWheel(e) {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const oldScale = stage.scaleX();
    const pointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const newScale = clampScale(direction > 0 ? oldScale / ZOOM_STEP : oldScale * ZOOM_STEP);
    setStageScale(newScale);
    setStagePos({
      x: pointer.x - pointTo.x * newScale,
      y: pointer.y - pointTo.y * newScale,
    });
  }

  // --- zoom: pinça de dois dedos no touch -----------------------------------
  const pinchRef = useRef({ dist: 0, center: null });
  // getBoundingClientRect é leitura de layout síncrona (força o navegador a
  // recalcular posição/tamanho na hora) — chamar isso a cada touchmove (que
  // dispara dezenas de vezes por segundo durante o pinça) é caro o
  // suficiente em tablets mais fracos pra derrubar o frame rate a ponto do
  // navegador começar a atrasar/agrupar os touchmove seguintes, o que dá
  // exatamente a sensação de "trava, precisa fazer o gesto de novo".
  // Cacheia uma vez por gesto (o container não se move/redimensiona no meio
  // de um pinça) em vez de recalcular a cada frame.
  const pinchRectRef = useRef(null);

  function touchPoint(touch, rect) {
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function handleTouchMove(e) {
    const touches = e.evt.touches;
    const stage = e.target.getStage();
    if (touches.length < 2) {
      handleStageMouseMove(e);
      return;
    }
    e.evt.preventDefault();
    if (stage.isDragging()) stage.stopDrag();
    if (!pinchRectRef.current) {
      pinchRectRef.current = stage.container().getBoundingClientRect();
    }
    const rect = pinchRectRef.current;
    const p1 = touchPoint(touches[0], rect);
    const p2 = touchPoint(touches[1], rect);
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    if (!pinchRef.current.center) {
      pinchRef.current = { dist, center };
      return;
    }
    const oldScale = stage.scaleX();
    const pointTo = {
      x: (center.x - stage.x()) / oldScale,
      y: (center.y - stage.y()) / oldScale,
    };
    const newScale = clampScale(oldScale * (dist / pinchRef.current.dist));
    setStageScale(newScale);
    setStagePos({
      x: center.x - pointTo.x * newScale,
      y: center.y - pointTo.y * newScale,
    });
    pinchRef.current = { dist, center };
  }

  function handleTouchEnd(e) {
    if (e.evt.touches.length < 2) {
      pinchRef.current = { dist: 0, center: null };
      pinchRectRef.current = null; // próximo pinça recalcula do zero
    }
    commitOnRelease();
  }

  // Ocupação "como vai ficar" já considerando o gesto de pintar em
  // andamento (ver registerPaintTouch) — os marcadores usam isso no lugar
  // de occupiedNames crua, então já mostram o resultado antes mesmo do
  // commit real acontecer ao soltar.
  const effectiveOccupied = computeEffectiveOccupied(occupiedNames, paintPreview, paintTarget);
  const previewingNames = computeChangingPreview(occupiedNames, paintPreview, paintTarget);

  return (
    <div
      ref={containerRef}
      className={'floorplan-container' + (addTool ? ' is-adding' : '')}
    >
      <button
        type="button"
        className="view-toggle"
        onClick={onToggleView}
        aria-label={view === 'top' ? 'Mudar pra visão isométrica' : 'Mudar pra vista de cima'}
        title={view === 'top' ? 'Ver isométrico' : 'Ver de cima'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <button
        type="button"
        className={'view-toggle mark-toggle' + (markModeActive ? ' is-active' : '')}
        onClick={onToggleMarkMode}
        aria-label={markModeActive ? 'Sair do modo de marcação de ocupação' : 'Entrar no modo de marcação de ocupação'}
        title="Marcar/desmarcar ocupação"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <button
        type="button"
        className={'view-toggle ptp-toggle' + (ptpModeActive ? ' is-active' : '')}
        onClick={onTogglePtpMode}
        aria-label={ptpModeActive ? 'Sair do modo Ponto a Ponto' : 'Entrar no modo Ponto a Ponto'}
        title="Ponto a Ponto"
      >
        <svg viewBox="0 0 109.69 122.88" fill="currentColor">
          <path fillRule="evenodd" clipRule="evenodd" d="M101.41,37.05c-1.95,2.14-4.22,4.05-6.77,5.6c-0.31,0.23-0.74,0.26-1.09,0.03c-3.76-2.39-6.93-5.27-9.41-8.4 c-3.43-4.3-5.59-9.07-6.33-13.66c-0.75-4.66-0.05-9.14,2.27-12.79C81,6.4,82.17,5.08,83.59,3.95c3.27-2.6,7-3.98,10.73-3.95 c3.58,0.03,7.12,1.36,10.18,4.15c1.08,0.98,1.98,2.09,2.72,3.31c2.49,4.11,3.03,9.34,1.93,14.65 C108.07,27.36,105.39,32.69,101.41,37.05L101.41,37.05L101.41,37.05z M9.82,64.7h8.72c1.45,0,2.57,0.36,3.35,1.08 c0.78,0.72,1.17,1.61,1.17,2.67c0,0.89-0.28,1.66-0.83,2.29c-0.37,0.43-0.91,0.76-1.62,1.01c1.08,0.26,1.88,0.7,2.39,1.34 c0.51,0.63,0.76,1.43,0.76,2.39c0,0.78-0.18,1.48-0.54,2.11c-0.36,0.62-0.86,1.12-1.49,1.48c-0.39,0.22-0.98,0.39-1.77,0.49 c-1.05,0.14-1.74,0.21-2.09,0.21H9.82V64.7L9.82,64.7z M14.51,70.62h2.03c0.73,0,1.23-0.13,1.52-0.38 c0.28-0.25,0.43-0.61,0.43-1.09c0-0.44-0.14-0.78-0.43-1.03c-0.28-0.25-0.78-0.37-1.49-0.37h-2.06V70.62L14.51,70.62z M14.51,76.53 h2.37c0.8,0,1.37-0.14,1.7-0.43c0.33-0.28,0.49-0.66,0.49-1.14c0-0.45-0.16-0.8-0.49-1.07c-0.33-0.27-0.9-0.41-1.71-0.41h-2.36 V76.53L14.51,76.53z M96.62,21.82h-5.27l-0.76,2.48h-4.75l5.67-15.07h5.1l5.65,15.07h-4.87L96.62,21.82L96.62,21.82z M95.64,18.56 l-1.64-5.41l-1.65,5.41H95.64L95.64,18.56z M23.88,92.06c-1.95,2.14-4.22,4.05-6.77,5.6c-0.31,0.23-0.74,0.26-1.09,0.03 c-3.76-2.4-6.93-5.27-9.41-8.4C3.19,85,1.03,80.23,0.29,75.63c-0.75-4.66-0.05-9.14,2.27-12.78c0.91-1.44,2.08-2.75,3.51-3.88 c3.27-2.6,7-3.98,10.72-3.95c3.58,0.03,7.12,1.36,10.18,4.15c1.08,0.98,1.98,2.09,2.72,3.31c2.49,4.11,3.03,9.34,1.93,14.65 C30.54,82.37,27.86,87.7,23.88,92.06L23.88,92.06L23.88,92.06z M17.07,103.04c4.51,0,8.32,3.02,9.52,7.14h59.97 c2.96,0,5.66-1.21,7.62-3.17c1.96-1.96,3.17-4.65,3.17-7.62l0,0c0-2.96-1.21-5.66-3.17-7.62c-1.96-1.96-4.65-3.17-7.62-3.17H65.58 v0c-4.71,0-8.99-1.92-12.09-5.02c-3.1-3.1-5.02-7.38-5.02-12.09l0,0c0-4.71,1.92-8.99,5.02-12.09c3.1-3.1,7.38-5.02,12.09-5.02 h18.97c1.3-3.96,5.03-6.82,9.42-6.82c5.48,0,9.92,4.44,9.92,9.92c0,5.48-4.44,9.92-9.92,9.92c-4.35,0-8.04-2.8-9.38-6.69H65.58 c-2.96,0-5.66,1.21-7.62,3.17c-1.96,1.96-3.17,4.65-3.17,7.62l0,0c0,2.96,1.21,5.66,3.17,7.62c1.94,1.94,4.61,3.15,7.55,3.17v0 h21.06c4.71,0,8.99,1.92,12.09,5.02c3.1,3.1,5.02,7.38,5.02,12.09l0,0c0,4.71-1.92,8.99-5.02,12.09c-3.1,3.1-7.38,5.02-12.09,5.02 H26.34c-1.43,3.73-5.04,6.37-9.27,6.37c-5.48,0-9.92-4.44-9.92-9.92C7.15,107.48,11.59,103.04,17.07,103.04L17.07,103.04z" />
        </svg>
      </button>
      {stageScale > 0 && image && (
        <Stage
          width={containerWidth}
          height={containerHeight}
          scaleX={stageScale}
          scaleY={stageScale}
          x={stagePos.x}
          y={stagePos.y}
          draggable={addTool === null}
          onDragStart={(e) => {
            if (e.target !== e.target.getStage()) return; // dragstart de um marcador (ex: mover ponto em edit), não é pan
            wasPanningRef.current = true;
          }}
          onDragEnd={(e) => {
            if (e.target !== e.target.getStage()) return; // dragend de um marcador borbulhou até aqui, não é pan
            setStagePos({ x: e.target.x(), y: e.target.y() });
          }}
          onWheel={handleWheel}
          onMouseDown={handleStageMouseDown}
          onMouseMove={handleStageMouseMove}
          onMouseUp={commitOnRelease}
          onClick={handleStageClick}
          onTap={handleStageClick}
          onTouchStart={handleStageMouseDown}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <Layer>
            <KonvaImage image={image} width={image.width} height={image.height} listening={false} />
          </Layer>
          <Layer>
            {lots.map((l) => (
              <LotMarker
                key={l.id}
                lot={{ ...l, x: l.x * image.width, y: l.y * image.height }}
                cellSize={l.cellSize || DEFAULT_CELL_SIZE}
                mode={mode}
                isSelected={l.id === selectedLotId}
                pickupName={pickupName}
                dropoffName={dropoffName}
                hoverName={hoveredName}
                occupiedNames={effectiveOccupied}
                previewingNames={previewingNames}
                onSelectLot={onSelectLot}
                onHoverEnter={handleHoverEnter}
                onHoverLeave={handleHoverLeave}
                onPressStart={handleMarkerPressStart}
                onChange={(id, patch) => {
                  const next = { ...patch };
                  if ('x' in next) next.x = next.x / image.width;
                  if ('y' in next) next.y = next.y / image.height;
                  onUpdateLot(id, next);
                }}
              />
            ))}
            {points.map((p) => (
              <PointMarker
                key={p.id}
                point={{ ...p, x: p.x * image.width, y: p.y * image.height }}
                size={DEFAULT_CELL_SIZE}
                mode={mode}
                isSelected={p.id === selectedId}
                isPickup={p.name === pickupName}
                isDropoff={p.name === dropoffName}
                isHovered={hoveredName === p.name}
                isOccupied={effectiveOccupied.includes(p.name)}
                isPreviewing={previewingNames.has(p.name)}
                onSelect={onSelectPoint}
                onHoverEnter={handleHoverEnter}
                onHoverLeave={handleHoverLeave}
                onPressStart={handleMarkerPressStart}
                onChange={(id, patch) => {
                  const next = { ...patch };
                  if ('x' in next) next.x = next.x / image.width;
                  if ('y' in next) next.y = next.y / image.height;
                  onUpdatePoint(id, next);
                }}
              />
            ))}
            {lotDraft && (
              <LotMarker
                lot={{
                  id: '__preview__',
                  prefix: pendingLotPrefix || '…',
                  x: lotDraft.anchorX,
                  y: lotDraft.anchorY,
                  rotation: lotDraft.rotation,
                  count: lotDraft.count,
                  scaleX: 1,
                  scaleY: 1,
                }}
                cellSize={DEFAULT_CELL_SIZE}
                mode={mode}
                isSelected={false}
                pickupName={null}
                dropoffName={null}
                hoverName={null}
                occupiedNames={occupiedNames}
                onSelectLot={() => {}}
                onHoverEnter={() => {}}
                onHoverLeave={() => {}}
                onChange={() => {}}
                isPreview
              />
            )}
          </Layer>
        </Stage>
      )}
    </div>
  );
}
