import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Group, Image as KonvaImage, Shape, Circle, Rect, Path, Line, Transformer } from 'react-konva';
import useImage from 'use-image';
import Konva from 'konva';
import { COLORS } from '../theme';
import {
  namedContentPositions, fitMapToContent, mapToContent, contentPxPerMeter, iconRotationDegrees, ROBOT_STATUS,
  buildAdjacency, routeStops, routePolyline, nearestNode, validRobotFrame,
  warpPoint, unwarpPoint, warpRotationDelta, WARP_MAX_SHIFT,
} from '../robotMap';
import emptyUrl from '../assets/robot-empty.webp';
import blueUrl from '../assets/robot-blue.webp';
import woodUrl from '../assets/robot-wood.webp';
import emptyGlowUrl from '../assets/robot-empty-glow.webp';
import blueGlowUrl from '../assets/robot-blue-glow.webp';
import woodGlowUrl from '../assets/robot-wood-glow.webp';

// Robô ao vivo no mapa (pedido do usuário, 2026-10-28). Tudo que muda a cada
// segundo (posição/ângulo) é feito IMPERATIVO direto nos nós do Konva, numa
// Layer só dele — nunca passa por estado React, então a pose não re-renderiza
// o FloorPlanCanvas nem o resto do app, e mover o robô redesenha só esta
// Layer (a planta e as ~218 células ficam quietas).
//
// Ícones (vista de cima, gerados a partir dos renders do usuário): mesmo
// quadro e mesma escala nos três, fundo transparente, ~5-7 KB cada. O ponto
// de giro (ICON.pivot) é o centro do pallet nos garfos — que é também o ponto
// que a pose do robô descreve (medido em campo em 2026-10-27: encaixado, a
// pose fica a 0-7 cm do ponto do pallet), então o ícone não "balança" nos
// giros. O brilho é uma máscara já desfocada (gerada offline, sem blur em
// tempo real) pintada na cor do status uma vez por troca de status.
const ICON = { width: 336, height: 212, pivotX: 227.7, pivotY: 106, robotLengthPx: 255, centerX: 167.5 };
const TAP_SLOP_PX = 12; // dedo que mexeu até isso entre pousar e soltar ainda é toque, não arrasto
const ROBOT_ICON_LENGTH_M = 2.0; // comprimento desenhado do robô (traseira -> ponta dos garfos)
const POSE_POLL_MS = 1000;
const ROUTE_GRAPH_RETRY_MS = 30000;
const SNAP_DISTANCE_M = 3; // salto maior que isso (relocalização) não anima, só pula
const STALE_OPACITY = 0.45; // servidor sem conseguir ler a pose: mostra a última, apagada
// Rota planejada (pedido do usuário, 2026-10-28): faixa larga mint escura
// semitransparente + traço mint claro por cima, em px de conteúdo (engrossa
// junto com o zoom, como uma pista).
const ROUTE_OUTER = { color: '#0f766e', width: 7, opacity: 0.7 };
const ROUTE_INNER = { color: '#5eead4', width: 2.6 };
const ROUTE_PROGRESS_LOOKAHEAD = 12; // segmentos à frente procurados pra achar onde o robô está na rota
// Setas circulares (aviso "calculando rota"): ícone refresh-cw (24x24, traço).
const ARROWS_PATH = 'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15';

// Máscara branca do brilho -> mesma máscara na cor do status (canvas pronto
// pra virar KonvaImage). Recalcula só quando o ícone ou a cor mudam.
function useTintedGlow(glowImage, color) {
  return useMemo(() => {
    if (!glowImage || !color) return null;
    const canvas = document.createElement('canvas');
    canvas.width = glowImage.width;
    canvas.height = glowImage.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(glowImage, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }, [glowImage, color]);
}

function shortestRotation(from, to) {
  return from + ((((to - from) % 360) + 540) % 360) - 180;
}

// `route`: { id, pickup, dropoff, live } — tarefa cujo caminho aparece no
// mapa (a atual, ou a clicada na Fila/Histórico); `live` = é a que o robô
// está fazendo agora: começa na posição dele e vai encolhendo enquanto anda.
// `editable` + `graphTool`: 'frame' = caixa pra mover/esticar/girar o grafo
// inteiro; 'warp' = deformação livre (arrasta um trecho, a vizinhança até
// `warpRadiusM` metros vai junto). `warp` = pinos salvos (ver robotMap.js).
// `routeOpacity`: multiplicador (0,1-1) da opacidade da rota desenhada.
function RobotOverlay({
  image, points, lots, frame, warp, routeOpacity = 1, showRoutePreview = false, editable, graphTool = 'frame', warpRadiusM = 8, interactive, status, carrying, route, bounceId,
  onFrameChange, onWarpChange, onRobotClick, onPoseRef,
}) {
  const [graph, setGraph] = useState(null);
  const routeRef = useRef(null);
  const trRef = useRef(null);
  const frameRef = useRef(null);
  const robotRef = useRef(null);
  const bodyRef = useRef(null);
  const sonarRef = useRef(null);
  const arrowsRef = useRef(null);
  const tweenRef = useRef(null);
  const lastPoseRef = useRef(null);

  const [emptyImg] = useImage(emptyUrl);
  const [blueImg] = useImage(blueUrl);
  const [woodImg] = useImage(woodUrl);
  const [emptyGlow] = useImage(emptyGlowUrl);
  const [blueGlow] = useImage(blueGlowUrl);
  const [woodGlow] = useImage(woodGlowUrl);
  const iconImg = carrying === 'blue' ? blueImg : carrying === 'wood' ? woodImg : emptyImg;
  const glowMask = carrying === 'blue' ? blueGlow : carrying === 'wood' ? woodGlow : emptyGlow;
  const glow = useTintedGlow(glowMask, ROBOT_STATUS[status]?.color());

  // Grafo + pontos do dispatch: uma vez (o servidor ainda guarda em cache).
  useEffect(() => {
    let stopped = false;
    let timer;
    function load() {
      fetch('/api/route-graph')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
        .then((data) => { if (!stopped) setGraph(data); })
        .catch(() => { if (!stopped) timer = setTimeout(load, ROUTE_GRAPH_RETRY_MS); });
    }
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  const transform = useMemo(() => {
    if (!graph || !image) return null;
    return fitMapToContent(graph.points, namedContentPositions(points, lots, image.width, image.height));
  }, [graph, image, points, lots]);

  const pxPerMeter = transform ? contentPxPerMeter(transform) : 0;
  const lengthPx = ROBOT_ICON_LENGTH_M * pxPerMeter;
  const iconScale = lengthPx / ICON.robotLengthPx;

  // Deformação livre: tudo que vai do mapa do robô pra planta passa por aqui
  // (grafo, rota, robô). pinsRef = os pinos salvos, ou salvos + o arrasto em
  // andamento (prévia) -- lido pelo desenho do grafo e pelo loop da pose.
  const pins = useMemo(() => warp || [], [warp]);
  const pinsRef = useRef(pins);
  const warpDragRef = useRef(null);
  if (!warpDragRef.current) pinsRef.current = pins;
  function toLocal(x, y) {
    const p = mapToContent(transform, x, y);
    return pinsRef.current.length ? warpPoint(pinsRef.current, p.x, p.y) : p;
  }

  // Segmentos do grafo em px de conteúdo SEM deformação (a deformação é
  // aplicada no desenho, pra prévia do arrasto não recalcular memo nenhum) —
  // num Shape só (um path), não 558 Lines. Só existe no modo "Editar closes".
  // `box` é o retângulo que contém o grafo já deformado: o Konva não sabe o
  // tamanho de um Shape com sceneFunc próprio, e sem ele a caixa do
  // Transformer nascia com tamanho zero no canto da planta (qualquer puxão
  // virava escala absurda).
  const segments = useMemo(() => {
    if (!editable || !graph || !transform || !graph.edges.length) return null;
    const data = new Float32Array(graph.edges.length * 4);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    graph.edges.forEach(([x1, y1, x2, y2], i) => {
      const p = mapToContent(transform, x1, y1);
      const q = mapToContent(transform, x2, y2);
      data.set([p.x, p.y, q.x, q.y], i * 4);
      const pw = warpPoint(pins, p.x, p.y);
      const qw = warpPoint(pins, q.x, q.y);
      minX = Math.min(minX, pw.x, qw.x);
      minY = Math.min(minY, pw.y, qw.y);
      maxX = Math.max(maxX, pw.x, qw.x);
      maxY = Math.max(maxY, pw.y, qw.y);
    });
    return { data, box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
  }, [editable, graph, transform, pins]);

  // --- rota planejada ------------------------------------------------------
  const adjacency = useMemo(() => (graph?.links ? buildAdjacency(graph.links) : null), [graph]);
  // Mexendo no slider de opacidade sem nenhuma rota na tela: uma rota de
  // exemplo entre dois lotes distantes, só enquanto mexe (`showRoutePreview`)
  // -- fixa na tela ela parecia uma rota "fantasma" de verdade.
  const previewRoute = useMemo(() => {
    if (!showRoutePreview || !graph) return null;
    const lotsWithH = Object.keys(graph.points).filter((n) => graph.points['H' + n]);
    if (lotsWithH.length < 2) return null;
    const [ax, ay] = graph.points[lotsWithH[0]];
    const far = lotsWithH.reduce((best, n) => {
      const [x, y] = graph.points[n];
      const d = (x - ax) ** 2 + (y - ay) ** 2;
      return d > best.d ? { n, d } : best;
    }, { n: null, d: -1 }).n;
    return { id: 'preview', pickup: lotsWithH[0], dropoff: far, live: false };
  }, [showRoutePreview, graph]);
  route = route || previewRoute;
  // Ponto de partida da rota ao vivo: o nó do grafo mais perto do robô no
  // momento em que a tarefa (ou a fase dela: antes/depois da coleta) apareceu.
  const [liveStart, setLiveStart] = useState(null); // { key, node }
  const routeKey = route ? route.id + '|' + (route.pickup || '') + '|' + route.dropoff : null;
  // o loop da pose roda numa closure antiga: lê o que muda por estes refs
  const liveKeyRef = useRef(null);
  liveKeyRef.current = route?.live ? routeKey : null;
  const liveStartKeyRef = useRef(null);
  const graphRef = useRef(null);
  graphRef.current = graph;
  const trimRouteRef = useRef(null);
  const routePoints = useMemo(() => {
    if (!route || !adjacency || !graph || !transform) return null;
    const start = route.live ? (liveStart?.key === routeKey ? liveStart.node : undefined) : null;
    if (start === undefined) return null; // ao vivo, esperando a 1ª pose pra saber de onde sai
    const poly = routePolyline(adjacency, graph.points, routeStops(graph.points, route, start));
    if (poly.length < 2) return null;
    return poly.flatMap(([x, y]) => {
      const p = mapToContent(transform, x, y);
      const w = warpPoint(pins, p.x, p.y);
      return [w.x, w.y];
    });
  }, [route, routeKey, adjacency, graph, transform, liveStart, pins]);
  const routeOuterRef = useRef(null);
  const routeInnerRef = useRef(null);
  // -1 = ainda não sabe onde o robô está nesta rota (procura na rota toda).
  const routeProgressRef = useRef(-1);
  useEffect(() => { routeProgressRef.current = -1; }, [routePoints]);

  // Rota ao vivo: o traço começa no robô e descarta o que ele já passou.
  // Avança só pra frente (a rota vai e volta no mesmo trecho ao entrar/sair
  // do lote — procurar o mais perto na rota toda pularia de volta). Só a 1ª
  // leitura depois da rota ser (re)calculada procura na rota toda: ela pode
  // ser recalculada no meio do caminho (mesma tarefa, ponto de partida do
  // início dela) e procurar só 12 trechos à frente do começo desenhava a
  // rota voltando até o início, por cima dela mesma.
  function trimRouteTo(pos) {
    const pts = routePoints;
    const outer = routeOuterRef.current;
    if (!pts || !outer || !route?.live) return;
    const n = pts.length / 2;
    const from = Math.max(0, routeProgressRef.current);
    const to = routeProgressRef.current < 0 ? n - 1 : Math.min(n - 1, from + ROUTE_PROGRESS_LOOKAHEAD);
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < to; i++) {
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * i + 2], by = pts[2 * i + 3];
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((pos.x - ax) * (bx - ax) + (pos.y - ay) * (by - ay)) / len2));
      const d = (pos.x - ax - t * (bx - ax)) ** 2 + (pos.y - ay - t * (by - ay)) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    routeProgressRef.current = best;
    const trimmed = [pos.x, pos.y, ...pts.slice(2 * best + 2)];
    outer.points(trimmed);
    routeInnerRef.current?.points(trimmed);
  }
  trimRouteRef.current = trimRouteTo;

  useEffect(() => {
    if (editable && segments && graphTool === 'frame' && trRef.current && routeRef.current) {
      trRef.current.nodes([routeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [editable, segments, graphTool]);

  // Posição do robô em px de conteúdo do Stage (já com o ajuste fino do frame).
  function contentPosition() {
    const robot = robotRef.current;
    const fr = frameRef.current;
    if (!robot || !fr || !robot.visible()) return null;
    return fr.getTransform().point({ x: robot.x(), y: robot.y() });
  }

  // --- pose ao vivo ---------------------------------------------------------
  useEffect(() => {
    if (!transform) return undefined;
    let stopped = false;
    let timer;
    function apply(pose) {
      const robot = robotRef.current;
      if (!robot) return;
      const base = mapToContent(transform, pose.x, pose.y);
      const pos = toLocal(pose.x, pose.y);
      const baseRot = iconRotationDegrees(transform, pose.theta);
      const rot = baseRot + warpRotationDelta(pinsRef.current, base.x, base.y, baseRot);
      robot.opacity(pose.ok ? 1 : STALE_OPACITY);
      const last = lastPoseRef.current;
      lastPoseRef.current = pose;
      tweenRef.current?.destroy();
      tweenRef.current = null;
      if (!robot.visible() || !last || Math.hypot(pose.x - last.x, pose.y - last.y) > SNAP_DISTANCE_M) {
        robot.setAttrs({ x: pos.x, y: pos.y, rotation: rot, visible: true });
        robot.getLayer()?.batchDraw();
      } else {
        const target = shortestRotation(robot.rotation(), rot);
        const moved = Math.hypot(pos.x - robot.x(), pos.y - robot.y()) > 0.02 || Math.abs(target - robot.rotation()) > 0.2;
        if (moved) {
          // Desliza até a pose nova no mesmo tempo que falta pra próxima: o
          // movimento parece contínuo com 1 leitura/s. Parado = nada redesenha.
          tweenRef.current = new Konva.Tween({
            node: robot, duration: POSE_POLL_MS / 1000, x: pos.x, y: pos.y, rotation: target, easing: Konva.Easings.Linear,
          });
          tweenRef.current.play();
        } else {
          robot.getLayer()?.batchDraw();
        }
      }
      // rota ao vivo nova (ou fase nova): parte do nó mais perto do robô agora.
      // Sem rota ao vivo, esquece a última -- a próxima volta pra energia tem
      // a mesma chave e precisa de um ponto de partida novo.
      if (!liveKeyRef.current) liveStartKeyRef.current = null;
      if (liveKeyRef.current && liveStartKeyRef.current !== liveKeyRef.current && graphRef.current) {
        liveStartKeyRef.current = liveKeyRef.current;
        setLiveStart({ key: liveKeyRef.current, node: nearestNode(graphRef.current.points, pose.x, pose.y) });
      }
      trimRouteRef.current?.(pos);
      const fr = frameRef.current;
      if (fr) onPoseRef?.current?.(fr.getTransform().point(pos));
    }
    function tick() {
      const next = () => { if (!stopped) timer = setTimeout(tick, POSE_POLL_MS); };
      if (document.hidden) { next(); return; } // aba escondida: não pergunta nada
      fetch('/api/robot-pose')
        .then((res) => (res.ok ? res.json() : null))
        .then((pose) => { if (!stopped && pose && Number.isFinite(pose.x)) apply(pose); })
        .catch(() => {})
        .finally(next);
    }
    lastPoseRef.current = null;
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      tweenRef.current?.destroy();
      tweenRef.current = null;
    };
  }, [transform, onPoseRef]);

  // --- animações de status: só rodam enquanto o status vale ----------------
  useEffect(() => {
    const sonar = sonarRef.current;
    const arrows = arrowsRef.current;
    if (!sonar || !arrows || !lengthPx) return undefined;
    let anim = null;
    if (status === 'obstacle') {
      const rings = sonar.getChildren();
      anim = new Konva.Animation((frameInfo) => {
        rings.forEach((ring, i) => {
          const phase = ((frameInfo.time / 1400) + i / rings.length) % 1;
          ring.radius(lengthPx * (0.45 + phase * 0.9));
          ring.opacity(0.85 * (1 - phase));
        });
      }, sonar.getLayer());
    } else if (status === 'planning') {
      anim = new Konva.Animation((frameInfo) => {
        arrows.rotation((frameInfo.time * 0.12) % 360);
      }, arrows.getLayer());
    }
    anim?.start();
    return () => anim?.stop();
  }, [status, lengthPx]);

  function bounce() {
    const body = bodyRef.current;
    if (!body) return;
    body.to({
      scaleX: iconScale * 1.35, scaleY: iconScale * 1.35, duration: 0.12,
      onFinish: () => body.to({ scaleX: iconScale, scaleY: iconScale, duration: 0.6, easing: Konva.Easings.ElasticEaseOut }),
    });
  }
  // Toque no painel "ROBÔ: ..." do header (ver FloorPlanCanvas): mesmo bounce.
  useEffect(() => {
    if (bounceId) bounce();
  }, [bounceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toque = pousou e soltou no robô sem arrastar. Não usa o `click` do Konva:
  // o Stage é arrastável e um dedo que mexe 1-2 px vira arrasto, que engole o
  // click (mesmo motivo do onPressStart das células).
  const pressRef = useRef(null);
  function handlePress(e) {
    pressRef.current = e.target.getStage().getPointerPosition();
  }
  function handleRelease(e) {
    const start = pressRef.current;
    pressRef.current = null;
    const end = e.target.getStage().getPointerPosition();
    if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) > TAP_SLOP_PX) return;
    e.cancelBubble = true;
    bounce();
    const pos = contentPosition();
    if (pos) onRobotClick?.(pos);
  }
  function setCursor(e, cursor) {
    const container = e.target.getStage()?.container();
    if (container) container.style.cursor = cursor;
  }

  // Ajuste fino do grafo (Editar closes): o robô segue o mesmo frame ao vivo
  // enquanto arrasta, e o valor final vai pra calibração.
  function syncFrame() {
    const r = routeRef.current;
    if (r && frameRef.current) {
      frameRef.current.setAttrs({ x: r.x(), y: r.y(), scaleX: r.scaleX(), scaleY: r.scaleY(), rotation: r.rotation() });
    }
  }
  function commitFrame(e) {
    const r = routeRef.current;
    if (!r || (e && e.target !== r && e.type === 'dragend')) return; // dragend do pegador da deformação sobe até aqui
    const next = validRobotFrame({ x: r.x(), y: r.y(), scaleX: r.scaleX(), scaleY: r.scaleY(), rotation: r.rotation() });
    if (next) {
      onFrameChange?.(next);
      return;
    }
    // passou do limite: volta pro último ajuste bom em vez de salvar lixo
    r.setAttrs(fr);
    syncFrame();
    r.getLayer()?.batchDraw();
  }

  // Deformação livre: o pegador (Rect arrastável do tamanho do grafo) não
  // anda -- o arrasto só serve pra ler o dedo. Âncora = o ponto SEM
  // deformação que está debaixo do dedo agora; o pino leva ele até o dedo.
  const warpCursorRef = useRef(null);
  const warpRadiusPx = warpRadiusM * pxPerMeter;
  function placeWarpCursor(at) {
    const c = warpCursorRef.current;
    if (!c) return;
    c.setAttrs(at ? { x: at.x, y: at.y, visible: true } : { visible: false });
    c.getLayer()?.batchDraw();
  }
  function handleWarpHover() {
    if (!warpDragRef.current) placeWarpCursor(routeRef.current?.getRelativePointerPosition());
  }
  function handleWarpDragStart(e) {
    const start = routeRef.current.getRelativePointerPosition();
    const anchor = unwarpPoint(pins, start.x, start.y);
    warpDragRef.current = { start, anchor, rect: { x: e.target.x(), y: e.target.y() }, pin: null };
  }
  function handleWarpDragMove(e) {
    const drag = warpDragRef.current;
    if (!drag) return;
    e.target.position(drag.rect);
    const cur = routeRef.current.getRelativePointerPosition();
    let dx = cur.x - drag.start.x;
    let dy = cur.y - drag.start.y;
    const max = warpRadiusPx * WARP_MAX_SHIFT;
    const len = Math.hypot(dx, dy);
    if (len > max) {
      dx *= max / len;
      dy *= max / len;
    }
    drag.pin = { x: drag.anchor.x, y: drag.anchor.y, dx, dy, r: warpRadiusPx };
    pinsRef.current = [...pins, drag.pin];
    placeWarpCursor({ x: drag.start.x + dx, y: drag.start.y + dy });
  }
  function handleWarpDragEnd(e) {
    const drag = warpDragRef.current;
    warpDragRef.current = null;
    e.target.position(drag?.rect || e.target.position());
    pinsRef.current = pins;
    if (drag?.pin && Math.hypot(drag.pin.dx, drag.pin.dy) >= 0.5) onWarpChange?.([...pins, drag.pin]);
    else e.target.getLayer()?.batchDraw();
  }

  if (!transform) return null;
  const fr = validRobotFrame(frame) || { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  const statusColor = ROBOT_STATUS[status]?.color() || COLORS.accentCyan;
  const offsetToCenter = (ICON.centerX - ICON.pivotX) * iconScale; // centro geométrico do robô, no eixo dele

  return (
    <Layer>
      {editable && segments && (
        <>
          <Group
            ref={routeRef}
            {...fr}
            draggable={graphTool === 'frame'}
            onDragMove={(e) => { if (e.target === routeRef.current) syncFrame(); }}
            onTransform={syncFrame}
            onDragEnd={commitFrame}
            onTransformEnd={commitFrame}
          >
            {graphTool === 'warp' ? (
              // pegador da deformação: cobre o grafo + um raio de folga
              <Rect
                x={segments.box.x - warpRadiusPx}
                y={segments.box.y - warpRadiusPx}
                width={segments.box.width + 2 * warpRadiusPx}
                height={segments.box.height + 2 * warpRadiusPx}
                fill="transparent"
                draggable
                onMouseMove={handleWarpHover}
                onMouseLeave={() => placeWarpCursor(null)}
                onDragStart={handleWarpDragStart}
                onDragMove={handleWarpDragMove}
                onDragEnd={handleWarpDragEnd}
              />
            ) : (
              // área de pegar: o grafo inteiro arrasta por qualquer ponto da caixa, não só pelas linhas
              <Rect {...segments.box} fill="transparent" />
            )}
            <Shape
              {...segments.box}
              listening={false}
              sceneFunc={(ctx, shape) => {
                const { data, box } = segments;
                const live = pinsRef.current;
                ctx.beginPath();
                for (let i = 0; i < data.length; i += 4) {
                  const p = live.length ? warpPoint(live, data[i], data[i + 1]) : { x: data[i], y: data[i + 1] };
                  const q = live.length ? warpPoint(live, data[i + 2], data[i + 3]) : { x: data[i + 2], y: data[i + 3] };
                  ctx.moveTo(p.x - box.x, p.y - box.y);
                  ctx.lineTo(q.x - box.x, q.y - box.y);
                }
                ctx.strokeShape(shape);
              }}
              stroke={COLORS.accentCyan}
              strokeWidth={1.5}
              strokeScaleEnabled={false}
              opacity={0.85}
            />
            {graphTool === 'warp' && (
              <Circle
                ref={warpCursorRef}
                radius={warpRadiusPx}
                visible={false}
                listening={false}
                stroke={COLORS.accentAmber}
                strokeWidth={1.5}
                strokeScaleEnabled={false}
                dash={[6, 4]}
                fill="rgba(245, 158, 11, 0.08)"
              />
            )}
          </Group>
          {graphTool === 'frame' && (
            <Transformer
              ref={trRef}
              rotateEnabled
              keepRatio={false}
              flipEnabled={false}
              ignoreStroke
              boundBoxFunc={(oldBox, newBox) => (newBox.width < 40 || newBox.height < 40 ? oldBox : newBox)}
              borderStroke={COLORS.accentAmber}
              anchorStroke={COLORS.accentAmber}
              anchorFill={COLORS.panelBase}
            />
          )}
        </>
      )}
      <Group ref={frameRef} {...fr} listening={interactive}>
        {routePoints && (
          <>
            <Line
              ref={routeOuterRef}
              points={routePoints}
              stroke={ROUTE_OUTER.color}
              strokeWidth={ROUTE_OUTER.width}
              opacity={ROUTE_OUTER.opacity * routeOpacity}
              lineCap="round"
              lineJoin="round"
              listening={false}
              perfectDrawEnabled={false}
            />
            <Line
              ref={routeInnerRef}
              points={routePoints}
              stroke={ROUTE_INNER.color}
              strokeWidth={ROUTE_INNER.width}
              opacity={routeOpacity}
              lineCap="round"
              lineJoin="round"
              listening={false}
              perfectDrawEnabled={false}
            />
          </>
        )}
        <Group ref={robotRef} visible={false}>
          <Group x={offsetToCenter} listening={false}>
            <Group ref={sonarRef} visible={status === 'obstacle'}>
              {[0, 1].map((i) => (
                <Circle key={i} radius={lengthPx * 0.5} stroke={ROBOT_STATUS.obstacle.color()} strokeWidth={2.5} strokeScaleEnabled={false} opacity={0} />
              ))}
            </Group>
            <Path
              ref={arrowsRef}
              visible={status === 'planning'}
              data={ARROWS_PATH}
              offsetX={12}
              offsetY={12}
              scaleX={(lengthPx * 0.8) / 11}
              scaleY={(lengthPx * 0.8) / 11}
              stroke={statusColor}
              strokeWidth={2.2}
              lineCap="round"
              lineJoin="round"
            />
          </Group>
          <Group ref={bodyRef} scaleX={iconScale} scaleY={iconScale}>
            {glow && <KonvaImage image={glow} offsetX={ICON.pivotX} offsetY={ICON.pivotY} listening={false} />}
            {iconImg && <KonvaImage image={iconImg} offsetX={ICON.pivotX} offsetY={ICON.pivotY} listening={false} />}
            {/* Área de toque: o quadro inteiro do ícone (robô + folga do
                brilho) — em escala real o robô fica pequeno na tela. */}
            <Rect
              x={-ICON.pivotX}
              y={-ICON.pivotY}
              width={ICON.width}
              height={ICON.height}
              fill="transparent"
              onMouseDown={handlePress}
              onTouchStart={handlePress}
              onMouseUp={handleRelease}
              onTouchEnd={handleRelease}
              onMouseEnter={(e) => setCursor(e, 'pointer')}
              onMouseLeave={(e) => setCursor(e, '')}
            />
          </Group>
        </Group>
      </Group>
    </Layer>
  );
}

export default memo(RobotOverlay);
