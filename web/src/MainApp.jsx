import { useState, useEffect, useRef } from 'react';
import Toolbar from './components/Toolbar';
import CloseUpStatusBanner from './components/CloseUpStatusBanner';
import PointsPanel from './components/PointsPanel';
import LotsPanel from './components/LotsPanel';
import CloseUpsPanel from './components/CloseUpsPanel';
import PalletHeightsPanel from './components/PalletHeightsPanel';
import PointToPointBar from './components/PointToPointBar';
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
import { saveTheme } from './api/auth';
import { applyTheme } from './theme';
// App.css já é carregado pelo App.jsx (raiz) — precisa estar disponível
// mesmo antes de MainApp montar, pra estilizar a LoginScreen.

// Só um gate de UI local (esconder edição de quem tá mexendo no tablet no
// dia a dia) — não é segurança de verdade, a senha fica visível em texto no
// bundle JS pra quem abrir o devtools. Não guardar nada sensível atrás
// disso.
const DEV_PASSWORD = 'ihavenomouthandimustscream';


// Prefixo do toast de "Enviar task" conforme o slot que o servidor devolve
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
    currentRoute, pendingRoute, routeQueue, occupied, emergency, robotCharging, robotBattery,
    enqueueRoutes, cancelCurrent, removeQueued, setOccupiedMany, toggleOccupied, setEmergency,
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
  const [palletTop, setPalletTop] = useState(false);
  const [sending, setSending] = useState(false);

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
    setActiveCloseUpId(null); // banner "VISUALIZANDO: KANBAN X" — nunca sobrevive a uma troca de modo, nem entrando/saindo de Interação
    if (!keepRoute) {
      setPickupNames([]);
      setDropoffNames([]);
      setActiveSlot('pickup');
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

  // Mode "de repouso" pra onde os toggles de mark/ptp voltam ao sair: 'edit'
  // pra quem desbloqueou o modo desenvolvedor (útil ficar ali, é onde se
  // edita pontos/lotes), 'ptp' pra todo mundo mais — nunca 'edit' sem
  // devMode, senão a aba escondida no Toolbar (ver Toolbar.jsx) ficaria
  // inútil: o app já cairia sozinho no modo que ela deveria trancar.
  function baseMode() {
    return devMode ? 'edit' : 'ptp';
  }

  // Modo de marcação de ocupação: botão flutuante próprio (ver
  // FloorPlanCanvas), não é uma aba do Toolbar. keepRoute sempre true (é
  // um "peek mode", ver isPeekMode acima) — corrigir uma ocupação errada
  // não pode derrubar uma seleção de Ponto a Ponto em andamento; o
  // operador volta pro ptp com a origem/destino ainda escolhidos, tanto no
  // painel quanto no destaque do mapa (ver highlightsRoute em
  // FloorPlanCanvas.jsx).
  function handleToggleMarkMode() {
    setMode((m) => (m === 'mark' ? baseMode() : 'mark'));
    resetSelection({ keepRoute: true });
  }

  // Ponto a Ponto: mesmo padrão do modo de marcação acima — só acessível
  // pelo botão flutuante (ícone de rota), não pelo Toolbar. Pra quem não é
  // dev, ptp JÁ é o modo de repouso — sair dele não muda nada (baseMode()
  // devolve 'ptp' de novo), o que é o comportamento certo.
  function handleTogglePtpMode() {
    const keepRoute = isPeekMode(mode); // ver handleModeChange acima
    setMode((m) => (m === 'ptp' ? baseMode() : 'ptp'));
    resetSelection({ keepRoute });
  }

  // Interação: mesmo padrão de mark/ptp acima, botão flutuante que
  // substituiu o antigo alternador de vista topo/isométrica (ver botão
  // "olho" -> "mãozinha" em FloorPlanCanvas.jsx). Acessível a qualquer
  // usuário (não só dev) — é o modo seguro de navegação pro operador.
  // keepRoute sempre true aqui (é o próprio toggle de Interação, outro
  // "peek mode" — cobre tanto entrar quanto sair dela).
  function handleToggleInteractionMode() {
    setMode((m) => (m === 'interaction' ? baseMode() : 'interaction'));
    resetSelection({ keepRoute: true });
  }

  // Fila: mesmo padrão de mark/ptp/interaction acima, botão flutuante
  // próprio (ícone de índice, ver FloorPlanCanvas.jsx) — ocupa o espaço que
  // era da roleta de zoom, removida (o modo Interação já cobre bem esse
  // gesto). Abrir o painel zera a notificação (bolinha vermelha com a
  // contagem de tasks solicitadas desde a última vez que foi aberto).
  function handleToggleQueueMode() {
    const keepRoute = isPeekMode(mode); // ver handleModeChange acima
    const entering = mode !== 'queue';
    setMode(entering ? 'queue' : baseMode());
    resetSelection({ keepRoute });
    if (entering) setQueueNotifCount(0);
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
  function projectedOccupancy(pickedUp, droppedOff) {
    const set = new Set(occupied);
    for (const name of pickedUp) set.delete(name);
    for (const name of droppedOff) set.add(name);
    return set;
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

  // Disparo/avanço/sondagem de verdade (falar com o robô, decidir
  // atual/pendente/fila, detectar FINISHED/CANCELLED, marcar ocupação) não
  // mora mais aqui — é tudo dono do servidor agora (ver CONTEXT.md, "Fila
  // de rotas compartilhada", e hooks/useLiveState.js). Este componente só
  // manda a INTENÇÃO ("quero enviar essa rota") e mostra o que o servidor
  // reporta de volta (qual slot a rota ocupou, ver TOAST_BY_SLOT).
  async function handleEnqueueRoute() {
    // Contagens iguais é pré-requisito (o botão já fica desabilitado sem
    // isso, ver PointToPointBar) — todo pallet pego precisa ter pra onde ir.
    if (!pickupNames.length || pickupNames.length !== dropoffNames.length) return;
    const pairs = pickupNames.map((pickup, i) => ({ pickup, dropoff: dropoffNames[i] }));
    setSending(true);
    try {
      // SEMPRE em lote, mesmo pra um par só: o servidor valida a cadeia
      // inteira com ocupação projetada (rota 2 em diante seria rejeitada se
      // fosse enviada uma a uma, porque no instante do envio a origem
      // anterior ainda está ocupada — o robô nem começou). Ver
      // /api/queue/enqueue-batch em server.py.
      // palletTop só vale pra azul; o servidor ignora pra madeira, mas
      // manda limpo mesmo assim.
      const { slot } = await enqueueRoutes({ pairs, palletType, palletTop: palletType === 'blue' && palletTop });
      // Substituição puramente visual (ver useCalibration.js,
      // displayCellName) — `pairs` (mandado pro servidor acima) continua
      // com os nomes técnicos, só o texto do toast troca pro apelido.
      const label = pairs.length > 1
        ? pairs.length + ' rotas enviadas em sequência: ' + pairs.map((p) => displayCellName(p.pickup, lots, points) + '→' + displayCellName(p.dropoff, lots, points)).join(', ')
        : TOAST_BY_SLOT[slot] + displayCellName(pairs[0].pickup, lots, points) + ' → ' + displayCellName(pairs[0].dropoff, lots, points);
      showToast(label, slot === 'current' ? 'success' : 'info');
      // Bolinha de notificação do botão Fila: conta as tasks solicitadas
      // desde a última vez que o painel foi aberto (ver handleToggleQueueMode).
      setQueueNotifCount((c) => c + pairs.length);
      // Limpa só no sucesso: se deu erro, a seleção montada continua ali
      // pro operador corrigir em vez de ter que remontar tudo do zero.
      handleClearSelection();
    } catch (err) {
      showToast('Erro ao enviar rota: ' + err.message, 'error');
    } finally {
      setSending(false);
    }
  }

  async function handleCancelCurrent() {
    if (!currentRoute) return;
    try {
      await cancelCurrent();
      showToast('Rota em andamento cancelada.', 'success');
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
  // 3. A ROTA ATUAL, um par só, sem número — o padrão de repouso, o que o
  //    robô está fazendo AGORA.
  const mapPickupNames = pickupNames.length ? pickupNames
    : selectedQueueGroup ? selectedQueueGroup.map((r) => r.pickup)
    : currentRoute ? [currentRoute.pickup] : EMPTY_SELECTION;
  const mapDropoffNames = dropoffNames.length ? dropoffNames
    : selectedQueueGroup ? selectedQueueGroup.map((r) => r.dropoff)
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
        devMode={devMode}
        onDevButtonClick={handleDevButtonClick}
        user={user}
        onLogout={onLogout}
        robotCharging={robotCharging}
        robotBattery={robotBattery}
      />
      <CloseUpStatusBanner name={activeCloseUpId ? closeUps.find((c) => c.id === activeCloseUpId)?.name : null} />

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
          <aside className="sidebar">
            <PointToPointBar
              pickupNames={pickupNames}
              dropoffNames={dropoffNames}
              lots={lots}
              points={points}
              onClear={handleClearSelection}
              onSend={handleEnqueueRoute}
              sending={sending}
              willQueue={!!currentRoute}
              palletType={palletType}
              onPalletTypeChange={setPalletType}
              palletTop={palletTop}
              onPalletTopChange={setPalletTop}
              sequenceMode={sequenceMode}
              onToggleSequenceMode={handleToggleSequenceMode}
              activeSlot={activeSlot}
              onActiveSlotChange={setActiveSlot}
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
            <HistoryPanel />
          </aside>
        )}
        {mode === 'users' && (
          <aside className="sidebar">
            <UsersPanel currentUsername={user.username} showToast={showToast} />
          </aside>
        )}
      </div>

      <Toast toast={toast} />
      <DevModeModal open={devModalOpen} onSubmit={handleDevModalSubmit} onClose={handleDevModalClose} />
    </div>
  );
}
