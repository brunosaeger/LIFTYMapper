# Site (React + Vite + Konva) — arquitetura e padrões

Vite + React, **sem TypeScript**, sem router (uma tela com "modos").
`react-konva`/`konva` pro mapa. Build: `npm run build` → `web/dist` (o
`server.py` serve do disco).

Contextos de funcionalidade: [mapa](../docs/context/mapa.md),
[ponto a ponto/fila](../docs/context/ponto-a-ponto.md),
[ocupação](../docs/context/ocupacao.md),
[chat/solicitações](../docs/context/chat-solicitacoes.md),
[usuários](../docs/context/usuarios.md),
[histórico](../docs/context/historico.md),
[avisos](../docs/context/avisos-robo.md).

## Arquivos

- `App.jsx` — só autenticação: `GET /api/session` → `LoginScreen` ou monta
  `MainApp` (montado só depois da sessão: os hooks carregam no 1º render).
  Repassa a resposta INTEIRA da sessão (não filtrar campos).
- `MainApp.jsx` — estado raiz: modo, seleções, lista de envio, regras de
  validação no clique (o gate real é o servidor), handlers de modo. O mais
  denso; comentários explicam o porquê.
- `components/FloorPlanCanvas.jsx` — o mapa (ver mapa.md).
- Hooks de dados (cada um dono de uma fonte):
  - `useCalibration.js` — pontos/lotes/closeUps/robotFrame… + save debounced.
  - `useLiveState.js` — fila, ocupação, materiais, reservas, avisos; poll
    de `/api/live-state` a cada 4 s e ações (`enqueueRoutes`,
    `cancelCurrent`, `removeQueued`, `reorderQueue`, `setOccupiedMany`,
    `setPalletMaterial`…).
  - `useChat.js` — chat + marcas de solicitação (poll 4 s).
- `api/lifty.js` (proxy: `fetchErrorRecords`, calibração, route-log),
  `api/auth.js`, `api/chat.js`.
- `theme.js` (`COLORS` mutável + `applyTheme`; Konva não lê CSS),
  `robotMap.js`, `sounds.js`, `utils.js` (`generateId`).
- CSS: `App.css` (componentes) e `index.css` (tokens, temas).

## Regra de ouro: efeito da ação NA HORA

Toda ação do usuário mostra o resultado imediatamente — nunca esperar o
próximo poll de 4 s. `useLiveState` faz `await refresh()` depois de cada
ação; se a ação muda dado de OUTRA fonte (ex.: marcar material mexe nas
marcas do chat), atualizar essa fonte também (ou otimista + confirmação).
Já errado em 2026-11-26 (amarelo levava 4 s pra sair).

## Modos (`mode` em MainApp)

| modo | como entra | quem |
|---|---|---|
| `ptp` (padrão) | botão flutuante de rota | todos |
| `mark` | botão do pallet | todos |
| `interaction` | lupa "+" | todos |
| `queue` | botão de lista | todos |
| `chat` | balão no canto superior esquerdo | todos |
| `request` | mãozinha do chat | todos |
| `history` | aba do Toolbar | admin ou modo dev |
| `users` | aba | admin |
| `edit`, `closeup` | abas | modo dev |

- Botões flutuantes à direita do mapa, de cima pra baixo: lupa "−"
  (reset), lupa "+", Marcação, Ponto a Ponto, Fila. Chat no canto superior
  esquerdo (onde era a emergência, removida).
- **Clicar no ícone do modo já ativo não faz nada** (já houve bug jogando
  pro Ponto a Ponto).
- **Peek modes** (`isPeekMode`: interaction, mark, chat, request) preservam
  a seleção do Ponto a Ponto (`resetSelection({ keepRoute })`); todo handler
  de troca calcula `keepRoute = isPeekMode(mode)` com o modo ATUAL.
  `highlightsRoute` (mapa) precisa incluir o modo pra o destaque não sumir.
- **Trava da Solicitação de pallets**: em `request`, todo handler de troca
  chama `blockedByRequest()` primeiro. Handler novo de modo também precisa.
- Sidebar: `.sidebar` normal; `--wide` (448 px) em ptp, queue, history,
  users, chat, request; o `CloseUpStatusBanner` recebe `wide` nesses modos.

## Modo desenvolvedor

Botão `{ }` no Toolbar com senha (`DEV_PASSWORD` no bundle — **só trava de
UI, não é segurança**). Persiste por conta no `localStorage`. Libera
"Editar pontos" (com "Altura de pallets", pontos, lotes), "Editar closes"
(com "Ajustar grafo do robô"), "+ Ponto"/"+ Lote", Histórico, lixeira da
Fila e o **Limit Breaker** (Doomguy, `doomguy-*.png`, renova a licença a
cada 4 s — ver fila.md). Sair do modo dev desliga o Limit Breaker.

## Interface: padrões e armadilhas resolvidas

- **Nunca `crypto.randomUUID()`** — não existe em HTTP puro por IP (o
  tablet); falhava calado. Usar `generateId()`.
- Altura: `.app`/`.login-screen` usam `var(--app-vh, 100vh)` medido em
  `main.jsx` por `window.innerHeight` (tablet Lenovo ZUI mentia no 100vh).
- Menu de contexto bloqueado no app inteiro (`main.jsx`, exceto
  input/textarea), `user-select: none` no body, `-webkit-user-drag: none`.
- Arrastar em listas (StagedTasks, Fila): hold ~280 ms, tolerância 8 px,
  `touch-action: pan-y` pra rolagem nativa; clique de seleção no `<li>`
  raiz (o `setPointerCapture` quebra cliques em filhos).
- Animação com `transform`/`opacity` (placa de vídeo); halo por
  `box-shadow` em vez de escala (escala criou barra de rolagem).
- Toasts `showToast(msg, 'info'|'success'|'error')`; pulso vermelho no mapa
  em recusa de clique.
- Textos visíveis em português: "tarefa(s)", nunca "task".
- Manual: ícone "i" (`ManualInfoButton`) abre `ManualViewer` com páginas
  JPEG pré-renderizadas — operador `public/manual/` (Ponto a Ponto pág. 19,
  Ocupação 25, Fila 27), admin `public/manual-admin/` (Usuários 2, Novo
  usuário 4, Histórico 3). PDF mudou: `pdftoppm -jpeg -scale-to-x 1400`,
  nomes `p-01.jpg`.
- Tema: escuro padrão; claro = paleta bege do usuário; acentos e cores de
  estado iguais nos dois (são funcionais). Faixas escuras sobre o mapa
  redefinem os acentos.
- Ícones do app em `public/` + `manifest.json`.

## Teste de tela

Edge headless via DevTools contra uma cópia isolada do servidor (porta
8011, usuários de teste) — ver a memória `ui-test-edge-headless`. Nunca
testar contra a VM nem contra o servidor que fala com o robô.
