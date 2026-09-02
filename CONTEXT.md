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
  `/api/reeman-dispatch-service/*` pro IP real do robô (usado só pela UI de
  calibração/erros — a fila de rotas fala com o robô por dentro, ver
  abaixo), persiste a calibração (`/api/calibration` ↔ `calibration.json`
  no disco), o histórico de rotas (`/api/route-log` ↔ `route_log.json` no
  disco), login/usuários (`/api/login` e afins ↔ `users.json` +
  `session_secret.key` no disco — ver "Sistema de login" abaixo), e é a
  **autoridade única da fila de rotas ao vivo** — dispara/cancela/sonda o
  robô sozinho numa thread de fundo, navegadores só leem
  (`GET /api/live-state`) e mandam intenções (`/api/queue/*`,
  `/api/occupied/*` — ver "Fila de rotas compartilhada" abaixo), estado em
  `queue_state.json`. Tudo protegido por sessão exceto os arquivos
  estáticos e o próprio login.
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
IP do robô na rede daquele dia (muda toda vez que troca de rede — já foi
`192.168.43.74` no hotspot de celular e `172.16.1.244` numa rede fixa,
nesta mesma sessão). O IP que o TABLET usa pra acessar o app é outro —
é o IP desta máquina (a que roda o `server.py`), não o do robô; descobre
com `hostname -I` (Linux) e confere que caiu na mesma faixa do robô.

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

**CUIDADO — `STATIC_DIR` tem que ser absoluto, nunca relativo**: já foi
`"web/dist"` (relativo) e isso causou um bug real em produção —
`SimpleHTTPRequestHandler` resolve `directory=` relativo ao **diretório
de trabalho do processo em tempo de requisição**, não ao arquivo do
script. Rodar `python3 server.py` de um terminal cujo `cd` mudou pra
dentro de `web/` (aconteceu de verdade, no meio de um monte de comandos
de build/teste na mesma sessão) fazia ele procurar em `web/web/dist` e
servir 404 pra tudo, **inclusive a própria `index.html`** — o app inteiro
parecia fora do ar sem nenhum erro no `server.py`. Corrigido:
`STATIC_DIR = str(Path(__file__).parent / "web" / "dist")` — sempre
absoluto, resolvido a partir da localização do próprio script. Não
reintroduzir um caminho relativo ali.

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

- `src/App.jsx` — só a camada de autenticação (ver "Sistema de login"
  abaixo): checa sessão, mostra `LoginScreen` ou monta `MainApp`. Fino de
  propósito.
- `src/MainApp.jsx` — o app de verdade (era `App.jsx` antes do login
  existir). Estado raiz: modo atual (`edit`/`ptp`/`mark`/`history`/
  `users`), seleção, modo desenvolvedor, validação de fronteira de
  ocupação (feedback rápido no clique — o gate de verdade é no servidor,
  ver "Fila de rotas compartilhada"). Disparo de rota/sondagem de status
  NÃO mora mais aqui — é tudo dono do `server.py` (ver hooks/useLiveState.js
  abaixo). Ainda assim o arquivo mais denso do projeto, com comentários
  explicando o *porquê* de cada decisão não-óbvia.
- `src/components/FloorPlanCanvas.jsx` — o editor visual (Konva). Stage com
  zoom/pan, desenha a imagem da vista atual + pontos avulsos + lotes,
  gerencia os gestos de interação (arrastar pra criar lote, pintar
  ocupação, crescer no hover, soltar pra confirmar). Também o maior/mais
  denso.
- `src/hooks/useCalibration.js` — estado de pontos/lotes (só isso;
  ocupação saiu daqui, ver abaixo) + persistência (debounced, 500ms) em
  `/api/calibration`.
- `src/hooks/useLiveState.js` — estado AO VIVO compartilhado entre
  dispositivos: rota atual/pendente/fila + ocupação. Poll
  `GET /api/live-state` a cada 4s, expõe ações
  (`enqueueRoute`/`cancelCurrent`/`removeQueued`/`setOccupied`/
  `setOccupiedMany`/`toggleOccupied`) que só mandam INTENÇÃO pro servidor —
  quem decide/dispara de verdade é sempre o `server.py` (ver "Fila de
  rotas compartilhada" abaixo).
- `src/api/lifty.js` — só o que sobrou de chamada direta ao dispatch
  service do robô a partir do navegador: leitura de erros/avisos
  (`fetchErrorRecords`, painel Histórico). A orquestração de fila
  (disparar/cancelar/sondar) migrou pro servidor — ver `server.py`. Também
  tem `fetchRouteLog`/`loadCalibration`/`saveCalibration`, chamadas pro
  nosso próprio `server.py`.
- `src/api/auth.js` — login/logout/sessão + CRUD de usuários, todas contra
  o nosso próprio `server.py` (ver "Sistema de login" abaixo).
- `src/components/`: `Toolbar`, `PointsPanel`, `LotsPanel`, `PointToPointBar`,
  `RouteQueue`, `OccupancyPanel`, `HistoryPanel`, `UsersPanel`,
  `DevModeModal`, `LoginScreen`, `Toast` — peças da UI, veja cada uma.
- `src/theme.js` — paleta de cores em hex (Konva não lê CSS custom
  properties, então os valores existem duplicados aqui e em `index.css`).
- `src/utils.js` — `generateId()`, gerador de id que substitui
  `crypto.randomUUID()` (ver "CUIDADO" na seção "Rodando o projeto" acima —
  essa API não funciona em HTTP puro fora de localhost).

### Zoom/pan do canvas: pinça suave + botão de reset + slider vertical

**Pinça engasgada, corrigida**: pinça de dois dedos e roda do mouse
mutavam o node do Konva via `setState` do React a cada `touchmove`/
`wheel` — dezenas de eventos por segundo, cada um forçando reconciliação
da árvore inteira. Num tablet mais fraco o React não acompanhava, os
eventos se acumulavam e o zoom "engasgava"/pulava em vez de seguir o
dedo. Corrigido: durante o gesto, muta o node do Konva DIRETO
(`stage.scale()`/`stage.position()` + `batchDraw()`, sem passar por
React) — o estado React (`stageScale`/`stagePos`) só sincroniza no FIM
do gesto (`handleTouchEnd`). Verificado numericamente (não só no olho):
disparando o evento nativo do Konva (`stage.fire('touchmove', ...)`,
bypassa a simulação de touch do navegador, pouco confiável em teste
headless) e lendo `stage.scaleX()` a cada passo — cresce suave e
monotônico.

**Botão de reset** (ícone de refresh, topo da pilha de botões flutuantes,
acima do olho — `.reset-toggle` no CSS, os outros desceram 76px cada):
reaplica o mesmo cálculo de "encaixar na tela" que já rodava só na
primeira vez que a vista aparecia (`handleResetView` em
`FloorPlanCanvas.jsx`, mesma fórmula do `useEffect` de inicialização) —
sem precisar recarregar a página.

**Slider vertical de zoom** (`.zoom-slider` no CSS, barra alta do lado
direito, `top: 316px`, logo abaixo da pilha dos 4 botões flutuantes) —
coexiste com roda/pinça (continuam valendo). É **controle de posição
absoluta**: a posição da bolinha É o nível de zoom. CENTRO = zoom default
(o mesmo "encaixar na tela" de quando a página abre / do botão de
refresh); pra cima = mais zoom (até `MAX_ZOOM_MULT`×, 8×); pra baixo =
menos (até `MIN_ZOOM_MULT`×, 0.5× — mais aberto que o encaixe). A bolinha
**fica onde é solta** — não tem mola, não volta pro centro. Barra
semitransparente (`opacity: 0.5`) que vai a 100% no hover/toque; a
bolinha cresce `scale(1.2)` enquanto arrastada (`.zoom-slider.is-active`).
- **Mapeamento exponencial** (`sliderFracToScale`/`sliderScaleToFrac` em
  `FloorPlanCanvas.jsx`): cada fração igual de curso multiplica a escala
  pelo mesmo fator — é o que faz o zoom "sentir" constante, mesma ideia
  do wheel/pinça, que multiplicam a escala. `MIN_ZOOM_MULT` (0.5) virou o
  piso do `clampScale` também, então roda/pinça agora também afastam além
  do encaixe (antes o piso era o próprio encaixe).
- **A bolinha acompanha o zoom feito por fora** (roda, pinça, abrir a
  página, refresh): um `useEffect` em `[stageScale, baseScale]` reposiciona
  a bolinha via `sliderScaleToFrac` sempre que não se está arrastando ela.
- **Durante o arrasto**, o transform é mutado DIRETO no node do Konva
  (`stage.scale/position + batchDraw`), sem `setState` — o estado React
  (`stageScale`/`stagePos`) só sincroniza no soltar (`handleZoomPointerUp`).
  Mesmo motivo do pinça: `setState` no meio re-renderiza a `<Stage>` com o
  valor antigo e o react-konva reverte o transform. Por isso até o
  `is-active` da barra é alternado por `classList` (`setSliderActive`), não
  por estado.
- **Ponto de zoom** = "a parte do mapa onde o usuário soltou o clique (ou
  dedo) pela última vez" (`focalContentRef`, em coordenadas de conteúdo /
  px da imagem). Atualizado por `rememberFocal` em todo
  `mousedown`/`mousemove`/soltar sobre o canvas (inclusive durante pan de
  1 dedo). O slider mantém esse ponto fixo na tela ao reescalar. Sem foco
  registrado ainda → centro do viewport.
- Eventos de ponteiro unificados (`onPointerDown/Move/Up` +
  `setPointerCapture` na track); `zoomDraggingRef` guarda se o arrasto
  está ativo. `touch-action: none` na `.zoom-slider` pro arrasto vertical
  não virar scroll da página. Barra com `height: 640px` /
  `max-height: calc(100% - 340px)` (não passa da borda inferior do mapa).

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

### Quatro modos de interação (`mode` em `MainApp.jsx`)

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
`MainApp.jsx`): `edit` se for dev, `ptp` pra todo mundo mais.

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
(`DevModeModal.jsx`; a senha está hardcoded em `MainApp.jsx`,
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
(`baseMode()` em `MainApp.jsx`) só é `edit` quando `devMode` está ativo.

### Painel "Histórico" (modo desenvolvedor, `HistoryPanel.jsx`)

Duas seções empilhadas na sidebar, **cada uma com seu próprio scroll
independente** (não o scroll do sidebar inteiro — ver `.sidebar--history`/
`.history-panel__list` no CSS, padrão `flex:1 + min-height:0 +
overflow-y:auto` aninhado):

1. **Histórico de rotas**: quando cada rota foi solicitada e concluída, e
   quem disparou (ver "Sistema de login"). **Carimbado pelo relógio da
   máquina que hospeda o `server.py`** — de propósito NÃO é o relógio do
   dispatch service (robô) nem do navegador/tablet do operador, que podem
   estar em fusos/horas diferentes. Gravado por `log_route_requested`/
   `log_route_completed` (funções internas de `server.py`, chamadas
   direto pelo código que dispara/conclui a rota — ver "Fila de rotas
   compartilhada" abaixo; não é mais um `POST` que o navegador manda,
   desde que a fila virou dona do servidor) — `datetime.now()` DO
   SERVIDOR, nunca um timestamp que o cliente mandasse pronto. Persistido
   em `route_log.json` (capado em 500 entradas — roda 24/7 num armazém sem
   manutenção, evita crescer pra sempre).
2. **Erros e avisos**: `GET /error/records` do dispatch service (ver
   tabela de endpoints abaixo) — schema validado contra resposta real do
   robô. Glossário de tradução (`KNOWN_PHRASES`/`ERROR_LABELS` em
   `HistoryPanel.jsx`) pra mensagens que o robô manda cruas em mandarim —
   crescimento pontual, cada frase nova encontrada em campo entra na
   lista quando aparece (não dá pra prever todas de antemão). Já tem:
   controle manual, desviou da rota, desconectou, mapa não está no
   servidor (hash de mapa divergente — ver aviso abaixo), mapa não
   inicializado/faltando pontos e rotas.

**Filtro por data** (ícone de calendário, abaixo do título "Histórico de
rotas"): um `<input type="date">` nativo fica invisível por cima do
ícone — quem recebe o toque é ele, não uma simulação em JS — porque em
Android/Chrome tocar em QUALQUER parte de um `<input type="date">` já
abre o calendário nativo do sistema sozinho, sem precisar de
`showPicker()` (API mais nova, mais frágil de depender). Filtra a lista
já carregada, client-side, comparando o prefixo `YYYY-MM-DD` de
`requestedAt`.

**Hash de mapa — CONFERIDO (2026-09-01), está certo**: houve um susto —
o robô mandou mensagens de erro citando hashes diferentes
(`7d07a3564729e5a35999099c0e539e9c`, `92802f9d5efcaf3836298077db4a35b0`)
do que está fixo em `ROBOT_TARGET_MAP`. O usuário confirmou na plataforma
do fabricante: o mapa ativo é `eecc4a9068e11bd9086538383a38c67d`, que é
exatamente o que o `server.py` já manda. Aqueles outros hashes eram de
mapas antigos/inativos citados em erros históricos. Criação de task está
ok. Se o robô for remapeado no futuro, atualizar `ROBOT_TARGET_MAP`.

## A API do dispatch service (tudo validado nesta sessão)

- Base: `http://{IP_DO_ROBO}/api/reeman-dispatch-service{endpoint}`
- Resposta padrão: `{"code": 0, "message": "success"/"Sucesso", "data": {...}}`;
  `code=0` é sucesso.
- **Sem autenticação** — confirmado testando em produção.

### Endpoints usados

Chamados hoje a partir de `server.py` (funções `robot_*`, ver "Fila de
rotas compartilhada" abaixo) — antes viviam em `src/api/lifty.js` e eram
chamados pelo navegador; migraram junto com a posse da fila. Só
`GET /error/records` (leitura, painel Histórico) continua chamado
direto do navegador, sem mudança.

| Endpoint | Uso |
|---|---|
| `POST /task-template/create` | Cria um template de task (`taskActionList` com PICKUP/UNLOAD). `id:null`=criar. |
| `GET /task-template/page?projectId&page&size&name&description` | Lista/busca templates por nome — usado pra **reaproveitar** um template já criado em vez de tentar criar de novo (ver abaixo). |
| `POST /task-template/generic/task-fast/{id}` | Dispara a execução de um template. Não retorna `taskRecordId` na resposta (gotcha original). |
| `GET /task-record/page?projectId&page&size&status&name` | Lista/busca registros de execução (instâncias, não templates). Paginado, ordenado mais-recente-primeiro. **Status confirmados: `WAITING`, `FINISHED`, `CANCELLED`** (não vimos o valor de "em execução" ainda — tratamos qualquer status que não seja `FINISHED`/`CANCELLED` como "ainda não terminou"). `taskType` confirmado: `FAST` (nossas tasks), `AUTO_SYSTEM` (task automática do robô, ex: ida pra carga). |
| `POST /task-record/all-cancel/{projectId}` | Cancela **tudo** que estiver ativo/pendente pro projeto. Usado só na **parada de emergência** (`/api/queue/emergency`) — o cancelamento de rota normal é granular por id. |
| `POST /task-record/cancel/{taskRecordId}` | Cancela **uma task específica** por id, sem afetar as outras. Descoberto capturando o botão "Cancelar tarefa" da plataforma admin. Usado pra: cancelar a task de carga sem derrubar a rota recém-disparada; cancelar a rota em andamento deixando a fila seguir (`/api/queue/cancel-current`); cancelar a `pendingRoute` (`/api/queue/remove-queued`). |
| `GET /action-record/list/{taskRecordId}` | Lista as **ações individuais** dentro de uma task (cada PICKUP/UNLOAD do `taskActionList`), com `status`/`startTime`/`finishTime` por ação. Usado no Caso 2 da marcação de ocupação (ver seção própria) — `finishTime` não-nulo confirmado em campo como sinal de "ação concluída com sucesso", mesmo nunca tendo visto o texto de `status` correspondente (só `"CANCELLED"` num exemplo). |
| `GET /action-type/list-all` | Lista os tipos de task existentes: `FAST`, `TIMED`, `TEMP_TASK_CHAIN`, `CAMERA`, `AUTO_SYSTEM`, `BUTTON_TASK`. Descoberto mas não usado ainda. |
| `GET /error/records?projectId&page&size` | Lista registros de erro/aviso do robô, paginado (`total`/`size`/`current`/`pages`). Schema validado contra resposta real: `records[]` com `id, projectId, agvId, error, level` (`"ERROR"`/`"WARN"`), `description, happenTime, isRead, readTime`. Usado no painel "Histórico" (modo desenvolvedor, `HistoryPanel.jsx`) — `fetchErrorRecords` em `lifty.js`. |

### Criação dinâmica de task (resolve o problema combinatório)

Motivação: com lotes configuráveis (ex: dois lotes 5×6 = 900 combinações
origem→destino possíveis), pré-cadastrar um template por combinação na
plataforma do fabricante é inviável. `robot_create_and_run_route(pickup,
dropoff, pallet_type)` em `server.py` (antes `createAndRunRoute` em
`lifty.js`, mesma lógica, portada):

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
não muda (`ROBOT_TARGET_MAP` em `server.py`).

**Reaproveitamento de template**: o dispatch service rejeita criar um
template com nome repetido no mesmo projeto (`{"code":1,"message":"...任务
模版名称已存在..."}` = "nome já existe"). Como o "recipe" de uma rota A→B
nunca muda, `robot_create_and_run_route` primeiro procura um template já
existente com esse nome (`robot_find_task_template_id`, via
`task-template/page`) e só cria se não achar — evita tanto o erro de nome
duplicado quanto acumular um template novo no dispatch a cada disparo da
mesma rota. Como a fila inteira é serializada por `QUEUE_LOCK` agora (ver
abaixo), esse "procura, senão cria" deixou de correr risco de corrida
mesmo entre disparos de dispositivos diferentes — antes (client-side) dois
navegadores concorrentes tecnicamente podiam disputar esse check-then-act.

### Fila de rotas e priorização automática — DONA DO SERVIDOR (`server.py`)

**Reescrito** (era 100% client-side, `App.jsx`, um dispositivo só via a
própria fila — ver "Fila de rotas compartilhada" logo abaixo pro porquê e
os detalhes de implementação). O que segue é o comportamento de negócio,
que não mudou — só QUEM executa:

Três camadas de estado (hoje em `queue_state.json`, não mais em React):
- **`currentRoute`**: já disparada pro robô, rodando agora (no máx. 1).
- **`pendingRoute`**: já disparada pro robô TAMBÉM, mas o dispatch a segura
  como "próxima" porque a atual ainda não terminou (no máx. 1).
- **`routeQueue`**: ainda não chegou a ser enviada — só vira `pendingRoute`
  quando esse slot esvaziar.

Sondagem (thread de fundo em `server.py`, a cada 4s) consulta
`GET /task-record/page` filtrado pelo nome exato da rota (nome
reaproveitado entre disparos — a correlação funciona porque cada disparo
cria um **registro de execução novo** mesmo reaproveitando o **template**,
e pegamos sempre o mais recente). `FINISHED` promove `pendingRoute` →
`currentRoute` **sem disparar de novo** (já estava rodando, foi mandada
com antecedência). `CANCELLED` só limpa, não promove — mesma cautela de
"não presuma que pode seguir".

**Comportamento do robô que motivou o design acima**: ao ficar sem NENHUMA
task na lista, o robô cria sozinho uma task automática (`AUTO_SYSTEM`) de
volta pra base de carga — e essa task tem a **mesma prioridade** de uma
task normal (não é preemptada; se já estiver rodando, uma `task-fast` nova
só começa depois dela terminar). Pra evitar esse desvio:

1. **Handoff entre rotas da fila** (`_fire_route(..., as_pending=True)`):
   dispara a próxima rota **enquanto a atual ainda roda** — o dispatch
   segura como "próxima" nativamente (mesma prioridade = fila FIFO simples
   no próprio dispatch), então a fila nunca fica vazia e o robô nunca tem
   motivo pra recriar a task de carga.
2. **Disparo a partir de estado ocioso** (`_fire_route` sem `as_pending`,
   robô pode estar indo pra carga): usa `robot_find_active_charge_task_id()`
   **antes** de disparar (se procurasse depois, o registro mais recente já
   seria o nosso, não o da carga), dispara a rota nova (fica pendente atrás
   da carga — nunca zero tasks), e só então cancela a carga especificamente
   por id (`robot_cancel_task_record`, nunca `all-cancel`, que pegaria a
   rota nova junto). Essa ordem (disparar antes de cancelar) evita uma
   corrida real que causava "robô para e volta pra energia" quando a ordem
   era invertida.

### Sistema de marcação de ocupação (pontos ocupados por pallet)

Motivo: outras paleteiras (humanos) operam no mesmo ambiente — o app
precisa saber se uma posição já tem pallet, tanto pra mostrar visualmente
quanto pra impedir o robô de tentar uma rota fisicamente impossível.

**Caso 1 (feito)**: modo `mark`, clique/toque marca ou desmarca uma célula
(mesmo gesto do Ponto a Ponto). Desenha um X na cor da célula, centralizado.
Funciona em pontos avulsos e células de lote. `toggleOccupied(name)` mora
hoje em `hooks/useLiveState.js` (chama `POST /api/occupied/set` — ver
"Fila de rotas compartilhada" abaixo pro porquê saiu de
`useCalibration.js`), persistido em `occupied` (global, ver acima).

**Caso 3 (feito, agora reforçado no servidor)**: regra de fronteira/FIFO —
dentro do MESMO lote (não entre lotes diferentes), uma célula ocupada
bloqueia qualquer posição "atrás" dela (índice maior) como **destino**, e
qualquer posição "antes" dela como **origem alcançável** — o robô entra
numa coluna só por uma ponta e não faz desvio lateral. Validado nos DOIS
lados agora: `isPickupAllowed`/`isDropoffAllowed` em `MainApp.jsx`
continuam dando feedback rápido no clique (toast), mas
`is_pickup_allowed`/`is_dropoff_allowed` em `server.py` são o GATE
DE VERDADE em `POST /api/queue/enqueue-batch` — ver "Fila de rotas
compartilhada" pro porquê (dois operadores escolhendo quase ao mesmo
tempo). Pontos avulsos não têm essa regra (sem noção de ordem).

**Caso 2 (validado em campo, hoje dono do servidor)**: marcação automática
de ocupação baseada no progresso da task — a cada tick da thread de fundo
em `server.py` (a mesma que avança a fila), busca `robot_fetch_action_records`
(`GET /action-record/list/{id}`) e olha a ação de `serialNumber: 1`
(PICKUP). Se `finishTime` estiver preenchido (e ainda não tiver desmarcado
nessa rota, flag `pickupCleared` em `queue_state.json`) → desmarca a
origem via `set_occupied_state(pickup, False)`. Usa `finishTime` não-nulo
como sinal de "terminou" em vez do texto de `status` da ação — **nunca
vimos o valor de `status` de uma ação concluída com sucesso** (só
`"CANCELLED"` uma vez), então depender do schema confirmado (`finishTime`)
é mais robusto que adivinhar o enum. Quando a task inteira termina
(`FINISHED`) → marca o destino via `set_occupied_state(dropoff, True)`.

Confirmado em campo (antes da migração pro servidor, mesma lógica):
`finishTime` da ação PICKUP populava corretamente assim que ela termina
com sucesso, mesmo com a task inteira ainda em andamento (UNLOAD não
concluído).

**Bug real encontrado depois, já corrigido — cancelar a rota apagava o X
da origem**: `finishTime` também é carimbado quando a ação/task é
CANCELADA (é a hora do cancelamento, não de conclusão). Então cancelar
uma rota com o robô ainda **a caminho da coleta** (nunca chegou a pegar o
pallet) fazia o tick ver `finishTime` na ação de PICKUP e desmarcar a
origem — apagava o X de um pallet que continuava lá. Corrigido em
`_queue_tick`: o clear do Caso 2 só roda se `record["status"] !=
"CANCELLED"` **e** `pickup_action["status"] != "CANCELLED"`. Rota
cancelada → ocupação fica intocada (suposição segura: o pallet continua
onde estava). Não afeta o caso legítimo "robô completou a coleta e SÓ
DEPOIS a rota foi cancelada" — aí `pickupCleared` já é `True` de um tick
anterior e a origem continua (corretamente) sem X, porque o pallet saiu
de lá de verdade (está no robô). Só o cancelamento pelo botão do próprio
app (`/api/queue/cancel-current`) nunca teve esse bug — ele zera o
`currentRoute` na hora e o tick seguinte nem processa a rota; o problema
era com cancelamento por FORA do app (plataforma do robô) ou um
cancelamento do app que falhasse no meio.

### Pontos avulsos = "lotes curinga" (revisado e corrigido)

Pontos avulsos (`points`, criados pelo "+ Ponto") são pontos especiais de
retirada única — pense neles como um lote de UMA célula só. Ficaram sem
uso por várias sessões e, na revisão, tinham **dois bugs reais**:

- `isPickupAllowed`/`is_pickup_allowed` faziam `if (!pos) return true`
  ANTES de checar ocupação → dava pra mandar o robô **pegar num ponto
  vazio**.
- `isDropoffAllowed`/`is_dropoff_allowed`, idem → dava pra **soltar num
  ponto que já tinha pallet**.

O `return true` antecipado queria dizer "sem regra de fronteira" (correto:
não há vizinho pra bloquear), mas acabou pulando também a regra básica,
que vale igual pra eles. Corrigido nos dois lados (cliente e servidor):
ponto avulso segue **as mesmas regras de uma célula de lote, menos a de
ordem** — coleta exige estar ocupado, entrega exige estar livre.

Tudo o mais já funcionava e foi confirmado: participam do mesmo gesto de
seleção, entram como origem/destino, aceitam marcação de ocupação (X), e
o nome deles é usado pra montar a task igual ao de célula de lote (o
robô não distingue — é só `targetPoint`).

**Sequência**: são curinga também na regra de "mesma coluna" — ficam
isentos dela (não têm vizinho pra destravar nem pra bloquear), então
podem entrar em qualquer sequência, sozinhos ou junto de uma coluna. A
restrição continua valendo entre células de LOTES diferentes.

**Mensagens**: falar em "posição antes dela no lote" não faz sentido pra
ponto avulso, então as recusas têm texto próprio ("não tem pallet marcado
ali" / "já tem pallet ali") — ver `pickupDeniedMessage`/
`dropoffDeniedMessage` em `MainApp.jsx` e o mesmo desvio em
`validate_route_chain` no `server.py`.

**Nome escondido por padrão**: ponto avulso tem `namesVisible` (mesmo
campo e mesmo ícone de olho dos lotes, agora no `PointsPanel`), e o padrão
é **escondido** — inclusive pros pontos que já existiam antes do campo
existir (`undefined` é falsy, então caem no escondido sem precisar migrar
nada).

**Cor (`COLORS.accentOrange`, `#f4610a`)**: têm cor própria laranja, do
mesmo jeito que um lote colorido tem a dele (`pointMarkerColors`/
`pointOccupiedColor` em `FloorPlanCanvas.jsx`). O tom precisou de duas
iterações, e o registro importa pra não repetir os erros:
- O âmbar (`#f5a524`, matiz 37°) já significa "destino selecionado". Um
  laranja comum (`#f97316`, 25°) fica a só **12° de matiz** dele com a
  mesma luminosidade — indistinguível num quadrado de ~12px.
- Tentativa 2 (`#e35205`) separou bem, mas com a borda escurecida nos 0.4
  padrão de `darkenHex` a luminosidade caía pra **27%** e o conjunto lia
  como **marrom queimado**.
- Final: base mais clara (`#f4610a`, 22°/50%) + escurecimento de borda
  reduzido pra **0.22** (borda a 39% em vez de 27%). Separa do âmbar por
  matiz sem precisar escurecer até virar marrom.

O escurecimento da borda aqui NÃO serve pra separar de vizinho (ponto
avulso não tem) — serve só pra dar contraste ao X, desenhado na cor cheia
por cima. Já testado: com borda e X na mesma cor cheia, o X some dentro
do quadrado.

### "Lotes em sequência" — N rotas de uma vez (IMPLEMENTADO)

**Motivação**: com a regra de fronteira (Caso 3), esvaziar uma coluna
inteira era penoso — só dá pra pegar `A` enquanto `A2`/`A3` estão atrás
dela, então o operador tinha que esperar cada task terminar pra só então
mandar a próxima. Agora dá pra montar a coluna toda de uma vez.

**Como usa**: checkbox "Lotes em sequência" no Ponto a Ponto (desligado
por padrão). Ligado, o slot ORIGEM fica com borda ciano e recebe várias
seleções seguidas (`A, A2, A3`); clicar no slot DESTINO passa o foco pra
ele (borda âmbar) e aí se escolhe os destinos. Cada quadrado selecionado
ganha um **número** no mapa (`SeqBadge` em `FloorPlanCanvas.jsx`) na cor
do papel, porque todos ficam pintados da mesma cor e a ORDEM é justamente
o que torna a sequência válida. Ao enviar, N tasks são criadas pareando
por índice: origem[i] → destino[i].

**A ideia central (uma só, não duas regras)**: cada seleção é validada
contra a **ocupação projetada** — o armazém como ele ESTARÁ quando aquela
rota rodar, não como está agora. É isso que faz `A → A2 → A3` valer na
origem (cada coleta destrava a seguinte) e `B3 → B2 → B` valer no destino
(enche do fundo pra frente, senão o primeiro pallet tranca os de trás).
As duas regras que parecem opostas são o mesmo princípio físico visto dos
dois lados: nunca passar por cima de uma posição ocupada.
`projectedOccupancy` em `MainApp.jsx` (feedback imediato no clique) e
`validate_route_chain` em `server.py` (o gate de verdade).

**Por que precisou de endpoint novo** (`POST /api/queue/enqueue-batch`,
substituiu o `/api/queue/enqueue` de um par só): o servidor valida contra
a ocupação **atual**, então mandar as rotas uma a uma faria a 2ª ser
rejeitada — no instante do envio o `A` ainda está ocupado, o robô nem
começou. O lote inteiro vai numa requisição só e é validado em cadeia. O
modo normal usa o MESMO endpoint com um par só (uma cadeia de um passo é
idêntica à validação antiga) — sem caminho separado pra divergir depois.

**Regras específicas da origem**: todas as origens têm que sair da MESMA
coluna (a sequência só se sustenta porque cada coleta destrava a
seguinte, e isso é uma relação interna de um lote). Destinos NÃO têm essa
restrição — podem ser colunas/kanbans diferentes, misturados.

**Decisões tomadas com o usuário**:
- **Contagens têm que bater**: o botão de envio fica desabilitado
  enquanto origens ≠ destinos (mostrando "3 origem(ns) / 2 destino(s)").
  Todo pallet pego precisa ter pra onde ir.
- **Se uma rota da sequência for cancelada, o resto do grupo cai junto**:
  as seguintes só eram válidas PORQUE essa ia rodar antes. Cada rota do
  lote carrega um `groupId`, e `_drop_group_from_queue` (`server.py`)
  limpa o resto — inclusive cancelando no robô a `pendingRoute` do grupo,
  que já tinha sido despachada de verdade. Vale pro cancelamento da rota
  em andamento (`/api/queue/cancel-current`), da próxima/fila
  (`/api/queue/remove-queued`) e pro cancelamento por fora do app. A
  `currentRoute` de um grupo, quando quem é cancelado é uma rota DEPOIS
  dela, não é tocada (ela é anterior, não depende das seguintes).
- **Clicar num já selecionado trunca dali pra frente** (não remove só
  ele): os seguintes dependiam dele, então deixá-los sozinhos criaria uma
  sequência impossível.
- **"Buraco" na coluna vale**: com `A` e `A3` ocupados e `A2` vazio,
  `A → A3` é permitido — o que importa é não ter nada bloqueando o
  caminho, e `A2` vazio não bloqueia (a alternativa deixaria `A3`
  impossível de pegar em sequência, já que `A2` vazio não pode ser
  "pego").

**Numeração some ao enviar** (pedido explícito): assim que a seleção é
limpa (logo após o envio bem-sucedido), o mapa volta a destacar a **rota
atual** — um par só, sem número. Ver `mapPickupNames`/`mapDropoffNames`
em `MainApp.jsx`: a numeração é apoio de montagem, e quem prevalece
durante a execução é o que o robô está fazendo AGORA.

**Detalhe de implementação**: `pickupName`/`dropoffName` (string) viraram
`pickupNames`/`dropoffNames` (arrays) em `MainApp.jsx`, `PointToPointBar`
e `FloorPlanCanvas` — no modo normal são listas de 0 ou 1 nome, então o
comportamento antigo é o mesmo sem caso especial. O número só aparece
quando a lista tem 2+.

**Testado**: os 6 cenários da regra (exemplo do usuário `A→B2, A2→B,
A3→C`; origem fora de ordem; pegar `A2` com `A` na frente; destino fora
de ordem; destino na ordem certa; buraco na coluna) validados
diretamente contra `validate_route_chain`; ponta a ponta com stub do
dispatch service (3 rotas criadas com o pareamento certo, mesmo
`groupId`, distribuídas em atual/pendente/fila; rejeições devolvendo 400
com a mensagem certa; cancelar a atual derruba o resto do grupo); e a UI
via Playwright (checkbox desligada por padrão, foco alternando entre os
slots, envio bloqueado sem seleção).

### Tema claro/escuro — preferência POR CONTA

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
`useEffect` de tema em `MainApp.jsx`, junto com `document.documentElement.
setAttribute('data-theme', ...)`. Não precisa passar `theme` como prop
pro `FloorPlanCanvas`: a troca de estado em `MainApp.jsx` já re-renderiza a
árvore toda (nada é memoizado com `React.memo`), e como os componentes
Konva leem `COLORS.xxx` fresco a cada desenho (não cacheado), o próximo
render já pega os valores novos automaticamente.

**Persistência (reescrita — era `localStorage` por dispositivo)**: fica
salva no `users.json` (campo `theme`) e viaja junto da sessão
(`GET /api/session` e a resposta do login), então o app já monta no tema
certo sem piscar no outro antes. Trocar chama `POST /api/session/theme`,
que altera só o usuário da SESSÃO — não dá pra mexer na preferência de
outra conta mandando outro nome no payload. Motivo da troca: por
dispositivo, quem mudava de tablet tinha que reconfigurar toda vez.
`localStorage` removido de vez, pra não ficar com duas fontes de verdade.
Conta sem o campo (criada antes disso) cai no padrão `dark`. A tela de
LOGIN em si continua sempre escura — nesse momento o app ainda não sabe
quem vai entrar, então não tem preferência de conta pra aplicar ainda.

**Cuidado que já mordeu**: o `App.jsx` montava o objeto do usuário
escolhendo campos a dedo (`{username, isAdmin}`) depois do login, o que
DESCARTAVA o `theme` — o app abria sempre no padrão, embora o servidor
estivesse mandando certo (e o caminho do reload de página, que repassa a
resposta inteira, funcionava). Agora repassa a resposta inteira nos dois
caminhos. Se acrescentar mais campo de sessão no futuro, não voltar a
filtrar ali.

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
(é o mais comum na planta). O estado (`palletType` em `MainApp.jsx`) não é
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

## Sistema de login (IMPLEMENTADO)

Uso real: múltiplos operadores (até ~10), cada um via tablet, todos na
mesma rede local fechada (sem internet, sem domínio — ver seção sobre
hotspot abaixo pro porquê disso ser especialmente verdade aqui). Pedido
original: algo simples que funcione e permita monitoramento por log —
nada sofisticado (sem OAuth, sem banco de dados de verdade). Mesma
filosofia zero-dependência do resto do projeto.

**Backend (`server.py`)**:
- `users.json` (mesmo padrão de `calibration.json`/`route_log.json`,
  gitignorado, gerado sozinho) — lista de `{username, passwordHash,
  isAdmin}`. Senha nunca em texto puro: PBKDF2-HMAC-SHA256 com salt
  próprio por usuário (`hash_password`/`verify_password`), 200k
  iterações. **Primeiro boot sem `users.json`**: cria um usuário `admin`
  com senha aleatória, impressa no console UMA vez
  (`_bootstrap_users_if_missing`) — evita cravar senha padrão no código
  (diferente do `DEV_PASSWORD` do front, que é só trava de UI).
- Sessão = **cookie HttpOnly assinado** (HMAC-SHA256 com chave em
  `session_secret.key`, gerada no primeiro boot e persistida em disco —
  também gitignorada) contendo `usuário:validade` — sobrevive a restart
  do `server.py` sem precisar de sessão em memória nem banco. Validade:
  30 dias (tablet de uso diário). `make_session_token`/
  `verify_session_token`.
- Endpoints: `POST /api/login`, `POST /api/logout`, `GET /api/session`
  (usados por qualquer sessão), `GET/POST /api/users` +
  `PUT/DELETE /api/users/{username}` (só admin, `_require_admin`).
  Trava de segurança: nunca deixa zerar o último admin (recusa
  demover/excluir se não sobrar nenhum) nem excluir o próprio usuário
  logado.
- **Bloqueio de conta por tentativas erradas** (`LOGIN_MAX_ATTEMPTS = 3`,
  campos `failedAttempts`/`locked` em cada usuário do `users.json`): 3
  senhas erradas seguidas pro MESMO username bloqueia a conta —
  `_login` recusa (HTTP 423) mesmo se a senha da vez estiver certa,
  sem nem chegar a comparar hash. Só desbloqueia via `PUT
  /api/users/{username}` com `{"locked": false}` (admin), que também
  zera `failedAttempts` — senão a próxima senha errada rebloquearia com
  1 tentativa só. Acerto de senha reseta o contador pra 0 normalmente.
  **Admin nunca bloqueia** (pedido explícito do usuário): `failedAttempts`
  ainda incrementa pra admin, mas `locked` nunca vira `True` nesse caso
  (checado nos dois lados — ao TENTAR bloquear em `_login`, e como defesa
  em profundidade no próprio gate de bloqueio, `and not user.get("isAdmin")`
  nos dois pontos). Promover alguém pra admin (`PUT .../isAdmin=true`)
  desbloqueia e zera o contador automaticamente — evita o estado
  inconsistente de "admin bloqueado".
- **Tudo que é dado/ação de verdade fica atrás de `_require_auth`** —
  proxy do robô, calibração, histórico de rotas, usuários. Só os
  arquivos estáticos (`web/dist`) continuam públicos, de propósito: é o
  próprio SPA React que decide mostrar a tela de login, então precisa
  carregar sem sessão pra chegar a esse ponto.
- HTTP simples (sem HTTPS) é aceitável aqui — rede genuinamente isolada,
  sem exposição à internet. Ressalva consciente: senha trafega em texto
  claro dentro da rede local; o cookie de sessão pelo menos não pode ser
  forjado sem conhecer `session_secret.key`.

**Frontend (`web/src/`)**:
- `App.jsx` (raiz) virou só a camada de autenticação: checa
  `GET /api/session` no mount, mostra `LoginScreen.jsx` (tela cheia,
  sem HTTPS/domínio, mesma estética do `DevModeModal`) se deslogado, ou
  monta `MainApp.jsx` (todo o app antigo, renomeado) só depois de sessão
  confirmada. De propósito MainApp NÃO fica escondido-mas-montado: seus
  hooks (`useCalibration`) disparam fetch autenticado já no primeiro
  render, num efeito que só roda uma vez — se existisse desde o início,
  um login bem-sucedido depois não teria como re-disparar essa carga sem
  recarregar a página.
- `api/auth.js` — `login`/`logout`/`fetchSession`/`fetchUsers`/
  `createUser`/`updateUser`/`deleteUser`. Cookie vai sozinho em toda
  fetch same-origin, nenhuma chamada passa token manualmente.
- **Aba "Usuários"** (`UsersPanel.jsx`, `mode === 'users'`) — gated por
  `user.isAdmin` (sessão de verdade), **independente** do modo
  desenvolvedor (`devMode`, trava de UI só pra edição de pontos/lotes —
  são duas travas diferentes). Lista usuários, toggle de admin, troca de
  senha por linha, exclusão (bloqueada pro próprio usuário logado),
  formulário de criação. Decisão do usuário: sem fluxo de "esqueci minha
  senha" — admin controla/reseta tudo por essa tela mesmo. Conta
  bloqueada (ver "Bloqueio de conta" acima) aparece com um 🔒 clicável ao
  lado do nome + borda vermelha na linha (`.is-locked`); clicar chama
  `updateUser(username, {locked: false})` e recarrega a lista.
- Toolbar mostra `usuário (admin)` + botão de logout (⏻) no canto
  direito, ao lado do botão `{ }` do modo desenvolvedor (independente
  dele).
- **Audit trail**: `route_log.json` ganhou o campo `user` — quem disparou
  cada rota, tirado da SESSÃO autenticada no servidor (`_route_log_request`
  recebe o usuário já validado por `_require_auth`, nunca de um campo que
  o cliente mandaria no payload — precisa ser confiável pra valer como
  log de verdade). Painel "Histórico" mostra "Solicitada por X: ...".

Testado ponta a ponta (Playwright headless): tela de login sem sessão,
login válido/inválido, gate 401 em endpoint protegido sem cookie, aba
"Usuários" só aparece pra admin, não-admin recebe 403 em `/api/users`
mesmo chamando direto (defesa em profundidade, não só esconder botão na
UI), criação/troca de senha/exclusão de usuário, trava de "não pode
ficar sem admin", logout volta pra tela de login. Não testado ainda:
uso real em tablet (mesma ressalva de sempre, ver seção de hotspot).

**Nota pra quem retomar**: qualquer `server.py` já rodando de antes
dessa mudança está servindo a versão SEM login — precisa reiniciar o
processo (`Ctrl+C` + `python3 server.py` de novo) pra pegar essas
mudanças. Na primeira subida sem `users.json`, a senha do `admin`
aparece no console — anote na hora.

### Fila de rotas compartilhada (IMPLEMENTADO)

**O que motivou**: descoberto testando com computador + tablet ao mesmo
tempo: o painel "Histórico" já era compartilhado de verdade (lê
`route_log.json` no servidor), mas o painel **Ponto a Ponto** (fila/"em
andamento") era **estado local do navegador** — cada aba só sabia da rota
que ela mesma disparou; se o computador disparava uma rota, o tablet não
tinha como saber. Confirmado com o usuário: múltiplos operadores (~10,
cada um num tablet) precisam ver ao vivo o que está rodando, a fila, e o
que já aconteceu — pedido explícito de atenção a conflitos/duplicação,
comuns nesse tipo de sistema quando vários atores decidem coisas "ao
mesmo tempo" sem uma autoridade única.

**Arquitetura**: `server.py` virou o **único** processo que fala com o
robô pra fila (disparar/cancelar/sondar) — navegadores só LEEM (polling)
e mandam INTENÇÕES, nunca decidem sozinhos. Isso elimina a classe inteira
de "dois atores agindo ao mesmo tempo": só sobra um ator (a thread de
fundo + os handlers HTTP), serializado por lock.

- **`queue_state.json`** (mesmo padrão de `route_log.json`/`users.json`,
  gitignorado) — `{currentRoute, pendingRoute, routeQueue, pickupCleared}`,
  protegido por `QUEUE_LOCK`. **`CALIBRATION_LOCK`** (nova) — `calibration.json`
  não tinha lock nenhum antes disso (risco real: duas marcações de
  ocupação quase simultâneas podiam se perder uma pra outra, "lost
  update", já que o save antigo mandava o objeto inteiro). **Ordem de
  lock fixa** (só a thread de fundo precisa dos dois, ao marcar ocupação
  como parte de avançar a fila): sempre `QUEUE_LOCK` primeiro,
  `CALIBRATION_LOCK` depois — documentado em comentário, nunca invertido
  em lugar nenhum do código.
- **Cliente do robô portado pra Python** (`robot_*` em `server.py`, ver
  seção da API acima) — as funções que antes viviam em `lifty.js` e o
  navegador chamava via proxy agora rodam dentro do próprio `server.py`,
  falando com `ROBOT_HOST` direto (`urllib.request`, mesmo padrão zero-dep
  do resto do projeto).
- **Thread de fundo** (`_start_queue_thread`, daemon, tick a cada 4s) —
  dona exclusiva de avançar a fila: sonda o robô, detecta PICKUP
  concluído (Caso 2) e `FINISHED`/`CANCELLED`, promove a fila. Como só ela
  faz isso e roda serializada por `QUEUE_LOCK`, dois dispositivos abertos
  ao mesmo tempo nunca disparam a mesma promoção duas vezes.
- **`POST /api/queue/enqueue-batch`** — recebe uma lista de pares
  pickup/dropoff + palletType (1 par no modo normal, N em sequência), valida
  Caso 3 (fronteira/FIFO) como GATE FINAL (não só feedback do cliente —
  ver `is_pickup_allowed`/`is_dropoff_allowed`, usando sempre a vista
  "top" como autoridade), e decide atomicamente (sob `QUEUE_LOCK`, mesma
  trava da thread de fundo) se vira atual/pendente/fila. Devolve `{"slot":
  "current"|"pending"|"queued"}` só pro cliente escolher a mensagem certa
  de feedback. `route["user"]` é capturado da SESSÃO no momento do
  enfileiramento (nunca relido depois) — inclusive quando o disparo de
  verdade só acontece bem mais tarde, promovido automaticamente pela
  thread de fundo; mais correto que a versão antiga (cliente), onde o
  registro no histórico ficava por conta de qual ABA estava rodando a
  sondagem no momento, meio ao acaso.
- **`POST /api/queue/cancel-current`** — cancela SÓ a rota em andamento,
  **por id** (`robot_cancel_task_record`, nunca mais `all-cancel`), e a
  fila segue: a `pendingRoute` (que o dispatch já tem como "próxima")
  assume, e `_advance_queue_locked` — a MESMA função do término normal —
  promove e pré-dispara a seguinte. O robô nunca fica com a lista vazia
  (a `pendingRoute` está sempre lá), então não cria a task de carga
  `AUTO_SYSTEM` no meio; como defesa contra um piscar de "sem task", se
  ainda há o que rodar o handler procura e mata uma carga que porventura
  tenha aparecido ANTES de promover (`robot_find_active_charge_task_id`).
  **Não é mais parada de emergência.** Se a rota cancelada era de uma
  sequência ("Lotes em sequência"), o resto do grupo cai junto
  (`_drop_group_from_queue` — ocupação projetada assumia que ela rodaria);
  rotas independentes na fila ficam intactas. **Campo a confirmar**: que
  cancelar a task ativa por id faz o dispatch promover a `pendingRoute`
  sozinho sem um vão que dispare a carga — o código se defende disso, mas
  vale ver ao vivo.
- **`POST /api/queue/remove-queued`** — agora cancela QUALQUER rota que
  ainda não está em andamento, inclusive a `pendingRoute` (antes recusava
  com 409 "cancele a atual primeiro"). Se é a `pendingRoute` (já foi pro
  robô) → cancela por id; se é só da `routeQueue` → some do estado local.
  A `currentRoute` segue rodando intacta. Esvaziou o slot de pending e
  ainda tem fila → pré-dispara a próxima pra pending na hora. Rota de
  sequência → cancela todo o resto do grupo que ainda não rodou (a
  `currentRoute`, mesmo do mesmo grupo, não é tocada — é anterior, não
  depende das seguintes). Idempotente: remover algo que já saiu devolve
  `{"ok":true}`, não erro (dois operadores clicando quase junto).
- **`POST /api/queue/emergency`** (`{"active": true|false}`) — **parada de
  emergência**. LIGAR: `robot_cancel_all_tasks()` (all-cancel — aqui SIM,
  é pra parar tudo) + esvazia a fila local (`currentRoute`/`pendingRoute`/
  `routeQueue` → null/[], logadas como `cancelled`) + liga o flag
  `emergency` no `queue_state.json`. Enfileirar passa a devolver 409.
  DESLIGAR: só apaga o flag — o robô volta ao normal sozinho.
  **Por que precisa de loop**: a API de dispatch **não tem "hold"**; assim
  que a lista de tasks do robô zera, ele recria sozinho a `AUTO_SYSTEM` de
  carga e volta a andar. Então enquanto `emergency` está ativo a thread de
  fundo sonda mais rápido (`EMERGENCY_POLL_INTERVAL_SECONDS = 1.5`) e, se
  vê QUALQUER task ativa, dá `all-cancel` de novo (`_emergency_suppress`,
  roda FORA do `QUEUE_LOCK` — só fala com o robô). Em repouso é 1 `GET`
  leve por tick; o `POST` só dispara quando o robô recriou a carga. É
  **melhor esforço, não fail-safe**: se o servidor/rede cair, o robô vai
  pra carga — **não substitui o E-stop físico**. Entre a carga nascer e o
  tick cancelar, o robô anda alguns segundos (visto no teste com stub:
  fila de AUTO_SYSTEM `CANCELLED` + uma `WAITING` recém-criada por catar).
  Flag sobrevive a restart (reconciliação pula e avisa no console).
  Idempotente sob lock (dois tablets ligando junto convergem).
- `robot_cancel_all_tasks()` (`/task-record/all-cancel`) voltou a ter uso —
  só nessa parada de emergência (o cancelamento de rota normal é granular,
  por id).
- **`GET /api/live-state`** — leitura pura (`{currentRoute, pendingRoute,
  routeQueue, occupied, emergency}`), é isso que todo navegador poll a
  cada 4s (o `emergency` sincroniza o botão em todos os tablets).
- **`POST /api/occupied/set`** / **`set-many`** — mutação cirúrgica só do
  array `occupied` (não reenvia `calibration.json` inteiro) — resolve o
  lost-update de ocupação. Pontos/lotes (modo desenvolvedor, raro, um
  editor por vez na prática) continuam por `POST /api/calibration` de
  sempre — que agora **sempre preserva o `occupied` que já está em disco**,
  em vez de confiar no que o payload manda (ou não manda): `useCalibration.js`
  nem inclui mais `occupied` no snapshot que salva, então sem essa
  preservação server-side qualquer edição de ponto/lote apagaria a
  ocupação ao vivo de todo mundo.
- **Reconciliação na subida do servidor** (`_reconcile_queue_state_on_startup`)
  — se `queue_state.json` tinha uma `currentRoute`, confere o status real
  dela no robô ANTES de confiar cegamente no que sobrou em disco (o robô
  pode ter terminado/cancelado enquanto o processo estava fora do ar, ex:
  reinício pra trocar `ROBOT_HOST`). Testado: matar o processo com uma
  rota em andamento, marcar ela como concluída "no robô", subir de novo —
  reconcilia sozinho (promove a fila, marca ocupação, grava o histórico)
  antes de aceitar requisição nenhuma.

**Frontend** (`hooks/useLiveState.js`, novo): poll `GET /api/live-state` a
cada 4s (+ um refresh imediato depois de qualquer ação, pra não esperar o
próximo ciclo) e expõe `enqueueRoute`/`cancelCurrent`/`removeQueued`/
`setOccupied`/`setOccupiedMany`/`toggleOccupied`. `MainApp.jsx` perdeu
inteiramente `fireRoute`/`advanceQueue`/o `useEffect` de sondagem — só
manda a intenção e mostra o que o servidor devolve. `useCalibration.js`
perdeu `occupied` (migrou pro hook novo) — continua dono só de
`points`/`lots`/`view`. Os componentes-folha (`PointToPointBar`,
`RouteQueue`, `OccupancyPanel`, `FloorPlanCanvas`) não mudaram — já
recebiam esses dados/callbacks só via props.

**Trade-off consciente**: os handlers de fila (`_queue_enqueue` etc.)
seguram `QUEUE_LOCK` durante a chamada de verdade ao robô (até ~10-20s no
pior caso, dois `_robot_call` em sequência) — outros pollers ficam
bloqueados por esse tanto. Pra ~10 tablets disparando rota ocasionalmente
(não a cada poucos segundos), isso é aceitável e muito mais simples do que
um esquema de "reservar slot, soltar lock, disparar, re-adquirir" — não
foi feito.

**Testado** (servidor isolado + stub HTTP simulando o dispatch service,
sem depender do robô real): duas requisições `POST /api/queue/enqueue-batch`
disparadas de propósito ao mesmo tempo (`curl` em paralelo) resultam em
exatamente uma "atual" e uma "pendente", nunca duas — e o stub confirma
só 2 chamadas de `task-fast`, nunca mais. Duas marcações de ocupação
concorrentes (nomes diferentes) não se perdem. `POST /api/calibration`
não apaga mais `occupied`. Rejeição de Caso 3 confirmada como gate
server-side. Reconciliação na subida confirmada (rota marcada `FINISHED`
"no robô" enquanto o servidor estava fora do ar é promovida corretamente
ao subir). Visibilidade cross-device confirmada com Playwright (dois
browser contexts logados, um dispara, o outro vê a rota aparecer sozinha
dentro de um ciclo de poll, sem ter feito nada).

**Bug real encontrado em campo depois de deployado, já corrigido**:
`_occupied_set_many` (endpoint do gesto de "pintar" ocupação arrastando)
tinha a linha `self._relay(200, ...)` **duplicada** — o servidor mandava
DUAS respostas HTTP no mesmo socket a cada gesto de pintar. O parser do
Vite dev server (Node) não tolera isso e derrubava o processo inteiro
(`Parse Error: Data after 'Connection: close'`), parecendo um bug de
rede/ambiente do usuário. Só `set-many` tinha o problema — marcar
quadrado a quadrado (`_occupied_set`) estava correto. Depois de corrigir,
varreu TODOS os endpoints inspecionando os bytes crus da resposta (não
só via `curl`, que ignora esse tipo de erro) — nenhum outro tinha o
mesmo padrão. Lição: qualquer handler novo que termina com `self._relay`
vale conferir se não sobrou um `_relay` duplicado por engano de copiar-colar.

### Empacotamento em `.exe` — PRÓXIMA TAREFA (retomar aqui)

Motivação: hoje rodar o app numa máquina nova exige VSCode/terminal, Python,
Node (pra build) — o usuário quer um `.exe` "plug and play": clica no
ícone do desktop, uma janelinha pede o IP do robô, e a partir daí o app
funciona sem precisar de nada mais instalado na máquina.

**Esclarecimento já discutido e importante pra não perder**: os tablets
NÃO acessam endereços diferentes entre si — todo mundo (computador +
todos os tablets) acessa o MESMO endereço
(`http://<IP-da-máquina-que-roda-o-server>:8000`), porque é o mesmo
servidor respondendo pra todo mundo (é literalmente o que a "Fila de
rotas compartilhada" acima implementa). O único ponto de acesso a mais
disso, `hostname -I`/`ip addr`, é como se descobre esse IP hoje — a
janelinha do `.exe` deve fazer isso sozinha e mostrar pro usuário.

**Desenho já fechado com o usuário** (perguntas feitas, respondidas,
ainda NADA implementado):

1. **PyInstaller** empacota `server.py` (já zero-dependência, encaixe
   natural) + `web/dist` (buildado antes) + uma GUI nova num `.exe` só.
   Ninguém na máquina de destino precisa de Python/Node/VSCode.
2. **GUI nova** (tkinter, também da biblioteca padrão — zero dependência
   nova pra rodar) — uma janela com:
   - Campo de texto pro IP do robô (`ROBOT_HOST`), **pré-preenchido com o
     último valor usado** — salvo num arquivo de config ao lado do
     `.exe` (não dentro do `.exe`).
   - **Botão de power**: vermelho = servidor desligado; clicar com ele
     vermelho INICIA o servidor (roda `server.py` como thread de fundo
     DENTRO do próprio processo do `.exe`, não um subprocess — assim dá
     pra desligar de verdade via `ThreadingHTTPServer.shutdown()`, não só
     matar processo) e o botão fica verde; clicar com ele VERDE desliga o
     servidor (`shutdown()`) e volta pra vermelho.
   - Com o servidor rodando (botão verde), a janela mostra o endereço de
     LAN pra colar nos tablets (descoberto via o truque de socket UDP:
     abrir um socket UDP "conectado" a um IP externo sem mandar nada, ler
     `getsockname()[0]` — dá o IP da interface de rede real da máquina) e
     abre o navegador padrão sozinho (`webbrowser.open(...)`) em
     `localhost:8000`.
3. **Fechar a janela (X) só MINIMIZA pra barra de tarefas do Windows**
   (decisão explícita: NÃO é um ícone na bandeja do sistema/tray — isso
   exigiria `pystray` + `Pillow`, dependências novas empacotadas no
   `.exe`; minimizar pra barra de tarefas é zero-dependência-nova e
   resolve o mesmo problema, só que ocupa uma entrada visível na barra
   enquanto roda). O servidor continua rodando com a janela minimizada;
   clicar no ícone da barra de tarefas restaura a janela (com o botão de
   power já mostrando o estado real).
4. **Build via GitHub Actions** (runner `windows-latest`) — PyInstaller
   não faz cross-compile de Linux pra Windows, então o `.exe` precisa ser
   gerado numa máquina Windows de verdade; GitHub Actions dá isso de
   graça na nuvem, sem o usuário precisar ter Windows. Workflow: checkout
   → setup Python + Node → `npm run build` (frontend) → PyInstaller
   (com spec file, bundlando `web/dist` como dado) → artefato/`.exe`
   publicado.

**Fricção esperada, não é bug**: no primeiro uso, o Firewall do Windows
vai perguntar se libera o app na rede (precisa, pros tablets alcançarem)
— avisar o usuário disso, não tentar "resolver" programaticamente.

### IMPLEMENTADO (2026-09-01) — falta só rodar o build

Arquivos novos:
- **`packaging/lifty_gui.py`** — a GUI tkinter (stdlib). `import server`,
  campo de IP (persiste em `lifty_config.json` ao lado do `.exe` via
  `server._app_dir()`), botão de power (vermelho `LIGAR` ↔ verde
  `DESLIGAR`), mostra o IP de LAN pros tablets (truque do socket UDP),
  abre o navegador em `localhost:8000` ao ligar. **X só minimiza**
  (`root.protocol("WM_DELETE_WINDOW", root.iconify)`); **botão "Sair"
  separado** encerra de verdade (`server.stop_server()` + `destroy()`).
- **`packaging/lifty.spec`** — PyInstaller onefile. Entry
  `lifty_gui.py`, bundla `web/dist` como `datas`, `icon=packaging/LIFTY.ico`.
  `console=True` por enquanto (ver prints do server.py no teste) — trocar
  pra `False` no release.
- **`packaging/LIFTY.ico`** — ícone (fornecido pelo usuário).
- **`packaging/calibration.seed.json`** — o mapa JÁ calibrado (28 lotes +
  11 pontos na `top`, 28 lotes na `iso`, `occupied` vazio) embutido como
  "de fábrica". Num install NOVO (sem `calibration.json` ao lado do
  `.exe`), `_seed_calibration_if_missing` em `server.py` copia ele pro
  lugar. Install que já tem mapa **nunca** é sobrescrito — trocar o `.exe`
  não mexe na calibração de quem já usa, e edições persistem local. Pra
  atualizar o de fábrica: `cp calibration.json packaging/calibration.seed.json`
  e rebuildar.
- **`.github/workflows/build-exe.yml`** — `windows-latest`, dispara na mão
  (aba Actions) ou por tag `v*`. checkout → node 20 → `npm ci && npm run
  build` → python 3.12 → `pip install pyinstaller==6.11.1` → `pyinstaller
  packaging/lifty.spec` → sobe `dist/LIFTY.exe` como artefato
  `LIFTY-windows`.

Mudanças no `server.py`:
- **`_app_dir()`** (pasta do `.exe` quando `sys.frozen`, senão
  `Path(__file__).parent`) — usado nos 5 arquivos de dado
  (`calibration`/`route_log`/`queue_state`/`users`/`session_secret`).
  **`_bundle_dir()`** (`sys._MEIPASS` quando frozen) — usado no
  `STATIC_DIR` (`web/dist`) e no `calibration.seed.json` (só leitura).
- **`_seed_calibration_if_missing()`** — pré-carrega o mapa de fábrica num
  install novo (ver `packaging/calibration.seed.json` acima). Roda no
  `start_server()`, junto do `_bootstrap_users_if_missing()`.
- **`set_robot_host(host)`** — troca `ROBOT_HOST` em runtime, normaliza
  (`192.168.1.5` → `http://192.168.1.5/`). `_robot_call`/`_proxy` leem o
  global fresco a cada chamada, então pega na hora.
- **`start_server()` / `stop_server()` / `is_running()`** — ciclo de vida
  in-process pro botão de power. `serve_forever` numa thread daemon;
  `stop_server` faz `shutdown()` + `server_close()` + para a thread da
  fila. O `__main__` (CLI, `python3 server.py`) usa os MESMOS —
  `start_server()` e fica em `while is_running(): sleep(1)`.
- **Thread da fila parável**: `_queue_stop` (Event) + `_queue_thread`;
  o loop usa `_queue_stop.wait(interval)` no lugar de `time.sleep`,
  `_start_queue_thread` é idempotente, `_stop_queue_thread` faz
  `join(timeout=12)`. Religar pelo botão não deixa thread órfã/duplicada.

**Testado no Linux** (isolado, com stub do robô, sem tocar nos arquivos
reais nem no robô real): start → responde → stop → porta liberada →
restart → responde; `_start_queue_thread` idempotente (não duplica
thread); após stop final só sobra a MainThread; `set_robot_host`
normaliza certo; CLI (`python3 server.py`) sobe e responde.

**CI falhou na 1ª tentativa (2026-09-01, run de ~48s, exit 1)** — RETOMAR
AQUI. NÃO é o npm: `npm ci` + `npm run build` reproduzidos no Linux,
ambos passam (lockfileVersion 3, deps batem, Node 20.20). O erro está na
etapa seguinte, o **PyInstaller** (`pyinstaller packaging/lifty.spec`) —
suspeitas, em ordem: (1) sintaxe da spec pra PyInstaller 6.11.1
(`PYZ(a.pure)` / assinatura do `EXE` onefile / kwargs do `Analysis`);
(2) `icon='packaging/LIFTY.ico'` resolvido a partir do CWD; (3)
`datas=[('web/dist','web/dist')]`. Próximo passo: pegar o log da etapa
vermelha do Actions, OU instalar pyinstaller no Linux e rodar a spec
(gera ELF inútil, mas reproduz erro de spec/Analysis). O aviso "Node.js
20 is deprecated" no run é do runtime das *actions*, não do nosso
`node-version` — ignorar.

**Em aberto pra quando pegar o `.exe` na mão:**
- `console=True` no spec — decidir quando virar `False`.
- `web/package-lock.json` está commitado (conferido) — `npm ci` ok.
- Testar no Windows: firewall, X→barra de tarefas, "Sair", persistência
  do `lifty_config.json`, os 5 json nascendo ao lado do `.exe`.

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
- Cancelar rota virou granular (ver "Fila de rotas compartilhada"):
  `cancel-current` cancela só a atual e a fila segue; `remove-queued`
  cancela qualquer rota não-iniciada, inclusive a `pendingRoute`. O
  "parar tudo" ficou no **botão de emergência** (`/api/queue/emergency` +
  loop de supressão da task de carga) — canto superior esquerdo do mapa.
- Painel "Histórico" (erros/avisos) hoje só busca a página mais recente
  (`size=30`, sem paginação) — se um dia precisar navegar o histórico
  inteiro (923+ registros no teste), dá pra adicionar paginação de verdade
  em `HistoryPanel.jsx`.
