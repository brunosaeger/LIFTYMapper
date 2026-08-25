import { useState, useEffect, useRef } from 'react';
import Toolbar from './components/Toolbar';
import PointsPanel from './components/PointsPanel';
import LotsPanel from './components/LotsPanel';
import PointToPointBar from './components/PointToPointBar';
import RouteQueue from './components/RouteQueue';
import OccupancyPanel from './components/OccupancyPanel';
import HistoryPanel from './components/HistoryPanel';
import FloorPlanCanvas from './components/FloorPlanCanvas';
import Toast from './components/Toast';
import DevModeModal from './components/DevModeModal';
import { useCalibration, lotCellName } from './hooks/useCalibration';
import { useToast } from './hooks/useToast';
import { generateId } from './utils';
import { applyTheme } from './theme';
import {
  createAndRunRoute,
  cancelAllTasks,
  cancelTaskRecord,
  findActiveChargeTaskId,
  fetchLatestTaskRecord,
  fetchActionRecords,
  logRouteRequested,
  logRouteCompleted,
} from './api/lifty';
import './App.css';

const POLL_INTERVAL_MS = 4000;
// Só um gate de UI local (esconder edição de quem tá mexendo no tablet no
// dia a dia) — não é segurança de verdade, a senha fica visível em texto no
// bundle JS pra quem abrir o devtools. Não guardar nada sensível atrás
// disso.
const DEV_PASSWORD = 'ihavenomouthandimustscream';

// Tema claro/escuro (botão lua/sol no Toolbar) — escuro é o padrão do site
// (ver index.css/theme.js). Persistido por dispositivo (localStorage), não
// por usuário — é preferência de tela, não dado de negócio.
const THEME_STORAGE_KEY = 'lifty-theme';

function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage indisponível (ex: navegação privada) — cai no padrão
  }
  return 'dark';
}

export default function App() {
  const {
    view, setView,
    points, addPoint, updatePoint, removePoint,
    lots, addLot, updateLot, removeLot,
    occupied, toggleOccupied, setOccupiedState, setOccupiedMany,
    status: saveStatus,
  } = useCalibration();
  const [toast, showToast] = useToast();

  const [theme, setTheme] = useState(getInitialTheme);

  // Aplica o tema nos dois lugares que precisam saber: o atributo no
  // <html> (pro CSS via :root[data-theme='light'], index.css) e o
  // theme.js:COLORS (pro Konva, que não lê CSS custom property nenhuma —
  // ver comentário lá). O re-render do FloorPlanCanvas que essa troca de
  // estado já dispara é o que faz o canvas redesenhar com as cores novas
  // (COLORS é o mesmo objeto sempre, só muta as propriedades em lugar).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // melhor esforço — só a persistência falha, o tema em si já aplicou
    }
  }, [theme]);

  function handleToggleTheme() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  // 'edit' só é alcançável em modo desenvolvedor (ver handleDevButtonClick e
  // baseMode abaixo) — o padrão pra quem não desbloqueou é 'ptp', o modo
  // operacional do dia a dia.
  const [mode, setMode] = useState('ptp'); // 'edit' | 'ptp' | 'mark'
  const [addTool, setAddTool] = useState(null); // null | 'point' | 'lot'
  const [pendingLotPrefix, setPendingLotPrefix] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedLotId, setSelectedLotId] = useState(null);

  // Modo desenvolvedor: libera a aba "Editar pontos" e os botões "+ Ponto"/
  // "+ Lote" no Toolbar (ver Toolbar.jsx) — sem ele, mode nunca chega a
  // 'edit' por nenhum caminho alcançável da UI (ver baseMode/
  // handleDevButtonClick). Não persiste entre reloads de propósito — é uma
  // trava de sessão, não uma preferência salva.
  const [devMode, setDevMode] = useState(false);
  const [devModalOpen, setDevModalOpen] = useState(false);

  const [pickupName, setPickupName] = useState(null);
  const [dropoffName, setDropoffName] = useState(null);
  // Diferenciação de pallets (ver CONTEXT.md) — azul vem selecionado por
  // padrão porque é o mais comum na planta. Não é resetado por
  // resetSelection: é uma preferência de "com que pallet estou trabalhando
  // agora", independente de qual origem/destino está selecionado no
  // momento.
  const [palletType, setPalletType] = useState('blue'); // 'wood' | 'blue'
  const [sending, setSending] = useState(false);

  // Fila de rotas, em até 3 camadas:
  // - currentRoute: já disparada pro robô, rodando agora (no máx. 1).
  // - pendingRoute: já disparada pro robô TAMBÉM, mas o dispatch a segura
  //   como "próxima" porque a atual ainda não terminou (no máx. 1). Mandar
  //   ela com antecedência (em vez de só quando a atual termina) é o que
  //   evita o robô achar que "não tem mais nada" e desviar sozinho pra
  //   carga — descoberto testando: o dispatch já suporta isso nativamente
  //   quando se dispara uma task com outra em andamento.
  // - routeQueue: ainda NÃO chegou a ser enviada pro robô, só existe aqui no
  //   navegador — só vira pendingRoute quando o slot pendente esvaziar.
  //
  // Sondagem de status (useEffect abaixo, validada contra GET
  // /task-record/page no robô real) detecta quando a atual termina: se
  // já tinha pendingRoute, só promove ela (não dispara de novo, já estava
  // rodando) e puxa o próximo da fila local pro slot pendente. Cancelar a
  // atual manualmente (X vermelho) NÃO promove nada — é uma parada de
  // emergência, não "terminou, pode seguir".
  const [currentRoute, setCurrentRoute] = useState(null); // { id, pickup, dropoff, taskName } | null
  const [pendingRoute, setPendingRoute] = useState(null); // { id, pickup, dropoff, taskName } | null
  const [routeQueue, setRouteQueue] = useState([]); // [{ id, pickup, dropoff }] — ainda local, não enviada
  const routeQueueRef = useRef([]);
  useEffect(() => { routeQueueRef.current = routeQueue; }, [routeQueue]);
  const pendingRouteRef = useRef(null);
  useEffect(() => { pendingRouteRef.current = pendingRoute; }, [pendingRoute]);

  function resetSelection() {
    setAddTool(null);
    setPendingLotPrefix('');
    setSelectedId(null);
    setSelectedLotId(null);
    setPickupName(null);
    setDropoffName(null);
  }

  function handleModeChange(next) {
    setMode(next);
    resetSelection();
  }

  // Trocar de vista (topo/isométrica) troca o conjunto de pontos/lotes
  // inteiro (cada vista é calibrada à parte) — qualquer seleção que
  // referenciasse um id da vista anterior fica inválida. pickup/dropoff NÃO
  // são limpos aqui: são nomes, não ids, e valem nas duas vistas (mesmo
  // ponto físico) — se o nome não existir na vista atual, simplesmente não
  // aparece destacado nela, mas a seleção em si continua de pé.
  function handleToggleView() {
    setView((v) => (v === 'top' ? 'iso' : 'top'));
    setAddTool(null);
    setPendingLotPrefix('');
    setSelectedId(null);
    setSelectedLotId(null);
  }

  // Mode "de repouso" pra onde os toggles de mark/ptp voltam ao sair: 'edit'
  // pra quem desbloqueou o modo desenvolvedor (útil ficar ali, é onde se
  // edita pontos/lotes), 'ptp' pra todo mundo mais — nunca 'edit' sem
  // devMode, senão a aba escondida no Toolbar (ver Toolbar.jsx) ficaria
  // inútil: o app já cairia sozinho no modo que ela deveria trancar.
  function baseMode() {
    return devMode ? 'edit' : 'ptp';
  }

  // Modo de marcação de ocupação: botão flutuante próprio (ver
  // FloorPlanCanvas), não é uma aba do Toolbar. Sair sempre volta pro modo
  // de repouso — é uma ação de manutenção pontual, não um estado que
  // precise "lembrar" onde você estava antes.
  function handleToggleMarkMode() {
    setMode((m) => (m === 'mark' ? baseMode() : 'mark'));
    resetSelection();
  }

  // Ponto a Ponto: mesmo padrão do modo de marcação acima — só acessível
  // pelo botão flutuante (ícone de rota), não pelo Toolbar. Pra quem não é
  // dev, ptp JÁ é o modo de repouso — sair dele não muda nada (baseMode()
  // devolve 'ptp' de novo), o que é o comportamento certo.
  function handleTogglePtpMode() {
    setMode((m) => (m === 'ptp' ? baseMode() : 'ptp'));
    resetSelection();
  }

  // "{ }" no canto do Toolbar: entra pedindo senha (ver DevModeModal);
  // sair não pede nada (só destrancar precisa de senha). Se a saída
  // acontecer com mode ainda em 'edit' (usuário tava mexendo em
  // pontos/lotes), volta pro modo de repouso — sem isso o app ficaria
  // preso numa tela de edição inacessível por qualquer botão depois de
  // trancar.
  function handleDevButtonClick() {
    if (devMode) {
      setDevMode(false);
      setMode((m) => (m === 'edit' ? 'ptp' : m));
      resetSelection();
    } else {
      setDevModalOpen(true);
    }
  }

  function handleDevModalSubmit(password) {
    if (password !== DEV_PASSWORD) return false;
    setDevMode(true);
    setDevModalOpen(false);
    showToast('Modo desenvolvedor ativado.', 'success');
    return true;
  }

  function handleDevModalClose() {
    setDevModalOpen(false);
  }

  // Caso 3 (regra de fronteira): dentro de um mesmo lote, uma célula
  // ocupada bloqueia qualquer posição "atrás" dela (numeração maior) como
  // destino — o robô não faz desvio lateral numa coluna/fileira de pallets,
  // só entra por uma ponta e sai pela mesma. Só vale dentro do MESMO lote
  // (da vista atual); pontos avulsos e lotes diferentes não têm ordem
  // entre si, então não têm essa restrição.
  function findLotCellPosition(name) {
    for (const lot of lots) {
      for (let i = 0; i < lot.count; i++) {
        if (lotCellName(lot.prefix, i) === name) return { lot, index: i };
      }
    }
    return null;
  }

  function isPickupAllowed(name) {
    const pos = findLotCellPosition(name);
    if (!pos) return true; // ponto avulso — sem regra de fronteira
    if (!occupied.includes(name)) return false; // precisa ter pallet ali pra pegar
    for (let i = 0; i < pos.index; i++) {
      if (occupied.includes(lotCellName(pos.lot.prefix, i))) return false; // bloqueado antes de chegar
    }
    return true;
  }

  function isDropoffAllowed(name) {
    const pos = findLotCellPosition(name);
    if (!pos) return true;
    for (let i = 0; i <= pos.index; i++) {
      if (occupied.includes(lotCellName(pos.lot.prefix, i))) return false; // ela mesma ou alguma antes está ocupada
    }
    return true;
  }

  function handleStartAddPoint() {
    setSelectedId(null);
    setSelectedLotId(null);
    setAddTool('point');
  }

  function handleStartAddLot() {
    const prefix = window.prompt('Prefixo do lote (ex: A) — vira o nome da 1ª célula, as seguintes ganham número:');
    if (!prefix || !prefix.trim()) return;
    setSelectedId(null);
    setSelectedLotId(null);
    setPendingLotPrefix(prefix.trim());
    setAddTool('lot');
  }

  function handleCancelAdd() {
    setAddTool(null);
    setPendingLotPrefix('');
  }

  function handleAddPoint(x, y) {
    const id = addPoint(x, y);
    setAddTool(null);
    setSelectedId(id);
  }

  function handleAddLot({ x, y, rotation, count }) {
    const id = addLot({ prefix: pendingLotPrefix, x, y, rotation, count });
    setAddTool(null);
    setPendingLotPrefix('');
    setSelectedLotId(id);
  }

  function handleSelectPoint(id) {
    setSelectedId(id);
    if (id) setSelectedLotId(null);
  }

  function handleSelectLot(id) {
    setSelectedLotId(id);
    if (id) setSelectedId(null);
  }

  function handleRename(id, name) {
    updatePoint(id, { name });
  }

  function handleDelete(id) {
    removePoint(id);
    if (selectedId === id) setSelectedId(null);
  }

  function handleRenameLotPrefix(id, prefix) {
    updateLot(id, { prefix });
  }

  function handleDeleteLot(id) {
    removeLot(id);
    if (selectedLotId === id) setSelectedLotId(null);
  }

  function handleSetLotColor(id, color) {
    updateLot(id, { color });
  }

  function handleToggleLotNames(id) {
    const lot = lots.find((l) => l.id === id);
    if (lot) updateLot(id, { namesVisible: !lot.namesVisible });
  }

  function handlePointToPointClick(name) {
    if (name === pickupName) { setPickupName(null); setDropoffName(null); return; }
    if (name === dropoffName) { setDropoffName(null); return; }
    if (!pickupName) {
      if (!isPickupAllowed(name)) {
        showToast('Não dá pra pegar em ' + name + ': precisa ter pallet ali e nada ocupado antes dela no lote.', 'error');
        return;
      }
      setPickupName(name);
      return;
    }
    if (!isDropoffAllowed(name)) {
      showToast('Não dá pra soltar em ' + name + ': ela ou alguma posição antes dela no lote está ocupada.', 'error');
      return;
    }
    setDropoffName(name);
  }

  function handleClearSelection() {
    setPickupName(null);
    setDropoffName(null);
  }

  // Dispara uma rota de verdade pro robô. asPending=false (padrão) vira a
  // "atual"; asPending=true vira a "pendente" — já enviada, mas o dispatch
  // segura ela até a atual terminar (é isso que evita o desvio pra carga
  // quando JÁ tem uma rota rodando). Chamada pelo envio manual, pelo
  // enfileiramento antecipado (handleEnqueueRoute) e pela promoção
  // automática (advanceQueue) — nunca de dentro de um updater funcional de
  // setState (mesmo motivo do bug do lote duplicado: StrictMode invoca
  // updaters 2x, e isso tem efeito colateral).
  async function fireRoute(route, { asPending = false } = {}) {
    if (!asPending) setSending(true);
    try {
      // Disparar como "atual" só acontece a partir de um estado ocioso — e
      // o robô, ao ficar sem nenhuma task na lista, sempre cria uma task
      // automática de ida pra carga sozinho (mesma prioridade de uma task
      // normal: se já estiver rodando, uma task-fast nova não a interrompe,
      // só fica pendente atrás dela). Pra evitar isso SEM cair numa corrida
      // (cancelar antes deixaria uma janela de fila vazia, tempo
      // suficiente do robô recriar a task de carga de novo antes da nossa
      // chegar — foi o que causou o "para e volta pra energia"): descobre
      // o id da task de carga ANTES de disparar (se cancelar depois de
      // disparar, o registro mais recente já seria o nosso, não a dela),
      // dispara a rota nova (fica pendente atrás da carga, fila nunca some
      // a zero), e só então cancela a carga especificamente por id — nunca
      // all-cancel aqui, que pegaria a rota nova recém-criada junto.
      const chargeTaskId = !asPending ? await findActiveChargeTaskId().catch(() => null) : null;

      // O nome de verdade usado no dispatch service tem um sufixo de
      // timestamp (evita colisão em rotas repetidas, ver comentário em
      // createAndRunRoute) — guarda ele em vez de recalcular, senão a
      // sondagem abaixo procuraria pelo nome errado.
      const { name } = await createAndRunRoute(route.pickup, route.dropoff, route.palletType);

      if (chargeTaskId) {
        try {
          await cancelTaskRecord(chargeTaskId);
        } catch {
          // melhor esforço só — a rota nova já foi disparada de qualquer
          // jeito, só fica esperando a carga terminar em vez de ser
          // priorizada
        }
      }

      // Histórico (painel "Histórico", modo desenvolvedor) — melhor
      // esforço, nunca deve travar/derrubar o disparo real da rota por
      // causa de uma falha só no registro.
      logRouteRequested({ id: route.id, pickup: route.pickup, dropoff: route.dropoff, taskName: name }).catch(() => {});

      const fired = { ...route, taskName: name };
      if (asPending) {
        setPendingRoute(fired);
        showToast('Próxima rota já na fila do robô: ' + route.pickup + ' → ' + route.dropoff, 'info');
      } else {
        setCurrentRoute(fired);
        showToast('Rota iniciada: ' + route.pickup + ' → ' + route.dropoff, 'success');
      }
    } catch (err) {
      showToast('Erro ao enviar rota: ' + err.message, 'error');
    } finally {
      if (!asPending) setSending(false);
    }
  }

  async function handleEnqueueRoute() {
    if (!pickupName || !dropoffName) return;
    // palletType vai junto com a rota no momento da seleção, não é relido
    // depois — se o operador trocar o pallet selecionado enquanto essa
    // rota ainda está na fila local, a rota já enfileirada continua com o
    // tipo que valia quando ela foi montada.
    const route = { id: generateId(), pickup: pickupName, dropoff: dropoffName, palletType };

    if (!currentRoute) {
      await fireRoute(route);
    } else if (!pendingRoute) {
      // Já tem uma rodando, mas o dispatch ainda não sabe de nenhuma
      // seguinte — manda essa já, pra ele segurar como "próxima" e não
      // desviar pra carga sozinho quando a atual terminar.
      await fireRoute(route, { asPending: true });
    } else {
      setRouteQueue((prev) => [...prev, route]);
      showToast('Rota adicionada à fila: ' + route.pickup + ' → ' + route.dropoff, 'info');
    }
    handleClearSelection();
  }

  // Chamado quando a rota atual termina de verdade (status FINISHED).
  function advanceQueue() {
    const pending = pendingRouteRef.current;
    if (pending) {
      // Já estava rodando no dispatch (disparada com antecedência) — só
      // promove localmente, sem disparar de novo. Se tiver mais alguma
      // coisa esperando só localmente, manda ela agora como a nova
      // pendente, mantendo o dispatch sempre com uma "próxima" conhecida.
      setCurrentRoute(pending);
      setPendingRoute(null);
      const queue = routeQueueRef.current;
      if (queue.length > 0) {
        const [next, ...rest] = queue;
        setRouteQueue(rest);
        fireRoute(next, { asPending: true });
      }
      return;
    }

    // Não tinha nada pré-enfileirado no dispatch (ex: a fila local estava
    // vazia quando a atual começou a rodar) — o robô pode já ter desviado
    // sozinho pra carga (comportamento padrão dele ao não ter próxima
    // task). fireRoute (asPending=false) já cancela esse desvio antes de
    // disparar, como melhor esforço.
    const queue = routeQueueRef.current;
    if (queue.length === 0) {
      setCurrentRoute(null);
      return;
    }
    const [next, ...rest] = queue;
    setRouteQueue(rest);
    fireRoute(next);
  }

  // Sondagem de status da rota em andamento — valida contra GET
  // /task-record/page (ver conversa: enum de status confirmado no robô real
  // inclui WAITING/FINISHED/CANCELLED). Filtra pelo nome único de verdade
  // (currentRoute.taskName, com o sufixo de timestamp — ver createAndRunRoute),
  // não pelo nome "base" pickup+dropoff, que pode se repetir entre disparos.
  // FINISHED promove a próxima da fila sozinho; CANCELLED (por fora do app —
  // ex: alguém cancelou na plataforma do robô) só limpa a atual, não promove
  // — mesma cautela do cancelamento manual. Qualquer outro status (ex: em
  // execução) simplesmente continua sondando.
  //
  // Caso 2 da marcação de ocupação (ver CONTEXT.md): o mesmo tick também
  // acompanha o progresso POR AÇÃO dentro da task (GET
  // /action-record/list/{id}), pra desmarcar a origem assim que o PICKUP
  // terminar — sem esperar a UNLOAD, que só finaliza a task inteira.
  // Detecta isso via finishTime não-nulo na ação de serialNumber 1, não
  // pelo texto de status (nunca vimos o valor de uma ação concluída com
  // sucesso — só "CANCELLED" uma vez). Ao terminar tudo (FINISHED), marca o
  // destino como ocupado (pallet entregue). setOccupiedState é
  // determinístico, não o toggle usado pelo clique manual — evita
  // desmarcar/remarcar em falso se o poll rodar mais de uma vez antes da
  // condição deixar de valer.
  useEffect(() => {
    if (!currentRoute) return;
    const name = currentRoute.taskName;
    let cancelled = false;
    // setCurrentRoute não atualiza currentRoute na hora (React é
    // assíncrono) — sem essa trava local, um segundo tick do polling
    // poderia ver FINISHED de novo antes do estado mudar e promover a fila
    // duas vezes pra mesma rota.
    let settled = false;
    let pickupCleared = false;

    async function poll() {
      if (settled) return;
      let record;
      try {
        record = await fetchLatestTaskRecord(name);
      } catch {
        return; // falha de rede pontual — tenta de novo no próximo ciclo
      }
      if (cancelled || settled || !record) return;

      if (!pickupCleared) {
        try {
          const actions = await fetchActionRecords(record.id);
          const pickupAction = actions.find((a) => a.serialNumber === 1);
          if (pickupAction && pickupAction.finishTime) {
            pickupCleared = true;
            setOccupiedState(currentRoute.pickup, false);
          }
        } catch {
          // melhor esforço — tenta de novo no próximo ciclo
        }
        if (cancelled || settled) return;
      }

      if (record.status === 'FINISHED') {
        settled = true;
        setOccupiedState(currentRoute.dropoff, true);
        showToast('Rota concluída: ' + currentRoute.pickup + ' → ' + currentRoute.dropoff, 'success');
        logRouteCompleted({ id: currentRoute.id, status: 'finished' }).catch(() => {});
        advanceQueue();
      } else if (record.status === 'CANCELLED') {
        settled = true;
        showToast('Rota cancelada fora do app: ' + currentRoute.pickup + ' → ' + currentRoute.dropoff, 'error');
        logRouteCompleted({ id: currentRoute.id, status: 'cancelled' }).catch(() => {});
        setCurrentRoute(null);
      }
    }

    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoute]);

  // Mesmo mecanismo do botão de emergência da versão anterior (all-cancel no
  // dispatch-service) — cancela de verdade, para o robô. all-cancel derruba
  // TUDO que estiver ativo/pendente pro projeto — se já existia uma
  // pendingRoute (disparada com antecedência pro dispatch), ela também é
  // cancelada de verdade no robô, então precisa sumir do estado local
  // também, senão o app ficaria achando que ainda tem uma "próxima" pronta
  // quando na verdade não tem mais nada. Só limpa se a chamada realmente
  // funcionou, senão a UI ficaria mostrando "nada em andamento" com o robô
  // possivelmente ainda executando. Não promove routeQueue (parada de
  // emergência, não "terminou, pode seguir") — quem quiser retomar manda
  // de novo pelo Ponto a Ponto.
  async function handleCancelCurrent() {
    if (!currentRoute) return;
    try {
      await cancelAllTasks();
      logRouteCompleted({ id: currentRoute.id, status: 'cancelled' }).catch(() => {});
      if (pendingRoute) logRouteCompleted({ id: pendingRoute.id, status: 'cancelled' }).catch(() => {});
      setCurrentRoute(null);
      setPendingRoute(null);
      showToast('Rota cancelada — robô parado.', 'success');
    } catch (err) {
      showToast('Erro ao cancelar: ' + err.message, 'error');
    }
  }

  // Rota ainda só local (nunca chegou a ser enviada) — remover é só estado
  // local. Já a pendingRoute foi de fato disparada pro robô (ver
  // fireRoute/asPending) — não tem como "esquecer" ela sem cancelar de
  // verdade, e cancelar de verdade (all-cancel) derrubaria a atual junto,
  // que não é a intenção de quem só quer tirar a PRÓXIMA da fila.
  function handleRemoveQueued(id) {
    if (pendingRoute && pendingRoute.id === id) {
      showToast('Essa rota já foi enviada ao robô — cancele a atual (que para tudo) se não quiser mais que ela rode.', 'info');
      return;
    }
    setRouteQueue((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <div className="app">
      <Toolbar
        mode={mode}
        onModeChange={handleModeChange}
        addTool={addTool}
        onStartAddPoint={handleStartAddPoint}
        onStartAddLot={handleStartAddLot}
        onCancelAdd={handleCancelAdd}
        saveStatus={saveStatus}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        devMode={devMode}
        onDevButtonClick={handleDevButtonClick}
      />

      <div className="app__body">
        {/*
          Sem seleção ativa, o mapa mostra a rota em andamento em vez de
          nada — quando currentRoute é promovido pra próxima da fila
          (automático, ver useEffect de sondagem acima), o destaque já
          segue sozinho, sem precisar mexer aqui.
        */}
        <FloorPlanCanvas
          points={points}
          lots={lots}
          mode={mode}
          addTool={addTool}
          pendingLotPrefix={pendingLotPrefix}
          onAddPoint={handleAddPoint}
          onAddLot={handleAddLot}
          onUpdatePoint={updatePoint}
          onUpdateLot={updateLot}
          selectedId={selectedId}
          onSelectPoint={handleSelectPoint}
          selectedLotId={selectedLotId}
          onSelectLot={handleSelectLot}
          pickupName={pickupName || currentRoute?.pickup || null}
          dropoffName={dropoffName || currentRoute?.dropoff || null}
          onPointToPointClick={handlePointToPointClick}
          view={view}
          onToggleView={handleToggleView}
          occupiedNames={occupied}
          onMarkOccupied={setOccupiedMany}
          markModeActive={mode === 'mark'}
          onToggleMarkMode={handleToggleMarkMode}
          ptpModeActive={mode === 'ptp'}
          onTogglePtpMode={handleTogglePtpMode}
        />

        {mode === 'edit' && (
          <aside className="sidebar">
            <PointsPanel
              points={points}
              selectedId={selectedId}
              onSelect={handleSelectPoint}
              onRename={handleRename}
              onDelete={handleDelete}
            />
            <LotsPanel
              lots={lots}
              selectedLotId={selectedLotId}
              onSelect={handleSelectLot}
              onRenamePrefix={handleRenameLotPrefix}
              onDelete={handleDeleteLot}
              onSetColor={handleSetLotColor}
              onToggleNames={handleToggleLotNames}
            />
          </aside>
        )}
        {mode === 'ptp' && (
          <aside className="sidebar">
            <PointToPointBar
              pickupName={pickupName}
              dropoffName={dropoffName}
              onClear={handleClearSelection}
              onSend={handleEnqueueRoute}
              sending={sending}
              willQueue={!!currentRoute}
              palletType={palletType}
              onPalletTypeChange={setPalletType}
            />
            <RouteQueue
              currentRoute={currentRoute}
              queue={pendingRoute ? [pendingRoute, ...routeQueue] : routeQueue}
              onCancelCurrent={handleCancelCurrent}
              onRemoveQueued={handleRemoveQueued}
            />
          </aside>
        )}
        {mode === 'mark' && (
          <aside className="sidebar">
            <OccupancyPanel occupied={occupied} onToggle={toggleOccupied} />
          </aside>
        )}
        {mode === 'history' && (
          <aside className="sidebar sidebar--history">
            <HistoryPanel />
          </aside>
        )}
      </div>

      <Toast toast={toast} />
      <DevModeModal open={devModalOpen} onSubmit={handleDevModalSubmit} onClose={handleDevModalClose} />
    </div>
  );
}
