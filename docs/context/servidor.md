# server.py — base, execução, arquivos de dados e armadilhas

`server.py` (raiz, ~6.000 linhas, **só biblioteca padrão do Python 3**, zero
dependências — manter assim). Serve o `web/dist`, faz proxy de
`/api/reeman-dispatch-service/*` pro robô, persiste os dados em JSON e é a
autoridade da fila (ver [fila.md](fila.md)).

Ler junto: [../../packaging/CONTEXT.md](../../packaging/CONTEXT.md)
(produção na VM), [robo-api.md](robo-api.md), [usuarios.md](usuarios.md).

## Rodar

```
cd web && npm run build && cd ..   # gera web/dist (o servidor serve do disco)
python server.py --teste           # modo teste, porta 8000 (ver abaixo)
```
Dev com hot-reload: `npm run dev` (Vite 5173, encaminha `/api/*` pro 8000).
O site novo entra no ar pra quem recarregar mesmo sem reiniciar o servidor;
mudança no `server.py` só vale depois de reiniciar o processo.

**Nunca reiniciar o servidor com rota em andamento ou na fila.** Nunca rodar
dois servidores LIFTY falando com o mesmo robô (a VM já fala) — testar
sempre com `--teste`.

### Modo teste (`--teste` ou `LIFTY_MODO_TESTE=1`, `TEST_MODE`)
Nunca fala com o robô: `ROBOT_HOST` fixo em `http://127.0.0.1:9/`
(`set_robot_host` ignora outro valor), sem varredura/redescoberta, sem vigia
do bridge, sem SSH. Usa os dados da pasta local (cópia antiga deste PC). Ações
que tentariam o robô ficam lentas/falham — normal.

## Arquivos de dados (todos ao lado do executável, `_app_dir()`)

`calibration.json`, `users.json`, `session_secret.key`, `queue_state.json`,
`route_log.json`, `robot_host.txt`, `operation_hours.json`, `chat.json`,
`pallet_requests.json`, `dock_shadow.jsonl`, `server.log`, `backups/`,
`robot_known_hosts`, chave `lifty_robot`. **Todos gitignored — nunca
commitar** (hash de senha, chave SSH, chave de sessão). Arquivo novo de
dado: entrar no `.gitignore` e na lista do
`packaging/vm/exportar-dados.ps1`.
- `_bundle_dir()` (`sys._MEIPASS` congelado): `web/dist` e
  `calibration.seed.json` (mapa de fábrica, só pra install novo —
  `_seed_calibration_if_missing`).
- Backup automático (`_backup_data`): `calibration.json` e `users.json` em
  `backups/` ao iniciar e 1x/dia, 30 dias. Restaurar = seção 11 do
  `MIGRACAO_VM_FINAL.md`.

## IP do robô (`discover_robot_host`)

Só o último octeto muda (`192.168.5.x`). Ao subir: tenta o último que
funcionou (`robot_host.txt`) e o `ROBOT_HOST` atual contra
`GET .../project/infos` conferindo a cara da resposta; senão varre o /24 da
própria máquina (40 threads, 0,5 s). Falha de CONEXÃO (não HTTP 4xx/5xx)
dispara redescoberta em thread, cooldown 30 s. Nunca apaga um valor que
funcionava.

## Armadilhas já resolvidas — não reintroduzir

- **Encoding**: TODO `read_text`/`write_text` com `encoding="utf-8"` e
  leitores tratando `ValueError` (cobre `UnicodeDecodeError`). No Windows o
  padrão é cp1252 e o `calibration.json` tem "Í" — derrubava o servidor na
  VM. Testar com `LC_ALL=C PYTHONUTF8=0` antes de gerar exe. O `server.py`
  tem BOM UTF-8 (usar `utf-8-sig` pra parsear com `ast`).
- **`STATIC_DIR` absoluto** (`Path(__file__).parent / "web" / "dist"` /
  `_bundle_dir`). Relativo servia 404 pra tudo quando o cwd mudava.
- **`Cache-Control: no-cache` só em `/` e `/index.html`** — sem isso o
  tablet ficava preso numa versão velha; `/assets/*` (hash no nome) pode
  cachear.
- **`_relay` duplicado**: um handler mandando duas respostas no mesmo
  socket derrubou o Vite dev server. Conferir em todo handler novo.
- Handlers que falam com o robô seguram o lock — chamada lenta de rede
  fica FORA do lock sempre que der (senão o `live-state` de todo mundo
  trava).
- Máquina do servidor **não pode suspender** (tela apagar é inofensivo).
  A GUI usa `SetThreadExecutionState`; na VM é serviço.

## Relógios

Hora do `server.py` = hora local da VM (histórico, horário de operação).
Robô/dispatch têm relógios próprios e desencontrados (ver
[../../robot-bridge/CONTEXT.md](../../robot-bridge/CONTEXT.md)) — nunca
comparar timestamps do robô com os nossos.

## Simuladores

`robot_simulator.py` (raiz): simula o dispatch localmente (fila, bateria).
Testes isolados de servidor: importar o módulo com `--teste` e mockar as
chamadas de rede e os arquivos de estado (ver [fila.md](fila.md), "Testes").
