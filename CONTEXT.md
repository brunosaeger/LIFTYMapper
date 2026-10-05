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

**Antes de rodar em campo:** não precisa mais editar `ROBOT_HOST` na mão —
o servidor descobre o IP do robô sozinho ao subir (ver "Descoberta
automática do IP do robô" logo abaixo). O IP que o TABLET usa pra acessar
o app é outro — é o IP desta máquina (a que roda o `server.py`), não o do
robô; descobre com `hostname -I` (Linux) e confere que caiu na mesma faixa
do robô.

**Descoberta automática do IP do robô (IMPLEMENTADO 2026-09-21)**: o robô
troca de IP toda vez que a rede muda (hotspot de celular vs roteador fixo,
ou o próprio DHCP reatribuindo) — mas só o ÚLTIMO octeto muda dentro da
MESMA sub-rede (observado pelo usuário: já foi `.193`, virou `.195`, sempre
`192.168.5.x`). Editar `ROBOT_HOST` na mão a cada troca já era uma dor
recorrente documentada nesta seção em sessões anteriores (`192.168.43.74`
no hotspot, `172.16.1.244` na rede fixa, `192.168.5.193`→`.195` depois).
Resolvido: `discover_robot_host()` em `server.py`, chamada automaticamente
por `start_server()` sempre que nenhum `robot_host` explícito é passado —
a GUI do `.exe` (campo de IP manual, ver "Empacotamento em .exe" abaixo)
continua sendo respeitada quando o usuário digita algo ali; a descoberta
automática entra quando ninguém informou nada, o que já cobre
`python3 server.py` direto.

Como funciona:
1. **Atalho rápido**: tenta o último IP que funcionou (`robot_host.txt` ao
   lado do `calibration.json`, gitignorado — mesmo padrão de dado de
   runtime) e o `ROBOT_HOST` atual, testando cada um contra
   `GET {ip}/api/reeman-dispatch-service/project/infos` (endpoint mais
   leve do dispatch service) e conferindo se a resposta tem a cara certa
   (`{"code": ...}`) — não só se a porta 80 está aberta, pra não "achar"
   qualquer outro serviço HTTP que por acaso esteja na rede. Cobre o caso
   comum ("nada mudou desde o último boot") sem varrer nada.
2. **Varredura completa**, só se o atalho falhar: descobre a sub-rede /24
   da PRÓPRIA máquina via um truque de socket UDP "conectado" (não manda
   pacote de verdade, só resolve a rota — funciona mesmo sem internet,
   só precisa da wifi já conectada) e testa os 254 endereços em paralelo
   (`ThreadPoolExecutor`, 40 workers, timeout de 0,5s por tentativa) até
   achar quem responde certo. **Testado contra o robô real** nesta sessão
   (2026-09-21, a máquina de dev estava na mesma rede do robô): achou em
   ~2,7s varrendo os 254 endereços.
3. **Redescoberta em runtime**: se uma chamada ao robô falhar por problema
   de CONEXÃO (não uma resposta HTTP de erro normal, que significa que o
   robô respondeu e só não gostou do pedido — `_note_possible_ip_change`
   distingue os dois via `isinstance(err, urllib.error.HTTPError)`),
   dispara uma nova descoberta numa thread separada, com cooldown de 30s
   entre tentativas (`DISCOVERY_RESCAN_COOLDOWN_SECONDS`) pra não martelar
   a rede inteira se o robô estiver genuinamente desligado.

Se a descoberta não achar nada (robô fora da mesma sub-rede /24, rede
ainda não subiu no boot etc.), mantém o `ROBOT_HOST` que já estava
(hardcoded no topo do arquivo, agora só semente/fallback) — nunca apaga um
valor que já funcionava.

**Fora do escopo desta implementação**: a GUI do `.exe`
(`packaging/lifty_gui.py`) continua com o campo de IP manual + o valor
salvo em `lifty_config.json`, sem chamar `discover_robot_host()`. Dava pra
fazer a GUI também se beneficiar disso (campo manual vira fallback
opcional em vez de obrigatório), mas é decisão separada, ainda não
discutida/implementada.

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

**CUIDADO — `index.html` precisa de `Cache-Control: no-cache` (2026-09-14)**:
`SimpleHTTPRequestHandler` não manda cache-control nenhum, aí o navegador
decide por conta — em tablet/Chrome mobile isso na prática guardava o
`index.html` em cache local sem revalidar. Como o `index.html` referencia
o JS/CSS pelo **nome com hash de conteúdo** (Vite), um `index.html` velho
em cache prendia o tablet numa versão antiga do app pra sempre, mesmo
depois de um `git pull` + rebuild — só saía com "limpar cache do site" na
mão em CADA tablet a cada atualização (dor recorrente, aconteceu várias
vezes nesta sessão). Corrigido: `Handler.end_headers()` manda
`Cache-Control: no-cache` só pra `/` e `/index.html` (sempre revalida);
`/assets/*` continua livre pra cachear à vontade — o nome muda sozinho
quando o conteúdo muda, então nunca serve algo desatualizado. Não tirar
esse header nem generalizar ele pra todo mundo (cachear os assets é
seguro e bom).

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
- `src/components/`: `Toolbar`, `PointsPanel`, `LotsPanel`, `CloseUpsPanel`,
  `PalletHeightsPanel`, `PointToPointBar`, `QueuePanel`, `OccupancyPanel`,
  `HistoryPanel`, `UsersPanel`, `DevModeModal`, `LoginScreen`, `Toast` —
  peças da UI, veja cada uma. (`RouteQueue` foi renomeado/movido pra
  `QueuePanel`, ver "Painel Fila dedicado" abaixo.)
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

**Slider vertical de zoom — REMOVIDO (2026-09-16)**. Existiu como
`.zoom-slider`/`sliderFracToScale`/`handleZoomPointer*` em
`FloorPlanCanvas.jsx` (controle de posição absoluta: bolinha no centro =
zoom default, topo/fundo = `MAX_ZOOM_MULT`/`MIN_ZOOM_MULT`, mapeamento
exponencial, ponto focal = último toque no mapa via `rememberFocal`/
`focalContentRef`). Removido porque o modo Interação (ver "Close Up e modo
Interação" abaixo) já cobre bem o gesto de "ver de perto uma área"; o
espaço que ele ocupava (`top: 316px`, logo abaixo da pilha de botões) virou
o botão **Fila** (ver "Painel Fila dedicado" abaixo). Roda do mouse e pinça
de dois dedos continuam funcionando exatamente como antes — não dependiam
do slider, tinham foco/lógica próprios (`handleWheel`/`pinchRef`).

### Duas vistas independentes (topo / isométrica) — vista isométrica LEGADA

O botão flutuante que trocava entre a planta baixa
(`src/assets/floorplan.jpg`) e a vista isométrica (`src/assets/isometric.jpg`)
foi **reaproveitado pro modo Interação** (ícone de mãozinha, ver "Close Up e
modo Interação" abaixo) — nada na UI chama mais `setView`, então a vista
fica travada em `'top'` daí pra frente. A vista `'iso'` e o split
`top`/`iso` do `calibration.json` **não foram removidos** (só ficaram
inatingíveis pela interface) — dado antigo continua sendo lido/gravado sem
quebrar nada, só não dá mais pra chegar nele por nenhum botão. Segue a
descrição original da mecânica, hoje só relevante se algum dia a troca de
vista voltar a existir:

Botão flutuante (ícone de olho) em cima do canvas alternava entre a planta
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

**Ponto avulso**: `{ id, name, displayName, x, y, rotation }` — `x`/`y` em
fração [0,1] da imagem da vista (não pixel de tela), sobrevive a qualquer
zoom/resolução. `name` é o nome TÉCNICO — precisa ser **idêntico** ao
ponto já calibrado no robô (ver dica em `PointsPanel.jsx`), nunca muda por
causa de apelido. `displayName` é o nome fantasia — mesmo mecanismo dos
lotes logo abaixo, sem numeração (ponto avulso é uma entidade única, não
uma sequência de células).

**Lote** (linha ou coluna de células grudadas, criado por clique-e-arrasto):
`{ id, prefix, displayName, x, y, rotation, count, cellSize, scaleX,
scaleY, color, namesVisible }`. Cada célula tem nome TÉCNICO derivado:
índice 0 = só o prefixo (`A`), demais numeram a partir de 2 (`A2`,
`A3`...) — `lotCellName(prefix, index)` em `useCalibration.js`. `cellSize`
fica gravado no momento da criação (não recalculado depois — ver
`DEFAULT_CELL_SIZE` em `FloorPlanCanvas.jsx`, hoje `11.97`px de conteúdo,
extraído medindo os lotes já calibrados manualmente pelo usuário pra bater
com o tamanho físico dos kanbans reais). A célula de índice 0 também ganha
um triangulozinho de "facing" saindo da base — ver "Close Up e modo
Interação" abaixo.

### Nome fantasia (`displayName`, IMPLEMENTADO 2026-09-18, lotes E pontos avulsos)

Apelido puramente visual, editável em `LotsPanel.jsx`/`PointsPanel.jsx`
junto do nome/prefixo técnico (`null` = sem apelido cadastrado). Existe
porque os nomes técnicos (`prefix`/`lotCellName` do lote, `name` do ponto)
já estão configurados no backend do robô — pontos com uma calibração que
precisa bater EXATAMENTE com o robô, lotes com uma lógica própria de
organização — e os operadores não conhecem essa nomenclatura, só a "de
chão de fábrica".

- **Lote**: `lotCellDisplayName(lot, index)` em `useCalibration.js`. Regra
  de numeração **diferente** da técnica de propósito (pedido explícito do
  usuário): o nome técnico (`lotCellName`) omite o número na 1ª célula
  (`A`, `A2`, `A3`...), mas a fantasia numera TODAS as células a partir de
  1 (`Linha Norte 1`, `Linha Norte 2`, `Linha Norte 3`...) — só pra
  fantasia, o técnico não mudou em nada.
- **Ponto avulso**: sem numeração — é `point.displayName` puro (entidade
  única, não uma sequência de células).
- **Resolver a partir do nome técnico**: `displayCellName(nomeTécnico,
  lots, points)` em `useCalibration.js` — procura primeiro nos lotes
  (célula por célula), depois nos pontos avulsos; `points` é opcional (só
  precisa de quem só tem a STRING técnica em mãos, como fila/ocupação/
  ponto a ponto, que vêm do servidor como nomes técnicos puros — o mapa já
  tem o objeto `point`/`lot` inteiro, não precisa dessa busca).

**A troca é só na renderização**: `PointToPointBar.jsx`, `QueuePanel.jsx`,
`OccupancyPanel.jsx`, o `<Text>` de `LotCell` e de `PointMarker`
(`FloorPlanCanvas.jsx`), e os **toasts de `MainApp.jsx`**
(`pickupDeniedMessage`/`dropoffDeniedMessage` — recusa de Caso 3 — e o
toast de confirmação de `handleEnqueueRoute`, tanto o de rota única quanto
o "N rotas enviadas em sequência: ...") mostram o apelido quando existe,
mas toda comparação/lógica (Caso 3, `pickupNames`/`dropoffNames`,
`occupied`, o que é mandado pro servidor) continua 100% sobre o nome
técnico — nada disso muda de valor, só o texto que aparece na tela. Sem
apelido cadastrado, cai no nome técnico mesmo (comportamento de sempre,
sem caso especial). **Fora do escopo de propósito**: os `window.confirm`
de exclusão em `LotsPanel.jsx`/`PointsPanel.jsx`/`CloseUpsPanel.jsx`
continuam mostrando o nome técnico — são diálogos do modo desenvolvedor
(edição/calibração), onde o nome técnico é exatamente o que precisa
aparecer, não o apelido do operador.

**Área de Close Up** (retângulo livre, sem rotação, criado por
clique-e-arrasto no modo `closeup`): `{ id, name, x, y, width, height,
scaleX, scaleY }` — `x`/`y` é o canto superior-esquerdo em fração [0,1] da
imagem (mesmo referencial de ponto avulso), `width`/`height` em px de
conteúdo (mesmo referencial de `cellSize`), `scaleX`/`scaleY` aplicados
pelo `Transformer` do Konva ao redimensionar. Ver "Close Up e modo
Interação" abaixo.

### Modos de interação (`mode` em `MainApp.jsx`)

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
- **`closeup`** (só em modo desenvolvedor): criar/editar áreas de Close Up
  (retângulo livre, tracejado laranja). Ver "Close Up e modo Interação"
  abaixo.
- **`interaction`**: navegação segura pro operador — tocar numa área de
  Close Up dá zoom automático nela; fora delas, o mapa não reage a clique
  nenhum (sem risco de marcar ocupação ou selecionar rota sem querer).
  Acessível a **qualquer usuário**, não só dev. Ver "Close Up e modo
  Interação" abaixo.
- **`queue`**: painel dedicado à fila de rotas (rota em andamento +
  próximas), fora do `ptp`. Acessível a **qualquer usuário**. Ver "Painel
  Fila dedicado" abaixo.

Acesso a `ptp`/`mark`/`interaction`/`queue` é por **botões flutuantes**
sobre o canvas (não pelo Toolbar), empilhados no canto superior direito do
mapa, mesmo tamanho (56px), 20px de espaço entre eles, de cima pra baixo:
reset de zoom, mãozinha (entrar/sair de `interaction` — substituiu o antigo
alternador de vista topo/isométrica, ver "Duas vistas independentes"
acima), X (entrar/sair de `mark`), ícone de rota (entrar/sair de `ptp`) e
ícone de índice/listagem (entrar/sair de `queue` — no lugar do antigo
slider vertical de zoom, ver seção acima). Sair de
`ptp`/`mark`/`interaction`/`queue` sempre volta pro modo de repouso
(`baseMode()` em `MainApp.jsx`): `edit` se for dev, `ptp` pra todo mundo
mais.

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
completo sem ele. A aba "Editar pontos" tem três sub-seções, nessa ordem:
**"Altura de pallets"** (`PalletHeightsPanel`, ver "Diferenciação de
pallets"), **"Pontos avulsos"**, **"Lotes"**. Sair do modo (clicar em
`{ }` de novo, sem pedir senha — senha só é exigida pra ENTRAR) força o
modo de volta pro `ptp` se estava em `edit`/`history`.

**Importante**: só esconder os botões não bastaria — o modo padrão do app
era `edit` antes dessa mudança, o que tornaria a trava inútil (o app já
cairia sozinho no modo escondido). Por isso o modo inicial virou `ptp`, e
o modo de "repouso" pra onde os toggles de `ptp`/`mark` voltam
(`baseMode()` em `MainApp.jsx`) só é `edit` quando `devMode` está ativo.

Com o modo ativo, a aba **"Editar closes"** também aparece no Toolbar
(mesmo gate de "Editar pontos") — ver seção seguinte.

### Close Up e modo Interação (IMPLEMENTADO 2026-09-15)

Motivação: dar zoom manual até um grupo de kanban específico é lento em
tablet, principalmente com muitos lotes próximos. A solução é o
desenvolvedor desenhar, uma vez, retângulos invisíveis por cima dos grupos
— e o operador só tocar dentro de um deles pra ganhar um zoom automático e
centralizado naquele grupo.

**Criação** (modo `closeup`, aba "Editar closes", só dev): botão "+ Close
Up" na sidebar (`CloseUpsPanel.jsx`) arma a ferramenta; clique-e-arrasto
livre no mapa (`handleStageMouseDown`/`handleStageMouseMove`/
`finishCloseUpDrag` em `FloorPlanCanvas.jsx`, mesmo padrão StrictMode-safe
de `lotDraft`/`finishLotDrag`, mas sem travar em direção/célula — os dois
cantos são normalizados livremente). Um clique sem arrastar (abaixo de
`MIN_CLOSEUP_DRAG`) ainda cria um quadrado de tamanho padrão
(`DEFAULT_CLOSEUP_SIZE`) centrado no clique, em vez de nada — mesma
filosofia "generosa" da criação de lote. A área é desenhada
(`CloseUpMarker`) com tracejado laranja só nesse modo; em qualquer outro
modo que não seja `interaction`, ela nem é renderizada — é isso que garante
"invisível de verdade" fora da edição.

**Uso** (modo `interaction`, qualquer usuário): a mesma `CloseUpMarker`
continua montada (pra escutar clique), mas sem fill/stroke nenhum — clique
dentro dela chama `handleCloseUpClick`, que anima o Stage (`stage.to`,
`Konva.Easings.EaseOut`, mesmo padrão de `usePtpScale`) até centralizar o
retângulo na tela, com uma folga de `CLOSEUP_ZOOM_MARGIN` (1.4×) ao redor
pra sobrar contexto. Sair do zoom não precisa de nada especial: o botão de
reset e a roda/pinça de zoom já funcionam em qualquer modo. Fora das áreas
de Close Up, o mapa em `interaction` não reage a clique nenhum —
`PointMarker`/`LotMarker` só ficam interativos em `edit`/`ptp`/`mark`, e
`interaction` não é nenhum dos três, então herda essa inércia de graça, sem
precisar de nenhuma mudança neles.

**Banner "VISUALIZANDO: KANBAN X"** (IMPLEMENTADO 2026-09-18,
`CloseUpStatusBanner.jsx`): mesmo retângulo semitransparente do
`RobotStatusBanner`, espelhado pro centro-inferior da tela (`bottom: 84px`
— não os mesmos 24px do `.toast`, de propósito, pra nunca sobrepor um
toast que apareça com o banner ativo). Mostra o nome do Close Up tocado
por último (`activeCloseUpId` em `MainApp.jsx`, resolvido contra `closeUps`
a cada render — acompanha rename ao vivo). Liga em `handleCloseUpClick`
(`FloorPlanCanvas.jsx`), chamando `onCloseUpActivate(closeUp)` já no toque,
sem esperar a animação de zoom terminar.

Desliga (`onCloseUpActivate(null)`) em QUALQUER mudança de ZOOM — pedido
explícito do usuário (2026-09-18): "persistente enquanto o zoom da
aproximação está rolando, qualquer alteração no zoom tira ele". `handleResetView`,
`handleWheel` (roda do mouse) e o ramo de pinça de `handleTouchMove`
(2 dedos) chamam isso; **pan/arrasto (1 dedo ou clica-arrasta) NÃO chama**
— só mover o mapa no mesmo nível de zoom não derruba o banner, só uma
mudança de ESCALA de verdade. Também desliga em `resetSelection()` em
`MainApp.jsx` — que roda em TODA troca de modo, então sair de
`interaction` por qualquer botão (inclusive entrar nele de novo, começando
sempre "sem nada ativo") também limpa. Tocar um Close Up diferente troca o
nome na hora (a mesma chamada
`onCloseUpActivate` dispara de novo).

**Seleção de Ponto a Ponto sobrevive aos "peek modes" — Interação
(BUG, corrigido 2026-09-16, em DUAS partes) e Marcação (mesmo tratamento,
pedido do usuário, 2026-09-18)**: entrar/sair de `interaction` (botão
mãozinha) chamava `resetSelection()` igual a qualquer outro toggle de
modo, que zerava `pickupNames`/`dropoffNames` — ou seja, escolher a
origem, abrir Interação pra conferir um lote de perto (dar zoom numa área
de Close Up) e voltar pro `ptp` perdia a origem já selecionada. Como
Interação é um modo de "só olhar" (não seleciona nada no mapa, não
conflita com nenhuma regra de Caso 3), não devia derrubar uma seleção em
andamento.
1. **Estado**: `resetSelection` (`MainApp.jsx`) ganhou o parâmetro
   opcional `{ keepRoute }`, que pula só `setPickupNames`/
   `setDropoffNames`/`setActiveSlot` (mantém tudo mais — seleção de
   ponto/lote/close-up em edição, addTool etc.). **Não bastava** só
   `handleToggleInteractionMode` passar `keepRoute: true`: o usuário sai
   de Interação clicando o botão de ROTA (ptp), não necessariamente de
   novo no de mãozinha — e `handleTogglePtpMode` (e igualmente
   `handleToggleQueueMode`/`handleModeChange`) chamava `resetSelection()`
   incondicionalmente, jogando fora o que acabara de ser preservado. Fix:
   `isPeekMode(m)` (`m === 'interaction' || m === 'mark'`) — todo toggle
   de modo calcula `const keepRoute = isPeekMode(mode)` (lendo o modo
   ATUAL, antes da troca) e passa isso pra `resetSelection`; os dois
   toggles dos próprios peek modes (`handleToggleMarkMode`/
   `handleToggleInteractionMode`) passam `keepRoute: true`
   incondicionalmente, já que entrar OU sair deles sempre preserva. Ou
   seja: sair de Interação/Marcação por QUALQUER botão preserva a
   seleção; sair de qualquer outro modo continua limpando normalmente.
   Marcação virou peek mode pelo mesmo motivo de Interação: corrigir uma
   ocupação errada é uma "ida rápida resolver outra coisa", não devia
   custar a seleção de ptp em andamento.
2. **Visual**: mesmo com o estado preservado, o destaque azul/âmbar
   sumia do mapa assim que entrava num peek mode, porque `highlightsRoute`
   (`FloorPlanCanvas.jsx`, ver "Fila de rotas compartilhada"/BUG DE
   LANÇAMENTO acima) só cobria `ptp`/`queue`, depois `ptp`/`queue`/
   `interaction` — passou a cobrir também `mark`, então a origem/destino
   já escolhidos continuam visíveis no mapa enquanto o operador está lá
   dentro, sem parecer que sumiu.

O botão de reset de zoom (`handleResetView` em `FloorPlanCanvas.jsx`)
nunca teve esse problema: é 100% local ao canvas (só mexe em
`stageScale`/`stagePos`), nunca tocou estado de seleção em `MainApp.jsx`.

**Triângulo de "facing"**: bônus independente do Close Up. Toda célula de
índice 0 de um lote (a sem numeração) ganha um triangulozinho saindo da
base do quadrado (`LotCell` em `FloorPlanCanvas.jsx`), indicando o lado
físico "de frente" do lote — sem ele não havia nenhuma pista visual de qual
extremidade é a célula 1. Fica no referencial local da célula (sempre
"pra baixo" antes da rotação), então herda a rotação do lote de graça.
Pontos avulsos ("lotes coringa") **não** ganham o triângulo — são
renderizados por `PointMarker`, um componente totalmente separado que
nunca passa por `LotCell`, então a exclusão sai de graça da estrutura
existente.

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

**Hash de mapa — atualizado 2026-09-11.** `ROBOT_TARGET_MAP` mudou de
`eecc4a9068e11bd9086538383a38c67d` pra **`dbc5b2b4cd6d2505d78fe894403fe2c5`**
(robô foi remapeado — mesmo galpão, pontos/lotes idênticos, só o hash do
mapa ativo mudou). Confirmado direto no robô: `GET /reeman/current_map` →
`{"name":"dbc5b2b4cd6d2505d78fe894403fe2c5"}`, bate. Nada em
`calibration.json` referencia o hash do mapa (pontos/lotes são frações
[0,1] da imagem, não amarrados ao mapa do robô) — só `ROBOT_TARGET_MAP`
em `server.py` precisa mudar quando o robô é remapeado; sem migração de
dado nenhuma.
Histórico: antes disso, em 2026-09-01, houve um susto com hashes vistos em
mensagens de erro (`7d07a3564729e5a35999099c0e539e9c`,
`92802f9d5efcaf3836298077db4a35b0`) que eram de mapas antigos/inativos —
não o ativo. Confirmar sempre direto em `/reeman/current_map` (ou na
plataforma do fabricante) antes de assumir qual hash usar.

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
| `GET /task-record/page?projectId&page&size&status&name` | Lista/busca registros de execução (instâncias, não templates). Paginado, ordenado mais-recente-primeiro. **Status confirmados: `WAITING`, `FINISHED`, `CANCELLED`, `FAILED`** (não vimos o texto de "em execução" ainda). `taskType` confirmado: `FAST` (nossas tasks), `AUTO_SYSTEM` (task automática do robô, ex: ida pra carga). **`FAILED` mordeu (2026-09-09):** o código só olhava `FINISHED`/`CANCELLED`, então uma rota `FAILED` (1) ficava "em andamento" eterno no painel e (2) ao clicar no X, o robô respondia HTTP 400 pra "cancelar o que já falhou" — rota presa, só saindo editando `queue_state.json` na mão. Corrigido: `_is_terminal_status` (allowlist ampla: `FINISHED CANCELLED FAILED ERROR ABORTED STOPPED EXCEPTION TIMEOUT TERMINATED`, case-insensitive), `_apply_record_status` limpa qualquer terminal-não-FINISHED como "failed", e `_robot_try_cancel` trata 4xx do robô no cancel como "já morreu, limpa local" (só 5xx/rede vira 502 e mantém a rota). |
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

### Pulsar vermelho em clique inválido (IMPLEMENTADO 2026-09-18)

**Motivação** (pedido do usuário): o toast de recusa (`pickupDeniedMessage`/
`dropoffDeniedMessage`/"Ordem inválida"/etc) já existia, mas não dizia
visualmente QUAL quadrado no mapa foi o clicado — só um texto no canto.
Agora, toda vez que um clique de Ponto a Ponto (normal ou "Lotes em
sequência") é rejeitado, o próprio quadrado/ponto clicado pulsa em
vermelho no mapa, além do toast de sempre.

**Onde dispara** (`triggerInvalidPulse(name)` em `MainApp.jsx`, chamado
logo antes de cada `return` de rejeição):
- Modo normal (`handlePointToPointClick`): `isPickupAllowed` falha (vazio
  ou obstrução) / `isDropoffAllowed` falha (já ocupado ou obstrução).
- "Lotes em sequência" (`handleSequenceClick`): origens de lote
  misturando colunas diferentes; `isPickupAllowed`/`isDropoffAllowed`
  falha (ordem errada/obstrução); clicar um destino sem ter origem
  correspondente ainda (toast tipo `info`, mas ainda assim pulsa — é um
  clique que não fez nada, mesma lógica das rejeições `error`).

**Como funciona** (`useInvalidPulse` em `FloorPlanCanvas.jsx`, usado por
`PointMarker` e `LotCell`): um `<Circle>` extra dentro do Group de cada
marcador/célula, raio ~0.75× do tamanho, `stroke=COLORS.stateError`,
começa com `opacity=0` (invisível). `MainApp.jsx` guarda `{ name, id }`
(`id` incrementa a cada disparo via `pulseIdRef`, nunca reseta — é o que
faz o efeito disparar de novo mesmo clicando o MESMO ponto inválido duas
vezes seguidas, já que o nome sozinho não mudaria). Cada marcador recebe
`invalidPulseActive` (`name === invalidPulseName`, comparado contra o nome
TÉCNICO — igual a `isPickup`/`isDropoff`, sem relação com nome fantasia) e
`invalidPulseId`; o hook reage a `[active, pulseId]` e dispara DOIS pulsos
encadeados (expande + desvanece, `node.to(...)` — mesmo padrão de
`usePtpScale`), pra ler como "pulsar" de verdade em vez de um flash único.
100% imperativo (Konva) — o estado React (`invalidPulse` em `MainApp.jsx`)
nunca precisa ser limpo depois, só serve de gatilho.

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

### Banner de status do robô (IMPLEMENTADO 2026-09-14, mexido depois)

Retângulo semitransparente **centralizado no HEADER** (`RobotStatusBanner.jsx`,
montado dentro de `Toolbar.jsx` — mudou de lugar em 2026-09-18, era
centralizado sobre o mapa antes; pedido do usuário: "fica menos poluído"
flutuando por cima do canvas. `.toolbar` virou a âncora `position:relative`
pra isso, `.app` continua âncora só do `.closeup-status-banner`) —
indicação rápida de longe do que o robô está fazendo: **"ROBÔ: EM
OPERAÇÃO"** ou **"ROBÔ: RECARREGANDO"**. Cores (pedido do usuário,
`.robot-status-banner__label`/`__status` no CSS): "ROBÔ:" na cor neutra
das abas do header (`--text-muted`, mesma de "Editar pontos"/"Histórico"/
"Usuários" quando inativas); o status inteiro em mint vibrante
(`--accent-cyan`) quando operando, âmbar (`--accent-amber`) quando
recarregando — a bolinha ao lado segue a mesma cor.

**Lógica BINÁRIA de propósito por enquanto** (pedido do usuário, refinar
depois se precisar): vem de `chargeFlag` em `GET /reeman/base_encode`
(API SLAM) — `chargeFlag == 2` confirmado em campo (2026-09-14, bateria
subindo) como "carregando de verdade"; qualquer outro valor vira "Em
Operação", **mesmo que o robô esteja só parado/ocioso sem fazer nada**
(não tem terceiro estado ainda).

- **Sondado pela THREAD DE FUNDO** (`_refresh_robot_status()`, chamada no
  topo de `_queue_tick()`, roda em todo tick — normal ou de emergência),
  nunca pelos handlers HTTP diretamente — mesmo raciocínio de
  `_emergency_suppress`: um GET só por tick, não N tablets multiplicando
  chamada ao robô.
- **Cache em memória** (`_robot_status_cache`, não persiste em disco — é
  telemetria, não estado que precise sobreviver a restart).
  `None` = servidor ainda não conseguiu ler o robô (boot, ou robô fora do
  ar) — o componente não renderiza nada nesse caso, nunca mostra um
  rótulo errado. Se o robô cair depois de já ter lido uma vez, **mantém o
  último valor conhecido** em vez de voltar pra `None` (testado).
- Exposto em `GET /api/live-state` como `robotCharging` (`true`/`false`/`null`) —
  os tablets só leem o que já veio, igual todo o resto do live-state.
- Ponto colorido no banner: ciano = operando, âmbar = recarregando (mesma
  paleta de acento do resto do app).

**Testado** (stub simulando `/reeman/base_encode`): `null` antes do 1º
tick; `chargeFlag=1` → `false`; `chargeFlag=2` → `true`; robô ficando
inalcançável → mantém o último valor, não reseta.

**% de bateria + ícone de pilha (IMPLEMENTADO 2026-09-18)**: dentro do
MESMO retângulo, ao lado do status. `battery` já vinha documentado em
`GET /reeman/base_encode` (junto de `chargeFlag`/`emergencyButton` — ver
"A API do dispatch service" abaixo) mas nunca tinha sido lido por nenhum
código até agora. `_normalize_battery(raw)` em `server.py` converte pra
int e clampa 0-100 — **formato assumido, NÃO confirmado em campo ainda**
(diferente do `chargeFlag`, que já foi testado com o robô de verdade em
2026-09-14); se o robô mandar algo fora dessa convenção (ex: 0-1 float,
ou millivolts), o número vai aparecer errado até alguém confirmar o
formato real e ajustar essa função. Exposto em `/api/live-state` como
`robotBattery` (0-100 ou `null` — mesma regra do `robotCharging`: `null`
esconde o indicador em vez de mostrar lixo). `robot_simulator.py` também
simula (`STATE["battery"]`, drena ~0.5%/min rodando, carrega ~2%/min na
base — só pra ter algo pra olhar testando local sem o robô físico).

`BatteryIcon` (função local em `RobotStatusBanner.jsx`): pilha com 4
"pauzinhos" — quantos acendem = `Math.ceil(battery / 25)` (1 barra a cada
25%); cor do ícone INTEIRO (contorno + barras + número da %) muda com o
nível: **<20% vermelho** (`--state-error`), **<50% âmbar**, senão **mint**
— independente de estar carregando ou não (é sobre o nível, não sobre o
estado de carga).

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

**Lógica** (hoje toda no `server.py` — `_pallet_pickup_params` /
`robot_route_task_name` / `robot_create_and_run_route`; era em `lifty.js`
antes da fila virar dona do servidor):
- **CUIDADO, já erramos isso uma vez**: o campo `height` que fica direto no
  topo da ação PICKUP **NÃO é o que a plataforma usa** pra alinhar o
  pallet — esse fica sempre `0`, pallet nenhum muda ele. O valor de
  verdade mora dentro de `params.PALLET_LAYER` (`height` **e** `layer`) —
  descoberto inspecionando o JSON real da plataforma. Colocar o valor no
  campo de topo faz a plataforma marcar "0cm" mesmo pedindo 8.
- Só o PICKUP leva `params`, o UNLOAD nunca (`params` do UNLOAD é sempre
  `null`).

> ⚠️ **"Pallet de cima" é REVERTÍVEL — pedido explícito do usuário
> (2026-09-02).** A feature (checkbox + alturas configuráveis + sub-seção
> do editor) ainda NÃO foi validada no robô físico. Se der errado nos
> testes, desfazer:
> ```
> git revert ccb9f17        # o commit da feature (tip quando isto foi escrito)
> ```
> Estado ANTES da feature = commit `34c581e`. O revert é limpo:
> - `queue_state.json` com rotas que têm `palletTop`/`palletHeights`: o
>   código revertido só ignora as chaves extras (`_read_queue_state` faz
>   `merged.update`, `_fire_route` chama `robot_create_and_run_route` com 3
>   args). Sem corrupção.
> - `calibration.json` com `palletHeights`: o código revertido ignora a
>   chave; some no próximo save de pontos/lotes. Sem migração.
> - Templates `A1toB2MT8` / `A1toB2MT12C` já criados no robô: viram órfãos
>   (o nome volta a ser `A1toB2MT`), ficam sem uso no dispatch — inofensivo,
>   só clutter. Os `A1toB2MT` antigos voltam a ser reaproveitados.
> Se a feature ficar OK, apagar este aviso.

**Três variantes de PICKUP (2026-09-02, "Pallet de cima"):**
- **madeira** → `params: null`, `height: 0` — não empilha, inalterado.
- **azul, andar de baixo** → `PALLET_LAYER: { height: <blueBase>, layer: 2 }`.
  `blueBase` é configurável (default 8) — campo "Altura do pallet azul
  padrão" no editor.
- **azul, "Pallet de cima"** (checkbox no Ponto a Ponto, `palletTop`) →
  `PALLET_LAYER: { height: <blueTop>, layer: 3 }`. O 2º andar do pallet
  azul de dois níveis; `blueTop` é configurável e SEM padrão de fábrica
  fixo — o valor exibido é sempre o último salvo (o usuário vai calibrar
  em testes). `layer: 3` = "terceiro nível".

**Configuração das alturas** — `calibration.json` ganhou uma chave global
`palletHeights: { blueBase, blueTop }` (ao lado de `top`/`iso`/`occupied`).
- Editada na sub-seção **"Altura de pallets"** do editor (modo
  desenvolvedor), ANTES de "Pontos avulsos" e "Lotes" —
  `PalletHeightsPanel.jsx`. Dois campos, salva no blur (Enter também) via
  `POST /api/pallet-heights` (mutação cirúrgica só dessa chave, sob
  `CALIBRATION_LOCK` — mesmo padrão de `/api/occupied/*`). `_save_calibration`
  (pontos/lotes) **preserva** `palletHeights` do disco, o cliente nem manda
  no snapshot.
- Operador comum (sem modo desenvolvedor) NÃO acessa esses valores — só a
  checkbox "Pallet de cima". Ela some quando "Madeira" está selecionado.
- Leitura tolerante: `_pallet_heights(cal)` / `normalizePalletHeights` dão
  os dois valores mesmo com `calibration.json` antigo (sem a chave). Não
  precisa migração.

**Nome do template codifica a altura** (`robot_route_task_name`), porque a
altura configurável faz o "recipe" mudar e templates são reaproveitados
por nome:
- madeira → `A1toB2`
- azul baixo → `A1toB2MT<blueBase>`   (ex `A1toB2MT8`)
- azul de cima → `A1toB2MT<blueTop>C` (ex `A1toB2MT12C`, `C` de cima)

Isso ORFANOU os templates antigos `A1toB2MT` (sem número) — cada rota azul
recria o template uma vez na 1ª vez após o deploy. Mudar uma altura no
editor tem o mesmo efeito: gera templates novos, os antigos ficam sem uso
no dispatch (raro, ação de admin).

- `palletType` **e agora `palletTop` + `palletHeights`** são capturados no
  ENFILEIRAMENTO (`_queue_enqueue_batch`, guardados no objeto da rota em
  `queue_state.json`) — não relidos depois. Mudar o pallet selecionado ou
  a altura no editor não afeta rota que já está na fila.

**Testado** (stub capturando os payloads de `task-template/create`): as 3
variantes geram nome + `PALLET_LAYER` corretos; `/api/pallet-heights`
persiste; `_save_calibration` preserva; madeira ignora `palletTop`; rota
na fila mantém a altura de quando foi montada mesmo se o admin mudar
depois.

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

## O "ponto de destino fantasma" — robô ignora cancelamento (INVESTIGAÇÃO EM CAMPO 2026-09-11)

**Sintoma:** operador manda uma rota, cancela (LIFTY OU plataforma da
Reeman, tanto faz — as duas batem no mesmo dispatch), e o robô **continua
executando a rota**. Não para com cancelamento de task, não para com
`all-cancel`, **não para com o botão de emergência**, e — testado ao vivo
— **não para com `POST /cmd/cancel_goal`** (retorna `{"status":"success"}`
mas o robô volta a se mover ~2s depois).

**O que de fato acontece (observado + confirmado nos action-records):**
1. A rota tem um PICKUP num ponto que o robô **não consegue alcançar por
   falta de espaço de manobra** ("turning space"). Hoje: pontos **MA, MB,
   DC**. (CC alcança normal, PICKUP em ~25s; MA/MB/DC o robô fica **2 a 4
   minutos** travado tentando.)
2. Enquanto está nesse estado travado, o robô **ignora QUALQUER
   cancelamento** — a task fica `CANCELLED` no dispatch mas ele não recebe
   / não processa.
3. Ele **desiste do PICKUP e vai pro UNLOAD** (confirmado: na task 66814
   o `startTime` do UNLOAD, 05:46:17, é ANTES do `finishTime` do PICKUP,
   05:46:50). Faz um **"unload fantasma" num ponto vazio** (não pegou nada).
4. Depois de "terminar" essa task fantasma e se reposicionar rumo à
   carga, o robô **se recupera sozinho** e volta a aceitar cancelamento +
   emergência normalmente.

**Não é a LIFTY nem o código.** É navegação do robô + calibração dos
pontos MA/MB/DC (pose/ângulo, espaço de manobra, obstáculo, ou mapa
desatualizado perto deles). Todas as tasks `FAILED` de hoje (start=None)
também foram `MAto...`/`DCto...`.

**Agravante — canal robô↔dispatch instável nessa rede:** WiFi pro robô
medido em 32–270ms de ping com jitter enorme e timeouts (HTTP ~700ms). A
maioria dos task-records fica com `start=None` mesmo o robô tendo
executado fisicamente — os eventos de status do robô não chegam no
dispatch. O broker MQTT está no NUC (portas 1883/8883/8083, com auth); o
push de cancelar/parar provavelmente vai por MQTT e **se perde quando a
conexão está ruim**. Infra confirmou: **sem client isolation / firewall**
entre dispositivos na mesma WiFi — então é cobertura/sinal/config de AP,
não filtro. O `standbyPointType: "charge"` do AGV faz o robô voltar pra
carga **sozinho** quando ocioso — isso NÃO é task, cancelamento nenhum
afeta.

**Status de task-record confirmados ao vivo:** `WAITING`, `ASSIGNED`,
`RUNNING`, `FINISHED`, `CANCELLED`, `FAILED`. Só `FINISHED` = sucesso.
`_is_terminal_status` (server.py) cobre os de falha; `WAITING`/`ASSIGNED`/
`RUNNING` contam como "ainda ativa" (correto).

**Confirmado direto no robô (resolve dúvidas antigas):**
- `GET /reeman/current_map` → confirmou `ROBOT_TARGET_MAP` certo nas duas
  vezes que foi checado (era `eecc4a9068e11bd9086538383a38c67d`, agora
  `dbc5b2b4cd6d2505d78fe894403fe2c5` após remapeamento em 2026-09-11 — ver
  "Hash de mapa" acima).
- `GET /project/list` → só projeto `id 13 "APItest"`, `enable=true`.
  `all-cancel/13` mira o projeto certo.
- `GET /agv/page?projectId=13` → `appVersion 1.3.1`, `navigationVersion
  RSNX-v4.1.10`, `mcuVersion S7.0.2`, `versionReportedAt 2026-09-11
  05:10:15` (~hora do restart do robô — pode ter auto-atualizado ao pegar
  internet na rede nova).

**Endpoints SLAM úteis (todos GET, funcionam):**
- `/reeman/speed` → `{"vx","vth"}` — velocidade, sinal confiável de "está
  se movendo".
- `/reeman/pose` → `{"x","y","theta"}`.
- `/reeman/base_encode` → `{"battery","chargeFlag","emergencyButton"}` —
  estado do E-stop físico, bateria, carga.
- `/reeman/nav_status` → `{"res","reason","goal","dist","mileage"}` — MAS
  mostrou `goal=-1` mesmo com o robô a 1 m/s (no estado travado o
  movimento não é nav baseada em goal) → NÃO serve como "está navegando".
- `/reeman/map`, `/reeman/laser`, `/reeman/current_map`.
- `POST /cmd/stop` e `POST /cmd/pause` existem (405 no GET) mas exigem um
  body não-documentado (`{}` dá `error_code 001`).

**Em aberto (usuário lidera a investigação):** por que MA/MB/DC não são
alcançáveis; e como contornar o "cancelamento não pega no estado travado"
— pela LIFTY ou pela plataforma. O `cmd/cancel_goal` no cancel-current /
emergência (server.py) ficou como best-effort: **não resolve o caso
travado** (testado), mas é inofensivo e pode ajudar em navegação normal
(não testado isolado).

### Recuperação de posição perdida ao cancelar — TENTADO E REMOVIDO (2026-09-18)

**Motivação original** (relato do usuário): cancelar uma rota com o robô
no meio do caminho às vezes deixa ele "perdido" — sem achar caminho de
volta pra carga. Relacionado ao "ponto de destino fantasma" acima.

**O que foi tentado**: a partir do PDF do fabricante "REEMAN SLAM WEB API
3.0" (trazido pelo usuário), que decodifica `GET /reeman/nav_status`
(`res`/`reason` — `res=3` + `reason=-6` = "Positioning abnormality", robô
perdeu a localização) e documenta `POST /cmd/reloc_pose` (força
posição/orientação manualmente) — implementei
`robot_stop_navigation_with_recovery()`: capturava a pose antes de
cancelar, conferia `nav_status` depois, e forçava `reloc_pose` de volta
se detectasse `reason=-6`. Só no cancelamento pontual (`/api/queue/
cancel-current`), nunca no loop de emergência (por causa do
`EMERGENCY_POLL_INTERVAL_SECONDS` de 1.5s — um `sleep` ali enfraqueceria
o loop de segurança).

**Por que foi removido** (pedido explícito do usuário, mesma sessão):
testado ao vivo, o cenário real nunca bateu `reason=-6` — a causa raiz de
verdade era outra (ver "Erros estruturados do robô" logo abaixo). Forçar
uma relocalização automática sem confirmação de que é segura é mais risco
do que ajuda (se a pose capturada estiver errada por qualquer motivo, o
`reloc_pose` faria o robô "acreditar" estar num lugar errado). O usuário
julgou que não era mais útil e estava atrapalhando — removido por completo
(`robot_get_pose`/`robot_get_nav_status`/`robot_reloc_pose`/
`robot_stop_navigation_with_recovery`/`_RECOVERY_CHECK_DELAY_SECONDS`,
todos fora do código). `robot_stop_navigation()` voltou a ser só o
`cancel_goal` puro, sem efeito colateral nenhum, usada igual nos 3
lugares de sempre (cancel-current, `_emergency_suppress`,
`_queue_emergency`).

**Fica registrado pra não reinventar**: `GET /reeman/nav_status` E
`POST /cmd/reloc_pose` existem e têm essa forma — só não são o caminho
certo pro problema de "robô parado depois de cancelar". Ver seção
seguinte pro que realmente funciona.

### Erros estruturados do robô — a causa raiz de verdade (CONFIRMADO EM CAMPO 2026-09-19)

**Diagnóstico ao vivo** (usuário cancelou uma rota, robô no meio do
caminho, e deixou parado de propósito pra eu investigar): consultei
`GET /reeman/nav_status` (ficou parado em `res=4`/`reason=0` — cancelamento
limpo, SEM erro, nunca voltou a tentar navegar) e o próprio
`GET /api/reeman-dispatch-service/task-record/page` do dispatch — que
mostrou uma task **`AUTO_SYSTEM` criada sozinha** (o robô TENTOU voltar
pra carga, o mecanismo de "volta pra base quando ocioso" existe e disparou),
mas com **`status: "ASSIGNED"` e `startTime: null`** — atribuída, nunca
efetivamente iniciada. Bate exatamente com o `nav_status` congelado (nunca
saiu de `res=4` pra `res=1`, o que apareceria se a navegação tivesse
começado de verdade).

**A causa, confirmada pelo usuário lendo o aviso na plataforma do
fabricante**: *"Espaço de giro insuficiente no ponto virtual_851 do mapa
dbc5b2b4cd6d2505d78fe894403fe2c5; o AGV não consegue girar ali"* — o
MESMO tipo de limitação física/geométrica já documentada em "O ponto de
destino fantasma" (lá era MA/MB/DC; aqui é um ponto virtual específico no
caminho de volta pra carga). **Não é bug de software, é espaço de manobra
insuficiente num ponto do mapa** — só se resolve fisicamente (liberar
espaço) ou recalibrando o mapa/pontos, nunca por chamada de API.

**Achado valioso, esse sim acionável**: `GET /error/records` (API do
dispatch — documentada em "REEMAN Dispatch Service Third-Party API",
JÁ parcialmente usada nesse projeto pro painel Histórico, ver
`fetchErrorRecords`) devolve o log estruturado de erros do AGV, com
`error` (código curto, filtrável) + `description` (texto, vem em chinês
por padrão — o cabeçalho `Accept-Language` da API de terceiros aceita
`en-US`, não testado ainda se muda o idioma). Confirmados ao vivo:
- **`ROTATE_ERROR`** (nível `DEBUG`) — exatamente o caso acima: espaço de
  giro insuficiente num ponto específico do mapa. Bloqueio físico, sem
  recuperação automática possível — só dá pra AVISAR o operador.
- **`LOCATION_LOST`** (nível `ERROR`) — "AGV desviou da rota"/perdeu a
  localização. Esse SIM é o cenário que a tentativa de `reloc_pose` (acima)
  mirava — só que não foi o que aconteceu no teste de campo. Continua sem
  recuperação automática implementada; pelo menos agora dá pra DETECTAR
  via esse endpoint (mais confiável que inferir pelo `nav_status`).
- **`GENERATE_PATH_UNKNOWN_ERROR`** (nível `DEBUG`) — ver incidente
  completo "AUTO_SYSTEM travado longe de casa" logo abaixo. Categoria
  DIFERENTE do `ROTATE_ERROR`: não é falta de espaço pra girar, é falha
  em GERAR o caminho de volta pra carga quando o robô está fisicamente
  longe da região dos pontos que esse caminho usa como "escada"
  intermediária.

**Ainda não implementado**: usar esse endpoint pra avisar o operador no
tablet em tempo real (a pergunta original desse fio de investigação, "é
possível emitir um aviso pra quando o robô parar por obstáculo?") — a
resposta é sim, via `GET /error/records`, filtrando por `error` novo/não
lido pro AGV em uso. Combinaria bem com `robotWarning` em
`/api/live-state` (mesmo padrão de `robotCharging`/`robotBattery`) e um
banner/toast no app. Não implementado ainda — próxima sessão, se o
usuário confirmar que quer isso.

### Incidente de campo — AUTO_SYSTEM travado longe de casa (2026-09-23)

Descoberto DEPOIS de validar o `check-turn` (ver "Bridge validado de
ponta a ponta"/"Cancelamento adiado até giro seguro" acima) — categoria
de problema DIFERENTE, não relacionada ao `ROTATE_ERROR`/espaço de giro.

**Sintoma**: usuário cancelou uma rota (com o `check-turn` novo já
protegendo — funcionou certo, sem reclamar de giro) longe da área normal
de operação, depois de uma sessão de testes onde o robô foi dirigido
manualmente pra vários cantos do galpão. Sem task, o robô criou sozinho
a `AUTO_SYSTEM` de retorno à carga (`energy_...`) — que ficou **travada**
(`ASSIGNED` sem nunca iniciar, ou `RUNNING` sem nunca progredir),
reaparecendo automaticamente do mesmo jeito a cada vez que era cancelada,
mesmo enviando rotas normais pelo app entre as tentativas.

**Causa raiz, confirmada com dados reais** (não é posição corrompida —
checado com `GET /reeman/pose` vs. `GET /map/point/list/{map}`: o robô
estava genuinamente a só 0.37m do ponto calibrado `HEXA`, localização
ótima): `GET /error/records` mostrou `GENERATE_PATH_UNKNOWN_ERROR`
(nível DEBUG) — *"生成路线失败：... 已偏离当前路线 P3 -> P1，距离路线
24.60m"* ("Falha ao gerar rota: ... desviou da rota atual P3 -> P1,
distância da rota 24.60m") — confirmado por cálculo: `P3` e `P1`
calibrados ficam a ~24-28m da pose real do robô naquele momento. O
retorno automático pra carga usa algum mecanismo de rota em
etapas/grafo (parece tratar P3→P1 como um trecho intermediário
fixo do caminho de volta) que só funciona se o robô estiver
razoavelmente perto dessa região — longe dali, a geração do caminho
falha e a task de retorno nunca sai do papel. **Mecanismo interno da
REEMAN, não documentado nos PDFs que temos, sem controle nosso via API.**

**O mesmo erro já tinha acontecido em 2026-09-19** (26.12m de desvio,
quase idêntico) — ou seja, não tem relação com a feature `reloc_pose`
removida na mesma época (que, pelo próprio commit de remoção, nunca
chegou a disparar de verdade em campo) nem com nada implementado nesta
sessão. É uma característica de como o robô lida com retorno de longa
distância, que só aparece quando ele acaba MUITO longe da área normal —
o que só aconteceu por causa da sessão extensa de testes manuais
(`check-turn`/calibração de pontos), não é esperado na operação normal
do dia a dia.

**Diagnóstico passo a passo** (tudo leitura, direto na API — não
precisou do `server.py`):
1. `GET /reeman/pose` (posição real) vs. `GET /map/point/list/{map}`
   (posição calibrada de cada ponto) — cálculo de distância euclidiana
   confirmou o robô perto de `HEXA` e longe de `P1`/`P3`, batendo com o
   texto do erro quase ao decimal.
2. `GET /task-record/page` mostrou a task `AUTO_SYSTEM` mais recente
   travada (`ASSIGNED`/`RUNNING` sem progresso).
3. `POST /task-record/cancel/{id}` nela (mesmo comando que o próprio
   `server.py` já usa automaticamente pra task de carga órfã) — limpou,
   mas uma nova reapareceu na hora (comportamento esperado, documentado:
   "ao ficar sem NENHUMA task, o robô recria a de carga sozinho").
4. Uma rota normal (`FAST`, ponto-a-ponto de verdade) rodou e terminou
   SEM erro nenhum na mesma área — confirma que a navegação normal
   funciona bem dali, só o mecanismo específico de retorno automático é
   que falha.

**Primeira hipótese testada, DESCARTADA**: dirigir o robô manualmente até
o ponto calibrado `energy` (a base de carga) uma vez pareceu resolver na
hora (a `AUTO_SYSTEM` seguinte terminou em 2s, `FINISHED` limpo) — mas
**não era a causa real**. Confirmado pelo próprio usuário logo depois:
colocando o robô em cima de OUTRO ponto calibrado qualquer (não a base de
carga), a task de retorno automático **continuou travando**. Ou seja,
"estar perto de um ponto conhecido" não era a variável que importava —
foi coincidência de a base de carga, nesse caso, também estar num trecho
sem curva acentuada (ver causa raiz de verdade abaixo).

**Causa raiz de verdade, RESOLVIDO (2026-09-23)**: o caminho entre a
posição do robô e o destino (`P3`/`P1`/o trecho usado pelo retorno
automático) exigia **curvas acentuadas em ângulo pequeno**. O próprio
PDF do fabricante ("SLAM 3.0 API", seção de rota fixa/`list_point`) avisa
disso explicitamente: *"Ensure that the path does not pass through
obstacles or sharp turns at small angles"* — curva fechada demais faz o
algoritmo de geração de rota falhar (exatamente o `GENERATE_PATH_
UNKNOWN_ERROR` visto no log), **não é sobre distância nem localização**.

**Correção aplicada pelo usuário**: simplificou a rota, reduzindo as
curvas acentuadas que o robô precisava fazer pra se locomover naquele
trecho (ajuste de configuração/pontos, fora do `server.py` — não foi
uma mudança de código nosso). Confirmado resolvido em campo.

**Prática recomendada, registrada aqui pra não repetir o susto**: se
`GET /error/records` mostrar `GENERATE_PATH_UNKNOWN_ERROR` (nível
DEBUG, texto tipo "已偏离当前路线... 距离路线 Xm"), **não pensar em
localização/posição perdida primeiro** — checar se o trajeto entre a
posição atual e o destino exige curva fechada em algum ponto, e
simplificar a rota (menos curvas acentuadas) ali. **Diferente do
`ROTATE_ERROR`** (falta de ESPAÇO pra girar no lugar) e diferente de
`LOCATION_LOST` (perda de localização de verdade) — os três aparecem
parecidos ("robô travado sem task") mas têm causas e correções
completamente diferentes. Sempre checar `GET /error/records` primeiro
pra saber qual dos três é, antes de tentar qualquer correção.

### Próxima ideia (AINDA NÃO IMPLEMENTADA) — perguntar "existe rota até X?" antes de despachar

Motivação: o `GENERATE_PATH_UNKNOWN_ERROR` acima só foi descoberto
DEPOIS de já ter travado o robô (via `GET /error/records`, depois do
fato). Seria melhor perguntar ANTES — mesmo espírito do `check-turn`
(pergunta ao vivo em vez de listar pontos seguros na mão).

**Dois candidatos achados no PDF "SLAM 3.0 API"** (mesma camada
serial/ROS do `check:turn_angle`, não expostos na API HTTP que já
usamos):
- **`get_defined_plan[point]`** → `getplan_dij:nofind` (sem rota) ou
  `getplan_dij:path_point1 path_point2...` (rota válida, com os pontos
  do caminho) — específico de **rota fixa**, o modo que parece estar
  por trás do `GENERATE_PATH_UNKNOWN_ERROR` (o texto do erro fala em
  "P3 -> P1" no formato de grafo).
- **`get_plan_name[point]`** / **`get_plan_point[x,y,radian]`** →
  `get_plan:error` (falhou, geralmente obstáculo no destino/caminho) ou
  `get_plan:x1,y1,radian1,...` (rota válida) — planejamento geral, **só
  funciona com pontos que NÃO estão em modo de rota fixa**.

**Próximo passo pra confirmar** (mesma técnica do `check-turn`): na
próxima sessão com SSH no robô, `rostopic list | grep -iE "plan|route|
reachable"` — se aparecer um tópico parecido (padrão já visto:
`/robot_api/turn_check_angle`, `/area_reachable`), estender o MESMO
bridge (`robot-bridge/lifty_turn_check_bridge.py`) com um segundo
endpoint (`/check-route?point=X`, mesmo padrão publish/subscribe do
`/check-turn`) — mesmos cuidados de sempre (script novo/isolado, sem
tocar workspace da REEMAN, ver seção "Cancelamento adiado até giro
seguro" acima). **Ainda não implementado** — combinar com o usuário
antes de partir pra isso.

### Descoberta relacionada (histórico, antes do check-turn existir)

Não existe (ou não achamos — testado e descartado, ver
"Recuperação de posição perdida" acima) uma forma de PERGUNTAR ao robô
"tenho espaço de giro aqui?" antes de agir — só fica sabendo DEPOIS, via
`ROTATE_ERROR`. Em compensação, dá pra saber **de qual ponto calibrado o
robô está mais perto agora**, combinando dois GETs que já sabemos
funcionar: `GET /reeman/pose` (posição ao vivo, `{x,y,theta}`) e
`GET /api/reeman-dispatch-service/map/point/list/{map}` (todos os pontos
de verdade — os mesmos nomes de kanban do app — cada um com
`position: [x,y,theta]`, **mesmo referencial** de `/reeman/pose`,
confirmado ao vivo). Calculando distância euclidiana da pose atual até
cada ponto e ordenando, o mais próximo é uma aproximação confiável de
"onde ele está agora" — testado ao vivo com o robô na base: `energy`
(0.01m) na frente, `PROD` (2.16m) em seguida. **Limitação**: é "ponto mais
próximo por distância reta", não "está exatamente no segmento entre A e
B" — mas é preciso o suficiente pra validação física andando na planta.

### Plano da próxima implementação (definido pelo usuário, 2026-09-19, AINDA NÃO FEITO)

Decisão do usuário depois de todo o diagnóstico acima: em vez de tentar
detectar/evitar `ROTATE_ERROR` via API (não dá, é limitação física do
mapa, não tem "pergunta" pra fazer antes), ele vai **mapear
empiricamente, ele mesmo, quais pontos são seguros pra cancelar** — usando
o app pra andar até perto de cada ponto suspeito e testar na prática se o
robô consegue girar ali.

1. **Usuário define uma lista de pontos "válidos pra girar"** (fora do
   código por enquanto — precisa decidir onde essa lista mora: hardcoded
   em `server.py`? Um campo novo no `calibration.json`, editável pela UI,
   tipo um checkbox "permite cancelar aqui" por ponto/lote? Em aberto,
   discutir na implementação).
2. **Nova condição no cancelamento de tasks** (`POST /api/queue/cancel-
   current`, provavelmente comparando contra o ponto calibrado mais
   próximo da pose atual, técnica confirmada acima): enquanto o robô NÃO
   estiver perto de um ponto da lista "válida", o cancelamento deve
   mostrar a mensagem:

   > **"ESPAÇO DE GIRO INSUFICIENTE: O Robô irá se re-orientar e cancelar
   > sua tarefa."**

   (Formato exato da mensagem já definido pelo usuário — usar literal,
   não parafrasear.) Semântica ainda a esclarecer na implementação: o
   cancelamento ainda acontece (só que avisando que vai levar um
   reposicionamento antes), ou fica bloqueado até o robô chegar num ponto
   válido? Confirmar com o usuário antes de implementar.

**Pré-requisitos técnicos já resolvidos** (ver achados acima, só falta
juntar): `GET /reeman/pose` + `GET /map/point/list/{map}` pra achar o
ponto mais próximo; `GET /error/records` como plano B/complementar pra
confirmar `ROTATE_ERROR` de verdade se quiser validar contra o log em vez
de só a lista pré-definida.

### SUPERADO (2026-09-21) — achamos como perguntar pro robô de verdade, ao vivo, sem lista pré-definida

O plano acima (mapear pontos manualmente, testando cancelamento de
verdade e vendo o robô reclamar) foi **substituído** por algo bem
melhor: o robô tem, de fábrica, exatamente a pergunta "posso girar
aqui?" — só que ela não está na API HTTP que usamos até hoje (dispatch
service / SLAM WEB API), está numa camada mais baixa (ROS, interna ao
computador de bordo). Achamos ela, confirmamos que funciona de verdade
no robô físico, e desenhamos como usar sem depender de lista fixa.

**Acesso obtido**: usuário tem SSH **root** no computador de bordo do
robô, alcançável por **cabo Ethernet** na porta interna
(`192.168.10.2`/`192.168.11.2` — ver `ip_lan`/`enp1s0`/`enp2s0` no SLAM
3.0 API). Robô confirmado rodando **ROS1** (hostname do robô:
`rbot55f-260318-003-001`).

**Descoberta 1 — o comando existe como PAR DE TÓPICOS, não como serviço.**
`rostopic list -v` no robô revelou:
```
/robot_api/turn_check_angle  [std_msgs/Float32]  1 publisher, 1 subscriber
/robot_api/turn_check_ok     [std_msgs/Bool]      1 publisher, 1 subscriber
```
Isso é exatamente o `check:turn_angle[angle]` → `turn_angle_check:x` da
seção "Unique to Forklift" do PDF SLAM 3.0 API, só que exposto como ROS
puro: publica um ângulo (graus, mesmo sinal do doc — positivo esquerda/
negativo direita) em `turn_check_angle`, o robô responde em
`turn_check_ok` (`True` = pode girar, `False` = tem obstáculo). Também
apareceu `/area_reachable [std_msgs/String]`, provável equivalente do
`check:area_reachable[...]` — ainda não testado.

**Validado ao vivo, na mão** (`rostopic pub -1 ... "data: 180.0"` +
`rostopic echo` num segundo terminal), em três situações reais:
- Corredor apertado, robô parado: `False`.
- Área aberta, robô parado: `True`.
- **No meio de uma task real em andamento** (não parado/ocioso): `False`,
  coerente, **sem nenhum efeito colateral aparente na navegação em
  curso** — confirma que a pergunta é mesmo só-leitura/não-invasiva,
  segura de fazer ao vivo, inclusive durante uma rota.

**Descoberta 2 — o computador de bordo é o MESMO que serve o dispatch
service pro tablet.** `ip addr` dentro da sessão SSH:
```
enp1s0: 192.168.10.2/24   (cabo, onde a gente entra)
enp2s0: 192.168.11.2/24   (outra interface interna)
wlp1s0: 192.168.5.195/24  (WIFI — o MESMO IP que ROBOT_HOST usa hoje!)
```
Ou seja: não são dois computadores separados — é uma máquina só, com
uma perna na rede interna (cabo) e outra na wifi do galpão (a mesma que
tablets e `server.py` já usam). Isso muda tudo: **dá pra expor essa
pergunta ao vivo, pela mesma wifi de sempre, sem cabo no dia a dia** —
o cabo só foi necessário pra essa investigação.

**Descoberta 3 — acesso "de fora" (sem tocar na máquina do robô de
jeito nenhum) foi tentado e NÃO funciona hoje**: testamos conectar na
porta do ROS master (11311) de uma máquina externa na mesma wifi
(`socket.create_connection(("192.168.5.195", 11311))`) → **`Connection
refused`**. O ROS master não aceita conexão de fora da própria máquina
— pra isso funcionar precisaria reconfigurar como o `roscore` sobe no
robô, o que é bem mais arriscado que adicionar algo novo e isolado
(mexeria em algo que já está funcionando na navegação de produção).
Opção descartada por enquanto.

**Decisão de arquitetura**: um script Python **standalone, novo e
independente**, rodando na própria máquina de bordo do robô (não numa
máquina externa), que fala com esses tópicos ROS locais (igual o
`rostopic pub`/`echo` que já validamos na mão) e expõe isso como HTTP
simples na wifi (`GET /check-turn?angle=180` → `{"safe": true/false}`).
`server.py` chamaria esse endpoint pela mesma wifi que já usa pra tudo
mais — nenhuma mudança de rede, nenhum cabo, nenhuma dependência nova
no `server.py` em si (ele só passa a fazer mais uma chamada HTTP comum).

**Cuidados inegociáveis, pedidos explicitamente pelo usuário (2026-09-21)
— vale pra QUALQUER sessão futura que mexer nisso**:
- **Nunca** rodar `colcon build`/`catkin_make` em nada.
- **Nunca** editar, sobrescrever ou mesmo depender de arquivo nenhum da
  REEMAN (workspace `catkin_ws` deles, launch files, configuração).
- **Nunca** mexer em systemd, boot, firewall ou rede do robô.
- O script só usa tipos de mensagem **padrão** do ROS
  (`std_msgs.Float32`/`Bool`) — nunca um pacote/mensagem customizada da
  REEMAN.
- É um arquivo **novo e isolado**, fora de qualquer workspace catkin —
  ver `robot-bridge/lifty_turn_check_bridge.py` neste repo (só a
  REFERÊNCIA/fonte; o arquivo de verdade precisa ser copiado pro robô
  via SSH, esse repo não roda automaticamente lá).
- Modo de operação por enquanto: **manual, sob demanda** (SSH, roda em
  primeiro plano, `Ctrl+C` pra parar — nada de systemd/boot automático)
  até decidirem explicitamente tornar permanente, depois de validado.

**Status ao encerrar a sessão de 2026-09-21**: script escrito e
revisado, cópia pro robô **em andamento** (esbarrou num limite de
~4096 caracteres por linha do terminal em modo canônico do Linux — duas
tentativas de transferência falharam de forma inofensiva, sem escrever
nada em disco nem executar nada de verdade, ver raciocínio na sessão;
resolvido quebrando o `base64` em ~10 pedaços de 500 caracteres, cada
um colado como comando separado). **Ainda não confirmado** que o
arquivo chegou íntegro no robô nem que o bridge roda lá de ponta a
ponta — retomar isso primeiro na próxima sessão.

### Bridge validado de ponta a ponta, incluindo acesso remoto pela wifi (2026-09-22)

Sessão seguinte, com o robô ligado de novo. Descobertas e ajustes:

- **Transferência ficou muito mais simples**: o repositório do projeto no
  GitHub é público, então em vez de repetir o esquema de pedaços em
  base64, deu pra baixar direto no robô com `curl -o
  ~/lifty_turn_check_bridge.py
  https://raw.githubusercontent.com/brunosaeger/LIFTYMapper/main/robot-bridge/lifty_turn_check_bridge.py`
  — um comando só, sem risco de cortar no meio. Hash (`sha256sum`)
  conferido igual ao do repo antes de rodar, garantindo integridade.
- **Bug real encontrado e corrigido**: `curl localhost:8091/...`
  funcionava, mas `curl http://192.168.5.195:8091/...` (de outra
  máquina na wifi) voltava "empty reply from server". Causa:
  `BaseHTTPRequestHandler.address_string()` (chamado automaticamente
  por `send_response()`, pra log) faz um **DNS reverso**
  (`socket.getfqdn`) no IP de quem chamou — pra `127.0.0.1` isso
  resolve na hora, mas pra um IP de rede de verdade, numa rede
  industrial sem DNS configurado, trava/falha e derruba a resposta
  ANTES de mandar qualquer byte. Corrigido sobrescrevendo
  `address_string()` pra devolver o IP puro, sem lookup nenhum (ver
  `robot-bridge/lifty_turn_check_bridge.py`, commit `480250a`).
- **Acesso remoto confirmado funcionando de verdade**: depois do fix,
  chamada feita de uma máquina completamente diferente (a de
  desenvolvimento, `192.168.5.191`, mesma wifi) devolveu `200` e o JSON
  esperado. **Essa é a confirmação que faltava**: dá pra usar isso ao
  vivo, todo santo dia, sem cabo nenhum — o cabo só foi necessário pra
  essa sessão de investigação/instalação.
- **Segunda confirmação independente do sinal**: robô estava numa
  posição genuinamente apertada no momento do teste (confirmado pelo
  usuário, olhando o robô ao vivo) — `check-turn` devolveu `false` tanto
  pra 180° quanto pra 10°, coerente com a realidade física. Soma com os
  três testes de ontem (apertado/aberto/mid-task) — o sinal continua se
  mostrando confiável.
- Bridge continua **manual/sob demanda** (rodado via SSH em primeiro
  plano) — ainda não virou serviço permanente, de propósito, até
  decidirem isso explicitamente.

**Próximos passos (nesta ordem, atualizados 2026-09-22)**:
1. ~~Copiar o arquivo pro robô~~ — feito, via `curl` direto (bem mais
   simples que o plano de base64 de ontem).
2. ~~Rodar e testar local + remoto~~ — feito e confirmado funcionando
   dos dois jeitos.
3. **Validar em MAIS pontos reais** (ainda pendente) — especialmente as
   bocas de corredor onde já aconteceu `ROTATE_ERROR` de verdade em
   campo, não só "um aberto, um apertado genéricos". Próxima vez que o
   robô estiver ligado e acessível: mover ele (pelo app, PTP normal,
   sem nada manual) até esses pontos suspeitos e chamar
   `http://<ROBOT_HOST>:8091/check-turn?angle=<graus>` em cada um.
4. Decidir a semântica do cancelamento (bloquear até ficar seguro vs.
   avisar e prosseguir — mensagem literal já definida, ver plano
   2026-09-19 acima) e então integrar no `server.py`: uma função tipo
   `_slam_call`, mas apontando pro bridge (`http://<ROBOT_HOST>:8091/
   check-turn`), chamada em `POST /api/queue/cancel-current` antes de
   cancelar de verdade.
5. Só depois de tudo validado em campo: decidir se o bridge vira
   permanente (systemd) ou continua manual.

### Cancelamento adiado até giro seguro (IMPLEMENTADO 2026-09-22) — SUPERA a ideia de marcar pontos

Decisão final do usuário, depois de todo o caminho acima: **não precisa
marcar ponto/lote nenhum como "seguro pra girar"**. Em vez de decidir de
antemão (lista fixa), o servidor **pergunta ao vivo** pro bridge a cada
vez, e resolve isso sozinho em segundo plano. Bem mais simples que os
planos de 2026-09-19/21 (lista pré-calibrada), que ficam superados por
esta abordagem — o bridge em si (a descoberta do `check_turn_angle`, a
transferência, o fix do DNS reverso) continua sendo o pré-requisito
técnico, só a "lista de pontos seguros" que deixou de ser necessária.

**Comportamento antigo (o problema)**: operador cancela → servidor
cancela a task na hora → se o robô estava num lugar sem espaço pra
girar, ele fica travado tentando se reorientar sozinho (`ROTATE_ERROR`)
até alguém destravar no modo manual — exatamente o que este projeto
existe pra evitar.

**Comportamento novo**: operador cancela → servidor pergunta pro bridge
"posso girar aqui?" (`robot_can_turn_safely()`, 180° — giro de meia-volta,
o cenário de retorno pra carga que motivou tudo isso):
- **Sim** (ou bridge indisponível — `None`, tratado como "não sei",
  mantém o comportamento de sempre em vez de travar um cancelamento só
  porque o bridge não está instalado nesse robô) → cancela na hora, como
  sempre foi.
- **Não** → **não cancela ainda**. Marca `cancelPending=True` no
  `queue_state.json`, devolve a mensagem de espera pro operador, e a
  rota ATUAL continua rodando **normalmente** (nada é tocado nela) — a
  thread de fundo passa a perguntar de novo a cada
  `CANCEL_PENDING_POLL_INTERVAL_SECONDS` (2s, mais rápido que o tick
  normal de 4s) e, assim que a resposta virar "sim", executa o
  cancelamento de verdade sozinha, sem o operador precisar clicar de
  novo. Se a rota terminar por conta própria antes disso (chegou no
  destino normalmente), `cancelPending` é limpo — não sobra nada
  pendente órfão.

**Mensagem literal mostrada ao operador** (`CANCEL_PENDING_MESSAGE`,
pedido explícito do usuário 2026-09-22 — **substitui** a mensagem
"ESPAÇO DE GIRO INSUFICIENTE..." do plano de 2026-09-19, que não chegou
a ser implementada):
> **"Aguarde até o robô chegar a uma posição válida para giro
> seguro..."**

**Implementação (`server.py`)**:
- `TURN_CHECK_PORT`/`TURN_CHECK_PATH`/`TURN_CHECK_ANGLE_DEGREES` (180.0)/
  `robot_can_turn_safely(angle)` — chama `http://<host-do-ROBOT_HOST>:8091/
  check-turn?angle=...` (mesmo host do dispatch, porta do bridge). Devolve
  `True`/`False`/`None` (indisponível).
- `cancelPending` (bool) novo campo em `_empty_queue_state()`/
  `queue_state.json`.
- `_execute_cancel_current_locked(state, current)` — a lógica de
  cancelamento de verdade, extraída pra função própria porque agora tem
  DOIS chamadores: o handler HTTP (giro já seguro na hora do clique) e a
  thread de fundo (giro ficou seguro depois de esperar).
- `_queue_cancel_current` (handler `POST /api/queue/cancel-current`):
  chama `robot_can_turn_safely()` **fora** do `QUEUE_LOCK` (mesma
  cautela de `_emergency_suppress` — chamada de rede lenta não pode
  prender o lock e travar os `GET /api/live-state` de todo mundo); se
  `False`, marca `cancelPending` e devolve `{"ok":true,"pending":true,
  "message":...}`; senão executa o cancelamento normalmente. Clique
  repetido enquanto já pending é idempotente (não faz nada novo).
- `_queue_tick`: antes do tick normal, se `cancelPending`, pergunta de
  novo (fora do lock); se seguro, executa `_execute_cancel_current_locked`
  e volta ao intervalo normal; senão segue o tick normal (Caso 2 etc.,
  a rota continua sendo sondada normalmente) mas devolve
  `CANCEL_PENDING_POLL_INTERVAL_SECONDS` no final.
- `_apply_record_status`: limpa `cancelPending=False` nos dois ramos
  (`FINISHED` e terminal/`CANCELLED`/`FAILED`) — se a rota morreu por
  conta própria, não há mais nada a cancelar.
- `GET /api/live-state` expõe `cancelPending`/`cancelPendingMessage`
  (null quando não pending).
- **Testado** (sem tocar rede/robô real — `robot_can_turn_safely`/
  `_robot_try_cancel`/etc. mockados): giro inseguro → `cancelPending=True`
  e nada cancelado ainda; giro fica seguro depois → cancelamento real
  executado, `cancelPending` limpo; rota termina (`FINISHED`) com
  `cancelPending=True` pendente → limpo sem sobrar órfão. **Ainda NÃO
  testado end-to-end com o robô físico** (o robô não estava disponível
  pra esse teste específico nesta sessão) — fazer isso assim que possível,
  provocando um cancelamento de propósito com o robô num corredor
  apertado de verdade.

**Frontend (`web/src/`)**:
- `hooks/useLiveState.js` — expõe `cancelPending`/`cancelPendingMessage`;
  `cancelCurrent()` agora devolve o resultado (`{ok, pending?, message?}`)
  em vez de void.
- `components/CancelPendingBanner.jsx` (novo) — banner âmbar fixo no topo
  do mapa, mesma família visual do `RobotStatusBanner`/
  `CloseUpStatusBanner`, mostra a mensagem literal enquanto
  `cancelPending` for true. Posição (`top: 16px`) é ponto de partida,
  ajustável ao vivo no tablet como os outros banners deste projeto.
- `components/QueuePanel.jsx` — botão de cancelar da rota em andamento
  troca pra ícone `⏳` (cor âmbar, `.queue-route__cancel--pending`) e
  rótulo "Aguardando giro seguro para cancelar..." enquanto pending;
  continua clicável (idempotente), só a aparência muda.
- `MainApp.jsx` — `handleCancelCurrent` mostra toast diferente se
  `result.pending` (info) vs cancelamento imediato (success).

## Segunda API do fabricante: SLAM WEB API (parcialmente usada agora)

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

### Terceiro PDF do fabricante: "SLAM 3.0 API" (comunicação SERIAL) — achado sobre obstáculo, NÃO confirmado em campo (2026-09-18)

Usuário trouxe um manual mais completo da API do fabricante — mas dessa
vez é a comunicação **serial** (RS232, 115200 baud, entre a placa de
navegação e o computador de bordo), não necessariamente a mesma coisa que
os endpoints HTTP `/reeman/*`/`/cmd/*` acima (que existem, mas não se sabe
ao certo o quanto espelham 1:1 esse protocolo serial — o PDF não é sobre
HTTP). Não está no repo (mesma regra dos outros PDFs do fabricante).

**Achado relevante pra "avisar o operador quando o robô para por
obstáculo"** (pedido do usuário, ainda NÃO implementado — ver decisão
abaixo): existe um relatório nativo `move_status:x`, **diferente** do
`nav_result`/`nav_status` já testado e descartado (aquele é sobre
progresso até o alvo — `state`/`goal`/`dist_to_goal`; mostrou `goal=-1`
mesmo com o robô andando, ver "O ponto de destino fantasma" acima). Os
códigos de `move_status`:
- `3`: não conseguiu planejar a rota (ou `4`, o PDF tem um problema de
  OCR/paginação aqui — os dois "4" aparecem em sequência, um dos dois é
  bug de extração do PDF, não confirmado qual é o certo);
- `4`: há obstáculos no caminho local;
- `5`: reinicia navegação automaticamente se uma navegação única falhar
  (rota fixa);
- `6`: encontrou obstáculo e está começando a contornar (confirmado de
  novo na seção "Navigate given target point name" do mesmo PDF: *"There
  is an obstacle: move_status:6"*).

**Por que não implementei em cima disso ainda**: não há confirmação de
que `move_status` aparece em algum endpoint HTTP que o `server.py` já
consegue ler — o PDF documenta o protocolo serial, e a ponte serial↔HTTP
roda dentro do próprio robô (Android embarcado, ver "Investigação
pausada" acima), fora do nosso controle/visibilidade. Implementar uma
UI de aviso em cima de um campo que talvez nem chegue até nós seria
chute. **Caminho de verificação sugerido ao usuário**: (1) bloquear o
robô de propósito com um obstáculo e observar `GET /reeman/nav_status`
ao vivo — se algum campo (`reason`? outro?) mudar pra um valor
compatível com "obstáculo" nesse momento específico, achamos o link; (2)
se não aparecer em `nav_status`, tentar farejar outros `/reeman/*` ainda
não mapeados (o HTTP API é "parcialmente usada", pode ter mais
endpoints); (3) como último recurso, o app de navegação grava log de
texto em `/storage/emulated/0/forklift_log/AAAA-MM-DD.log` (acessível
por ADB sem fio, já usado na investigação do robô parando sozinho a cada
~10-15m, ver acima) — se `move_status` aparecer nesse log durante um
obstáculo de propósito, dá pra ler o log por fora em vez de expor um
endpoint HTTP novo (mais frágil, mas função enquanto não se acha o
caminho HTTP).

**Decisão pendente com o usuário**: perguntei se ele queria (a) um
heurístico best-effort agora baseado em `/reeman/speed` (vx≈0 por muito
tempo com rota `RUNNING`) — risco real de falso positivo por causa do
comportamento já documentado do robô parar sozinho a cada ~10-15m em
retas longas (descartado como obstáculo naquela investigação, mas não
resolvido) — ou (b) testar em campo primeiro pra achar um sinal de
verdade. A pergunta foi interrompida sem resposta ainda.

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
- **Concorrência de tasks (IMPLEMENTADO 2026-09-18, pedido do supervisor)**
  — preocupação: duas pessoas enviando a MESMA task quase ao mesmo tempo,
  ou uma task cujo pickup/dropoff já está em uso por uma rota em
  andamento/pendente/na fila. **Gap que existia**: `validate_route_chain`
  (Caso 3, acima) só enxerga `occupied` (a calibração) — nunca a fila — e
  `occupied[pickup]` só é liberado quando o PICKUP termina de verdade
  (Caso 2, `_queue_tick`), não no instante em que a rota vira `current`.
  Ou seja: enquanto o robô ainda está a caminho de pegar em `A`, `A`
  continua marcado como ocupado, então uma SEGUNDA rota pro mesmo `A` (ou
  pro mesmo destino de uma rota já na fila) passava pela validação de
  ocupação sem problema nenhum — nada cruzava o pickup/dropoff novo contra
  a fila de verdade. **Fix**: `_active_routes(state)` (junta
  `currentRoute` + `pendingRoute` + `routeQueue`) e
  `_find_route_conflict(pickup, dropoff, active_routes)` (colide se o
  pickup OU dropoff novo bater com o pickup OU dropoff de qualquer rota
  ativa — os 4 jeitos de colidir) rodam **dentro do mesmo `QUEUE_LOCK`**
  que decide os slots logo abaixo, ANTES de despachar qualquer rota do
  lote (uma barra, todas ficam de fora — nunca despacha metade de uma
  sequência pra depois rejeitar o resto). Isso fecha a race de verdade:
  duas requisições concorrentes disputam o mesmo lock, a segunda a entrar
  já vê a rota que a primeira acabou de enfileirar. Rejeita com **409** e
  `{"error": "..."}` nomeando a posição em conflito e quem enviou a rota
  existente (`route["user"]`) — o frontend já mostra isso automaticamente
  como toast (`jsonRequest` em `useLiveState.js` já extrai `data.error` de
  qualquer resposta não-200 e propaga; `handleEnqueueRoute` em
  `MainApp.jsx` já tinha o `catch` mostrando `err.message` — não precisou
  de nenhuma mudança no cliente pra esse aviso aparecer).
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
  emergência**. LIGAR: `robot_stop_navigation()` (`POST /cmd/cancel_goal` —
  API SLAM, o comando que de fato FREIA o robô) + `robot_cancel_all_tasks()`
  (esvazia a fila do dispatch) + esvazia a fila local + liga o flag
  `emergency`. Enfileirar passa a devolver 409. DESLIGAR: só apaga o flag.
  - **BUG DE CAMPO 2026-09-11** — o que motivou reescrever isso: robô no
    meio de um trajeto, usuário cancelou a rota, robô não achou caminho pra
    voltar pra carga e ficou "girando"; TODAS as tasks confirmadas
    `Cancelada` na plataforma do fabricante, e mesmo assim o robô seguiu
    andando e o botão de emergência não parou ele. **Causa raiz: cancelar
    task-record no dispatch só tira o job da FILA — NÃO aborta a navegação
    que já está em curso** (é outra camada de controle, a API SLAM
    `/cmd/*`). O emergency só fazia `all-cancel`, então nunca tocava no
    movimento. **Segundo bug junto**: se o `all-cancel` falhava (engine
    travada → 4xx/5xx), o handler devolvia 502 e **nunca setava o flag** →
    a emergência não engatava, o loop não rodava, o botão não fazia NADA.
  - **Correção**: (1) o emergency agora chama `cancel_goal` (SLAM) além do
    `all-cancel`; (2) o flag **SEMPRE engata**, mesmo que os comandos
    imediatos ao robô falhem — devolve 200 com `warning`, e a thread de
    fundo segue martelando `cancel_goal` + `all-cancel` a cada tick; (3)
    `_emergency_suppress` chama `cancel_goal` em TODO tick (o robô pode
    estar andando por navegação que não é task — recovery, retorno pra
    carga), e só dispara `all-cancel` se há task **não-terminal** ativa
    (usa `_is_terminal_status`, então uma `FAILED` não faz o loop girar à
    toa).
  - **TESTADO NO ROBÔ (2026-09-11)**: `POST /cmd/cancel_goal` existe e
    retorna `{"status":"success"}`, MAS **não parou um robô em movimento**
    no estado travado (voltou a andar ~2s depois). Ver "O ponto de destino
    fantasma" acima. Então o `cancel_goal` na emergência é best-effort —
    pode ajudar em navegação normal (não testado isolado), não resolve o
    robô travado. **Nesse caso, E-stop físico.**
  - Ainda **melhor esforço, não fail-safe** — não substitui o E-stop
    físico. Flag sobrevive a restart. Idempotente sob lock.
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
`points`/`lots`/`view`/`closeUps`. Os componentes-folha (`PointToPointBar`,
`OccupancyPanel`, `FloorPlanCanvas`) não mudaram — já recebiam esses
dados/callbacks só via props. `RouteQueue` foi substituído por `QueuePanel`
(ver "Painel Fila dedicado" abaixo) — a fonte de dados é a mesma
(`currentRoute`/`pendingRoute`/`routeQueue`), só a UI que consome mudou.

### Painel Fila dedicado (IMPLEMENTADO 2026-09-16)

Motivação: a fila de rotas vivia dentro do modo `ptp` (`RouteQueue.jsx`,
apertada na sidebar normal junto do seletor de pickup/dropoff). Virou seu
próprio modo (`queue`), com sidebar mais larga (`.sidebar--queue`, 448px,
~60% maior que a normal — a largura anima com `transition: width 0.3s` no
`.sidebar` base) e botão flutuante próprio (ícone de índice/listagem, ver
"Modos de interação" acima) no lugar do antigo slider vertical de zoom.

`QueuePanel.jsx` (substitui `RouteQueue.jsx`) mostra duas seções, igual
antes: "Rota em andamento" (no máximo uma, nome em **verde vivo**
`--state-success` + barra pulsando indeterminada — `.queue-route__bar-fill`,
animação `queue-bar-sweep`, sem `prefers-reduced-motion` vira pulso de
opacidade em vez de deslizar — não é % real, o robô não expõe progresso
fino) e "Próximas rotas" (tom **âmbar** `--accent-amber`, "standby"). A
LÓGICA de fila/cancelamento/prioridade não mudou nada — é toda do servidor
(ver "Fila de rotas compartilhada" acima), o componente só lê
`currentRoute`/`waitingRoutes` e manda intenções pra cima.

**Seleção clicável** (`selectedQueueRouteId`/`handleSelectQueueRoute` em
`MainApp.jsx`): clicar numa rota da lista de espera isola sua
origem/destino no mapa (`mapPickupNames`/`mapDropoffNames`), substituindo
temporariamente a rota atual em destaque; clicar de novo na mesma (ou na
rota em andamento) volta ao padrão. Se a rota clicada faz parte de um
grupo de "Lotes em sequência" (mesmo `groupId`, só existe quando o
servidor recebeu mais de 1 par — ver `POST /api/queue/enqueue-batch`),
isola o **grupo inteiro** (`selectedQueueGroup` filtra `waitingRoutes` por
`groupId`), não só aquele par. Prioridade de destaque no mapa, em ordem:
seleção do Ponto a Ponto sendo montada > seleção do painel Fila > rota
atual (padrão de repouso). Sair do modo `queue` (qualquer outro botão/aba
— todos passam por `resetSelection()`) zera `selectedQueueRouteId`, então
o mapa volta sozinho a destacar a rota atual.

**BUG DE LANÇAMENTO, corrigido em seguida**: o destaque azul/âmbar
(pickup/dropoff) no mapa era pintado só quando `mode === 'ptp'`
(`markerColors`/`pointMarkerColors`/`pointOccupiedColor`/`lotCellColors`/
`occupiedColor`, todos com esse gate) — resquício de quando só o modo
`ptp` tinha pickup/dropoff pra mostrar. Com o painel Fila, `mode` é
`'queue'` ao clicar numa rota, então `mapPickupNames`/`mapDropoffNames`
chegavam certos no `FloorPlanCanvas` mas o mapa não pintava nada. Fix:
`highlightsRoute(mode)` (`mode === 'ptp' || mode === 'queue'`) substitui o
gate nas 5 funções de cor. Gestos de clique no mapa (`usesHoverGesture`,
crescer no hover, confirmar ao soltar) continuam só em `ptp`/`mark` de
propósito — a seleção no modo `queue` é sempre pela lista na sidebar,
nunca tocando o mapa.

**Notificação** (bolinha vermelha no canto superior esquerdo do botão
Fila, `.queue-toggle__badge`): conta quantas tasks foram solicitadas
(`pairs.length` de cada `enqueueRoutes`, soma todas — não é contagem da
fila em si) desde a última vez que o painel foi aberto; zera em
`handleToggleQueueMode` ao entrar no modo `queue`.

`robot_simulator.py` (novo, raiz do projeto): simulador local da API do
dispatch service do robô (mesmo formato de `ROBOT_HOST`), pra testar
fila/tasks sem o robô físico ligado. Não documentado em detalhe aqui ainda
— ver o arquivo.

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

### A máquina do servidor NÃO PODE suspender (dormir) — descoberto 2026-09-14

Testando no Linux (rodando `server.py` + `npm run dev` pelo terminal),
percebido: quando a máquina entra em **suspensão** (não só a tela apagar —
o SO de verdade dorme), acontecem erros de comunicação com o robô e o
painel chega a ficar **fora do ar**.

**É esperado, dado como o código funciona hoje — não é bug, é física:**
uma máquina suspensa **para o processo inteiro**. A thread de fundo que
sonda o robô (`_start_queue_thread`) para de rodar, o `ThreadingHTTPServer`
para de responder, a placa de rede desliga — não tem código que sobrevive
a isso, porque o processo Python literalmente não executa nem um tick de
CPU enquanto o SO está suspenso. Ao acordar, leva alguns segundos pra rede
reconectar (Wi-Fi reassociar, DHCP renovar) — é nessa janela que aparecem
os erros de comunicação; o painel fica inacessível pros tablets o tempo
inteiro que a máquina esteve dormindo.

**Distinção importante: TELA apagar ≠ SISTEMA suspender.** Só a tela
apagar (o monitor apaga, mas o SO continua rodando) é **inofensivo** — o
`server.py` nem percebe. O problema é especificamente a suspensão
(standby/sleep) do sistema operacional, que para tudo.

**Aconteceria igual no `.exe` do Windows?** Sim — é o mesmo `server.py`
rodando dentro do mesmo processo da GUI tkinter (`packaging/lifty_gui.py`),
não muda em nada só por estar empacotado. Se o Windows da máquina que roda
o `LIFTY.exe` suspender, o mesmo apagão acontece.

**Correção aplicada (2026-09-14):** `packaging/lifty_gui.py` agora chama
`SetThreadExecutionState` (API nativa do Windows, via `ctypes`) quando o
servidor liga, dizendo pro Windows **não suspender o sistema** enquanto o
LIFTY estiver no ar — sem precisar instruir ninguém a mexer nas
configurações de energia manualmente. `prevent_system_sleep(True)` no
`_start()`, `prevent_system_sleep(False)` no `_stop()`/`quit()`. De
propósito **não** usa `ES_DISPLAY_REQUIRED` — deixa a TELA apagar
normalmente (inofensivo, economiza monitor), só bloqueia a suspensão do
sistema. É no-op em qualquer SO que não seja Windows (`sys.platform !=
"win32"`) — não atrapalha rodar em dev no Linux/Mac.

**Máquina de teste Linux atual**: ajustado direto via `gsettings`
(`org.gnome.desktop.session idle-delay 0`,
`org.gnome.desktop.screensaver lock-enabled false`,
`org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type/
sleep-inactive-battery-type 'nothing'`) — persistente, sobrevive a
reboot. Se for notebook, `HandleLidSwitch` em
`/etc/systemd/logind.conf` ainda pode suspender ao fechar a tampa —
ajustar separadamente se for o caso.

**Não precisa instruir ninguém a "deixar a tela sempre ligada"** — isso
é irrelevante (tela apagada não incomoda). O que importa é a máquina não
suspender, e isso agora é automático no `.exe` (Windows) — só a máquina
de teste Linux atual precisou do ajuste manual porque não passa pelo
`lifty_gui.py`.

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



  SETEMBRO 2022
  CANCELAMENTO DE ROTAS: CHECK_TURN APROVADO !!!!!

## Check-turn no início de tarefas (IMPLEMENTADO 2026-09-22, AINDA NÃO VALIDADO EM CAMPO)

Pedido do usuário, depois do check-turn no cancelamento já validado
("Cancelamento adiado até giro seguro" acima): o mesmo risco de
`ROTATE_ERROR` existe também quando uma rota **começa** — não só quando
uma é cancelada. Toda vez que o robô vai passar a se mover pra uma rota
nova (fila estava vazia, rota promovida depois de um término/cancelamento,
ou rota que estava só na fila local e virou a vez dela), ele pode precisar
girar pra encarar o novo pickup, e se não tiver espaço, trava do mesmo
jeito. Pedido explícito: "aceitar" a rota (ela pode continuar chegando na
fila normalmente, sem checar nada) mas só **disparar** ela de verdade pro
robô quando o check-turn (`robot_can_turn_safely()`, mesmo bridge do
cancelamento) disser que é seguro.

**Descoberta de arquitetura que mudou o plano original**: `pendingRoute`
(a "próxima da fila") sempre foi disparada **antecipadamente** no robô —
criada e mandada rodar enquanto a `currentRoute` ainda estava em
andamento, só pra não ter gap nenhum quando a atual terminasse. Isso
significa que o giro físico pra essa próxima rota acontece **sozinho, no
robô**, no instante em que a atual termina/é cancelada — sem nenhuma
chamada nossa naquele momento pra interceptar. Checar giro seguro só na
hora do disparo antecipado não protegia nada de verdade, porque a posição
do robô nesse momento não é a mesma que ele vai ter quando o giro
realmente acontecer. **Decisão (confirmada com o usuário antes de
implementar)**: trocar o disparo antecipado por disparo tardio — toda
rota, `pendingRoute` incluída, agora fica **RESERVADA** (guardada local,
sem `taskName`, nunca tocou o robô) até o exato momento em que precisa
virar `currentRoute` de verdade. Só currentRoute dispara, e só depois do
check-turn liberar. Contrapartida aceita: uma pequena pausa entre rotas
quando o check-turn precisar esperar (em vez do zero-gap de antes) — no
caminho comum (giro já seguro), a pausa é imperceptível, porque o disparo
é tentado imediatamente, sem esperar o próximo ciclo da sondagem.

**Implementação (`server.py`)**:
- `TURN_BLOCKED_START_MESSAGE` — mensagem mostrada ao operador (mesmo
  padrão de `CANCEL_PENDING_MESSAGE`).
- `turnBlocked` (bool) — novo campo em `_empty_queue_state()`/
  `queue_state.json`, análogo ao `cancelPending` mas pro lado de começar.
- **Invariante nova**: só `currentRoute` pode ter `taskName` preenchido.
  `pendingRoute` e itens de `routeQueue` NUNCA têm — são só dados locais
  até a hora de virar `currentRoute`.
- `_fire_route(route)` — perdeu o parâmetro `as_pending` (não faz mais
  sentido: só dispara quem já vai virar `currentRoute` de verdade). Único
  lugar que fala com o robô pra criar uma rota nova.
- `_advance_queue_locked(state)` — virou reorganização PURAMENTE local
  (promove `pendingRoute`/`routeQueue` pra `currentRoute`, sem chamar o
  robô). Antes disparava a nova `pendingRoute` de antemão; agora só
  reserva.
- `_try_dispatch_current()` — a peça nova central. Auto-contida (cuida do
  próprio lock, chamada de rede sempre fora dele) e idempotente: se
  `currentRoute` existe e ainda não tem `taskName`, pergunta
  `robot_can_turn_safely()`; `True`/`None` (bridge indisponível, mesmo
  fail-open do cancelamento) → dispara de verdade; `False` → marca
  `turnBlocked=True` e não faz nada, tenta de novo depois. Chamada em
  TODOS os pontos onde uma `currentRoute` reservada pode aparecer:
  handler de enfileirar (pra manter a resposta rápida no caminho comum),
  handler de cancelar (depois de promover a próxima), e a cada tick da
  thread de fundo (inclusive de novo, no mesmo tick, logo depois de
  detectar FINISHED — pra manter o gap mínimo no caminho comum).
- `_cancel_reserved_current_locked(state, current)` — cancelar uma
  `currentRoute` que ainda nem foi disparada (esperando o check-turn) é
  bem mais simples que cancelar uma de verdade em andamento: nada rodando
  no robô pra frear, então é só remover do estado local e avançar a fila.
  `_queue_cancel_current` detecta esse caso (`current["taskName"]` ausente)
  e usa este caminho em vez do `cancelPending` de sempre (que só faz
  sentido pra rota DE VERDADE em andamento).
- Simplificação em cadeia: como `pendingRoute`/`routeQueue` nunca são
  disparadas antecipadamente, várias chamadas que existiam só pra cancelar
  a `pendingRoute` NO ROBÔ (em `_drop_group_from_queue`,
  `_queue_remove_queued`) deixaram de ser necessárias — viraram remoção
  puramente local, igual já era pra itens da `routeQueue`. A guarda
  "procura e mata uma carga (AUTO_SYSTEM) que apareceu no meio" em
  `_execute_cancel_current_locked` também saiu — hoje isso é resolvido
  pela própria dança de `_fire_route` (achar/cancelar carga ativa ANTES de
  criar a rota nova), que agora roda no momento certo (o disparo de
  verdade), não mais logo após o cancelamento.
- `_get_live_state`: novos campos `turnBlocked`/`turnBlockedMessage`.

**Frontend**: `useLiveState.js` expõe `turnBlocked`/`turnBlockedMessage`;
`MainApp.jsx` reusa o `CancelPendingBanner` existente, mostrando
`cancelPendingMessage || turnBlockedMessage` (nunca coexistem — um só
existe pra rota já disparada, o outro só pra reservada). Não mexi no
ícone `⏳` do `QueuePanel` (cancelar uma rota bloqueada-pra-começar
cancela NA HORA, sem espera nenhuma — mostrar o mesmo ícone de "espera"
ali seria enganoso).

**Testado isolado** (stub completo do robô, sem tocar no robô real nem em
arquivo de produção — script descartável, não ficou no repo): disparo
imediato quando seguro; fica reservado sem chamar o robô quando inseguro,
depois dispara quando libera; término normal (FINISHED) promove e já
tenta disparar a promovida no mesmo tick; cancelar uma reservada não
chama `_robot_try_cancel`/`robot_stop_navigation`; cancelar uma já
disparada mantém o fluxo antigo intacto (chama os dois). `_queue_tick()`
de ponta a ponta também rodou sem quebrar.

**NÃO validado em campo ainda** — usuário vai testar no robô real (mesmo
espírito de validação do check-turn no cancelamento: rodar em pontos
suspeitos de verdade, ver se o comportamento agrada) antes de considerar
isso pronto.

## Retorno pra carga assumido pelo server.py (IMPLEMENTADO 2026-09-23, AINDA NÃO VALIDADO EM CAMPO)

**Incidente que motivou isso**: usuário cancelou uma rota (check-turn liberou
certinho, sem reclamar de giro) — 5 segundos depois, com a fila vazia, a
REEMAN recriou sozinha a `AUTO_SYSTEM` de retorno pra carga (`standbyPointType:
"charge"` no AGV, comportamento nativo, não é task nossa, cancelamento normal
não afeta), que bateu em `ROTATE_ERROR` num ponto `virtual_673` (nó de grafo
interno, não é ponto nosso calibrado) e **travou de verdade** — nada de
auto-recuperação; confirmado pelo usuário que **a única forma conhecida de
destravar é modo manual + levar até a base de carga na mão**, aí ele detecta
carga e volta a aceitar tarefa. Achado no log real do robô
(`GET /error/records`): 6 `ROTATE_ERROR` em pontos `virtual_*` DIFERENTES
(673, 674, 642, 663, 324, 328) em ~3h de teste, intercalados com
`LOCATION_LOST` e `GENERATE_PATH_UNKNOWN_ERROR` — mesma família do incidente
"AUTO_SYSTEM travado longe de casa" documentado antes, só que agora
confirmado que também quebra como `ROTATE_ERROR`, não só `GENERATE_PATH_
UNKNOWN_ERROR`.

**Por que o check-turn não alcança isso**: nosso check-turn (cancelamento E
início de tarefa) só pergunta "posso girar **na minha posição atual**?",
sempre ANTES de agir — e só protege disparos que passam pela NOSSA fila
(`_fire_route`). A `AUTO_SYSTEM` é criada e roteada inteiramente por dentro
da REEMAN, nunca passa pelo `server.py`, e o travamento acontece num ponto
NO MEIO do caminho dela (`virtual_673`), que a gente não tem como prever —
não existe (procurado, não achado) uma forma de perguntar "vou conseguir
girar no ponto X, mais na frente do meu caminho?" — só "posso girar AQUI,
AGORA". Por isso a solução não pode ser "checar antes" (não dá) — teve que
ser "nunca deixar o mecanismo problemático rodar sozinho".

**Por que apostar em task nossa em vez de só reagir ao travamento**: já
documentado antes (mesmo incidente "AUTO_SYSTEM travado longe de casa") que
uma rota NORMAL ponto-a-ponto (`FAST`, a mesma que PICKUP/UNLOAD usam) rodou
**sem erro nenhum** na mesma área onde o retorno automático falhava — sinal
de que o problema é do MECANISMO de roteamento específico do retorno
automático (parece grafo/rota fixa com esses pontos `virtual_*`), não do
espaço físico em si. Apostamos que uma task `CHARGE` nossa, disparada pelo
MESMO mecanismo de dispatch (`task-template` + `task-fast`) que já
comprovadamente funciona bem nessa área, usa esse planejamento normal em vez
do roteamento especial que trava. **Não confirmado em campo ainda** — é uma
hipótese fundamentada, não uma garantia.

**Implementação (`server.py`)**:
- `AUTO_CHARGE_POINT = "energy"` (ponto calibrado da base de carga) /
  `AUTO_CHARGE_TASK_NAME = "LIFTY_AUTO_CHARGE_RETURN"`.
- `robot_create_and_run_charge_task()` — mesmo padrão de
  `robot_create_and_run_route` (task-template + task-fast), só que com UMA
  ação `CHARGE` em vez de PICKUP+UNLOAD. **Forma exata dos params de uma ação
  CHARGE não veio com exemplo nos PDFs do fabricante** (só confirmamos que
  `"CHARGE"` existe no dicionário `GET /action-type/list-all`) — `params:
  None`, mesma aposta já usada pro UNLOAD (que funciona). Se o dispatch
  rejeitar essa forma, a exceção sobe e quem chama tenta de novo no próximo
  ciclo, sem travar mais nada.
- `autoChargeTask` (novo campo em `_empty_queue_state()`/`queue_state.json`)
  — mesmo padrão RESERVADO/DISPARADO de `currentRoute`: `{"taskName": None}`
  enquanto espera o check-turn liberar, `{"taskName": "..."}" depois de
  disparada.
- `_suppress_native_auto_charge()` — acha (`robot_find_active_charge_task_id`,
  já existia) e cancela (`robot_cancel_task_record`) a `AUTO_SYSTEM` nativa
  toda vez que aparece, **EXCETO se `_robot_status_cache["charging"]` já for
  True** (aí já chegou/já está carregando, não mexe em nada). Só fala com o
  robô, roda fora do `QUEUE_LOCK`.
- `_try_dispatch_auto_charge()` — clone de `_try_dispatch_current`, só que
  pra `autoChargeTask` em vez de `currentRoute`: pergunta `robot_can_turn_
  safely()` fora do lock, só dispara (`robot_create_and_run_charge_task`) se
  `True`/`None` (fail-open, mesmo padrão de sempre); se `False`, marca
  `turnBlocked` (MESMO campo do bloqueio de rota — reusa a sondagem rápida
  que já existia).
- `_queue_tick()`: antes de checar status da `currentRoute`, roda em ordem:
  1. `_suppress_native_auto_charge()` (se não carregando);
  2. sob lock, decide se reserva `autoChargeTask` (fila **genuinamente
     ociosa**: sem `currentRoute`/`pendingRoute`/`routeQueue`, e não
     carregando) ou solta ela (chegou trabalho de verdade antes do disparo);
  3. `_try_dispatch_auto_charge()`;
  4. sonda o status da `autoChargeTask` disparada — se terminal (`FINISHED`/
     `FAILED`/etc.), libera o campo pra um próximo período ocioso poder
     tentar de novo (não é rota, não tem Caso 2/pickup/ocupação envolvidos).
- `_try_dispatch_current()` (disparo de rota de verdade): se sobrou uma
  `autoChargeTask` JÁ DISPARADA no meio do caminho, cancela ela (melhor
  esforço) ANTES de disparar a rota nova — trabalho de verdade sempre tem
  prioridade sobre o retorno pra carga.
- `_queue_emergency` (engatar): zera `autoChargeTask` junto com o resto do
  estado.

**Testado isolado** (mesmo estilo do check-turn no início — stub completo,
sem tocar no robô real): fila ociosa + turn seguro dispara a task de carga
nossa; `AUTO_SYSTEM` nativa aparece e é cancelada; enquanto carregando, nem
suprime nem dispara nada; rota de verdade chegando antes do disparo solta a
`autoChargeTask` reservada local; rota de verdade chegando com a
`autoChargeTask` JÁ disparada cancela ela no robô antes de assumir o lugar;
`autoChargeTask` termina (FINISHED) e libera o campo pro próximo ciclo.

**NÃO validado em campo ainda, e com um risco real específico**: a forma dos
params da ação `CHARGE` é uma aposta, não uma certeza confirmada pelo
fabricante. Se estiver errada, o robô pode navegar até o ponto `energy` sem
efetivamente conectar/carregar — enquanto isso, estamos suprimindo o
mecanismo nativo que SABEMOS que conecta direito. **Recomendação: primeiro
teste supervisionado, olhando o robô, confirmando que ele realmente pluga e
`robotCharging` vira `true`** — não deixar rodando sem supervisão numa
primeira sessão.

### Teste de campo 2026-09-23 — resultado misto, dois bugs corrigidos

**Resultado principal confirmado**: o congelamento (`ROTATE_ERROR` sem
recuperação) **não aconteceu mais** — o robô se recarrega corretamente com a
nossa task. A hipótese central (task disparada pelo mecanismo normal de
dispatch evita o roteamento especial que travava) se sustentou no teste.

**Bug 1 — "anda um pouco, para, anda de novo" em loop**: a `autoChargeTask`
terminava (`FINISHED`) e o campo era liberado NA HORA, sem esperar nada. No
tick seguinte (só ~4s depois), com a fila ainda ociosa e `robotCharging`
ainda sem confirmar (o sensor demora um pouco a mais que o status da task pra
atualizar — mesmo atraso de canal já documentado), a gente **redisparava
outra task de carga imediatamente**, interrompendo o encaixe que
provavelmente já estava em andamento de verdade. Sintoma bateu exatamente:
"anda um pouco, para, anda de novo" repetidas vezes.
**Corrigido**: `AUTO_CHARGE_RETRY_COOLDOWN_SECONDS = 30` — depois que a
autoChargeTask termina SEM `chargeFlag` confirmado, `autoChargeRetryAfter`
(novo campo, timestamp) bloqueia uma nova tentativa por 30s. Se `charging`
virar `true` antes disso, o cooldown é limpo na hora (não tem motivo pra
esperar).

**Bug 2 — giro parcial da AUTO_SYSTEM nativa, mesmo com supressão ativa**:
usuário viu o robô "julgar que deveria virar, girar um pouquinho, e parar" —
sintoma de `ROTATE_ERROR` de novo, mesmo com `_suppress_native_auto_charge`
ativo. Causa: a supressão só rodava na cadência normal do tick
(`QUEUE_POLL_INTERVAL_SECONDS`, 4s) — e no incidente de campo que motivou
tudo isso, só levou **5 segundos** entre a `AUTO_SYSTEM` ser criada e travar.
Ou seja, tinha uma janela real onde ela conseguia agir (e girar) antes da
nossa supressão alcançar. **Não é conflito entre duas tasks disputando
controle ao mesmo tempo** (como o usuário suspeitou) — é a nativa tendo
tempo de sobra pra agir sozinha antes da gente notar.
**Corrigido, parcialmente**: `_queue_tick` agora sonda na cadência RÁPIDA
(`CANCEL_PENDING_POLL_INTERVAL_SECONDS`, 2s) sempre que o robô está ocioso e
não carregando (`managing_auto_charge`), reduzindo a janela pela metade.
**Isso não elimina a corrida, só encolhe ela** — não tem como eliminar de
verdade sem um jeito de ser avisado NO INSTANTE que a `AUTO_SYSTEM` nasce
(não existe esse webhook/push na API que temos). Se o giro problemático
acontecer em menos de ~2s da criação, ainda pode escapar.

**Ambos corrigidos no código, testados isolado (stub), AINDA NÃO revalidados
em campo** — próximo teste do usuário deve confirmar se o loop parou e se a
janela de 2s é suficiente na prática.

### Check-turn ignorado em cima do ponto de carga (IMPLEMENTADO 2026-09-23)

Usuário relatou: check-turn parecia estar impedindo tasks NOVAS de começar.
**Confirmado ao vivo** — com o robô fisicamente em cima do `energy`
(pose `25.79, 58.90` vs. calibração do ponto `25.83, 58.89`, mesmo lugar),
chamei `GET :8091/check-turn?angle=180` direto e a resposta foi
`{"safe": false}`. Ou seja: o nicho de encaixe elétrico do ponto de carga é
apertado demais pra um giro completo de 200° — mas a calibração do próprio
ponto (`GET /map/point/list/{map}`) mostra `"mustTurn": false` pra ele,
confirmando que **sair dali não exige girar no lugar**, só andar pra
frente/curva normal. `_try_dispatch_current` estava perguntando a coisa
ERRADA especificamente ali (200° no lugar, quando a saída real nem precisa
disso) — resultado: qualquer task nova enquanto o robô carregava ficava
`turnBlocked` pra sempre, sem nunca liberar sozinha.

**Correção**: em `_try_dispatch_current`, se `_robot_status_cache["charging"]`
for `True` (proxy simples e confiável de "estou em cima do ponto de energia
agora" — só fica `True` carregando de verdade, encostado no ponto), o
check-turn é pulado inteiramente (`safe = True` direto, sem chamar o
bridge). Escopo deliberadamente restrito só a `_try_dispatch_current` — não
mexe no cancelamento nem no `_try_dispatch_auto_charge` (esse já nunca roda
enquanto carregando, por construção).

**Risco aceito conscientemente**: isso confia que TODA saída do ponto
`energy` é segura sem checar — baseado no `mustTurn: false` calibrado e na
observação de que o check-turn ali dava `false` mesmo sem colisão nenhuma
(mesmo padrão de falso-positivo do sensor em espaço apertado já visto no
"Problema 1" — giro barrado por sensor de segurança configurado
conservador, não por falta de espaço de verdade). Se algum dia mudar a
calibração desse ponto especificamente pra exigir giro na saída, esse bypass
precisa ser revisto.

## Caso peculiar relatado (2026-09-23) — robô "ajustando ângulo constantemente" em modo manual, AINDA NÃO REPRODUZIDO com dados

Usuário relatou: em algum momento durante a execução de uma task, colocou o
robô em modo manual, e ele ficou **ajustando o próprio ângulo
constantemente** (sozinho, não por comando do operador) — sem travar de
vez, mas sem progredir normalmente. No fim, o usuário assumiu o controle
manual e mandou ele pra base na mão. **Causa desconhecida** — usuário não
sabe o que pode ter disparado isso.

**Monitor ao vivo montado pra investigar** (script descartável, não ficou no
repo): sonda a cada 1s `reeman/pose` (x,y,theta), `check-turn?angle=180`,
`task-record/page` (task mais recente) e o `queue_state.json` local,
grava tudo em JSONL com timestamp — pensado pra capturar o exato instante
de um episódio desses e correlacionar com o que o `server.py` estava
decidindo ao mesmo tempo.

**Primeira captura (16:26:46–16:30:54, 2026-09-23) NÃO reproduziu o
sintoma descrito** — mas registrou dois achados à parte, guardados aqui
pra referência futura:
1. **`check-turn` oscila `true`/`false` ao longo do tempo MESMO com o robô
   100% parado na mesma posição** (visto às 16:27:02 `true` → 16:27:18
   `false`, zero movimento entre as duas leituras). Confirma que a
   resposta do bridge não é uma função pura da pose — é uma leitura viva
   de sensor, sujeita a variar (obstáculo temporário passando perto,
   ruído do sensor, etc.), mesmo parado.
2. **A `LIFTY_AUTO_CHARGE_RETURN` ficou em `RUNNING`, imóvel (x/y/theta
   idênticos), por mais de 80 segundos seguidos** até o fim da captura,
   sem nunca chegar em `FINISHED` nem se mexer — não chegou a virar o
   sintoma relatado (nenhuma oscilação de `theta` observada), mas pode ser
   o início dele, capturado incompleto (a captura foi interrompida antes
   de eventualmente resolver ou virar o problema descrito).

**Próximo passo**: nova captura em andamento, pedido explícito do usuário
pra tentar pegar o episódio completo dessa vez.

**Atualização, ainda 2026-09-23 — usuário interrompeu a 2ª captura**: robô
começou a fazer um **barulho estranho ("gargarejando") enquanto andava**.
Usuário com medo de ter bugado o robô por causa da mudança no NUC (o
bridge `lifty_turn_check_bridge.py`). Investigação imediata:

- Reli o bridge inteiro — é um cliente ROS **passivo**: publica um
  `Float32` num tópico de CONSULTA (`/robot_api/turn_check_angle`) e
  espera a resposta booleana (`/robot_api/turn_check_ok`). Nunca toca em
  tópico de motor, nunca manda comando de movimento. Fisicamente não tem
  como emitir som — não fala com o driver do motor. Confirmado ainda
  respondendo normal (`curl` único, sem martelar).
- **Suspeito mais plausível, não confirmado**: desde o retorno pra carga
  assumido (seção acima), a frequência de chamadas HTTP/ROS pro
  computador de bordo subiu de ~1x/4s pra até 3-4x/2s sempre que o robô
  está ocioso — tudo rodando no MESMO computador que controla os motores
  em tempo real. Sem SSH pra medir CPU/carga real, não dá pra confirmar
  nem descartar contenção de recurso como causa.
- **Ação por precaução**: revertida a sondagem rápida (2s) que tinha sido
  adicionada pra reagir mais rápido à `AUTO_SYSTEM` nativa (ver bug 2 do
  teste de campo acima) — voltou pro intervalo normal (`QUEUE_POLL_
  INTERVAL_SECONDS`, 4s) enquanto gerencia o retorno pra carga. Custo:
  a janela de reação à `AUTO_SYSTEM` nativa volta a ser maior (~4s em vez
  de ~2s) — aceito temporariamente até isolar a causa do barulho.
- **Teste definitivo ainda pendente, recomendado ao usuário**: parar o
  `server.py` inteiro (zera TODO tráfego nosso pro robô, bridge incluído)
  e ver se o barulho acontece mesmo assim dirigindo o robô por fora do
  nosso sistema (app da REEMAN, modo manual) — só assim dá pra confirmar
  ou descartar de vez se é coisa nossa.

**AINDA NÃO EXPLICADO** — pode não ter relação nenhuma com o software
(desgaste mecânico, motor, algo físico) — usuário avisado que o bridge em
si não tem como causar isso diretamente, só a hipótese de carga/contenção
de recurso é plausível e foi mitigada por precaução.

**Resolução do barulho**: usuário reiniciou o robô e o barulho sumiu — causa
raiz não identificada, não necessariamente relacionada ao software (pode
ter sido qualquer coisa física/mecânica que um reboot também "resolveria").
Combinado deixar de lado até acontecer de novo, sem investigar mais por
enquanto.

## Bridge morre se a sessão SSH cair (descoberto 2026-09-23) — usar `nohup`

Depois de reiniciar o robô (pro barulho estranho acima), o usuário subiu o
bridge de novo via SSH (`python3 lifty_turn_check_bridge.py`, do jeito
documentado) e, em seguida, **desconectou o cabo do SSH**. Resultado:
`check-turn` parou de responder — `curl` na porta 8091 dava **"Connection
refused"** (não timeout — porta fechada de vez), enquanto o dispatch
service do robô (porta 80) continuava respondendo normal. Ou seja: só o
bridge morreu, o robô em si estava saudável.

**Causa**: o bridge roda em **primeiro plano** na sessão SSH, sem
`nohup`/`screen`/`tmux` (assim de propósito, documentado como "manual, sob
demanda"). Fechar a sessão SSH — inclusive só desconectando o cabo, sem
`Ctrl+C` nenhum — manda um `SIGHUP` pro processo em primeiro plano, que
morre junto com a sessão. Isso é comportamento padrão de shell, não bug do
script.

**Correção**: documentado no próprio `robot-bridge/lifty_turn_check_bridge.py`
— se for deixar a sessão sem supervisionar (ou desconectar de propósito),
subir com `nohup`:
```
nohup python3 lifty_turn_check_bridge.py > bridge.log 2>&1 &
```
Isso sobrevive à queda da sessão SSH, mas **continua sendo "manual, sob
demanda"** — não virou systemd, não inicia sozinho no boot, e ainda precisa
ser morto na mão (`pkill -f lifty_turn_check_bridge`) quando quiser parar
de verdade. Só resolve a morte ACIDENTAL por desconexão.

**Diagnóstico rápido pra próxima vez que "check-turn parou de funcionar"**:
`curl http://192.168.5.195:8091/check-turn?angle=180` — se der "connection
refused", o processo morreu (precisa subir de novo via SSH); se der
timeout, é problema de rede/rota; se responder normal mas com valores que
não fazem sentido, aí sim investigar a lógica. `server.py` não precisa
reiniciar nesses casos — ele não guarda cache de disponibilidade do
bridge, chama `robot_can_turn_safely()` do zero a cada vez.

## Sondagem rápida (2s) RE-ATIVADA (2026-09-24) — travamento real de campo confirmou o risco da reversão

Depois de subir o bridge de novo (via `nohup`, ver seção acima), usuário
reproduziu o MESMO travamento do incidente original — dessa vez no
`virtual_676`. Diagnóstico com dados reais do robô (`error/records` +
`task-record/page`), timeline exata:

```
07:42:52  usuário cancela a rota EXFtoEXF2MT7 (check-turn aprovou certo)
07:42:57  AUTO_SYSTEM nativa (energy_...) nasce sozinha, fila vazia
07:43:02  ROTATE_ERROR no virtual_676 -- 5s depois de nascer
07:43:04  nossa supressão só alcança agora -- 7s depois, 2s TARDE DEMAIS
```

Confirma exatamente o "Bug 2" já diagnosticado no teste de campo de
2026-09-23 (ver seção acima) — a sondagem normal de 4s (revertida naquele
dia por precaução com o barulho estranho no robô) deixa uma janela real
onde a `AUTO_SYSTEM` nativa nasce, tenta girar e trava ANTES da nossa
supressão conseguir reagir.

**Decisão do usuário, explícita, depois de pesar o trade-off**: o barulho
estranho sumiu só com um reboot do robô — causa raiz nunca confirmada,
pode não ter relação nenhuma com a frequência de sondagem. O risco de
congelamento (o problema central que todo esse projeto existe pra evitar)
é concreto, recorrente, e mais grave. **Re-ativada a sondagem rápida
(`CANCEL_PENDING_POLL_INTERVAL_SECONDS`, 2s) enquanto o robô está ocioso e
não carregando** — mesmo código que tinha sido revertido em 2026-09-23,
restaurado.

**Continua sendo mitigação, não eliminação**: não existe (procurado, não
achado) uma forma de ser avisado no INSTANTE que a `AUTO_SYSTEM` nasce —
só sondagem periódica. 2s encolhe a janela pela metade, mas se o giro
travar em menos de ~2s da criação, ainda escapa. Se acontecer de novo
mesmo com a sondagem rápida, o próximo passo é reconsiderar se vale a pena
manter esse método (retorno pra carga assumido) ou reverter pro
`f244ca9` (só o cancelamento adiado, sem esse jogo de corrida com a
AUTO_SYSTEM) — combinado com o usuário como alternativa em aberto.

## obs_3d ligado/desligado durante o giro inicial pra energia (IMPLEMENTADO 2026-09-24, AINDA NÃO VALIDADO EM CAMPO)

**Novo sintoma relatado**: com o check-turn dando aval e a task de ir pra
`energia` disparando, o robô às vezes gira poucos graus, para, tenta de
novo, e fica **em loop de ajuste de ângulo sem nunca completar o giro nem
travar de vez** (variante do congelamento original — antes ele travava
seco, agora fica reiniciando a tentativa). Hipótese do usuário: o sensor de
obstáculo 3D (câmera de profundidade) está configurado sensível demais
naquele ponto específico — o `check:turn_angle` confirma que o MAPA
ESTÁTICO tem espaço, mas o sensor AO VIVO trava o giro mesmo sem colisão
real (mesmo padrão de falso-positivo já discutido no "Problema 1" bem
antes nessa conversa).

**Descoberta ao vivo** (`rostopic list -v | grep -iE "obs|avoid|3d"`, via
SSH): `/robot_api/set_obs3d_switch [std_msgs/Bool]` — mesmo namespace
oficial `/robot_api/*` do `turn_check_angle` já validado, tipo de mensagem
padrão, publisher único (sem par de confirmação como o turn_check tem —
é só um "liga/desliga", não precisa esperar resposta). Batia exatamente com
o `obs_3d[on/off]` documentado no `SLAM+3.0+API-en.pdf` ("Unique to
Forklift" — bate com nosso robô). Também apareceram `/robot_api/
set_avoid_switch` [Float32] e `/robot_api/set_obs3d_param` [Int32]
(candidatos a `avoid_obstacle`/`avoid:distance`, não usados por enquanto)
e `/avoid_distance` [`yoyo_msgs/AvoidDistance`] — esse último é tipo de
mensagem CUSTOMIZADO da REEMAN, então descartado de propósito (viola a
regra de só usar tipos padrão do ROS no bridge).

**Duas condições inegociáveis, pedidas explicitamente pelo usuário
2026-09-24**:
1. Nunca desligar de forma permanente — sempre religar sozinho.
2. Nunca alterar arquivo nenhum do robô da REEMAN.
3. (Adicionada durante a implementação, também exigida pelo usuário) — o
   check-turn só vale pra posição EXATA onde foi perguntado; se o robô se
   mexeu entre a pergunta e o disparo de verdade, a resposta não pode ser
   usada — precisa perguntar de novo.

**Implementação**:
- `robot-bridge/lifty_turn_check_bridge.py` — novo endpoint `GET
  /obstacle-3d?on=1|0`, publica `Bool` em `/robot_api/set_obs3d_switch`,
  sem lock (publish simples, sem corrida possível). Commitado e pushado
  isolado (`b8d6188`) pra continuar baixável via `curl` do raw GitHub, sem
  tocar no resto do trabalho em andamento (`server.py` continua sem
  commit, mantendo a opção de reverter tudo pro `f244ca9`).
- `server.py`:
  - `_set_obs3d_switch(on)` — chama o endpoint novo, fail-open (melhor
    esforço, só loga se falhar).
  - `robot_pose()` — `{x,y,theta}` via `/reeman/pose` (SLAM WEB API, já
    alcançável sem bridge).
  - `_poses_match(a, b)` — confirma posição igual dentro de uma tolerância
    (`OBS3D_POSITION_MATCH_TOLERANCE_METERS`=0.15m,
    `OBS3D_POSITION_MATCH_TOLERANCE_DEGREES`=5°).
  - `_dispatch_charge_task_with_obs3d_bracket()` — desliga o sensor,
    dispara a task, sonda `robot_pose()` a cada 0.5s até `theta` ficar
    estável por 2 leituras seguidas (giro terminou) OU até
    `OBS3D_DISABLE_MAX_SECONDS` (teto de segurança, 15s) — religa no
    `finally`, SEMPRE, mesmo se o disparo falhar ou a leitura de pose
    falhar no meio do caminho.
  - `_try_dispatch_auto_charge()`: captura `robot_pose()` ANTES do
    check-turn e de novo bem antes do disparo de verdade; se as duas
    leituras não baterem (`_poses_match`), descarta a resposta do
    check-turn e devolve `False` — o próximo ciclo pergunta tudo de novo do
    zero. Só chama o bracket acima quando a posição foi confirmada igual.
    Como o bracket pode levar até 15s de verdade, o disparo agora acontece
    FORA do `QUEUE_LOCK` (antes era uma chamada rápida, dentro do lock) —
    se chegar trabalho de verdade nesse meio-tempo, a `autoChargeTask`
    (já criada no robô) é cancelada em vez de rastreada (trabalho real tem
    prioridade).

**Escopo deliberadamente restrito**: só a rota de retorno pra `energia`
(`_try_dispatch_auto_charge`) passa por esse bracket — rotas normais
(`_try_dispatch_current`) NÃO desligam sensor nenhum, porque esse sintoma
nunca foi visto nelas.

**Testado isolado** (stub completo): posição igual → dispara normal, obs3d
desliga antes e religa depois do disparo; posição mudou → aborta sem tocar
no sensor nem criar task nenhuma; falha no disparo → sensor religa mesmo
assim (garantia do `finally`); rota real chega durante o bracket → a
charge task órfã (já criada no robô) é cancelada em vez de ficar
rastreada.

**AINDA NÃO VALIDADO EM CAMPO** — bridge commitado/pushado, falta o
usuário baixar a versão nova no robô (`pkill` + `curl` + `nohup`, ver
instruções de redeploy) e testar no ponto exato onde o sintoma apareceu.

## Dois bugs de campo (2026-09-24) — aviso preso no tablet + AUTO_SYSTEM oscilando

Usuário reproduziu o congelamento de novo, num ponto diferente. Dados reais
(`error/records` + `task-record/page`) mostraram 10 tasks `AUTO_SYSTEM`
nativas criadas e canceladas em ~30 segundos (08:26:47–08:27:14) — **zero**
`LIFTY_AUTO_CHARGE_RETURN` no período. `queue_state.json` preso com
`turnBlocked: true`, `autoChargeTask: {"taskName": null}`.

**Bug 1 (corrigido) — aviso "aguarde" preso no tablet mesmo depois do robô
chegar na carga**: se `autoChargeTask` fica RESERVADA (sem taskName,
esperando o check-turn) e `charging_now` vira `True` nesse meio-tempo
(usuário levou o robô na mão), o código antigo não tinha nenhum ramo que
tratasse esse caso — nem o "idle sem carregar" nem o "chegou trabalho real"
disparavam. Resultado: `autoChargeTask` continuava reservada pra sempre,
`_try_dispatch_auto_charge` continuava tentando check-turn bem em cima do
nicho apertado da base de carga (onde ele SEMPRE dá `false` — mesmo motivo
do bypass em `_try_dispatch_current`), e `turnBlocked` nunca saía de `true`.
**Corrigido**: bloco de gerência do retorno pra carga em `_queue_tick`
reestruturado — sempre que `charging_now` é `True`, solta a reserva, limpa
o cooldown, e limpa `turnBlocked` (só se `idle` também for `True`, pra
nunca mexer no bloqueio de uma rota de verdade por engano).

**Bug 2 (identificado, NÃO corrigido — decisão em aberto) — AUTO_SYSTEM
"oscilando" enquanto nossa task espera**: enquanto `autoChargeTask` fica
travada esperando check-turn (`turnBlocked=true`), a `AUTO_SYSTEM` nativa
continua nascendo (a fila está genuinamente vazia) e
`_suppress_native_auto_charge` cancela ela incondicionalmente, sem olhar
se é seguro ou não. Cada ciclo nasce → começa a girar um pouco → é
cancelada → nasce de novo — visualmente é exatamente o "ajustando ângulo e
inicializando task em loop" que o usuário descreveu. Diferente do
congelamento original (que travava e ficava parado pra sempre), esse é um
looping ativo — mecanicamente diferente, mas igualmente exige intervenção
manual.

**Por que não é simples de corrigir**: o check-turn está dizendo a verdade
— não tem espaço pra girar ali, nem pra AUTO_SYSTEM nem pra nossa task.
Parar de suprimir a AUTO_SYSTEM quando `turnBlocked` está ativo volta a
arriscar o congelamento ORIGINAL (ela pode travar de vez, sem
autorrecuperação, como no primeiro incidente). Continuar suprimindo
incondicionalmente é o que causa a oscilação. Nenhuma das duas é
claramente melhor — é uma escolha de qual comportamento incomoda menos,
em aberto com o usuário.

**Ideia ainda não avaliada**: `check:turn_angle` sempre pergunta por
180° (`TURN_CHECK_ANGLE_DEGREES`, fixo) — o pior caso, mesmo que o giro
necessário de verdade pra virar rumo à energia seja bem menor. Calcular o
ângulo REAL necessário (bearing até o ponto `energy` calibrado, a partir
da pose atual) e checar esse ângulo específico em vez de sempre 180° podia
desbloquear pontos onde um giro parcial seria seguro mesmo quando o giro
completo não é. Não implementado ainda — precisa validar se isso faz
sentido com o usuário antes.

**IMPLEMENTADO 2026-09-24** — usuário escolheu essa opção pro Bug 2 (em vez
de parar de suprimir a AUTO_SYSTEM, ou manter suprimindo sempre):
- `robot_find_point_position(name, target_map)` — busca a posição
  calibrada `{x,y}` de um ponto via `GET /map/point/list/{map}` (dispatch
  service). `None` se não encontrar/der erro — quem chama cai pro
  comportamento conservador.
- `_required_turn_angle_degrees(pose, target_x, target_y)` — calcula o
  ângulo de giro (graus, mesma convenção do `check:turn_angle`: positivo
  esquerda, negativo direita) a partir da pose atual até um ponto, via
  bearing (`atan2`) menos o heading atual, normalizado pra (-180, 180].
- `_try_dispatch_auto_charge()`: em vez de sempre checar
  `TURN_CHECK_ANGLE_DEGREES` (180°, pior caso fixo), calcula o ângulo real
  necessário pra virar rumo ao `energy` a partir da pose capturada no
  início da função, e checa ESSE ângulo. Se não conseguir calcular (ponto
  não encontrado, erro de rede, pose indisponível), cai pro 180° de
  sempre — nunca assume um ângulo menor sem confirmar de verdade.

**Testado isolado**: matemática do ângulo (ponto à frente/atrás/esquerda/
direita, sempre normalizado em (-180,180]) e integração (usa o ângulo
calculado quando consegue achar o ponto; cai pro 180° quando não consegue).

**AINDA NÃO VALIDADO EM CAMPO** — precisa reproduzir o Bug 2 de novo (ou
achar um ponto parecido) e confirmar se o ângulo real de fato costuma ser
menor que 180° nesses casos, e se isso realmente evita a oscilação da
AUTO_SYSTEM.

## Retorno pra carga assumido pelo server.py — REMOVIDO (2026-09-24)

**Motivo**: usuário reproduziu o Bug 2 de novo mesmo com o ângulo real
implementado — dados reais confirmaram 15 tasks `AUTO_SYSTEM` nativas
criadas/canceladas em 80 segundos (08:45:53–08:47:13) antes da nossa
`LIFTY_AUTO_CHARGE_RETURN` finalmente conseguir disparar (08:47:13). Ou
seja: o cálculo do ângulo real ajudou a eventualmente destravar, mas não
evitou os 80 segundos de robô "gaguejando" (girando um pouco, parando,
tentando de novo) antes disso — a oscilação em si continuou sendo o
problema visível/disruptivo. Usuário: "eu me lembro dele estar funcionando
melhor sem essa mudança" — decisão de **remover a feature inteira** e
voltar a deixar a `AUTO_SYSTEM` nativa em paz (comportamento de antes de
2026-09-23), aceitando o risco original de congelamento seco em vez do
risco de oscilação contínua introduzido por tentar suprimir/substituir ela.

**O que foi removido de `server.py`** (tudo o que existia desde "Retorno
pra carga assumido pelo server.py" até "obs_3d ligado/desligado" e
"ângulo real" acima, seções inteiras deste documento hoje ficam só como
histórico do que foi tentado e por que não funcionou):
- Constantes: `AUTO_CHARGE_POINT`, `AUTO_CHARGE_TASK_NAME`,
  `AUTO_CHARGE_RETRY_COOLDOWN_SECONDS`, todas as `OBS3D_*`.
- Funções: `_set_obs3d_switch`, `_obs3d_switch_url`, `robot_pose`,
  `_poses_match`, `robot_find_point_position`,
  `_required_turn_angle_degrees`, `_dispatch_charge_task_with_obs3d_bracket`,
  `robot_create_and_run_charge_task`, `_suppress_native_auto_charge`,
  `_try_dispatch_auto_charge`.
- Campo `autoChargeTask`/`autoChargeRetryAfter` em `_empty_queue_state()`/
  `queue_state.json`.
- O bloco inteiro de gerência do retorno pra carga dentro de `_queue_tick`
  (supressão + reserva/disparo + sondagem de status + cooldown +
  `managing_auto_charge` no cálculo do intervalo rápido).
- O cancelamento da `autoChargeTask` órfã dentro de `_try_dispatch_current`.
- A limpeza de `autoChargeTask` no `_queue_emergency`.

**O que foi MANTIDO, de propósito**:
- `robot-bridge/lifty_turn_check_bridge.py` continua com o endpoint
  `/obstacle-3d` (commit `b8d6188`, já pushado) — não faz mal nenhum ficar
  ali disponível e sem uso; economiza a descoberta via `rostopic list -v`
  se algum dia isso for retomado.
- A instrução de usar `nohup` pra subir o bridge (sobrevive à queda da
  sessão SSH) — problema real, independente dessa feature.
- Check-turn no cancelamento (`f244ca9`, a base original).
- Check-turn no início de rotas reais (`_try_dispatch_current`/
  `_cancel_reserved_current_locked`), incluindo o bypass durante
  `_robot_status_cache["charging"]` (ainda relevante: uma rota real pode
  ser despachada com o robô em cima do `energy`, carregado pela
  `AUTO_SYSTEM` nativa de novo).

**Testado isolado**: suite completa re-executada confirmando que o que
ficou (disparo de rota nova, `turnBlocked`, bypass durante carga,
cancelamento de rota em andamento, tick com fila vazia) continua
funcionando sem nenhum resquício do campo `autoChargeTask` no estado.

**Estado da fila no robô agora**: idêntico ao que era antes de
2026-09-23 — `AUTO_SYSTEM` nativa nasce e morre sozinha, sem nossa
interferência nenhuma, com o risco de congelamento seco (`ROTATE_ERROR`
sem autorrecuperação) que motivou tudo isso desde o início. **Não
resolvido** — só decidido que, entre os dois males conhecidos
(congelamento seco vs. oscilação), o primeiro incomoda menos por enquanto.

## Varredura ao vivo: check-turn e ROTATE_ERROR são cálculos INDEPENDENTES (2026-09-24)

Usuário pediu uma varredura via SSH enquanto o robô estava travado de novo
no MESMO ponto do primeiro incidente (`virtual_673`). `rosnode info
main_forklift_node` revelou:
- Esse nó SUBSCREVE `/robot_api/turn_check_angle` e PUBLICA `/robot_api/
  turn_check_ok` — ele é quem calcula a resposta do nosso check-turn.
- Também subscreve `/robot_api/set_obs3d_switch` e `/avoid_distance`.
- Mas é um nó **separado** do `/move_base` (o motor de navegação de
  verdade, com o `TebLocalPlannerROS` já mapeado em sessão anterior).

**Testado ao vivo, com o robô parado no ponto**: `check-turn` respondeu
`safe: true` em TODOS os ângulos testados (180°, 90°, -90°, 45°, -45°,
20°, -20°) — e mesmo assim a task trava com `ROTATE_ERROR` nesse ponto.
Desligar o `obs3d` de propósito (com a task ainda ativa) **não teve efeito
nenhum** — task continuou `ASSIGNED`/`start:None`, pose não mudou,
nenhuma nova tentativa registrada.

**Conclusão**: `check-turn` (calculado pelo `main_forklift_node`, usando
scans/`avoid_distance`/`check_scan1_obstacles`) e o `ROTATE_ERROR` de
verdade (quase certamente do `/move_base`/`TebLocalPlannerROS`, usando o
costmap local alimentado pelos lidars `/scan`/`/scan2`) são **cálculos
genuinamente independentes**, de nós diferentes. Isso explica de vez por
que o check-turn pode dizer "seguro" com confiança e a navegação discordar
na hora de executar — nunca estavam calculando a mesma coisa. `obs3d` só
afeta o cálculo do `main_forklift_node`; não tem influência nenhuma no que
o `move_base` realmente usa pra decidir se o giro cabe.

**Pergunta de acompanhamento do usuário** ("obs3d é uma câmera? pode ter
zoado a calibração de pallet?"): não — `lx_camera_pallet_node` (câmera de
reconhecimento de pallet) é um nó ROS **totalmente separado**, nunca
recebeu comando nenhum nosso. `set_obs3d_switch` é um Bool ligado/desligado
num processo já rodando — não reinicia câmera, não mexe em calibração
salva em disco, não persiste nada. Sensor já foi religado antes de
qualquer teste posterior.

**Alavanca mais funda, cogitada e descartada**: `/move_base/local_costmap/
obstacle_layer/enabled` via `dynamic_reconfigure` afetaria de verdade o
`ROTATE_ERROR` (é a fonte real), mas desligar isso cega o robô pra
QUALQUER obstáculo, em QUALQUER movimento — não só durante o giro, e não
só uma câmera secundária como o `obs3d`, é a proteção principal (lidar)
inteira. Descartado por risco desproporcional; usuário optou por corrigir
via calibração/rota física em vez disso (mesmo caminho que já resolveu o
`GENERATE_PATH_UNKNOWN_ERROR` antes).

## Destravamento manual do ROTATE_ERROR via `cmd/turn` (IMPLEMENTADO 2026-09-24, baseado em validação de campo do usuário)

**Achado de campo do usuário, decisivo**: girar o robô manualmente (modo
manual, ~180°) nesses pontos travados **sempre destrava a navegação**,
mesmo com o check-turn já tendo validado o giro antes de travar — combina
com a descoberta acima (o travamento é do `/move_base`, não falta de
espaço real). Usuário pediu pra automatizar exatamente essa correção
manual, incluindo um refinamento importante: **alinhar com o ÚLTIMO NÓ
CALIBRADO que o robô percorreu, não com o destino final**. Exemplo do
usuário: "robô parou entre HCD -> P15, sentido P15, ele deve se alinhar
com o HCD" — a orientação da ARESTA do grafo fixo (refletida no `theta`
calibrado dos nós) é o que importa pra estar "alinhado com a rota", não um
rumo em linha reta até um destino distante (que pode apontar pra qualquer
direção, sem relação com a aresta local).

**Aproximação prática adotada**: como o `ROTATE_ERROR` não informa quais
dois nós formam a aresta onde o `virtual_NNN` travou (diferente do
`GENERATE_PATH_UNKNOWN_ERROR`, que menciona os dois, ex: "P16 -> HCD"), a
solução foi achar o **ponto calibrado MAIS PRÓXIMO** da posição atual do
robô (`GET /map/point/list/{map}`, já alcançável sem bridge) — como as
arestas do grafo fixo costumam ser curtas, o ponto mais próximo tende a
ser uma das duas pontas da aresta onde o robô travou — e usar o `theta`
**próprio** desse ponto (já calibrado com a orientação da aresta) como
ângulo alvo, em vez de calcular um rumo até ele.

**Implementação (`server.py`)**:
- `robot_fetch_recent_error_records(size)` — `GET /error/records`.
- `robot_pose()` — `{x,y,theta}` via `/reeman/pose` (sem bridge).
- `robot_find_nearest_point(pose, target_map)` — `{name,x,y,theta}` do
  ponto calibrado mais próximo, via `/map/point/list/{map}` (sem bridge).
- `_normalize_angle_degrees(delta_radianos)` — normaliza uma diferença de
  ângulo pra graus em (-180, 180].
- `_last_handled_rotate_error_id` (dict em memória, não persistido —
  reinício do servidor só reseta essa otimização) — evita reagir à MESMA
  ocorrência de erro duas vezes.
- `_recover_from_rotate_error_if_stuck()`: detecta um `ROTATE_ERROR` novo
  → cancela a task travada (`robot_find_active_charge_task_id` +
  `robot_cancel_task_record`) → freia navegação (`robot_stop_navigation`)
  → lê pose → acha o nó calibrado mais próximo → calcula o ângulo até o
  `theta` dele → confirma com `robot_can_turn_safely(angle)` **exigindo
  `True` explícito** (diferente do resto do sistema — aqui estamos
  comandando movimento ativamente, "não sei" não é suficiente pra agir) →
  manda `POST /cmd/turn` (SLAM WEB API, já alcançável sem bridge) com
  `direction`/`angle`/`speed=0.3 rad/s` (moderado, começa devagar).
- Chamada em `_queue_tick`, logo após o tratamento de emergência, só
  quando a fila está genuinamente ociosa e o robô não está carregando
  (todo `ROTATE_ERROR` observado até agora foi da `AUTO_SYSTEM` nativa
  indo pra carga).

**Testado isolado** (8 cenários, stub completo): dispara giro quando
seguro; não repete pro mesmo erro; NÃO gira se `check-turn` disser `False`
OU `None` (exige `True` explícito); ignora erros que não são
`ROTATE_ERROR`; direção correta (esquerda/direita) conforme o `theta` do
nó mais próximo; desiste sem chamar `cmd/turn` se não achar nenhum ponto
calibrado por perto.

**Incidente de isolamento de teste, 2026-09-24 (corrigido)**: um teste
mais antigo (`test_after_revert.py`, sobre outra coisa) chamava
`_queue_tick()` sem mockar `robot_fetch_recent_error_records` — como essa
função nova roda incondicionalmente dentro do tick, o teste **acabou
chamando o robô real por engano** (achou um `ROTATE_ERROR` de verdade que
tinha acabado de acontecer, tentou cancelar/frear/girar). Por sorte sem
consequência: a task já tinha `FINISHED` sozinha antes, `robot_stop_
navigation` estava mockado nesse teste (não chamou de verdade), e o
`cmd/turn` foi rejeitado pelo robô (`HTTP 400`) antes de qualquer
movimento real. **Corrigido**: todo teste que chama `_queue_tick()`
precisa mockar `robot_fetch_recent_error_records` (lista vazia) pra nunca
ativar esse destravamento sem querer.

**AINDA NÃO VALIDADO EM CAMPO** — próximo `ROTATE_ERROR` real vai testar
isso de ponta a ponta.

## `cmd/turn` confirmado QUEBRADO; trocado por "empurrãozinho" via `cmd/speed` (2026-09-24)

**3 tentativas reais registradas** (`id=3078,3082,3089`) confirmaram o
destravamento funcionando como desenhado nos dois primeiros casos (check-
turn recusou ângulos específicos, sistema corretamente não forçou nada) —
mas no terceiro (`3089`, -73.6°, check-turn liberou), o `cmd/turn` foi
**rejeitado pelo próprio robô**: `HTTP 400 {"error":"Request body is not
correct.","error_code":"001"}`.

**Investigação exaustiva do 400** — testado ao vivo, todas as variações
falharam com o MESMO erro genérico:
- Ângulo inteiro vs decimal, valores em string, corpo vazio,
  `application/x-www-form-urlencoded` em vez de JSON, sem `Content-Type`.
- **De dentro do próprio robô, via SSH em `localhost`** (descartando a
  hipótese de que o endpoint só aceitaria chamada local, sugerida pela doc
  escrever "http://loca**host**" só pra esse grupo de comandos) — mesmo
  erro idêntico.
- `cmd/move` (mesma família, mesmo padrão de doc) falha igual.
- **Controle**: `cmd/cancel_goal` e `cmd/speed` funcionam normalmente,
  exatamente como documentado — confirma que não é rede nem autenticação,
  é esse comando específico (e `cmd/move`) que está quebrado/mal
  documentado nesse firmware.

**`cmd/speed` funciona, mas de um jeito imprevisível**: testado ao vivo
com `vth=0.1` e depois `vth=0.15` por ~1-3s (reenviando a cada 250ms, como
a doc pede pra movimento contínuo) — a pose **não mudou durante os
comandos**, só um pouco **depois** de mandar o comando de parar (~1°,
~4mm) — bem menos que a conta simples `velocidade × tempo` previa. Usuário
confirmou **fisicamente** (ouviu a roda mexer, viu o robô girar um
pouco) — o comando tem efeito real, só que atrasado/amortecido de um jeito
que não dá pra modelar com precisão a partir desses testes.

**Decisão do usuário, importante**: não precisa ser um ângulo exato — um
giro pequeno e impreciso já é suficiente pra quebrar o travamento (mesmo
espírito do giro manual de 180° que já funcionava: o que importa é sair do
estado travado, não acertar um ângulo específico). Isso elimina a
necessidade de calcular tempo pra um ângulo preciso — só a DIREÇÃO
(esquerda/direita) importa.

**Implementação nova** (substitui o `cmd/turn`):
- `_send_rotate_nudge(direction_sign)` — manda `cmd/speed` com `vx:0,
  vth:±0.15` repetido a cada 0.25s por 3s fixos (mesmos valores do teste
  que girou de verdade), sempre com um `finally` que garante um comando
  final `vth:0` (parar), mesmo se algo falhar no meio.
- `_recover_from_rotate_error_if_stuck()`: continua achando o nó calibrado
  mais próximo e calculando o ângulo até o `theta` dele, mas agora só usa
  o **sinal** (direção) — pergunta pro check-turn um ângulo CONSERVADOR
  fixo (`ROTATE_ERROR_NUDGE_CHECK_ANGLE_DEGREES = 20°`) nessa direção (não
  o ângulo real, que pode ser bem maior) antes de empurrar.

**Testado isolado** (7 cenários): direção correta (esquerda/direita)
conforme o nó mais próximo; sempre termina com `vth:0`; nunca empurra se
check-turn disser `False` ou `None`; ignora erros que não são
`ROTATE_ERROR`; não repete pro mesmo erro; **mesmo com falha de rede no
meio do envio, o comando de parar ainda é tentado** (garantia do
`finally`).

**AINDA NÃO VALIDADO EM CAMPO** — próximo `ROTATE_ERROR` real testa essa
versão de ponta a ponta.

## Cancelamento antes do pickup via alinhamento de docking (2026-09-24)

**Motivação**: o cancelamento adiado até giro seguro (ver acima) usa o
check-turn (`main_forklift_node`) como referência de "posso cancelar aqui
sem travar o robô?" — mas já vimos (ver "Varredura ao vivo" acima) que o
check-turn e a navegação de verdade (`/move_base`/TEB) são cálculos
INDEPENDENTES que podem divergir. O usuário descreveu um processo físico
que é **inerentemente mais confiável** pra decidir quando é seguro cancelar
uma rota ANTES do pickup (rota ainda indo pegar o pallet, `pickupCleared`
ainda `False`):

1. O robô roda a rota até chegar em cima do **docking point** — nomenclatura
   fixa `"H" + nome do ponto de pallet` (ex: pickup `"CD"` → docking
   `"HCD"`; explica referências antigas tipo "P16 -> HCD" em erros de
   `GENERATE_PATH_UNKNOWN_ERROR`).
2. Em cima do docking point, o robô **gira pra alinhar os garfos** com o
   ponto de pallet (não é um alinhamento perfeito). Esse giro é parte da
   sequência normal e confiável do robô — bem diferente de forçar um giro
   ad-hoc (ver seção acima), não tem risco de `ROTATE_ERROR`.
3. Assim que alinha, o **reconhecimento de câmera começa quase
   instantaneamente** — a partir daí não dá mais pra cancelar o pickup.

Ideia do usuário: em vez de perguntar "posso girar?" pro check-turn,
pergunta "o robô já chegou nessa fase específica (alinhamento no docking)
e ainda não passou do ponto de não-retorno?" — usando só pose + posições
calibradas dos pontos, sem nenhuma dependência de sensor novo.

**`dock_state` (ROS, `driver_msgs/ForkliftStatus`) descartado como opção**
— existe de verdade no robô (`main_forklift_node` assina), mas exige um
tipo de mensagem CUSTOM da REEMAN, violando o princípio do bridge de só
usar tipos `std_msgs` padrão. Usuário: "melhor não usar ele" — decidiu
descrever o processo físico pra eu montar a detecção com as ferramentas que
já temos (pose, `/map/point/list`).

**Detecção implementada** (`server.py`):
- `robot_find_point_position(name, target_map)` — busca um ponto calibrado
  por NOME EXATO (diferente de `robot_find_nearest_point`, que busca por
  proximidade — aqui já sabemos exatamente quais pontos queremos: `"H" +
  pickup` e o próprio `pickup`).
- `_pre_pickup_cancel_ready(current)` — lê a pose atual, acha o docking
  point e o ponto de pallet da rota, calcula o rumo esperado de alinhamento
  (`atan2` do docking até o pallet) e devolve:
  - `False` se o robô ainda está longe do docking point (>
    `PRE_PICKUP_CANCEL_PROXIMITY_METERS = 1.5m` — evita falso-positivo de
    "por acaso apontando pro rumo certo" enquanto ainda está em trânsito
    normal, longe do docking);
  - `True` se está perto E a diferença angular pro rumo esperado já é ≤
    `PRE_PICKUP_CANCEL_ALIGNMENT_MARGIN_DEGREES = 30°` — margem pedida pelo
    usuário ("faltando uns 30"), dá tempo de cancelar antes da câmera
    travar o pickup;
  - `None` se não deu pra calcular (pose indisponível, ou os pontos
    "H<pickup>"/pickup não existem no mapa).
- `_current_route_cancel_ready(current, pickup_cleared)` — unifica as DUAS
  estratégias como a lógica GERAL de cancelamento (pedido explícito do
  usuário: "Vamos no momento implementar isso como lógica geral de
  cancelamento"):
  - **ANTES** do pickup (`pickup_cleared=False`): usa
    `_pre_pickup_cancel_ready`; se vier `None` (pontos/pose indisponíveis),
    cai pro check-turn como rede de segurança, em vez de travar o
    cancelamento pra sempre.
  - **DEPOIS** do pickup (carregando o pallet): continua com o check-turn
    de sempre — não existe um "docking point" equivalente nesse trecho, e
    o usuário não decidiu ainda se vai permitir cancelamento automático
    aqui além do que já existia ("nem sei se tem como fazer uma task só de
    descarregar — a estrutura exige pickup+dropoff").
- Os dois pontos de chamada do check-turn no fluxo de cancelamento
  (`_queue_cancel_current`, o handler HTTP, e o bloco `cancelPending` de
  `_queue_tick`) agora chamam `_current_route_cancel_ready` no lugar de
  `robot_can_turn_safely()` direto.
- `_cancel_poll_interval(cancel_pending, pickup_cleared)` — enquanto
  `cancelPending` está esperando a janela ANTES do pickup, sonda bem mais
  rápido (`PRE_PICKUP_CANCEL_POLL_INTERVAL_SECONDS = 0.5s`, contra os 2s do
  `CANCEL_PENDING_POLL_INTERVAL_SECONDS` comum) — é uma corrida contra o
  reconhecimento de câmera, que o usuário descreveu como "quase
  instantâneo" depois do alinhamento; um intervalo de 2s podia perder a
  janela de 30° inteira.

**Testado isolado** (17 cenários, `robot_find_point_position`,
`_pre_pickup_cancel_ready`, `_current_route_cancel_ready`,
`_cancel_poll_interval`): nome exato encontrado/não encontrado/rede falha;
`None` em cada motivo (pose, docking ausente, pallet ausente); `False`
longe do docking; `True`/`False` dentro/fora da margem angular perto do
docking; pós-pickup nunca chama o cálculo de alinhamento; pré-pickup
`None` cai pro check-turn; intervalo de sondagem rápido só quando pendente
E antes do pickup.

**AINDA NÃO VALIDADO EM CAMPO** — decisão do usuário: "vamos começar
testando isso... se for validado, eu penso numa alternativa" (implica que
o `dock_state`/outra abordagem pode voltar à mesa se isso não funcionar na
prática).

### 1ª tentativa de campo (2026-09-25) — FALHOU, câmera reconheceu antes

Usuário reportou que o robô entrou no modo de reconhecimento de câmera
antes do cancelamento disparar (tarefa `EXFtoEXF2MT7`, id `67475`, PICKUP
em `EXF` de 07:19:30 a 07:19:48 — o dispatch aceitou o cancelamento nesse
intervalo, mas isso não garante que a câmera ainda não tivesse começado o
reconhecimento fisicamente).

**Lição sobre observabilidade**: o código novo não tinha NENHUM `print` —
diferente do resto do projeto (ex. `_recover_from_rotate_error_if_stuck`),
não deixou rastro nenhum no console. Sem log, a única evidência disponível
depois do fato foi reconstruída por fora, direto da dispatch API
(`task-record/page`, `action-record/list/{id}`) — dá o resultado final
(CANCELLED), mas não a geometria (distância/ângulo) no momento da decisão.
**Corrigido**: `_pre_pickup_cancel_ready` agora imprime a cada chamada
`dist ao docking` e `diff angular` calculados, e `_current_route_cancel_
ready` imprime quando decide cancelar de verdade — a próxima tentativa
real vai ter esse rastro completo no console do server.py.

**Bug real encontrado ao investigar** (mesmo sem log da tentativa em si):
o alvo de alinhamento usado (`expected_theta`) era o **rumo geométrico
calculado por `atan2` entre o docking point e o pallet point** — não o
`theta` PRÓPRIO calibrado do ponto de pallet. Conferido ao vivo no par
EXF/HEXF (a rota que falhou): `theta` calibrado de ambos os pontos é
**-179.8°**, enquanto o rumo geométrico HEXF→EXF (`atan2`) dava **0.2°** —
**180° de diferença**. É exatamente o mesmo erro (e a mesma correção) que
o usuário já tinha apontado antes pra `_recover_from_rotate_error_if_stuck`
("alinhar com o theta PRÓPRIO do ponto calibrado, não um rumo calculado
até ele" — ver seção acima). Com o alvo invertido, a checagem de margem de
30° só batia (se batesse) bem depois do robô já ter girado quase todo o
caminho de verdade — plausível causa da câmera ganhar a corrida.

**Corrigido**: `_pre_pickup_cancel_ready` agora usa `pallet["theta"]`
diretamente como alvo, sem nenhum cálculo de rumo geométrico (o `atan2`
foi removido). Suíte de testes isolados atualizada pro mesmo contrato
(alvo = theta do próprio ponto).

**AINDA NÃO REVALIDADO EM CAMPO** — próxima tentativa real testa a correção
E gera o log que faltou na primeira vez.

### 2ª tentativa de campo (2026-09-25, mesmo dia) — VALIDADO, funciona muito bem

Usuário confirmou ao vivo, depois de restart do server.py com a correção
acima: "ficou simplesmente sensacional. Funciona MUITO bem."

**Cenário extra observado e importante**: quando o robô entra NUM LOTE
VERTICALMENTE, ele já entra alinhado com o pallet (nunca precisa girar
nesses casos — segundo o usuário, "ele sempre entra alinhado no lote"). O
cancelamento pré-pickup funcionou nesse cenário SEM giro nenhum (a checagem
de margem já bate de cara, `dist`/`diff` dentro do limite assim que chega).
Isso é um sinal de segurança a mais, não só uma confirmação de
funcionamento: elimina o risco de o robô girar durante o cancelamento e
bater em pallets que possam estar em **lotes laterais adjacentes** — o giro
só acontece quando o alinhamento de verdade exige (entrada não-vertical),
nunca à toa.

Feature considerada **estável e validada** a partir daqui.

## Trava: não iniciar task durante retorno pra energia (2026-09-25)

**Cenário levantado pelo usuário**: fila vazia → o robô volta sozinho pra
carga (AUTO_SYSTEM nativa) → o operador manda uma rota nova ANTES dele
chegar/começar a carregar. Até aqui, isso caía no gate normal de
"check-turn no início de tarefas" (`_try_dispatch_current`): pergunta pro
bridge se dá pra girar ONDE o robô estiver naquele instante e, se disser
que sim, dispara na hora. O problema: nesse trecho o robô pode estar em
QUALQUER heading, no meio do caminho de volta — sem docking point, sem
ponto calibrado de referência por perto, nenhuma das garantias de
alinhamento que já vimos em pontos de pallet/lote. E já sabemos, pela
"Varredura ao vivo" (acima), que o check-turn diverge da navegação real —
não é uma referência confiável nesse tipo de posição arbitrária.

**Observação do usuário que simplifica tudo**: se a fila JÁ tinha algo
enfileirado quando a rota anterior terminou, o robô nem chega a voltar pra
energia — a próxima rota já assume, e ele parte de um ponto onde acabou de
soltar um pallet (docking/lote, sempre alinhado, como já confirmado na
seção anterior). Ou seja, **o cenário perigoso só existe quando a fila
estava genuinamente vazia** (senão a AUTO_SYSTEM nem é criada) — não
precisa de tratamento nenhum pro caso "fila não vazia", só pro retorno de
verdade pra energia.

**Decisão**: em vez de confiar no check-turn nesse trecho específico, uma
trava mais simples e robusta — só aceita (dispara) a rota nova depois do
robô CHEGAR na energia e começar a carregar de verdade
(`_robot_status_cache["charging"]`, o mesmo sinal já usado pro bypass do
check-turn no ponto de energia). Aceitar a rota na fila continua normal (o
operador não é bloqueado nem precisa reenviar) — só o DISPARO fica adiado,
com aviso na tela, mesmo padrão UX de `cancelPending`/`turnBlocked`.

**Implementado em `server.py`**:
- `_robot_returning_to_charge_now()` — `True` só quando existe uma
  AUTO_SYSTEM ativa (`robot_find_active_charge_task_id`, já usada em
  `_fire_route`/`_recover_from_rotate_error_if_stuck`) E o robô ainda não
  está carregando. Fail-open pra `False` em erro de rede (mesma postura do
  check-turn em todo o resto do arquivo — falha pontual não pode travar o
  disparo pra sempre, mesmo que aqui o fail-open corra o risco oposto:
  deixar disparar durante um retorno de verdade numa falha bem
  cronometrada. Trade-off aceito, consistente com o resto do código).
- `_try_dispatch_current()` — nova checagem ANTES do check-turn: se
  `_robot_returning_to_charge_now()` é `True`, nem pergunta pro check-turn
  — marca `awaitingCharge` no estado e devolve `False` (tenta de novo no
  próximo tick). Assim que `charging` vira `True`, essa checagem já devolve
  `False` sozinha (não está mais "voltando"), cai direto no bypass de
  check-turn do ponto de energia (que já existia) e dispara imediatamente.
- Novo campo `awaitingCharge` (+ `AWAITING_CHARGE_MESSAGE`) no
  `queue_state.json`/API `/api/live-state`, limpo em
  `_cancel_reserved_current_locked` (operador cancelou enquanto esperava) e
  no disparo com sucesso — mesmo ciclo de vida de `turnBlocked`.
  `_queue_tick` sonda mais rápido (`CANCEL_PENDING_POLL_INTERVAL_SECONDS`)
  enquanto `awaitingCharge` está ativo, mesma urgência de tela de
  `turnBlocked`.
- Front (`MainApp.jsx`/`useLiveState.js`): `awaitingChargeMessage` entra no
  mesmo banner de `cancelPendingMessage`/`turnBlockedMessage` (nunca
  coexistem pra mesma rota — a trava de energia é checada ANTES do
  check-turn, então uma rota RESERVADA só pode estar esperando por UM dos
  dois motivos por vez).

**Testado isolado** (9 cenários, com `_read_queue_state`/`_write_queue_state`
mockados em memória — nunca o `queue_state.json` de verdade, que o processo
rodando ao vivo lê/escreve sozinho): não dispara e marca `awaitingCharge` se
voltando pra energia (sem nem perguntar pro check-turn); dispara normal se
não é o caso; dispara assim que `charging` vira `True`, direto pelo bypass,
sem perguntar check-turn; idempotente (não reescreve o estado à toa a cada
tick); no-op se não há nada reservado; fail-open em erro de rede.

**AINDA NÃO VALIDADO EM CAMPO** — precisa de um teste real com o robô
voltando pra energia e uma rota nova chegando no meio do caminho.

### Bug de campo 2026-09-25 — travava a PRÓPRIA fila (corrigido no mesmo dia)

Usuário reportou o oposto do que essa trava deveria fazer: tinha um destino
em andamento + outra tarefa NA FILA; cancelou o primeiro, e em vez do robô
seguir com a tarefa já enfileirada, ele "exigiu ir até a base de
carregamento pra iniciar a próxima". Hipótese do usuário: a `AUTO_SYSTEM`
nasce imediatamente quando uma tarefa termina/é cancelada, mesmo havendo
outra na fila local.

**Confirmado com dados reais do robô** (`task-record/page`):
```
09:31:18  CD6toCD5MT6 (FAST) criada
09:32:38  CD6toCD5MT6 CANCELLED
09:32:38  energy_... (AUTO_SYSTEM) criada NO MESMO SEGUNDO
09:33:36  essa AUTO_SYSTEM CANCELLED, outra energy_... já toma o lugar
09:34:11  a 2ª AUTO_SYSTEM FINISHED (conectou de verdade)
```
A `AUTO_SYSTEM` nativa aparece porque a dispatch service vê "sem task
ativa" por uma fração de segundo entre uma rota terminar e a próxima ser
disparada — isso SEMPRE existiu (é o motivo de `_fire_route` já achar e
cancelar essa AUTO_SYSTEM órfã antes/depois de disparar a rota nova) e
nunca foi um problema, porque a rota nova disparava imediatamente por
cima. A primeira versão de `_robot_returning_to_charge_now()` (implementada
mais cedo nesse mesmo dia) via essa AUTO_SYSTEM transitória e a tratava
IGUAL a um retorno de verdade — segurando a rota da fila (`awaitingCharge`)
até o robô terminar de ir e voltar da carga (quase 90s nesse caso), quando
na verdade havia trabalho de sobra pronto pra rodar na hora.

**1ª correção (margem de tempo) — TAMBÉM abandonada, ver próxima seção**:
`_robot_returning_to_charge_now()` só devolveria `True` se a MESMA
`AUTO_SYSTEM` continuasse aparecendo por pelo menos
`AWAITING_CHARGE_GRACE_SECONDS` (5s) seguidos, medido pelo relógio LOCAL
(as duas máquinas estão desincronizadas em ~19h, confirmado comparando
timestamps reais — comparar contra `createTime`/`startTime` do robô teria
dado uma conta sem sentido). Chegou a ser implementada e testada, mas o
usuário encontrou o furo antes de validar em campo de verdade — ver "Bug
de campo 2026-09-25, 2ª rodada" logo abaixo.

### Bug de campo 2026-09-25, 2ª rodada — margem de tempo não resolve uso simultâneo

Usuário testou um cenário real antes de validar a correção acima: robô
termina a ÚNICA operação (fila fica genuinamente vazia — exatamente o
cenário que essa trava deveria proteger), e o operador manda uma rota nova
rapidamente (cenário normal com vários tablets ao mesmo tempo). A rota foi
aceita e disparada na hora — "óbvio, foi dentro da janela de 5s". Ou seja:
a margem de tempo não conseguia diferenciar uma AUTO_SYSTEM genuína (que
também é "nova" nesse instante, simplesmente porque acabou de nascer) de
um blip de transição de fila — ela só filtrava CASOS CURTOS, não o
CENÁRIO CERTO. O usuário perguntou se dava pra diferenciar um envio feito
por uma pessoa (clique manual) de um disparo feito pelo próprio sistema de
filas — resposta: sim, e é um sinal bem melhor que tempo nenhum.

**Solução definitiva (ideia do usuário)**: a diferença nunca esteve em
QUANTO TEMPO a AUTO_SYSTEM está ativa — está em DE ONDE a rota reservada
veio:
- Uma rota **promovida** da fila (já estava em `pendingRoute`/`routeQueue`
  ANTES da anterior terminar) nunca pode enfrentar uma AUTO_SYSTEM
  genuína — enquanto a rota anterior rodava, a dispatch service tinha uma
  task nossa ativa, então não existia a janela "sem task" pra uma
  AUTO_SYSTEM nascer. Qualquer uma vista bem nessa hora é sempre um blip
  novo do exato instante da troca — já resolvido por `_fire_route` (acha e
  cancela ela sozinho, antes/depois de disparar a promovida).
- Só uma rota **fresca** (a fila estava REALMENTE vazia antes dela chegar
  — só possível via `_queue_enqueue_batch`, nunca via promoção) pode
  enfrentar uma AUTO_SYSTEM que já vinha rodando há qualquer tempo,
  inclusive zero segundos — não importa, porque não havia mais nenhuma
  rota nossa em andamento de qualquer forma.

**Implementação**: novo campo `currentRouteFresh` (bool) no
`queue_state.json`. `_queue_enqueue_batch` marca `True` só quando a rota
cai no slot `currentRoute` porque a fila estava vazia
(`not state.get("currentRoute")`). `_advance_queue_locked` sempre marca
`False` (nas três saídas: promove `pendingRoute`, promove direto da
`routeQueue`, ou fila esvazia de vez) — nunca é uma chegada "do nada".
`_try_dispatch_current` só chama `_robot_returning_to_charge_now()` quando
`currentRouteFresh` é `True`; se for `False` (promovida), dispara direto
pro check-turn de sempre, sem checar retorno pra energia nenhum.
`_robot_returning_to_charge_now()` voltou a ser simples (sem margem de
tempo, sem estado em memória): `True` assim que existe QUALQUER
AUTO_SYSTEM ativa — porque agora só é chamada exatamente no caso onde isso
já é suficiente. `_queue_emergency` também passou a limpar
`awaitingCharge`/`currentRouteFresh` junto com o resto (gap que já existia
desde a 1ª versão de `awaitingCharge`, corrigido de brinde aqui).

**Testado isolado** (13 cenários): `_advance_queue_locked` sempre marca
`currentRouteFresh=False` nas três saídas; rota fresca segura quando
retornando, dispara normal quando não; rota promovida dispara DIRETO
mesmo com uma AUTO_SYSTEM ativa, sem nem chamar a checagem; bypass de
carga; idempotência; no-op sem nada reservado — mais os 17 de pré-pickup
cancel (regressão), tudo sem tocar o `queue_state.json` real.

**Validado em campo (2026-09-25)** — sequência real de 9 transições
consecutivas (`67536`→`67546`) confirmou o comportamento certo: rota
termina, AUTO_SYSTEM nasce no mesmo segundo, próxima rota da fila dispara
por cima em 2-5s, sem esperar nada. `currentRouteFresh` funcionando como
esperado.

### Bug de campo 2026-09-25, 3ª rodada — retardatária na fresta do próprio `_fire_route`

Mesmo com `currentRouteFresh` funcionando bem nas outras 8 transições, UMA
delas (`67546`→`67548`) desviou pra energia mesmo assim — usuário relatou
"fez tudo muito bem, só essa desviou". Dados reais:
```
11:18:59  CAYtoCAXMT7 (67546) termina
11:19:00  energy_... (67547, AUTO_SYSTEM) E CD5toCD6MT7 (67548, nossa rota)
          criadas NO MESMO SEGUNDO
11:20:12  67547 termina sozinha (FINISHED -- conectou de verdade, ~72s)
11:20:13  67548 só AGORA começa a se mover (startTime), logo depois da 67547
```
**Causa**: diferente do bug das rodadas 1-2 (que era sobre quando ESPERAR),
este é uma corrida dentro do próprio `_fire_route`, que sempre existiu:
ele checa "existe carga ativa?" (`robot_find_active_charge_task_id`,
olhando só o registro MAIS RECENTE) ANTES de criar a rota nova — de
propósito, porque checar DEPOIS veria a própria rota nova como "mais
recente" e nunca acharia a AUTO_SYSTEM antiga. Mas isso deixa uma fresta:
se a AUTO_SYSTEM nascer bem no instante ENTRE essa checagem e o robô
começar a mover pra rota nova, `_fire_route` nunca chega a vê-la — e o
robô, do lado de dentro do dispatch nativo, prioriza o comando que já
estava em voo (a AUTO_SYSTEM), deixando a rota nova "criada" mas parada até
a AUTO_SYSTEM terminar sozinha.

**Correção**: `robot_find_any_active_charge_task_id(size=3)` — escaneia os
ÚLTIMOS registros (não só o topo) em vez de olhar só o mais recente.
`_fire_route` agora faz uma SEGUNDA checagem com essa função, DEPOIS de
criar a rota nova — nesse momento o topo já é a nossa própria rota, mas
uma AUTO_SYSTEM retardatária que tenha nascido na fresta ainda aparece
mais abaixo na lista, e é cancelada também (sem duplicar se for o mesmo id
já cancelado na checagem de antes).

**Continua sendo mitigação, não eliminação total** (mesma ressalva já
registrada antes pra esse tipo de corrida): se a AUTO_SYSTEM nascer DEPOIS
até dessa segunda checagem, ainda escaparia — mas a janela agora é muito
menor (só o tempo de criar a rota + fazer a checagem, não mais o tempo
inteiro até o próximo tick).

**Testado isolado** (8 cenários): retardatária achada e cancelada mesmo
com a checagem de antes vindo vazia; não duplica cancelamento se for o
mesmo id; cancela as duas se forem ids diferentes; não cancela nada sem
retardatária; disparo não falha se a checagem de retardatária der erro de
rede; `robot_find_any_active_charge_task_id` escaneando corretamente —
mais os 13 de `awaitingCharge` e 17 de pré-pickup cancel (regressão), 38
no total, sem tocar o `queue_state.json` real.

**AINDA NÃO REVALIDADO EM CAMPO** — precisa de outra sequência longa pra
confirmar que esse desvio específico não se repete (aceitando que a
corrida nunca é 100% eliminável, só bem mais estreita).



## Tarefas aguardando envio (IMPLEMENTADO 2026-09-25, AINDA NÃO VALIDADO EM CAMPO)

**Pedido do usuário**: "Enviar tarefa" no Ponto a Ponto não dispara mais na
hora — a tarefa entra numa lista local, nova subseção **TAREFAS AGUARDANDO
ENVIO** logo abaixo do botão, pra dar tempo de conferir antes de mandar pro
robô. Só o botão verde **▶ Iniciar tarefas** envia. Motivo: organização e
evitar mandar algo errado por pressa.

**O que dá pra fazer na lista** (`web/src/components/StagedTasksPanel.jsx`):
- Barrinhas no estilo do painel Fila, com número de ordem, rota, e o ícone
  da textura do pallet (madeira/azul) à direita; X fora da barra remove.
  Entram deslizando da esquerda pra direita.
- **Tocar na textura** abre uma janelinha pra trocar madeira/azul (e "Pallet
  de cima" no azul).
- **Tocar na barrinha** carrega a tarefa no Ponto a Ponto pra editar
  (origem/destino aparecem ampliados no mapa, azul/laranja, igual à seleção
  normal): título vira "Editando tarefa", Enviar vira "Salvar alterações",
  Limpar vira "Cancelar edição", e o checkbox "Lotes em sequência" TRAVA
  (avulsa não vira grupo). Tocar num grupo edita a sequência inteira (abre
  em modo sequência, também travado). Tocar de novo na mesma barrinha sai
  sem mudar nada. "Iniciar tarefas" fica bloqueado enquanto edita.
- **Segurar ~0,3s e arrastar** reordena: a barrinha cresce ao levantar,
  vira uma prévia semitransparente seguindo o dedo, e as vizinhas deslizam
  pra abrir espaço. Deslizar SEM segurar rola a lista (as barrinhas têm
  `touch-action: none` pro arrasto funcionar no dedo, então a rolagem é
  feita na mão pelo componente). Soltar fora da lista (mapa, canto vazio)
  volta pro lugar.
- **Grupos de "Lotes em sequência"** chegam juntos, num tracejado laranja,
  e só se movem inteiros (o modelo é uma lista de UNIDADES — avulsa ou
  grupo — nunca tarefas soltas de um grupo). Dividem o mesmo pallet (o
  servidor sempre tratou o grupo com um pallet só). Remover uma tarefa de um
  grupo deixa o resto; grupo com uma só vira avulsa.

**Regra de obstrução** (`MainApp.jsx`, `validateChain`/`checkStagedChange`):
a MESMA regra do servidor (`validate_route_chain`): cada tarefa conferida
contra o armazém como ele estará quando ela rodar (ocupação projetada pelas
anteriores). Reordenar, remover ou salvar uma edição que quebra uma cadeia
válida é recusado com aviso e pulso vermelho no mapa (ex: pôr "pegar A2"
antes de "pegar A", ou remover a que tira o A quando a seguinte depende
disso). A seleção nova no Ponto a Ponto também projeta a partir das já
preparadas (`projectedOccupancy` → `stagedBeforeSelection`), então dá pra
montar A e depois A2 em tarefas separadas. Se a lista ficar inválida por
fora (ocupação mudou), a primeira tarefa problemática fica em vermelho e
"Iniciar" trava com o motivo — e aí mexer na ordem é permitido (pode ser
justamente o conserto).

**Envio num lote só, com pallet e grupo POR PAR** (`server.py`,
`_queue_enqueue_batch`): mandar cada tarefa preparada separadamente não
funcionaria — o servidor valida a cadeia só DENTRO de um envio, então uma
tarefa que depende de outra anterior seria recusada. Por isso "Iniciar"
manda a lista inteira de uma vez, e cada par agora pode trazer `group`
(chave do cliente, ou `null` pra avulsa) e `palletType`/`palletTop`
próprios. Avulsas continuam independentes na fila do servidor (sem
`groupId` — cancelar uma não derruba as outras); cada grupo ganha seu
próprio `groupId`. Sem `group` em nenhum par = formato antigo, idêntico ao
de antes (o lote inteiro vira um grupo, pallet único).

**⚠️ Deploy**: o `server.py` serve o `web/dist` direto do disco, então o
front novo entra no ar pra qualquer tablet que recarregar mesmo SEM
reiniciar o servidor. Um servidor antigo ignora `group`/pallet por par:
uma lista com pallets misturados iria toda com o pallet da primeira
(altura errada no garfo) e tudo viraria um grupo só. **Reiniciar o
`server.py` antes de usar "Iniciar tarefas".**

**Estado local do dispositivo**: a lista não vai pro servidor até o
"Iniciar" — não é compartilhada entre tablets e some num reload da página.

**Testado** (backend FALSO `mock_server.py` + Vite numa porta separada +
Chromium headless — nunca contra o `server.py` real, que controla o robô):
18 cenários com mouse (entrada na lista sem envio, tarefa dependente aceita,
grupo com tracejado, reordenação inválida recusada, grupo inteiro pro topo,
soltar no mapa volta, remoção de dependência recusada, troca de pallet,
edição de avulsa e de grupo, "Iniciar" manda UM envio com grupo/pallet por
par e esvazia a lista, nenhum "task" na tela) + 5 com toque real via CDP
(deslizar não reordena, segurar mostra a prévia, arrastar com o dedo
reordena, toque rápido abre edição). O teste de toque achou um bug real,
corrigido: depois de um arrasto com o dedo o toque seguinte era ignorado
(a marca "ignorar o clique do fim do arrasto" ficava pendurada, porque com
dedo o navegador não dispara esse clique). E o de mouse achou outro: grupo
(alto) não chegava ao topo — a posição passou a ser calculada pela borda
que empurra (de cima subindo, de baixo descendo), não pelo centro. Servidor:
5 testes isolados do formato novo e do antigo, com disco/robô mockados.

**Também nesta mudança**: sidebar do Ponto a Ponto com a mesma largura da
Fila (448px); "task" → "tarefa(s)" em todos os textos visíveis.

## "Limit breaker" — modo de teste do desenvolvedor (IMPLEMENTADO 2026-09-28)

Botão com a cara do Doomguy no Toolbar, ao lado do `{ }`, **só visível em
modo desenvolvedor**. Tocar alterna rosto sério → sorrindo (ligado, com
brilho vermelho pulsando). Enquanto ligado, cancelar a rota em andamento
pula TODO o tratamento de cancelamento seguro — nem a espera de giro
(check-turn/`cancelPending`) nem o alinhamento de docking pré-pickup — e
cancela na hora. Pedido do usuário: agilizar testes de desenvolvimento.

**Atualização (mesmo dia, pedido do usuário: "precisa ser 100% livre")**:
o limit breaker desliga TAMBÉM as travas de início de tarefas — check-turn
no disparo (`turnBlocked`) e a espera de carga (`awaitingCharge`) — e
resolve na hora um cancelamento que já estava pendente em segundo plano.

**Por que virou licença em vez de `force` por requisição**: o disparo da
próxima rota da fila acontece na thread de fundo (`_queue_tick` →
`_try_dispatch_current`), sem nenhuma requisição do tablet que pudesse
carregar o pedido. Então o servidor mantém uma LICENÇA em memória
(`_limit_breaker`, `_limit_breaker_active()`) que expira sozinha em
`LIMIT_BREAKER_LEASE_SECONDS` (12s). O tablet com o Doomguy sorrindo renova
a cada 4s (`POST /api/dev/limit-breaker {"on": true}`, só admin — 403 pra
outros); desligar o botão ou sair do modo desenvolvedor manda
`{"on": false}` na hora.

**Nunca fica ligado esquecido** (exigência do usuário): recarregar/fechar a
página ou reiniciar o app = para de renovar, desliga sozinho em até ~12s;
reiniciar o servidor = zera na hora (só memória). Enquanto a licença está
ativa, ela vale pro sistema INTEIRO (qualquer tablet), não só pra quem
ligou — é um modo de teste. O `force` por requisição no
`POST /api/queue/cancel-current` continua existindo (cancelamento na hora
mesmo antes da primeira renovação chegar). O servidor loga
`LIMIT BREAKER LIGADO/desligado por <usuário>` e cada cancelamento forçado,
e `/api/live-state` expõe `limitBreaker` (estado real no servidor).

Imagens em `web/src/assets/doomguy-normal.png`/`doomguy-limit.png`
(recortadas e igualadas de tamanho a partir das do usuário, renderizadas
com `image-rendering: pixelated`). Senha do modo desenvolvedor trocada no
mesmo dia (constante `DEV_PASSWORD` em `MainApp.jsx`).

**Testado**: 5 testes isolados do servidor (admin com force cancela sem
perguntar giro; force fura pendente; force de não-admin ignorado; sem force
espera normal; pendente sem force continua idempotente) + 8 no navegador
contra backend falso (botão escondido fora do modo dev, senha antiga
recusada, nova libera, imagem troca, `force:true`/`false` no corpo,
sair do modo dev e recarregar desligam). Depois da atualização: +7 testes
da licença no servidor (liga/desliga, 403 pra não-admin, expira sem
renovar, renovar empurra o vencimento, sem licença as travas de início
seguram, com licença dispara sem trava de energia nem check-turn e limpa
`turnBlocked`/`awaitingCharge`, cancelamento pendente resolve na hora no
tick) + 4 no navegador (renova enquanto ligado, desligar e sair do modo dev
mandam `off`, para de renovar depois).

## Incidente de campo 2026-09-29 — GENERATE_PATH_UNKNOWN_ERROR depois de cancelar num docking point fora do corredor

Monitor só-leitura (pose/tasks/erros/fila a cada 2s, sem check-turn)
durante uma sessão de ~20 tarefas. Um único erro:
`GENERATE_PATH_UNKNOWN_ERROR — desviou da rota atual P3 -> P1, distância
7.39m` (08:05:21 no relógio do robô).

**Linha do tempo** (relógio do robô):
```
08:03:32  EXC2toEXC3 começa; operador cancela 8s depois (cancelPending)
          robô segue: corredor y≈44.6 de P1 (23.1,44.8) até P3 (10.5,44.5),
          desce a pista até HEXC2 (11.67,37.10) e gira pra alinhar com EXC2
08:05:12  cancelamento pré-pickup executa no giro de alinhamento, como
          projetado — robô a 0.05m do HEXC2
08:05:16  AUTO_SYSTEM (energy) nasce — nunca inicia (startTime vazio)
08:05:17  CAZtoCAZ2 (próxima da fila) disparada pelo server.py (fica WAITING)
08:05:21  erro P3->P1 7.39m; AUTO_SYSTEM cancelada; CAZtoCAZ2 RUNNING
```
Depois disso o robô **hesitou ~2 min** antes de seguir a rota normalmente:
32s parado no HEXC2, giro de 180°, anda 0.8m, 10s parado, sobe até P3,
**40s parado em P3**, e só então segue pelo corredor até HCAZ.

**O que os números mostram**: 7.39m é exatamente a distância do HEXC2 ao
segmento P3→P1 (conferido pela calibração). O HEXC2 fica no fundo de uma
pista sem saída, ~7m ao sul do corredor. A AUTO_SYSTEM de volta pra carga
tenta gerar a rota a partir do trecho P3→P1 — o MESMO trecho do incidente
de 2026-09-19/23 (24.60m daquela vez) — e desiste quando o robô está longe
dele. Isso matiza a conclusão anterior ("curvas fechadas, não distância"):
pelo menos pra essa mensagem, a distância que o robô reporta bate
exatamente com a distância geométrica até o trecho.

**Contraste na mesma sessão**: cancelamentos nos docking points de CA*/CD*
(HCAZ, HCD..., colados no corredor norte-sul x≈23.8) retomaram a próxima
rota em ~5s, sem erro. O problema só apareceu no docking point no fundo da
pista EX*. Caso parecido às 06:53:24: `EXPtoRDY2` cancelada → AUTO_SYSTEM
que nunca inicia → erro `HEXF3 -> HEXF2 1.02m`. (O de 07:18:08, `HEXQ ->
P19 4.36m`, foi no meio de uma task de 27 min — outro caso, fora da janela
do monitor.)

**Nosso sistema fez o que devia**: cancelamento no alinhamento de
docking, próxima rota da fila disparada na hora (`currentRouteFresh=False`,
sem trava de energia), AUTO_SYSTEM órfã cancelada. O erro da AUTO_SYSTEM
em si é inofensivo (ela seria cancelada de qualquer jeito). O custo real
foram os ~2 min de hesitação pra sair da pista — sem intervenção manual.

**Sem correção aplicada ainda** — opções levantadas, a decidir:
1. Aceitar (ele se recuperou sozinho).
2. Ajustar o grafo de rotas na REEMAN pra ter um nó na boca/no meio das
   pistas EX* (docking points nunca a vários metros do grafo) — mesmo tipo
   de ajuste que resolveu o incidente de 2026-09-23.
3. Do nosso lado, evitar cancelar no fundo de pistas longe do grafo — não
   é trivial (o alinhamento no docking é justamente o ponto seguro pra
   girar).

`nav_status` (`/reeman/nav_status`) ficou em `res=4` a sessão toda — reflete
a navegação direta da SLAM (último `cancel_goal`), não as tasks da dispatch;
não serve pra acompanhar tarefa.

## Incidente 2026-09-29 (2) — AUTO_SYSTEM "sequestra" a rota da fila; e o P3→P1 é FIXO

**O que o usuário viu**: rota `EXC2toRAY2` terminou com sucesso; a próxima
da fila (`OAtoOB`, adicionada durante a anterior) deveria começar, mas o
robô foi até a energia primeiro. O usuário cancelou `OAtoOB` nesse meio.

**Linha do tempo** (relógio do robô, `task-record` + `action-record`):
```
08:39:59  EXC2toRAY2 FINISHED
08:40:00  OAtoOB criada pelo server.py (promovida da fila, na hora)
08:40:01  AUTO_SYSTEM (energy) criada E atribuída ao robô
08:40:04  OAtoOB só agora atribuída — atrás da AUTO_SYSTEM
08:40:05  AUTO_SYSTEM começa; robô vai até a energia (~4 min)
08:43:57  AUTO_SYSTEM FINISHED
08:43:59  OAtoOB finalmente começa; cancelamento pré-pickup (pedido durante
          a ida pra energia) espera o docking HOA, como projetado
08:46:21  OAtoOB CANCELLED no giro de alinhamento, a 0.05m do HOA — certo
08:46:29  nova AUTO_SYSTEM — fica ASSIGNED e nunca inicia
08:46:38  GENERATE_PATH_UNKNOWN_ERROR "P3 -> P1, 41.03m"
```

**Causa do desvio pra energia**: a REEMAN criou a AUTO_SYSTEM ~1s DEPOIS da
nossa rota já existir (a nossa ainda não tinha sido atribuída ao robô —
isso levou 4s), e atribuiu a dela primeiro. As duas checagens de
`_fire_route` (antes e logo depois de criar a rota) rodam antes disso,
então não tinham o que cancelar. A "corrida" que eu tinha descrito como
estreita (milissegundos) na verdade tem janela de SEGUNDOS: enquanto a
nossa rota espera atribuição, a dispatch acha o robô ocioso. Nenhuma trava
nossa roda depois do disparo pra corrigir isso. O cancelamento em si
funcionou certo (não cancelou durante a ida pra energia porque não era a
nossa rota que estava andando; cancelou no docking HOA quando ela rodou).

**Descoberta que CORRIGE a análise do incidente anterior**: o erro sempre
cita o MESMO trecho P3→P1, não importa onde o robô esteja — 7.39m do
HEXC2, 41.03m do HOA (conferido: distância geométrica 41.06m), 24.60m do
HEXA em 2026-09-19. Ou seja, **P3→P1 não é "o trilho mais próximo"; é o
trecho INICIAL fixo do retorno automático pra carga** configurado na
REEMAN. Onde quer que o robô esteja, a AUTO_SYSTEM tenta começar por ele e
só consegue se o robô estiver bem perto. Consequência: **ligar os docking
points ao P3 com trilhos de saída (a solução proposta antes) provavelmente
NÃO resolve** o erro da AUTO_SYSTEM — ela não usa o grafo livremente. Fica
registrado como hipótese descartada pelos dados antes de ser testada.

**Estado deixado**: AUTO_SYSTEM `67663` ASSIGNED sem conseguir iniciar
(robô parado no HOA) — o mesmo "travado sem task" de 2026-09-19. Rotas
normais (`FAST`) planejam bem de qualquer lugar; mandar uma tarefa ou levar
na mão resolve.

**Correção (2026-09-29, mesmo dia)** — usuário ajustou a rota de volta pra
carga na REEMAN (parte do P3→P1) e pediu a correção do "sequestro" no
servidor:
- `_cancel_charge_task_hijacking_route(task_name)`: chamada em TODO tick de
  `_queue_tick` enquanto a `currentRoute` está disparada e não terminou
  (ramo "não avançou", fora do `QUEUE_LOCK`). Se houver qualquer AUTO_SYSTEM
  ativa (`robot_find_any_active_charge_task_id`, olha os 3 registros mais
  recentes), cancela. Fila ociosa, rota reservada (sem `taskName`) ou rota
  que acabou de terminar NÃO passam por aqui — a volta pra carga genuína
  continua livre, sem a oscilação da supressão removida em 2026-09-24.
- `_route_fired_at` + `ROUTE_FIRED_WATCH_SECONDS` (20s) /
  `ROUTE_FIRED_WATCH_INTERVAL_SECONDS` (1.5s): `_fire_route` marca a hora do
  disparo e o loop da fila roda a cada 1.5s nessa janela, pra pegar a
  AUTO_SYSTEM antes dela começar a andar (+1s criada, +5s andando no
  incidente).
- Testado isolado (7): rota esperando atribuição e rota rodando cancelam a
  AUTO_SYSTEM; sem AUTO_SYSTEM não cancela nada; fila ociosa, rota reservada
  e rota recém-terminada não cancelam; `_fire_route` marca a hora.
  **AINDA NÃO VALIDADO EM CAMPO.**

## Rolagem do menu Ponto a Ponto com o dedo (CORRIGIDO 2026-09-29)

**Problema relatado**: no tablet, não dava pra rolar o menu Ponto a Ponto
arrastando o dedo na subseção "Tarefas aguardando envio" — ao contrário do
painel de marcações X, que rola bem.

**Causa**: o painel X usa rolagem 100% nativa do navegador (o `.sidebar`
rola sozinho). A lista de tarefas tinha três coisas atrapalhando: as
barrinhas com `touch-action: none` (pro arrasto funcionar) desligavam a
rolagem nativa quando o dedo começava em cima delas; a rolagem "feita na
mão" que compensava isso mexia só na lista interna, não no menu; e a lista
tinha rolagem própria (máx. 380px) dentro do menu que também rola.

**Correção** (`StagedTasksPanel.jsx`, `App.css`):
- Lista sem rolagem própria — quem rola é o menu inteiro, nativo, igual ao
  painel X. Barrinhas com `touch-action: pan-y`: deslizar na vertical rola
  normalmente.
- O arrasto continua exigindo SEGURAR parado ~0,3s. Só aí o componente
  trava a rolagem nativa (`touchmove` com `preventDefault`, listener
  não-passivo) até soltar. Menu de contexto do Android bloqueado no segurar.
- Arrastando perto da borda de cima/baixo do menu (70px), ele rola sozinho
  (até 14px por quadro), e as posições das barrinhas são corrigidas pelo
  quanto o menu rolou (`retarget`).
- Fora da lista (em cima do botão Iniciar, do mapa, de espaço vazio), a
  prévia mostra as vizinhas voltando pro lugar — é o que acontece ao
  soltar ali (regra do usuário: soltar em lugar inválido volta pro lugar).

**Testado** (toque real via CDP, backend falso): deslizar em cima de uma
barrinha rola o menu (~290px) sem reordenar nem abrir edição; segurar e
arrastar reordena sem o menu rolar junto; arrastar até a borda rola o
menu sozinho até o fim; dedo em cima do Iniciar = prévia volta pro lugar;
voltando pra lista e soltando, a tarefa vai pro fim; toque rápido abre
edição. Arrasto com mouse continua funcionando.

**Complemento (mesmo dia)**: segurar o dedo numa tarefa abria o menu do
Chrome do tablet (baixar, imprimir, modo de leitura). Bloqueado no app
inteiro: `contextmenu` com `preventDefault` global em `main.jsx` (exceto
`input`/`textarea`, onde o menu serve pra colar), `user-select: none` +
`-webkit-touch-callout: none` no `body` (campos de texto continuam
selecionáveis) e `-webkit-user-drag: none` em imagens. Testado no navegador:
bloqueado em botões, lista de tarefas, mapa e toolbar; liberado em campo de
texto.

## Visualizar tarefa (IMPLEMENTADO 2026-09-29)

Tocar numa barrinha de "Tarefas aguardando envio" (além de abrir a edição,
como já fazia):
1. O mapa dá zoom no **kanban (Close Up) onde está a ORIGEM** — o mesmo zoom
   animado do toque num kanban no modo Interação (`handleCloseUpClick`).
   Ponto fora de qualquer kanban: zoom centralizado nele (4× o
   enquadramento geral).
2. O banner "VISUALIZANDO: KANBAN X" aparece (agora também fora do modo
   Interação) com uma 2ª linha `ORIGEM → DESTINO`, cada ponta numa pílula
   clicável (ciano/âmbar, as cores do destaque no mapa); a ponta sendo
   vista fica preenchida.
3. Tocar numa ponta leva o mapa ao kanban DELA e troca o nome no banner.
4. Tocar de novo na mesma barrinha (ou salvar/cancelar a edição, sair do
   modo) sai da visualização — banner some, o mapa fica onde está. Num
   grupo, tocar noutra barrinha do mesmo grupo só troca a tarefa vista.

**Como acha o kanban**: `FloorPlanCanvas.contentPositionOf(name)` calcula a
posição real da célula (lote em (x,y), girado/esticado, célula i em
(i·cellSize, 0) — mesma transformação do desenho) e `closeUpContaining`
testa contra os retângulos dos kanbans (o menor, se sobrepor). O pedido
chega por `focusRequest {name, id}` (MainApp → mapa; `id` muda a cada
pedido).

**Nomes ao vivo**: o banner lê a seleção em edição (`pickupNames`/
`dropoffNames` no índice da tarefa), no apelido visual — mudar a origem
clicando no mapa já atualiza o banner. Banner centralizado no mapa também
com a sidebar larga (Ponto a Ponto/Fila, `--wide`).

**Testado** (navegador, backend falso, tarefa com origem e destino em
kanbans diferentes — MÁQUINA 80 → MÁQUINA 79): zoom ao tocar; banner com o
kanban da origem e origem destacada; origem visível na tela; tocar no
destino troca kanban/destaque e mostra o destino; voltar pra origem; tocar
de novo sai (banner some).

## Cancelamento pós-pickup: UNLOAD isolado via `task-template/generic/chain` (IMPLEMENTADO 2026-09-30, AINDA NÃO VALIDADO EM CAMPO)

**Problema que ficou em aberto desde o início do projeto**: cancelar uma
rota DEPOIS do pickup (robô já com o pallet no garfo) nunca teve tratamento
automático — a estrutura do dispatch sempre exigiu pickup+dropoff numa
task, então não tinha como criar uma tarefa só pra "descarregar aqui" (nem
pelo site do fabricante, confirmado pelo usuário tentando na prática).
Cancelar nesse trecho, até aqui, só freava o robô onde estivesse — sem
soltar o pallet em lugar nenhum.

**Descoberta que destravou isso (2026-09-29/30)**: testado ao vivo,
`POST /task-template/generic/chain` aceita uma `taskChain` com uma ÚNICA
ação (sem exigir PICKUP+UNLOAD) — recusado pelo SITE do fabricante, mas
aceito pela API (`code: 0`, vira um `task-record` de verdade,
`taskType: TEMP_TASK_CHAIN`). Achado num teste de investigação: mandamos
`{"taskChain":[{"action":"UNLOAD","targetPoint":"A",...}]}` com o garfo
VAZIO — aceitou, criou o registro, mas ficou em `WAITING` até cancelarmos
uma `AUTO_SYSTEM` antiga que estava competindo pelo único AGV da frota (não
tem relação com o UNLOAD em si). **Ainda não testado com pallet de verdade
em cima** — só confirma que a API aceita o formato, não que o robô executa
o descarregar fisicamente sem erro.

**Design (pedido do usuário, confirmado incluindo "Lotes em sequência";
CORRIGIDO em 2026-09-30 depois do 1º teste de campo — ver "Bug de campo
2026-09-30 (3º do dia)" abaixo, esta descrição já reflete a versão
corrigida)**:
1. Operador cancela uma rota que já passou do pickup (`pickupCleared`).
2. O robô continua até o ponto de DESTINO normalmente (a task original não
   é interrompida no meio do caminho) — mas só pra usar aquele ponto como
   docagem segura pra cancelar, NÃO pra entregar ali. Cancelar significa
   abortar a entrega, não completá-la.
3. No destino, o MESMO mecanismo de alinhamento de docking que já usávamos
   pra pré-pickup (ver seção acima) dispara o cancelamento — contra o ponto
   de DESTINO (é lá que o robô está fisicamente chegando). Giro que o robô
   já faz de qualquer jeito, mesma margem de 30°.
4. Assim que cancela, dispara na hora uma tarefa de PRIORIDADE MÁXIMA — só
   com UNLOAD no ponto de ORIGEM da rota cancelada (devolve o pallet pra
   onde foi pego) — que aparece na fila como **"DESCARREGANDO EM: {nome
   fantasia da origem}"**. A fila normal (pending/queue) fica esperando
   atrás dela, sem tentar avançar.
5. Terminando o descarregar (pallet de volta na origem), a fila segue
   normal (próxima tarefa, ou volta pra energia — exatamente como já
   acontecia).
6. "Lotes em sequência": não muda nada de especial — o resto do grupo já
   caía imediatamente ao cancelar (antes ou depois do pickup, sempre foi
   assim), e a tarefa isolada de descarregar nunca herda `groupId` nenhum.

**Unificação do mecanismo de alinhamento** (`server.py`): o que antes era
`_pre_pickup_cancel_ready`/`PRE_PICKUP_CANCEL_*` (só pro pickup) virou
`_docking_alignment_cancel_ready(pallet_point)`/`DOCKING_ALIGNMENT_CANCEL_*`
— a MESMA função, parametrizada pelo ponto. `_current_route_cancel_ready`
escolhe `current["dropoff"]` se `pickup_cleared`, senão `current["pickup"]`.
`_cancel_poll_interval` perdeu o parâmetro `pickup_cleared`: agora sonda
rápido sempre que `cancelPending`, dos dois lados (a corrida contra o
reconhecimento de câmera na docagem vale pra pickup E pra dropoff).

**Implementação nova**:
- `robot_create_and_run_unload_chain(dropoff)` — `POST /task-template/
  generic/chain` com `taskChain` de uma ação só (`UNLOAD`, `params: {}`,
  `agvTypes` em vez de `agvId` — só AGV da frota hoje). A resposta devolve
  `taskChainId`, que é o MESMO id do task-record criado (confirmado ao
  vivo) — por isso não precisamos de um nome nosso pra sondar depois.
- `robot_fetch_task_record_by_id(id, size=5)` — acha o registro entre os
  mais recentes (o dispatch não dá um endpoint de busca por id direto).
- `_execute_cancel_current_locked`: se `pickupCleared`, em vez de avançar a
  fila, marca `pendingPostPickupUnload` com `dropoff = current["pickup"]`
  (o campo se chama "dropoff" porque é o destino da tarefa NOVA e isolada,
  que é a ORIGEM da rota cancelada — ver correção abaixo) — a fila normal
  fica parada até isso resolver. `_drop_group_from_queue` continua rodando
  IMEDIATAMENTE, igual sempre foi.
- `_try_dispatch_post_pickup_unload()` — resolve o pendente: dispara o
  chain, e só quando CONSEGUE vira a `currentRoute` de verdade (com
  `taskName`/`taskRecordId`/`unloadOnly: True`, `pickup: None`,
  `groupId: None`, `pickupCleared: True` por construção). Se a rede falhar,
  NÃO desiste — mantém `pendingPostPickupUnload` pro próximo tick tentar de
  novo (o pallet continua no garfo, desistir não é opção). Chamada: na
  mesma resposta HTTP do cancelamento, no mesmo tick que resolve um
  `cancelPending` em segundo plano, e em TODO tick normal enquanto
  continuar pendente (sondagem rápida, mesmo intervalo da corrida contra a
  câmera).
- `_apply_record_status`: `unloadOnly` + `FINISHED` marca o destino ocupado
  e avança a fila normal (igual sempre foi). `unloadOnly` + terminal SEM
  sucesso (CANCELLED/FAILED por fora) NÃO desiste — volta pra
  `pendingPostPickupUnload` pra tentar de novo, com aviso no console
  (`ATENÇÃO: UNLOAD isolado... pallet pode continuar no garfo`).
- `_queue_tick`/`_reconcile_queue_state_on_startup`: sondam uma rota
  `unloadOnly` por ID (`robot_fetch_task_record_by_id`), não por nome — o
  dispatch dá um nome aleatório ("76f46_2026-09-30 10:40:05") que não
  temos como prever.
- Aviso ao operador: `POST_PICKUP_UNLOAD_MESSAGE`, exposto em
  `/api/live-state` como `postPickupUnloadMessage` (ativo desde o
  `pendingPostPickupUnload` até a `currentRoute.unloadOnly` terminar) —
  reaproveita o `CancelPendingBanner` já existente (mesmo padrão de
  `cancelPendingMessage`/`turnBlockedMessage`/`awaitingChargeMessage`,
  nunca coexistem).
- Front (`QueuePanel.jsx`): `currentRoute.unloadOnly` renderiza
  "DESCARREGANDO EM: {nome fantasia}" em vez de origem→destino, e SEM botão
  de cancelar (cancelar de novo só recriaria o mesmo problema, possivelmente
  no meio do movimento de descarregar). `HistoryPanel.jsx`: mesma
  substituição pro histórico (`pickup: null` → "Descarregando em: X").

**Limitação conhecida, aceita por ora**: parada de emergência durante a
janela `pendingPostPickupUnload`/`unloadOnly` ainda limpa tudo sem
tratamento especial — mesmo comportamento (e mesma lacuna) que já existia
pra qualquer rota cancelada carregando um pallet antes desta feature. Não
foi pedido pelo usuário resolver isso agora; registrado aqui pra não
esquecer se algum dia for revisitado.

**Testado isolado** (23 cenários, tudo mockado — nunca o robô real nem o
`queue_state.json` real): mecanismo de alinhamento escolhe pickup/dropoff
corretamente; `_cancel_poll_interval` sempre rápido quando pendente;
`robot_create_and_run_unload_chain` monta o corpo exato confirmado ao vivo
e levanta erro sem `taskChainId`; `robot_fetch_task_record_by_id` acha por
id; `_execute_cancel_current_locked` pré-pickup inalterado (regressão),
pós-pickup não avança a fila e marca pendente, sequência solta o grupo
igual; `_try_dispatch_post_pickup_unload` sucesso/falha-com-retry/no-op/
corrida; `_apply_record_status` unloadOnly FINISHED avança normal,
CANCELLED/FAILED tenta de novo; sondagem por id em vez de nome;
`log_route_requested` aceita `pickup=None`; handler HTTP ponta a ponta
(pré-pickup regressão + pós-pickup sucesso/falha). Navegador (backend
falso): banner aparece, fila mostra "DESCARREGANDO EM: X" sem botão de
cancelar, próxima rota normal da fila continua normal.

**AINDA NÃO VALIDADO EM CAMPO** — falta: (1) confirmar que `POST /task-
template/generic/chain` com UNLOAD funciona com pallet de verdade em cima
(só testamos com o garfo vazio); (2) reproduzir o cenário completo
(cancelar depois do pickup, ver o giro no destino, ver a tarefa isolada
aparecer na fila, ver o pallet realmente descarregar, ver a fila seguir
sozinha). **Reiniciar o `server.py` antes de testar** — o processo rodando
agora é anterior a esta mudança.

## Bug de campo 2026-09-30 — pickupCleared perdeu a corrida, foi pra energia com o pallet possivelmente no garfo (CORRIGIDO no mesmo dia)

**O que o usuário relatou**: cancelou uma rota com o robô "dentro de um
lote, em cima de um ponto de docagem" — em vez de disparar o UNLOAD
isolado (feature nova, ver seção acima), o robô só cancelou e foi pra
energia (comportamento pré-pickup). Perguntou: o sistema considera alguma
flag de "o robô está carregando um pallet"? Sim — `pickupCleared` (Caso 2)
— mas essa investigação achou um jeito real dela FALHAR.

**Dados reais** (task `67689`, `CD3toCAXMT7`): a ação PICKUP mostra
`finishTime: 2026-09-30 11:26:58` mas `status: CANCELLED`. Comparado com
uma coleta genuína recente (task `67682`, PICKUP `start`→`finish` = 64s):
aqui a fase de PICKUP durou **85s** (11:25:28 até a UNLOAD "iniciar" às
11:26:53) — mais que a referência de coleta completa — e só 5s depois disso
é que a task inteira aparece `CANCELLED`. Forte indício de que **o pallet
já tinha sido pego de verdade** antes do cancelamento chegar.

**Causa raiz**: `pickupCleared` é setada pela sondagem PERIÓDICA de Caso 2
(uma vez por tick, checando `action-record/list` — ver `_queue_tick`). Se o
PICKUP terminar de verdade e a task for cancelada (por nós ou por fora)
DENTRO do mesmo intervalo de sondagem, a ação de PICKUP NUNCA chega a ser
observada com `status: FINISHED` — no próximo poll, ela já está
`CANCELLED` (o cancelamento contaminou retroativamente o status da ação
que tinha acabado de completar), e o `finishTime` vira só o carimbo do
cancelamento (mesma ressalva já documentada no comentário de Caso 2, "não
é de conclusão"). Ou seja: **um pickup genuinamente concluído pode nunca
deixar rastro de sucesso**, se o cancelamento for rápido o bastante — e
como o cancelamento pré-pickup é DESENHADO pra acontecer bem no fim do giro
de alinhamento (ver seção acima), essa corrida é mais fácil de perder do
que parece: o pickup pode terminar segundos antes do clique de cancelar.

**Correção** (`server.py`): `_pickup_actually_completed(current)` — faz UMA
checagem FRESCA (`action-record/list`) bem antes de mandar qualquer
comando de cancelamento nosso, ainda sem contaminação (a ação só vira
`CANCELLED` DEPOIS que a gente manda cancelar). `_resolve_pickup_cleared_
for_cancel(current, pickup_cleared)`: se a flag salva já é `True`, confia
nela (nunca regride); se é `False`, faz a checagem fresca — confirma
`True` só se `finishTime` existe E `status != CANCELLED` NESSE INSTANTE.
Chamada nos DOIS pontos que decidem um cancelamento (`_queue_cancel_
current` e o bloco de `cancelPending` em `_queue_tick`), ANTES de escolher
qual ponto alinhar (origem ou destino) e antes de gravar `pickupCleared` no
estado que `_execute_cancel_current_locked` vai ler.

**Por que isso não existia desde o início**: a feature de cancelamento
pós-pickup é NOVA (mesmo dia) — antes dela, `pickupCleared` errado só
significava "usa o check-turn em vez do alinhamento", sem consequência de
segurança (as duas formas cancelavam do mesmo jeito). Agora que
`pickupCleared` decide "dispara UNLOAD isolado ou não", a corrida virou
crítica — motivo de ter sido pega logo no 1º teste de campo.

**Testado isolado** (11 cenários): `_pickup_actually_completed` confirma
com FINISHED genuíno, recusa com CANCELLED mesmo tendo finishTime (o caso
real), recusa se ainda rodando, `None` em falha de rede/sem registro;
`_resolve_pickup_cleared_for_cancel` nunca regride de True, corrige False
pra True quando a checagem fresca confirma (cenário do incidente), mantém
False se realmente não pegou ou se a checagem for inconclusiva; ponta a
ponta pelo handler HTTP reproduzindo o incidente (flag salva False + pickup
já concluído de verdade → vira UNLOAD isolado no destino, não energia) e a
contraprova (flag False + realmente não pegou → continua indo pra fila
normal). Um teste antigo precisou ser corrigido nesse processo: usava
`pickupCleared=False` sem mockar a checagem nova, o que faria uma chamada
de rede de VERDADE pro robô durante o teste "isolado" — achado e corrigido
antes de rodar (a suíte toda caiu de ~0.3s pra ~0.01s depois do mock).

**AINDA NÃO REVALIDADO EM CAMPO** — próximo cancelamento pós-pickup real
deve mostrar a tarefa "DESCARREGANDO EM: X" em vez de ir pra energia,
mesmo quando `pickupCleared` não tinha sido pega a tempo pela sondagem
periódica. **Reiniciar o `server.py`** antes de testar de novo.

## Bug de campo 2026-09-30 (2º do dia) — UNLOAD começou 44s antes do cancelamento pós-pickup ser executado

**O que o usuário relatou**: com a correção acima já em campo, o
cancelamento pós-pickup foi ACEITO corretamente (o robô foi até o ponto de
deploy como esperado), mas o robô **iniciou o próprio deploy da rota
original** no ponto onde deveria ter cancelado, em vez de parar pro giro de
alinhamento de docking (ver `_docking_alignment_cancel_ready`).

**Dados reais** (task `67691`): a ação UNLOAD da rota original começa às
`11:42:16`; a task inteira só é marcada `CANCELLED` às `11:43:00` — **44
segundos depois**. Ou seja, o cancelamento de fato aconteceu, mas tarde
demais: o UNLOAD já tinha sido disparado antes.

**Hipótese investigada (não confirmada como causa única)**: a thread de
fundo que sonda a fila (`_start_queue_thread`) dormia com `threading.Event.
wait(intervalo)` sem jeito de acordar antes da hora, exceto no encerramento
do servidor. Se o clique de cancelar do operador encontrasse o robô ainda
FORA da margem seguro-pra-cancelar (`safe=False`), `cancelPending=True`
era gravado, mas a thread de fundo só ia reparar nisso no próximo ciclo de
sondagem — até `QUEUE_POLL_INTERVAL_SECONDS` (4s) de "janela morta" se o
ciclo tivesse acabado de começar a dormir. Isso por si só não bate com 44s
de atraso — mas é uma folga real que não deveria existir, e some do
caminho de investigação para o próximo teste.

**Correção aplicada** (`server.py`, não depende do robô pra ser testada):
`_queue_wake` (`threading.Event`) substitui a espera cega por
`QUEUE_POLL_INTERVAL_SECONDS`: a thread de fundo agora dorme em `_queue_wake.
wait(intervalo)`, que acorda tanto no timeout normal quanto na hora exata
em que alguém chama `_poke_queue_thread()`. `_poke_queue_thread()` é
chamada nos 3 pontos onde o sistema entra num "estado de espera" que a
sondagem precisa resolver o quanto antes: `cancelPending=True` (handler
`_queue_cancel_current`), `turnBlocked=True` e `awaitingCharge=True`
(ambos em `_try_dispatch_current`). `_stop_queue_thread` também dá `set()`
em `_queue_wake` pra encerrar rápido no shutdown, sem depender do timeout
em andamento.

**Testado isolado** (6 cenários, thread de fundo de verdade — é sobre
timing — mas `_queue_tick` mockado, nunca fala com o robô nem toca
`queue_state.json` real): poke acorda a thread bem antes do intervalo
normal terminar; sem poke, o intervalo normal é respeitado; `_stop_queue_
thread` ainda encerra rápido mesmo com intervalo longo configurado; os 3
pontos de transição (`cancelPending`/`turnBlocked`/`awaitingCharge`) de
fato chamam `_poke_queue_thread` uma vez cada.

**IMPORTANTE — isto é uma melhoria arquitetural, NÃO uma correção
confirmada da causa raiz**: a folga de até 4s que essa mudança elimina é
real e vale a pena eliminar, mas sozinha não explica 44s de atraso. A causa
exata do atraso de 44s ainda não foi determinada — falta o log de console
do `server.py` daquele teste (os prints de diagnóstico como "alinhamento
de docking: dentro da margem" não foram capturados). **Próximo teste de
campo deve rodar o servidor redirecionando a saída pra arquivo** (ex.:
`nohup python3 server.py > server.log 2>&1 &`) pra não perder esses prints
de novo. **Reiniciar o `server.py`** antes de testar (mudança só entra em
vigor depois do restart).

**Explicação alternativa, dada pelo usuário (mais provável que a hipótese
acima)**: o usuário trocou o robô pro modo manual ENQUANTO essa tarefa de
cancelamento pós-pickup ainda estava pendente (esperando o giro de
alinhamento de docking pra cancelar com segurança). Se for isso, os 44s não
são sondagem lenta nenhuma — o robô passou a responder ao controle manual
em vez de à fila do `server.py`, e nenhuma correção de latência em segundo
plano teria como competir com isso. Nesse caso a lição prática não é de
código, é operacional: **evitar trocar pro modo manual enquanto o aviso de
"cancelamento pendente" ou "descarregando em X" estiver na tela** — o
sistema foi desenhado pra resolver isso sozinho (ver "Cancelamento adiado
até giro seguro"); manual só deveria entrar como último recurso se ficar
preso por muito tempo sem resolver. A correção de latência
(`_queue_wake`/`_poke_queue_thread`) continua válida por si só, mas
provavelmente não é o que teria evitado este caso específico.

**Efeito colateral descoberto durante a investigação (não corrigido
ainda)**: a tarefa de recuperação criada pelo cancelamento pós-pickup desse
mesmo teste (task `67692`, alvo CAX) bateu `LOCATION_LOST` 67s depois de
começar e ficou presa em `status: RUNNING`/`finishTime: None`
indefinidamente — o robô terminou voltando pra energia e carregando de
verdade, mas o `queue_state.json` ainda acha que essa `currentRoute`
(`unloadOnly: true`) está rodando, o que bloqueia qualquer novo despacho.
Como rotas `unloadOnly` não têm botão de cancelar na UI (de propósito, ver
seção acima — cancelar de novo recriaria o mesmo problema durante um
descarregamento ativo), não existe hoje um jeito de destravar isso pela
interface quando ela FALHA em vez de completar. Ideia ainda não
implementada nem validada com o usuário: reabilitar o cancelar de rotas
`unloadOnly` especificamente quando o "Limit Breaker" (modo desenvolvedor)
estiver ativo — operador comum não devia poder interromper um
descarregamento em andamento, mas uma recuperação travada precisa de uma
saída.

## Bug de campo 2026-09-30 (3º do dia) — cancelamento pós-pickup entregava no DESTINO, deveria devolver à ORIGEM (CORRIGIDO no mesmo dia)

**O que aconteceu**: no teste de campo com o `server.log` sendo observado
ao vivo (ver bug anterior), o cancelamento pós-pickup funcionou tecnicamente
— alinhou no destino, cancelou, disparou a tarefa isolada "DESCARREGANDO
EM: X" — mas **X era o ponto de DESTINO da rota cancelada**, e o pallet
acabou sendo entregue lá. O usuário reportou como possível bug: o pallet
ficou no destino original quando o esperado, segundo ele, era o robô
usar o destino só pra cancelar com segurança e depois criar uma tarefa
devolvendo o pallet à ORIGEM.

**Causa raiz**: confusão de especificação desde o pedido original (2026-09-
30, ver seção "Cancelamento pós-pickup" acima) — a frase "o robô vai até o
ponto de deploy... cria outra tarefa... apenas com o unload" foi
implementada como "termina de entregar no destino, já que está indo pra lá
mesmo". O usuário esclareceu depois de ver o teste ao vivo: a intenção
sempre foi **abortar a entrega** (mesmo significado de "cancelar" que já
vale pra pré-pickup — parar e não completar), não terminá-la — a diferença
é que com o pallet no garfo não dá pra simplesmente "não fazer nada" (o
pallet tem que ir a algum lugar), então o lugar certo é de volta à ORIGEM
de onde foi pego, não o destino que a entrega original tinha.

**Confirmação de que não teve dano físico**: o pallet ficou no destino
original (usuário confirmou), o operador está devolvendo manualmente agora
pra poder repetir o teste com a correção. O robô também confirmou ter
baixado o garfo e iniciado o unload de verdade antes do cancelamento
executar (ver bug anterior, "44s de atraso") — ou seja, o atraso na
execução do cancelamento não causou nenhum problema de posicionamento
errado, só reforça que a lógica de ONDE entregar depois é que estava
errada, não o timing de quando cancelar.

**Correção** (`server.py`): o mecanismo de alinhamento de docking pra
cancelar CONTINUA usando o ponto de DESTINO (`_current_route_cancel_ready`
não mudou — o robô fisicamente está chegando lá, é o ponto certo pra usar
a docagem e cancelar com segurança). O que mudou é só o ALVO da tarefa
isolada criada depois: `_execute_cancel_current_locked` agora monta
`pendingPostPickupUnload` com `dropoff = current["pickup"]` (a ORIGEM da
rota cancelada) em vez de `current["dropoff"]`. `_try_dispatch_post_pickup_
unload` não precisou mudar — já lê `pending["dropoff"]` genericamente (o
nome do campo significa "destino desta tarefa nova", que agora É a origem
da rota cancelada). `POST_PICKUP_UNLOAD_MESSAGE` e o comentário em
`QueuePanel.jsx` atualizados pra não falar mais em "destino original".

**Testado isolado** (2 cenários, mockando `_robot_try_cancel`/
`robot_stop_navigation`/rede — nunca fala com o robô de verdade):
`_execute_cancel_current_locked` com `pickupCleared=True` grava
`pendingPostPickupUnload["dropoff"]` igual ao `pickup` da rota cancelada
(não ao `dropoff`); `_try_dispatch_post_pickup_unload` cria a `currentRoute`
isolada com `dropoff` igual à origem e chama `robot_create_and_run_unload_
chain` com esse mesmo ponto. Um erro de isolamento foi cometido e corrigido
no processo — o 1º teste não mockava `_robot_try_cancel`, fazendo uma
chamada de rede de verdade (o robô respondeu HTTP 400 "já terminal", só
não deu pra perceber sem prestar atenção no output) — corrigido antes de
seguir (suíte caiu de rede real pra 0.005s).

**AINDA NÃO VALIDADO EM CAMPO COM A CORREÇÃO** — próximo teste deve mostrar
"DESCARREGANDO EM: {origem}" (não mais o destino) e o pallet deve realmente
voltar pro ponto onde foi pego. **Reiniciar o `server.py`** antes de testar
de novo.

## Bug de scroll num tablet específico (Lenovo ZUI TB311FU) — "100vh mente" (CORRIGIDO 2026-09-30)

**Sintoma**: nesse tablet (WebView Android mais simples/skin customizada),
o menu lateral de Ponto a Ponto não rolava pra baixo, e o botão "Enviar
tarefa" nem aparecia — "comido" pela parte debaixo da tela.

**Causa**: `100vh` nesse WebView mede a altura "cheia" da tela, não a área
realmente visível depois da barra de navegação do sistema — o `.app`
(`height: 100vh`) se achava maior que a tela de verdade, empurrando o fim
da sidebar pra fora. Sem nada "transbordando" do ponto de vista do CSS, o
`overflow-y: auto` da sidebar nunca ativava.

**Correção**: `main.jsx` mede a altura real via `window.innerHeight`
(reflete a área visível de verdade nesses casos) e guarda numa variável CSS
(`--app-vh`, atualizada em resize/orientação). `App.css`: `.app` e
`.login-screen` usam `var(--app-vh, 100vh)` em vez de `100vh` puro (100vh
só como fallback antes do JS rodar). `-webkit-overflow-scrolling: touch`
também adicionado na sidebar, reforço pra WebViews mais antigos.

## Status "Voltando à Energia" (IMPLEMENTADO 2026-09-30)

**Pedido do usuário**: quando o robô está numa task de retorno pra energia
(AUTO_SYSTEM nativa, ainda não chegou/começou a carregar), mostrar
"VOLTANDO À ENERGIA" no banner de status em vez de "EM OPERAÇÃO".

**Implementação**: `_robot_status_cache` ganhou `returningToCharge`,
atualizado no MESMO ciclo de `_refresh_robot_status` (chamado por
`_queue_tick`, não por requisição HTTP — senão cada tablet multiplicaria a
chamada ao robô) via `_robot_returning_to_charge_now()` (já existia, usado
em `_try_dispatch_current` pra travar início de rota — reaproveitado aqui).
Exposto em `/api/live-state` como `robotReturningToCharge`.
`RobotStatusBanner.jsx`: 3º estado (`is-returning`, cor laranja —
`--accent-orange`, mesma família do Close Up) — só considerado quando
`charging` é false.

## Tela cheia por conta (IMPLEMENTADO 2026-09-30)

**Pedido do usuário**: botão de tela cheia ao lado do de tema, preferência
vinculada à CONTA (não ao tablet), igual o tema.

**Ressalva importante**: a API de Fullscreen do navegador só entra em tela
cheia dentro de um GESTO do usuário — nenhum navegador deixa
`requestFullscreen()` disparar sozinho ao carregar a página. Então a
preferência salva não "força" nada sozinha ao logar.

**Implementação**: `server.py` — `_user_fullscreen(user)`, endpoint
`POST /api/session/fullscreen` (self-service, mesmo padrão de
`/api/session/theme`), campo `fullscreen` no payload de sessão/login, e no
registro do usuário (default `False`). `MainApp.jsx`: `wantsFullscreen`
(preferência, da conta) vs `isFullscreen` (estado DE FATO do navegador,
via evento `fullscreenchange`) — quando a conta quer tela cheia mas o
navegador não está nela (ex: acabou de logar), um listener de
`pointerdown` ÚNICO no documento inteiro aproveita o PRÓXIMO toque em
qualquer lugar do app (vai acontecer de qualquer jeito, é touchscreen de
operação) pra satisfazer a exigência de gesto sem precisar de aviso/botão
extra. O botão do Toolbar (gesto explícito) chama request/exitFullscreen
direto.

## Painel Histórico: filtros, nome fantasia, tag CANCELADA, zoom (IMPLEMENTADO 2026-09-30/10-01)

**Pedido do usuário**: sidebar do Histórico do mesmo tamanho de Fila/Ponto
a Ponto; filtro por conta solicitante (busca com sugestões) combinável com
data e horário; nome fantasia em vez do nome técnico; tag "CANCELADA";
clicar numa rota do histórico mostra origem/destino no mapa com zoom de
perto + banner "VISUALIZANDO", igual ao "Visualizar tarefa" do Ponto a
Ponto.

**Implementação** (`HistoryPanel.jsx`, filtragem 100% client-side — a
lista inteira já vem de `GET /api/route-log`, sem round-trip novo por
filtro):
- `.sidebar--history` entrou no grupo de largura 448px (`.sidebar--wide`).
- 3 filtros combináveis por AND: data (já existia), horário (dois
  `<input type="time">` de/até, comparação lexicográfica de string no
  `HH:MM`), conta (busca com sugestões — nomes distintos vistos no próprio
  histórico carregado, sem endpoint novo).
- Nome fantasia via `displayCellName` (precisa de `lots`/`points` como
  prop, antes não recebia).
- Tag `CANCELADA`/`FALHOU` (`history-route__tag`) ao lado do nome.
- Cada rota virou `<button>` (era `<div>`) — clicar chama `onSelectEntry`.

**Bug achado e corrigido no mesmo dia**: o destaque não aparecia ao
clicar — `highlightsRoute(mode)` (`FloorPlanCanvas.jsx`, decide quais
modos desenham pickup/dropoff colorido) não incluía `'history'` na lista.

**Zoom + banner "VISUALIZANDO"** (`MainApp.jsx`): reaproveita o mecanismo
já existente do Ponto a Ponto (`requestFocus`/`focusRequest`, usado em
"Visualizar tarefa") — `selectedHistoryRoute`/`historyFocusedEndpoint`
espelham `viewTask`/`viewTask.active`. `handleFocusEndpoint` agora checa
`mode` pra decidir se o clique no banner é sobre a seleção de Ponto a
Ponto ou a do Histórico (nunca os dois ao mesmo tempo, modos diferentes).
Pickup `null` (UNLOAD isolado pós-cancelamento) foca o destino direto.

## "Enviado por" na Fila (IMPLEMENTADO 2026-10-01)

Pedido do usuário: mostrar quem solicitou cada rota, discreto (cinza,
menor), abaixo do nome — `QueuePanel.jsx`, `queue-route__user`, lê
`route.user`/`currentRoute.user` (já existia nos dados, só não era
exibido).

## Delimitação de usuários por grupo de lotes ("Kanbans") (IMPLEMENTADO 2026-10-01)

**Pedido do usuário**: restringir um usuário comum a só RETIRAR pallets de
um ou mais grupos de lotes (delimitados visualmente por um Close Up no
mapa — "kanban"), mas podendo ENTREGAR em qualquer lugar sem restrição.
Novo papel "Mestre": acesso a qualquer kanban + cancela qualquer tarefa,
mas sem acesso a Histórico/Usuários (igual operador comum). Dois kanbans
("SAÍDAS 69/71" e "SAÍDAS 47,40,61,52,35") são livres pra todos — nunca
aparecem na lista de restrição, e qualquer usuário restrito pode pegar ali
mesmo sem ter esse kanban atribuído.

**Decisões confirmadas com o usuário antes de implementar** (pergunta
feita de propósito — errar modelo de permissão custa caro de desfazer):
usuário comum precisa de **pelo menos um kanban JÁ NA CRIAÇÃO** (não dá
pra criar sem); Mestre **não vê** as abas Histórico/Usuários (mesma
restrição de operador comum hoje); a restrição vale **também** pra remover
uma tarefa da fila de espera, não só cancelar a que está rodando.

**IDs, não nomes** (pedido explícito do usuário — nomes de kanban podem
mudar): tanto os 2 kanbans "livres pra todos" quanto a lista de kanbans de
cada usuário são guardados pelo `id` (UUID) do Close Up, nunca pelo nome.

**Geometria portada pro servidor** (`server.py`) — a restrição é um GATE
de verdade, não só UI: `_closeup_id_for_name(name, cal)` reimplementa em
Python a mesma matemática que `FloorPlanCanvas.jsx` já usa no cliente
(`contentPositionOf`/`closeUpContaining`) pra achar qual Close Up (o
menor, se houver sobreposição) contém a posição de um nome técnico
(célula de lote ou ponto avulso). Constantes replicadas e **não
compartilhadas** entre front/back (risco documentado no código): dimensão
do `floorplan.jpg` (1411×759, lida com Pillow) e `DEFAULT_CELL_SIZE`
(11.97, copiado de `FloorPlanCanvas.jsx`) — se um dia a imagem for trocada
por outra de tamanho diferente, ou esse valor mudar no front, isto aqui
precisa acompanhar manualmente.

**`FREE_KANBAN_IDS`** (`server.py`): os 2 ids fixos das "SAÍDAS" —
achados consultando `calibration.json` real pelo nome ATUAL, mas fixados
pelo `id`.

**`_user_can_pick_up_from(user, pickup_name, cal)`**: admin/Mestre sempre
podem; usuário comum sem NENHUM kanban atribuído (conta antiga, de antes
desta feature) também não é restrito — só passa a valer quando o admin
atribui pelo menos um. Destino nunca é restrito, só a origem.

**Enforcement** (3 pontos, todos com `_read_calibration()` feito ANTES de
entrar no `QUEUE_LOCK` — `CALIBRATION_LOCK` nunca é aninhado dentro de
`QUEUE_LOCK` nesse código, pra nunca arriscar ordem de lock trocada):
`_queue_enqueue_batch` (checa TODAS as origens do lote antes de aceitar
qualquer uma), `_queue_cancel_current` (checa a origem da `currentRoute`,
pulado se `force`/limit breaker), `_queue_remove_queued` (ganhou o
parâmetro `requester` que não tinha antes — checa a origem da rota
alvo, mesma regra de cancelar).

**Schema de usuário**: `isMaster` (bool) e `kanbanIds` (lista de ids)
novos em `users.json`. Validação (criação E edição,
`_create_user`/`_update_user`): usuário resultante nem admin nem Mestre
precisa ter `kanbanIds` não-vazio, senão 400. `GET /api/kanbans` (novo
endpoint, qualquer usuário autenticado): lista `{id, name}` dos Close Ups
elegíveis, já excluindo os 2 livres.

**Front** (`UsersPanel.jsx`): `.sidebar` do modo `users` entrou no grupo
`.sidebar--wide`. Checkbox "mestre" ao lado de "admin". Seção "KANBANS"
(só pra quem não é admin nem Mestre) com `KanbanPicker` compartilhado
(criação E edição): chips dos já escolhidos (clicar foca de novo no mapa)
+ "+" abre dropdown dos ainda não escolhidos (escolher já foca no mapa na
hora). Criação bloqueia o botão "Criar" até ter pelo menos 1 kanban
(mesma trava do servidor, com feedback antes de tentar salvar).

**Visual no mapa** (`FloorPlanCanvas.jsx`): novo `closeUpFocusRequest`
(mesmo espírito de `focusRequest`, mas focando um Close Up DIRETO pelo id
em vez de um ponto) — zoom + ativa o banner "VISUALIZANDO: KANBAN X"
(reaproveita `handleCloseUpClick`, o mesmo do modo Interação) E destaca o
contorno tracejado do Close Up (`CloseUpMarker`, novo estado `previewing`
= `mode === 'users' && isSelected`, reaproveitando `selectedCloseUpId` que
já existia). Áreas de Close Up agora também são desenhadas (antes só em
`closeup`/`interaction`) quando `mode === 'users'` — só a selecionada fica
visível, as outras continuam invisíveis/sem clique.

**Testado isolado** (9 cenários, `test_kanban_permission.py` — geometria
contra a calibração REAL, só leitura; permissão com dados sintéticos):
todas as 218 células reais mapeiam pra algum Close Up; nome inexistente
devolve `None`; os 2 ids livres existem na calibração real; admin/Mestre
sempre podem; usuário comum sem kanban configurado não é restrito; usuário
restrito com kanban certo pode, com errado não; usuário restrito sempre
pode no kanban livre mesmo sem tê-lo atribuído.

**Testado end-to-end via curl contra o servidor real** (`/api/kanbans`
excluindo os 2 livres; criar usuário comum sem kanban → 400; com kanban →
200; enqueue com origem FORA do kanban → 403; DENTRO do kanban → passa da
checagem de permissão, falha depois por motivo de negócio não relacionado
— confirma que o gate não bloqueia o caminho válido). Usuário de teste
removido depois.

**AINDA NÃO VALIDADO EM CAMPO COM USUÁRIO DE VERDADE** — o próximo passo é
o admin criar um usuário restrito de verdade e confirmar na prática
(enviar de dentro do kanban funciona, de fora é recusado com a mensagem
certa, Mestre cancela qualquer coisa, Mestre/usuário comum não veem
Histórico/Usuários).

## Correções diversas (2026-10-02)

- **Pinça bloqueada no mapa**: pedido do usuário — zoom por pinça de dois
  dedos não faz mais nada (`FloorPlanCanvas.jsx`, `handleTouchMove`/
  `handleTouchEnd` simplificados, removida toda a lógica de escala/posição
  do gesto). Ao detectar uma tentativa, pulsa um anel azul menta ao redor
  do botão de Interação (lupa "+") uma vez por gesto (`pinchPulseId`,
  reinicia via `key` no `<span>`). Bug corrigido no mesmo dia: faltava
  `animation-fill-mode: forwards` — sem isso, ao terminar a animação de
  700ms o anel voltava pro `opacity:1` de repouso em vez de ficar sumido
  ("o pulso nunca sumia").
- **Visualização de GRUPO no Ponto a Ponto**: clicar no grupo de "Lotes em
  sequência" em si (não numa barrinha específica) só mostrava a 1ª tarefa
  como se as outras não existissem. `viewTask.index: null` é o sentinela
  "visualizando o grupo inteiro" — o banner "VISUALIZANDO" passou a
  mostrar TODAS as N origens empilhadas e todos os N destinos empilhados
  (`CloseUpStatusBanner.jsx`, `task.pickups`/`task.dropoffs` agora são
  SEMPRE listas, mesmo com 1 item). Cada ponto continua clicável
  individualmente. Clicar numa barrinha específica dentro do grupo
  continua mostrando só aquele par, sem mudança.
- **Mandarim residual nos erros/avisos**: `HistoryPanel.jsx`,
  `displayDescription` já tinha um glossário (`KNOWN_PHRASES`) pra
  traduzir frases conhecidas, mas um código/frase NOVO em mandarim passava
  direto. Adicionado `HAN_CHARS` (regex de caracteres Han) como rede de
  segurança final: se depois das trocas conhecidas ainda sobrar qualquer
  caractere chinês, a mensagem inteira vira um aviso genérico em PT-BR com
  o código original (sempre ASCII) — garante que nenhum mandarim bruto
  chega na tela, mesmo de códigos nunca vistos. Não existe "histórico
  salvo" pra limpar: erros/avisos vêm sempre em tempo real da API do robô
  (`GET /error/records`), sem cache/arquivo nosso — a correção já cobre
  tudo, passado e futuro, automaticamente.
- **Altura padrão do pallet azul**: pedido do usuário, 7cm em vez de 8
  (`PALLET_BASE_HEIGHT_DEFAULT` em `server.py`, `DEFAULT_PALLET_HEIGHTS`
  em `useCalibration.js`, `EMPTY_CALIBRATION`) — só o `blueBase`
  ("Altura do pallet azul padrão" no editor); `blueTop` ("Altura do
  segundo pallet") não tem padrão de fábrica conceitual de verdade (ver
  comentário em `server.py`) e ficou inalterado. O `calibration.json` real
  já estava com `blueBase:7` configurado — essa mudança só ajusta o
  FALLBACK de código pra quando o valor estiver faltando (fresh install),
  sem efeito na configuração já salva.

## Alerta de robô parado (IMPLEMENTADO 2026-10-02)

**Pedido do usuário**: se o robô ficar parado por 1 minuto, com uma tarefa
de verdade em andamento, e não estiver carregando — emitir alerta
vermelho: "Robô com caminho obstruído ou desviou da rota, por favor,
utilize o modo manual para conduzi-lo à energia ou remova obstáculos
próximos."

**Implementação** (`server.py`): `_refresh_robot_status` (mesmo ciclo da
thread de fundo que já lê `base_encode` pra bateria/carga) agora também
lê `GET /reeman/speed` (`{"vx","vth"}`, confirmado no doc da SLAM WEB API)
e rastreia `_robot_status_cache["stationarySince"]` — marca o instante em
que a velocidade fica abaixo de um épsilon (`STALL_VX_EPSILON_MPS=0.02`,
`STALL_VTH_EPSILON_DEG_S=1.0`, tolerância a ruído de sensor parado) e zera
na hora que detecta velocidade de verdade (ou falha de rede, tratada como
"não sei" — zera por segurança, nunca acumula tempo errado).
`_robot_stalled_message(state)` combina isso com o estado da fila: só
alerta se `stationarySince` existe, já passou de
`STALL_ALERT_SECONDS=60`, existe alguma `currentRoute` (QUALQUER uma —
reservada esperando giro seguro pra começar/terminar de voltar pra carga,
ou já disparada de verdade, inclusive `unloadOnly` — correção do mesmo dia
a pedido do usuário: a 1ª versão só considerava rota com `taskName`,
excluindo `turnBlocked`/`awaitingCharge` por engano; obstrução por
obstáculo pode travar o robô em qualquer uma dessas situações), e não está
carregando. Exposto em `/api/live-state` como `robotStalledMessage`.

**Front**: `CancelPendingBanner.jsx` ganhou um `variant` ('warning' âmbar,
já existia; 'danger' vermelho pulsando, novo — mesma animação do
`emergency-toggle.is-active`). `robotStalledMessage` tem prioridade sobre
as mensagens de espera normal (`cancelPending`/`turnBlocked`/
`awaitingCharge`/`postPickupUnload`) no banner — é uma anomalia, nunca
fica escondido por uma espera comum.

**Testado isolado** (9 cenários, mockando `_robot_status_cache`/
`_slam_call`, nunca fala com o robô de verdade): sem `stationarySince` não
alerta; carregando nunca alerta mesmo parado há muito tempo; sem rota
nenhuma não alerta; rota RESERVADA (sem `taskName`) TAMBÉM alerta; parado
há menos de 60s ainda não alerta; parado ≥60s com rota ativa sem carregar
alerta; `_refresh_robot_status` liga o relógio com velocidade quase-zero,
zera com velocidade de verdade, e zera também se a chamada de rede falhar
(trata como "não sei", nunca assume parado por engano).

**AINDA NÃO VALIDADO EM CAMPO** — próximo teste real deve confirmar que o
alerta aparece quando o robô trava de verdade (obstáculo/desvio) e some
assim que ele volta a se mover ou termina de carregar.

## Bug: clicar no ícone já ativo jogava pro Ponto a Ponto (CORRIGIDO 2026-10-02)

**Sintoma relatado pelo usuário**: clicar no ícone de um menu que JÁ
estava aberto (marcação, interação, ou fila) saía daquele modo e caía no
Ponto a Ponto, mesmo sem o usuário ter pedido isso.

**Causa**: `handleToggleMarkMode`/`handleTogglePtpMode`/
`handleToggleInteractionMode`/`handleToggleQueueMode` (`MainApp.jsx`) eram
todos TOGGLES de verdade: clicar no ícone já ativo chamava `baseMode()`
("modo de repouso": 'ptp' pra quem não é dev, 'edit' pra quem é) em vez de
simplesmente ficar onde estava. Isso também afetava o Ponto a Ponto pra
usuário DEV: clicar no ícone de ptp estando já em ptp jogava pra 'edit'.

**Correção**: os 4 handlers agora só TROCAM de modo quando o ícone
clicado é de um modo DIFERENTE do atual — clicar no mesmo ícone de novo é
no-op (o menu correspondente continua aberto, nada acontece). Sair de um
desses modos exige clicar em outro ícone (inclusive o de Ponto a Ponto).
`baseMode()` ficou sem uso depois disso e foi removida.

## `.exe` sem interface pra rodar como Serviço do Windows (IMPLEMENTADO 2026-10-05)

**Contexto**: migração do `server.py` pra uma VM Windows Server 2019 da
empresa (`aplsrv`, IP fixo `192.168.5.252`, ver `MIGRACAO_VM.md`). O `.exe`
que já existia (`packaging/lifty.spec` → `LIFTY.exe`) é uma GUI com botão
"LIGAR SERVIDOR" pensada pra alguém com a tela na frente — não serve pra
uma VM, que precisa subir SOZINHA no boot, sem ninguém clicando em nada.

**Solução**: `packaging/lifty_headless.spec` — novo spec do PyInstaller
que empacota o PRÓPRIO `server.py` como entrypoint (não a GUI). O bloco
`if __name__ == "__main__"` no fim de `server.py` já faz exatamente o que
precisa — `start_server()` sem argumento (descoberta automática do IP do
robô na rede local, sem precisar digitar nada) + fica rodando até
`Ctrl+C`/encerrado — é o MESMO comportamento já validado a sessão
inteira rodando `python3 server.py` direto em dev. Gera `LIFTY-SERVICE.exe`
— esse é o artefato pra registrar como Serviço do Windows (ex. via NSSM),
não a GUI.

**CI**: `.github/workflows/build-exe.yml` (builda num runner Windows de
verdade — PyInstaller não compila Windows a partir de Linux) agora gera
os DOIS artefatos na mesma run: `LIFTY-windows` (GUI, como já era) e
`LIFTY-SERVICE-windows` (novo, sem interface).

## Opção "Pallet de cima" removida da versão final (2026-10-05)

Pedido do usuário: a opção de marcar o 2º andar do pallet azul (checkbox
"Pallet de cima") não vai ser entregue na versão final. Removida de dois
lugares onde era editável: `PointToPointBar.jsx` (montagem inicial da
tarefa) e `StagedTasksPanel.jsx`/`PalletPopover` (editar uma tarefa já
preparada). O estado `palletTop` em `MainApp.jsx` continua existindo (fica
sempre `false` agora, dormente) e toda a canalização até o payload que vai
pro servidor permanece intacta — backend (`server.py`,
`PALLET_TOP_LAYER`/`blueTop`) não foi tocado, só a forma do usuário
conseguir ativar isso pela UI. Reativar no futuro é só devolver os dois
checkboxes removidos.

## Bug: pallet por TAREFA num lote em sequência, não por grupo inteiro (CORRIGIDO 2026-10-05)

**Sintoma relatado pelo usuário**: num grupo de "Lotes em sequência" já
montado em "Tarefas aguardando envio", trocar o modelo de pallet pelo
ícone de uma barrinha trocava o de TODAS as tarefas do grupo junto, em vez
de só daquela.

**Causa**: `palletType` vivia só no nível da UNIDADE (`unit.palletType`),
nunca por tarefa individual (`unit.tasks[i]`) — `flattenUnits` (o que
monta a lista que vai pro servidor) lia `u.palletType` pra toda tarefa do
grupo, e o popover de troca (`handleChangeStagedPallet`) escrevia
`u.palletType` direto, afetando a unidade inteira. O servidor em si JÁ
aceitava `palletType` diferente por item desde sempre (`pair.get(
"palletType", pallet_type)` em `_queue_enqueue_batch`) — o bug era 100%
do lado do cliente, nunca chegava a mandar valores diferentes.

**Correção** (`MainApp.jsx`/`StagedTasksPanel.jsx`): `palletType` passou
a viver em cada `task` (`unit.tasks[i].palletType`), não mais só na
unidade:
- `handleStageSelection`/`handleSaveEdit`: cada tarefa nasce/mantém seu
  próprio `palletType` — reeditar origem/destino do grupo (reabrir pra
  mexer no mapa) NÃO reseta o pallet que cada uma já tinha
  individualmente; só tarefa NOVA (grupo que cresceu) herda o valor
  escolhido na hora na barra.
- `flattenUnits`: lê `t.palletType` (por tarefa), não mais `u.palletType`.
- `handleChangeStagedPallet(unitId, taskId, type)`: ganhou o parâmetro
  `taskId` — só escreve na tarefa clicada.
- `StagedTasksPanel.jsx`: `TaskBar`/`PalletSwatch` leem `task.palletType`;
  `openPallet`/`PalletPopover` carregam junto QUAL tarefa está sendo
  editada (`popover.taskId`), não só a unidade.
- `handleSelectStagedUnit`: ao abrir "Visualizar tarefa", carrega na barra
  o pallet da tarefa ESPECÍFICA sendo vista (`unit.tasks[index].
  palletType`), não mais um valor único da unidade.

`unit.palletType`/`unit.palletTop` continuam existindo como "valor de
partida" (usados só na criação da unidade e como fallback pra tarefa nova
que entra num grupo reeditado) — não são mais a fonte de verdade de
nenhuma tarefa já existente.
