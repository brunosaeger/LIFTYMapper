# Chat geral e Solicitação de pallets

Arquivos: `server.py` (blocos "Chat" e "Solicitação de pallets"),
`web/src/api/chat.js`, `hooks/useChat.js`, `components/ChatPanel.jsx`,
`components/PalletRequestPanel.jsx`, `components/RequestIcons.jsx`,
`FloorPlanCanvas.jsx` (`RequestMark`, `DraftRing`, camada própria).

Ler junto: [ocupacao.md](ocupacao.md) (o que limpa as marcas),
[mapa.md](mapa.md), [../../web/CONTEXT.md](../../web/CONTEXT.md) (modos e
trava de menu).

## Chat

- `chat.json` (gitignored, entra no exportar-dados): `messages`
  {id, user, text, at, ts, kind?, positions?}, `nextId`, `reads`
  {usuário: último id lido}. Mensagem com mais de 12 h some na leitura
  (`CHAT_TTL_SECONDS`); texto até 500.
- `GET /api/chat` → {messages, lastReadId, palletRequests};
  `POST /api/chat/send {text}`; `POST /api/chat/read {id}`. Quem envia já
  "leu" a própria mensagem.
- Front: `useChat` sonda a cada 4 s (dedupe por assinatura), marca lido
  sozinho com o chat aberto, `unread` = mensagens de OUTROS depois da última
  lida. Ícone redondo no canto superior esquerdo do mapa (onde era o botão
  de emergência), bolinha vermelha. Modo `chat` = peek mode, sidebar larga.
- Balões: os de quem está logado ficam à direita, PREENCHIDOS com a cor da
  borda (`--accent-cyan-dim`, nos dois temas); os dos outros, à esquerda, só
  com borda.

### Responder uma mensagem (estilo WhatsApp)
- **Segurar** uma mensagem (balão ou cartão de solicitação) ~0,45 s
  (`LONG_PRESS_MS`; mexer > 10 px cancela) → prévia "Respondendo X" em cima
  da barrinha, com ✕ (ou Esc) pra desistir; a mensagem segurada ganha
  contorno ciano. O clique que vem depois do "segurar" é engolido
  (`swallowClickAfterPress`) — segurar o cartão não dá zoom.
- `POST /api/chat/send {text, replyTo: id}` → o servidor guarda uma CÓPIA
  curta (`_chat_reply_snapshot`: id, user, 140 caracteres, e `positions` se
  for solicitação) em `msg.replyTo` — a citação sobrevive à original sumir
  nas 12 h.
- A resposta mostra a citação (`.chat-quote`) em cima do texto; tocar nela
  rola até a original e pisca (`is-flash`), ou avisa que já saiu do chat.
- Só mensagens de texto são respostas (solicitação nova não cita nada).

## Solicitação de pallets (2026-11-26)

Aviso visual pra pedir pallet numa posição. **Não trava tarefa, ninguém
aceita/recusa.** (Um desenho anterior com aceitar/recusar e reservas foi
feito e descartado em 25/11 — não recriar.)

- Mãozinha da barrinha do chat → modo `request` (menu "SOLICITAÇÃO DE
  PALLETS"). **Ao entrar, o mapa afasta sozinho** (`resetViewRequest` →
  `handleResetView({ fromButton: false })` no FloorPlanCanvas) **e o 1º toque
  amplia o kanban** (`requestZoomPicking` já ligado). Depois: escolher Madeira/Azul (obrigatório pra marcar), tocar nas
  posições VAZIAS (ocupada → aviso + pulso; tocar de novo tira; com o outro
  material troca), barrinha "LOTES SOLICITADOS", mensagem opcional,
  "Remover solicitação" (vermelho) e "Enviar solicitação" (verde, play).
- **Trava**: só sai do menu por esses dois botões. Qualquer outra troca de
  modo passa por `blockedByRequest()` (MainApp) → aviso + o vermelho pulsa
  (`requestCallId`). Lupa "+" liga `requestZoomPicking` (toca no kanban,
  amplia, continua no menu); lupa "−" afasta E liga `requestZoomPicking`
  (igual aos outros menus: o próximo toque no mapa escolhe o kanban). Todo handler novo de troca de
  modo precisa chamar `blockedByRequest()`.
- Servidor: `POST /api/chat/pallet-request {positions:[{name, material}],
  text?}`, tudo ou nada: 403 `denied` (fora do kanban, `_user_can_mark`),
  409 `occupiedNames` (já tem pallet), 400 posição desconhecida (máx. 60).
  Feito sob CALIBRATION_LOCK → CHAT_LOCK → PALLET_REQUESTS_LOCK (essa
  ordem). Vira mensagem `kind: "palletRequest"` e grava
  `pallet_requests.json` {nome: {material, msgId, user, at}} (gitignored,
  entra no exportar-dados).
- Cartão no chat (ícone pallet+caixa): lotes, materiais, mensagem, status
  "Aguardando pallets" / "N de M aguardando" / "Atendida" / "Cancelada".
  Tocar = zoom no kanban da 1ª posição ainda pendente.
- **Cancelar**: botão largo vermelho com ✕ embaixo do cartão, **só pra quem
  enviou** e só enquanto há posição esperando. `POST
  /api/chat/pallet-request/cancel {id}` (403 pra outro usuário, 404 se não
  existe): marca `cancelled` na mensagem (o cartão fica, esmaecido) e tira as
  marcas amarelas com aquele `msgId` (CHAT_LOCK → PALLET_REQUESTS_LOCK). A
  resposta já traz o chat — o amarelo some na hora.
- **Material exigido**: destino com pedido ativo só recebe o material pedido
  ali. Barrado com o aviso "Atenção ao material do pallet: a solicitação em
  {apelido} pede pallet de MADEIRA, e esta tarefa leva pallet de AZUL
  (metal)." + pulso no destino:
  - no site (`requestedMaterialMismatch`/`firstRequestMismatch` em MainApp):
    ao tocar o destino (material vem da origem, `materialForPickup`), ao
    adicionar à lista, ao trocar o pallet na lista e antes de "Iniciar";
  - no servidor (o gate de verdade): `_pallet_request_mismatch` em
    `enqueue-batch` → 409 `{materialMismatch, name, wanted, sent}` (o site
    mostra o mesmo aviso e relê o chat).
- **A marca sai de vez** quando a posição fica ocupada (entrega do robô ou
  Marcação madeira/azul — `_write_calibration` → `_prune_pallet_requests`)
  ou com o X da Marcação (`set_pallet_material_many(material=None)` →
  `_clear_pallet_requests`). Não expira com as 12 h (o cartão sim).
- **Instantâneo**: a Marcação esconde o amarelo no ato
  (`chat.hideRequests`) e relê o chat quando o servidor responde
  (`chat.confirm`, zera a assinatura — posição recusada volta). Sem isso
  levava até 4 s (erro já cometido).

### Desenho no mapa (`RequestMark`)
- Camada Konva própria, `listening={false}`, por cima dos lotes.
- Amarelo `#FFD21F` translúcido + textura do material translúcida.
- **Rascunho**: quadrado 1,22× a célula, borda grossa com um "chevron
  invisível" que percorre o contorno e apaga a borda por onde passa
  (`DraftRing`: `clipFunc` com `evenodd`). Todos sincronizados pelo relógio
  (`performance.now()`), não pelo início de cada um (já ficou um caos).
- **Enviada**: tamanho normal da célula, MANTÉM o chevron. Sem seta (o
  usuário tirou).
- Enviada fica escondida (só visual) enquanto a posição está no destaque
  origem/destino (Ponto a Ponto/Fila/rota atual) ou é destino de tarefa na
  fila — aí o número da fila (`QueueMark`) fica amarelo. Tarefa cancelada →
  o amarelo volta.
