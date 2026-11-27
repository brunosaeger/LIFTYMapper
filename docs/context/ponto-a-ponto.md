# Ponto a Ponto, lista de envio e visualização de tarefas (front)

Como o operador monta tarefas. Tudo é estado LOCAL do aparelho até o
"Iniciar tarefas" — só então vai pro servidor, num envio só.

Arquivos: `web/src/MainApp.jsx` (estado e regras),
`components/PointToPointBar.jsx`, `components/StagedTasksPanel.jsx`,
`components/QueuePanel.jsx` (Fila), `components/CloseUpStatusBanner.jsx`.

Ler junto: [ocupacao.md](ocupacao.md) (regra de fronteira e material),
[fila.md](fila.md) (o que o servidor faz com o envio),
[mapa.md](mapa.md) (gesto, destaque, zoom), [../../web/CONTEXT.md](../../web/CONTEXT.md).

## Seleção (`mode === 'ptp'`)

- `pickupNames`/`dropoffNames` são LISTAS (0 ou 1 nome no modo normal; N na
  sequência) — nomes TÉCNICOS; a tela mostra o apelido (`displayCellName`).
- 1º toque = origem, 2º = destino; tocar na origem atual limpa tudo, no
  destino limpa só ele.
- Clique inválido (vazio na coleta, ocupado na entrega, obstrução, origem
  sem material, fora do kanban, destino com Solicitação de pallets pedindo
  outro material) → toast + **pulso vermelho** no quadrado
  (`triggerInvalidPulse`, `invalidPulse {name, id}` — o `id` muda a cada
  disparo) + som `failedtrue`.
- Destino é validado com a origem já removida (pegar A, soltar A2 vale).
- Seleção nova projeta a ocupação a partir das tarefas já preparadas
  (`stagedBeforeSelection`) — dá pra montar A e depois A2 separadas.

## "Lotes em sequência" — checkbox fora da tela (2026-11-24)

Só o checkbox saiu; `sequenceMode` e toda a lógica continuam (começa
`false`, então não dá pra montar sequência nova). Regras, se voltar: origens
de lote todas da MESMA coluna (pontos avulsos são curinga), contagens
origem = destino pra enviar, clicar num já selecionado trunca dali pra
frente, número de ordem no mapa (`SeqBadge`).

## Lista "Tarefas aguardando envio" (`stagedUnits`)

- "Enviar tarefa" só adiciona à lista; **"▶ Iniciar tarefas"** manda tudo.
- Modelo = lista de UNIDADES (avulsa ou grupo de sequência; grupo move
  junto, tracejado laranja). `palletType` vive em cada TAREFA
  (`unit.tasks[i].palletType`) — já houve bug trocando o pallet do grupo
  inteiro.
- Tocar na barrinha = editar (origem/destino ampliados no mapa; Enviar vira
  "Salvar alterações" com sonar ciano; Limpar vira "Cancelar edição") + zoom
  no kanban da origem ("Visualizar tarefa"). Tocar no grupo = mostra todas as
  origens/destinos empilhados (`viewTask.index = null`).
- Segurar ~0,3 s e arrastar reordena (rolagem nativa do menu continua: a
  barrinha é `touch-action: pan-y`; só trava a rolagem depois do hold).
  Soltar fora da lista volta pro lugar.
- Reordenar/remover/salvar que quebra a cadeia é recusado
  (`validateChain`/`checkStagedChange`, mesma regra do servidor). Se a lista
  ficar inválida por fora, a tarefa problemática fica vermelha e "Iniciar"
  trava com o motivo.
- Envio: `POST /api/queue/enqueue-batch` com `group` e `palletType` POR PAR.
  Erro `operationBlocked` (horário de operação) mostra a mensagem crua.
- Lista com tarefas mostra "Confira se os materiais dos pallets
  correspondem à sua posição."

## Visualizar (banner `CloseUpStatusBanner`)

"VISUALIZANDO: KANBAN X" + linha `ORIGEM → DESTINO` com pílulas clicáveis
(ciano/âmbar). Mesmo mecanismo pra Ponto a Ponto (`viewTask`), Fila
(`selectedQueueRouteId`, inclusive `'current'` = rota em andamento) e
Histórico (`selectedHistoryRoute`) — `handleFocusEndpoint` decide pelo
modo. Tocar numa ponta = `requestFocus(name)` → zoom no kanban que contém o
ponto (se origem e destino estão no mesmo kanban, a tela não mexe).
Prioridade do destaque no mapa: seleção do Ponto a Ponto > Fila/Histórico >
rota atual.

## Fila (`QueuePanel.jsx`, `mode === 'queue'`)

"Rota em andamento" (verde, barra pulsando — não é % real) e "Próximas
rotas" (âmbar). Grupos com tracejado laranja (`groupWaitingRoutes`, rotas
consecutivas do mesmo `groupId`). Clicar numa rota = zoom + banner + só
aquele par no mapa, com o número dela no grupo (`seqOverride`). Segurar e
arrastar reordena (não a `pendingRoute`). "Enviado por" em cinza. Ícone do
material (só leitura). Lixeira "limpar fila" pra Admin/Mestre/dev (pede
confirmação). Bolinha do ícone = tarefas pedidas desde a última abertura.
Bug já corrigido: `setPointerCapture` no arrasto quebrava o clique em filhos
— todo clique de seleção fica no `<li>` raiz com delegação por
`data-route-id`.
