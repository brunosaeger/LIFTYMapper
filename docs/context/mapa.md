# Mapa (Konva): calibração, zoom, gestos, robô ao vivo

`web/src/components/FloorPlanCanvas.jsx` (o maior arquivo do front),
`components/RobotOverlay.jsx`, `robotMap.js`, `hooks/useCalibration.js`,
`theme.js`.

Ler junto: [../../web/CONTEXT.md](../../web/CONTEXT.md) (modos),
[ponto-a-ponto.md](ponto-a-ponto.md), [ocupacao.md](ocupacao.md),
[chat-solicitacoes.md](chat-solicitacoes.md) (camada amarela),
[usuarios.md](usuarios.md) (kanbans no servidor).

## Modelo de calibração (`calibration.json`)

- `{ top: {points, lots, closeUps, robotFrame, robotWarp, routeOpacity},
  iso: {...}, occupied, palletMaterials, palletHeights }`. Só a vista `top`
  é usada; `iso` é legado (sem botão), mantido sem quebrar.
- **Ponto avulso** `{id, name, displayName, x, y, rotation, namesVisible}`;
  **lote** `{id, prefix, displayName, x, y, rotation, count, cellSize,
  scaleX, scaleY, color, namesVisible}`; **Close Up** (kanban) `{id, name,
  x, y, width, height, scaleX, scaleY}`. `x/y` em FRAÇÃO [0,1] da imagem;
  tamanhos em px de conteúdo.
- Nome técnico da célula: `lotCellName(prefix, i)` → `A`, `A2`, `A3`…
  (índice 0 sem número). Precisa bater EXATAMENTE com o ponto no robô.
  Apelido (`displayName`) é só visual: `lotCellDisplayName` numera TODAS a
  partir de 1; `displayCellName(nome, lots, points)` resolve. Toda lógica
  usa o técnico.
- `DEFAULT_CELL_SIZE = 11.97` e a imagem `floorplan.jpg` (1411×759) estão
  **duplicados** no `server.py` (`DEFAULT_LOT_CELL_SIZE`,
  `FLOORPLAN_IMAGE_*`) pra geometria de kanban — mudou um, muda o outro.
- Salvar: debounce 500 ms em `POST /api/calibration`, **só por edição do
  editor** (não salva ao carregar — um tablet com JS velho apagava ajustes
  dos outros). `calibrationStamp` no live-state muda só em POST do editor;
  os outros aparelhos recarregam sozinhos (`syncRemoteStamp`).

## Zoom e câmera

- Pinça de dois dedos **bloqueada** (pedido do usuário): só pulsa a lupa
  "+". Zoom pela roda, lupa "+" (modo Interação → toca num kanban → zoom
  animado `handleCloseUpClick`, margem 1,4×) e lupa "−" (reset; também volta
  pro modo Interação a partir de ptp/marcação/fila).
- Durante gestos de alta frequência, mutar o node do Konva direto e só
  sincronizar o estado React no fim (setState a cada `touchmove` engasgava).
- Banner "VISUALIZANDO: KANBAN X" some em qualquer mudança de ESCALA
  (roda, reset), não em pan.
- `focusRequest {name, id}` / `closeUpFocusRequest {closeUpId, reqId}`: o
  `id` muda a cada pedido (repetir o mesmo nome também dispara). Ponto fora
  de kanban: zoom 4× nele.
- Fim do zoom num kanban em Interação abre o ÚLTIMO modo de trabalho
  (`lastWorkModeRef`: Ponto a Ponto ou Marcação).
- **Mapa virado 180°** (botão ao lado do VISUALIZANDO, só neste aparelho):
  o Stage gira em torno do centro; textos de pé (`viewRotation`,
  `uprightTextProps`); câmera automática usa `flipSign`/`stagePosCentering`.
  Só desvira pelo botão ou pela lupa "−".

## Gestos (ptp, mark, request)

- Hover/dedo em cima faz a célula crescer (`usePtpScale`); a ação só
  acontece **ao soltar** (`commitOnRelease`), nunca no toque inicial.
- Touch: o Konva não dispara mouseenter ao arrastar o dedo → célula debaixo
  do dedo por `getIntersection` + atributo próprio `cellName` nos Groups.
- Pan sempre funciona, exceto começando em cima de uma célula nesses modos
  (`stage.stopDrag()` no mousedown).
- Fila/Histórico não usam toque no mapa — a seleção é pela lista.
- `highlightsRoute(mode)` decide quais modos pintam origem/destino
  (ciano/âmbar) — já houve 2 bugs por faltar um modo nessa lista (queue,
  history). Inclui os peek modes.

## Desenho das células

- `LotCell` é `memo` com props estáveis (handlers via `latestHandlersRef`);
  `themeKey` só pra invalidar o memo ao trocar tema (COLORS é mutado em
  lugar). Anéis de pulso ficam `visible={false}` em repouso (237 círculos
  invisíveis custavam desenho).
- Cores: lote = fundo translúcido na cor + borda escurecida; ponto avulso =
  laranja `#f4610a` com borda escurecida só 0,22 (o âmbar já é "destino" e
  laranja comum ficava indistinguível; 0,4 virava marrom).
- `QueueMark`: destino de tarefa na fila = quadrado laranja com o número da
  fila; se a célula está em destaque, só o número na cor do destaque; se a
  posição tem Solicitação de pallets, amarelo em vez de laranja.
- Triângulo de "facing" na célula 0 de cada lote.
- Konva não lê CSS: `theme.js` exporta `COLORS` mutável + `applyTheme`.

## Robô ao vivo (`RobotOverlay.jsx`, só vista `top`)

- Pose: `GET /api/robot-pose` (`_cached_robot_pose`: cache 0,8 s, lock não
  bloqueante), 1x/s, pausa com a aba escondida, anima com `Konva.Tween`
  (salto > 3 m teletransporta).
- Metros → px (`robotMap.js`): afim por mínimos quadrados entre pontos
  calibrados e as coordenadas do dispatch (~11,3 px/m). θ do robô aponta
  pro lado OPOSTO aos garfos. Ajuste fino no "Editar closes": `robotFrame`
  (mover/esticar, `validRobotFrame` limita escala 0,5–2 e rotação ±45° —
  já salvou scaleX 1068) e `robotWarp` (pinos "liquify"); `routeOpacity`.
  O servidor preserva esses campos se o POST não os traz.
- Ícones `assets/robot-{empty,blue,wood}{,-glow}.webp` (com pallet =
  `robotCarrying`); brilho por status (`ROBOT_STATUS`/`robotStatusOf`):
  obstáculo > planejando > cancelando > devolvendo > voltando à energia >
  carregando > operando > ocioso. Animações só com o status ativo.
- Tocar no robô (ou no painel ROBÔ do header) = quique + zoom + SEGUIR (zona
  morta 28%) + banner "VISUALIZANDO: ROBÔ". Qualquer gesto de câmera solta.
- Rota desenhada: `GET /api/route-graph` (cache 600 s, arestas de
  `/map/list/details/15`) + Dijkstra por TEMPO no front (`fastestPath`,
  bate com o dispatch em 126/130). Paradas: início → H(origem) → origem →
  H(origem) → H(destino) → destino. **Hoje só a rota clicada na
  Fila/Histórico (estática)**; o trajeto ao vivo saiu em 2026-10-30
  (`RobotOverlay` ainda sabe desenhar `live: true`).

## Camada da Solicitação de pallets

Layer própria, sem toque, por cima dos lotes (a animação redesenha só
ela). Detalhes em [chat-solicitacoes.md](chat-solicitacoes.md).

## Teste de tela

Edge headless via DevTools (ver memória `ui-test-edge-headless`):
`window.Konva.stages` dá as posições; **precisa**
`Emulation.setFocusEmulationEnabled` senão os tweens do Konva congelam no
quadro 0 (não é bug do app).
