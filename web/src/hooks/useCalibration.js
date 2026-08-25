import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCalibration, saveCalibration } from '../api/lifty';
import { generateId } from '../utils';

const EMPTY_VIEW_DATA = { points: [], lots: [] };

function normalizeView(raw) {
  if (raw && Array.isArray(raw.points) && Array.isArray(raw.lots)) {
    return { points: raw.points, lots: raw.lots };
  }
  return { points: [], lots: [] };
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
// occupied (marcação de ocupação) é GLOBAL, não por vista — representa um
// fato físico do armazém (tem pallet ali ou não agora), não uma calibração
// visual. É uma lista de nomes, válida nas duas vistas ao mesmo tempo.
export function useCalibration() {
  const [view, setView] = useState('top'); // 'top' | 'iso'
  const [data, setData] = useState({ top: EMPTY_VIEW_DATA, iso: EMPTY_VIEW_DATA });
  const [occupied, setOccupied] = useState([]); // nomes marcados como ocupados
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
        setOccupied(Array.isArray(loaded && loaded.occupied) ? loaded.occupied : []);
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
      saveCalibration({ ...data, occupied })
        .then(() => setStatus('idle'))
        .catch(() => setStatus('error'));
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [data, occupied]);

  // --- pontos avulsos (sempre na vista ativa) --------------------------------
  const addPoint = useCallback((x, y) => {
    const id = generateId();
    setData((prev) => {
      const cur = prev[view];
      const name = 'ponto-' + (cur.points.length + 1);
      return { ...prev, [view]: { ...cur, points: [...cur.points, { id, name, x, y, rotation: 0 }] } };
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
      const lot = { id, prefix, x, y, rotation, count, cellSize, scaleX: 1, scaleY: 1, color: null, namesVisible: false };
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

  // --- ocupação (global, independente de vista) ------------------------------
  const toggleOccupied = useCallback((name) => {
    setOccupied((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }, []);

  // Versão determinística do toggle, pra marcação automática (Caso 2, ver
  // CONTEXT.md) — a sondagem de progresso da task chama isso a cada tick
  // enquanto a condição valer, então precisa ser idempotente (nunca
  // desmarcar/remarcar em falso se rodar mais de uma vez pro mesmo nome).
  const setOccupiedState = useCallback((name, isOccupied) => {
    setOccupied((prev) => {
      const has = prev.includes(name);
      if (isOccupied === has) return prev;
      return isOccupied ? [...prev, name] : prev.filter((n) => n !== name);
    });
  }, []);

  // Versão em lote — commit único do gesto de "pintar arrastando" no modo
  // mark (ver FloorPlanCanvas): todos os nomes tocados durante o arrasto
  // viram a MESMA ação de uma vez (decidida pelo primeiro quadrado tocado),
  // um único setState em vez de N chamadas sequenciais.
  const setOccupiedMany = useCallback((names, isOccupied) => {
    setOccupied((prev) => {
      const set = new Set(prev);
      let changed = false;
      for (const name of names) {
        if (isOccupied === set.has(name)) continue;
        if (isOccupied) set.add(name); else set.delete(name);
        changed = true;
      }
      return changed ? Array.from(set) : prev;
    });
  }, []);

  return {
    view, setView,
    points: data[view].points, addPoint, updatePoint, removePoint,
    lots: data[view].lots, addLot, updateLot, removeLot,
    occupied, toggleOccupied, setOccupiedState, setOccupiedMany,
    status,
  };
}

// Nome de uma célula do lote a partir do índice (0-based): a primeira célula
// é só o prefixo (conta como "1" implícito), as demais numeram a partir de 2
// — ex prefixo "A": A, A2, A3, A4...
export function lotCellName(prefix, index) {
  return index === 0 ? prefix : prefix + String(index + 1);
}
