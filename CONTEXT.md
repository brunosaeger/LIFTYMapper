# 33R-LIFTY — Painel de Controle da Forklift Autônoma

Contexto acumulado do desenvolvimento até agora. Serve pra qualquer pessoa (ou eu
mesmo, numa sessão futura) retomar o projeto sem precisar re-perguntar o básico.

## O que é isso

Um painel de controle pra uma empilhadeira/paleteira autônoma (fabricante REEMAN,
robô `rbot55f`, modelo Hercules 3.0) que opera num armazém com pontos de
coleta/entrega calibrados manualmente e lotes de armazenamento (linhas/colunas de
posições numeradas), operando em conjunto com paleteiras humanas.

**Linha do tempo do projeto:**
1. Primeira versão: painel simples com 5 botões (A→B, B→A, ir pra carga, ir pra
   home, parada de emergência) — usado com sucesso numa apresentação ao vivo.
   Vanilla JS, um arquivo só. Ainda existe em `legacy/index.html`, só como
   referência histórica — não é mais servido pelo `server.py`.
2. Segunda versão (ainda vanilla JS): células fixas + construtor de lotes em
   matriz NxM, com vínculo manual de task ID por seção via "modo desenvolvedor".
   Também zerada.
3. **Versão atual: reescrita completa em React** (`web/`), com editor visual de
   pontos sobre a planta baixa real do galpão (Konva/react-konva, zoom/pan,
   arrastar/girar/redimensionar), criação dinâmica de task via API (sem
   pré-cadastro), fila de rotas com priorização automática, e sistema de
   marcação de ocupação de posições. Detalhado abaixo.

## Arquivos

- `web/` — app React (Vite). Ver "Arquitetura do app React" abaixo.
- `server.py` — servidor local (só biblioteca padrão do Python 3, zero
  dependências). Serve o build (`web/dist`) estático, faz proxy reverso de
  `/api/reeman-dispatch-service/*` pro IP real do robô, persiste a
  calibração (`/api/calibration` ↔ `calibration.json` no disco) e o
  histórico de rotas (`/api/route-log*` ↔ `route_log.json` no disco — ver
  "Modo desenvolvedor" abaixo).
- `legacy/index.html` — versão anterior (vanilla JS, células fixas + lotes),
  mantida só como referência. Não é mais servida.
- `CONTEXT.md` — este arquivo.

## Rodando o projeto

```
cd web && npm run build && cd ..   # gera web/dist
python3 server.py                  # serve tudo + proxy, porta 8000
```
Em desenvolvimento, rodar os dois em paralelo:
```
cd web && npm run dev    # Vite dev server, porta 5173, hot-reload
python3 server.py        # porta 8000 — proxy pro robô + /api/calibration
```
`web/vite.config.js` já encaminha `/api/*` do dev server (5173) pro `server.py`
(8000), então funciona sem CORS em dev também.

**Antes de rodar em campo:** editar `ROBOT_HOST` no topo do `server.py` com o
IP do robô na rede daquele dia (muda conforme a rede usada). IP validado nos
últimos testes: `192.168.43.74` (rede de hotspot de celular usada pros
testes — ver seção de tablet abaixo pro porquê disso importar).

**CUIDADO — `crypto.randomUUID()` não funciona fora de "contexto seguro"**:
essa API (usada pra gerar id de ponto/lote/rota) só existe em HTTPS ou em
`localhost`/`127.0.0.1` — em HTTP simples acessado por **IP de rede puro**
(exatamente como um tablet acessa esse app, via `http://<ip-do-servidor>:8000`,
já que "localhost" no tablet seria o próprio tablet), o navegador **nem
expõe essa função** — chamar ela lança `TypeError` na hora, silenciosamente
(geralmente é a primeira linha da função, fora de qualquer `try/catch`,
então não aparece toast de erro nem log de rede nenhum — parece que
"simplesmente não faz nada"). Isso já causou um bug real: funcionava
perfeito testando do próprio computador que roda o `server.py` via
`localhost:8000` (contexto seguro), e falhava 100% das vezes no tablet
(só alcança via IP da rede). Corrigido usando um gerador de id próprio
(`src/utils.js`, `generateId()`) em vez de `crypto.randomUUID()` — **não
reintroduzir esse método em lugar nenhum do código**, esse app É PRA
RODAR em HTTP puro numa rede industrial sem HTTPS/domínio, de propósito
(ver seção seguinte).

## Por que existe um proxy (`server.py`) e não dá pra chamar a API direto

A API de task-fast usa `Content-Type: application/json`, o que dispara um
*preflight* (OPTIONS) no navegador antes do POST. O dispatch service do robô
não responde esse preflight — então mesmo com a rede certa e sem
autenticação, uma chamada direta do navegador é bloqueada silenciosamente
antes de sair. Isso não aparece em teste com `curl` (que ignora CORS), só
dentro do navegador.

`server.py` resolve isso: o navegador só fala com ele (mesma origem, zero
CORS), e ele repassa a chamada pro robô via uma requisição HTTP comum
(server-to-server não tem regra de CORS).

## Arquitetura do app React (`web/`)

Vite + React, sem TypeScript. `react-konva`/`konva` pro editor visual sobre a
planta baixa. Sem router (é uma tela só, com "modos").

### Arquivos principais

- `src/App.jsx` — estado raiz: modo atual (`edit`/`ptp`/`mark`/`history`),
  seleção, fila de rotas, modo desenvolvedor, toda a lógica de negócio
  (disparo de task, sondagem de status, validação de fronteira de
  ocupação). O arquivo mais denso do projeto, com comentários explicando o
  *porquê* de cada decisão não-óbvia.
- `src/components/FloorPlanCanvas.jsx` — o editor visual (Konva). Stage com
  zoom/pan, desenha a imagem da vista atual + pontos avulsos + lotes,
  gerencia os gestos de interação (arrastar pra criar lote, pintar
  ocupação, crescer no hover, soltar pra confirmar). Também o maior/mais
  denso.
- `src/hooks/useCalibration.js` — estado de pontos/lotes/ocupação +
  persistência (debounced, 500ms) em `/api/calibration`.
- `src/api/lifty.js` — toda chamada HTTP pro dispatch service do robô (porta
  direta do antigo `window.LIFTY`, expandida) + chamadas pro histórico de
  rotas do nosso próprio `server.py`.
- `src/components/`: `Toolbar`, `PointsPanel`, `LotsPanel`, `PointToPointBar`,
  `RouteQueue`, `OccupancyPanel`, `HistoryPanel`, `DevModeModal`, `Toast` —
  peças da UI, veja cada uma.
- `src/theme.js` — paleta de cores em hex (Konva não lê CSS custom
  properties, então os valores existem duplicados aqui e em `index.css`).
- `src/utils.js` — `generateId()`, gerador de id que substitui
  `crypto.randomUUID()` (ver "CUIDADO" na seção "Rodando o projeto" acima —
  essa API não funciona em HTTP puro fora de localhost).

### Duas vistas independentes (topo / isométrica)

Botão flutuante (ícone de olho) em cima do canvas alterna entre a planta
baixa (`src/assets/floorplan.jpg`) e uma vista isométrica
(`src/assets/isometric.jpg`). **Cada vista tem seu próprio conjunto de
pontos/lotes calibrados** (posição, ângulo, tudo) — são fisicamente a mesma
posição real, mas a calibração visual é feita duas vezes, uma pra cada
imagem, porque o ângulo de câmera é diferente.

O único vínculo entre as duas vistas é o **nome** do ponto/célula — se
existir um ponto chamado `A1` nas duas vistas, é o mesmo lugar físico (mesma
task no robô), mas cada vista guarda posição/rotação próprias. Nada é
copiado automaticamente entre vistas: se você calibrou só na vista de cima,
o ponto simplesmente não aparece na isométrica até ser calibrado lá também.

`calibration.json` (ver `useCalibration.js`):
```json
{
  "top": { "points": [...], "lots": [...] },
  "iso": { "points": [...], "lots": [...] },
  "occupied": ["A1", "B3", ...]
}
```
`occupied` é **global** (não por vista) — representa um fato físico do
armazém (tem pallet ali agora ou não), válido nas duas vistas ao mesmo
tempo.

Formato antigo (pré-isométrico, `{points:[...], lots:[...]}` direto, sem
`top`/`iso`) é migrado automaticamente no load — vira a vista `top`, `iso`
nasce vazia.

### Modelo de dados

**Ponto avulso**: `{ id, name, x, y, rotation }` — `x`/`y` em fração [0,1]
da imagem da vista (não pixel de tela), sobrevive a qualquer zoom/resolução.

**Lote** (linha ou coluna de células grudadas, criado por clique-e-arrasto):
`{ id, prefix, x, y, rotation, count, cellSize, scaleX, scaleY, color,
namesVisible }`. Cada célula tem nome derivado: índice 0 = só o prefixo
(`A`), demais numeram a partir de 2 (`A2`, `A3`...) — `lotCellName(prefix,
index)` em `useCalibration.js`. `cellSize` fica gravado no momento da
criação (não recalculado depois — ver `DEFAULT_CELL_SIZE` em
`FloorPlanCanvas.jsx`, hoje `11.97`px de conteúdo, extraído medindo os
lotes já calibrados manualmente pelo usuário pra bater com o tamanho físico
dos kanbans reais).

### Quatro modos de interação (`mode` em `App.jsx`)

- **`edit`**: criar/editar pontos e lotes (arrastar, girar, redimensionar
  lote via `Transformer` do Konva), renomear, colorir lote, excluir. **Só
  alcançável em modo desenvolvedor** (ver seção própria abaixo) — pra
  qualquer outro usuário, esse modo nunca é atingido por nenhum caminho da
  UI.
- **`ptp`** (Ponto a Ponto): selecionar pickup → dropoff clicando no mapa,
  disparar a task de verdade pro robô. Sidebar mostra fila de rotas. É o
  modo padrão (inicial) do app pra quem não é dev — ver "Modo
  desenvolvedor" abaixo pro porquê.
- **`mark`**: marcar/desmarcar ocupação de posições (tem pallet ali ou
  não), com o gesto de "pintar arrastando" (ver abaixo).
- **`history`** (só em modo desenvolvedor): painel de histórico de rotas +
  erros/avisos do robô, sem interação nenhuma com o mapa. Ver seção
  própria abaixo.

Acesso a `ptp`/`mark` é por **botões flutuantes** sobre o canvas (não pelo
Toolbar): ícone de olho (trocar vista topo/isométrica), X (entrar/sair de
`mark`) e ícone de rota (entrar/sair de `ptp`) — empilhados no canto
superior direito do mapa, mesmo tamanho (56px), 20px de espaço entre eles.
Sair de `ptp`/`mark` sempre volta pro modo de repouso (`baseMode()` em
`App.jsx`): `edit` se for dev, `ptp` pra todo mundo mais.

`ptp` e `mark` compartilham o mesmo **gesto de interação de base**: passar
o mouse/dedo por cima de um quadrado o faz crescer (animação, `usePtpScale`
em `FloorPlanCanvas.jsx`), e a ação de verdade só acontece **ao soltar** —
nunca no toque inicial. Isso existe especificamente pra touchscreen: evita
que o operador confirme sem querer no primeiro toque errado; arrastar o
dedo por cima de vários quadrados troca qual está "ativo" em tempo real
(Konva reavalia o hit-test a cada movimento, mesmo em touch — não é
elemento DOM por célula).

**Pintar arrastando (modo `mark`)**: em vez de tocar quadrado a quadrado,
dá pra pressionar e arrastar por cima de vários — cada um entra numa
prévia visual (X translúcido) sem confirmar nada ainda. A direção
(marcar/desmarcar) é decidida pelo estado do PRIMEIRO quadrado tocado no
gesto; só ao soltar tudo que ainda está no "caminho" é aplicado de uma vez
(`setOccupiedMany` em `useCalibration.js`). **Retraçar desfaz**: se o
dedo/mouse volta por cima de um quadrado já tocado sem soltar, tudo que
veio depois dele na prévia é descartado (o "caminho" é truncado de volta
pra esse ponto) — implementado como um array ordenado
(`paintPathRef`), não um Set, exatamente pra permitir esse truncamento.
Ver `registerPaintTouch`/`commitOnRelease` em `FloorPlanCanvas.jsx`.

**Pan (arrastar pra mover o mapa) sempre funciona**, em qualquer modo,
**exceto** quando o toque começa em cima de um ponto/célula nos modos
`ptp`/`mark` — aí arrastar é o gesto de seleção/pintura acima, e os dois
brigariam pelo mesmo movimento. Nesse caso específico, `stage.stopDrag()`
é chamado no `mousedown`/`touchstart` (antes do pan sequer começar) pra
cancelar o pan nativo do Stage. Começando em espaço vazio (mesmo em
`ptp`/`mark`), o pan funciona normalmente.

### Modo desenvolvedor

Botão `{ }` na ponta direita do Toolbar (`Toolbar.jsx`) — pede uma senha
(`DevModeModal.jsx`; a senha está hardcoded em `App.jsx`,
`DEV_PASSWORD` — **isso NÃO é segurança de verdade**, é só uma trava de UI
pra esconder edição de quem tá mexendo no tablet no dia a dia; a senha
fica visível em texto no bundle JS pra quem abrir o devtools). Não
persiste entre reloads (trava de sessão, não preferência salva).

Com o modo ativo: libera a aba **"Editar pontos"** + **"Histórico"** e os
botões **"+ Ponto"**/**"+ Lote"** no Toolbar — todos escondidos por
completo sem ele. Sair do modo (clicar em `{ }` de novo, sem pedir senha —
senha só é exigida pra ENTRAR) força o modo de volta pro `ptp` se estava
em `edit`/`history`.

**Importante**: só esconder os botões não bastaria — o modo padrão do app
era `edit` antes dessa mudança, o que tornaria a trava inútil (o app já
cairia sozinho no modo escondido). Por isso o modo inicial virou `ptp`, e
o modo de "repouso" pra onde os toggles de `ptp`/`mark` voltam
(`baseMode()` em `App.jsx`) só é `edit` quando `devMode` está ativo.

### Painel "Histórico" (modo desenvolvedor, `HistoryPanel.jsx`)

Duas seções empilhadas na sidebar, **cada uma com seu próprio scroll
independente** (não o scroll do sidebar inteiro — ver `.sidebar--history`/
`.history-panel__list` no CSS, padrão `flex:1 + min-height:0 +
overflow-y:auto` aninhado):

1. **Histórico de rotas**: quando cada rota foi solicitada e concluída.
   **Carimbado pelo relógio da máquina que hospeda o `server.py`** — de
   propósito NÃO é o relógio do dispatch service (robô) nem do
   navegador/tablet do operador, que podem estar em fusos/horas
   diferentes. Isso exigiu um mecanismo próprio: `POST
   /api/route-log/request` (chamado de `fireRoute` em `App.jsx` assim que
   uma rota é disparada com sucesso) e `POST /api/route-log/complete`
   (chamado quando a sondagem detecta `FINISHED`/`CANCELLED`, ou no
   cancelamento manual) — o `server.py` é quem carimba
   `requestedAt`/`completedAt` com `datetime.now()` DELE, não o navegador
   quem manda um timestamp pronto. Persistido em `route_log.json`
   (capado em 500 entradas — roda 24/7 num armazém sem manutenção, evita
   crescer pra sempre). Todas as chamadas de log são **melhor esforço**
   (`.catch(() => {})`) — uma falha aqui nunca deve impedir o
   disparo/conclusão real da rota.
2. **Erros e avisos**: `GET /error/records` do dispatch service (ver
   tabela de endpoints abaixo) — schema validado contra resposta real do
   robô.

## A API do dispatch service (tudo validado nesta sessão)

- Base: `http://{IP_DO_ROBO}/api/reeman-dispatch-service{endpoint}`
- Resposta padrão: `{"code": 0, "message": "success"/"Sucesso", "data": {...}}`;
  `code=0` é sucesso.
- **Sem autenticação** — confirmado testando em produção.

### Endpoints usados (`src/api/lifty.js`)

| Endpoint | Uso |
|---|---|
| `POST /task-template/create` | Cria um template de task (`taskActionList` com PICKUP/UNLOAD). `id:null`=criar. |
| `GET /task-template/page?projectId&page&size&name&description` | Lista/busca templates por nome — usado pra **reaproveitar** um template já criado em vez de tentar criar de novo (ver abaixo). |
| `POST /task-template/generic/task-fast/{id}` | Dispara a execução de um template. Não retorna `taskRecordId` na resposta (gotcha original). |
| `GET /task-record/page?projectId&page&size&status&name` | Lista/busca registros de execução (instâncias, não templates). Paginado, ordenado mais-recente-primeiro. **Status confirmados: `WAITING`, `FINISHED`, `CANCELLED`** (não vimos o valor de "em execução" ainda — tratamos qualquer status que não seja `FINISHED`/`CANCELLED` como "ainda não terminou"). `taskType` confirmado: `FAST` (nossas tasks), `AUTO_SYSTEM` (task automática do robô, ex: ida pra carga). |
| `POST /task-record/all-cancel/{projectId}` | Cancela **tudo** que estiver ativo/pendente pro projeto. Usado só no botão de emergência (`handleCancelCurrent`). |
| `POST /task-record/cancel/{taskRecordId}` | Cancela **uma task específica** por id, sem afetar as outras. Descoberto capturando o botão "Cancelar tarefa" da plataforma admin. Usado pra cancelar só a task automática de carga sem derrubar a rota que acabou de ser disparada. |
| `GET /action-record/list/{taskRecordId}` | Lista as **ações individuais** dentro de uma task (cada PICKUP/UNLOAD do `taskActionList`), com `status`/`startTime`/`finishTime` por ação. Usado no Caso 2 da marcação de ocupação (ver seção própria) — `finishTime` não-nulo confirmado em campo como sinal de "ação concluída com sucesso", mesmo nunca tendo visto o texto de `status` correspondente (só `"CANCELLED"` num exemplo). |
| `GET /action-type/list-all` | Lista os tipos de task existentes: `FAST`, `TIMED`, `TEMP_TASK_CHAIN`, `CAMERA`, `AUTO_SYSTEM`, `BUTTON_TASK`. Descoberto mas não usado ainda. |
| `GET /error/records?projectId&page&size` | Lista registros de erro/aviso do robô, paginado (`total`/`size`/`current`/`pages`). Schema validado contra resposta real: `records[]` com `id, projectId, agvId, error, level` (`"ERROR"`/`"WARN"`), `description, happenTime, isRead, readTime`. Usado no painel "Histórico" (modo desenvolvedor, `HistoryPanel.jsx`) — `fetchErrorRecords` em `lifty.js`. |

### Criação dinâmica de task (resolve o problema combinatório)

Motivação: com lotes configuráveis (ex: dois lotes 5×6 = 900 combinações
origem→destino possíveis), pré-cadastrar um template por combinação na
plataforma do fabricante é inviável. `createAndRunRoute(pickup, dropoff)`
em `lifty.js`:

```js
{
  name: pickup + 'to' + dropoff,   // ex: "A1toB2"
  description: "",
  supportRobotTypes: ["犀牛2.0"],
  projectId: "13",
  id: null,
  taskActionList: [
    { targetMap: HASH_FIXO, targetPoint: pickup, action: "PICKUP", groupId:1, serialNumber:1, params:null },
    { targetMap: HASH_FIXO, targetPoint: dropoff, action: "UNLOAD", groupId:1, serialNumber:2, params:null },
  ],
}
```
`targetMap` é o hash do mapa ativo no robô — fixo depois de mapeado/salvo,
não muda (`CONFIG.TARGET_MAP` em `lifty.js`).

**Reaproveitamento de template**: o dispatch service rejeita criar um
template com nome repetido no mesmo projeto (`{"code":1,"message":"...任务
模版名称已存在..."}` = "nome já existe"). Como o "recipe" de uma rota A→B
nunca muda, `createAndRunRoute` primeiro procura um template já existente
com esse nome (`findTaskTemplateId`, via `task-template/page`) e só cria se
não achar — evita tanto o erro de nome duplicado quanto acumular um
template novo no dispatch a cada disparo da mesma rota.

### Fila de rotas e priorização automática (`App.jsx`)

Três camadas de estado:
- **`currentRoute`**: já disparada pro robô, rodando agora (no máx. 1).
- **`pendingRoute`**: já disparada pro robô TAMBÉM, mas o dispatch a segura
  como "próxima" porque a atual ainda não terminou (no máx. 1).
- **`routeQueue`**: ainda só local (array no navegador), nunca chegou a ser
  enviada — só vira `pendingRoute` quando esse slot esvaziar.

Sondagem (`useEffect` em `App.jsx`, a cada 4s) consulta
`GET /task-record/page` filtrado pelo nome exato da rota (com sufixo?
não — nome reaproveitado, ver acima; a correlação funciona porque cada
disparo cria um **registro de execução novo** mesmo reaproveitando o
**template**, e pegamos sempre o mais recente). `FINISHED` promove
`pendingRoute` → `currentRoute` **sem disparar de novo** (já estava
rodando, foi mandada com antecedência). `CANCELLED` só limpa, não promove
— mesma cautela de "não presuma que pode seguir".

**Comportamento do robô que motivou o design acima**: ao ficar sem NENHUMA
task na lista, o robô cria sozinho uma task automática (`AUTO_SYSTEM`) de
volta pra base de carga — e essa task tem a **mesma prioridade** de uma
task normal (não é preemptada; se já estiver rodando, uma `task-fast` nova
só começa depois dela terminar). Pra evitar esse desvio:

1. **Handoff entre rotas da fila** (`fireRoute` com `asPending:true`):
   dispara a próxima rota **enquanto a atual ainda roda** — o dispatch
   segura como "próxima" nativamente (mesma prioridade = fila FIFO simples
   no próprio dispatch), então a fila nunca fica vazia e o robô nunca tem
   motivo pra recriar a task de carga.
2. **Disparo a partir de estado ocioso** (`fireRoute` sem `asPending`,
   robô pode estar indo pra carga): usa `findActiveChargeTaskId()` **antes**
   de disparar (se procurasse depois, o registro mais recente já seria o
   nosso, não o da carga), dispara a rota nova (fica pendente atrás da
   carga — nunca zero tasks), e só então cancela a carga especificamente
   por id (`cancelTaskRecord`, nunca `all-cancel`, que pegaria a rota nova
   junto). Essa ordem (disparar antes de cancelar) evita uma corrida real
   que causava "robô para e volta pra energia" quando a ordem era invertida.

### Sistema de marcação de ocupação (pontos ocupados por pallet)

Motivo: outras paleteiras (humanos) operam no mesmo ambiente — o app
precisa saber se uma posição já tem pallet, tanto pra mostrar visualmente
quanto pra impedir o robô de tentar uma rota fisicamente impossível.

**Caso 1 (feito)**: modo `mark`, clique/toque marca ou desmarca uma célula
(mesmo gesto do Ponto a Ponto). Desenha um X na cor da célula, centralizado.
Funciona em pontos avulsos e células de lote. `toggleOccupied(name)` em
`useCalibration.js`, persistido em `occupied` (global, ver acima).

**Caso 3 (feito)**: regra de fronteira/FIFO — dentro do MESMO lote (não
entre lotes diferentes), uma célula ocupada bloqueia qualquer posição
"atrás" dela (índice maior) como **destino**, e qualquer posição "antes"
dela como **origem alcançável** — o robô entra numa coluna só por uma
ponta e não faz desvio lateral. Implementado como validação em
`handlePointToPointClick` (`isPickupAllowed`/`isDropoffAllowed` em
`App.jsx`), rejeita a seleção com toast explicando o motivo. Pontos
avulsos não têm essa regra (sem noção de ordem).

**Caso 2 (IMPLEMENTADO E VALIDADO EM CAMPO)**: marcação automática de
ocupação baseada no progresso da task — implementado no `useEffect` de
sondagem em `App.jsx` (o mesmo que já promovia a fila). Testado contra o
robô real: o pallet reposicionou (origem desmarcada no momento certo, ao
concluir o PICKUP) como esperado.

- A cada tick, além do status geral (`fetchLatestTaskRecord`, que substituiu
  `fetchLatestTaskStatus` — agora devolve o registro inteiro, `id` incluso,
  não só o status), busca `fetchActionRecords(taskRecordId)`
  (`GET /action-record/list/{id}`, em `lifty.js`) e olha a ação de
  `serialNumber: 1` (PICKUP). Se `finishTime` estiver preenchido (e ainda
  não tiver desmarcado nessa rodada) → desmarca a origem via
  `setOccupiedState(pickup, false)` — nova função determinística em
  `useCalibration.js`, ao lado do `toggleOccupied` usado pelo clique manual
  (evita desmarcar/remarcar em falso se o poll rodar mais de uma vez).
  Usa `finishTime` não-nulo como sinal de "terminou" em vez do texto de
  `status` da ação — **nunca vimos o valor de `status` de uma ação
  concluída com sucesso** (só `"CANCELLED"` uma vez), então depender do
  schema confirmado (`finishTime`) é mais robusto que adivinhar o enum.
- Quando a task inteira termina (`status === 'FINISHED'`, mesma condição
  que já promovia a fila) → marca o destino via
  `setOccupiedState(dropoff, true)`.

Confirmado: `finishTime` da ação PICKUP populate corretamente assim que ela
termina com sucesso, mesmo com a task inteira ainda em andamento (UNLOAD
não concluído) — a suposição de que esse campo seguia a convenção
"null-enquanto-pendente, preenchido-ao-terminar" (feita sem nunca ter visto
o valor de sucesso, só o de uma ação cancelada) se confirmou na prática.

### Tema claro/escuro

Botão lua/sol no Toolbar, logo antes do texto de status de salvamento
("Salvo"/"Salvando…"). Escuro é o padrão do site; claro é a mesma UI com
tokens de superfície/texto trocados (fundo cinza-quase-branco, texto
escuro) — cor de acento (âmbar/ciano), cor de lote e cor de estado
(erro/sucesso) ficam **iguais** nos dois temas de propósito (são cores
funcionais, não decorativas — trocar geraria risco de confundir
pickup/dropoff/ocupação sem necessidade).

**Duas frentes, porque Konva não lê CSS**: elementos HTML normais reagem
sozinhos via `:root[data-theme='light']` em `index.css` (as bordas de
painel — Toolbar, sidebar — já usam `var(--panel-line)`, então ganham
contraste de graça, sem CSS extra). O canvas (Konva) não lê custom
properties do CSS, então `theme.js` exporta `COLORS` como um objeto
**mutável** (sempre a mesma referência) e uma função `applyTheme(theme)`
que sobrescreve as propriedades em lugar (`Object.assign`) — chamada no
`useEffect` de tema em `App.jsx`, junto com `document.documentElement.
setAttribute('data-theme', ...)`. Não precisa passar `theme` como prop
pro `FloorPlanCanvas`: a troca de estado em `App.jsx` já re-renderiza a
árvore toda (nada é memoizado com `React.memo`), e como os componentes
Konva leem `COLORS.xxx` fresco a cada desenho (não cacheado), o próximo
render já pega os valores novos automaticamente.

Persistido em `localStorage` (`lifty-theme`) — por **dispositivo**, não
por usuário (ainda não existe conceito de usuário/login no app; login foi
discutido mas não implementado ainda).

### Diferenciação de pallets: Azul (metálico) vs Madeira

Motivação: a indústria onde o robô opera tem dois modelos físicos de
pallet — **azul** (metálico, levemente elevado do chão por 4 pezinhos) e
**madeira** (rente ao chão). Pra pegar o azul, o robô precisa de uma
altura no ponto de PICKUP (8cm) pra alinhar o garfo corretamente; o de
madeira não precisa (altura 0 — o comportamento que **todo** template
criado antes dessa feature já usa, implicitamente, já que `height` sempre
foi `0` fixo).

**UI** (`PointToPointBar.jsx`, modo `ptp`, abaixo das caixas de
origem/destino): seção "Escolha o modelo de pallet", dois botões com
textura de fundo (`src/assets/pallet-wood.png`/`pallet-blue.png` — apesar
da extensão `.png`, os arquivos são JPEG de verdade; Vite/navegador não se
importam, funciona igual) + label "Madeira"/"Azul" embaixo. Selecionado
tem borda destacada (`.is-selected`). **Azul vem selecionado por padrão**
(é o mais comum na planta). O estado (`palletType` em `App.jsx`) não é
resetado por `resetSelection()` — é uma preferência de sessão
("com que pallet estou trabalhando agora"), não amarrada à seleção de
origem/destino atual.

**Lógica** (`lifty.js`):
- **CUIDADO, já erramos isso uma vez**: o campo `height` que fica direto no
  topo da ação PICKUP **NÃO é o que a plataforma usa** pra alinhar o
  pallet — esse fica sempre `0`, pallet nenhum muda ele. O valor de
  verdade mora dentro de `params.PALLET_LAYER` (dois campos juntos,
  `height` **e** `layer`) — descoberto inspecionando o JSON real que a
  plataforma gera ao criar o template manualmente. Colocar o valor no
  campo de topo faz a plataforma marcar a checkbox de "0cm" na tela de
  criação de tarefa mesmo pedindo 8cm.
  `PICKUP_PALLET_LAYER = { wood: null, blue: { height: 8, layer: 2 } }` —
  madeira manda `params: null` (igual todo template de antes dessa
  feature), azul manda `params: { PALLET_LAYER: { height: 8, layer: 2 } }`.
  Só o PICKUP leva isso, o UNLOAD nunca (não foi pedido pro dropoff, `params`
  do UNLOAD é sempre `null`).
- `PALLET_NAME_SUFFIX = { wood: '', blue: 'MT' }` — pallet azul acrescenta
  `MT` (Metal) no nome do template/rota (`routeTaskName`), ex:
  `A1toB2MT`. Isso faz a mesma origem→destino virar **dois templates
  separados** dependendo do pallet (a altura de PICKUP faz parte do
  "recipe" da rota, não dá pra reaproveitar o nome de antes) — e por
  construção, todo template já existente (sem sufixo, `height:0`) continua
  servindo pra madeira sem precisar de migração nenhuma.
- `palletType` é capturado **no momento em que a rota é montada**
  (`handleEnqueueRoute`, guardado junto no objeto da rota) — não é relido
  depois, então trocar o pallet selecionado não afeta rotas que já estão
  na fila local esperando pra disparar.

## Investigação pausada: robô para sozinho a cada ~10-15m numa rota

Fora do escopo desse app (é comportamento do robô/navegação, não do
código aqui), mas registrando pra não perder o progresso se retomar.
Sintoma: em rotas retas longas, o robô desacelera, para completamente e
retoma sozinho, de forma determinística por **distância percorrida** (não
por lugar fixo no mapa — testado movendo o ponto de partida). Descartado:
obstáculo real (sem alerta sonoro), rede/WiFi (testado em duas redes,
mesmo padrão), desalinhamento de rota. Hipótese líder: algum parâmetro de
"distância máxima de planejamento local" (`max_plan_dist`, documentado na
API **serial** do fabricante — não a API HTTP que este app usa) deixado
num default conservador de fábrica.

Caminho de investigação: o robô tem uma placa Android embarcada (YoungFeel,
RK3568) acessível por **ADB sem fio** (Configurações → Opções de
desenvolvedor → Depuração sem fio, no tablet/board do robô — IP:porta
mudam a cada conexão). Apps relevantes instalados: `com.reeman.forkliftnew`
(navegação/forklift) e `com.reeman.dispatch`. O app de navegação grava log
de texto legível em `/storage/emulated/0/forklift_log/AAAA-MM-DD.log` —
inclui telemetria de posição/velocidade a ~1Hz (`MQTT 发布状态成功: {...
locationInfo, speed, isNavigating, paused ...}`), útil pra medir a
distância exata da parada sem precisar mexer na serial. Não chegamos a
confirmar a causa raiz — pausado a pedido do usuário pra priorizar o app.

## Descontinuado / decidido que não vamos fazer (por enquanto)

- **Rastreamento de posição em tempo real da forklift**: chegamos a desenhar
  uma seção com ícones de home/prateleira/pallet e um ícone de forklift que
  "teletransportava" entre eles por estado. Implementado, testado, e depois
  **removido a pedido do usuário** antes da limpeza geral que originou a
  reescrita em React. Obstáculo técnico na época (task-fast sem
  taskRecordId) foi essencialmente resolvido pelo trabalho desta sessão
  (task-record/page + correlação por nome) — se isso voltar a ser pedido,
  já temos o mecanismo.
- **Botão "girar N graus"**: pedido, avaliado (API não tem comando de
  rotação bruta), implementado, e depois **removido a pedido do usuário**.

## Segunda API do fabricante: SLAM WEB API (não usada no app atual)

Existe uma **outra** API HTTP no mesmo IP do robô, sem o prefixo
`/api/reeman-dispatch-service` — prefixos `/reeman/*` (GET) e `/cmd/*`
(POST). Mapeada a partir de PDFs do fabricante (não estão no repo). Foi
cogitada antes da criação dinâmica de task ser descoberta, mas o
dispatch-service (`task-template/create` + `task-fast`) cobriu tudo que
precisávamos — incluindo o manuseio físico do pallet, que a princípio
pensávamos exigir acesso serial (não exige: o dispatch-service orquestra
isso internamente ao interpretar `PICKUP`/`UNLOAD` no `taskActionList`).
Mantida como referência caso surja necessidade de navegação pura fora de
uma task completa:

- `POST /cmd/nav_name {"point":"A"}` — navega até um ponto pelo nome.
- `GET /reeman/nav_status` — status de navegação em tempo real.
- `POST /cmd/cancel_goal` — cancela só a navegação atual.
- `POST /cmd/charge` — ir pra/cancelar docagem na base de carga.
- `POST /cmd/position` — cria/atualiza um ponto calibrado
  (`{name, type, pose:{x,y,theta}}`) — alternativa programática à
  calibração manual na plataforma do fabricante, não usada (calibramos
  visualmente no nosso próprio editor, que não precisa disso).

## Próximos passos

### Sistema de login — PRÓXIMA TAREFA (retomar aqui)

Uso real: múltiplos operadores (até ~10), cada um via tablet, todos na
mesma rede local fechada (sem internet, sem domínio — ver seção sobre
hotspot abaixo pro porquê disso ser especialmente verdade aqui). O chefe
do usuário só pediu algo simples que funcione e permita monitoramento por
log — nada sofisticado (sem OAuth, sem banco de dados de verdade).

**Decisão já tomada, na mesma filosofia zero-dependência do projeto**
(discutido, ainda não implementado):
- Lista de usuários num arquivo local (tipo `users.json`, mesmo padrão de
  `calibration.json`/`route_log.json`) — usuário + hash da senha (não
  texto puro), sem framework de auth.
- Login vira um **cookie assinado** (HMAC com chave secreta guardada no
  servidor) contendo usuário + validade — evita precisar de sessão em
  memória (que se perderia a cada restart do `server.py`); cada requisição
  só confere a assinatura do cookie, sem estado servidor-side pra manter.
- **Monitoramento por log**: já existe a peça principal —
  `route_log.json`/painel "Histórico" já registra hora (relógio do
  servidor) e o quê. Falta só acrescentar **quem** disparou cada rota
  (campo `user` na entrada), uma vez que login existir — vira audit trail
  real sem esforço extra.
- HTTP simples (sem HTTPS) é aceitável aqui — rede genuinamente isolada,
  sem exposição à internet. Ressalva já discutida: senha trafega em texto
  claro dentro da rede local, troca consciente pra esse contexto.

Detalhes ainda em aberto (perguntar ao usuário quando retomar): quem
cadastra usuário novo (arquivo editado à mão vs. tela de admin), e se
"esqueci a senha" precisa de algum fluxo ou é só pedir pra alguém
redefinir manualmente.

### Visibilidade multi-dispositivo no Ponto a Ponto (decisão pendente)

Descoberto testando com computador + tablet ao mesmo tempo: o painel
"Histórico" é compartilhado de verdade (lê `route_log.json` no servidor,
qualquer dispositivo vê rotas de todo mundo) — mas o painel **Ponto a
Ponto** (fila/"em andamento") é **estado local do navegador**
(`currentRoute`/`pendingRoute`/`routeQueue` em `App.jsx`). Cada
aba/dispositivo só sabe da rota que ele mesmo disparou; se o computador
dispara uma rota, o tablet não tem como saber e continua mostrando "nada
em andamento" — não é bug, é como o app foi desenhado (nunca pensado pra
múltiplos operadores vendo o mesmo estado ao mesmo tempo).

Perguntado ao usuário se isso deveria virar compartilhado (qualquer
dispositivo mostrar o que o robô está executando agora, não importa quem
disparou) — ainda sem resposta/decisão. Se for pra frente, é mudança de
arquitetura real: a fila/handoff hoje depende de "eu sei que rota eu
mandei" (nome guardado localmente pra sondar o status); virar
compartilhado precisaria de algo tipo "pergunto pro robô o que está
rodando agora, seja lá quem mandou" (dá pra usar o mesmo padrão de
`findActiveChargeTaskId`, adaptado).

### Rede: hotspot de celular como infraestrutura de teste

Os testes atuais (robô + laptop rodando `server.py` + tablets) usam um
**hotspot de celular** como rede — não um roteador dedicado. Isso já
causou confusão real numa sessão (investigação de "botão não envia" que
parecia bug de touch/rede, mas era na real `crypto.randomUUID()` — ver
"CUIDADO" na seção "Rodando o projeto" — falhando silenciosamente só no
tablet por causa de contexto inseguro). Hotspot de celular não é pensado
pra sustentar múltiplos dispositivos com tráfego constante (o app sonda o
robô a cada 4s o tempo todo) — pra operação de produção de verdade (não
só teste), vale considerar um roteador dedicado (mesmo um portátil de
viagem), que também resolveria de vez a recomendação de fixar o IP da
máquina que roda o `server.py`.

### Itens menores

- Decidir se `action-type/list-all` (tipos de task) tem alguma utilidade
  pro app, ou é só curiosidade de API.
- Trocar o cancelamento dos botões de emergência da UI por algo mais
  granular, se fizer sentido — hoje `handleCancelCurrent` usa `all-cancel`
  deliberadamente (é uma parada de emergência de verdade).
- Painel "Histórico" (erros/avisos) hoje só busca a página mais recente
  (`size=30`, sem paginação) — se um dia precisar navegar o histórico
  inteiro (923+ registros no teste), dá pra adicionar paginação de verdade
  em `HistoryPanel.jsx`.
