# Bridge do robô (`lifty_turn_check_bridge.py`) e acesso ao robô

Script Python **standalone** que roda no computador de bordo do robô
(Ubuntu + ROS1, hostname `rbot55f-260318-003-001`) e expõe tópicos ROS como
HTTP na porta **8091**, pela mesma wifi do dispatch (`192.168.5.195`). Este
arquivo do repo é só a FONTE: o que roda é a cópia no `~` do robô.

Ler junto: [../docs/context/robo-api.md](../docs/context/robo-api.md),
[../docs/context/fila.md](../docs/context/fila.md) (quem usa o bridge),
[../docs/context/avisos-robo.md](../docs/context/avisos-robo.md)
(obstáculo, câmera, sombra).

## Regras inegociáveis (pedidas pelo usuário — valem pra qualquer sessão)

- Robô em operação = só leitura. Por padrão NÃO rodar: `sudo`, `rostopic
  pub`, `rosservice call`, `rosparam set`, `dynamic_reconfigure`, `rosnode
  kill`, `docker restart/stop/exec` com escrita, `systemctl`.
- **Nunca alterar arquivo nenhum da REEMAN** (`~/data`, `~/reeman_ws`,
  `catkin_ws`, launch files, `/mnt/reeman-dispatch-cloud`). Nunca
  `colcon build`/`catkin_make`. Nunca mexer em boot, systemd, crontab
  (`@reboot` do `bringup.sh` é da REEMAN), firewall ou rede do robô.
- Instalar algo, abrir porta ou rodar processo novo no robô: combinar antes.
- Backup antes de editar qualquer configuração.
- Bridge é arquivo novo e isolado, fora de qualquer workspace. Mensagens
  padrão (`std_msgs`); tipos customizados da REEMAN só por leitura via
  `rospy.AnyMsg` + `genpy.dynamic` (nada compilado — autorizado pelo
  usuário).
- Nunca desligar sensor de forma permanente; nunca
  `move_base/local_costmap/obstacle_layer/enabled` (cega o lidar inteiro).
- `reemansniff.md` (raio-x do robô, IPs/acessos) é LOCAL, fora do git
  (repo público). Chave SSH e dados nunca no git.

## Acesso

- SSH root por cabo (`192.168.10.2`/`192.168.11.2`) ou pela wifi; é a MESMA
  máquina que serve o dispatch (`wlp1s0 = 192.168.5.195`).
- O ROS master (11311) recusa conexão de fora — por isso o bridge roda lá
  dentro, não numa máquina externa.
- Instalar/atualizar: `curl -o ~/lifty_turn_check_bridge.py
  https://raw.githubusercontent.com/brunosaeger/LIFTYMapper/main/robot-bridge/lifty_turn_check_bridge.py`
  (conferir `sha256sum`). Precisa estar commitado/pushado pra baixar.
- Subir: `setsid nohup python3 -u lifty_turn_check_bridge.py > bridge.log 2>&1 < /dev/null &`
  no `~`. Sem `nohup` morre junto com a sessão SSH (SIGHUP). Parar: `kill -9`
  (o rospy segura SIGTERM/SIGINT). **Não volta sozinho depois de reiniciar o
  robô** — quem religa é a vigia do servidor (abaixo).
- Diagnóstico rápido: `curl http://192.168.5.195:8091/check-turn?angle=180`
  — "connection refused" = processo morto; timeout = rede.

## Endpoints

| Rota | O quê | Tópicos |
|---|---|---|
| `GET /check-turn?angle=X` | `{safe}` — posso girar X° aqui? (+ esquerda) | pub `/robot_api/turn_check_angle` (Float32), sub `/robot_api/turn_check_ok` (Bool) |
| `GET /obstacle` | `{front, back, left, right, f_left, f_right, age, avoid, blocked, camera}` (503 antes da 1ª leitura) | `/mobile_base/commands/fork_info`, `/avoid_distance`, `/mobile_base/debug/raw_data_stream`, `/robot_api/get_pallet_pose`, `/lx_camera_pallet_node/forklift_pallet_pose` |
| `GET /dock-shadow` | detecção "pallet empurrado" (só registra) | câmera de pallet + `/mobile/odom` |
| `POST /fork-nav-height` | garfo a 300 mm (comando FIXO `208 4 25 1 44 1`) | pub `/mobile_base/commands/send_to_base` (String) |
| `GET /obstacle-3d?on=1\|0` | liga/desliga sensor 3D — **sem uso** (feature removida), mantido | pub `/robot_api/set_obs3d_switch` |

- `fork_info`: cm, 255 = livre; 0-2 = sensor mascarado pelo app.
  `f_left`/`f_right` contam como FRENTE (validado em campo).
- `avoid_distance`: distância de desvio ATIVA por lado (m), só quando muda;
  0 = lado desligado.
- `raw_data_stream`: pacote `D0 05 55 aa bb cc dd` a cada ~2 s SÓ enquanto
  bloqueado por obstáculo — é o sinal "parou por obstrução" (`blocked`).
- Câmera: `get_pallet_pose` true → 10 s sem detecção → false = 1 falha
  (`camera.failStreak`).
- `address_string()` sobrescrito pra não fazer DNS reverso (sem isso,
  chamada de outra máquina dava "empty reply").
- Consultas 200 de `/obstacle` e `/dock-shadow` não vão pro `bridge.log`
  (rodando 24/7 encheria o disco).

## Vigia do bridge no servidor (`_refresh_bridge_watch`)

Thread própria (`BRIDGE_WATCHDOG_*`): a cada 30 s testa a 8091; fora do ar e
porta 22 aberta → `ssh` (BatchMode, `StrictHostKeyChecking=accept-new`,
known_hosts próprio `robot_known_hosts`) roda o script fixo
`BRIDGE_START_SCRIPT` (responde `ja-rodando` se já há processo). Vivo mas
mudo por 300 s → mata e sobe. Tentativas a cada 120 s; log só quando muda
(`Bridge: ...`). Chave `lifty_robot` ao lado do executável (serviço roda
como SYSTEM) ou `~/.ssh/lifty_robot`. A VM precisa alcançar o robô nas
portas 80, 8091 e 22. Desligada no modo teste.

## Fatos do robô úteis

- `main_forklift_node` calcula o check-turn; `move_base`/TEB dá o
  `ROTATE_ERROR`. São independentes — check-turn "seguro" não garante nada.
- Planejamento lento (~2 min) depois de cancelar em docking do corredor: é
  o planejador do dispatch (`PathPlanningUtils`, Docker `dispatch-service`,
  porta 8080, junto de `mysql`/`redis`/`emqx`). Log:
  `sudo docker logs -t dispatch-service` (só leitura; `sudo` só com
  autorização). Piorou depois de pontos novos no mapa (10/10).
- Logs: `~/downfile/roslog/*.log` (driver), `~/downfile/powerlog/forklift_log/`
  (app do tablet: `叉臂高度: N` = altura real do garfo em mm, comandos
  `send_to_base`).
- Câmera de pallet: config fica na câmera; `level_dist = 0` travou o
  algoritmo (incidente 27/10) — resolveu voltando pra 30 no PalletPro
  (`C:\PalletPro\logs\lanxin_vision_*.log`). RET -2/-6 = pernas do pallet
  não detectadas.
- Seletor manual/automático (hardware) pode prender no manual — ligar o
  robô já em automático; não mexer no knob até a manutenção.
- Relógios não batem (robô, dispatch, PC) — alinhar eventos pelo movimento,
  nunca pelo minuto. Offsets vistos: heartbeat do dispatch ≈ PC + 18h57;
  `task-record` ≈ PC − 5h03; `/error/records` ≈ PC + 11h (variam — conferir).
