# API do robô REEMAN (dispatch service + SLAM)

Referência do que foi **validado no robô de verdade**. Quem chama é o
`server.py` (funções `robot_*` e `_slam_call`) — o navegador não fala com o
robô (exceção: `GET /error/records`, lido pelo painel Histórico pelo proxy).

Robô: REEMAN `rbot55f` (Hercules 3.0), hostname `rbot55f-260318-003-001`,
IP na wifi `192.168.5.195` (pode mudar — ver [servidor.md](servidor.md),
descoberta do IP). PDFs do fabricante em `docss/` (dispatch third-party
API, SLAM WEB API 3.0, SLAM 3.0 API serial, calling API).

Ler junto: [fila.md](fila.md) (quem usa quase tudo isto),
[avisos-robo.md](avisos-robo.md) (leituras de estado/erro),
[../../robot-bridge/CONTEXT.md](../../robot-bridge/CONTEXT.md) (o que só
existe via ROS/SSH).

## 1. Dispatch service

- Base: `http://{ROBOT_HOST}/api/reeman-dispatch-service{endpoint}`.
- Resposta: `{"code": 0, "message": ..., "data": {...}}`; `code=0` = sucesso.
- **Sem autenticação.**
- Projeto: **15 ("单机项目")** desde a atualização do dispatch de
  2026-10-21 — `ROBOT_PROJECT_ID` (server.py) e `PROJECT_ID`
  (`web/src/api/lifty.js`). O 13 ("APItest") ficou só com histórico.
- **Por que o proxy existe**: `task-fast` usa `Content-Type:
  application/json` → o navegador faz preflight OPTIONS, que o dispatch não
  responde → chamada direta do navegador é bloqueada (curl não mostra,
  porque ignora CORS). Por isso tudo passa pelo `server.py`.

### Endpoints usados

| Endpoint | Uso |
|---|---|
| `POST /task-template/create` | Cria template (`taskActionList` PICKUP/UNLOAD). `id:null` = criar. Nome repetido no projeto é recusado (`code 1`, "任务模版名称已存在"). |
| `GET /task-template/page?projectId&page&size&name&description` | Busca template por nome — **reaproveita** em vez de criar de novo (`robot_find_task_template_id`). |
| `POST /task-template/generic/task-fast/{id}` | Dispara um template. **Não devolve `taskRecordId`** — a correlação é pelo nome (ver abaixo). |
| `POST /task-template/generic/chain` | Dispara uma cadeia avulsa (usado no UNLOAD isolado do cancelamento pós-pickup, ver [fila.md](fila.md)). |
| `GET /task-record/page?projectId&page&size&status&name` | Registros de execução, mais recente primeiro. `taskType`: `FAST` (nossas), `AUTO_SYSTEM` (do robô, ex. ida pra carga `energy_...`). |
| `POST /task-record/cancel/{taskRecordId}` | Cancela UMA task por id (cancelamento normal, task de carga órfã, `pendingRoute`). |
| `POST /task-record/all-cancel/{projectId}` | Cancela tudo do projeto. Só na emergência — nunca no cancelamento normal (pegaria a rota nova junto). |
| `GET /action-record/list/{taskRecordId}` | Ações (PICKUP/UNLOAD) de uma task com `status`/`startTime`/`finishTime`. Base da marcação automática de ocupação. |
| `GET /error/records?projectId&page&size` | Log de erros/avisos do AGV: `records[]` com `id, agvId, error, level, description, happenTime, isRead`. `description` vem em chinês. |
| `GET /map/point/list/{map}` | Pontos calibrados com `position: [x,y,theta]` — mesmo referencial de `/reeman/pose`. |
| `GET /agv/page?projectId=…` | Versões do AGV (app/navegação/MCU). |
| `GET /map/list/details/15` | Grafo do mapa (`edges`) — base do `/api/route-graph`. |
| `GET /action-type/list-all` | Tipos: `FAST, TIMED, TEMP_TASK_CHAIN, CAMERA, AUTO_SYSTEM, BUTTON_TASK` (não usado). |

### Status de task-record

Confirmados ao vivo: `WAITING`, `ASSIGNED`, `RUNNING`, `FINISHED`,
`CANCELLED`, `FAILED`. **Só `FINISHED` é sucesso.**
`_is_terminal_status` usa uma allowlist ampla e case-insensitive
(`FINISHED CANCELLED FAILED ERROR ABORTED STOPPED EXCEPTION TIMEOUT
TERMINATED`). Já mordeu: o código só olhava FINISHED/CANCELLED e uma rota
`FAILED` ficava "em andamento" pra sempre. Cancelar algo que já morreu: o
robô responde 4xx → tratar como "já morreu, limpa local" (só 5xx/rede
mantém a rota).

Muitos registros ficam com `startTime=None` mesmo o robô tendo executado —
o canal robô↔dispatch (MQTT no NUC) perde eventos quando a wifi está ruim.

### Criação dinâmica de task

Pré-cadastrar uma task por par origem→destino é inviável (centenas de
combinações), então o servidor cria na hora (`robot_create_and_run_route`):

```js
{ name: pickup + 'to' + dropoff + sufixoDoPallet, description: "",
  supportRobotTypes: ["犀牛2.0"], projectId: ROBOT_PROJECT_ID, id: null,
  taskActionList: [
    { targetMap: ROBOT_TARGET_MAP, targetPoint: pickup,  action: "PICKUP", groupId: 1, serialNumber: 1, params: <pallet> },
    { targetMap: ROBOT_TARGET_MAP, targetPoint: dropoff, action: "UNLOAD", groupId: 1, serialNumber: 2, params: null },
  ] }
```

- `targetPoint` é o nome TÉCNICO do ponto (lote ou ponto avulso — o robô
  não distingue).
- Procura o template pelo nome antes de criar (`robot_find_task_template_id`).
  Cada disparo cria um **registro novo** mesmo reaproveitando o template;
  a sondagem pega sempre o mais recente com aquele nome.
- **Altura do pallet azul (já erramos uma vez)**: o `height` no topo da ação
  PICKUP NÃO é o que a plataforma usa (fica sempre 0). O valor vai em
  `params.PALLET_LAYER = { height, layer }`. Só o PICKUP leva `params`;
  UNLOAD é sempre `null`.
  - madeira → `params: null`, nome `A1toB2`
  - azul → `PALLET_LAYER { height: <blueBase>, layer: 2 }`, nome `A1toB2MT<blueBase>` (ex. `A1toB2MT8`)
  - azul "de cima" (dormente, ver [ocupacao.md](ocupacao.md)) → `{ height: <blueTop>, layer: 3 }`, nome `A1toB2MT<blueTop>C`
  - O nome codifica a altura porque templates são reaproveitados por nome:
    mudar a altura gera templates novos (os antigos ficam órfãos no
    dispatch, inofensivo).
  - Implementação: `_pallet_pickup_params` / `robot_route_task_name`.

### Hash do mapa

`ROBOT_TARGET_MAP = "dbc5b2b4cd6d2505d78fe894403fe2c5"` (desde o
remapeamento de 2026-09-11). Conferir sempre em `GET /reeman/current_map`
antes de mudar — hashes em mensagens de erro podem ser de mapas antigos.
Remapear só exige trocar essa constante: `calibration.json` não referencia
o hash.

## 2. SLAM WEB API (mesmo IP, sem prefixo)

GET `/reeman/*`, POST `/cmd/*`. Usados/validados:

- `GET /reeman/base_encode` → `{battery, chargeFlag, emergencyButton}`.
  `chargeFlag == 2` = carregando de verdade (confirmado em campo).
  `battery` é normalizado por `_normalize_battery` (0-100, formato assumido).
- `GET /reeman/pose` → `{x, y, theta}`; `GET /reeman/speed` → `{vx, vth}`.
- `GET /reeman/current_map`, `/reeman/map`, `/reeman/laser`.
- `GET /reeman/nav_status` → `{res, reason, goal, dist, mileage}`. **Não
  serve como "está navegando"** (mostrou `goal=-1` com o robô a 1 m/s).
  `res=3 + reason=-6` = perdeu a localização; `res=4/reason=0` = parado
  limpo depois de cancelar.
- `POST /cmd/cancel_goal` → responde `success` mas **não para um robô
  travado** (volta a andar ~2 s depois). Best-effort; quem para de verdade
  é o E-stop físico. Cancelar task-record no dispatch **não** aborta a
  navegação em curso (são camadas diferentes).
- `POST /cmd/speed` → usado no "empurrãozinho" de destravar giro (ver
  [fila.md](fila.md)). `POST /cmd/turn` existe mas está **quebrado** — não usar.
- `POST /cmd/stop`, `/cmd/pause`: exigem body não documentado (`{}` dá
  `error_code 001`) — não usados.
- Existem e **não devem ser reintroduzidos** sem motivo novo:
  `POST /cmd/reloc_pose` (relocalização forçada — tentado e removido em
  2026-09-18: forçar pose sem confirmação é mais risco que ajuda).
- Referência não usada: `POST /cmd/nav_name {point}`, `POST /cmd/charge`,
  `POST /cmd/position`.
- **Não existe comando de giro bruto** via HTTP. A pergunta "posso girar
  aqui?" só existe no ROS (ver robot-bridge).

## 3. Comportamentos do robô que moldam o código

- **Sem nenhuma task, o robô cria sozinho uma `AUTO_SYSTEM` de volta pra
  carga**, com a MESMA prioridade de uma task normal (não é preemptada).
  Toda a estratégia da fila (handoff com `pendingRoute`, disparar antes de
  cancelar a carga) existe por causa disso — ver [fila.md](fila.md).
- `standbyPointType: "charge"`: ocioso, ele volta pra carga sozinho — isso
  não é task, cancelamento não afeta.
- O retorno automático pra carga passa por um trecho fixo **P3 → P1** do
  grafo.

## 4. Diagnóstico: "robô travado sem task"

Sempre olhar `GET /error/records` primeiro — três erros parecidos, causas
diferentes:

| `error` | Causa | O que fazer |
|---|---|---|
| `ROTATE_ERROR` | Falta espaço pra girar num ponto ("espaço de giro insuficiente no ponto X"). Físico. | Avisar/esperar; o cancelamento seguro existe por isso. |
| `GENERATE_PATH_UNKNOWN_ERROR` | Não conseguiu gerar o caminho (texto "已偏离当前路线 P3 -> P1, 距离路线 Xm"). Causa real: **curvas fechadas em ângulo pequeno** no trajeto, não distância nem localização. | Simplificar a rota/pontos (feito pelo usuário em 2026-09-23). |
| `LOCATION_LOST` | Perdeu a localização de verdade. | Sem recuperação automática. |

Ponto calibrado mais próximo do robô: distância euclidiana entre
`/reeman/pose` e `/map/point/list/{map}` (aproximação confiável).

Pontos que o robô não alcança por falta de espaço de manobra causam o
"unload fantasma" (desiste do PICKUP, faz UNLOAD vazio e ignora
cancelamentos enquanto está travado) — problema de calibração do ponto,
não do código.

## 5. Ideias registradas, não implementadas

- Perguntar "existe rota até X?" antes de despachar: `get_defined_plan` /
  `get_plan_name` (camada ROS/serial, PDF "SLAM 3.0 API"). Precisaria achar
  o tópico ROS e estender o bridge. Combinar com o usuário antes.
- Robô desacelera/para sozinho a cada ~10-15 m em retas longas (por
  distância, não por lugar). Não resolvido; hipótese `max_plan_dist`
  (parâmetro da API serial). Fora do escopo do app.
