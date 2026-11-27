# Fila de rotas e ciclo de vida da tarefa (server.py)

O `server.py` é a **única autoridade** da fila: só ele fala com o robô pra
disparar/cancelar/sondar. Os navegadores leem `GET /api/live-state` (poll de
4 s) e mandam INTENÇÕES (`/api/queue/*`). Isso existe porque ~10 tablets
precisam ver a mesma fila e nunca podem disparar a mesma coisa duas vezes.

Ler junto: [robo-api.md](robo-api.md) (endpoints e comportamentos do robô),
[ocupacao.md](ocupacao.md) (validação de cadeia, ocupação automática),
[avisos-robo.md](avisos-robo.md) (mensagens de espera e alertas),
[ponto-a-ponto.md](ponto-a-ponto.md) (como o operador monta o envio),
[../../robot-bridge/CONTEXT.md](../../robot-bridge/CONTEXT.md) (check-turn).

## Estado (`queue_state.json`, gitignored)

- `currentRoute` — a rota da vez (no máx. 1). **Invariante: só ela pode ter
  `taskName`** (= já foi disparada no robô). Sem `taskName` = RESERVADA,
  esperando liberar o disparo.
- `pendingRoute` — a próxima (no máx. 1), **nunca disparada antes da hora**.
- `routeQueue` — o resto.
- Flags: `pickupCleared` (o PICKUP da atual já terminou), `cancelPending`,
  `turnBlocked`, `awaitingCharge`, `currentRouteFresh`, `emergency`, e os
  dos alertas (ver avisos-robo.md).
- Cada rota guarda `pickup`, `dropoff`, `palletType`, `palletTop`,
  `palletHeights`, `user` (da SESSÃO, nunca do payload) e `groupId` (só
  quem veio em sequência/grupo). Pallet e altura são capturados no
  enfileiramento — mudar depois não afeta rota na fila.

Locks: `QUEUE_LOCK` (fila) e `CALIBRATION_LOCK` (calibração/ocupação).
**Ordem fixa: QUEUE_LOCK antes de CALIBRATION_LOCK**, nunca invertida.
Chamada de rede que pode demorar (check-turn, pose/alinhamento, garfo,
cancelamentos do "limpar fila") roda **fora** do lock, pra não travar o
`live-state` de todo mundo. Exceção consciente: o próprio disparo
(`_fire_route`, criar template + task-fast) roda dentro do `QUEUE_LOCK` —
até ~10-20 s no pior caso; aceito pra ~10 tablets, bem mais simples que
reservar/soltar/readquirir.

## Thread de fundo (`_queue_tick`)

Daemon parável (`_queue_stop` Event, `_start_queue_thread` idempotente),
tick a cada `QUEUE_POLL_INTERVAL_SECONDS` (4 s), mais rápido em esperas
(`CANCEL_PENDING_POLL_INTERVAL_SECONDS` 2 s; 0,5 s na janela de cancelamento
pré-pickup; 1,5 s nos 20 s depois de um disparo). Dorme em
`_queue_wake.wait()` — `_poke_queue_thread()` acorda na hora quando entra
`cancelPending`/`turnBlocked`/`awaitingCharge`. É dona exclusiva de avançar
a fila:
1. lê o status do robô (`_refresh_robot_status`: carga/bateria, cache em
   memória);
2. sonda a `currentRoute` por nome em `task-record/page`;
3. marca/desmarca ocupação (ver ocupacao.md, "Caso 2");
4. `FINISHED`/terminal → `_apply_record_status` → `_advance_queue_locked`
   (reorganização puramente LOCAL) → `_try_dispatch_current` (dispara a
   promovida no mesmo tick).

`_reconcile_queue_state_on_startup`: ao subir, confere no robô o status
real da `currentRoute` que sobrou em disco antes de aceitar requisições.

## Disparo (`_try_dispatch_current` → `_fire_route`)

Só a `currentRoute` dispara, e só quando liberada:
1. Rota **fresca** (`currentRouteFresh`: entrou com a fila vazia, só via
   enqueue) + robô voltando pra carga (`_robot_returning_to_charge_now`:
   existe `AUTO_SYSTEM` ativa e não está carregando) → segura e marca
   `awaitingCharge` ("aguardando o robô chegar na energia"). Rota
   **promovida** nunca espera isso: uma AUTO_SYSTEM vista na troca é só um
   blip e o `_fire_route` mata ela.
   - Por que "fresca" e não margem de tempo: margem de tempo foi tentada e
     não distingue blip de retorno genuíno (bug de campo 2026-09-25).
2. Carregando de verdade (`charging`) → pula o check-turn (o nicho do
   `energy` sempre dá `safe:false`, mas a saída não exige girar —
   `mustTurn: false` no ponto).
3. Senão pergunta `robot_can_turn_safely()` (bridge, 180°). `True`/`None`
   (bridge fora) → dispara (fail-open); `False` → `turnBlocked`.
   **Hoje `TURN_CHECK_ENABLED = False`** (decisão de 2026-10-15, VM sem o
   check-turn): devolve `None` na hora, então `turnBlocked` não aparece na
   prática. O check-turn também oscila true/false com o robô parado (é
   leitura viva de sensor) e é calculado por um nó diferente do que dá o
   `ROTATE_ERROR` (`main_forklift_node` × `move_base`) — não é garantia.
3b. Saindo da energia (carregando): sobe o garfo pra altura de navegação
   antes de `_fire_route` (ver "Garfo" abaixo).
4. `_fire_route`: acha a `AUTO_SYSTEM` de carga ativa **antes** de criar a
   rota (depois, o registro mais recente já seria o nosso), cria e dispara
   a rota, cancela a carga **por id** (nunca `all-cancel`), e faz uma
   **segunda checagem depois** (`robot_find_any_active_charge_task_id`,
   olha os últimos 3 registros) pra pegar uma AUTO_SYSTEM retardatária
   que nasceu na fresta. Disparar antes de cancelar evita o robô ficar
   sem task (e recriar a carga).

**Não fazer de novo (tentado e removido em 2026-09-24)**: assumir o retorno
pra carga com task própria (`LIFTY_AUTO_CHARGE_RETURN`), suprimir a
AUTO_SYSTEM nativa, ligar/desligar o `obs3d` no giro. Causou o robô
"gaguejando" (nasce/gira/é cancelada em loop). Decisão do usuário: deixar
a AUTO_SYSTEM nativa em paz, aceitando o risco de travamento seco.

## Enfileirar (`POST /api/queue/enqueue-batch`)

Recebe `pairs` (1 no modo normal, N numa lista de envio), cada um podendo
trazer `group` (chave do cliente ou `null`), `palletType`, `palletTop`.
Sob `QUEUE_LOCK`, antes de despachar qualquer coisa:
- horário de operação (409 `operationBlocked`, ver [usuarios.md](usuarios.md));
- kanban do usuário pra origem;
- `validate_route_chain` (cadeia com ocupação projetada — ver ocupacao.md);
- destino com Solicitação de pallets pedindo outro material
  (`_pallet_request_mismatch`, 409 `materialMismatch`, ver
  [chat-solicitacoes.md](chat-solicitacoes.md));
- conflito com rota ativa (`_active_routes` + `_find_route_conflict`: o
  pickup ou dropoff novo bate com pickup ou dropoff de qualquer rota ativa)
  → 409 nomeando a posição e quem enviou a outra;
- material conhecido na origem.
Uma recusa barra o lote inteiro (nunca despacha metade). Devolve o `slot`
do primeiro par (`current`/`pending`/`queued`). Avulsas ficam sem
`groupId`; cada grupo ganha o seu. Sem `group` em nenhum par = formato
antigo (lote inteiro vira um grupo, pallet único).

## Cancelar

### `POST /api/queue/cancel-current`
- Rota reservada (sem `taskName`) → `_cancel_reserved_current_locked`: só
  remove local e avança.
- Rota disparada → decide se pode cancelar **agora**
  (`_current_route_cancel_ready`):
  - **antes do pickup**: espera o robô estar no docking point `"H" + pickup`
    (ex. `CD` → `HCD`) já alinhado com o `theta` PRÓPRIO calibrado do ponto
    de pallet (margem 30°), antes da câmera começar o reconhecimento.
    Já erramos: usar o rumo `atan2` docking→pallet dava 180° de diferença
    do `theta` calibrado. Validado em campo.
    **Regra do EIXO** (`_docking_alignment_cancel_ready` /
    `_docking_axis_geometry`, 2026-10-23, substituiu o raio de 1,5 m que
    liberava de LADO, ex. ao lado do P16 a 1,45 m do HFD): eixo = reta
    pallet → H no sentido do `theta` do pallet; `s` = posição ao longo dele a
    partir do H (+ = à frente). Libera só com lateral ≤ 0,35 m,
    `-0,2 ≤ s ≤ +1,0` e diff ≤ 30°. Lotes F*: o robô gira no **P5** (0,7 m à
    frente do HFD, sobre o eixo) e entra de ré — o cancelamento libera lá.
    O log de cada checagem traz pose, ponto mais próximo, `s`, lateral e diff.
  - Sem pose e sem check-turn → `False` (fica pendente; antes cancelava onde
    estivesse). Limit Breaker força.
  - Pickup que acabou de terminar pode nunca aparecer como FINISHED (o
    cancelamento contamina o status da ação). Por isso
    `_resolve_pickup_cleared_for_cancel` faz uma checagem FRESCA de
    `action-record` antes de cancelar (nunca regride de True).
  - **depois do pickup**: check-turn.
  - `None` (pontos/pose indisponíveis) → cai pro check-turn.
  - Não dá ainda → `cancelPending=True`, mensagem
    `CANCEL_PENDING_MESSAGE` ("Aguarde até o robô chegar a uma posição
    válida para giro seguro..."), a rota segue normal e a thread tenta de
    novo sozinha. Clique repetido é idempotente.
- `_execute_cancel_current_locked`: cancela por id, `robot_stop_navigation`
  (`cmd/cancel_goal`, best-effort), avança a fila.
- Depois de cancelar pela regra do eixo (nunca no forçado): sobe o garfo
  pra 300 mm (ver "Garfo").
- Cancelamento com o pallet já no garfo → UNLOAD isolado de volta à
  ORIGEM (ver "Cancelamento pós-pickup" abaixo).
- Quem pode: a origem da rota precisa estar no kanban do usuário
  (Admin/Mestre sempre) — vale pra cancelar e pra remover da fila.

### Dependentes caem juntos (`_drop_dependents_from_queue`)
Cancelar/remover uma rota (por qualquer caminho, inclusive task morta por
fora) derruba em cascata:
- o resto do seu grupo de sequência (`groupId`, `_drop_group_from_queue`)
  — só as seguintes; a anterior não é tocada;
- quem tem a rota em `dependsOn`: no enqueue, `_batch_dependencies` refaz a
  cadeia sem cada tarefa; toda posterior que fica inválida depende dela
  (só dentro do MESMO envio).

### `POST /api/queue/remove-queued`
Remove qualquer rota ainda não disparada (pending ou fila) — puramente
local. Grupo: leva junto as seguintes do grupo. Idempotente.

### Limpar fila (`POST /api/queue/clear-all`)
Lixeira da Fila: Admin ou Mestre (servidor; o botão aparece também no modo
dev). Sem tratamento nenhum: zera o estado (mantém o flag de emergência),
registra todas como canceladas no histórico e, fora do lock, cancela no
robô cada rota que já tinha `taskName` + `cancel_goal`. Sem giro seguro e
sem devolver pallet. Pede confirmação na tela; depois um operador instruído
leva o robô à base no modo manual.

### Reordenar (`POST /api/queue/reorder {taskId, toIndex}`)
Arrastar em "Próximas rotas". Recusa a `pendingRoute` (400), origem fora
do kanban do usuário (403) e ordem que quebra a cadeia (`validate_route_chain`,
400). Unidade = rota avulsa ou grupo inteiro (`_group_queue_units`, mesmo
algoritmo do `groupWaitingRoutes` do front). Idempotente se a rota já saiu.

### Limit Breaker (modo dev, só admin)
Licença em memória (`_limit_breaker`, expira em `LIMIT_BREAKER_LEASE_SECONDS`
= 12 s, o tablet renova a cada 4 s em `POST /api/dev/limit-breaker`). Vale
pro sistema inteiro enquanto ativa: cancela na hora (sem eixo/giro), dispara
sem `turnBlocked`/`awaitingCharge`, e cancelamento pós-pickup **sem devolver
o pallet** (`skipPostPickupUnload`). Nunca fica ligado esquecido: fechar a
página para de renovar; reiniciar o servidor zera.

## Cancelamento pós-pickup (UNLOAD isolado) — validado em campo

Cancelar com o pallet no garfo (`pickupCleared`):
1. O robô segue até o DESTINO só pra usar o docking dele como lugar seguro
   pra cancelar (mesma regra do eixo, contra o ponto de destino).
2. Cancelou → `pendingPostPickupUnload` com `dropoff = pickup da rota
   cancelada` (**devolve à ORIGEM** — já erramos entregando no destino; o
   usuário quer abortar a entrega, não completá-la). A fila normal espera.
3. `_try_dispatch_post_pickup_unload` cria `POST /task-template/generic/chain`
   com UMA ação UNLOAD (o site do fabricante recusa, a API aceita; o
   `taskChainId` é o id do task-record). Vira `currentRoute` com
   `unloadOnly: True`, `pickup: None`, sem `groupId`. Sondada por ID
   (`robot_fetch_task_record_by_id`), não por nome.
4. Falha de rede ou UNLOAD terminado sem sucesso → **não desiste**, volta a
   ficar pendente (o pallet continua no garfo).
5. Passa pelo mesmo `_create_task_cancelling_charge` das rotas normais
   (checa AUTO_SYSTEM antes, cancela depois, 2ª checagem, vigia de 20 s) —
   sem isso o robô foi pra energia antes de receber o UNLOAD.
- Tela: `postPickupUnloadMessage`; Fila mostra "DESCARREGANDO EM: {apelido}"
  **sem botão de cancelar**; Histórico mostra "Descarregando em: X".
- Lacunas conhecidas: emergência no meio limpa sem tratamento; um
  `unloadOnly` que trava (ex. `LOCATION_LOST`) não tem saída pela UI — só
  "limpar fila".
- Operacional: **não trocar pro modo manual** com "cancelamento pendente" ou
  "descarregando em X" na tela (o robô passa a obedecer a manopla, e o
  sistema perde a corrida).

## AUTO_SYSTEM "sequestrando" a rota

A REEMAN pode criar a AUTO_SYSTEM de carga ~1 s DEPOIS da nossa rota (que
ainda espera atribuição, até ~4 s) e atribuir a dela primeiro.
`_cancel_charge_task_hijacking_route`: a cada tick, com a `currentRoute`
disparada e não terminada, cancela qualquer AUTO_SYSTEM ativa (últimos 3
registros). Nos 20 s depois de um disparo (`ROUTE_FIRED_WATCH_SECONDS`) o
tick roda a cada 1,5 s. Fila ociosa/rota reservada/recém-terminada não
passam por aqui — a volta pra carga genuína segue livre.

## Destravar `ROTATE_ERROR` ("empurrãozinho")

Girar o robô na mão sempre destrava (o travamento é do `move_base`, não
falta de espaço). `_recover_from_rotate_error_if_stuck` (no tick, só com a
fila ociosa e sem carregar): `ROTATE_ERROR` novo em `/error/records` →
cancela a task travada → `cancel_goal` → acha o ponto calibrado mais
próximo e usa o **`theta` PRÓPRIO** dele (não um rumo calculado) só pra
saber a DIREÇÃO → check-turn de 20° exigindo `True` explícito →
`_send_rotate_nudge`: `cmd/speed vth ±0,15` a cada 0,25 s por 3 s, com
`finally` mandando `vth:0`. `cmd/turn` está quebrado no firmware (400
"Request body is not correct") — não usar.
**Testes que chamam `_queue_tick()` precisam mockar
`robot_fetch_recent_error_records`** (já houve teste chamando o robô real).

## Garfo na altura de navegação

O app do robô só sobe o garfo pra 300 mm quando volta a navegar depois de
concluir uma ação; depois de cancelamento ou de chegar na energia ele pula,
e a coleta seguinte sai com o garfo no chão (entra no pallet ~2,5 cm mais
alto). `robot_fork_to_nav_height` (`FORK_NAV_HEIGHT_ENABLED`) chama o bridge
`POST /fork-nav-height` (publica `208 4 25 1 44 1` em
`/mobile_base/commands/send_to_base`): depois de cancelamento pela regra do
eixo, e saindo da energia. `_refresh_fork_after_drop`: depois de um depósito
FINISHED, vigia a ré no eixo e sobe o garfo quando `s ≥ -0,10 m` (não sobe
se saiu do eixo, passou de 60 s, ou o H da próxima coleta cai na faixa).
Formato do comando: texto `208 4 25 1 <lo> <hi>`, altura em mm, 16 bits
little-endian (`44 1` = 300 mm, `60 0` = coleta do azul). Validado em campo.

## Limpezas automáticas

- `_clear_stale_queue_on_startup`: ao subir, descarta fila, próxima, rota
  reservada e UNLOAD pendente (cancelando no robô o que tinha `taskName`).
  A rota em andamento disparada fica (a reconciliação limpa se já acabou).
  Emergência e ocupação ficam.
- `_refresh_idle_queue_timeout`: fila sem mudar nada por 1 h
  (`QUEUE_IDLE_TIMEOUT_SECONDS`, impressão digital persistida em
  `idleFingerprint`/`idleSince`) → tira pending/fila/reservada e põe a rota
  em andamento em `cancelPending` (mesmo fluxo do botão). Nunca cancela o
  UNLOAD isolado.

## Emergência (`POST /api/queue/emergency`)

Sem botão no site desde 2026-10-29 (o chat ocupa o lugar dele), mas o
endpoint e a supressão no tick continuam: liga = `cancel_goal` +
`all-cancel` + limpa a fila + flag `emergency` (enqueue dá 409); o flag
**sempre engata**, mesmo se o robô não responder. Best-effort: não
substitui o E-stop físico.

## Testes

Isolar sempre: mockar `_robot_call`/`_slam_call`/`_robot_try_cancel`/
`robot_stop_navigation` e `_read_queue_state`/`_write_queue_state` — nunca
o `queue_state.json` real nem o robô. Ver também a memória do Edge headless
para testes de tela.
