// Robô no mapa (pedido do usuário, 2026-10-28): conversão das coordenadas do
// mapa do robô (metros, /api/robot-pose e /api/route-graph) pra px de
// CONTEÚDO da planta (mesmo espaço dos marcadores do FloorPlanCanvas), e o
// status visual do ícone.
import { lotCellName } from './hooks/useCalibration';

const DEFAULT_CELL_SIZE = 11.97; // mesmo valor do FloorPlanCanvas

// Centro de cada ponto avulso / célula de lote calibrado na planta, por nome
// técnico, em px de conteúdo — mesma conta de contentPositionOf
// (FloorPlanCanvas): a célula i fica em (i * cellSize, 0) no referencial do
// lote, girado e esticado.
export function namedContentPositions(points, lots, width, height) {
  const out = {};
  for (const lot of lots) {
    const rad = ((lot.rotation || 0) * Math.PI) / 180;
    const cell = (lot.cellSize || DEFAULT_CELL_SIZE) * (lot.scaleX || 1);
    for (let i = 0; i < lot.count; i++) {
      out[lotCellName(lot.prefix, i)] = {
        x: lot.x * width + i * cell * Math.cos(rad),
        y: lot.y * height + i * cell * Math.sin(rad),
      };
    }
  }
  for (const p of points) out[p.name] = { x: p.x * width, y: p.y * height };
  return out;
}

function solve3(m, v) {
  const a = m.map((row, i) => [...row, v[i]]);
  for (let i = 0; i < 3; i++) {
    let k = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(a[r][i]) > Math.abs(a[k][i])) k = r;
    [a[i], a[k]] = [a[k], a[i]];
    if (Math.abs(a[i][i]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i];
      for (let c = i; c < 4; c++) a[r][c] -= f * a[i][c];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

// Afim por mínimos quadrados: mapa do robô (m) -> planta (px), a partir dos
// nomes que existem nos dois lados. Calibrado em 2026-10-28 com 237 pares:
// ~11,3 px/m, erro mediano ~7 px (o posicionamento manual das células) — o
// resto se acerta à mão arrastando o grafo no modo "Editar closes" (frame).
// { a, b, c, d, e, f }: u = a·x + b·y + c, v = d·x + e·y + f. null se não der.
export function fitMapToContent(mapPoints, named) {
  const pairs = [];
  for (const name of Object.keys(named)) {
    const p = mapPoints[name];
    if (p) pairs.push([p[0], p[1], named[name].x, named[name].y]);
  }
  if (pairs.length < 3) return null;
  const n = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bu = [0, 0, 0];
  const bv = [0, 0, 0];
  for (const [x, y, u, v] of pairs) {
    const r = [x, y, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) n[i][j] += r[i] * r[j];
      bu[i] += r[i] * u;
      bv[i] += r[i] * v;
    }
  }
  const cu = solve3(n, bu);
  const cv = solve3(n, bv);
  if (!cu || !cv) return null;
  return { a: cu[0], b: cu[1], c: cu[2], d: cv[0], e: cv[1], f: cv[2] };
}

export function mapToContent(t, x, y) {
  return { x: t.a * x + t.b * y + t.c, y: t.d * x + t.e * y + t.f };
}

// px de conteúdo por metro (média dos dois eixos — o ajuste deu ~igual).
export function contentPxPerMeter(t) {
  return Math.sqrt(Math.abs(t.a * t.e - t.b * t.d));
}

// Rotação (graus, sentido do Konva) do ícone pra uma pose. O ícone desenha
// os garfos apontando pra +x; no robô, os garfos ficam do lado OPOSTO ao
// theta da pose (medido em campo: encaixado no CAX ele está com theta ~0
// apontando pro H, e entrou de ré) — por isso o vetor é (-cos, -sin).
export function iconRotationDegrees(t, theta) {
  const dx = -Math.cos(theta);
  const dy = -Math.sin(theta);
  return (Math.atan2(t.d * dx + t.e * dy, t.a * dx + t.b * dy) * 180) / Math.PI;
}

// --- caminho planejado ------------------------------------------------------
// O dispatch não expõe o caminho da tarefa (só vai na ordem MQTT pro app do
// robô), então ele é recalculado aqui no mesmo grafo: caminho mais RÁPIDO,
// custo = comprimento / velocidade máxima de cada sentido (vem pronto do
// servidor em graph.links). Bateu exato com o globalPath real em 126 de 130
// ordens dos logs de campo — as outras 4 são empate/aresta sobreposta.
export function buildAdjacency(links) {
  const adj = new Map();
  const add = (a, b, cost) => {
    if (cost == null) return;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, cost]);
  };
  for (const [a, b, ab, ba] of links) {
    add(a, b, ab);
    add(b, a, ba);
  }
  return adj;
}

// Dijkstra com heap binário: lista de nomes de src até dst, ou null.
export function fastestPath(adj, src, dst) {
  if (src === dst) return [src];
  const dist = new Map([[src, 0]]);
  const prev = new Map();
  const heap = [[0, src]];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === dst) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const [v, w] of adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        push([nd, v]);
      }
    }
  }
  if (!dist.has(dst)) return null;
  const path = [dst];
  while (path[path.length - 1] !== src) path.push(prev.get(path[path.length - 1]));
  return path.reverse();
}

// Nós por onde a tarefa passa, na ordem: (início ->) H da coleta -> coleta
// (entra no lote) -> H da coleta (sai de ré) -> H da entrega -> entrega. Sem
// `pickup` (pallet já no garfo / devolução), só a parte da entrega. Ponto sem
// "H<nome>" no mapa (ex: energia) entra direto.
export function routeStops(points, { pickup, dropoff }, startNode) {
  const h = (n) => (points['H' + n] ? 'H' + n : n);
  const stops = [];
  if (startNode) stops.push(startNode);
  if (pickup) stops.push(h(pickup), pickup, h(pickup));
  if (dropoff) stops.push(h(dropoff), dropoff);
  return stops.filter((s, i) => s && points[s] && s !== stops[i - 1]);
}

// Encadeia o caminho mais rápido entre paradas consecutivas -> [[x, y], ...]
// em metros (mapa do robô). Perna sem caminho é pulada.
export function routePolyline(adj, points, stops) {
  const out = [];
  for (let i = 1; i < stops.length; i++) {
    const leg = fastestPath(adj, stops[i - 1], stops[i]);
    if (!leg) continue;
    for (const name of leg) {
      const p = points[name];
      const last = out[out.length - 1];
      if (p && !(last && last[0] === p[0] && last[1] === p[1])) out.push(p);
    }
  }
  return out;
}

export function nearestNode(points, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const name of Object.keys(points)) {
    const [px, py] = points[name];
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

// Status do ícone, em ordem de prioridade (o primeiro que valer ganha).
// Cores do brilho mais saturadas que as do tema de propósito: a planta é
// clara e o brilho no tom do tema se misturava com ela (pedido do usuário).
const GLOW = { red: '#ff1744', mint: '#00f5d4', yellow: '#ffd600', orange: '#ff4500', green: '#00e676' };
export const ROBOT_STATUS = {
  obstacle: { label: 'Obstáculo / robô parado', color: () => GLOW.red },
  planning: { label: 'Calculando rota', color: () => GLOW.mint },
  cancelling: { label: 'Indo cancelar a rota', color: () => GLOW.yellow },
  returningPallet: { label: 'Devolvendo pallet', color: () => GLOW.yellow },
  returning: { label: 'Voltando para energia', color: () => GLOW.orange },
  charging: { label: 'Carregando', color: () => GLOW.green },
  operating: { label: 'Em operação', color: () => GLOW.mint },
  idle: { label: 'Parado', color: () => null },
};

export function robotStatusOf({ robotStalledMessage, routePlanningMessage, cancelPending, postPickupUnloadMessage, robotReturningToCharge, robotCharging, currentRoute }) {
  if (robotStalledMessage) return 'obstacle';
  if (routePlanningMessage) return 'planning';
  if (cancelPending) return 'cancelling';
  if (postPickupUnloadMessage) return 'returningPallet';
  if (robotReturningToCharge) return 'returning';
  if (robotCharging) return 'charging';
  if (currentRoute && currentRoute.taskName) return 'operating';
  return 'idle';
}
