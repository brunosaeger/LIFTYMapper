import { useState, useEffect, useRef } from 'react';
import Toolbar from './components/Toolbar';
import CloseUpStatusBanner from './components/CloseUpStatusBanner';
import CancelPendingBanner from './components/CancelPendingBanner';
import PointsPanel from './components/PointsPanel';
import LotsPanel from './components/LotsPanel';
import CloseUpsPanel from './components/CloseUpsPanel';
import PalletHeightsPanel from './components/PalletHeightsPanel';
import PointToPointBar from './components/PointToPointBar';
import StagedTasksPanel from './components/StagedTasksPanel';
import QueuePanel from './components/QueuePanel';
import OccupancyPanel from './components/OccupancyPanel';
import HistoryPanel from './components/HistoryPanel';
import UsersPanel from './components/UsersPanel';
import FloorPlanCanvas from './components/FloorPlanCanvas';
import Toast from './components/Toast';
import DevModeModal from './components/DevModeModal';
import { useCalibration, lotCellName, displayCellName } from './hooks/useCalibration';
import { useLiveState } from './hooks/useLiveState';
import { useToast } from './hooks/useToast';
import { saveTheme, saveFullscreen } from './api/auth';
import { applyTheme } from './theme';
// App.css já é carregado pelo App.jsx (raiz) — precisa estar disponível
// mesmo antes de MainApp montar, pra estilizar a LoginScreen.

// Só um gate de UI local (esconder edição de quem tá mexendo no tablet no
// dia a dia) — não é segurança de verdade, a senha fica visível em texto no
// bundle JS pra quem abrir o devtools. Não guardar nada sensível atrás
// disso.
const DEV_PASSWORD = 'ripandtear2002';


// Prefixo do toast de "Iniciar tarefas" conforme o slot que o servidor devolve
// (ver POST /api/queue/enqueue, campo "slot") — o cliente não sabe mais
// sozinho se a rota virou atual/pendente/fila, quem decide é o servidor.
// Referência estável pra "nada selecionado" (ver mapPickupNames) — um `[]`
// inline viraria um array novo a cada render, sem necessidade.
const EMPTY_SELECTION = [];

const TOAST_BY_SLOT = {
  current: 'Rota iniciada: ',
  pending: 'Próxima rota já na fila do robô: ',
  queued: 'Rota adicionada à fila: ',
};

// Só é montado depois de sessão confirmada (ver App.jsx) — user aqui nunca
// é null/undefined, sempre { username, isAdmin }. Isso evita o problema de
// useCalibration/etc dispararem fetch autenticado ANTES de haver sessão
// (o efeito de carga roda uma vez só, no mount — se rodasse com a sessão
// ainda não confirmada, um login bem-sucedido depois não teria como
// re-disparar essa carga sem um refresh de página).
export default function MainApp({ user, onLogout }) {
  const {
    // setView não é mais chamado por nada na UI — o botão que trocava de
    // vista virou o modo Interação (ver handleToggleInteractionMode). A
    // vista fica travada em 'top' daqui pra frente; 'iso' é legado
    // inatingível (ver CONTEXT.md, "Duas vistas independentes").
    view,
    points, addPoint, updatePoint, removePoint,
    lots, addLot, updateLot, removeLot,
    closeUps, addCloseUp, updateCloseUp, removeCloseUp,
    palletHeights, savePalletHeights,
    status: saveStatus,
  } = useCalibration();
  // Estado ao vivo compartilhado entre dispositivos (ver CONTEXT.md, "Fila
  // de rotas compartilhada") — currentRoute/pendingRoute/routeQueue/
  // occupied vêm do servidor (polling), e as ações abaixo mandam intenções
  // pra ele em vez de mudar estado local direto (quem decide/dispara de
  // verdade é sempre o server.py, nunca o navegador).
  const {
    currentRoute, pendingRoute, routeQueue, occupied, emergency, cancelPending, cancelPendingMessage, turnBlockedMessage, awaitingChargeMessage, postPickupUnloadMessage, robotCharging, robotBattery, robotReturningToCharge, robotStalledMessage,
    enqueueRoutes, cancelCurrent, removeQueued, setOccupiedMany, toggleOccupied, setEmergency, setLimitBreakerLease,
  } = useLiveState();
  const [toast, showToast] = useToast();

  // Tema claro/escuro (botão lua/sol no Toolbar) — preferência da CONTA,
  // guardada em users.json e entregue junto da sessão (ver server.py). Era
  // localStorage antes, ou seja, por dispositivo: quem trocava de tablet
  // tinha que reconfigurar toda vez. Como o `user` já chega resolvido do
  // App.jsx, o app monta direto no tema certo, sem piscar no outro.
  const [theme, setTheme] = useState(user.theme === 'light' ? 'light' : 'dark');

  // Aplica o tema nos dois lugares que precisam saber: o atributo no
  // <html> (pro CSS via :root[data-theme='light'], index.css) e o
  // theme.js:COLORS (pro Konva, que não lê CSS custom property nenhuma —
  // ver comentário lá). O re-render do FloorPlanCanvas que essa troca de
  // estado já dispara é o que faz o canvas redesenhar com as cores novas
  // (COLORS é o mesmo objeto sempre, só muta as propriedades em lugar).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    applyTheme(theme);
  }, [theme]);

  function handleToggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // Fora do updater de propósito: StrictMode invoca updaters duas vezes,
    // e isso aqui é efeito colateral (mesma armadilha comentada em
    // fireRoute na época da fila local). Melhor esforço — se a gravação
    // falhar, o tema já valeu nesta sessão e só não persiste pra próxima.
    saveTheme(next).catch(() => {});
  }

  // Preferência de tela cheia da CONTA (pedido do usuário, 2026-10-01) —
  // mesmo espírito do tema acima (persiste por conta, não por tablet), mas
  // com uma pegada a mais: a API de Fullscreen do navegador só entra em
  // tela cheia dentro de um gesto do usuário (toque/clique) — nenhum
  // navegador deixa isso disparar sozinho ao carregar a página. `wantsFull`
  // é a PREFERÊNCIA (o que a conta quer, persistido no servidor);
  // `isFullscreen` é o estado DE FATO do navegador agora (pode discordar
  // brevemente — ex. acabou de logar e ainda não tocou em nada, ou saiu de
  // tela cheia pelo gesto do próprio Android).
  const [wantsFullscreen, setWantsFullscreen] = useState(!!user.fullscreen);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);

  useEffect(() => {
    function onChange() { setIsFullscreen(!!document.fullscreenElement); }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Reentrada silenciosa: se a conta quer tela cheia mas o navegador não
  // está nela agora (ex. acabou de logar), aproveita o PRIMEIRO toque em
  // qualquer lugar do app — que vai acontecer de qualquer jeito, é um
  // tablet de operação — pra satisfazer a exigência de gesto do usuário,
  // sem precisar de um botão/aviso extra pedindo pra tocar em algo.
  // Melhor esforço: se o navegador recusar (ex. toque não contou como
  // gesto válido por algum motivo), não insiste — o botão manual continua
  // disponível no Toolbar.
  useEffect(() => {
    if (!wantsFullscreen || isFullscreen) return;
    function tryEnter() {
      document.removeEventListener('pointerdown', tryEnter, true);
      if (document.fullscreenElement) return;
      document.documentElement.requestFullscreen().catch(() => {});
    }
    document.addEventListener('pointerdown', tryEnter, true);
    return () => document.removeEventListener('pointerdown', tryEnter, true);
  }, [wantsFullscreen, isFullscreen]);

  // Botão no Toolbar: ESTE clique já É o gesto do usuário, então pode
  // chamar request/exitFullscreen direto, sem esperar o próximo toque.
  function handleToggleFullscreen() {
    const next = !wantsFullscreen;
    setWantsFullscreen(next);
    saveFullscreen(next).catch(() => {});
    if (next) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  // 'edit' só é alcançável em modo desenvolvedor (ver handleDevButtonClick e
  // baseMode abaixo) — o padrão pra quem não desbloqueou é 'ptp', o modo
  // operacional do dia a dia.
  const [mode, setMode] = useState('ptp'); // 'edit' | 'ptp' | 'mark' | 'queue'
  const [addTool, setAddTool] = useState(null); // null | 'point' | 'lot'
  const [pendingLotPrefix, setPendingLotPrefix] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedLotId, setSelectedLotId] = useState(null);
  const [selectedCloseUpId, setSelectedCloseUpId] = useState(null);
  // Painel Fila: qual rota da lista de espera está "isolada" no mapa agora
  // (null = mostra a rota em andamento, o padrão — ver mapPickupNames
  // abaixo). Bolinha de notificação: quantas tasks foram solicitadas desde
  // a última vez que o painel foi aberto (zerada em handleToggleQueueMode).
  const [selectedQueueRouteId, setSelectedQueueRouteId] = useState(null);
  const [queueNotifCount, setQueueNotifCount] = useState(0);
  // Painel Histórico: qual entrada foi clicada, pra destacar origem/destino
  // no mapa (ver mapPickupNames abaixo) — guarda o par direto (o painel já
  // tem a entrada inteira em mãos, sem precisar re-achar por id como no
  // painel Fila). null = nada selecionado (comportamento de sempre).
  // `historyFocusedEndpoint` ('pickup'|'dropoff'|null): qual ponta está
  // sendo vista no mapa agora (banner "VISUALIZANDO", ver
  // handleSelectHistoryEntry/handleFocusEndpoint) — mesmo espírito do
  // `viewTask.active` do Ponto a Ponto, só que pro Histórico.
  const [selectedHistoryRoute, setSelectedHistoryRoute] = useState(null);
  const [historyFocusedEndpoint, setHistoryFocusedEndpoint] = useState(null);
  // Banner "VISUALIZANDO: KANBAN X" (CloseUpStatusBanner.jsx): qual Close Up
  // o operador tocou por último no modo Interação. Zerado em qualquer troca
  // de modo (ver resetSelection abaixo, SEM keepRoute — não é seleção de
  // ptp) e ao resetar o zoom (ver onCloseUpActivate passado pro
  // FloorPlanCanvas, chamado com null de dentro de handleResetView).
  const [activeCloseUpId, setActiveCloseUpId] = useState(null);
  // Pulsar vermelho no ponto/célula clicado com seleção INVÁLIDA (Caso 3,
  // vazio na coleta, já ocupado na entrega, ordem errada em "Lotes em
  // sequência") — ver triggerInvalidPulse/useInvalidPulse
  // (FloorPlanCanvas.jsx). `id` incrementa a CADA disparo (pulseIdRef, não
  // reseta) — é ele que dispara a animação de novo mesmo clicando o MESMO
  // ponto inválido duas vezes seguidas; sem isso o efeito não teria como
  // saber que houve um NOVO clique (o nome sozinho não muda). Nunca
  // precisa ser limpo depois: a animação é 100% imperativa (Konva), o
  // estado React só serve pra disparar o efeito uma vez.
  const [invalidPulse, setInvalidPulse] = useState(null); // { name, id }
  const pulseIdRef = useRef(0);

  function triggerInvalidPulse(name) {
    pulseIdRef.current += 1;
    setInvalidPulse({ name, id: pulseIdRef.current });
  }

  // Modo desenvolvedor: libera a aba "Editar pontos" e os botões "+ Ponto"/
  // "+ Lote" no Toolbar (ver Toolbar.jsx) — sem ele, mode nunca chega a
  // 'edit' por nenhum caminho alcançável da UI (ver baseMode/
  // handleDevButtonClick). Não persiste entre reloads de propósito — é uma
  // trava de sessão, não uma preferência salva.
  const [devMode, setDevMode] = useState(false);
  const [devModalOpen, setDevModalOpen] = useState(false);
  // "Limit breaker" (botão do Doomguy, só em modo desenvolvedor): enquanto
  // ligado, cancelar a rota em andamento pula TODO o tratamento de
  // cancelamento seguro (espera de giro/alinhamento de docking) — pra testar
  // rápido. Só memória desta página, de propósito: recarregar, reiniciar ou
  // sair do modo desenvolvedor sempre desliga (o servidor também não guarda
  // nada — o `force` vai por requisição), pra nunca ficar ligado esquecido.
  const [limitBreaker, setLimitBreaker] = useState(false);
  const limitBreakerOn = devMode && limitBreaker;

  // Enquanto ligado, renova a licença no servidor bem antes dela vencer
  // (LIMIT_BREAKER_LEASE_SECONDS = 12s lá). Desligar/sair do modo dev/
  // desmontar manda "off" na hora; recarregar ou fechar a aba simplesmente
  // para de renovar e o servidor desliga sozinho em segundos.
  useEffect(() => {
    if (!limitBreakerOn) return undefined;
    let cancelled = false;
    function renew() {
      setLimitBreakerLease(true).catch((err) => {
        if (cancelled) return;
        setLimitBreaker(false);
        showToast('Limit breaker não ligou no servidor (' + err.message + ') — reinicie o server.py se ele for de antes dessa função.', 'error');
      });
    }
    renew();
    const timer = setInterval(renew, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      setLimitBreakerLease(false).catch(() => {});
    };
  }, [limitBreakerOn, setLimitBreakerLease, showToast]);

  function handleToggleLimitBreaker() {
    const next = !limitBreaker;
    setLimitBreaker(next);
    showToast(
      next ? 'LIMIT BREAKER ligado — sem travas de cancelamento nem de início de tarefas.' : 'Limit breaker desligado — travas de segurança de volta.',
      next ? 'error' : 'success',
    );
  }

  // Listas (não nomes soltos) porque o modo "Lotes em sequência" seleciona
  // vários de uma vez — ver CONTEXT.md. Fora dele, ficam com no máximo 1
  // nome cada, e todo o comportamento antigo continua idêntico.
  const [pickupNames, setPickupNames] = useState([]);
  const [dropoffNames, setDropoffNames] = useState([]);
  // "Lotes em sequência" (checkbox no PointToPointBar): permite montar N
  // pares origem→destino de uma vez, pra descarregar uma coluna inteira sem
  // esperar cada task terminar. Desligado por padrão.
  const [sequenceMode, setSequenceMode] = useState(false);
  // Qual slot está recebendo os cliques do mapa ('pickup' | 'dropoff') — só
  // importa em sequência, onde o usuário troca clicando no slot. No modo
  // normal a alternância continua automática (primeiro clique = origem,
  // segundo = destino).
  const [activeSlot, setActiveSlot] = useState('pickup');
  // Diferenciação de pallets (ver CONTEXT.md) — azul vem selecionado por
  // padrão porque é o mais comum na planta. Não é resetado por
  // resetSelection: é uma preferência de "com que pallet estou trabalhando
  // agora", independente de qual origem/destino está selecionado no
  // momento.
  const [palletType, setPalletType] = useState('blue'); // 'wood' | 'blue'
  // "Pallet de cima": 2º andar do pallet azul de dois níveis (layer 3,
  // altura configurável no editor). Só faz sentido com azul. Também NÃO é
  // resetado por resetSelection — é preferência de sessão, igual palletType.
  // Pedido do usuário (2026-10-05): a opção de marcar isso ficou fora da
  // versão final (removida de PointToPointBar/StagedTasksPanel) — este
  // estado fica sempre false agora, dormente, mas o restante da
  // canalização (payload pro servidor, StagedTasksPanel) continua intacto
  // caso a feature volte depois.
  const [palletTop, setPalletTop] = useState(false);

  // "Tarefas aguardando envio" (ver StagedTasksPanel.jsx e CONTEXT.md):
  // "Enviar tarefa" não manda mais direto pro robô — a tarefa entra nesta
  // lista local, onde dá pra conferir, reordenar, trocar pallet ou editar,
  // e só "Iniciar tarefas" manda tudo pro servidor. Cada item é uma
  // UNIDADE: uma tarefa avulsa, ou um grupo inteiro de "Lotes em
  // sequência" (groupKey preenchido) — o grupo só se move junto e divide o
  // mesmo pallet. Estado deste dispositivo só (não é compartilhado entre
  // tablets — nada disso existe no servidor até o "Iniciar").
  const [stagedUnits, setStagedUnits] = useState([]);
  // Unidade sendo editada (tocar numa barrinha): a origem/destino dela vão
  // pra seleção do Ponto a Ponto (e pro mapa, ampliados), e "Enviar" vira
  // "Salvar alterações". editPrevRef guarda as preferências de sessão
  // (sequência/pallet) de antes, pra devolver ao sair da edição.
  const [editingUnitId, setEditingUnitId] = useState(null);
  const editPrevRef = useRef(null);
  // "Visualizar tarefa": qual tarefa (índice dentro da unidade em edição) o
  // banner mostra, e qual ponta está sendo vista no mapa. Só existe junto
  // com editingUnitId. focusRequest é o pedido pro mapa dar zoom até o
  // kanban onde o ponto está (`id` muda a cada pedido, ver FloorPlanCanvas).
  const [viewTask, setViewTask] = useState(null); // { index, active: 'pickup' | 'dropoff' }
  const [focusRequest, setFocusRequest] = useState(null);
  const focusIdRef = useRef(0);

  function requestFocus(name) {
    if (!name) return;
    focusIdRef.current += 1;
    setFocusRequest({ name, id: focusIdRef.current });
  }

  // Painel Usuários, seletor de "KANBANS" (pedido do usuário, 2026-10-01):
  // mesmo espírito de focusRequest acima, mas focando um Close Up DIRETO
  // pelo id (o admin está escolhendo um kanban, não um ponto/tarefa) — zoom
  // + contorno tracejado (ver FloorPlanCanvas.jsx, closeUpFocusRequest/
  // CloseUpMarker previewing) pra confirmar visualmente qual área é.
  const [closeUpFocusRequest, setCloseUpFocusRequest] = useState(null);
  const closeUpFocusIdRef = useRef(0);

  function requestCloseUpFocus(closeUpId) {
    if (!closeUpId) return;
    closeUpFocusIdRef.current += 1;
    setCloseUpFocusRequest({ closeUpId, reqId: closeUpFocusIdRef.current });
  }
  const [starting, setStarting] = useState(false);
  const stagedIdRef = useRef(0);
  const editingIndex = editingUnitId ? stagedUnits.findIndex((u) => u.id === editingUnitId) : -1;
  const editingUnit = editingIndex >= 0 ? stagedUnits[editingIndex] : null;
  const stagedBeforeSelection = editingIndex >= 0 ? stagedUnits.slice(0, editingIndex) : stagedUnits;

  function newStagedId(prefix) {
    stagedIdRef.current += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + stagedIdRef.current;
  }

  // keepRoute: true preserva pickupNames/dropoffNames/activeSlot — usado só
  // ao entrar/sair do modo Interação (ver handleToggleInteractionMode): é
  // um modo de "só olhar/mexer em outra coisa" — Interação (dar zoom numa
  // área de Close Up pra conferir um lote de longe) e Marcação (corrigir
  // uma ocupação errada) — não deveria derrubar uma seleção de Ponto a
  // Ponto em andamento — o operador precisa poder resolver aquilo e voltar
  // pro ptp com a origem/destino ainda escolhidos. Nos outros modos (edit,
  // queue, closeup, history, users, ou sair do próprio ptp) a seleção
  // continua sendo limpa — trocar pra eles é uma intenção diferente o
  // suficiente pra justificar recomeçar. Ver isPeekMode/resetSelection
  // abaixo.
  function isPeekMode(m) {
    return m === 'interaction' || m === 'mark';
  }

  function resetSelection({ keepRoute = false } = {}) {
    setAddTool(null);
    setPendingLotPrefix('');
    setSelectedId(null);
    setSelectedLotId(null);
    setSelectedCloseUpId(null);
    setSelectedQueueRouteId(null);
    setSelectedHistoryRoute(null);
    setHistoryFocusedEndpoint(null);
    setActiveCloseUpId(null); // banner "VISUALIZANDO: KANBAN X" — nunca sobrevive a uma troca de modo, nem entrando/saindo de Interação
    if (!keepRoute) {
      setPickupNames([]);
      setDropoffNames([]);
      setActiveSlot('pickup');
      // Edição de uma tarefa preparada é uma seleção de ptp como outra
      // qualquer — cai junto, sem salvar (a lista em si continua intacta).
      if (editingUnitId) restoreEditPrefs();
    }
  }

  function handleModeChange(next) {
    // Se estava num "peek mode" (Interação/Marcação), a seleção de ptp foi
    // preservada de propósito — sair dele por QUALQUER caminho (aba do
    // Toolbar, aqui, ou os botões flutuantes abaixo) não pode jogar fora o
    // que só estava "em pausa".
    const keepRoute = isPeekMode(mode);
    setMode(next);
    resetSelection({ keepRoute });
  }

  // Modo de marcação de ocupação: botão flutuante próprio (ver
  // FloorPlanCanvas), não é uma aba do Toolbar. keepRoute sempre true (é
  // um "peek mode", ver isPeekMode acima) — corrigir uma ocupação errada
  // não pode derrubar uma seleção de Ponto a Ponto em andamento; o
  // operador volta pro ptp com a origem/destino ainda escolhidos, tanto no
  // painel quanto no destaque do mapa (ver highlightsRoute em
  // FloorPlanCanvas.jsx).
  //
  // Bug corrigido (pedido do usuário, 2026-10-02): clicar no ÍCONE JÁ
  // ATIVO não "desliga" mais o modo (antes caía pro baseMode(), que pra
  // quem não é dev é 'ptp' — clicar de novo no ícone de marcação te jogava
  // pro Ponto a Ponto sem pedir). Agora só MUDA de modo quando o ícone
  // clicado é de um modo DIFERENTE do atual — clicar no mesmo ícone de
  // novo é no-op, o menu correspondente continua aberto. Pra sair de um
  // desses modos, clica em outro ícone (inclusive o de Ponto a Ponto).
  function handleToggleMarkMode() {
    if (mode === 'mark') return;
    setMode('mark');
    resetSelection({ keepRoute: true });
  }

  // Ponto a Ponto: mesmo padrão do modo de marcação acima — só acessível
  // pelo botão flutuante (ícone de rota), não pelo Toolbar.
  function handleTogglePtpMode() {
    if (mode === 'ptp') return;
    const keepRoute = isPeekMode(mode); // ver handleModeChange acima
    setMode('ptp');
    resetSelection({ keepRoute });
  }

  // Interação: mesmo padrão de mark/ptp acima, botão flutuante que
  // substituiu o antigo alternador de vista topo/isométrica (ver botão
  // "olho" -> "mãozinha" em FloorPlanCanvas.jsx). Acessível a qualquer
  // usuário (não só dev) — é o modo seguro de navegação pro operador.
  // keepRoute sempre true aqui (é o próprio toggle de Interação, outro
  // "peek mode").
  function handleToggleInteractionMode() {
    if (mode === 'interaction') return;
    setMode('interaction');
    resetSelection({ keepRoute: true });
  }

  // Fila: mesmo padrão de mark/ptp/interaction acima, botão flutuante
  // próprio (ícone de índice, ver FloorPlanCanvas.jsx) — ocupa o espaço que
  // era da roleta de zoom, removida (o modo Interação já cobre bem esse
  // gesto). Abrir o painel zera a notificação (bolinha vermelha com a
  // contagem de tasks solicitadas desde a última vez que foi aberto).
  function handleToggleQueueMode() {
    if (mode === 'queue') return;
    const keepRoute = isPeekMode(mode); // ver handleModeChange acima
    setMode('queue');
    resetSelection({ keepRoute });
    setQueueNotifCount(0);
  }

  // Clique numa rota do painel Fila: alterna a seleção (clicar na mesma
  // desfaz). null = volta a mostrar a rota em andamento no mapa (padrão).
  function handleSelectQueueRoute(id) {
    setSelectedQueueRouteId(id);
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
      setLimitBreaker(false);
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

  // Ocupação PROJETADA: como o armazém estará depois que as rotas já
  // selecionadas rodarem. É a peça central do modo "Lotes em sequência" —
  // `A → A2 → A3` só é válido porque, na hora de pegar A2, o A JÁ saiu.
  // Validar sempre contra a ocupação atual (o que o app fazia antes de
  // existir sequência) rejeitaria A2 e A3 pra sempre.
  //
  // Fora do modo sequência as duas listas têm no máximo 1 item e nada foi
  // "executado" ainda, então isso devolve exatamente a ocupação atual — o
  // comportamento antigo, sem caso especial nenhum.
  //
  // Com a lista de "Tarefas aguardando envio", a seleção nova vai rodar
  // DEPOIS das já preparadas — então a projeção parte do armazém como ele
  // estará depois delas (ou só das que vêm ANTES, se estiver editando uma
  // do meio da lista).
  function projectedOccupancy(pickedUp, droppedOff) {
    const set = occupancyAfter(flattenUnits(stagedBeforeSelection));
    for (const name of pickedUp) set.delete(name);
    for (const name of droppedOff) set.add(name);
    return set;
  }

  // Lista preparada achatada na ordem de execução, uma entrada por tarefa —
  // é exatamente o que vai pro servidor no "Iniciar tarefas". palletType é
  // POR TAREFA (pedido do usuário, 2026-10-05 — cada perna de uma
  // sequência pode ter um pallet diferente), não da unidade/grupo inteiro.
  function flattenUnits(units) {
    return units.flatMap((u) => u.tasks.map((t) => ({
      taskId: t.id,
      pickup: t.pickup,
      dropoff: t.dropoff,
      palletType: t.palletType,
      palletTop: t.palletType === 'blue' && !!u.palletTop,
      group: u.groupKey,
    })));
  }

  function occupancyAfter(pairs) {
    const set = new Set(occupied);
    for (const p of pairs) {
      set.delete(p.pickup);
      set.add(p.dropoff);
    }
    return set;
  }

  // Mesma regra que o servidor aplica no envio (validate_route_chain em
  // server.py): cada tarefa conferida contra o armazém como ele estará
  // quando ela rodar. Devolve a PRIMEIRA que quebra, ou null.
  function validateChain(pairs) {
    const set = new Set(occupied);
    for (const p of pairs) {
      if (!isPickupAllowed(p.pickup, set)) return { taskId: p.taskId, name: p.pickup, message: pickupDeniedMessage(p.pickup) };
      set.delete(p.pickup);
      if (!isDropoffAllowed(p.dropoff, set)) return { taskId: p.taskId, name: p.dropoff, message: dropoffDeniedMessage(p.dropoff) };
      set.add(p.dropoff);
    }
    return null;
  }

  // Aceita uma nova versão da lista (reordenada, com algo removido ou
  // editado) só se ela não QUEBRA uma cadeia que estava válida. Se a lista
  // já estava inválida antes (ex: a ocupação mudou por fora), deixa mexer —
  // pode ser justamente a mudança que conserta — a não ser que o erro novo
  // caia numa das tarefas em `ownTaskIds` (as que o operador acabou de
  // montar/editar).
  function checkStagedChange(next, ownTaskIds = []) {
    const before = validateChain(flattenUnits(stagedUnits));
    const after = validateChain(flattenUnits(next));
    if (!after) return null;
    if (!before || ownTaskIds.includes(after.taskId)) return after;
    return null;
  }

  function isPickupAllowed(name, occupiedSet) {
    const pos = findLotCellPosition(name);
    // Ponto avulso ("lote curinga" de uma célula só): não tem vizinho pra
    // bloquear o caminho, então a regra de fronteira não se aplica — mas a
    // regra básica sim: só dá pra pegar onde tem pallet marcado. Antes isso
    // retornava true direto e deixava mandar o robô pegar num ponto VAZIO.
    if (!pos) return occupiedSet.has(name);
    if (!occupiedSet.has(name)) return false; // precisa ter pallet ali pra pegar
    for (let i = 0; i < pos.index; i++) {
      if (occupiedSet.has(lotCellName(pos.lot.prefix, i))) return false; // bloqueado antes de chegar
    }
    return true;
  }

  function isDropoffAllowed(name, occupiedSet) {
    const pos = findLotCellPosition(name);
    // Ponto avulso: sem ordem pra respeitar, mas continua valendo que não
    // dá pra empilhar — soltar onde já tem pallet era permitido antes.
    if (!pos) return !occupiedSet.has(name);
    for (let i = 0; i <= pos.index; i++) {
      if (occupiedSet.has(lotCellName(pos.lot.prefix, i))) return false; // ela mesma ou alguma antes está ocupada
    }
    return true;
  }

  // Mensagens de recusa: ponto avulso não tem "lote"/ordem, então falar de
  // "posição antes dela no lote" só confundiria — a razão real ali é
  // simplesmente estar vazio (coleta) ou já ocupado (entrega).
  function pickupDeniedMessage(name) {
    // findLotCellPosition usa o nome TÉCNICO (é ele que identifica a
    // célula de verdade) — só o texto exibido troca pro apelido.
    const label = displayCellName(name, lots, points);
    return findLotCellPosition(name)
      ? 'Não dá pra pegar em ' + label + ': precisa ter pallet ali e nada ocupado antes dela no lote.'
      : 'Não dá pra pegar em ' + label + ': não tem pallet marcado ali.';
  }

  function dropoffDeniedMessage(name) {
    const label = displayCellName(name, lots, points);
    return findLotCellPosition(name)
      ? 'Não dá pra soltar em ' + label + ': ela ou alguma posição antes dela no lote está ocupada.'
      : 'Não dá pra soltar em ' + label + ': já tem pallet ali.';
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

  function handleStartAddCloseUp() {
    setSelectedCloseUpId(null);
    setAddTool('closeup');
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

  function handleAddCloseUp({ x, y, width, height }) {
    const id = addCloseUp({ x, y, width, height });
    setAddTool(null);
    setSelectedCloseUpId(id);
  }

  function handleSelectPoint(id) {
    setSelectedId(id);
    if (id) setSelectedLotId(null);
  }

  function handleSelectLot(id) {
    setSelectedLotId(id);
    if (id) setSelectedId(null);
  }

  function handleSelectCloseUp(id) {
    setSelectedCloseUpId(id);
  }

  // Modo Interação: tocar um Close Up (ou resetar o zoom, que manda null —
  // ver FloorPlanCanvas.jsx/handleResetView) liga/desliga o banner
  // "VISUALIZANDO: KANBAN X" (CloseUpStatusBanner.jsx).
  function handleCloseUpActivate(closeUp) {
    setActiveCloseUpId(closeUp ? closeUp.id : null);
  }

  function handleRename(id, name) {
    updatePoint(id, { name });
  }

  // Apelido puramente visual (ver useCalibration.js, displayCellName) —
  // NUNCA toca `name`, o nome técnico já calibrado idêntico ao ponto no
  // robô. Mesmo padrão de handleRenameLotDisplayName abaixo.
  function handleRenamePointDisplayName(id, displayName) {
    updatePoint(id, { displayName: displayName || null });
  }

  function handleDelete(id) {
    removePoint(id);
    if (selectedId === id) setSelectedId(null);
  }

  function handleRenameLotPrefix(id, prefix) {
    updateLot(id, { prefix });
  }

  // Apelido puramente visual (ver useCalibration.js, lotCellDisplayName) —
  // NUNCA toca `prefix`, o nome técnico já configurado no robô.
  function handleRenameLotDisplayName(id, displayName) {
    updateLot(id, { displayName: displayName || null });
  }

  function handleDeleteLot(id) {
    removeLot(id);
    if (selectedLotId === id) setSelectedLotId(null);
  }

  function handleSetLotColor(id, color) {
    updateLot(id, { color });
  }

  function handleRenameCloseUp(id, name) {
    updateCloseUp(id, { name });
  }

  function handleDeleteCloseUp(id) {
    removeCloseUp(id);
    if (selectedCloseUpId === id) setSelectedCloseUpId(null);
  }

  function handleTogglePointNames(id) {
    const point = points.find((p) => p.id === id);
    if (point) updatePoint(id, { namesVisible: !point.namesVisible });
  }

  function handleToggleLotNames(id) {
    const lot = lots.find((l) => l.id === id);
    if (lot) updateLot(id, { namesVisible: !lot.namesVisible });
  }

  function handlePointToPointClick(name) {
    if (sequenceMode) return handleSequenceClick(name);

    // --- modo normal (um par por vez), idêntico ao que sempre foi ---------
    const [pickupName] = pickupNames;
    const [dropoffName] = dropoffNames;
    if (name === pickupName) { setPickupNames([]); setDropoffNames([]); return; }
    if (name === dropoffName) { setDropoffNames([]); return; }
    if (!pickupName) {
      if (!isPickupAllowed(name, projectedOccupancy([], []))) {
        showToast(pickupDeniedMessage(name), 'error');
        triggerInvalidPulse(name);
        return;
      }
      setPickupNames([name]);
      return;
    }
    // O destino é validado com a origem JÁ removida — pegar de A e soltar
    // em A2 (logo atrás) é fisicamente válido, e sem essa projeção o
    // próprio A bloquearia o A2.
    if (!isDropoffAllowed(name, projectedOccupancy([pickupName], []))) {
      showToast(dropoffDeniedMessage(name), 'error');
      triggerInvalidPulse(name);
      return;
    }
    setDropoffNames([name]);
  }

  // --- modo "Lotes em sequência" -----------------------------------------
  // Cada seleção é validada como se todas as anteriores já tivessem sido
  // executadas (ver projectedOccupancy). É isso que faz `A → A2 → A3` valer
  // na origem e `B3 → B2 → B` valer no destino: as duas regras que parecem
  // opostas ("crescente" na coleta, "decrescente" na entrega) são o MESMO
  // princípio físico visto dos dois lados — nunca passar por cima de uma
  // posição ocupada.
  function handleSequenceClick(name) {
    const list = activeSlot === 'pickup' ? pickupNames : dropoffNames;
    const setList = activeSlot === 'pickup' ? setPickupNames : setDropoffNames;

    // Clicar num já selecionado desfaz dali pra frente (decisão do usuário)
    // — truncar em vez de remover só ele é o que mantém o resto da
    // sequência sempre válido: os seguintes só eram válidos POR CAUSA
    // desse, então deixá-los sozinhos criaria uma sequência impossível.
    const existing = list.indexOf(name);
    if (existing !== -1) {
      setList(list.slice(0, existing));
      return;
    }

    if (activeSlot === 'pickup') {
      // Origens de LOTE têm que sair todas da mesma coluna: a sequência só
      // se sustenta porque cada coleta destrava a seguinte, e isso é uma
      // relação interna de um lote — entre lotes diferentes não existe
      // ordem nenhuma pra respeitar.
      //
      // Pontos avulsos são curinga e ficam FORA dessa restrição: não têm
      // vizinho pra destravar nem pra bloquear, então podem entrar em
      // qualquer sequência (com outros avulsos, ou junto de uma coluna).
      const pos = findLotCellPosition(name);
      if (pos) {
        const conflicting = pickupNames
          .map(findLotCellPosition)
          .find((p) => p && p.lot.id !== pos.lot.id);
        if (conflicting) {
          showToast('Em sequência, as origens de lote precisam ser todas da mesma coluna.', 'error');
          triggerInvalidPulse(name);
          return;
        }
      }
      if (!isPickupAllowed(name, projectedOccupancy(pickupNames, dropoffNames))) {
        showToast('Ordem inválida: caminho bloqueado', 'error');
        triggerInvalidPulse(name);
        return;
      }
      setPickupNames([...pickupNames, name]);
      return;
    }

    // Destino: no instante desta entrega, as coletas 1..N desta rota já
    // aconteceram (inclusive a desta) e as entregas anteriores já foram
    // feitas — é exatamente essa a projeção usada aqui.
    const idx = dropoffNames.length;
    if (idx >= pickupNames.length) {
      showToast('Já tem um destino pra cada origem — selecione mais origens antes.', 'info');
      triggerInvalidPulse(name);
      return;
    }
    const proj = projectedOccupancy(pickupNames.slice(0, idx + 1), dropoffNames);
    if (!isDropoffAllowed(name, proj)) {
      showToast('Ordem inválida: caminho bloqueado', 'error');
      triggerInvalidPulse(name);
      return;
    }
    setDropoffNames([...dropoffNames, name]);
  }

  function handleToggleSequenceMode() {
    // Editando uma tarefa preparada, avulsa continua avulsa e grupo
    // continua grupo — trocar aqui misturaria as duas coisas.
    if (editingUnitId) return;
    // Trocar de modo zera a seleção: as regras de validade são diferentes
    // entre os dois, então carregar uma seleção montada sob outras regras
    // poderia virar um envio inválido sem o operador perceber.
    setSequenceMode((v) => !v);
    setPickupNames([]);
    setDropoffNames([]);
    setActiveSlot('pickup');
  }

  function handleClearSelection() {
    setPickupNames([]);
    setDropoffNames([]);
    setActiveSlot('pickup');
  }

  function routeLabel(pickup, dropoff) {
    // Substituição puramente visual (ver useCalibration.js, displayCellName)
    // — o que vai pro servidor continua sendo o nome técnico.
    return displayCellName(pickup, lots, points) + ' → ' + displayCellName(dropoff, lots, points);
  }

  function rejectStaged(err, prefix) {
    showToast(prefix + err.message, 'error');
    triggerInvalidPulse(err.name);
  }

  // "Enviar tarefa": a seleção montada entra na lista de "Tarefas
  // aguardando envio" — nada vai pro robô ainda (ver "Iniciar tarefas",
  // handleStartStaged). Editando uma tarefa da lista, o mesmo botão salva.
  function handleStageSelection() {
    // Contagens iguais é pré-requisito (o botão já fica desabilitado sem
    // isso, ver PointToPointBar) — todo pallet pego precisa ter pra onde ir.
    if (!pickupNames.length || pickupNames.length !== dropoffNames.length) return;
    if (editingUnitId) {
      handleSaveEdit();
      return;
    }
    // palletType vai POR TAREFA (pedido do usuário, 2026-10-05) — o valor
    // escolhido agora na barra vira só o ponto de partida de cada uma,
    // editável depois individualmente (ver PalletSwatch/handleChangeStagedPallet).
    const tasks = pickupNames.map((pickup, i) => ({ id: newStagedId('t'), pickup, dropoff: dropoffNames[i], palletType }));
    const unitId = newStagedId('u');
    const unit = {
      id: unitId,
      // Só vira grupo (tracejado laranja, move junto) com sequência de verdade.
      groupKey: tasks.length > 1 ? unitId : null,
      palletType,
      palletTop: palletType === 'blue' && palletTop,
      tasks,
    };
    const next = [...stagedUnits, unit];
    const err = checkStagedChange(next, tasks.map((t) => t.id));
    if (err) {
      rejectStaged(err, '');
      return;
    }
    setStagedUnits(next);
    showToast(
      tasks.length > 1
        ? tasks.length + ' tarefas em sequência adicionadas à lista de envio.'
        : 'Tarefa adicionada à lista de envio: ' + routeLabel(tasks[0].pickup, tasks[0].dropoff),
      'info',
    );
    handleClearSelection();
  }

  // Tocar numa barrinha: carrega a unidade na seleção do Ponto a Ponto
  // (mapa mostra origem/destino ampliados, dá pra trocar clicando). Tocar
  // de novo na mesma sai da edição sem mudar nada. Um grupo de sequência
  // abre em modo sequência (edita o grupo inteiro); uma avulsa trava a
  // sequência desligada.
  //
  // "Visualizar tarefa": além de carregar pra edição, o mapa dá zoom no
  // kanban onde a ORIGEM da tarefa tocada está, e o banner "VISUALIZANDO"
  // mostra ORIGEM → DESTINO clicáveis (handleFocusEndpoint). Num grupo, tocar
  // noutra barrinha do MESMO grupo só troca a tarefa visualizada.
  //
  // Clicar NO GRUPO em si (não numa barrinha específica — taskId null E o
  // grupo tem groupKey, ver StagedTasksPanel/handleClickUnit) é diferente:
  // bug relatado pelo usuário (2026-10-02) — mostrava só a 1ª tarefa do
  // grupo, como se as outras não existissem. `index: null` é o sentinela
  // "visualizando o GRUPO inteiro" — o banner passa a mostrar TODAS as N
  // origens e TODOS os N destinos (empilhados), em vez de um par só (ver
  // CloseUpStatusBanner.jsx). Tocar numa barrinha específica continua
  // mostrando só aquele par, sem mudança nenhuma.
  function handleSelectStagedUnit(unitId, taskId = null) {
    const unit = stagedUnits.find((u) => u.id === unitId);
    if (!unit) return;
    const viewingGroup = !taskId && !!unit.groupKey;
    const index = viewingGroup ? null : Math.max(0, taskId ? unit.tasks.findIndex((t) => t.id === taskId) : 0);
    const focusPickup = viewingGroup ? unit.tasks[0].pickup : unit.tasks[index].pickup;
    if (editingUnitId === unitId) {
      if (viewTask && viewTask.index !== index) {
        setViewTask({ index, active: 'pickup', activeIndex: 0 });
        requestFocus(viewingGroup ? focusPickup : pickupNames[index]);
        return;
      }
      handleCancelEdit();
      return;
    }
    setViewTask({ index, active: 'pickup', activeIndex: 0 });
    requestFocus(focusPickup);
    if (!editingUnitId) editPrevRef.current = { sequenceMode, palletType, palletTop };
    setEditingUnitId(unitId);
    setSequenceMode(!!unit.groupKey);
    setPickupNames(unit.tasks.map((t) => t.pickup));
    setDropoffNames(unit.tasks.map((t) => t.dropoff));
    setActiveSlot('pickup');
    // Carrega o pallet da tarefa ESPECÍFICA sendo vista (índice 0 na
    // visualização de grupo inteiro) — cada uma pode ter um tipo
    // diferente agora (pedido do usuário, 2026-10-05).
    setPalletType(unit.tasks[index ?? 0].palletType);
    setPalletTop(!!unit.palletTop);
  }

  // Banner: toca na origem ou no destino → mapa vai até o kanban daquele
  // ponto. Serve tanto pro Ponto a Ponto (viewTask) quanto pro Histórico
  // (selectedHistoryRoute, ver handleSelectHistoryEntry abaixo) — nunca os
  // dois ao mesmo tempo (modos diferentes), então checar o modo decide
  // qual dos dois está valendo agora. `index` só importa na visualização de
  // GRUPO (viewTask.index === null) — qual das N origens/destinos
  // empilhadas foi tocada; nos outros casos (uma tarefa só, ou Histórico)
  // é sempre 0, já que só existe um par.
  function handleFocusEndpoint(kind, index = 0) {
    if (mode === 'history') {
      if (!selectedHistoryRoute) return;
      const name = kind === 'pickup' ? selectedHistoryRoute.pickup : selectedHistoryRoute.dropoff;
      if (!name) return;
      setHistoryFocusedEndpoint(kind);
      requestFocus(name);
      return;
    }
    if (!viewTask) return;
    if (viewTask.index === null) {
      const name = (kind === 'pickup' ? pickupNames : dropoffNames)[index];
      if (!name) return;
      setViewTask({ ...viewTask, active: kind, activeIndex: index });
      requestFocus(name);
      return;
    }
    const name = (kind === 'pickup' ? pickupNames : dropoffNames)[viewTask.index];
    if (!name) return;
    setViewTask({ ...viewTask, active: kind, activeIndex: 0 });
    requestFocus(name);
  }

  // Clicar numa rota do painel Histórico: alterna seleção (clicar de novo
  // na mesma desseleciona — mesmo gesto do painel Fila) e, ao SELECIONAR,
  // já dá zoom de perto na origem (ou no destino, se não houver origem —
  // caso do UNLOAD isolado pós-cancelamento, ver CONTEXT.md "Cancelamento
  // pós-pickup") e liga o banner "VISUALIZANDO" com origem/destino
  // clicáveis, mesmo espírito de "Visualizar tarefa" no Ponto a Ponto.
  function handleSelectHistoryEntry(entry) {
    setSelectedHistoryRoute((cur) => {
      if (cur && cur.id === entry.id) {
        setHistoryFocusedEndpoint(null);
        return null;
      }
      const startKind = entry.pickup ? 'pickup' : 'dropoff';
      setHistoryFocusedEndpoint(startKind);
      requestFocus(entry.pickup || entry.dropoff);
      return entry;
    });
  }

  function restoreEditPrefs() {
    const prev = editPrevRef.current;
    editPrevRef.current = null;
    setEditingUnitId(null);
    // Sai da visualização junto: some a linha da tarefa e o nome do kanban
    // (o mapa fica onde está).
    setViewTask(null);
    setActiveCloseUpId(null);
    if (prev) {
      setSequenceMode(prev.sequenceMode);
      setPalletType(prev.palletType);
      setPalletTop(prev.palletTop);
    }
  }

  function handleCancelEdit() {
    restoreEditPrefs();
    handleClearSelection();
  }

  function handleSaveEdit() {
    if (!editingUnit) {
      handleCancelEdit();
      return;
    }
    // Reaproveita o id das tarefas que já existiam (não reanima a barrinha à
    // toa); só as novas de um grupo que cresceu ganham id novo. Mesma
    // lógica pro palletType: reeditar origem/destino não deve apagar o
    // pallet que cada tarefa já tinha individualmente (pedido do usuário,
    // 2026-10-05) — só tarefa NOVA (grupo que cresceu) herda o valor
    // escolhido agora na barra.
    const tasks = pickupNames.map((pickup, i) => ({
      id: editingUnit.tasks[i]?.id || newStagedId('t'),
      pickup,
      dropoff: dropoffNames[i],
      palletType: editingUnit.tasks[i]?.palletType || palletType,
    }));
    const edited = {
      ...editingUnit,
      tasks,
      groupKey: tasks.length > 1 ? (editingUnit.groupKey || editingUnit.id) : null,
      palletType,
      palletTop: palletType === 'blue' && palletTop,
    };
    const next = stagedUnits.map((u) => (u.id === edited.id ? edited : u));
    const err = checkStagedChange(next, tasks.map((t) => t.id));
    if (err) {
      rejectStaged(err, 'Não dá pra salvar: ');
      return;
    }
    setStagedUnits(next);
    showToast(tasks.length > 1 ? 'Sequência atualizada.' : 'Tarefa atualizada: ' + routeLabel(tasks[0].pickup, tasks[0].dropoff), 'success');
    handleCancelEdit();
  }

  // Arrastar e soltar (StagedTasksPanel): move a UNIDADE inteira de `from`
  // pra `to`. Recusa (e a barrinha volta pro lugar) se a nova ordem obstrui
  // algum lote — ex: tentar pegar A2 antes do A sair.
  function handleReorderStaged(from, to) {
    const next = [...stagedUnits];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const err = checkStagedChange(next);
    if (err) {
      rejectStaged(err, 'Ordem inválida: ');
      return false;
    }
    setStagedUnits(next);
    return true;
  }

  function handleRemoveStagedTask(unitId, taskId) {
    const next = stagedUnits
      .map((u) => (u.id === unitId ? { ...u, tasks: u.tasks.filter((t) => t.id !== taskId) } : u))
      .filter((u) => u.tasks.length > 0)
      // Grupo que ficou com uma tarefa só volta a ser avulsa.
      .map((u) => (u.groupKey && u.tasks.length < 2 ? { ...u, groupKey: null } : u));
    const err = checkStagedChange(next);
    if (err) {
      rejectStaged(err, 'Não dá pra remover — a tarefa seguinte depende dela: ');
      return;
    }
    if (unitId === editingUnitId) handleCancelEdit();
    setStagedUnits(next);
  }

  // Troca o pallet de UMA tarefa só dentro da unidade (pedido do usuário,
  // 2026-10-05: num grupo de "Lotes em sequência", cada tarefa pode ter um
  // pallet diferente — trocar o ícone de uma barrinha não mexe nas outras).
  function handleChangeStagedPallet(unitId, taskId, type) {
    setStagedUnits((units) => units.map((u) => (
      u.id === unitId
        ? { ...u, tasks: u.tasks.map((t) => (t.id === taskId ? { ...t, palletType: type } : t)) }
        : u
    )));
  }

  // Disparo/avanço/sondagem de verdade (falar com o robô, decidir
  // atual/pendente/fila, detectar FINISHED/CANCELLED, marcar ocupação) não
  // mora aqui — é tudo dono do servidor (ver CONTEXT.md, "Fila de rotas
  // compartilhada", e hooks/useLiveState.js). "Iniciar tarefas" só manda a
  // INTENÇÃO e mostra o que o servidor reporta de volta.
  async function handleStartStaged() {
    if (!stagedUnits.length || editingUnitId) return;
    const flat = flattenUnits(stagedUnits);
    const err = validateChain(flat);
    if (err) {
      rejectStaged(err, 'Ordem inválida: ');
      return;
    }
    // A lista inteira num envio só: o servidor valida a cadeia com ocupação
    // projetada através de TODAS (mandadas uma a uma, uma tarefa que depende
    // de outra anterior seria recusada, porque no instante do envio a origem
    // anterior ainda está ocupada). Cada par leva pallet e grupo próprios —
    // avulsa vai com group null e continua independente na fila do servidor
    // (ver /api/queue/enqueue-batch em server.py).
    const pairs = flat.map(({ pickup, dropoff, palletType: type, palletTop: top, group }) => ({
      pickup, dropoff, palletType: type, palletTop: top, group,
    }));
    setStarting(true);
    try {
      const { slot } = await enqueueRoutes({ pairs, palletType: pairs[0].palletType, palletTop: pairs[0].palletTop });
      showToast(
        pairs.length > 1
          ? pairs.length + ' tarefas iniciadas.'
          : TOAST_BY_SLOT[slot] + routeLabel(pairs[0].pickup, pairs[0].dropoff),
        slot === 'current' ? 'success' : 'info',
      );
      // Bolinha de notificação do botão Fila: conta as tarefas solicitadas
      // desde a última vez que o painel foi aberto (ver handleToggleQueueMode).
      setQueueNotifCount((c) => c + pairs.length);
      // Limpa só no sucesso: se deu erro, a lista continua ali pro operador
      // corrigir em vez de ter que remontar tudo do zero.
      setStagedUnits([]);
    } catch (e) {
      showToast('Erro ao iniciar tarefas: ' + e.message, 'error');
    } finally {
      setStarting(false);
    }
  }

  const stagedChainError = validateChain(flattenUnits(stagedUnits));
  const stagedBlockedReason = editingUnitId
    ? { text: 'Salve ou cancele a edição antes de iniciar.', kind: 'info' }
    : stagedChainError ? { text: 'Ordem inválida: ' + stagedChainError.message, kind: 'error' } : null;

  // Cancelamento adiado até giro seguro (ver CONTEXT.md e useLiveState.js):
  // `result.pending` true significa que o robô não tem espaço pra girar
  // AGORA — o cancelamento de verdade não aconteceu ainda, o servidor
  // continua tentando sozinho (CancelPendingBanner, acima, mostra o aviso
  // persistente enquanto isso durar). Clicar de novo enquanto pending é
  // inofensivo (idempotente no servidor), só repete o mesmo toast.
  async function handleCancelCurrent() {
    if (!currentRoute) return;
    try {
      const result = await cancelCurrent({ force: devMode && limitBreaker });
      if (result && result.pending) {
        showToast(result.message || 'Aguardando o robô achar espaço seguro pra girar...', 'info');
      } else {
        showToast('Rota em andamento cancelada.', 'success');
      }
    } catch (err) {
      showToast('Erro ao cancelar: ' + err.message, 'error');
    }
  }

  // Parada de emergência: liga/desliga. Ligada, o servidor cancela tudo e
  // mantém o robô parado (reprimindo a task de carga). É melhor esforço,
  // não substitui o E-stop físico — ver CONTEXT.md.
  async function handleToggleEmergency() {
    const turningOn = !emergency;
    try {
      const result = await setEmergency(turningOn);
      if (turningOn && result && result.warning) {
        // A emergência ENGATOU (o servidor segue martelando cancel_goal +
        // all-cancel a cada tick), mas algum comando imediato ao robô
        // falhou — o operador precisa saber que pode não ter parado na hora.
        showToast('EMERGÊNCIA ativa, mas o robô recusou um comando (' + result.warning + '). Se ele não parar, use o E-stop físico.', 'error');
      } else {
        showToast(
          turningOn ? 'PARADA DE EMERGÊNCIA ativa — robô sendo mantido parado.' : 'Emergência liberada — robô voltando ao normal.',
          turningOn ? 'error' : 'success',
        );
      }
    } catch (err) {
      showToast('Erro na parada de emergência: ' + err.message, 'error');
    }
  }

  // Cancela uma rota que ainda não está em andamento (a "próxima" já
  // disparada pro robô, ou qualquer uma só na fila local) — o servidor
  // cuida de cancelar no robô se preciso e de promover a seguinte. A rota
  // em andamento não é afetada.
  async function handleRemoveQueued(id) {
    try {
      await removeQueued(id);
    } catch (err) {
      showToast('Erro ao cancelar rota: ' + err.message, 'error');
    }
  }

  // Painel Fila: rotas "de espera" na ordem em que o robô as verá — a
  // pendingRoute (se houver) já foi disparada pro dispatch como "próxima",
  // o resto é fila local (ver CONTEXT.md, "Fila de rotas compartilhada").
  const waitingRoutes = pendingRoute ? [pendingRoute, ...routeQueue] : routeQueue;

  // Rota selecionada no painel Fila (clique numa das "próximas rotas") — só
  // procura nas de espera; clicar na rota em andamento manda null (ver
  // QueuePanel/handleSelectQueueRoute), que já é o padrão abaixo.
  const selectedQueueRoute = selectedQueueRouteId
    ? waitingRoutes.find((r) => r.id === selectedQueueRouteId)
    : null;
  // "Lotes em sequência" (ver CONTEXT.md): rotas da mesma sequência
  // compartilham groupId. Selecionar uma delas "isola" o grupo inteiro no
  // mapa — sem groupId (rota avulsa), isola só ela mesma.
  const selectedQueueGroup = selectedQueueRoute
    ? (selectedQueueRoute.groupId
      ? waitingRoutes.filter((r) => r.groupId === selectedQueueRoute.groupId)
      : [selectedQueueRoute])
    : null;

  // O que o mapa destaca, em ordem de prioridade:
  // 1. Seleção sendo montada no Ponto a Ponto (com a numeração da sequência);
  // 2. Rota (ou grupo) selecionada no painel Fila;
  // 3. Entrada selecionada no painel Histórico (pickup pode ser null — ver
  //    HistoryPanel, UNLOAD isolado pós-cancelamento — por isso o filter);
  // 4. A ROTA ATUAL, um par só, sem número — o padrão de repouso, o que o
  //    robô está fazendo AGORA.
  const mapPickupNames = pickupNames.length ? pickupNames
    : selectedQueueGroup ? selectedQueueGroup.map((r) => r.pickup)
    : selectedHistoryRoute ? [selectedHistoryRoute.pickup].filter(Boolean)
    : currentRoute ? [currentRoute.pickup] : EMPTY_SELECTION;
  const mapDropoffNames = dropoffNames.length ? dropoffNames
    : selectedQueueGroup ? selectedQueueGroup.map((r) => r.dropoff)
    : selectedHistoryRoute ? [selectedHistoryRoute.dropoff].filter(Boolean)
    : currentRoute ? [currentRoute.dropoff] : EMPTY_SELECTION;

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
        isFullscreen={isFullscreen}
        onToggleFullscreen={handleToggleFullscreen}
        devMode={devMode}
        onDevButtonClick={handleDevButtonClick}
        limitBreaker={limitBreaker}
        onToggleLimitBreaker={handleToggleLimitBreaker}
        user={user}
        onLogout={onLogout}
        robotCharging={robotCharging}
        robotBattery={robotBattery}
        robotReturningToCharge={robotReturningToCharge}
      />
      <CloseUpStatusBanner
        name={activeCloseUpId ? closeUps.find((c) => c.id === activeCloseUpId)?.name : null}
        // Nomes AO VIVO da seleção em edição (mudar a origem no mapa já
        // atualiza aqui), no apelido visual — nunca o nome técnico.
        // pickups/dropoffs SEMPRE em lista (mesmo quando só existe um par) —
        // uniformiza o banner pros dois casos: uma tarefa só (lista de 1) e
        // o GRUPO inteiro de "Lotes em sequência" (lista de N, uma por
        // tarefa — bug corrigido 2026-10-02, antes só mostrava a 1ª).
        task={viewTask && editingUnitId && mode === 'ptp' ? {
          pickups: (viewTask.index === null ? pickupNames : [pickupNames[viewTask.index]])
            .map((n) => (n ? displayCellName(n, lots, points) : null)),
          dropoffs: (viewTask.index === null ? dropoffNames : [dropoffNames[viewTask.index]])
            .map((n) => (n ? displayCellName(n, lots, points) : null)),
          active: { kind: viewTask.active, index: viewTask.activeIndex },
        } : mode === 'history' && selectedHistoryRoute ? {
          pickups: [selectedHistoryRoute.pickup ? displayCellName(selectedHistoryRoute.pickup, lots, points) : null],
          dropoffs: [selectedHistoryRoute.dropoff ? displayCellName(selectedHistoryRoute.dropoff, lots, points) : null],
          active: { kind: historyFocusedEndpoint, index: 0 },
        } : null}
        onFocusEndpoint={handleFocusEndpoint}
        wide={mode === 'ptp' || mode === 'queue' || mode === 'history'}
      />
      {/* cancelPendingMessage (esperando girar pra CANCELAR), turnBlockedMessage
          (esperando girar pra COMEÇAR uma rota nova), awaitingChargeMessage
          (esperando o robô voltar pra energia e carregar antes de COMEÇAR uma
          rota nova) e postPickupUnloadMessage (cancelou já com o pallet no
          garfo — descarregando isolado antes de seguir, ver CONTEXT.md
          "Cancelamento pós-pickup") nunca coexistem — cada uma cobre uma
          janela sequencial diferente da mesma currentRoute, nunca ao mesmo
          tempo (ver server.py, "check-turn no início de tarefas", "Trava:
          não iniciar task durante retorno pra energia" e "Cancelamento
          pós-pickup"). */}
      {/* robotStalledMessage (vermelho, anomalia) tem prioridade sobre as
          esperas normais (âmbar) — nunca escondido por elas. */}
      <CancelPendingBanner
        message={robotStalledMessage || cancelPendingMessage || turnBlockedMessage || awaitingChargeMessage || postPickupUnloadMessage}
        variant={robotStalledMessage ? 'danger' : 'warning'}
      />

      <div className="app__body">
        {/*
          Sem seleção ativa, o mapa mostra a rota em andamento em vez de
          nada — currentRoute vem do polling de useLiveState, então quando
          o servidor promove a próxima da fila, o destaque já segue
          sozinho aqui, sem precisar mexer em nada.
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
          closeUps={closeUps}
          onAddCloseUp={handleAddCloseUp}
          onUpdateCloseUp={updateCloseUp}
          selectedCloseUpId={selectedCloseUpId}
          onSelectCloseUp={handleSelectCloseUp}
          onCloseUpActivate={handleCloseUpActivate}
          focusRequest={focusRequest}
          closeUpFocusRequest={closeUpFocusRequest}
          pickupNames={mapPickupNames}
          dropoffNames={mapDropoffNames}
          onPointToPointClick={handlePointToPointClick}
          view={view}
          occupiedNames={occupied}
          onMarkOccupied={setOccupiedMany}
          markModeActive={mode === 'mark'}
          onToggleMarkMode={handleToggleMarkMode}
          ptpModeActive={mode === 'ptp'}
          onTogglePtpMode={handleTogglePtpMode}
          interactionModeActive={mode === 'interaction'}
          onToggleInteractionMode={handleToggleInteractionMode}
          queueModeActive={mode === 'queue'}
          onToggleQueueMode={handleToggleQueueMode}
          queueNotifCount={queueNotifCount}
          invalidPulseName={invalidPulse?.name ?? null}
          invalidPulseId={invalidPulse?.id ?? null}
          emergencyActive={emergency}
          onToggleEmergency={handleToggleEmergency}
        />

        {mode === 'edit' && (
          <aside className="sidebar">
            <PalletHeightsPanel heights={palletHeights} onSave={savePalletHeights} />
            <PointsPanel
              points={points}
              selectedId={selectedId}
              onSelect={handleSelectPoint}
              onRename={handleRename}
              onRenameDisplayName={handleRenamePointDisplayName}
              onDelete={handleDelete}
              onToggleNames={handleTogglePointNames}
            />
            <LotsPanel
              lots={lots}
              selectedLotId={selectedLotId}
              onSelect={handleSelectLot}
              onRenamePrefix={handleRenameLotPrefix}
              onRenameDisplayName={handleRenameLotDisplayName}
              onDelete={handleDeleteLot}
              onSetColor={handleSetLotColor}
              onToggleNames={handleToggleLotNames}
            />
          </aside>
        )}
        {mode === 'closeup' && (
          <aside className="sidebar">
            <CloseUpsPanel
              closeUps={closeUps}
              selectedCloseUpId={selectedCloseUpId}
              addActive={addTool === 'closeup'}
              onStartAdd={handleStartAddCloseUp}
              onCancelAdd={handleCancelAdd}
              onSelect={handleSelectCloseUp}
              onRename={handleRenameCloseUp}
              onDelete={handleDeleteCloseUp}
            />
          </aside>
        )}
        {mode === 'interaction' && (
          <aside className="sidebar">
            <p className="points-panel__hint">Selecione o kanban que você deseja ampliar.</p>
          </aside>
        )}
        {mode === 'ptp' && (
          <aside className="sidebar sidebar--wide">
            <PointToPointBar
              pickupNames={pickupNames}
              dropoffNames={dropoffNames}
              lots={lots}
              points={points}
              onClear={editingUnitId ? handleCancelEdit : handleClearSelection}
              onSend={handleStageSelection}
              editing={editingUnit ? (editingUnit.groupKey ? 'group' : 'single') : null}
              palletType={palletType}
              onPalletTypeChange={setPalletType}
              sequenceMode={sequenceMode}
              onToggleSequenceMode={handleToggleSequenceMode}
              activeSlot={activeSlot}
              onActiveSlotChange={setActiveSlot}
            />
            <StagedTasksPanel
              units={stagedUnits}
              lots={lots}
              points={points}
              editingUnitId={editingUnitId}
              invalidTaskId={stagedChainError?.taskId ?? null}
              blockedReason={stagedBlockedReason}
              onSelectUnit={handleSelectStagedUnit}
              onRemoveTask={handleRemoveStagedTask}
              onReorder={handleReorderStaged}
              onChangePallet={handleChangeStagedPallet}
              onStart={handleStartStaged}
              starting={starting}
            />
          </aside>
        )}
        {mode === 'queue' && (
          <aside className="sidebar sidebar--queue">
            <QueuePanel
              currentRoute={currentRoute}
              waitingRoutes={waitingRoutes}
              lots={lots}
              points={points}
              selectedRouteId={selectedQueueRouteId}
              onSelectRoute={handleSelectQueueRoute}
              onCancelCurrent={handleCancelCurrent}
              onRemoveQueued={handleRemoveQueued}
              cancelPending={cancelPending}
            />
          </aside>
        )}
        {mode === 'mark' && (
          <aside className="sidebar">
            <OccupancyPanel occupied={occupied} lots={lots} points={points} onToggle={toggleOccupied} />
          </aside>
        )}
        {mode === 'history' && (
          <aside className="sidebar sidebar--history">
            <HistoryPanel
              lots={lots}
              points={points}
              selectedEntryId={selectedHistoryRoute ? selectedHistoryRoute.id : null}
              onSelectEntry={handleSelectHistoryEntry}
            />
          </aside>
        )}
        {mode === 'users' && (
          <aside className="sidebar sidebar--wide">
            <UsersPanel
              currentUsername={user.username}
              showToast={showToast}
              onFocusKanban={requestCloseUpFocus}
            />
          </aside>
        )}
      </div>

      <Toast toast={toast} />
      <DevModeModal open={devModalOpen} onSubmit={handleDevModalSubmit} onClose={handleDevModalClose} />
    </div>
  );
}
