# Status e avisos do robô (banners, alertas, sons)

Tudo que o tablet mostra sobre o estado do robô é calculado na **thread de
fundo** do `server.py` (um GET por tick, não um por tablet) e só lido pelo
site via `GET /api/live-state`.

Ler junto: [fila.md](fila.md) (estados de espera), [robo-api.md](robo-api.md),
[../../robot-bridge/CONTEXT.md](../../robot-bridge/CONTEXT.md) (sensores),
[mapa.md](mapa.md) (robô desenhado no mapa).

## Regra do usuário (memória `obstacle-alert-rule`)

**Parou e foi por obstrução → avisa, sempre.** Sem exceção por geometria
(faixa de encaixe, raio do carregador etc. foram removidos em 2026-11-13
depois de paradas reais que o tablet não mostrou). Só não avisa quando o
motivo da parada é conhecido (planejador, carregando, emergência) ou a
leitura é 0-2 cm (sensor mascarado pelo app). Aviso falso se corrige com
dado do robô, nunca com distância/posição.

## Status no header (`RobotStatusBanner.jsx`, dentro do Toolbar)

- `robotCharging` = `chargeFlag == 2` de `/reeman/base_encode` (confirmado);
  `robotBattery` (0-100, `_normalize_battery`); `robotReturningToCharge`
  (AUTO_SYSTEM ativa e não carregando). Cache em memória
  `_robot_status_cache`; `null` = ainda não leu (o banner não mostra nada);
  se o robô cair, mantém o último valor.
- Estados: EM OPERAÇÃO (menta), RECARREGANDO (âmbar), VOLTANDO À ENERGIA
  (laranja). Pilha com 4 barras (`ceil(battery/25)`), cor pelo nível:
  < 20% vermelho, < 50% âmbar, senão menta.
- Tocar no painel ROBÔ = zoom e seguir o robô (ver mapa.md).

## Banner de avisos (`CancelPendingBanner.jsx`)

Uma mensagem por vez, nesta prioridade (MainApp):
1. `robotStalledMessage` — **vermelho** (`danger`, pulsa, som em loop
   `warningtrue` até sumir). Fontes:
   - obstáculo (`_refresh_obstacle`);
   - câmera sem reconhecer o pallet (`_refresh_camera_watch`);
   - planejamento passando de 140 s (`ROUTE_PLANNING_LATE_MESSAGE`);
   - navegação travada (`NAV_FREEZE_MESSAGE`).
2. Esperas **âmbar** (`warning`, som `notiftrue` 1x): `cancelPendingMessage`,
   `turnBlockedMessage`, `awaitingChargeMessage`, `postPickupUnloadMessage`
   (nunca coexistem).
3. `routePlanningMessage` — **menta** (`info`).

### Obstáculo (`_refresh_obstacle`, thread própria de 1 s)
- Só com rota disparada (ou voltando pra energia), sem emergência, fora da
  carga e fora do "planejando".
- Com bridge novo: avisa **só pelo sinal `blocked`** do bridge (pacote
  `D0 05` do `raw_data_stream`) + parado ≥ `OBSTACLE_STOPPED_SECONDS` (5 s).
  O LADO vem dos campos do `fork_info`.
- Bridge antigo: leitura ≤ distância de desvio do trecho
  (`/avoid_distance`) + 3 cm; sem `avoid`: frente 85, trás 60, laterais 55.
- Ignora: traseira com pallet no garfo (enxerga o próprio pallet), lado com
  avoid 0, leitura ≤ 2 cm. `isNavigating` NÃO serve de filtro (manobras de
  encaixe não contam como navegação).
- Mensagens `OBSTACLE_*_MESSAGE` com a distância + "Remova o obstáculo ou
  utilize o modo manual para levá-lo à energia." Traseira = "SENSOR DO
  GARFO detectou um obstáculo".
- Sem bridge não há aviso de obstáculo (a vigia religa em 30–60 s).

### Câmera não reconhece o pallet (`_refresh_camera_watch`)
Rota com coleta pendente + falha da câmera ≤ 30 s → vermelho com o apelido
da posição e o nº de tentativas. Some ao reconhecer, ao coletar, ao começar
outra rota, ou 5 min depois. Causa comum: frente do pallet azul
descascada/escura.

### "Planejando a rota" (`_refresh_route_planning_wait`)
Rota disparada que ainda não está RUNNING, robô parado, não carregando, e no
corredor: distância à reta **P3–P10** ≤ 1,2 m, ou sobre o eixo do docking
de `ROUTE_PLANNING_SLOW_POINTS` (EXE, EXE2, EXM, EXN, EXO, EXP, EXQ, EXF,
EXF2, EXF3; raio 0,6 m). Menta até 140 s, depois vira vermelho. Durante a
espera o aviso de obstáculo não dispara. Causa real do atraso: planejador
do dispatch (ver robot-bridge). A fábrica disse que ~140 s "não é problema".

### Navegação travada (`_refresh_nav_freeze_watch`)
O dispatch grava UMA vez em `/error/records` "Navigation does not issue
current coordinates" quando a navegação para de passar a posição (ex.: lidar
caindo e voltando). Registro novo (id acima do que existia ao subir) liga
"Erro inesperado. O robô precisa ser reiniciado." Apaga quando o robô anda
0,5 m ou fica 20 s sem responder (reiniciando). Só avisa.

### Removidos (não recriar)
"ROBÔ PARADO!" por tempo parado sem olhar sensor, e o chute "sensor do
garfo" por posição perto da origem (`_refresh_stall_at_origin`). A
`stationarySince` continua (usada pelo "planejando").

## Modo sombra — pallet empurrado na coleta (`_refresh_dock_shadow`)

Só REGISTRA, não para o robô e não mostra nada no tablet
(`DOCK_SHADOW_ENABLED`). Bridge `/dock-shadow`: razão −Δdis_x(câmera)/Δodom;
< 0,25 = empurrando. Servidor: profundidade da pose no eixo (limite −0,30 m).
Grava em `dock_shadow.jsonl` (fora do git) e no log com prefixo `Sombra:`
("normal" ou "TERIA PARADO"). Pendente: revisar o arquivo depois de alguns
dias; parar de verdade só com zero alarme falso e decisão à parte.

## Sons (`web/src/sounds.js`, `web/public/sounds/`)

`notif.mp3` 1x quando chega mensagem de OUTRO usuário no chat (ver
chat-solicitacoes.md); `notiftrue` 1x nos avisos amarelos; `warningtrue` em loop no vermelho;
`chargeready` + brilho verde quando começa a carregar; `failedtrue`
(0,6) em clique inválido; `opoveshchenie` + brilho azul no ícone da Fila
quando uma tarefa da fila começa.
