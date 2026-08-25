// Camada de API do dispatch service do robô. Sem dependência de React —
// porta direta de window.LIFTY (ver legacy/index.html e CONTEXT.md), mais
// createTaskTemplate/createAndRunRoute pro fluxo "Ponto a Ponto".

export const CONFIG = {
  API_BASE: '/api/reeman-dispatch-service', // caminho relativo -> proxy local (server.py)
  PROJECT_ID: 13,
  // Hash do mapa ativo na plataforma do robô — fixo depois de mapeado/salvo.
  // Capturado inspecionando a criação manual de um template (ver CONTEXT.md).
  TARGET_MAP: 'eecc4a9068e11bd9086538383a38c67d',
  SUPPORT_ROBOT_TYPES: ['犀牛2.0'],
};

// Diferenciação de pallets (ver CONTEXT.md) — o azul (metálico) fica
// levemente elevado do chão em 4 pezinhos, precisa de ajuste de altura no
// PICKUP pra alinhar o garfo certo; o de madeira fica rente ao chão. UNLOAD
// nunca leva ajuste diferenciado, só o PICKUP — não foi pedido pro dropoff.
//
// IMPORTANTE (corrigido depois de inspecionar o JSON real gerado pela
// plataforma): o campo `height` QUE FICA DIRETO na ação (topo do objeto)
// NÃO é o que controla o alinhamento do pallet — esse fica sempre em 0,
// pallet nenhum muda ele. O valor de verdade mora dentro de
// `params.PALLET_LAYER` (dois campos, `height` E `layer`) — colocar o
// valor no lugar errado faz a plataforma marcar a checkbox de 0cm mesmo
// pedindo altura de 8cm. Madeira mantém `params: null` (igual todo
// template criado antes dessa feature já usava, implicitamente).
const PICKUP_PALLET_LAYER = {
  wood: null,
  blue: { height: 8, layer: 2 },
};
const PALLET_NAME_SUFFIX = { wood: '', blue: 'MT' }; // MT = pallet de Metal

export async function apiPost(path, body) {
  const opts = { method: 'POST' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(CONFIG.API_BASE + path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* resposta vazia ou não-JSON */ }
  if (!res.ok || !data || data.code !== 0) {
    const msg = (data && data.message) || ('Falha HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

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

export async function runTask(taskId) {
  if (!taskId) throw new Error('ID da task não configurado.');
  return apiPost('/task-template/generic/task-fast/' + taskId, {});
}

export async function cancelAllTasks() {
  if (!CONFIG.PROJECT_ID) throw new Error('PROJECT_ID não configurado.');
  return apiPost('/task-record/all-cancel/' + CONFIG.PROJECT_ID);
}

// Cancela UMA task específica pelo id do registro (task-record), sem afetar
// nenhuma outra — diferente de cancelAllTasks, que derruba tudo do projeto.
// Descoberto capturando o botão "Cancelar tarefa" da plataforma admin.
export async function cancelTaskRecord(taskRecordId) {
  return apiPost('/task-record/cancel/' + taskRecordId);
}

// Acha o id da task automática de carga ("ir pra energia") se ela estiver
// ativa agora pra esse projeto. O robô cria essa task sozinho sempre que
// fica sem nenhuma task na lista (mesma prioridade de uma task normal — não
// é preemptada). Olha só o registro mais recente do projeto: se for do tipo
// AUTO_SYSTEM e ainda não tiver terminado/sido cancelado, é ela.
export async function findActiveChargeTaskId() {
  const params = new URLSearchParams({
    projectId: String(CONFIG.PROJECT_ID),
    page: '1',
    size: '1',
    status: '',
    name: '',
  });
  const data = await apiGet('/task-record/page?' + params.toString());
  const record = data.data && data.data.records && data.data.records[0];
  if (record && record.taskType === 'AUTO_SYSTEM' && record.status !== 'FINISHED' && record.status !== 'CANCELLED') {
    return record.id;
  }
  return null;
}

// Cria um task-template na hora (POST /task-template/create) a partir de uma
// lista de ações já montada. Não dispara a execução — só cadastra o template
// e devolve o id (data.id), que serve direto em runTask().
export async function createTaskTemplate(name, taskActionList) {
  const data = await apiPost('/task-template/create', {
    name,
    description: '',
    supportRobotTypes: CONFIG.SUPPORT_ROBOT_TYPES,
    projectId: String(CONFIG.PROJECT_ID),
    id: null,
    taskActionList,
  });
  if (!data.data || !data.data.id) throw new Error('Resposta sem id de template.');
  return data.data.id;
}

// Nome de template/registro pra uma rota — usado tanto pra criar quanto pra
// procurar um template já existente, e pra filtrar o status em
// fetchLatestTaskRecord. Pallet azul (metálico) ganha o sufixo "MT" —
// mesma origem/destino com pallet diferente vira um template SEPARADO (a
// altura de PICKUP faz parte do "recipe", não dá pra reaproveitar o mesmo
// nome de antes). Sem sufixo pra madeira preserva compatibilidade com todo
// template já criado antes dessa feature existir (todos eram, implicitamente,
// pallet de madeira — altura 0).
export function routeTaskName(pickupPointName, dropoffPointName, palletType = 'wood') {
  return pickupPointName + 'to' + dropoffPointName + (PALLET_NAME_SUFFIX[palletType] || '');
}

// Procura um template já cadastrado com esse nome exato (GET
// /task-template/page, descoberto inspecionando a plataforma admin —
// devolve os templates de um projeto, paginado, filtrável por name).
// Devolve o id se achar, ou null. O filtro `name` do endpoint pode ser
// parcial (não confirmado se é exato ou "contém") — por segurança comparamos
// nome a nome do lado de cá antes de aceitar um resultado.
export async function findTaskTemplateId(name) {
  const params = new URLSearchParams({
    page: '1',
    size: '10',
    projectId: String(CONFIG.PROJECT_ID),
    name,
    description: '',
  });
  const data = await apiGet('/task-template/page?' + params.toString());
  const records = (data.data && data.data.records) || [];
  const exact = records.find((r) => r.name === name);
  return exact ? exact.id : null;
}

// Fluxo completo do modo "Ponto a Ponto": reaproveita o template PICKUP→
// UNLOAD entre dois pontos calibrados se um com esse nome já existir
// (o "recipe" pra uma rota A→B nunca muda), senão cria na hora — e sempre
// dispara a execução. Ver CONTEXT.md, seção "RESOLVIDO", e conversa: o
// dispatch service rejeita nome de template repetido no mesmo projeto
// ({"code":1,"message":"...任务模版名称已存在..."} = "nome de template já
// existe"), então criar sem checar antes falhava toda vez que a mesma rota
// era mandada de novo.
export async function createAndRunRoute(pickupPointName, dropoffPointName, palletType = 'wood') {
  const name = routeTaskName(pickupPointName, dropoffPointName, palletType);

  let templateId = await findTaskTemplateId(name);
  if (!templateId) {
    const palletLayer = PICKUP_PALLET_LAYER[palletType];
    const taskActionList = [
      {
        targetMap: CONFIG.TARGET_MAP,
        targetArea: '',
        targetPoint: pickupPointName,
        height: 0,
        action: 'PICKUP',
        groupId: 1,
        serialNumber: 1,
        params: palletLayer ? { PALLET_LAYER: palletLayer } : null,
      },
      {
        targetMap: CONFIG.TARGET_MAP,
        targetArea: '',
        targetPoint: dropoffPointName,
        height: 0,
        action: 'UNLOAD',
        groupId: 1,
        serialNumber: 2,
        params: null,
      },
    ];
    templateId = await createTaskTemplate(name, taskActionList);
  }

  await runTask(templateId);
  return { templateId, name };
}

// Consulta GET /task-record/page filtrando por nome — devolve o registro
// mais recente com esse nome inteiro (id incluso, não só o status), ou null
// se ainda não existir nenhum (task acabou de disparar, dispatch-service
// ainda não indexou o registro). Validado contra o robô real: enum de
// status confirmado inclui pelo menos WAITING (criada, ainda não começou),
// FINISHED (terminou com sucesso) e CANCELLED (cancelada). Qualquer outro
// valor (ex: em execução) é tratado como "ainda não terminou" pelo
// chamador — não precisa enumerar todos. Precisa do id (não só do status)
// pra poder consultar o progresso por ação em fetchActionRecords (Caso 2 da
// marcação de ocupação, ver CONTEXT.md).
export async function fetchLatestTaskRecord(name) {
  const params = new URLSearchParams({
    projectId: String(CONFIG.PROJECT_ID),
    page: '1',
    size: '1',
    status: '',
    name,
  });
  const data = await apiGet('/task-record/page?' + params.toString());
  return (data.data && data.data.records && data.data.records[0]) || null;
}

// Lista as ações individuais dentro de uma task (cada PICKUP/UNLOAD do
// taskActionList original), com startTime/finishTime/status por ação — usa
// finishTime não-nulo (não o texto de status) como sinal de "essa ação
// terminou": nunca vimos o valor de status de uma ação concluída com
// sucesso (só "CANCELLED" uma vez num exemplo real), então depender do
// schema de finishTime, esse sim confirmado, é mais robusto que adivinhar
// o enum. Usado pra detectar quando o PICKUP terminou mas o UNLOAD ainda
// não (Caso 2 da marcação de ocupação, ver CONTEXT.md).
export async function fetchActionRecords(taskRecordId) {
  const data = await apiGet('/action-record/list/' + taskRecordId);
  return data.data || [];
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

// Histórico de rotas (painel "Histórico", modo desenvolvedor) — NÃO é uma
// chamada ao dispatch service, é o nosso próprio server.py
// (route_log.json). De propósito: requestedAt/completedAt são carimbados
// pelo RELÓGIO DA MÁQUINA QUE HOSPEDA O SERVIDOR, não pelo do dispatch nem
// pelo do navegador/tablet do operador — o app só manda pickup/dropoff/
// taskName, quem carimba o horário é sempre o servidor (ver server.py).
// Melhor esforço: chamado de dentro de fireRoute/da sondagem de status em
// App.jsx, nunca deve impedir o disparo/conclusão real da rota — só o
// registro no histórico.
export async function logRouteRequested({ id, pickup, dropoff, taskName }) {
  const res = await fetch('/api/route-log/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, pickup, dropoff, taskName }),
  });
  if (!res.ok) throw new Error('Falha ao registrar rota no histórico (HTTP ' + res.status + ')');
}

export async function logRouteCompleted({ id, status }) {
  const res = await fetch('/api/route-log/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status }),
  });
  if (!res.ok) throw new Error('Falha ao concluir rota no histórico (HTTP ' + res.status + ')');
}

export async function fetchRouteLog() {
  const res = await fetch('/api/route-log');
  if (!res.ok) throw new Error('Falha ao carregar histórico de rotas (HTTP ' + res.status + ')');
  return res.json();
}

// Persistência da calibração (pontos avulsos + lotes em linha/coluna) —
// server.py grava em calibration.json no disco (sobrevive a reload/troca de
// dispositivo).
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
