// Camada de API que sobra no cliente pro dispatch service do robô — só
// leitura (erros/avisos), e persistência de calibração/histórico no nosso
// próprio server.py. Toda a orquestração de fila (criar/disparar task,
// cancelar, sondar status) migrou pro servidor (ver CONTEXT.md, "Fila de
// rotas compartilhada", e server.py) — o navegador não fala mais direto
// com o robô pra isso, só manda intenções pro servidor (hooks/useLiveState.js).

export const CONFIG = {
  API_BASE: '/api/reeman-dispatch-service', // caminho relativo -> proxy local (server.py)
  PROJECT_ID: 13,
};

export async function apiGet(path) {
  const res = await fetch(CONFIG.API_BASE + path);
  let data = null;
  try { data = await res.json(); } catch { /* resposta vazia ou não-JSON */ }
  if (!res.ok || !data || data.code !== 0) {
    const msg = (data && data.message) || ('Falha HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

// Registros de erro/aviso do robô — schema validado contra o robô real:
// records[] com id/agvId/error/level ("ERROR"/"WARN")/description/
// happenTime/isRead/readTime, paginado (total/size/current/pages). Usado no
// painel "Histórico" (modo desenvolvedor).
export async function fetchErrorRecords({ page = 1, size = 30 } = {}) {
  const params = new URLSearchParams({
    projectId: String(CONFIG.PROJECT_ID),
    page: String(page),
    size: String(size),
  });
  const data = await apiGet('/error/records?' + params.toString());
  return data.data;
}

// Histórico de rotas (painel "Histórico") — leitura do nosso próprio
// server.py (route_log.json). A GRAVAÇÃO não é mais feita pelo cliente:
// quem dispara/conclui rotas agora é o servidor (ver useLiveState.js), que
// já grava o histórico direto, sem round-trip HTTP nenhum.
export async function fetchRouteLog() {
  const res = await fetch('/api/route-log');
  if (!res.ok) throw new Error('Falha ao carregar histórico de rotas (HTTP ' + res.status + ')');
  return res.json();
}

// Persistência da calibração (pontos avulsos + lotes em linha/coluna) —
// server.py grava em calibration.json no disco (sobrevive a reload/troca de
// dispositivo). A marcação de ocupação (occupied) não passa mais por aqui —
// ver hooks/useLiveState.js e /api/occupied/*.
export async function loadCalibration() {
  const res = await fetch('/api/calibration');
  if (!res.ok) throw new Error('Falha ao carregar calibração (HTTP ' + res.status + ')');
  return res.json();
}

export async function saveCalibration(calibration) {
  const res = await fetch('/api/calibration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calibration),
  });
  if (!res.ok) throw new Error('Falha ao salvar calibração (HTTP ' + res.status + ')');
}

// Altura do pallet azul (sub-seção "Altura de pallets" do editor). Mutação
// cirúrgica só dessa chave no calibration.json — não passa pelo snapshot
// debounced de pontos/lotes. Devolve { blueBase, blueTop } já aplicado.
export async function savePalletHeights(heights) {
  const res = await fetch('/api/pallet-heights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(heights),
  });
  if (!res.ok) throw new Error('Falha ao salvar altura dos pallets (HTTP ' + res.status + ')');
  const data = await res.json();
  return data.palletHeights;
}
