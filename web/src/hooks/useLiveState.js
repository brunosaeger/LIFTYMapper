import { useCallback, useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 4000; // mesmo intervalo que a sondagem client-side usava antes

async function jsonRequest(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch { /* resposta vazia ou não-JSON */ }
  if (!res.ok) {
    const msg = (data && data.error) || ('Falha HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

// Estado ao vivo compartilhado entre todos os dispositivos (ver CONTEXT.md,
// "Fila de rotas compartilhada") — currentRoute/pendingRoute/routeQueue/
// occupied agora vivem no server.py (queue_state.json/calibration.json),
// não mais em estado React local. Este hook só POLL o servidor (GET
// /api/live-state, mesmo intervalo de 4s que a sondagem antiga usava) e
// manda INTENÇÕES (enqueueRoute/cancelCurrent/removeQueued/setOccupied*) —
// quem decide e fala com o robô de verdade é sempre o servidor. Isso é o
// que impede duplicação: o servidor serializa tudo por lock, então dois
// dispositivos nunca "decidem" a mesma coisa duas vezes (ver server.py,
// QUEUE_LOCK).
export function useLiveState() {
  const [state, setState] = useState({ currentRoute: null, pendingRoute: null, routeQueue: [], occupied: [], emergency: false });
  const [status, setStatus] = useState('loading'); // loading | idle | error

  const refresh = useCallback(() => {
    return fetch('/api/live-state')
      .then((res) => {
        if (!res.ok) throw new Error('Falha HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        setState(data);
        setStatus('idle');
      })
      .catch(() => setStatus('error'));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Cada ação abaixo já puxa um refresh() logo depois de confirmada — sem
  // isso, quem acabou de agir só veria o efeito da própria ação no próximo
  // ciclo de poll (até 4s de atraso), o que pareceria "travado" comparado
  // ao feedback instantâneo que o app tinha antes (setState local direto).

  // Envia N pares origem→destino de uma vez. Devolve `{ slot: 'current' |
  // 'pending' | 'queued' }` referente ao PRIMEIRO par — o servidor decide
  // (sob lock, sem corrida entre dois operadores enviando quase junto), e
  // quem chama usa isso só pra escolher a mensagem de feedback certa.
  //
  // Sempre em lote, mesmo com um par só: o servidor precisa validar a
  // cadeia inteira com ocupação PROJETADA (ver "Lotes em sequência" no
  // CONTEXT.md). Mandar par a par faria a 2ª rota ser rejeitada, porque no
  // instante do envio a origem anterior ainda está fisicamente ocupada.
  const enqueueRoutes = useCallback(async ({ pairs, palletType }) => {
    const result = await jsonRequest('/api/queue/enqueue-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs, palletType }),
    });
    await refresh();
    return result;
  }, [refresh]);

  const cancelCurrent = useCallback(async () => {
    await jsonRequest('/api/queue/cancel-current', { method: 'POST' });
    await refresh();
  }, [refresh]);

  // Parada de emergência (liga/desliga). Ligar cancela tudo no robô e
  // mantém ele parado (o servidor reprime a task de carga que o robô
  // recria) — ver server.py, _queue_emergency / _emergency_suppress.
  const setEmergency = useCallback(async (active) => {
    await jsonRequest('/api/queue/emergency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    await refresh();
  }, [refresh]);

  const removeQueued = useCallback(async (id) => {
    await jsonRequest('/api/queue/remove-queued', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await refresh();
  }, [refresh]);

  const setOccupied = useCallback(async (name, isOccupied) => {
    await jsonRequest('/api/occupied/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, occupied: isOccupied }),
    });
    await refresh();
  }, [refresh]);

  // Commit único do gesto de "pintar arrastando" no modo mark (ver
  // FloorPlanCanvas/commitOnRelease) — todos os nomes tocados no arrasto
  // viram uma única chamada de rede, não N chamadas sequenciais.
  const setOccupiedMany = useCallback(async (names, isOccupied) => {
    await jsonRequest('/api/occupied/set-many', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names, occupied: isOccupied }),
    });
    await refresh();
  }, [refresh]);

  // Clique manual num item já ocupado (painel Ocupação) — sempre desmarca
  // na prática (só é chamado sobre itens já na lista), mas calcula o
  // estado-alvo a partir do que o servidor mandou por último, pra ficar
  // correto mesmo se algum dia for chamado sobre um nome não-ocupado.
  const toggleOccupied = useCallback((name) => {
    const isCurrentlyOccupied = state.occupied.includes(name);
    return setOccupied(name, !isCurrentlyOccupied);
  }, [state.occupied, setOccupied]);

  return {
    currentRoute: state.currentRoute,
    pendingRoute: state.pendingRoute,
    routeQueue: state.routeQueue,
    occupied: state.occupied,
    emergency: state.emergency,
    status,
    enqueueRoutes,
    cancelCurrent,
    removeQueued,
    setEmergency,
    setOccupied,
    setOccupiedMany,
    toggleOccupied,
  };
}
