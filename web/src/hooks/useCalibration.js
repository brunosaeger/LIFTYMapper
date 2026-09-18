import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCalibration, saveCalibration, savePalletHeights as savePalletHeightsApi } from '../api/lifty';
import { generateId } from '../utils';

const EMPTY_VIEW_DATA = { points: [], lots: [], closeUps: [] };
// "Altura de pallets" (sub-seção do editor). blueBase = andar de baixo do
// pallet azul (o valor que o azul já recebia, 8); blueTop = 2º andar do
// "pallet de cima" (sem padrão de fábrica — persiste o último salvo).
// Madeira não empilha, não usa nada disso.
const DEFAULT_PALLET_HEIGHTS = { blueBase: 8, blueTop: 8 };

function normalizePalletHeights(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : d);
  return {
    blueBase: num(r.blueBase, DEFAULT_PALLET_HEIGHTS.blueBase),
    blueTop: num(r.blueTop, DEFAULT_PALLET_HEIGHTS.blueTop),
  };
}

function normalizeView(raw) {
  if (raw && Array.isArray(raw.points) && Array.isArray(raw.lots)) {
    // closeUps é campo novo (ver "Close Up") — calibration.json salvo antes
    // dele existir não tem a chave, cai no fallback [] abaixo.
    return { points: raw.points, lots: raw.lots, closeUps: Array.isArray(raw.closeUps) ? raw.closeUps : [] };
  }
  return { points: [], lots: [], closeUps: [] };
}

// Estado da calibração (pontos avulsos + lotes em linha/coluna) + persistência
// em server.py (calibration.json). x/y de pontos e âncora de lotes ficam
// salvos como fração [0,1] da imagem de cada vista — sobrevive a qualquer
// redimensionamento de tela sem recalcular nada.
//
// Duas vistas independentes ('top' = vista de cima, 'iso' = isométrica): cada
// uma tem seu próprio conjunto de pontos/lotes, calibrado na posição/ângulo
// daquela imagem específica. O único vínculo entre as duas é o NOME do ponto
// — se o mesmo nome existir nas duas vistas, é o mesmo ponto físico (mesma
// task no robô), mas cada vista guarda sua própria posição/rotação/lote.
// Nada é copiado automaticamente de uma vista pra outra.
//
// A marcação de ocupação (occupied) NÃO mora mais aqui — ver
// hooks/useLiveState.js. Ela virou estado compartilhado ao vivo entre
// dispositivos (polling + mutação cirúrgica no servidor, ver CONTEXT.md,
// "Fila de rotas compartilhada"), diferente de pontos/lotes, que continuam
// só localmente editados (modo desenvolvedor) e salvos em snapshot
// debounced como sempre.
export function useCalibration() {
  const [view, setView] = useState('top'); // 'top' | 'iso'
  const [data, setData] = useState({ top: EMPTY_VIEW_DATA, iso: EMPTY_VIEW_DATA });
  const [palletHeights, setPalletHeights] = useState(DEFAULT_PALLET_HEIGHTS);
  const [status, setStatus] = useState('loading'); // loading | idle | saving | error
  const saveTimer = useRef(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadCalibration()
      .then((loaded) => {
        if (cancelled) return;
        // Migração: calibration.json de antes da vista isométrica existir
        // era {points:[...], lots:[...]} direto (sem "top"/"iso") — tudo
        // que já existia foi calibrado contra a vista de cima.
        const isNewFormat = loaded && typeof loaded === 'object' && ('top' in loaded || 'iso' in loaded);
        setData({
          top: normalizeView(isNewFormat ? loaded.top : loaded),
          iso: normalizeView(isNewFormat ? loaded.iso : null),
        });
        setPalletHeights(normalizePalletHeights(loaded && loaded.palletHeights));
        setStatus('idle');
        loadedRef.current = true;
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
        loadedRef.current = true;
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return; // não salva antes do primeiro load completar
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setStatus('saving');
      // occupied não é lido/escrito daqui — GET manda o que já está salvo
      // (server.py preserva o campo), e as mutações de ocupação passam
      // pelos endpoints cirúrgicos em useLiveState.js, nunca por aqui.
      saveCalibration(data)
        .then(() => setStatus('idle'))
        .catch(() => setStatus('error'));
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [data]);

  // --- pontos avulsos (sempre na vista ativa) --------------------------------
  const addPoint = useCallback((x, y) => {
    const id = generateId();
    setData((prev) => {
      const cur = prev[view];
      const name = 'ponto-' + (cur.points.length + 1);
      // namesVisible começa false: o padrão é o nome ESCONDIDO no mapa,
      // igual aos lotes — liga no olho do PointsPanel quando precisar.
      // displayName: apelido puramente visual (ver displayCellName abaixo)
      // — null = sem apelido, cai no nome técnico (`name`, já calibrado
      // idêntico ao ponto no robô — NUNCA muda por causa de apelido).
      return { ...prev, [view]: { ...cur, points: [...cur.points, { id, name, displayName: null, x, y, rotation: 0, namesVisible: false }] } };
    });
    return id;
  }, [view]);

  const updatePoint = useCallback((id, patch) => {
    setData((prev) => {
      const cur = prev[view];
      return { ...prev, [view]: { ...cur, points: cur.points.map((p) => (p.id === id ? { ...p, ...patch } : p)) } };
    });
  }, [view]);

  const removePoint = useCallback((id) => {
    setData((prev) => {
      const cur = prev[view];
      return { ...prev, [view]: { ...cur, points: cur.points.filter((p) => p.id !== id) } };
    });
  }, [view]);

  // --- lotes (linha/coluna de células grudadas, sempre na vista ativa) ------
  // cellSize fica gravado no próprio lote no momento da criação (não é
  // recalculado depois) — assim um lote já criado mantém seu tamanho mesmo
  // se o tamanho padrão (calculado a partir da imagem) mudar no futuro.
  const addLot = useCallback(({ prefix, x, y, rotation, count, cellSize }) => {
    const id = generateId();
    setData((prev) => {
      const cur = prev[view];
      // displayName: apelido puramente visual (ver lotCellDisplayName
      // abaixo) — null = sem apelido cadastrado ainda, cai no prefixo
      // técnico mesmo. NUNCA usado pra identificar a célula de verdade
      // (isso continua sendo só `prefix`, já configurado no backend do
      // robô) — editável em LotsPanel.jsx, junto do prefixo.
      const lot = { id, prefix, displayName: null, x, y, rotation, count, cellSize, scaleX: 1, scaleY: 1, color: null, namesVisible: false };
      return { ...prev, [view]: { ...cur, lots: [...cur.lots, lot] } };
    });
    return id;
  }, [view]);

  const updateLot = useCallback((id, patch) => {
    setData((prev) => {
      const cur = prev[view];
      return { ...prev, [view]: { ...cur, lots: cur.lots.map((l) => (l.id === id ? { ...l, ...patch } : l)) } };
    });
  }, [view]);

  const removeLot = useCallback((id) => {
    setData((prev) => {
      const cur = prev[view];
      return { ...prev, [view]: { ...cur, lots: cur.lots.filter((l) => l.id !== id) } };
    });
  }, [view]);

  // --- áreas de Close Up (retângulo livre, sempre na vista ativa) -----------
  // Mesmo padrão de lote: x/y em fração da imagem (canto superior-esquerdo),
  // width/height em px de conteúdo (não recalculados depois), scaleX/scaleY
  // aplicados pelo Transformer do Konva ao redimensionar. Ver
  // FloorPlanCanvas.jsx (CloseUpMarker/handleCloseUpClick).
  const addCloseUp = useCallback(({ x, y, width, height }) => {
    const id = generateId();
    setData((prev) => {
      const cur = prev[view];
      const name = 'close-' + (cur.closeUps.length + 1);
      const closeUp = { id, name, x, y, width, height, scaleX: 1, scaleY: 1 };
      return { ...prev, [view]: { ...cur, closeUps: [...cur.closeUps, closeUp] } };
    });
    return id;
  }, [view]);

  const updateCloseUp = useCallback((id, patch) => {
    setData((prev) => {
      const cur = prev[view];
      return { ...prev, [view]: { ...cur, closeUps: cur.closeUps.map((c) => (c.id === id ? { ...c, ...patch } : c)) } };
    });
  }, [view]);

  const removeCloseUp = useCallback((id) => {
    setData((prev) => {
      const cur = prev[view];
      return { ...prev, [view]: { ...cur, closeUps: cur.closeUps.filter((c) => c.id !== id) } };
    });
  }, [view]);

  // Altura de pallets: mutação cirúrgica no servidor (não passa pelo save
  // debounced de pontos/lotes). Otimista + reconcilia com o que o servidor
  // devolve; em erro, volta pro valor anterior.
  const savePalletHeights = useCallback(async (next) => {
    const optimistic = normalizePalletHeights({ ...palletHeights, ...next });
    setPalletHeights(optimistic);
    try {
      const applied = await savePalletHeightsApi(next);
      setPalletHeights(normalizePalletHeights(applied));
    } catch (err) {
      setPalletHeights(palletHeights); // rollback
      throw err;
    }
  }, [palletHeights]);

  return {
    view, setView,
    points: data[view].points, addPoint, updatePoint, removePoint,
    lots: data[view].lots, addLot, updateLot, removeLot,
    closeUps: data[view].closeUps, addCloseUp, updateCloseUp, removeCloseUp,
    palletHeights, savePalletHeights,
    status,
  };
}

// Nome de uma célula do lote a partir do índice (0-based): a primeira célula
// é só o prefixo (conta como "1" implícito), as demais numeram a partir de 2
// — ex prefixo "A": A, A2, A3, A4...
// Esse é o nome TÉCNICO — usado nas regras de fronteira (Caso 3), enviado
// pro robô, guardado em pickupNames/dropoffNames/occupied/route.pickup etc.
// Já está configurado no backend do robô — NUNCA muda por causa de nome
// fantasia (ver lotCellDisplayName/displayCellName abaixo).
export function lotCellName(prefix, index) {
  return index === 0 ? prefix : prefix + String(index + 1);
}

// Nome fantasia de uma célula — AO CONTRÁRIO do lotCellName técnico acima
// (que omite o número na 1ª célula, "A"/"A2"/"A3"), aqui TODA célula é
// numerada a partir de 1: "Linha Norte 1", "Linha Norte 2"... Pedido
// explícito do usuário: essa regra vale SÓ pra fantasia, o nome técnico
// continua sem número na primeira célula, sem mudança nenhuma. Puramente
// visual: nunca entra em nenhuma lógica de identificação/validação. Lote
// sem apelido cadastrado (displayName null/vazio) cai no nome técnico
// mesmo — a UI nunca mostra "undefined" ou uma célula sem nome.
export function lotCellDisplayName(lot, index) {
  return lot.displayName ? lot.displayName + ' ' + (index + 1) : lotCellName(lot.prefix, index);
}

// Resolve o nome fantasia a partir do nome TÉCNICO — usado em qualquer
// lugar que só tem a string técnica em mãos (fila, ocupação, seleção de
// ponto a ponto: essas vêm do servidor ou de arrays de nomes, não do
// objeto `lot`/`point` direto) e precisa mostrar o apelido em vez dela.
// Procura primeiro nos lotes (célula de lote), depois nos pontos avulsos
// (`points`, opcional — quem não precisa dessa parte, como o mapa que já
// tem o objeto `point` em mãos, pode omitir). Sem apelido cadastrado em
// nenhum dos dois: devolve o nome técnico sem mudar nada — substituição
// estritamente visual.
export function displayCellName(technicalName, lots, points) {
  for (const lot of lots) {
    for (let i = 0; i < lot.count; i++) {
      if (lotCellName(lot.prefix, i) === technicalName) return lotCellDisplayName(lot, i);
    }
  }
  const point = points && points.find((p) => p.name === technicalName);
  if (point && point.displayName) return point.displayName;
  return technicalName;
}
