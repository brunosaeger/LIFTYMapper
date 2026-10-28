#!/usr/bin/env python3
"""Servidor local do painel de controle do forklift.

Serve o build do app React (web/dist) estaticamente, faz proxy de
/api/reeman-dispatch-service/* para o dispatch service do robo, e persiste
a calibração feita no editor (pontos avulsos + lotes em linha/coluna, uma
vista "top" e uma "iso" independentes, /api/calibration) em
calibration.json no disco.

Por que um proxy? O app chama a API do robo via fetch(). Se o navegador
chamasse http://IP_DO_ROBO diretamente, isso seria uma requisicao
cross-origin: como as chamadas de criacao de task usam
Content-Type: application/json, o navegador dispara um preflight (OPTIONS)
antes do POST. O dispatch service nao foi feito para responder esse
preflight, entao o navegador bloqueia a chamada antes mesmo dela sair -
mesmo com a rede certa e sem autenticacao, o clique simplesmente nao
funcionaria.

Rodando esse proxy, o navegador so fala com este processo (mesma origem,
sem CORS). Este processo, por sua vez, repassa a chamada para o robo via
uma requisicao HTTP comum (que nao passa por regra de CORS nenhuma,
porque CORS e uma restricao do navegador, nao do protocolo HTTP).

Uso:
    1. cd web && npm run build && cd ..   (gera web/dist)
    2. python3 server.py
    3. Abra http://localhost:8000 no navegador/tablet (mesma rede do robo).

ROBOT_HOST abaixo e so um FALLBACK/semente inicial — ao subir, o servidor
varre sozinho a rede local procurando quem responde como o dispatch service
de verdade e atualiza o host automaticamente (ver discover_robot_host() e
"Descoberta automatica do robo" mais abaixo). So importa editar a mao se a
varredura falhar (robo fora da mesma sub-rede /24, rede ainda nao subiu no
boot etc.).

Em desenvolvimento (npm run dev dentro de web/), o Vite serve o app na 5173
e encaminha /api pra este processo na 8000 (ver web/vite.config.js) — rode
os dois processos em paralelo.

Sem dependencias externas - só biblioteca padrão do Python 3.
"""
import base64
import concurrent.futures
import functools
import hashlib
import hmac
import http.cookies
import http.server
import json
import math
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# Saída SEMPRE em UTF-8 (com `replace` pra nunca estourar). Rodando como
# serviço no Windows (ex. NSSM redirecionando pra arquivo), o Python usa a
# codepage local (cp1252) pra stdout/stderr — e as mensagens de erro do
# dispatch vêm com ideogramas chineses (ex. "任务模版名称已存在"). Um print()
# disso levantaria UnicodeEncodeError DENTRO de um handler de erro, e podia
# derrubar a thread da fila. Só muda o encoding do log, nada de lógica.
for _stream in (sys.stdout, sys.stderr):
    try:
        if _stream is not None:
            _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — stream sem reconfigure (ex. sem console): segue como está
        pass


# --- onde ficam os arquivos ------------------------------------------------
# Quando empacotado com PyInstaller (--onefile), os recursos embutidos são
# extraídos pra uma pasta TEMPORÁRIA (sys._MEIPASS) que some quando o app
# fecha. Então:
#   _bundle_dir() -> recursos SÓ-LEITURA que vêm dentro do pacote (web/dist)
#   _app_dir()    -> onde LER/ESCREVER dado que precisa persistir (os 5
#                    arquivos json/key) — a pasta do próprio .exe, ao lado
#                    dele, NUNCA a temporária.
# Em desenvolvimento (rodando `python3 server.py`), os dois são a pasta
# deste script — comportamento de sempre.
def _bundle_dir():
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # noqa: SLF001 — API do PyInstaller
    return Path(__file__).parent


def _app_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent

# ---------------------------------------------------------------------------
# CONFIGURAÇÃO — confirme o IP do robô antes da demo (ver seção 1.1 do PDF /
# ip_nav confirmado em testes anteriores).
# ---------------------------------------------------------------------------
ROBOT_HOST = "http://192.168.5.195/" #http://192.168.43.74 ou http://172.16.1.244/
LISTEN_PORT = 8000
# ---------------------------------------------------------------------------


def set_robot_host(host):
    """Troca o IP/host do robô em tempo de execução (a GUI do .exe chama
    isso com o que o usuário digitou). Aceita `192.168.1.5`,
    `http://192.168.1.5` ou `http://192.168.1.5/` — normaliza pra forma com
    esquema e barra final, que é o que _robot_call/_proxy esperam."""
    global ROBOT_HOST
    host = (host or "").strip()
    if not host:
        return
    if "://" not in host:
        host = "http://" + host
    if not host.endswith("/"):
        host += "/"
    ROBOT_HOST = host


# --- Descoberta automática do robô -----------------------------------------
# Motivo: o robô troca de IP toda vez que a rede muda (hotspot de celular vs
# roteador fixo, ou o próprio DHCP reatribuindo) — só o ÚLTIMO octeto muda
# dentro da mesma sub-rede (ex: .193 virou .195), nunca os três primeiros.
# Antes disso exigia editar ROBOT_HOST à mão a cada troca (já rendeu mais de
# um susto em campo, ver histórico no topo do arquivo). Agora, ao subir (e
# quando uma chamada ao robô falha por problema de CONEXÃO, não uma resposta
# de erro normal), o servidor varre sozinho a sub-rede /24 da própria
# máquina procurando quem responde como o dispatch service de verdade —
# bate no endpoint mais leve que existe (lista de projetos) e confere se a
# resposta tem a cara certa ({"code":...}), não só se a porta está aberta
# (evita "achar" qualquer outro serviço HTTP que por acaso esteja na rede).
API_PREFIX = "/api/reeman-dispatch-service"
DISCOVERY_PROBE_PATH = API_PREFIX + "/project/infos"
ROBOT_HOST_CACHE_FILE = _app_dir() / "robot_host.txt"  # último IP achado — testado primeiro no próximo boot, evita varrer 254 endereços se nada mudou
DISCOVERY_TIMEOUT_SECONDS = 0.5
DISCOVERY_WORKERS = 40
DISCOVERY_RESCAN_COOLDOWN_SECONDS = 30  # evita martelar a rede inteira a cada chamada falhando, se o robô estiver genuinamente desligado


def _local_subnet_prefix():
    """Descobre o prefixo /24 (ex: '192.168.5.') e o próprio IP local, olhando
    qual interface o SO usaria pra sair — via "connect" UDP, que só resolve
    rota (não manda pacote nenhum), então funciona mesmo sem internet de
    verdade, só precisando de uma rota local configurada (wifi conectado)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        local_ip = sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()
    parts = local_ip.split(".")
    if len(parts) != 4:
        return None
    return ".".join(parts[:3]) + ".", local_ip


def _looks_like_dispatch_service(ip):
    """True se `ip` responder no endpoint do dispatch service com a cara
    certa ({"code": ...}) — não só se a porta 80 estiver aberta (qualquer
    outro serviço HTTP na rede também responderia a isso)."""
    url = "http://%s%s" % (ip, DISCOVERY_PROBE_PATH)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=DISCOVERY_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read())
        return isinstance(data, dict) and "code" in data
    except Exception:
        return False


def discover_robot_host():
    """Varre a rede procurando o robô e atualiza ROBOT_HOST sozinho. Tenta
    primeiro o último IP que funcionou (arquivo ROBOT_HOST_CACHE_FILE) e o
    ROBOT_HOST atual — cobre o caso comum de "nada mudou" sem varrer nada. Só
    varre a sub-rede /24 inteira se isso falhar. Sempre devolve algo utilizável
    em ROBOT_HOST: se não achar nada, mantém o que já estava (não apaga o
    valor anterior)."""
    candidates_first = []
    if ROBOT_HOST_CACHE_FILE.exists():
        cached = ROBOT_HOST_CACHE_FILE.read_text(encoding="utf-8").strip()
        if cached:
            candidates_first.append(cached)
    current = ROBOT_HOST.rstrip("/").replace("http://", "").replace("https://", "")
    if current and current not in candidates_first:
        candidates_first.append(current)
    for ip in candidates_first:
        if _looks_like_dispatch_service(ip):
            set_robot_host(ip)
            ROBOT_HOST_CACHE_FILE.write_text(ip, encoding="utf-8")
            print("Robô encontrado em %s (sem precisar varrer a rede)." % ip)
            return ip

    prefix_info = _local_subnet_prefix()
    if not prefix_info:
        print("Aviso: não deu pra determinar a sub-rede local pra varrer — mantendo ROBOT_HOST atual (%s)." % ROBOT_HOST)
        return None
    prefix, own_ip = prefix_info
    candidates = [prefix + str(i) for i in range(1, 255) if prefix + str(i) != own_ip]

    print("Procurando o robô em %s0/24..." % prefix)
    found = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=DISCOVERY_WORKERS) as pool:
        futures = {pool.submit(_looks_like_dispatch_service, ip): ip for ip in candidates}
        for future in concurrent.futures.as_completed(futures):
            if future.result():
                found = futures[future]
                break

    if found:
        set_robot_host(found)
        ROBOT_HOST_CACHE_FILE.write_text(found, encoding="utf-8")
        print("Robô encontrado em %s (varredura de %s0/24)." % (found, prefix))
        return found

    print("Aviso: não achei nenhum robô respondendo como dispatch service em %s0/24 — mantendo ROBOT_HOST atual (%s). Confira se o robô está ligado e na mesma rede." % (prefix, ROBOT_HOST))
    return None


_last_discovery_attempt = 0.0
_discovery_attempt_lock = threading.Lock()


def _note_possible_ip_change(err):
    """Chamado quando uma chamada ao robô falha por problema de CONEXÃO
    (robô não respondeu nada — pode ter trocado de IP). Diferente de uma
    resposta HTTP de erro (o robô respondeu, só não gostou do pedido — não
    é sinal de IP errado). Dispara uma redescoberta em segundo plano, com
    cooldown pra não martelar a rede inteira a cada chamada se o robô
    estiver genuinamente desligado/fora da rede."""
    if isinstance(err, urllib.error.HTTPError):
        return
    global _last_discovery_attempt
    now = time.monotonic()
    with _discovery_attempt_lock:
        if now - _last_discovery_attempt < DISCOVERY_RESCAN_COOLDOWN_SECONDS:
            return
        _last_discovery_attempt = now
    threading.Thread(target=discover_robot_host, daemon=True).start()
CALIBRATION_PATH = "/api/calibration"
KANBANS_PATH = "/api/kanbans"  # lista de Close Ups elegíveis pra restringir usuário (ver _get_kanbans) — exclui os "livres pra todos" (FREE_KANBAN_IDS)
# Sempre absoluto, nunca relativo ao diretório de trabalho do processo —
# SimpleHTTPRequestHandler resolve `directory=` relativo ao CWD em tempo de
# requisição, não ao arquivo deste script. Rodar `python3 server.py` de um
# CWD diferente da raiz do projeto (ex: de dentro de web/) com STATIC_DIR
# relativo fazia ele procurar em web/web/dist e servir 404 pra tudo,
# inclusive a própria index.html — bug real, já aconteceu.
STATIC_DIR = str(_bundle_dir() / "web" / "dist")
CALIBRATION_FILE = _app_dir() / "calibration.json"
EMPTY_CALIBRATION = b'{"top":{"points":[],"lots":[]},"iso":{"points":[],"lots":[]},"occupied":[],"palletHeights":{"blueBase":7,"blueTop":8}}'
CALIBRATION_LOCK = threading.Lock()  # protege leitura+escrita de calibration.json (full-snapshot E as mutações cirúrgicas de occupied abaixo)

# Histórico de rotas (modo desenvolvedor, painel "Histórico" no app React) —
# guarda quando cada rota foi SOLICITADA e CONCLUÍDA usando o relógio DESTA
# máquina (a que roda este processo), de propósito: nem o relógio do robô
# (dispatch service) nem o do tablet/navegador do operador são confiáveis
# como referência única — cada um pode estar em fuso/hora diferente. O app
# React só manda pickup/dropoff/taskName; quem carimba requestedAt/
# completedAt é sempre este servidor.
ROUTE_LOG_PATH = "/api/route-log"
ROUTE_LOG_FILE = _app_dir() / "route_log.json"
ROUTE_LOG_MAX_ENTRIES = 500  # roda 24/7 num armazém, sem manutenção — evita o arquivo crescer pra sempre
ROUTE_LOG_LOCK = threading.Lock()  # ThreadingHTTPServer atende requisições em paralelo; protege o ciclo ler-modificar-escrever do arquivo


def _read_route_log():
    if not ROUTE_LOG_FILE.exists():
        return []
    try:
        return json.loads(ROUTE_LOG_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):  # ValueError cobre JSONDecodeError e UnicodeDecodeError
        return []


def _write_route_log(entries):
    ROUTE_LOG_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


# Gravação do histórico — funções de módulo (não métodos do Handler) porque,
# desde que a fila de rotas passou a ser dona do servidor (ver "Fila de
# rotas compartilhada" abaixo), quem dispara/conclui uma rota não é mais o
# navegador via HTTP (POST /api/route-log/request|complete, removidos) — é
# o PRÓPRIO servidor (o handler de /api/queue/enqueue e a thread de fundo),
# chamando essas funções diretamente, sem round-trip HTTP nenhum.
def log_route_requested(entry_id, pickup, dropoff, task_name, username):
    with ROUTE_LOG_LOCK:
        entries = _read_route_log()
        entries.append({
            "id": entry_id,
            "pickup": pickup,
            "dropoff": dropoff,
            "taskName": task_name,
            "user": username,
            "requestedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "completedAt": None,
            "status": "requested",
        })
        entries = entries[-ROUTE_LOG_MAX_ENTRIES:]
        _write_route_log(entries)


def log_route_completed(entry_id, status):
    with ROUTE_LOG_LOCK:
        entries = _read_route_log()
        for entry in entries:
            if entry.get("id") == entry_id:
                entry["completedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                entry["status"] = status
                break
        _write_route_log(entries)

# --- Fila de rotas compartilhada entre dispositivos (ver CONTEXT.md, "Fila
# de rotas compartilhada") -----------------------------------------------
#
# Até aqui, era o PRÓPRIO NAVEGADOR de cada operador quem falava direto com
# o robô (via o proxy genérico acima) pra disparar/cancelar/sondar rotas, e
# a fila (`currentRoute`/`pendingRoute`/`routeQueue`) vivia só como estado
# React local — cada aba via só as rotas que ELA MESMA disparou. Com vários
# operadores em tablets diferentes, isso tem dois problemas sérios: (1)
# ninguém vê o que os outros estão fazendo, e (2) se dois navegadores
# decidem "a atual terminou, disparo a próxima" ao mesmo tempo (ou dois
# operadores clicam Enviar quase juntos), não tem nenhuma autoridade única
# impedindo disparo duplicado.
#
# A partir daqui, o server.py é o ÚNICO ator que fala com o robô pra isso —
# navegadores só LEEM (GET /api/live-state, polling) e mandam INTENÇÕES
# (POST /api/queue/*), nunca decidem sozinhos. Uma thread de fundo avança a
# fila sozinha (sondando o robô a cada QUEUE_POLL_INTERVAL_SECONDS); os
# handlers de enfileirar/cancelar/remover competem pelo mesmo QUEUE_LOCK —
# com um único ator serializado por lock, nunca existe "dois ao mesmo
# tempo" de verdade.
#
# ORDEM DE LOCK (pra nunca dar deadlock): quem precisa de QUEUE_LOCK e
# CALIBRATION_LOCK ao mesmo tempo (só a thread de fundo, ao marcar ocupação
# como parte de avançar a fila) SEMPRE pega QUEUE_LOCK primeiro,
# CALIBRATION_LOCK depois — nunca a ordem inversa em lugar nenhum do código.
QUEUE_STATE_FILE = _app_dir() / "queue_state.json"
QUEUE_LOCK = threading.Lock()
QUEUE_POLL_INTERVAL_SECONDS = 4  # mesmo intervalo que o front usava pra sondar (POLL_INTERVAL_MS)
# Parada de emergência: quando ativa, a thread de fundo sonda MAIS RÁPIDO pra
# reprimir a task de carga (AUTO_SYSTEM) que o robô recria sozinho ao ficar
# sem fila — é o que o mantém parado no lugar. Ver _emergency_suppress.
EMERGENCY_POLL_INTERVAL_SECONDS = 1.5
# Limpeza automática da fila parada (pedido do usuário, 2026-10-27 — o
# servidor fica no ar 24/7 na VM): se a fila não muda NADA (nenhuma rota
# enfileirada, cancelada, removida, reordenada, disparada ou concluída) por
# esse tempo, é limpa sozinha. Ver _refresh_idle_queue_timeout.
QUEUE_IDLE_TIMEOUT_SECONDS = 60 * 60
# Cancelamento adiado (ver CONTEXT.md, "Cancelamento adiado até giro
# seguro"): enquanto `cancelPending` está true, sonda MAIS RÁPIDO —
# alguém está esperando isso resolver na tela, e a rota continua se
# movendo (o robô pode estar entrando numa área segura a qualquer momento).
CANCEL_PENDING_POLL_INTERVAL_SECONDS = 2
# Mensagem literal mostrada ao operador enquanto espera — usar exatamente
# essa string (pedido do usuário), não parafrasear.
CANCEL_PENDING_MESSAGE = "Aguarde até o robô chegar a uma posição válida para giro seguro..."

# Check-turn também no INÍCIO de uma tarefa (pedido do usuário, 2026-09-22 —
# ver CONTEXT.md "check-turn no início de tarefas"), não só no cancelamento:
# rota nova (fila estava vazia), rota promovida depois de um cancelamento, ou
# rota que estava só na fila local e virou a vez dela — nenhuma delas é
# disparada de verdade pro robô (`_fire_route`) enquanto `robot_can_turn_
# safely()` não disser "sim" (ou o bridge estiver indisponível, tratado como
# "não sei" — mesmo comportamento fail-open do cancelamento). Reusa o mesmo
# intervalo de sondagem rápida do cancelamento adiado (mesma urgência: alguém
# pode estar vendo isso na tela).
TURN_BLOCKED_START_MESSAGE = "Aguardando o robô chegar a uma posição válida para giro seguro antes de iniciar esta rota..."

# Trava: não iniciar task nova durante o retorno nativo pra energia (pedido
# do usuário, 2026-09-25 — ver CONTEXT.md "Trava: não iniciar task durante
# retorno pra energia"). Cenário: fila vazia, o robô já está voltando
# sozinho pra carga (AUTO_SYSTEM nativa) quando o operador manda uma rota
# nova. Diferente do "check-turn no início de tarefas" acima (que confia no
# check-turn pra decidir se dá pra girar ONDE o robô estiver), aqui o robô
# pode estar em QUALQUER heading, no meio do caminho de volta — sem docking
# point, sem ponto calibrado de referência, sem a garantia de alinhamento
# que já vimos em pontos de pallet/lote. Em vez de confiar no check-turn
# (que já provamos divergir da navegação real — ver "Varredura ao vivo"),
# espera um sinal simples e já validado: o robô chegou e está carregando de
# verdade (`_robot_status_cache["charging"]`, mesmo sinal do bypass de
# check-turn no ponto de energia acima). Só entra em jogo quando há mesmo
# uma AUTO_SYSTEM ativa (robot_find_active_charge_task_id) — rota promovida
# normalmente (fila não estava vazia) nunca aciona isso, porque nesse caso
# a AUTO_SYSTEM nem chega a existir.
AWAITING_CHARGE_MESSAGE = "Aguardando o robô chegar à energia e iniciar a carga antes de começar esta rota — ele está retornando sozinho pra carga, sem posição segura garantida pra girar no meio do caminho."

# Cancelamento pós-pickup (ver CONTEXT.md, "Cancelamento pós-pickup" —
# pedido do usuário, 2026-09-30): mostrado enquanto `pendingPostPickupUnload`
# está sendo resolvido (janela curta, entre cancelar e disparar o UNLOAD
# isolado) E enquanto a currentRoute é esse UNLOAD isolado em si — cobre o
# processo inteiro, do cancelamento até o robô soltar o pallet de vez.
POST_PICKUP_UNLOAD_MESSAGE = "O robô estava com um pallet no garfo — cancelamento concluído no alinhamento de docagem, devolvendo o pallet ao ponto de origem antes de seguir com a fila."

LIVE_STATE_PATH = "/api/live-state"
QUEUE_ENQUEUE_BATCH_PATH = "/api/queue/enqueue-batch"
QUEUE_CANCEL_CURRENT_PATH = "/api/queue/cancel-current"
QUEUE_REMOVE_QUEUED_PATH = "/api/queue/remove-queued"
QUEUE_CLEAR_ALL_PATH = "/api/queue/clear-all"
QUEUE_REORDER_PATH = "/api/queue/reorder"  # arrastar-e-soltar em "Próximas rotas" (ver _queue_reorder)
QUEUE_EMERGENCY_PATH = "/api/queue/emergency"
DEV_LIMIT_BREAKER_PATH = "/api/dev/limit-breaker"
OCCUPIED_SET_PATH = "/api/occupied/set"
OCCUPIED_SET_MANY_PATH = "/api/occupied/set-many"
PALLET_HEIGHTS_PATH = "/api/pallet-heights"

# --- cliente do dispatch service do robô (porta de src/api/lifty.js) ------
# Antes, essas chamadas viviam no navegador (lifty.js) e passavam pelo
# proxy genérico. Agora que o SERVIDOR é quem orquestra a fila, ele fala
# com o robô direto (mesmo ROBOT_HOST/API_PREFIX do proxy, só que a partir
# do processo Python, não a partir de uma requisição de navegador repassada).
ROBOT_PROJECT_ID = "15"
ROBOT_TARGET_MAP = "dbc5b2b4cd6d2505d78fe894403fe2c5"
ROBOT_SUPPORT_TYPES = ["犀牛2.0"]
# Ver CONTEXT.md, "Diferenciação de pallets": o campo height que fica no
# topo da ação PICKUP NÃO é o que a plataforma usa pra alinhar o pallet —
# fica sempre 0; o valor de verdade mora em params.PALLET_LAYER
# ({height, layer}).
#
# Madeira: sem params, height 0 (não empilha — inalterado).
# Azul, andar de baixo: layer 2, altura = palletHeights.blueBase (config,
#   default 7cm, pedido do usuário 2026-10-02 — era 8) — "Altura do pallet
#   azul padrão" no editor.
# Azul, "Pallet de cima" (checkbox no Ponto a Ponto): layer 3, altura =
#   palletHeights.blueTop (config, sem padrão de fábrica fixo — persiste o
#   último valor que o admin salvou). O 2º andar do pallet azul de 2 níveis.
#   Reaproveita a MESMA constante abaixo só como fallback de último recurso
#   se o campo vier faltando (não é "o padrão do blueTop" de verdade).
PALLET_BASE_HEIGHT_DEFAULT = 7
PALLET_BASE_LAYER = 2
PALLET_TOP_LAYER = 3


def _coerce_height(value, fallback):
    # Aceita uma casa decimal (ex. 6.5). Valor inteiro continua saindo como
    # int (7, não 7.0) pra não mudar o JSON nem o nome de template já usados.
    try:
        h = round(float(value), 1)
    except (TypeError, ValueError):
        return fallback
    if h != h or h in (float("inf"), float("-inf")):
        return fallback
    h = max(0, h)
    return int(h) if h == int(h) else h


def _height_tag(h):
    # Nome de template: 6.5 -> "6_5" (sem ponto), 7 -> "7".
    return str(h).replace(".", "_")


def _pallet_heights(cal):
    """Sempre devolve as duas alturas com valor válido, mesmo se o
    calibration.json for antigo (sem a chave) ou tiver campo faltando."""
    ph = cal.get("palletHeights") if isinstance(cal, dict) else None
    ph = ph if isinstance(ph, dict) else {}
    return {
        "blueBase": _coerce_height(ph.get("blueBase"), PALLET_BASE_HEIGHT_DEFAULT),
        "blueTop": _coerce_height(ph.get("blueTop"), PALLET_BASE_HEIGHT_DEFAULT),
    }


def _pallet_pickup_params(pallet_type, pallet_top, heights):
    if pallet_type != "blue":
        return None  # madeira: params null, height 0 — como sempre foi
    h = heights or {}
    if pallet_top:
        return {"PALLET_LAYER": {"height": _coerce_height(h.get("blueTop"), PALLET_BASE_HEIGHT_DEFAULT), "layer": PALLET_TOP_LAYER}}
    return {"PALLET_LAYER": {"height": _coerce_height(h.get("blueBase"), PALLET_BASE_HEIGHT_DEFAULT), "layer": PALLET_BASE_LAYER}}


class RobotError(Exception):
    pass


def _robot_call(method, path, body=None):
    target = ROBOT_HOST + API_PREFIX + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(target, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            parsed = json.loads(resp.read())
    except Exception as err:
        _note_possible_ip_change(err)
        raise
    if parsed.get("code") != 0:
        raise RobotError(parsed.get("message") or "erro desconhecido do robô")
    return parsed.get("data")


# --- API SLAM do robô (/cmd/*, /reeman/*) — SEM o prefixo do dispatch -----
# É uma API SEPARADA, de CONTROLE DE NAVEGAÇÃO PURO. Cancelar um task-record
# no dispatch (all-cancel / cancel) só tira o job da FILA — NÃO freia o robô
# se ele já está no meio de um trajeto (a navegação é outra camada). Quem
# aborta o movimento de verdade é `POST /cmd/cancel_goal`.
# Descoberto no bug de campo 2026-09-11: robô com todas as tasks CANCELADAS
# (confirmado na plataforma do fabricante) seguiu andando; nem o botão de
# emergência (que só faz all-cancel) parou ele.
# A resposta do /cmd/* não segue o {code,message,data} do dispatch — aqui só
# devolve o cru e deixa quem chama interpretar. Best-effort: se o endpoint
# não existir nesse firmware, urlopen levanta e quem chama trata.
def _slam_call(method, path, body=None):
    target = ROBOT_HOST.rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(target, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
    except Exception as err:
        _note_possible_ip_change(err)
        raise
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return raw.decode("utf-8", "replace")


def robot_stop_navigation():
    """POST /cmd/cancel_goal — aborta a navegação ATUAL. É o comando que de
    fato para o robô no meio do caminho."""
    return _slam_call("POST", "/cmd/cancel_goal", {})


# --- bridge de "posso girar aqui?" (ver CONTEXT.md, "Bridge validado de
# ponta a ponta" e "SUPERADO 2026-09-21") ----------------------------------
# Motivo de existir: cancelar uma rota com o robô no meio de um corredor
# estreito podia deixá-lo TRAVADO — ao ficar sem task, ele tenta se
# reorientar sozinho pra voltar pra carga, e se não tiver espaço pra girar
# (ROTATE_ERROR), fica parado reclamando até alguém destravar manualmente
# (o que este projeto existe pra evitar ao máximo). O robô já sabe
# responder "tenho espaço pra girar X graus?" via ROS
# (`/robot_api/turn_check_angle` → `/robot_api/turn_check_ok`, confirmado
# funcionando ao vivo), só que isso não é exposto pela dispatch API nem
# pela SLAM WEB API — por isso o `robot-bridge/lifty_turn_check_bridge.py`
# (script separado, rodando no PRÓPRIO computador de bordo do robô, NUNCA
# nesta máquina) traduz isso pra um HTTP simples na mesma wifi.
TURN_CHECK_PORT = 8091
TURN_CHECK_PATH = "/check-turn"
TURN_CHECK_ANGLE_DEGREES = 180.0  # giro de "meia-volta" — o cenário de retorno pra carga que motivou tudo isso
TURN_CHECK_TIMEOUT_SECONDS = 3
# Chave geral da checagem de giro seguro (2026-10-15): o usuário decidiu NÃO
# usar o bridge da porta 8091 na VM. Desligada = robot_can_turn_safely devolve
# None na hora ("não sei", o mesmo fail-open de sempre: a rota começa e o
# cancelamento acontece sem esperar giro seguro), SEM abrir conexão nenhuma —
# senão cada início/cancelamento tentaria falar com a 8091 e, se a rede da VM
# descartar essa porta, perderia até TURN_CHECK_TIMEOUT_SECONDS por tentativa
# além de poluir o log. Pra voltar a usar o bridge: True + bridge rodando no
# robô (ver robot-bridge/).
TURN_CHECK_ENABLED = False


def _turn_check_url(angle):
    host = urllib.parse.urlparse(ROBOT_HOST).hostname
    return "http://%s:%d%s?angle=%s" % (host, TURN_CHECK_PORT, TURN_CHECK_PATH, angle)


def robot_can_turn_safely(angle=TURN_CHECK_ANGLE_DEGREES):
    """True/False = resposta de verdade do robô. None = não deu pra saber
    (bridge fora do ar, ainda não instalado nesse robô, rede indisponível
    agora) — quem chama decide o que fazer com "não sei" (ver
    _queue_cancel_current: hoje trata como "segue com o comportamento
    antigo", pra essa checagem nova nunca travar um cancelamento se o
    bridge não estiver rodando)."""
    if not TURN_CHECK_ENABLED:
        return None
    try:
        with urllib.request.urlopen(_turn_check_url(angle), timeout=TURN_CHECK_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read())
        return bool(data.get("safe"))
    except Exception as err:
        print("Aviso: check-turn indisponível (%s) — tratando como 'não sei'." % err)
        return None


# --- garfo de volta à altura de navegação (2026-10-26) ---------------------
# O app do tablet manda a MCU levar o garfo pra altura de navegação (~300 mm,
# configurada no app dispatch) só quando começa a navegar DEPOIS de concluir
# uma ação. Depois de um CANCELAMENTO ou de chegar na ENERGIA ele pula esse
# passo (forklift_log do app, 20-26/10: sem o passo em 45 de 69 coletas após
# cancelamento e 16 de 21 após a energia) e a coleta seguinte começa com o
# garfo embaixo (~20 mm). Aí o comando de altura de coleta leva o garfo
# SUBINDO e ele para ~2,5 cm acima do normal (6,5 cm: ~71-75 mm subindo
# contra ~49 mm descendo de 300 mm) -- o motor passa do alvo conforme a
# direção, e a altura de navegação é o que garante que a coleta sempre chega
# descendo. Também com pallet no garfo: depois de um cancelamento pós-coleta
# o app não volta pra 300 mm e a devolução pode viajar a ~12 cm.
# O bridge do robô (robot-bridge/, mesma porta do check-turn) publica o MESMO
# comando que o app usa. Só é chamado entre tarefas e com o robô fora do lote
# (cancelamento executado pela regra do eixo do docking, ou saindo do
# carregador) -- nunca no meio de uma ação do app nem depois de cancelamento
# forçado (Limit Breaker), que pode acontecer com o garfo dentro do lote.
# Fail-open: bridge fora do ar = segue como antes, sem travar nada.
FORK_NAV_HEIGHT_ENABLED = True
FORK_NAV_HEIGHT_PATH = "/fork-nav-height"
FORK_NAV_HEIGHT_SETTLE_SECONDS = 2.5  # medido: o garfo sobe de ~20 pra ~300 mm em ~3 s, de ~120 em ~1,5 s


def robot_fork_to_nav_height(reason, settle=True):
    """Manda o garfo pra altura de navegação e (settle=True) espera ele chegar
    antes de devolver. True = comando aceito pelo bridge; False = não deu
    (segue sem)."""
    if not FORK_NAV_HEIGHT_ENABLED:
        return False
    host = urllib.parse.urlparse(ROBOT_HOST).hostname
    url = "http://%s:%d%s" % (host, TURN_CHECK_PORT, FORK_NAV_HEIGHT_PATH)
    try:
        req = urllib.request.Request(url, data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=TURN_CHECK_TIMEOUT_SECONDS) as resp:
            resp.read()
    except Exception as err:
        print("Aviso: não consegui mandar o garfo pra altura de navegação (%s): %s -- segue sem." % (reason, err))
        return False
    if not settle:
        print("Garfo -> altura de navegação (%s)." % reason)
        return True
    print("Garfo -> altura de navegação (%s); aguardando %.1fs antes de seguir." % (reason, FORK_NAV_HEIGHT_SETTLE_SECONDS))
    time.sleep(FORK_NAV_HEIGHT_SETTLE_SECONDS)
    return True


# --- destravamento manual do ROTATE_ERROR (ver "Destravamento manual do
# ROTATE_ERROR" no CONTEXT.md, ideia e validação de campo do usuário,
# 2026-09-24) --------------------------------------------------------------
# Achado em campo: girar o robô manualmente (modo manual, 180°) nesses
# pontos SEMPRE destrava a navegação, mesmo o check-turn já validando o giro
# antes — confirma que é a pilha de navegação (`/move_base`, camada
# diferente do check-turn, ver CONTEXT.md "e quanto a desligar os
# sensores?") que trava, não falta de espaço de verdade.
#
# Ajuste do usuário (2026-09-24): NÃO alinhar com o destino final (energia)
# — alinhar com o ÚLTIMO NÓ CALIBRADO que o robô percorreu, porque é a
# orientação da ARESTA do grafo fixo (ex: "parou entre HCD -> P15, sentido
# P15, alinha com o HCD") que indica se está de verdade alinhado com a
# rota, não o rumo em linha reta até um destino distante (que pode ficar em
# qualquer direção, sem relação nenhuma com a aresta local). Como o
# ROTATE_ERROR não informa quais dois nós formam a aresta onde o
# "virtual_NNN" travou, a aproximação prática é achar o ponto calibrado
# MAIS PRÓXIMO da posição atual (arestas do grafo costumam ser curtas, o
# mais próximo tende a ser uma das duas pontas) e usar o `theta` PRÓPRIO
# desse ponto (já calibrado com a orientação da aresta) como alvo — não um
# rumo calculado até ele.
# `cmd/turn` (o comando "gire X graus e pare sozinho") se mostrou QUEBRADO
# nesse robô — testado exaustivamente em campo 2026-09-24 (7+ variações de
# corpo, inclusive de dentro do próprio robô via SSH/localhost, sempre
# `HTTP 400 "Request body is not correct"`). `cmd/speed` (velocidade
# contínua, sem noção de ângulo) FUNCIONA — confirmado com giro físico real
# em teste ao vivo — mas com resposta atrasada/amortecida que não dá pra
# prever direito ("vth×tempo = ângulo" não bateu, girou muito menos que a
# conta). Decisão do usuário: não precisa ser exato — um empurrãozinho na
# direção certa, mesmo pequeno, já é o suficiente pra quebrar o travamento
# (mesmo espírito do giro manual de 180° que já funcionava — o que importa
# é sair do estado travado, não acertar um ângulo específico). Por isso: em
# vez de calcular um tempo pra atingir um ângulo exato, manda uma sequência
# curta e fixa de `cmd/speed` na direção certa, sempre terminando com um
# comando de parar garantido (mesmo se algo falhar no meio).
ROTATE_ERROR_NUDGE_ANGULAR_SPEED = 0.15  # rad/s -- mesmo valor testado ao vivo, confirmado que produz giro real
ROTATE_ERROR_NUDGE_DURATION_SECONDS = 3.0  # duração total do empurrãozinho -- mesma do teste que girou de verdade
ROTATE_ERROR_NUDGE_COMMAND_INTERVAL_SECONDS = 0.25  # reenvio (doc pede ~300ms pra movimento contínuo)
ROTATE_ERROR_NUDGE_CHECK_ANGLE_DEGREES = 20.0  # ângulo conservador (maior que o giro real esperado) pra pedir confirmação do check-turn antes de empurrar

_last_handled_rotate_error_id = {"value": None}  # em memória de propósito -- um reinício do servidor só reseta essa otimização, não é um estado que precise sobreviver


def robot_fetch_recent_error_records(size=5):
    data = _robot_call("GET", "/error/records?size=" + str(size)) or {}
    return data.get("records") or []


def robot_pose():
    """{'x','y','theta'} — posição/orientação atual do robô (SLAM WEB API,
    já alcançável sem bridge nenhum)."""
    data = _slam_call("GET", "/reeman/pose")
    return {"x": data["x"], "y": data["y"], "theta": data["theta"]}


# --- Robô no mapa do site (pedido do usuário, 2026-10-28) -------------------
# Posição ao vivo pro ícone do robô no FloorPlanCanvas. Endpoint próprio, fora
# do /api/live-state: a pose muda a cada segundo e o live-state re-renderiza
# o app inteiro quando muda. Sob demanda e compartilhada: no máximo uma
# leitura ao robô a cada ROBOT_POSE_MAX_AGE_SECONDS, não importa quantos
# tablets estejam com o mapa aberto, e nenhuma se ninguém estiver olhando.
# Uma leitura lenta (robô fora do ar) não segura ninguém: quem chega durante
# ela recebe a última pose conhecida.
ROBOT_POSE_PATH = "/api/robot-pose"
ROBOT_POSE_MAX_AGE_SECONDS = 0.8
_robot_pose_cache = {"pose": None, "ok": False, "at": -1e9}
_robot_pose_lock = threading.Lock()


def _cached_robot_pose():
    if time.monotonic() - _robot_pose_cache["at"] >= ROBOT_POSE_MAX_AGE_SECONDS \
            and _robot_pose_lock.acquire(blocking=False):
        try:
            try:
                _robot_pose_cache.update(pose=robot_pose(), ok=True)
            except Exception:
                _robot_pose_cache["ok"] = False  # mantém a última pose; o front decide o que fazer
            _robot_pose_cache["at"] = time.monotonic()
        finally:
            _robot_pose_lock.release()
    return dict(_robot_pose_cache["pose"] or {}, ok=_robot_pose_cache["ok"])


# Grafo de rotas do dispatch (mesmo desenhado no painel do dispatch): só as
# arestas como segmentos [x1, y1, x2, y2] em metros + a posição dos pontos
# com nome (o front cruza com os pontos/lotes calibrados na planta pra achar
# a transformação mapa do robô -> imagem). Todas as arestas do mapa atual
# são retas (type 0, sem controlPositions). Muda só quando alguém edita o
# mapa no dispatch -- cache longo.
ROUTE_GRAPH_PATH = "/api/route-graph"
ROUTE_GRAPH_CACHE_SECONDS = 600
_route_graph_cache = {"data": None, "at": -1e9}


def _route_graph():
    if _route_graph_cache["data"] is None or time.monotonic() - _route_graph_cache["at"] >= ROUTE_GRAPH_CACHE_SECONDS:
        maps = _robot_call("GET", "/map/list/details/" + ROBOT_PROJECT_ID) or []
        m = next((m for m in maps if m.get("name") == ROBOT_TARGET_MAP), None)
        if m is None:
            raise RuntimeError("mapa %s não encontrado no projeto %s" % (ROBOT_TARGET_MAP, ROBOT_PROJECT_ID))
        edges = [[round(v, 3) for v in (e["startPosition"][0], e["startPosition"][1], e["endPosition"][0], e["endPosition"][1])]
                 for e in m.get("edges") or [] if e.get("startPosition") and e.get("endPosition")]
        points = {p["name"]: [round(p["position"][0], 3), round(p["position"][1], 3)]
                  for p in m.get("points") or [] if p.get("name") and len(p.get("position") or []) >= 2}
        # Pro caminho planejado (desenho da rota no site): [de, para, custo
        # de->para, custo para->de], custo = comprimento / velocidade máxima
        # daquele sentido, None = sentido proibido. Com esse custo, o caminho
        # mais rápido bate EXATO com o globalPath que o dispatch mandou ao robô
        # em 126 de 130 ordens dos logs de campo (2026-10-27/28; só distância
        # batia 112).
        links = []
        for e in m.get("edges") or []:
            dirs = {d.get("direction"): d for d in e.get("edgeDirections") or []}
            cost = [round(dirs[k]["length"] / max(dirs[k].get("maxSpeed") or 1.0, 0.05), 3) if k in dirs else None for k in (0, 1)]
            if e.get("startPoint") and e.get("endPoint") and (cost[0] is not None or cost[1] is not None):
                links.append([e["startPoint"], e["endPoint"], cost[0], cost[1]])
        _route_graph_cache.update(data={"edges": edges, "points": points, "links": links}, at=time.monotonic())
    return _route_graph_cache["data"]


def _robot_carrying(state):
    """Tipo do pallet no garfo ('blue'/'wood') ou None -- pro ícone do robô.
    Com pallet: rota atual já disparada e coleta concluída (pickupCleared;
    o UNLOAD isolado já nasce assim), ou cancelamento pós-coleta esperando o
    UNLOAD ser disparado. A rota sai de currentRoute no FINISHED, quando o
    pallet já foi deixado."""
    pending = state.get("pendingPostPickupUnload")
    if pending:
        return pending.get("palletType") or "wood"
    current = state.get("currentRoute") or {}
    if current.get("taskName") and state.get("pickupCleared"):
        return current.get("palletType") or "wood"
    return None


def robot_find_nearest_point(pose, target_map=ROBOT_TARGET_MAP):
    """{'name','x','y','theta'} do ponto calibrado mais próximo da pose
    atual, ou None se a lista falhar/vier vazia. Aproximação pro "último nó
    percorrido" (ver comentário acima) — o `theta` vem direto da
    calibração do ponto, não de um cálculo de rumo."""
    try:
        points = _robot_call("GET", "/map/point/list/" + target_map) or []
    except Exception:
        return None
    best = None
    best_dist = None
    for p in points:
        pos = p.get("position") or []
        if len(pos) < 3:
            continue
        d = math.hypot(pos[0] - pose["x"], pos[1] - pose["y"])
        if best_dist is None or d < best_dist:
            best_dist = d
            best = {"name": p.get("name"), "x": pos[0], "y": pos[1], "theta": pos[2]}
    return best


def _normalize_angle_degrees(delta_radians):
    """Normaliza uma diferença de ângulo (radianos) pra graus em
    (-180, 180]."""
    delta = (delta_radians + math.pi) % (2 * math.pi) - math.pi
    return math.degrees(delta)


# Manda uma sequência curta e fixa de `cmd/speed` (giro no lugar, vx=0) na
# direção indicada (`direction_sign`: +1 esquerda, -1 direita — mesma
# convenção do check:turn_angle), reenviando a cada
# ROTATE_ERROR_NUDGE_COMMAND_INTERVAL_SECONDS (a doc do `cmd/speed` pede
# reenvio pra movimento contínuo) até completar ROTATE_ERROR_NUDGE_
# DURATION_SECONDS. O `finally` GARANTE um comando de parar
# (`vth:0`) no final, mesmo se algo falhar no meio do caminho — nunca deixa
# o robô girando sem um comando de parada explícito.
def _send_rotate_nudge(direction_sign):
    vth = ROTATE_ERROR_NUDGE_ANGULAR_SPEED * (1 if direction_sign >= 0 else -1)
    deadline = time.time() + ROTATE_ERROR_NUDGE_DURATION_SECONDS
    try:
        while time.time() < deadline:
            try:
                _slam_call("POST", "/cmd/speed", {"vx": 0, "vth": vth})
            except Exception as err:
                print("Aviso: falha ao mandar cmd/speed durante o giro (%s) -- tenta de novo até o teto." % err)
            time.sleep(ROTATE_ERROR_NUDGE_COMMAND_INTERVAL_SECONDS)
    finally:
        try:
            _slam_call("POST", "/cmd/speed", {"vx": 0, "vth": 0})
        except Exception as err:
            print("Aviso: falha ao mandar o comando de PARAR depois do giro manual: %s" % err)


# Detecta um ROTATE_ERROR novo (a AUTO_SYSTEM nativa tentou girar rumo à
# energia e travou, ver CONTEXT.md) e tenta destravar: cancela a task
# travada, descobre a DIREÇÃO certa alinhando com o último nó calibrado
# percorrido (ver comentário acima — só a direção importa, não o ângulo
# exato), confirma com o check-turn pra um ângulo conservador nessa direção
# (só age com resposta True EXPLÍCITA — diferente do resto do sistema, aqui
# estamos comandando movimento ativamente, "não sei" não é suficiente) e
# manda o empurrãozinho. Best-effort em cada etapa — qualquer falha no meio
# só desiste dessa tentativa, o próximo ROTATE_ERROR novo aciona outra.
def _recover_from_rotate_error_if_stuck():
    try:
        records = robot_fetch_recent_error_records(size=5)
    except Exception:
        return
    error = next((r for r in records if r.get("error") == "ROTATE_ERROR"), None)
    if not error or error.get("id") == _last_handled_rotate_error_id["value"]:
        return
    _last_handled_rotate_error_id["value"] = error["id"]
    print("ROTATE_ERROR novo detectado (id=%s) -- tentando destravar com um giro (nudge)." % error["id"])

    try:
        stuck_id = robot_find_active_charge_task_id()
        if stuck_id:
            robot_cancel_task_record(stuck_id)
    except Exception as err:
        print("Aviso: falha ao cancelar a task travada antes do giro: %s" % err)
    try:
        robot_stop_navigation()
    except Exception as err:
        print("Aviso: cancel_goal falhou antes do giro: %s" % err)

    try:
        pose = robot_pose()
    except Exception as err:
        print("Aviso: não deu pra ler a pose pra decidir a direção do giro: %s" % err)
        return
    nearest = robot_find_nearest_point(pose)
    if nearest is None:
        print("Aviso: não achei nenhum ponto calibrado próximo -- desisto do giro.")
        return
    angle = _normalize_angle_degrees(nearest["theta"] - pose["theta"])
    direction_sign = 1 if angle >= 0 else -1
    check_angle = ROTATE_ERROR_NUDGE_CHECK_ANGLE_DEGREES * direction_sign
    print("Alinhando com '%s' (nó calibrado mais próximo) -- direção %s (ângulo real %.1f, checando %.0f)." % (
        nearest["name"], "esquerda" if direction_sign > 0 else "direita", angle, check_angle))

    safe = robot_can_turn_safely(check_angle)
    if safe is not True:
        print("Giro NÃO confirmado seguro pelo check-turn (ângulo checado=%.0f, safe=%s) -- desisto." % (check_angle, safe))
        return

    print("Empurrando pra %s por %.1fs (vth=%.2f rad/s)." % (
        "esquerda" if direction_sign > 0 else "direita", ROTATE_ERROR_NUDGE_DURATION_SECONDS, ROTATE_ERROR_NUDGE_ANGULAR_SPEED))
    _send_rotate_nudge(direction_sign)


# --- cancelamento via alinhamento do docking point (ver CONTEXT.md,
# "Cancelamento antes do pickup via alinhamento de docking" e "Cancelamento
# pós-pickup", pedido do usuário 2026-09-24/2026-09-30) ---------------------
# Descoberta de campo: ao chegar em QUALQUER ponto de pallet (seja o pickup
# ANTES de pegar, seja o dropoff DEPOIS, já carregando), o robô sempre passa
# por uma sequência fixa e confiável: para sobre o docking point
# (nomenclatura "H" + nome do ponto, ex. pallet "CD" -> docking "HCD") e gira
# PARA ALINHAR os garfos com o ponto (não é um alinhamento perfeito). É um
# giro que o robô já faz de qualquer jeito, de forma confiável — diferente de
# forçar um giro ad-hoc (ver "Destravamento manual do ROTATE_ERROR" acima),
# não corre risco de ROTATE_ERROR. Por isso é uma referência de segurança
# MELHOR que o check-turn pra esse trecho específico (que depende do
# main_forklift_node, já visto divergindo do que o /move_base realmente
# executa — ver "Varredura ao vivo" no CONTEXT.md).
#
# Logo depois desse giro o reconhecimento de câmera começa (quase instantâneo
# segundo o usuário) e a partir daí não dá mais pra cancelar aquela ação
# (pickup OU dropoff). Por isso cancela um pouco ANTES do giro completar
# (margem de DOCKING_ALIGNMENT_CANCEL_MARGIN_DEGREES) em vez de esperar o
# alinhamento perfeito.
#
# Até 2026-09-29, isso só valia ANTES do pickup — depois (carregando o
# pallet) caía no check-turn tradicional, porque não tínhamos como criar uma
# task só com UNLOAD (a estrutura do dispatch exige pickup+dropoff). Em
# 2026-09-30 descobrimos que `POST /task-template/generic/chain` aceita uma
# ação isolada (confirmado ao vivo, o site do fabricante recusa mas a API
# aceita — ver CONTEXT.md, "Cancelamento pós-pickup") — então o MESMO
# mecanismo de alinhamento agora vale pros dois lados: antes do pickup, usa
# o ponto de ORIGEM; depois (pickup_cleared), usa o ponto de DESTINO (é lá
# que o robô vai alinhar de qualquer jeito a caminho de largar o pallet). Ver
# `_execute_cancel_current_locked`/`robot_create_and_run_unload_chain` pra o
# que acontece DEPOIS de cancelar nesse segundo caso.
DOCKING_ALIGNMENT_CANCEL_MARGIN_DEGREES = 30.0  # "faltando uns 30" -- pedido explícito do usuário
# EIXO do docking (2026-10-23) -- substitui o raio de 1,5 m em volta do H.
# Incidente de campo 2026-10-22 (FDtoFD2, 2 vezes): vindo pelo oeste
# (P18 -> P16), o robô anda PARALELO ao pallet FD, então "a <=1,5 m do HFD e
# a <=30° do theta" ficou verdadeiro no meio da curva ao lado do P16, a 1,44 m
# DE LADO do eixo do docking -- cancelou longe do HFD. Auditoria de 150
# aproximações reais (heartbeats do dispatch, 10/10 a 23/10): o raio
# disparava fora do eixo em 15 delas (lotes F*, NA/NB, DD2, CAY2, A4); a regra
# do eixo dispara no MESMO instante nas outras 135 e, nessas 15, só quando o
# robô já está sobre o eixo (2-7 s antes de chegar no H).
# O eixo é a reta pallet -> H (sentido do theta do pallet). `s` = posição ao
# longo dela a partir do H: positivo = à frente do H (de onde o robô chega --
# nos lotes F* ele gira no nó P5/P6/P12/P13, ~0,7 m à frente, e entra de ré
# até o H); negativo = já entrando no pallet.
DOCKING_ALIGNMENT_CANCEL_LATERAL_METERS = 0.35  # desvio máximo DE LADO do eixo (medido em campo: <=0,05 m sobre o eixo; ~1,2-1,4 m nos falsos positivos)
DOCKING_ALIGNMENT_CANCEL_AHEAD_METERS = 1.0  # até onde à frente do H ainda conta (nó de giro dos lotes F* fica a 0,64-0,91 m)
DOCKING_ALIGNMENT_CANCEL_BEHIND_METERS = 0.2  # passou disso pra dentro do pallet = já começou a entrada, não cancela mais aquela ação
DOCKING_ALIGNMENT_CANCEL_POLL_INTERVAL_SECONDS = 0.5  # bem mais rápido que o cancelPending comum (2s) -- a janela entre "dentro da margem de 30°" e a câmera travar é curta, dos dois lados


def robot_point_positions(target_map=ROBOT_TARGET_MAP):
    """{nome: {'x','y','theta'}} de todos os pontos calibrados do mapa, numa
    chamada só, ou None se a lista falhar."""
    try:
        points = _robot_call("GET", "/map/point/list/" + target_map) or []
    except Exception:
        return None
    result = {}
    for p in points:
        pos = p.get("position") or []
        if p.get("name") and len(pos) >= 3:
            result[p["name"]] = {"x": pos[0], "y": pos[1], "theta": pos[2]}
    return result


def robot_find_point_position(name, target_map=ROBOT_TARGET_MAP):
    """{'x','y','theta'} do ponto calibrado de nome EXATO `name`, ou None se
    não existir/a lista falhar -- mesma fonte de robot_find_nearest_point, só
    que por nome em vez de proximidade (aqui já sabemos exatamente qual
    ponto queremos: o docking point "H<pallet>" ou o próprio ponto de
    pallet)."""
    return (robot_point_positions(target_map) or {}).get(name)


def _docking_axis_geometry(pose, docking, pallet):
    """(s, lateral, diff) da pose em relação ao eixo do docking -- ver
    DOCKING_ALIGNMENT_CANCEL_* acima. `diff` em graus, contra o theta
    PRÓPRIO do pallet (ver correção de 2026-09-25 abaixo)."""
    ux, uy = math.cos(pallet["theta"]), math.sin(pallet["theta"])
    dx, dy = pose["x"] - docking["x"], pose["y"] - docking["y"]
    s = dx * ux + dy * uy
    lateral = abs(dy * ux - dx * uy)
    diff = abs(_normalize_angle_degrees(pallet["theta"] - pose["theta"]))
    return s, lateral, diff


def _docking_alignment_cancel_ready(pallet_point):
    """True = o robô já está sobre o EIXO do docking point ("H" +
    pallet_point) -- de lado no máximo DOCKING_ALIGNMENT_CANCEL_LATERAL_
    METERS, entre AHEAD à frente do H e BEHIND pra dentro do pallet -- e
    alinhado (dentro da margem) -- seguro cancelar agora, é o giro final que
    o robô já faz de qualquer jeito (na coleta OU na entrega, mesmo mecanismo
    dos dois lados). False = ainda não chegou lá, ainda não alinhou o
    suficiente, ou já passou do H pra dentro do pallet -- espera mais. None =
    não deu pra determinar (pose indisponível, ou os pontos
    "H<pallet_point>"/pallet_point não existem no mapa) -- quem chama decide
    o fallback.

    CORRIGIDO 2026-09-25 (1ª tentativa de campo falhou -- câmera reconheceu
    antes do cancelamento disparar): o alvo de alinhamento NÃO é o rumo
    geométrico calculado entre docking e pallet (atan2) -- é o `theta`
    PRÓPRIO calibrado do ponto de pallet, mesmo erro (e mesma correção) já
    feitos em _recover_from_rotate_error_if_stuck acima ("usar o theta do
    ponto, não um rumo calculado até ele"). Comprovado ao vivo: no par
    EXF/HEXF, o theta calibrado de ambos os pontos é -179.8°, enquanto o
    rumo geométrico HEXF->EXF dava 0.2° -- 180° de diferença. Com o rumo
    errado, a checagem de margem (30°) só batia bem depois do robô já ter
    girado de verdade (ou nunca), explicando o cancelamento tardio demais."""
    try:
        pose = robot_pose()
    except Exception as err:
        print("alinhamento de docking: pose indisponível (%s) -- cai pro check-turn." % err)
        return None
    points = robot_point_positions() or {}
    docking = points.get("H" + pallet_point)
    pallet = points.get(pallet_point)
    if docking is None or pallet is None:
        print("alinhamento de docking: docking 'H%s' ou pallet '%s' não encontrado no mapa -- cai pro check-turn." % (
            pallet_point, pallet_point))
        return None
    s, lateral, diff = _docking_axis_geometry(pose, docking, pallet)
    nearest = min(points, key=lambda n: math.hypot(points[n]["x"] - pose["x"], points[n]["y"] - pose["y"]))
    print("alinhamento de docking (%s): pose=(%.2f, %.2f, %.1f) perto de %s | eixo: s=%+.2fm (de -%.2f a +%.2f), lateral=%.2fm (limite %.2f), diff angular=%.1f (margem %.0f)" % (
        pallet_point, pose["x"], pose["y"], math.degrees(pose["theta"]), nearest,
        s, DOCKING_ALIGNMENT_CANCEL_BEHIND_METERS, DOCKING_ALIGNMENT_CANCEL_AHEAD_METERS,
        lateral, DOCKING_ALIGNMENT_CANCEL_LATERAL_METERS, diff, DOCKING_ALIGNMENT_CANCEL_MARGIN_DEGREES))
    if lateral > DOCKING_ALIGNMENT_CANCEL_LATERAL_METERS or s > DOCKING_ALIGNMENT_CANCEL_AHEAD_METERS:
        return False  # ainda a caminho do docking point (fora do eixo ou longe à frente)
    if s < -DOCKING_ALIGNMENT_CANCEL_BEHIND_METERS:
        return False  # já entrando no pallet -- essa ação não cancela mais
    return diff <= DOCKING_ALIGNMENT_CANCEL_MARGIN_DEGREES


def _cancel_poll_interval(cancel_pending):
    """Intervalo de sondagem enquanto cancelPending está ativo -- sempre o
    rápido (DOCKING_ALIGNMENT_CANCEL_POLL_INTERVAL_SECONDS): antes ou depois
    do pickup, os dois lados agora correm contra o mesmo reconhecimento de
    câmera na docagem (ver acima)."""
    return DOCKING_ALIGNMENT_CANCEL_POLL_INTERVAL_SECONDS if cancel_pending else CANCEL_PENDING_POLL_INTERVAL_SECONDS


def _current_route_cancel_ready(current, pickup_cleared):
    """Decide se é seguro cancelar a currentRoute JÁ DISPARADA agora --
    alinhamento de docking dos dois lados (ver comentário acima do arquivo):
    ANTES do pickup usa o ponto de ORIGEM, DEPOIS (pickup_cleared) usa o de
    DESTINO -- é lá que o robô vai alinhar de qualquer jeito. Sempre devolve
    True/False, nunca None.

    Sem resposta do alinhamento (pose indisponível agora, ou pontos ausentes
    no mapa) tenta o check-turn; se ele também não souber -- o normal desde
    que o bridge da 8091 foi desligado (TURN_CHECK_ENABLED = False) --
    devolve False: o cancelamento fica pendente e é reavaliado no próximo
    ciclo. Antes devolvia o None do check-turn, que os chamadores tratam
    como "pode cancelar" -- uma falha de leitura da pose cancelava a rota
    onde o robô estivesse (2026-10-23). Se ficar preso, o Limit Breaker
    força."""
    target_point = current["dropoff"] if pickup_cleared else current["pickup"]
    ready = _docking_alignment_cancel_ready(target_point)
    if ready is True:
        print("alinhamento de docking: dentro da margem -- cancelando agora.")
    if ready is not None:
        return ready
    turn_ok = robot_can_turn_safely()
    if turn_ok is None:
        print("alinhamento de docking indisponível e check-turn sem resposta -- cancelamento continua pendente.")
        return False
    return turn_ok


# --- garfo de volta à altura de navegação DEPOIS DE DEPOSITAR (2026-10-27) --
# Depois de baixar o pallet o app sai de ré até o docking point e segue pra
# próxima tarefa com o garfo no chão (~20 mm) -- o dispatch até manda
# RESET_ARM na ordem seguinte, mas o app ignora (forklift_log, 27/10 15:05).
# Subir o garfo com ele ainda dentro do pallet pode virar o pallet, então só
# sobe quando a pose diz que o garfo já saiu: sobre o eixo do docking do
# ponto de depósito (mesma geometria da regra de cancelamento), já de volta
# no H (s >= FORK_AFTER_DROP_MIN_S). Medido no CAX (27/10 15:05): a ré para
# primeiro em s=-0,17 e só depois o app gira PARADO sobre o H (s=-0,01) com
# o garfo ainda no chão -- é esse ponto do giro, onde o próprio app já mexe o
# garfo sem encostar no pallet, que libera a subida. É só UM comando de garfo,
# não mexe na ordem em andamento -- o app manda esse mesmo comando andando
# no fluxo normal.
# Janela fechada: se o robô já saiu do eixo (lateral/à frente) ou passou
# FORK_AFTER_DROP_WINDOW_SECONDS sem chegar no H, NÃO manda -- um comando
# atrasado poderia chegar quando ele já está baixando o garfo pra próxima
# coleta. Pelo mesmo motivo, não sobe se o H da coleta da rota seguinte cai
# DENTRO da faixa de subida (coletar no mesmo ponto que acabou de depositar,
# ou num lote de frente cujo H fique sobre este eixo): o app baixa o garfo
# pra coleta justamente no H, e o robô poderia estar lá ainda dentro da
# faixa. H fora da faixa (ex.: corredor paralelo, CAY2 a 1,36 m de lado do
# CAX2) não conflita -- quando o robô chega lá a vigia já saiu do eixo.
# Emergência apaga a vigia. Em memória de propósito: reiniciar o servidor só
# perde uma subida.
FORK_AFTER_DROP_WINDOW_SECONDS = 60
FORK_AFTER_DROP_POLL_INTERVAL_SECONDS = 1.0
FORK_AFTER_DROP_MIN_S = -0.10  # metros ao longo do eixo; negativo = pra dentro do pallet
FORK_AFTER_DROP_PICKUP_MARGIN_METERS = 0.3  # folga em volta da faixa de subida pro H da próxima coleta
_fork_after_drop = {"point": None, "since": 0.0, "points": None}


def _arm_fork_after_drop(point):
    _fork_after_drop.update(point=point, since=time.monotonic(), points=None)


def _clear_fork_after_drop():
    _fork_after_drop.update(point=None, points=None)


def _next_pickup_docking_in_window(points, drop_point):
    """Nome do ponto de coleta da rota atual (ainda não coletado) cujo H cai
    dentro da faixa de subida do eixo de `drop_point` (com
    FORK_AFTER_DROP_PICKUP_MARGIN_METERS de folga), ou None."""
    with QUEUE_LOCK:
        state = _read_queue_state()
    current = state.get("currentRoute") or {}
    pickup = current.get("pickup")
    if not pickup or state.get("pickupCleared"):
        return None
    docking = points.get("H" + pickup)
    if docking is None:
        return None
    m = FORK_AFTER_DROP_PICKUP_MARGIN_METERS
    s, lateral, _ = _docking_axis_geometry(dict(docking, theta=0.0), points["H" + drop_point], points[drop_point])
    if lateral <= DOCKING_ALIGNMENT_CANCEL_LATERAL_METERS + m and FORK_AFTER_DROP_MIN_S - m <= s <= DOCKING_ALIGNMENT_CANCEL_AHEAD_METERS + m:
        return pickup
    return None


def _refresh_fork_after_drop():
    """Roda a cada tick enquanto há um depósito recente. True = ainda
    vigiando (o tick deve voltar rápido); False = nada a vigiar."""
    point = _fork_after_drop["point"]
    if not point:
        return False
    if time.monotonic() - _fork_after_drop["since"] > FORK_AFTER_DROP_WINDOW_SECONDS:
        print("Garfo pós-depósito (%s): robô não voltou ao docking em %ds -- não mexe no garfo." % (point, FORK_AFTER_DROP_WINDOW_SECONDS))
        _clear_fork_after_drop()
        return False
    points = _fork_after_drop["points"]
    if points is None:
        points = robot_point_positions()
        if points is None:
            return True  # lista falhou agora -- tenta de novo no próximo tick
        if points.get("H" + point) is None or points.get(point) is None:
            print("Garfo pós-depósito: docking 'H%s' ou pallet '%s' não encontrado no mapa -- não mexe no garfo." % (point, point))
            _clear_fork_after_drop()
            return False
        _fork_after_drop["points"] = points
    try:
        pose = robot_pose()
    except Exception:
        return True  # pose indisponível agora -- tenta de novo no próximo tick
    s, lateral, _ = _docking_axis_geometry(pose, points["H" + point], points[point])
    if lateral > DOCKING_ALIGNMENT_CANCEL_LATERAL_METERS or s > DOCKING_ALIGNMENT_CANCEL_AHEAD_METERS:
        print("Garfo pós-depósito (%s): robô já saiu do eixo (s=%+.2fm, lateral=%.2fm) -- janela perdida, não mexe no garfo." % (point, s, lateral))
        _clear_fork_after_drop()
        return False
    if s < FORK_AFTER_DROP_MIN_S:
        return True  # garfo ainda dentro do pallet ou saindo de ré -- espera o H
    _clear_fork_after_drop()
    near_pickup = _next_pickup_docking_in_window(points, point)
    if near_pickup:
        print("Garfo pós-depósito (%s): H da próxima coleta (%s) fica sobre este eixo -- não mexe no garfo." % (point, near_pickup))
        return False
    with QUEUE_LOCK:
        if _read_queue_state().get("emergency"):
            return False
    print("Garfo pós-depósito (%s): fora do pallet, sobre o eixo (s=%+.2fm, lateral=%.2fm)." % (point, s, lateral))
    robot_fork_to_nav_height("depois de depositar em %s" % point, settle=False)
    return False


# --- status ao vivo do robô pro banner "Em Operação" / "Recarregando" -----
# (ver FloorPlanCanvas.jsx) — lógica binária de propósito por enquanto:
# chargeFlag==2 confirmado em campo (2026-09-14) como "carregando de
# verdade" (bateria subindo); qualquer outro valor vira "Em Operação",
# mesmo que o robô esteja só parado/ocioso sem fazer nada — refinar depois
# se precisar de um terceiro estado.
#
# Cache em memória (não persiste, não precisa — é telemetria, não estado):
# só a THREAD DE FUNDO escreve (um GET por tick, mesmo padrão de
# _emergency_suppress), os handlers HTTP só leem — assim nenhum poll de
# tablet bate no robô direto, e não têm N tablets multiplicando chamada.
# `stationarySince`: ver "Alerta de robô parado" abaixo.
_robot_status_cache = {"charging": None, "battery": None, "returningToCharge": False, "stationarySince": None, "stalledAtOrigin": None}  # None = ainda não sabemos (1ª leitura não chegou ainda)

# --- Alerta de robô parado (pedido do usuário, 2026-10-02) -----------------
# "Parado há 40 s (era 1 minuto até 2026-10-14) + rota de verdade em andamento (taskName já disparado
# -- reservada/esperando check-turn/esperando carga NÃO conta, o robô nem
# devia estar se movendo ainda) + não carregando" -- sintoma de caminho
# obstruído ou desvio de rota que o robô não resolve sozinho. `vx`/`vth`
# (GET /reeman/speed) são a mesma leitura de velocidade que o resto do
# sistema já usa pra girar (ver ROTATE_ERROR_NUDGE acima) -- "quase zero"
# em vez de exatamente zero, por ruído normal de sensor até parado.
STALL_VX_EPSILON_MPS = 0.02
STALL_VTH_EPSILON_DEG_S = 1.0
STALL_ALERT_SECONDS = 40  # era 60 s; reduzido a pedido do usuário (2026-10-14)
ROBOT_STALLED_MESSAGE = "ROBÔ PARADO! Remova obstáculos ou use o modo manual."
# Variante do alerta vermelho (pedido do usuário, 2026-10-09): robô parado
# PERTO da origem da rota e ALINHADO com ela, antes de pegar o pallet — aí o
# problema não é caminho obstruído, é o sensor do garfo enxergando o próprio
# pallet como objeto (espaçamento entre pallets pequeno demais), e a ação
# certa é abaixar o garfo no modo manual. Mesmas constantes de "perto" e
# "alinhado" do cancelamento por alinhamento de docking (validadas em campo).
ROBOT_STALLED_AT_ORIGIN_MESSAGE = ("Sensor do garfo detectou o pallet como objeto, use o modo manual "
                                   "para abaixar o garfo. Fique atento ao espaçamento correto entre pallets!")
STALL_AT_ORIGIN_RADIUS_METERS = 1.5
STALL_AT_ORIGIN_MARGIN_DEGREES = 30.0


# `battery` em `/reeman/base_encode` (documentado, nunca lido até agora —
# ver CONTEXT.md, "A API do dispatch service") — assumido 0-100 (%), a
# convenção mais comum nesse tipo de API; NÃO confirmado em campo ainda
# (diferente do chargeFlag, que já foi). Clampa/arredonda pra nunca exibir
# um número fora da faixa se a suposição do formato estiver errada; valor
# não numérico ou ausente vira None (esconde o ícone, não mostra lixo).
def _normalize_battery(raw):
    try:
        pct = round(float(raw))
    except (TypeError, ValueError):
        return None
    return max(0, min(100, pct))


def _refresh_robot_status():
    try:
        data = _slam_call("GET", "/reeman/base_encode")
        _robot_status_cache["charging"] = (data.get("chargeFlag") == 2)
        _robot_status_cache["battery"] = _normalize_battery(data.get("battery"))
    except Exception:
        pass  # robô/rede indisponível agora — mantém o último valor conhecido, tenta de novo no próximo tick
    # 3º estado do banner (ver RobotStatusBanner.jsx): "voltando à energia"
    # sozinho (AUTO_SYSTEM nativa), ainda não chegou/começou a carregar de
    # verdade -- reusa _robot_returning_to_charge_now (já cuida de devolver
    # False se `charging` já é True) no MESMO ciclo da thread de fundo, não
    # por requisição HTTP (senão cada tablet multiplicaria a chamada extra
    # ao robô, mesma preocupação de charging/battery acima).
    try:
        _robot_status_cache["returningToCharge"] = _robot_returning_to_charge_now()
    except Exception:
        pass
    # Rastreio de "parado há quanto tempo" (ver "Alerta de robô parado"
    # acima) -- marca o instante em que ficou quase-zero; qualquer
    # velocidade de verdade (ou falha de rede, tratada como "não sei")
    # zera a marca na hora, o relógio só conta enquanto fica quieto sem
    # interrupção.
    try:
        speed = _slam_call("GET", "/reeman/speed")
        vx = float(speed.get("vx") or 0)
        vth = float(speed.get("vth") or 0)
        if abs(vx) < STALL_VX_EPSILON_MPS and abs(vth) < STALL_VTH_EPSILON_DEG_S:
            if _robot_status_cache["stationarySince"] is None:
                _robot_status_cache["stationarySince"] = time.monotonic()
        else:
            _robot_status_cache["stationarySince"] = None
    except Exception:
        _robot_status_cache["stationarySince"] = None


def _refresh_stall_at_origin():
    """Roda na thread de fundo (mesmo ciclo de _refresh_robot_status): quando o
    robô está parado há tempo suficiente pro alerta vermelho E a rota atual
    ainda não pegou o pallet, confere se ele está perto da origem e alinhado
    com ela. Guarda o resultado (e de QUAL rota) em _robot_status_cache — o
    GET /api/live-state de cada tablet só lê isso, nunca fala com o robô. Só
    gasta chamadas ao robô enquanto o alerta está de fato disparado (raro)."""
    result, route_id = False, None
    try:
        since = _robot_status_cache.get("stationarySince")
        if since is not None and not _robot_status_cache.get("charging") \
                and time.monotonic() - since >= STALL_ALERT_SECONDS:
            with QUEUE_LOCK:
                state = _read_queue_state()
            cur = state.get("currentRoute") or {}
            pickup = cur.get("pickup")
            if pickup and cur.get("taskName") and not cur.get("unloadOnly") and not state.get("pickupCleared"):
                route_id = cur.get("id")
                pose = robot_pose()
                pallet = robot_find_point_position(pickup)
                docking = robot_find_point_position("H" + pickup)
                if pallet is not None:
                    dists = [math.hypot(pose["x"] - pt["x"], pose["y"] - pt["y"]) for pt in (pallet, docking) if pt is not None]
                    diff = abs(_normalize_angle_degrees(pallet["theta"] - pose["theta"]))
                    result = min(dists) <= STALL_AT_ORIGIN_RADIUS_METERS and diff <= STALL_AT_ORIGIN_MARGIN_DEGREES
                    print("robô parado: perto da origem '%s'=%s (dist=%.2fm, diff angular=%.1f°)" % (pickup, result, min(dists), diff))
    except Exception as err:  # robô/rede indisponível: cai na mensagem genérica
        print("robô parado: não deu pra checar a origem (%s) -- usa o aviso genérico." % err)
        result, route_id = False, None
    _robot_status_cache["stalledAtOrigin"] = result
    _robot_status_cache["stalledAtOriginRouteId"] = route_id


# --- Aviso de "planejando a rota" no corredor P3–P10 (pedido do usuário, 2026-10-14)
# O dispatch demora ~130 s pra publicar a ordem quando o robô está parado num
# ponto de docking do corredor (28 ciclos de planejamento de ~4,7 s por causa
# das arestas sobrepostas P3/P10 -> pontos H*; ver CONTEXT.md, "Investigação
# da demora de início"). Medido no log do dispatch: depois de uma tarefa normal
# o robô fica no nó do LOTE (fora da faixa) e planeja em ~10 s; depois de um
# cancelamento fica no docking e leva ~132 s. Só mostra aviso — não muda
# fila, disparo nem cancelamento.
#   - menta enquanto a rota atual já foi criada no robô, ainda não está
#     RUNNING, o robô está parado e dentro da faixa entre P3 e P10;
#   - vermelho se passar de ROUTE_PLANNING_LATE_SECONDS sem começar.
# Enquanto o aviso vale, o alerta genérico de "robô parado" (STALL_ALERT_SECONDS) é
# suprimido — o robô está parado de propósito, esperando o planejador.
ROUTE_PLANNING_MESSAGE = "Planejando a rota... pode levar até ~2 min. Aguarde."
ROUTE_PLANNING_LATE_MESSAGE = "Planejamento da rota demorando mais de 140 s. Verifique o robô ou cancele e tente de novo."
ROUTE_PLANNING_LATE_SECONDS = 140
ROUTE_PLANNING_CORRIDOR_POINTS = ("P3", "P10")  # extremos do corredor (no mapa do robô)
# Docking das duas colunas ficam a ≤0,8 m da reta P3–P10; os nós dos lotes
# (onde o robô fica depois de uma tarefa normal, e planeja rápido) a ≥1,7 m.
ROUTE_PLANNING_CORRIDOR_HALF_WIDTH_METERS = 1.2
ROUTE_PLANNING_CORRIDOR_CACHE_SECONDS = 600
# Outros pontos onde o mesmo planejamento lento foi visto em campo (pedido do
# usuário, 2026-10-28). Aqui não é uma faixa de corredor: o robô fica parado
# no eixo de docking do ponto (entre o lote e o H dele) -- a zona é esse
# segmento, com folga.
ROUTE_PLANNING_SLOW_POINTS = ("EXE", "EXE2", "EXM", "EXN", "EXO", "EXP", "EXQ")
ROUTE_PLANNING_POINT_RADIUS_METERS = 0.6  # o robô para no H com precisão de cm; os lotes EX vizinhos ficam a ~1,2 m
_route_planning_cache = {"routeId": None, "started": None, "inCorridor": False, "inCorridorRouteId": None}
_corridor_endpoints_cache = {"at": None, "a": None, "b": None, "slow": []}


def _note_route_record(current, record):
    """Chamada pelo _queue_tick com o task-record que ele JÁ leu (nenhuma
    chamada extra ao robô): guarda se a rota atual já está RUNNING."""
    try:
        status = record.get("status")
        _route_planning_cache["routeId"] = current.get("id")
        _route_planning_cache["started"] = (status == "RUNNING") or bool(_is_terminal_status(status))
    except Exception:
        pass


def _corridor_endpoints():
    """((x,y) de P3, (x,y) de P10) ou None. Cache de 10 min — o mapa quase não
    muda. Na mesma leitura, guarda os eixos (ponto, H) de
    ROUTE_PLANNING_SLOW_POINTS em cache["slow"]."""
    cache = _corridor_endpoints_cache
    now = time.monotonic()
    if cache["at"] is not None and now - cache["at"] < ROUTE_PLANNING_CORRIDOR_CACHE_SECONDS and cache["a"] and cache["b"]:
        return cache["a"], cache["b"]
    points = _robot_call("GET", "/map/point/list/" + ROBOT_TARGET_MAP) or []
    found = {}
    for p in points:
        name = p.get("name")
        pos = p.get("position") or []
        if len(pos) >= 2:
            found[name] = (pos[0], pos[1])
    a, b = found.get(ROUTE_PLANNING_CORRIDOR_POINTS[0]), found.get(ROUTE_PLANNING_CORRIDOR_POINTS[1])
    if not a or not b:
        return None
    cache["slow"] = [(found[n], found.get("H" + n, found[n])) for n in ROUTE_PLANNING_SLOW_POINTS if n in found]
    cache["at"], cache["a"], cache["b"] = now, a, b
    return a, b


def _segment_distance(pose, a, b, margin_fraction=0.0):
    """Distância da pose ao segmento a-b; None se a projeção cai fora dele
    (além de `margin_fraction` do comprimento em cada ponta)."""
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 <= 0:
        return math.hypot(pose["x"] - ax, pose["y"] - ay)
    t = ((pose["x"] - ax) * dx + (pose["y"] - ay) * dy) / length2
    if t < -margin_fraction or t > 1 + margin_fraction:
        return None
    return abs((pose["x"] - ax) * dy - (pose["y"] - ay) * dx) / math.sqrt(length2)


def _in_planning_corridor(pose):
    ends = _corridor_endpoints()
    if not ends:
        return False
    dist = _segment_distance(pose, ends[0], ends[1], margin_fraction=0.02)
    if dist is not None and dist <= ROUTE_PLANNING_CORRIDOR_HALF_WIDTH_METERS:
        return True
    # Pontos EX*: no eixo lote<->H, ou a até ROUTE_PLANNING_POINT_RADIUS_METERS
    # de qualquer uma das pontas.
    for pallet, dock in _corridor_endpoints_cache.get("slow") or []:
        d = _segment_distance(pose, pallet, dock)
        if (d is not None and d <= ROUTE_PLANNING_POINT_RADIUS_METERS) or min(
                math.hypot(pose["x"] - p[0], pose["y"] - p[1]) for p in (pallet, dock)) <= ROUTE_PLANNING_POINT_RADIUS_METERS:
            return True
    return False


def _refresh_route_planning_wait():
    """Thread de fundo (junto de _refresh_stall_at_origin): só pergunta a pose
    ao robô quando a rota atual já foi disparada, ainda não está RUNNING e o
    robô está parado — o resto do tempo não gasta chamada nenhuma."""
    inside, route_id = False, None
    try:
        with QUEUE_LOCK:
            state = _read_queue_state()
        cur = state.get("currentRoute") or {}
        c = _route_planning_cache
        if (cur.get("taskName") and not state.get("cancelPending")
                and _route_fired_at.get("t") is not None
                and c.get("routeId") == cur.get("id") and c.get("started") is False
                and _robot_status_cache.get("stationarySince") is not None
                and not _robot_status_cache.get("charging")):
            inside = _in_planning_corridor(robot_pose())
            route_id = cur.get("id")
    except Exception:
        inside, route_id = False, None  # robô/rede indisponível: sem aviso (cai no comportamento antigo)
    _route_planning_cache["inCorridor"] = inside
    _route_planning_cache["inCorridorRouteId"] = route_id


def _route_planning_elapsed(state):
    """Segundos desde o disparo da rota atual, ou None se não estamos
    esperando o planejamento do dispatch (ver bloco acima)."""
    cur = state.get("currentRoute") or {}
    c = _route_planning_cache
    if not (cur.get("taskName") and not state.get("cancelPending") and c.get("inCorridor")
            and c.get("inCorridorRouteId") == cur.get("id") and c.get("started") is False):
        return None
    fired = _route_fired_at.get("t")
    if fired is None:
        return None
    return time.monotonic() - fired


def _route_planning_message(state):
    """Aviso menta (None se não vale ou se já passou do limite -> vira o vermelho)."""
    elapsed = _route_planning_elapsed(state)
    if elapsed is None or elapsed >= ROUTE_PLANNING_LATE_SECONDS:
        return None
    return ROUTE_PLANNING_MESSAGE


# --- Obstáculo pelos sensores do robô (pedido do usuário, 2026-10-28) -------
# O app do robô para sozinho quando um sensor de distância marca algo perto
# na direção em que ele anda, e fala "saia do caminho" -- mas a fala não vai
# pra log nenhum. Medido em campo (bloqueios de propósito, 2026-10-28): as
# distâncias que o app usa saem em /mobile_base/commands/fork_info (cm, 255 =
# livre, ~5 Hz) -- parou com front=71 (frente) e back=31 (lado dos garfos) e
# voltou a andar no instante em que o valor voltou a 255. O bridge expõe isso
# em GET /obstacle; uma thread própria consulta a cada ~1 s SÓ com rota
# disparada, e o aviso sai em ~2-3 s em vez dos 40 s do alerta de "parado"
# (que continua de reserva se o bridge cair).
#   - fora do lote: parado >= OBSTACLE_STOPPED_SECONDS com front/back abaixo
#     do limite -> "obstáculo à frente/atrás" com a distância;
#   - na faixa de encaixe (eixo do docking da coleta/entrega, entre o H e o
#     pallet): o sensor de trás vê o pallet normalmente, então só depois de
#     OBSTACLE_DOCKING_STOPPED_SECONDS parado -- e aí, com o de trás, é o
#     "sensor do garfo viu o pallet" de verdade (antes era chute por posição);
#   - esperando o planejador do dispatch (corredor P3-P10): nunca -- o robô
#     está parado no H de propósito, com os garfos de frente pro lote.
# Ajustes pelo dia inteiro de coleta (todas as paradas >= 1,5 s com sensor
# perto, 2026-10-28):
#   - laterais também param o robô (bloqueios de propósito: parou com 45-58
#     e 19 cm) -> entram, com limite próprio;
#   - leitura 0-2 = sensor mascarado pelo app (aparece parado nos H, nos
#     lotes), não objeto colado -> ignorada;
#   - com pallet no garfo o sensor de trás enxerga a própria carga (6-47 cm
#     nos H depois da coleta) -> ignorado enquanto carrega;
#   - paradas normais em nós com parede perto duram 1,8-1,9 s; bloqueio de
#     verdade, 20-40 s -> pede 3 s parado.
OBSTACLE_PATH = "/obstacle"
OBSTACLE_WATCH_INTERVAL_SECONDS = 1.0
# Limites: o robô para quando um sensor fica abaixo da distância de desvio
# do TRECHO atual (o app troca por rota/ponto: [100,100,30,30], [0,30,0,0],
# [100,100,100,100]... -- confirmado ao vivo: parado com a direita a 99 cm
# num trecho de 100). O bridge repassa essa distância; os fixos abaixo só
# valem enquanto ela não chegou (os bloqueios de propósito pararam com
# 71/31-38/45-58 cm).
OBSTACLE_AVOID_MARGIN_CM = 3  # leitura oscila uns cm em volta do limite com o robô parado
OBSTACLE_FRONT_TRIGGER_CM = 85
OBSTACLE_BACK_TRIGGER_CM = 60
OBSTACLE_SIDE_TRIGGER_CM = 55
OBSTACLE_MASKED_MAX_CM = 2
OBSTACLE_STOPPED_SECONDS = 3.0
OBSTACLE_DOCKING_STOPPED_SECONDS = 10
OBSTACLE_DOCKING_LATERAL_METERS = 0.5
OBSTACLE_DOCKING_AHEAD_METERS = 0.8  # quanto além do H (saindo do lote) ainda conta -- o robô gira/espera até ~0,5 m dele
OBSTACLE_READING_MAX_AGE_SECONDS = 2.0
OBSTACLE_BRIDGE_HEALTHY_SECONDS = 5  # bridge respondeu há menos que isso = confia nele (desliga o chute por posição)
OBSTACLE_POINTS_CACHE_SECONDS = 600
OBSTACLE_FRONT_MESSAGE = "OBSTÁCULO À FRENTE do robô (%d cm)! Libere o caminho."
OBSTACLE_BACK_MESSAGE = "OBSTÁCULO ATRÁS, no lado dos garfos (%d cm)! Libere o caminho."
OBSTACLE_LEFT_MESSAGE = "OBSTÁCULO NA LATERAL ESQUERDA do robô (%d cm)! Libere o caminho."
OBSTACLE_RIGHT_MESSAGE = "OBSTÁCULO NA LATERAL DIREITA do robô (%d cm)! Libere o caminho."
_obstacle_watch = {"message": None, "routeId": None, "stoppedSince": None, "healthyAt": None, "points": None, "pointsAt": -1e9}
_obstacle_thread = {"t": None}


def robot_obstacle_distances():
    """{'front','back',...} em cm (255 = livre) da leitura mais recente do
    bridge, ou None (bridge fora do ar / leitura velha)."""
    host = urllib.parse.urlparse(ROBOT_HOST).hostname
    try:
        with urllib.request.urlopen("http://%s:%d%s" % (host, TURN_CHECK_PORT, OBSTACLE_PATH), timeout=1.5) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None
    if data.get("age") is None or data["age"] > OBSTACLE_READING_MAX_AGE_SECONDS:
        return None
    _obstacle_watch["healthyAt"] = time.monotonic()
    return data


def _in_docking_zone(pose, state, current):
    """Robô sobre o eixo do docking da coleta (ainda não feita) ou da entrega
    da rota atual, entre o pallet e um pouco além do H."""
    if time.monotonic() - _obstacle_watch["pointsAt"] >= OBSTACLE_POINTS_CACHE_SECONDS or not _obstacle_watch["points"]:
        _obstacle_watch["points"] = robot_point_positions() or {}
        _obstacle_watch["pointsAt"] = time.monotonic()
    points = _obstacle_watch["points"]
    names = [current.get("dropoff")]
    if current.get("pickup") and not state.get("pickupCleared"):
        names.append(current["pickup"])
    for name in filter(None, names):
        pallet, docking = points.get(name), points.get("H" + name)
        if pallet and docking:
            s, lateral, _diff = _docking_axis_geometry(pose, docking, pallet)
            if lateral <= OBSTACLE_DOCKING_LATERAL_METERS and s <= OBSTACLE_DOCKING_AHEAD_METERS:
                return True
    return False


def _set_obstacle_message(message, route_id):
    if message != _obstacle_watch["message"]:
        print("Obstáculo: %s" % (message or "liberado"))
    _obstacle_watch["message"] = message
    _obstacle_watch["routeId"] = route_id if message else None


def _refresh_obstacle():
    with QUEUE_LOCK:
        state = _read_queue_state()
    current = state.get("currentRoute") or {}
    if (not current.get("taskName") or state.get("emergency") or _robot_status_cache.get("charging")
            or _route_planning_elapsed(state) is not None):
        _obstacle_watch["stoppedSince"] = None
        _set_obstacle_message(None, None)
        return
    speed = _slam_call("GET", "/reeman/speed")
    if abs(float(speed.get("vx") or 0)) >= STALL_VX_EPSILON_MPS or abs(float(speed.get("vth") or 0)) >= STALL_VTH_EPSILON_DEG_S:
        _obstacle_watch["stoppedSince"] = None
        _set_obstacle_message(None, None)
        return
    if _obstacle_watch["stoppedSince"] is None:
        _obstacle_watch["stoppedSince"] = time.monotonic()
    stopped_for = time.monotonic() - _obstacle_watch["stoppedSince"]
    if stopped_for < OBSTACLE_STOPPED_SECONDS:
        return
    d = robot_obstacle_distances()
    if d is None:
        _set_obstacle_message(None, None)  # sem leitura: o alerta antigo de 40 s cobre
        return

    def reading(*keys):
        vals = [d.get(k, 255) for k in keys]
        vals = [v for v in vals if v > OBSTACLE_MASKED_MAX_CM]
        return min(vals) if vals else 255

    # Limite de cada lado = a distância de desvio que o PRÓPRIO robô está
    # usando no trecho (bridge, /avoid_distance; 0 = lado desligado). Sem ela
    # (bridge recém-ligado: o tópico só publica quando muda), os fixos.
    avoid = d.get("avoid") or {}

    def limit(side, fixed):
        cm = avoid.get(side)
        return fixed if cm is None else (cm + OBSTACLE_AVOID_MARGIN_CM if cm > 0 else 0)

    carrying = _robot_carrying(state) is not None
    near = []  # (cm, lado, mensagem) abaixo do limite de cada lado
    front = reading("front")
    if front < limit("front", OBSTACLE_FRONT_TRIGGER_CM):
        near.append((front, "front", OBSTACLE_FRONT_MESSAGE))
    back = reading("back")
    if back < limit("back", OBSTACLE_BACK_TRIGGER_CM) and not carrying:
        near.append((back, "back", OBSTACLE_BACK_MESSAGE))
    left, right = reading("left", "f_left"), reading("right", "f_right")
    if left < limit("left", OBSTACLE_SIDE_TRIGGER_CM):
        near.append((left, "left", OBSTACLE_LEFT_MESSAGE))
    if right < limit("right", OBSTACLE_SIDE_TRIGGER_CM):
        near.append((right, "right", OBSTACLE_RIGHT_MESSAGE))
    if not near:
        _set_obstacle_message(None, None)
        return
    cm, side, template = min(near)
    if _in_docking_zone(robot_pose(), state, current):
        # Na faixa de encaixe é normal ter pallet/lote perto de todo lado: só
        # o garfo (trás, sem carga) parado por muito tempo é aviso -- o caso
        # do espaçamento entre pallets.
        if any(s == "back" for _, s, _ in near) and stopped_for >= OBSTACLE_DOCKING_STOPPED_SECONDS:
            _set_obstacle_message(ROBOT_STALLED_AT_ORIGIN_MESSAGE, current.get("id"))
        else:
            _set_obstacle_message(None, None)
        return
    _set_obstacle_message(template % cm, current.get("id"))


def _start_obstacle_thread():
    if _obstacle_thread["t"] is not None and _obstacle_thread["t"].is_alive():
        return

    def _loop():
        while not _queue_stop.wait(OBSTACLE_WATCH_INTERVAL_SECONDS):
            try:
                _refresh_obstacle()
            except Exception:  # robô/rede indisponível agora -- sem aviso, tenta no próximo segundo
                _obstacle_watch["stoppedSince"] = None
                _set_obstacle_message(None, None)

    _obstacle_thread["t"] = threading.Thread(target=_loop, daemon=True)
    _obstacle_thread["t"].start()


# Condição final do alerta (ver "Alerta de robô parado" acima): combina o
# rastreio de velocidade (stationarySince) com o estado da fila. QUALQUER
# rota conta -- reservada esperando giro seguro pra começar (turnBlocked),
# esperando terminar de voltar pra carga sozinho (awaitingCharge), ou já
# disparada de verdade (normal, unloadOnly, ou esperando giro seguro pra
# CANCELAR) -- obstrução por obstáculo pode travar o robô em qualquer uma
# dessas situações, não só numa rota já em andamento (pedido explícito do
# usuário, 2026-10-02 -- a 1ª versão só considerava `taskName` de verdade).
def _robot_stalled_message(state):
    # Esperando o planejador do dispatch no corredor P3–P10 (ver acima): o
    # robô está parado de propósito — sem o alerta genérico de "parado"; só passa
    # do limite vira vermelho (mensagem própria).
    planning = _route_planning_elapsed(state)
    if planning is not None:
        return ROUTE_PLANNING_LATE_MESSAGE if planning >= ROUTE_PLANNING_LATE_SECONDS else None
    # Sensores do robô (ver "Obstáculo pelos sensores do robô"): na hora, com o lado.
    current = state.get("currentRoute") or {}
    if _obstacle_watch["message"] and _obstacle_watch["routeId"] == current.get("id"):
        return _obstacle_watch["message"]
    since = _robot_status_cache.get("stationarySince")
    if since is None or _robot_status_cache.get("charging"):
        return None
    if not state.get("currentRoute"):
        return None
    if time.monotonic() - since < STALL_ALERT_SECONDS:
        return None
    # Bridge respondendo = os sensores já disseram se é o garfo vendo o
    # pallet (acima); o chute por posição só vale com o bridge fora do ar.
    healthy_at = _obstacle_watch["healthyAt"]
    bridge_healthy = healthy_at is not None and time.monotonic() - healthy_at < OBSTACLE_BRIDGE_HEALTHY_SECONDS
    if not bridge_healthy and _robot_status_cache.get("stalledAtOrigin") \
            and _robot_status_cache.get("stalledAtOriginRouteId") == current.get("id"):
        return ROBOT_STALLED_AT_ORIGIN_MESSAGE
    return ROBOT_STALLED_MESSAGE


# O nome do template CODIFICA o "recipe" da rota (ver CONTEXT.md): rotas com
# params de PICKUP diferentes precisam de templates diferentes, senão
# reaproveitar o nome rodaria o pallet com a altura errada. Como a altura
# do azul virou configurável, ela entra no nome também.
#   madeira:        A1toB2
#   azul, baixo:    A1toB2MT<h>        (ex A1toB2MT8)
#   azul, de cima:  A1toB2MT<h>C       (ex A1toB2MT12C)  — "C" de cima, layer 3
def robot_route_task_name(pickup, dropoff, pallet_type, pallet_top=False, heights=None):
    base = pickup + "to" + dropoff
    if pallet_type != "blue":
        return base
    h = heights or {}
    if pallet_top:
        return base + "MT" + _height_tag(_coerce_height(h.get("blueTop"), PALLET_BASE_HEIGHT_DEFAULT)) + "C"
    return base + "MT" + _height_tag(_coerce_height(h.get("blueBase"), PALLET_BASE_HEIGHT_DEFAULT))


def robot_find_task_template_id(name):
    params = urllib.parse.urlencode({"page": 1, "size": 10, "projectId": ROBOT_PROJECT_ID, "name": name, "description": ""})
    data = _robot_call("GET", "/task-template/page?" + params) or {}
    records = data.get("records") or []
    exact = next((r for r in records if r.get("name") == name), None)
    return exact["id"] if exact else None


def robot_create_task_template(name, task_action_list):
    data = _robot_call("POST", "/task-template/create", {
        "name": name,
        "description": "",
        "supportRobotTypes": ROBOT_SUPPORT_TYPES,
        "projectId": ROBOT_PROJECT_ID,
        "id": None,
        "taskActionList": task_action_list,
    })
    if not data or not data.get("id"):
        raise RobotError("resposta sem id de template")
    return data["id"]


def robot_run_task(template_id):
    _robot_call("POST", "/task-template/generic/task-fast/" + str(template_id), {})


# Reaproveita um template já existente com esse nome em vez de criar de novo
# (o dispatch rejeita nome duplicado) — mesmo raciocínio de
# createAndRunRoute em lifty.js. Devolve o taskName (usado depois pra sondar
# o registro de execução mais recente).
def robot_create_and_run_route(pickup, dropoff, pallet_type, pallet_top=False, heights=None):
    name = robot_route_task_name(pickup, dropoff, pallet_type, pallet_top, heights)
    template_id = robot_find_task_template_id(name)
    if not template_id:
        pickup_params = _pallet_pickup_params(pallet_type, pallet_top, heights)
        task_action_list = [
            {
                "targetMap": ROBOT_TARGET_MAP, "targetArea": "", "targetPoint": pickup,
                "height": 0, "action": "PICKUP", "groupId": 1, "serialNumber": 1,
                "params": pickup_params,
            },
            {
                "targetMap": ROBOT_TARGET_MAP, "targetArea": "", "targetPoint": dropoff,
                "height": 0, "action": "UNLOAD", "groupId": 1, "serialNumber": 2, "params": None,
            },
        ]
        template_id = robot_create_task_template(name, task_action_list)
    robot_run_task(template_id)
    return name


def robot_cancel_task_record(task_record_id):
    _robot_call("POST", "/task-record/cancel/" + str(task_record_id))


def robot_cancel_all_tasks():
    _robot_call("POST", "/task-record/all-cancel/" + ROBOT_PROJECT_ID)


def robot_find_active_charge_task_id():
    params = urllib.parse.urlencode({"projectId": ROBOT_PROJECT_ID, "page": 1, "size": 1, "status": "", "name": ""})
    data = _robot_call("GET", "/task-record/page?" + params) or {}
    records = data.get("records") or []
    record = records[0] if records else None
    if record and record.get("taskType") == "AUTO_SYSTEM" and not _is_terminal_status(record.get("status")):
        return record["id"]
    return None


# Variante pra pegar retardatária (ver CONTEXT.md, incidente 2026-09-25,
# "AUTO_SYSTEM na fresta entre checar e disparar"): olha os últimos `size`
# registros, não só o topo — usada DEPOIS de disparar uma rota nova (nesse
# momento o registro MAIS RECENTE já é o nosso, não uma AUTO_SYSTEM que
# tenha nascido bem no instante entre a checagem de _fire_route e o
# disparo de verdade; só escaneando um pouco mais fundo dá pra achar ela).
def robot_find_any_active_charge_task_id(size=3):
    params = urllib.parse.urlencode({"projectId": ROBOT_PROJECT_ID, "page": 1, "size": size, "status": "", "name": ""})
    data = _robot_call("GET", "/task-record/page?" + params) or {}
    for record in data.get("records") or []:
        if record.get("taskType") == "AUTO_SYSTEM" and not _is_terminal_status(record.get("status")):
            return record["id"]
    return None


def robot_fetch_latest_task_record(name):
    params = urllib.parse.urlencode({"projectId": ROBOT_PROJECT_ID, "page": 1, "size": 1, "status": "", "name": name})
    data = _robot_call("GET", "/task-record/page?" + params) or {}
    records = data.get("records") or []
    return records[0] if records else None


def robot_fetch_recent_task_records(size=5):
    params = urllib.parse.urlencode({"projectId": ROBOT_PROJECT_ID, "page": 1, "size": size, "status": "", "name": ""})
    data = _robot_call("GET", "/task-record/page?" + params) or {}
    return data.get("records") or []


# Acha um task-record específico pelo id, dentre os `size` mais recentes —
# não existe um GET por id direto documentado. Usada pra sondar o status da
# tarefa de UNLOAD isolado (ver robot_create_and_run_unload_chain): ela não
# tem um nome NOSSO pra buscar como as rotas normais (robot_fetch_latest_
# task_record busca por `name`) — o dispatch dá um nome aleatório
# ("76f46_2026-09-30 10:40:05", confirmado ao vivo), então guardamos o ID
# devolvido na criação e procuramos por ele aqui.
def robot_fetch_task_record_by_id(task_record_id, size=5):
    for record in robot_fetch_recent_task_records(size=size):
        if record.get("id") == task_record_id:
            return record
    return None


# --- cancelamento pós-pickup: UNLOAD isolado (ver CONTEXT.md, "Cancelamento
# pós-pickup" — pedido do usuário, 2026-09-30) -------------------------------
# Descoberto ao vivo 2026-09-30: o SITE do fabricante recusa criar uma task
# só com UNLOAD (exige pickup+dropoff), mas a API `POST /task-template/
# generic/chain` aceita — não depende de template salvo, e devolve
# `code: 0` pra uma `taskChain` com uma ÚNICA ação. Testado com o garfo
# vazio (aceitou e virou um task-record de verdade, `taskType:
# TEMP_TASK_CHAIN`) — AINDA NÃO validado com pallet de verdade em cima.
#
# `taskChainId` na resposta é o MESMO id do task-record criado (confirmado
# ao vivo: pedimos o chain, devolveu `taskChainId: 67688`, e `GET
# /task-record/page` logo depois mostrou um registro `id: 67688` novo) — por
# isso não precisamos de um nome nosso pra sondar depois, só o id.
def robot_create_and_run_unload_chain(dropoff):
    data = _robot_call("POST", "/task-template/generic/chain", {
        "projectId": int(ROBOT_PROJECT_ID),
        "agvId": None,
        "agvTypes": ROBOT_SUPPORT_TYPES,
        "taskChain": [
            {
                "targetMap": ROBOT_TARGET_MAP,
                "targetPoint": dropoff,
                "targetArea": "",
                "action": "UNLOAD",
                "params": {},
            },
        ],
    })
    task_record_id = data.get("taskChainId") if data else None
    if not task_record_id:
        raise RobotError("resposta sem taskChainId")
    return task_record_id


def robot_fetch_action_records(task_record_id):
    return _robot_call("GET", "/action-record/list/" + str(task_record_id)) or []


# Checagem de segurança ADICIONAL à flag `pickupCleared` (ver CONTEXT.md,
# incidente de campo 2026-09-30) — não confia só nela na hora de decidir um
# CANCELAMENTO. `pickupCleared` é setada pela sondagem periódica de Caso 2
# (uma vez por tick, ~4s ou mais rápido durante cancelPending) — se o
# PICKUP terminar de verdade e o cancelamento (nosso ou externo) acontecer
# DENTRO do mesmo intervalo de sondagem, a ação de PICKUP nunca chega a ser
# vista com `status: FINISHED`: no próximo poll, a task inteira já está
# `CANCELLED`, e essa mesma ação de PICKUP também aparece `CANCELLED` — o
# `finishTime` dela vira só o carimbo do cancelamento, não prova nada (ver
# comentário de Caso 2 em _queue_tick). Ou seja: um pickup que REALMENTE
# aconteceu pode nunca deixar rastro de "FINISHED" se o cancelamento for
# rápido o suficiente — exatamente o caso confirmado ao vivo (task 67689,
# PICKUP rodou 85s, mais que o dobro do tempo típico de ~64s de um pickup
# de verdade, UNLOAD chegou a "iniciar" 5s antes do cancelamento — fortes
# indícios de que o pallet já tinha sido pego).
#
# Por isso: ANTES de mandar qualquer comando de cancelamento nosso (que
# contaminaria o status retroativamente), confere o estado VERDADEIRO
# agora, direto na API — nesse instante, se o pickup já tiver terminado de
# verdade, a ação ainda mostra `status: FINISHED` genuíno, porque a gente
# ainda não mandou cancelar nada. Só usada quando `pickupCleared` ainda é
# False (se já é True, não precisa checar de novo — nunca REGRIDE).
def _pickup_actually_completed(current):
    try:
        record = robot_fetch_latest_task_record(current["taskName"])
        if not record:
            return None
        actions = robot_fetch_action_records(record["id"])
        pickup_action = next((a for a in actions if a.get("serialNumber") == 1), None)
        if not pickup_action:
            return None
        return bool(pickup_action.get("finishTime")) and pickup_action.get("status") != "CANCELLED"
    except Exception:
        return None


def _resolve_pickup_cleared_for_cancel(current, pickup_cleared):
    """`pickup_cleared`: valor já salvo (da sondagem periódica). Se ainda
    for False, faz a checagem fresca acima antes de decidir qualquer coisa
    sobre o cancelamento (qual lado alinhar, se vai virar UNLOAD isolado
    depois) — ver _pickup_actually_completed."""
    if pickup_cleared:
        return True
    fresh = _pickup_actually_completed(current)
    if fresh:
        print("Pickup em %s já tinha terminado de verdade (checagem fresca antes de cancelar) -- tratando como pós-pickup." % current["pickup"])
        return True
    return pickup_cleared


# Estados TERMINAIS de um task-record no robô. Confirmados em campo:
# FINISHED, CANCELLED, FAILED. Os outros são chutes defensivos por nomes
# comuns — o objetivo é só "não tentar cancelar / não ficar preso no que já
# morreu". Comparação case-insensitive. Qualquer status FORA dessa lista é
# tratado como "ainda rodando" (mesmo critério do polling).
#
# Motivo: uma task FAILED não é FINISHED nem CANCELLED, então o código
# antigo (1) nunca limpava ela da fila pelo polling e (2) tentava
# cancelá-la ao clicar no X — e o robô responde HTTP 400 pra "cancelar o
# que já falhou", deixando a rota presa no painel (bug real, 2026-09-09).
ROBOT_TERMINAL_STATUSES = {
    "FINISHED", "CANCELLED", "FAILED", "ERROR", "ABORTED",
    "STOPPED", "EXCEPTION", "TIMEOUT", "TERMINATED",
}


def _is_terminal_status(status):
    return (status or "").strip().upper() in ROBOT_TERMINAL_STATUSES


def _robot_try_cancel(task_name):
    """Cancela a task 'task_name' no robô, tolerante a ela já ter morrido.
    Volta normalmente se cancelou, se o robô recusou com 4xx (task já
    terminal), ou se nem existe mais. LEVANTA só num erro de verdade — robô
    fora do ar, 5xx.

    SEMPRE tenta o `task-record/cancel/{id}` se a task ainda existe, MESMO
    em estado FAILED/terminal — antes (fix de 2026-09-09) a gente pulava a
    chamada pra task terminal, mas o `cancel` do dispatch pode ter efeito
    colateral na camada de navegação (parar o robô), e pular isso deixou o
    robô seguindo pra task residual (bug 2026-09-11)."""
    try:
        record = robot_fetch_latest_task_record(task_name)
    except Exception:
        raise
    if not record or not record.get("id"):
        return  # nem existe — nada a cancelar
    try:
        robot_cancel_task_record(record["id"])
    except urllib.error.HTTPError as err:
        if 400 <= err.code < 500:
            # o robô diz que não dá pra cancelar essa task (já terminal).
            # Não é erro do nosso lado — segue e limpa local.
            print("Robô recusou cancelar '%s' (HTTP %d) — já terminal; seguindo." % (task_name, err.code))
            return
        raise  # 5xx — problema de verdade


# --- estado persistido da fila (queue_state.json) --------------------------
def _empty_queue_state():
    # Função (não constante compartilhada!) de propósito — um dict
    # constante no módulo teria a lista routeQueue=[] COMPARTILHADA entre
    # todo mundo que pedisse "o estado vazio", e um .append() em qualquer
    # chamador corromperia esse "vazio" pra sempre (mutable default clássico).
    return {"currentRoute": None, "pendingRoute": None, "routeQueue": [], "pickupCleared": False, "emergency": False, "cancelPending": False, "turnBlocked": False, "awaitingCharge": False, "currentRouteFresh": False, "pendingPostPickupUnload": None}


def _read_queue_state():
    if not QUEUE_STATE_FILE.exists():
        return _empty_queue_state()
    try:
        data = json.loads(QUEUE_STATE_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):  # ValueError cobre JSONDecodeError e UnicodeDecodeError
        return _empty_queue_state()
    merged = _empty_queue_state()
    merged.update(data)
    return merged


def _write_queue_state(state):
    QUEUE_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# --- calibração (leitura estruturada — só pro que este bloco precisa: lotes
# da vista "top" pra validar fronteira, e o array occupied) ----------------
def _read_calibration():
    if not CALIBRATION_FILE.exists():
        return json.loads(EMPTY_CALIBRATION)
    try:
        data = json.loads(CALIBRATION_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):  # ValueError cobre JSONDecodeError e UnicodeDecodeError
        return json.loads(EMPTY_CALIBRATION)
    # _save_calibration (mais abaixo) já exige essa forma pra aceitar um
    # save — um arquivo sem "top"/"iso" só existiria se nunca tivesse sido
    # resalvo desde antes da vista isométrica existir (ver CONTEXT.md,
    # "migrado automaticamente no load" — migração é client-side). Tratar
    # como vazio aqui é seguro: o próximo save de qualquer cliente já
    # resalva no formato novo.
    if not isinstance(data, dict) or "top" not in data or "iso" not in data:
        return json.loads(EMPTY_CALIBRATION)
    return data


def _write_calibration(data):
    CALIBRATION_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# --- Kanbans (grupos de lotes delimitados por um Close Up) — restrição de
# usuário por kanban (pedido do usuário, 2026-10-01) -------------------------
# Mesma matemática de "qual Close Up contém esta posição" que o
# FloorPlanCanvas.jsx usa pro zoom/destaque (closeUpContaining/
# contentPositionOf) — portada pra Python porque a RESTRIÇÃO precisa ser
# aplicada no servidor (quem decide de verdade), não só escondida na UI. Os
# números abaixo (dimensão da imagem, tamanho padrão de célula) são os
# mesmos valores fixos do floorplan.jpg e de FloorPlanCanvas.jsx
# (DEFAULT_CELL_SIZE) — não há uma fonte única compartilhada entre
# front/back pra esses dois números, então se o floorplan.jpg for trocado
# por uma imagem de outro tamanho, ou DEFAULT_CELL_SIZE mudar lá, isto
# precisa acompanhar.
FLOORPLAN_IMAGE_WIDTH = 1411
FLOORPLAN_IMAGE_HEIGHT = 759
DEFAULT_LOT_CELL_SIZE = 11.97

# Kanbans "livres pra todos" (pedido do usuário): saídas compartilhadas,
# nunca aparecem na lista de kanbans pra restringir um usuário, e qualquer
# usuário restrito pode pegar pallet ali mesmo sem ter esse kanban
# atribuído. Fixo pelo ID (não pelo NOME — nome pode ser renomeado, pedido
# explícito do usuário) dos Close Ups "SAÍDAS 69/71" e "SAÍDAS
# 47,40,61,52,35" na vista 'top' de hoje.
FREE_KANBAN_IDS = {
    "ff61748b-be50-4d7e-9f19-315f63c382d0",  # SAÍDAS 69/71
    "32027cb0-6cf4-491c-b78b-1bd6537afd8a",  # SAÍDAS 47,40,61,52,35
}


def _lot_cell_name(prefix, index):
    return prefix if index == 0 else prefix + str(index + 1)


def _lot_cell_position(lot, index):
    cell_size = lot.get("cellSize") or DEFAULT_LOT_CELL_SIZE
    lx = index * cell_size * (lot.get("scaleX") or 1)
    rad = math.radians(lot.get("rotation") or 0)
    return (
        lot["x"] * FLOORPLAN_IMAGE_WIDTH + lx * math.cos(rad),
        lot["y"] * FLOORPLAN_IMAGE_HEIGHT + lx * math.sin(rad),
    )


def _point_position(point):
    return (point["x"] * FLOORPLAN_IMAGE_WIDTH, point["y"] * FLOORPLAN_IMAGE_HEIGHT)


def _closeup_bounds(closeup):
    x = closeup["x"] * FLOORPLAN_IMAGE_WIDTH
    y = closeup["y"] * FLOORPLAN_IMAGE_HEIGHT
    w = closeup["width"] * (closeup.get("scaleX") or 1)
    h = closeup["height"] * (closeup.get("scaleY") or 1)
    return (min(x, x + w), max(x, x + w), min(y, y + h), max(y, y + h))


# Posição de um nome técnico (célula de lote OU ponto avulso) na vista
# 'top' — mesmo espírito de contentPositionOf (FloorPlanCanvas.jsx).
def _top_position_for_name(name, cal):
    for lot in cal["top"]["lots"]:
        for i in range(lot.get("count", 0)):
            if _lot_cell_name(lot["prefix"], i) == name:
                return _lot_cell_position(lot, i)
    for point in cal["top"]["points"]:
        if point.get("name") == name:
            return _point_position(point)
    return None


# Id do Close Up (o menor, se houver sobreposição) que contém esse nome
# técnico — mesmo espírito de closeUpContaining (FloorPlanCanvas.jsx). None
# se a posição não existe ou não está dentro de nenhum Close Up.
def _closeup_id_for_name(name, cal):
    pos = _top_position_for_name(name, cal)
    if pos is None:
        return None
    best_id, best_area = None, None
    for c in cal["top"]["closeUps"]:
        x0, x1, y0, y1 = _closeup_bounds(c)
        if x0 <= pos[0] <= x1 and y0 <= pos[1] <= y1:
            area = abs((x1 - x0) * (y1 - y0))
            if best_area is None or area < best_area:
                best_id, best_area = c["id"], area
    return best_id


def _user_kanban_ids(user):
    return user.get("kanbanIds") or []


# Pode PEGAR (origem) nesse ponto? Admin/Mestre sempre podem (ver pedido do
# usuário: Mestre usa qualquer kanban sem restrição). Usuário comum sem
# kanban nenhum atribuído (conta antiga, de antes desta feature) também não
# tem restrição — só passa a valer quando o admin atribui pelo menos um
# kanban. Destino nunca é restrito (só a ORIGEM importa, ver CONTEXT.md).
def _user_can_pick_up_from(user, pickup_name, cal):
    if user.get("isAdmin") or user.get("isMaster"):
        return True
    kanban_ids = _user_kanban_ids(user)
    if not kanban_ids:
        return True
    closeup_id = _closeup_id_for_name(pickup_name, cal)
    return closeup_id in FREE_KANBAN_IDS or closeup_id in kanban_ids


def _seed_file():
    """calibration.json "de fábrica" embutida no pacote — o mapa que já foi
    calibrado (lotes/pontos: mesmo nome, cor, posição). Usada só pra
    pré-popular um install NOVO (ver _seed_calibration_if_missing)."""
    for c in (_bundle_dir() / "calibration.seed.json",              # .exe congelado
              _bundle_dir() / "packaging" / "calibration.seed.json"):  # dev, rodando da raiz
        if c.exists():
            return c
    return None


def _seed_calibration_if_missing():
    """Num install novo (não existe calibration.json ao lado do .exe), copia
    a versão de fábrica embutida. Install que JÁ tem calibração nunca é
    tocado — então trocar o .exe por um novo não mexe no mapa de quem já
    calibrou, e edições continuam persistindo local. Pra atualizar o mapa
    de fábrica: copiar calibration.json -> packaging/calibration.seed.json
    e rebuildar."""
    if CALIBRATION_FILE.exists():
        return
    seed = _seed_file()
    if seed is None:
        return
    try:
        CALIBRATION_FILE.write_bytes(seed.read_bytes())
        print(f"Mapa pré-carregado do exemplo de fábrica -> {CALIBRATION_FILE}")
    except OSError as err:
        print(f"Aviso: não deu pra pré-carregar o mapa de fábrica: {err}")


# --- Caso 2 (marcação automática de ocupação) — mutação cirúrgica ----------
# Substituem o caminho antigo (snapshot completo de calibration.json vindo
# do cliente) especificamente pra ocupação — full-snapshot sem lock era uma
# corrida real (dois dispositivos marcando quase ao mesmo tempo perdiam a
# mudança um do outro). Pontos/lotes (modo desenvolvedor, raro, um editor
# por vez na prática) continuam pelo POST /api/calibration de sempre.
def set_occupied_state(name, is_occupied):
    with CALIBRATION_LOCK:
        data = _read_calibration()
        occupied = data.get("occupied") or []
        has = name in occupied
        if is_occupied == has:
            return
        data["occupied"] = (occupied + [name]) if is_occupied else [n for n in occupied if n != name]
        _write_calibration(data)


def set_occupied_many(names, is_occupied):
    with CALIBRATION_LOCK:
        data = _read_calibration()
        occupied_set = set(data.get("occupied") or [])
        changed = False
        for name in names:
            if is_occupied == (name in occupied_set):
                continue
            if is_occupied:
                occupied_set.add(name)
            else:
                occupied_set.discard(name)
            changed = True
        if changed:
            data["occupied"] = sorted(occupied_set)
            _write_calibration(data)


# --- Caso 3 (regra de fronteira/FIFO dentro de um lote) — porta de
# isPickupAllowed/isDropoffAllowed em MainApp.jsx, agora também como
# GATE FINAL no servidor (não só no cliente, que só dá feedback rápido):
# dois operadores escolhendo, quase ao mesmo tempo, combinações que
# isoladamente pareciam válidas no momento do clique podiam juntas violar a
# regra. Usa sempre a vista "top" como autoridade — a ordem das células
# dentro do lote é a mesma ideia física nas duas vistas, só a posição
# visual/ângulo muda entre elas, então não há ambiguidade real em escolher
# uma só (evita depender do cliente informar qual vista estava ativa).
def lot_cell_name(prefix, index):
    return prefix if index == 0 else prefix + str(index + 1)


def _find_lot_cell_position(lots, name):
    for lot in lots:
        for i in range(lot.get("count", 0)):
            if lot_cell_name(lot["prefix"], i) == name:
                return lot, i
    return None, None


def is_pickup_allowed(lots, occupied, name):
    lot, index = _find_lot_cell_position(lots, name)
    # Ponto avulso ("lote curinga" de uma célula só): não tem vizinho pra
    # bloquear o caminho, então a regra de fronteira não se aplica — mas a
    # básica sim: só dá pra pegar onde tem pallet marcado. Antes isso
    # devolvia True direto, permitindo mandar o robô pegar num ponto VAZIO.
    if lot is None:
        return name in occupied
    if name not in occupied:
        return False  # precisa ter pallet ali pra pegar
    for i in range(index):
        if lot_cell_name(lot["prefix"], i) in occupied:
            return False  # bloqueado antes de chegar
    return True


def is_dropoff_allowed(lots, occupied, name):
    lot, index = _find_lot_cell_position(lots, name)
    # Ponto avulso: sem ordem pra respeitar, mas continua valendo que não dá
    # pra empilhar — soltar onde já tem pallet era permitido antes.
    if lot is None:
        return name not in occupied
    for i in range(index + 1):
        if lot_cell_name(lot["prefix"], i) in occupied:
            return False  # ela mesma ou alguma antes está ocupada
    return True


# Valida uma SEQUÊNCIA de pares origem→destino de uma vez (modo "Lotes em
# sequência", ver CONTEXT.md) simulando a ocupação passo a passo: cada rota
# é conferida contra o armazém como ele ESTARÁ quando ela for executada, não
# como está agora.
#
# Sem isso, mandar `A→X, A2→Y, A3→Z` seria rejeitado a partir da segunda
# rota: no instante do envio o A ainda está ocupado (o robô nem começou),
# então A2 parece bloqueado. A ordem dentro do par importa e é respeitada
# aqui: primeiro o PICKUP acontece (libera a origem), só depois o UNLOAD
# (ocupa o destino).
#
# Um par só (modo normal) passa por aqui também — a simulação de um passo
# só é idêntica à validação antiga, então não existe caminho separado.
def validate_route_chain(lots, occupied, pairs):
    projected = set(occupied)
    for i, pair in enumerate(pairs):
        pickup = pair["pickup"]
        dropoff = pair["dropoff"]
        if not is_pickup_allowed(lots, projected, pickup):
            # Ponto avulso não tem lote/ordem — falar em "posição antes dela
            # no lote" ali só confundiria; a razão real é estar vazio.
            if _find_lot_cell_position(lots, pickup)[0] is None:
                return "Não dá pra pegar em %s (rota %d): não tem pallet marcado ali." % (pickup, i + 1)
            return "Não dá pra pegar em %s (rota %d): precisa ter pallet ali e nada ocupado antes dela no lote." % (pickup, i + 1)
        projected.discard(pickup)
        if not is_dropoff_allowed(lots, projected, dropoff):
            if _find_lot_cell_position(lots, dropoff)[0] is None:
                return "Não dá pra soltar em %s (rota %d): já tem pallet ali." % (dropoff, i + 1)
            return "Não dá pra soltar em %s (rota %d): ela ou alguma posição antes dela no lote está ocupada." % (dropoff, i + 1)
        projected.add(dropoff)
    return None  # cadeia inteira válida


# Concorrência (pedido do supervisor, 2026-09-18): duas pessoas enviando a
# MESMA task quase ao mesmo tempo, ou uma task cujo pickup/dropoff já está
# em uso por uma rota em andamento/pendente/na fila. `validate_route_chain`
# acima NÃO pega esse caso — só enxerga `occupied` (a calibração), nunca a
# fila — e `occupied[pickup]` continua True até o PICKUP terminar de
# verdade (Caso 2, ver _queue_tick): enquanto o robô ainda está a caminho,
# o pallet fisicamente segue lá, então uma segunda rota pro MESMO pickup
# (ou pro mesmo dropoff de uma rota já na fila) passa pela validação de
# ocupação sem problema nenhum. Aqui a checagem é contra a FILA de verdade,
# não a calibração.
def _active_routes(state):
    routes = []
    if state.get("currentRoute"):
        routes.append(state["currentRoute"])
    if state.get("pendingRoute"):
        routes.append(state["pendingRoute"])
    routes.extend(state.get("routeQueue") or [])
    return routes


# Devolve (nome_em_conflito, rota_conflitante) se `pickup` ou `dropoff` já
# for o pickup OU o dropoff de alguma rota ativa — em qualquer um dos 4
# jeitos de colidir (mesmo pickup, mesmo dropoff, pickup novo = dropoff de
# outra rota, dropoff novo = pickup de outra rota), a posição física já tem
# um robô comprometido com ela, então uma segunda rota pra ela não pode ser
# aceita. `None, None` se não colidir com nada.
def _find_route_conflict(pickup, dropoff, active_routes):
    for route in active_routes:
        for name in (pickup, dropoff):
            if name == route["pickup"] or name == route["dropoff"]:
                return name, route
    return None, None


# Tira do estado local as rotas que sobraram de um grupo cuja cadeia se
# quebrou (uma rota do meio cancelada/falhou) — as seguintes só eram
# fisicamente válidas PORQUE essa ia rodar antes, então deixá-las na fila
# faria o robô tentar pegar uma posição que continua bloqueada.
#
# pendingRoute e routeQueue nunca foram disparadas pro robô de verdade (ver
# "check-turn no início de tarefas" acima — só a currentRoute dispara, e só
# depois do check-turn liberar), então tirar do estado local já basta pras
# duas, sem chamada nenhuma ao robô.
def _drop_group_from_queue(state, group_id):
    if not group_id:
        return
    pending = state.get("pendingRoute")
    if pending and pending.get("groupId") == group_id:
        log_route_completed(pending["id"], "cancelled")
        state["pendingRoute"] = None
    # O resto do grupo que ainda estava só na fila LOCAL some sem mais nada:
    # essas nunca chegaram a ser disparadas pro robô, e o histórico só
    # registra rota a partir do disparo (ver log_route_requested, chamado de
    # dentro de _fire_route) — então não há entrada pra marcar como
    # cancelada, do mesmo jeito que já acontece ao remover uma da fila pelo X.
    state["routeQueue"] = [r for r in (state.get("routeQueue") or []) if r.get("groupId") != group_id]


# Dependência entre tarefas do MESMO envio (pedido do usuário, 2026-10-27):
# com "Tarefas aguardando envio" dá pra montar avulsas que só são válidas
# porque uma anterior do mesmo lote libera o caminho (ex: NA → x e depois
# NA2 → y — sem tirar o NA, o NA2 continua obstruído; não existe NA1, a
# 2ª célula do lote já é NA2, ver lot_cell_name). Antes, cancelar a
# primeira deixava a segunda na fila, e o robô tentaria pegar numa posição
# bloqueada. Mesmo tratamento do grupo de "Lotes em sequência", mas só pra
# quem DEPENDE de verdade — tarefa que não depende continua independente.
#
# Contrafactual, com a MESMA regra do validate_route_chain: pra cada tarefa
# i, refaz a cadeia como se i não rodasse; toda tarefa j > i que deixa de
# ser válida depende de i (e também não roda, então não mexe na projeção —
# quem dependia de j fica dependendo de i também, transitivo). Pega
# obstrução no lote, pegar num ponto onde uma anterior ia soltar, soltar
# num ponto que uma anterior ia esvaziar — sem caso especial pra nenhum.
# Devolve, pra cada par, os índices dos pares de que ele depende.
def _batch_dependencies(lots, occupied, pairs):
    deps = [set() for _ in pairs]
    for i in range(len(pairs)):
        projected = set(occupied)
        for j, pair in enumerate(pairs):
            if j == i:
                continue
            after_pickup = projected - {pair["pickup"]}
            if j > i and not (is_pickup_allowed(lots, projected, pair["pickup"])
                              and is_dropoff_allowed(lots, after_pickup, pair["dropoff"])):
                deps[j].add(i)
                continue
            projected = after_pickup | {pair["dropoff"]}
    return deps


# Tira da fila tudo que caiu junto com `route` (cancelada, falhou ou
# removida): o resto do grupo dela (_drop_group_from_queue) e as tarefas
# do mesmo envio que dependiam dela (`dependsOn`, ver _batch_dependencies)
# — em cascata, porque uma rota derrubada por grupo também pode ter
# dependentes fora do grupo. Mesmo tratamento de log do grupo: pendingRoute
# vira "cancelled" no histórico, fila local só some.
def _drop_dependents_from_queue(state, route):
    if not route:
        return
    before = [r for r in [state.get("pendingRoute")] + list(state.get("routeQueue") or []) if r]
    _drop_group_from_queue(state, route.get("groupId"))
    remaining_ids = {r["id"] for r in [state.get("pendingRoute")] + list(state.get("routeQueue") or []) if r}
    dropped = {route["id"]} | {r["id"] for r in before if r["id"] not in remaining_ids}
    while True:
        pending = state.get("pendingRoute")
        if pending and dropped.intersection(pending.get("dependsOn") or []):
            log_route_completed(pending["id"], "cancelled")
            state["pendingRoute"] = None
            dropped.add(pending["id"])
            continue
        queue = state.get("routeQueue") or []
        hit = [r for r in queue if dropped.intersection(r.get("dependsOn") or [])]
        if not hit:
            return
        dropped.update(r["id"] for r in hit)
        state["routeQueue"] = [r for r in queue if r not in hit]


# Agrupa rotas CONSECUTIVAS do mesmo groupId em "unidades" — mesmo
# espírito de groupWaitingRoutes em QueuePanel.jsx (porta Python, usado
# por _queue_reorder). Rotas de um grupo sempre ficam adjacentes (nascem
# juntas no envio, nunca se intercalam com rota independente no meio).
def _group_queue_units(route_queue):
    units = []
    for route in route_queue:
        group_id = route.get("groupId")
        if group_id and units and units[-1]["groupId"] == group_id:
            units[-1]["routes"].append(route)
        else:
            units.append({"groupId": group_id, "routes": [route]})
    return units


# --- disparo/avanço da fila (chamado com QUEUE_LOCK já adquirido) ---------
# Dispara de verdade no robô e devolve a rota "disparada" (com taskName
# preenchido). NÃO atualiza state[...] sozinho, quem chama decide onde ela
# fica. route["user"] (capturado no momento do ENFILEIRAMENTO, não relido
# depois) é quem aparece no histórico como requisitante, mesmo que o disparo
# de verdade só aconteça bem depois (ver "check-turn no início de tarefas"
# acima) — mais correto do que a versão antiga (cliente), onde o log ficava
# por conta de qual ABA estava rodando a sondagem no momento, meio ao acaso.
#
# SÓ chama isto quem já checou (fora do QUEUE_LOCK, ver _try_dispatch_current)
# que é seguro girar agora — esta função em si não pergunta nada pro bridge,
# só dispara. Único lugar que fala com o robô pra CRIAR uma rota nova; tanto
# a currentRoute nova quanto a promovida de pendingRoute/routeQueue passam
# por aqui exatamente uma vez, no momento em que de fato começam a rodar.
def _fire_route(route):
    task_name = _create_task_cancelling_charge(
        lambda: robot_create_and_run_route(
            route["pickup"], route["dropoff"], route.get("palletType", "wood"),
            route.get("palletTop", False), route.get("palletHeights"),
        ),
        "rota %s->%s" % (route["pickup"], route["dropoff"]),
    )
    fired = dict(route)
    fired["taskName"] = task_name
    log_route_requested(route["id"], route["pickup"], route["dropoff"], task_name, route["user"])
    return fired


# Cria uma task no robô (`create`, devolve o que ela devolver) sem deixar a
# AUTO_SYSTEM de volta pra carga passar na frente. Usada pelas rotas normais
# (_fire_route) E pelo UNLOAD isolado do cancelamento pós-pickup (bug de
# campo 2026-10-27: a devolução não passava por aqui e o robô começou a ir
# pra energia antes de receber o UNLOAD).
def _create_task_cancelling_charge(create, label):
    # Descobre a task de carga ativa ANTES de disparar (se checasse depois,
    # o registro mais recente já seria o nosso, não o dela), dispara a rota
    # nova (fica pendente atrás da carga, fila nunca some a zero), e só então
    # cancela a carga — nunca all-cancel aqui.
    try:
        charge_task_id = robot_find_active_charge_task_id()
    except Exception:
        charge_task_id = None
    result = create()
    if charge_task_id:
        try:
            robot_cancel_task_record(charge_task_id)
        except Exception:
            pass  # melhor esforço — a rota nova já foi disparada de qualquer jeito

    # Retardatária (ver CONTEXT.md, incidente 2026-09-25): a checagem acima
    # roda ANTES de criar a rota nova, então uma AUTO_SYSTEM que nasça bem
    # na fresta entre essa checagem e o robô de fato começar a mover pra
    # rota nova passa batido — visto ao vivo (task 67547/67548): as duas
    # foram criadas no MESMO SEGUNDO, mas a rota nova só começou a se mover
    # depois da AUTO_SYSTEM terminar sozinha (quase 90s de desvio). Segunda
    # passada, agora DEPOIS de disparar, escaneando os últimos registros
    # (não só o topo — o topo já é a nossa rota recém-criada) — melhor
    # esforço, não desfaz nem re-tenta o disparo que já aconteceu.
    try:
        straggler_id = robot_find_any_active_charge_task_id()
        if straggler_id and straggler_id != charge_task_id:
            print("Retardatária pega na 2ª checagem (id=%s, %s) -- cancelando." % (straggler_id, label))
            robot_cancel_task_record(straggler_id)
    except Exception as err:
        print("Aviso: 2ª checagem de AUTO_SYSTEM retardatária falhou (%s) -- melhor esforço, segue sem cancelar." % err)

    _route_fired_at["t"] = time.monotonic()
    return result


# AUTO_SYSTEM "sequestrando" a rota da fila (ver CONTEXT.md, incidente
# 2026-09-29 (2)): a dispatch leva alguns segundos pra ATRIBUIR a nossa rota
# ao robô depois de criada, e nesse meio-tempo acha o robô ocioso, cria a
# AUTO_SYSTEM de volta pra carga e atribui ELA primeiro — visto ao vivo: a
# nossa rota foi criada 08:40:00, a AUTO_SYSTEM 08:40:01, e o robô foi até a
# energia (4 min) antes de começar a nossa. As checagens de _fire_route
# rodam cedo demais pra isso. Então, a cada tick, enquanto houver uma rota
# NOSSA disparada e não terminada, qualquer AUTO_SYSTEM ativa é cancelada.
# Isso é diferente da supressão removida em 2026-09-24 (que brigava com a
# AUTO_SYSTEM com a fila VAZIA e fazia o robô oscilar): aqui só age quando
# existe trabalho de verdade esperando pra rodar no lugar dela.
def _cancel_charge_task_hijacking_route(task_name):
    try:
        charge_id = robot_find_any_active_charge_task_id()
    except Exception:
        return  # falha pontual de rede — tenta de novo no próximo tick
    if not charge_id:
        return
    print("AUTO_SYSTEM #%s ativa enquanto a rota %s espera/roda — cancelando (trabalho real tem prioridade)." % (charge_id, task_name))
    try:
        robot_cancel_task_record(charge_id)
    except Exception as err:
        print("Aviso: falha ao cancelar a AUTO_SYSTEM #%s: %s" % (charge_id, err))


# Janela logo depois de disparar uma rota em que o tick roda mais rápido —
# é quando a AUTO_SYSTEM costuma aparecer (+1s no incidente) e ela leva
# alguns segundos pra começar a andar (+5s): pegar ela ANTES de sair
# andando evita até o robô esboçar o movimento pra energia.
ROUTE_FIRED_WATCH_SECONDS = 20
ROUTE_FIRED_WATCH_INTERVAL_SECONDS = 1.5
_route_fired_at = {"t": None}  # só memória: reiniciar zera, não há o que guardar


# Promove pendingRoute/routeQueue pra currentRoute — chamado com QUEUE_LOCK
# já adquirido, depois que a rota atual terminou de verdade (FINISHED) ou foi
# cancelada. PURA reorganização local, nenhuma chamada ao robô: a nova
# currentRoute fica "reservada" (sem taskName) até _try_dispatch_current
# liberar o disparo de verdade (check-turn), exatamente como pendingRoute e
# routeQueue sempre estiveram — ver "check-turn no início de tarefas" acima.
# Quem chama é responsável por tentar _try_dispatch_current() logo depois,
# fora do QUEUE_LOCK.
#
# `currentRouteFresh = False` aqui de propósito (ver AWAITING_CHARGE_MESSAGE
# e "Trava: não iniciar task durante retorno pra energia" no CONTEXT.md):
# uma rota promovida já estava na fila ANTES da anterior terminar — ela
# nunca precisa esperar retorno pra energia nenhum, porque enquanto a rota
# anterior rodava não havia janela nenhuma pra uma AUTO_SYSTEM nativa
# aparecer (só nasce quando não há task nossa ativa). Qualquer AUTO_SYSTEM
# vista bem aqui é sempre um blip novinho deste exato instante — já
# resolvido por `_fire_route` (acha e cancela ela antes/depois de disparar
# a rota promovida), sem precisar de trava nenhuma.
def _advance_queue_locked(state):
    pending = state.get("pendingRoute")
    if pending:
        state["currentRoute"] = pending
        state["currentRouteFresh"] = False
        state["pendingRoute"] = None
        state["pickupCleared"] = False
        queue = state.get("routeQueue") or []
        if queue:
            state["pendingRoute"] = queue[0]
            state["routeQueue"] = queue[1:]
        return

    queue = state.get("routeQueue") or []
    if not queue:
        state["currentRoute"] = None
        state["currentRouteFresh"] = False
        return
    state["currentRoute"] = queue[0]
    state["currentRouteFresh"] = False
    state["pickupCleared"] = False
    state["routeQueue"] = queue[1:]


# BUG DE CAMPO 2026-09-25, DUAS RODADAS (corrigido):
#
# 1ª versão: considerava QUALQUER AUTO_SYSTEM ativa como "retorno de
# verdade" — mas cancelar/terminar uma rota com OUTRA já esperando na fila
# TAMBÉM dispara uma AUTO_SYSTEM nativa (a dispatch service vê "sem task"
# por uma fração de segundo, entre uma rota terminar e a próxima ser
# disparada). Confirmado com o log real: `CD6toCD5MT6` cancelada 09:32:38,
# AUTO_SYSTEM aparece NO MESMO SEGUNDO, fica ativa por quase 90s até
# conectar — a rota seguinte da fila ficou presa em `awaitingCharge` esse
# tempo todo, mesmo já tendo trabalho de verdade pra fazer.
#
# 2ª tentativa (margem de tempo — TAMBÉM abandonada): esperar a mesma
# AUTO_SYSTEM continuar aparecendo por alguns segundos antes de contar como
# "de verdade". Não resolve o caso real que o usuário testou: robô termina
# a única rota (fila fica REALMENTE vazia), operador manda uma rota nova
# rápido (dentro da margem, cenário normal com vários tablets simultâneos)
# — a AUTO_SYSTEM genuína também é nova nesse instante, e uma margem de
# tempo não consegue diferenciar isso de um blip de transição de fila.
#
# Solução de verdade (ideia do usuário): a diferença não está em QUANTO
# TEMPO a AUTO_SYSTEM está ativa, está em DE ONDE a rota reservada veio.
# Uma rota PROMOVIDA (já estava em pendingRoute/routeQueue antes da
# anterior terminar — ver `_advance_queue_locked`, `currentRouteFresh =
# False`) nunca pode enfrentar uma AUTO_SYSTEM genuína, porque enquanto a
# rota anterior rodava não existia a janela "sem task" pra ela nascer — só
# pode ser um blip novo deste exato instante, e `_fire_route` já sabe
# limpar isso sozinho. Só uma rota FRESCA (fila estava REALMENTE vazia
# antes dela chegar — `_queue_enqueue_batch`, `currentRouteFresh = True`)
# pode enfrentar uma AUTO_SYSTEM que já vinha rodando há qualquer tempo.
# `_try_dispatch_current` só chama esta função quando `currentRouteFresh`
# é `True` — nesse caso, QUALQUER AUTO_SYSTEM ativa já é motivo suficiente
# pra esperar, sem precisar medir nada.
def _robot_returning_to_charge_now():
    if _robot_status_cache.get("charging"):
        return False  # já chegou e está carregando -- não é mais "voltando"
    try:
        return bool(robot_find_active_charge_task_id())
    except Exception:
        return False


# "Limit breaker" (modo desenvolvedor, ver CONTEXT.md): enquanto ativo,
# NENHUMA trava de segurança de cancelamento ou de início de rota vale —
# cancelamento sem espera de giro/docking, disparo sem check-turn e sem
# esperar carga. É uma LICENÇA que expira sozinha: o tablet com o Doomguy
# ligado renova a cada poucos segundos (POST /api/dev/limit-breaker); se
# parar de renovar (desligou, recarregou, fechou, reiniciou o app), cai em
# LIMIT_BREAKER_LEASE_SECONDS. Só em memória — reiniciar o servidor zera na
# hora. Precisa ser licença (e não um `force` por requisição) porque o
# disparo da próxima rota também acontece em segundo plano, na thread da
# fila, sem requisição nenhuma do tablet pra carregar o pedido. Pedido do
# usuário: não pode ter como ficar ligado esquecido.
LIMIT_BREAKER_LEASE_SECONDS = 12
_limit_breaker = {"until": 0.0, "by": None}


def _limit_breaker_active():
    return time.monotonic() < _limit_breaker["until"]


# Tenta disparar de verdade a currentRoute RESERVADA (sem taskName ainda) —
# gateado pelo mesmo check-turn do cancelamento, só que pro lado de INICIAR
# (ver "check-turn no início de tarefas" acima). Auto-contido (cuida do
# próprio QUEUE_LOCK, chamada de rede SEMPRE fora dele) e idempotente — pode
# ser chamado de qualquer lugar, a qualquer momento, sem risco de disparar
# duas vezes: se não há nada reservado pra disparar, é no-op. Devolve True se
# disparou agora, False se ficou esperando (ou não havia nada a fazer).
def _try_dispatch_current():
    with QUEUE_LOCK:
        state = _read_queue_state()
        current = state.get("currentRoute")
        if not current or current.get("taskName"):
            return False  # nada reservado, ou já disparada
        current_route_fresh = bool(state.get("currentRouteFresh"))

    # Limit breaker: dispara direto, sem trava de energia nem check-turn.
    free = _limit_breaker_active()

    # Trava de retorno pra energia (ver AWAITING_CHARGE_MESSAGE acima) — vem
    # ANTES do check-turn de propósito: se o robô está voltando sozinho pra
    # carga, nem pergunta pro check-turn (que não temos garantia nenhuma de
    # que responde certo nesse trecho, sem docking point de referência) — só
    # espera o sinal simples (chegou e carregando). Só faz sentido pra uma
    # rota FRESCA (fila estava REALMENTE vazia antes dela — ver
    # `_robot_returning_to_charge_now` acima); uma rota promovida da fila
    # nunca passa por aqui, dispara direto pro check-turn de sempre.
    if not free and current_route_fresh and _robot_returning_to_charge_now():
        with QUEUE_LOCK:
            state = _read_queue_state()
            current = state.get("currentRoute")
            if not current or current.get("taskName"):
                return False  # mudou enquanto perguntávamos
            if not state.get("awaitingCharge"):
                state["awaitingCharge"] = True
                _write_queue_state(state)
                _poke_queue_thread()  # sonda rápido já, sem esperar o sono atual (ver "Latência de até 4s")
        return False

    # Check-turn não se aplica em cima do ponto de carga (pedido do usuário,
    # 2026-09-23, confirmado ao vivo): o nicho de encaixe elétrico do
    # `energy` é apertado demais pra um giro completo de 200° — check-turn
    # dá `false` ali SEMPRE, mesmo estando perfeitamente seguro pra sair
    # (a calibração do próprio ponto confirma: `mustTurn: false` — a saída
    # não exige girar no lugar, é andar pra frente/curva normal, igual
    # qualquer outro despacho). Sem esse bypass, QUALQUER task nova travava
    # como `turnBlocked` pra sempre enquanto o robô estivesse carregando.
    # `_robot_status_cache["charging"]` é o proxy mais simples e confiável
    # de "estou em cima do ponto de energia agora" (só fica True carregando
    # de verdade, ou seja, encostado no ponto).
    if free or _robot_status_cache.get("charging"):
        safe = True
    else:
        # Chamada de rede FORA do lock (mesma cautela de robot_can_turn_safely
        # nos outros usos, ver _queue_cancel_current/_queue_tick) — o timeout
        # dela (TURN_CHECK_TIMEOUT_SECONDS) não pode prender QUEUE_LOCK e
        # travar os GET /api/live-state de todo mundo.
        safe = robot_can_turn_safely()

    # Saindo do carregador: o app não leva o garfo pra altura de navegação
    # depois da energia (ver robot_fork_to_nav_height). Fora do lock -- a
    # espera do garfo subir não pode prender o QUEUE_LOCK.
    if safe is not False and _robot_status_cache.get("charging"):
        robot_fork_to_nav_height("saindo do carregador")

    with QUEUE_LOCK:
        state = _read_queue_state()
        current = state.get("currentRoute")
        if not current or current.get("taskName"):
            return False  # mudou enquanto perguntávamos (cancelada, por ex.)
        if safe is False:
            if not state.get("turnBlocked"):
                state["turnBlocked"] = True
                _write_queue_state(state)
                _poke_queue_thread()  # sonda rápido já, sem esperar o sono atual (ver "Latência de até 4s")
            return False
        # Seguro (True) ou bridge indisponível (None, tratado como "não sei"
        # — mesmo comportamento fail-open do cancelamento, pra essa checagem
        # nova nunca travar o robô ocioso só porque o bridge não está rodando
        # nesse robô) → dispara de verdade agora.
        try:
            state["currentRoute"] = _fire_route(current)
        except Exception as err:
            print("Erro ao disparar rota reservada assim que girar ficou seguro: %s" % err)
            return False  # tenta de novo no próximo tick
        state["turnBlocked"] = False
        state["awaitingCharge"] = False
        _write_queue_state(state)
        return True


# Cancelamento de verdade da currentRoute JÁ DISPARADA (current["taskName"]
# existe — pra rota ainda reservada/sem taskName, ver
# _cancel_reserved_current_locked abaixo) — extraído pra função própria
# porque agora tem DOIS chamadores (ver "Cancelamento adiado até giro
# seguro" no CONTEXT.md): o handler HTTP (`_queue_cancel_current`, quando
# já é seguro girar na hora do clique) e a thread de fundo
# (`_queue_tick`, quando o clique veio antes de haver espaço e ficou
# esperando `cancelPending`). QUEUE_LOCK já deve estar adquirido por quem
# chama. Levanta em erro de verdade (5xx do robô) — quem chama decide o
# que fazer (o handler HTTP relata 502; a thread de fundo só loga e tenta
# de novo no próximo tick).
def _execute_cancel_current_locked(state, current):
    _robot_try_cancel(current["taskName"])

    # Cancelar a rota EM ANDAMENTO tem que FREIAR o robô, não só tirar o
    # job da fila. cancel_goal (SLAM) é o comando de navegação que de fato
    # para. Best-effort — se a promoção da pendingRoute logo abaixo
    # disparar, ela manda um goal novo por cima.
    try:
        robot_stop_navigation()
    except Exception as err:
        print("cancel-current: cancel_goal falhou: %s" % err)

    log_route_completed(current["id"], "cancelled")
    state["cancelPending"] = False
    # Limit breaker (pedido do usuário, 2026-10-07): cancelar após o pickup
    # NÃO devolve o pallet à origem — segue como cancelamento comum. Vale se o
    # pedido de cancelar já veio com limit breaker (flag persistida em state,
    # porque o cancelamento pode ter ficado adiado e ser executado depois pela
    # thread de fundo) ou se a licença do limit breaker está ativa agora.
    skip_unload = bool(state.pop("skipPostPickupUnload", False)) or _limit_breaker_active()
    if skip_unload and state.get("pickupCleared"):
        print("Pós-pickup: cancelamento SEM devolver o pallet (limit breaker).")

    # Sequência ("Lotes em sequência"): o resto do grupo assumia que esta
    # rota rodaria antes (ocupação projetada), então cai junto — inclusive
    # cancelando no robô a pendingRoute do grupo. Rotas INDEPENDENTES na
    # fila não são tocadas. Sempre acontece na hora, pickup limpo ou não —
    # o resto da sequência perde a validade assim que ESTA rota é cancelada,
    # independente de quando (ou se) o descarregar isolado abaixo terminar.
    # Idem pras tarefas do mesmo envio que dependiam desta (dependsOn).
    _drop_dependents_from_queue(state, current)

    if state.get("pickupCleared") and not skip_unload:
        # Pós-pickup (ver CONTEXT.md, "Cancelamento pós-pickup"): o robô
        # está com o pallet no garfo, e acabou de cancelar bem no giro de
        # alinhamento com o DESTINO (mesmo mecanismo do pré-pickup, ver
        # _current_route_cancel_ready) — usa o destino só como ponto de
        # docagem pra cancelar com segurança, mas NÃO entrega ali: cancelar
        # significa abortar a entrega, então o pallet volta pro ponto de
        # ORIGEM de onde foi pego (correção 2026-09-30 — a 1ª versão desta
        # feature entregava no destino por engano; ver CONTEXT.md). Isso
        # vira uma tarefa de prioridade MÁXIMA (`pendingPostPickupUnload`,
        # resolvida por _try_dispatch_post_pickup_unload em TODO tick,
        # começando já no mesmo tick que chamou esta função) — a fila normal
        # (pending/queue) fica esperando atrás dela, sem avançar ainda.
        state["currentRoute"] = None
        state["pendingPostPickupUnload"] = {
            "dropoff": current["pickup"],
            "user": current["user"],
            "palletType": current.get("palletType", "wood"),
            "palletTop": current.get("palletTop", False),
            "palletHeights": current.get("palletHeights"),
        }
        print("Pós-pickup: rota cancelada com o pallet no garfo -- devolvendo o pallet à origem (%s) via UNLOAD isolado (prioridade máxima)." % current["pickup"])
        return

    state["currentRoute"] = None
    state["pickupCleared"] = False

    # Promove pendingRoute/routeQueue -> currentRoute (fica RESERVADA, sem
    # taskName ainda — ver _advance_queue_locked) — mesmo caminho do término
    # normal (FINISHED). Uma eventual task de carga (AUTO_SYSTEM) que o robô
    # recrie sozinho nesse meio-tempo é achada e cancelada pela própria
    # _fire_route, no momento em que a rota promovida for de fato disparada
    # (ver _try_dispatch_current) — não precisa de guarda extra aqui.
    _advance_queue_locked(state)


# Resolve `pendingPostPickupUnload` (ver _execute_cancel_current_locked
# acima): tenta disparar a tarefa isolada de UNLOAD, e só quando conseguir
# vira a currentRoute de verdade (com taskName/taskRecordId já preenchidos —
# prioridade máxima, não passa pelo check-turn/espera de carga normal, o
# robô já está posicionado). Auto-contida (cuida do próprio QUEUE_LOCK,
# chamada de rede SEMPRE fora dele) e idempotente, mesmo espírito de
# _try_dispatch_current — se `robot_create_and_run_unload_chain` falhar
# (rede momentânea), NÃO desiste: o pedido continua em
# `pendingPostPickupUnload`, e o próprio _queue_tick chama isso nos
# próximos ciclos (rápido, ver DOCKING_ALIGNMENT_CANCEL_POLL_INTERVAL_
# SECONDS) até conseguir -- o pallet continua no garfo enquanto isso não
# resolve, então desistir não é opção. `pending["dropoff"]` aqui é o ponto
# de ORIGEM da rota cancelada (ver _execute_cancel_current_locked) -- o
# nome do campo ficou "dropoff" porque é o destino desta tarefa NOVA e
# isolada, não da rota original.
def _try_dispatch_post_pickup_unload():
    with QUEUE_LOCK:
        state = _read_queue_state()
        pending = state.get("pendingPostPickupUnload")
        if not pending or state.get("currentRoute"):
            return False  # nada pendente, ou já foi resolvido (outra chamada venceu a corrida)

    try:
        task_record_id = _create_task_cancelling_charge(
            lambda: robot_create_and_run_unload_chain(pending["dropoff"]),
            "UNLOAD isolado em %s" % pending["dropoff"],
        )
    except Exception as err:
        print("Aviso: falha ao disparar UNLOAD isolado em %s (%s) -- pallet continua no garfo, tentando de novo." % (pending["dropoff"], err))
        return False

    route = {
        "id": secrets.token_hex(8),
        "pickup": None,  # já foi feito na rota original, cancelada -- essa é só o descarregar
        "dropoff": pending["dropoff"],
        "palletType": pending.get("palletType", "wood"),
        "palletTop": pending.get("palletTop", False),
        "palletHeights": pending.get("palletHeights"),
        "user": pending["user"],
        "groupId": None,  # nunca faz parte de sequência nenhuma
        "taskName": "UNLOAD@" + pending["dropoff"],
        "taskRecordId": task_record_id,
        "unloadOnly": True,  # pro front (QueuePanel) renderizar "DESCARREGANDO EM: X", e pro _queue_tick sondar por id em vez de nome
    }
    log_route_requested(route["id"], None, pending["dropoff"], route["taskName"], pending["user"])
    print("Descarregando em %s (tarefa isolada, id=%s, prioridade máxima)." % (pending["dropoff"], task_record_id))

    with QUEUE_LOCK:
        state = _read_queue_state()
        if state.get("currentRoute"):
            return False  # correu por fora nesse meio-tempo -- não sobrescreve
        state["currentRoute"] = route
        state["pickupCleared"] = True  # sem fase de pickup nesta rota -- já está "limpo" por construção
        state["currentRouteFresh"] = False  # o robô já estava ativo um instante atrás, não é uma chegada "do nada"
        state["pendingPostPickupUnload"] = None
        _write_queue_state(state)
    return True


# Cancela a currentRoute enquanto ela ainda está RESERVADA (sem taskName —
# esperando o check-turn liberar o disparo, ver "check-turn no início de
# tarefas" acima). Não tem nada rodando no robô pra frear nem cancelar, então
# é só remover do estado local e avançar a fila — bem mais simples que
# _execute_cancel_current_locked (que lida com uma rota DE VERDADE em
# andamento). QUEUE_LOCK já deve estar adquirido por quem chama.
def _cancel_reserved_current_locked(state, current):
    log_route_completed(current["id"], "cancelled")
    state["currentRoute"] = None
    state["turnBlocked"] = False
    state["awaitingCharge"] = False
    _drop_dependents_from_queue(state, current)
    _advance_queue_locked(state)


# Aplica o status observado do robô pro currentRoute — usado tanto pelo tick
# normal (_queue_tick) quanto pela reconciliação na subida do servidor
# (_reconcile_queue_state_on_startup). Devolve True se mudou algo (precisa
# persistir).
def _apply_record_status(state, current, record):
    status = record.get("status")
    if status == "FINISHED":
        set_occupied_state(current["dropoff"], True)
        log_route_completed(current["id"], "finished")
        _arm_fork_after_drop(current["dropoff"])  # garfo ficou no chão: sobe quando sair do pallet
        # A rota terminou de chegar por conta própria antes de existir uma
        # janela segura pra cancelar — o cancelamento pendente (se havia)
        # perdeu o sentido, não tem mais o que cancelar.
        state["cancelPending"] = False
        _advance_queue_locked(state)
        return True
    if _is_terminal_status(status):
        # CANCELLED (por fora do app), FAILED, ERROR, etc. — a task morreu no
        # robô sem concluir. Limpa a currentRoute pra fila não ficar travada
        # nela pra sempre (era o caso do FAILED: o código só olhava
        # FINISHED/CANCELLED, então FAILED ficava "em andamento" eterno).
        log_route_completed(current["id"], "cancelled" if status == "CANCELLED" else "failed")
        state["cancelPending"] = False  # já morreu por fora — nada mais a cancelar

        if current.get("unloadOnly"):
            # Cancelamento pós-pickup (ver CONTEXT.md): o UNLOAD isolado que
            # deveria terminar de descarregar o pallet morreu SEM concluir —
            # o pallet pode continuar no garfo. NÃO desiste: volta pro
            # mesmo `pendingPostPickupUnload` de antes, pra tentar de novo
            # sozinho (ver _try_dispatch_post_pickup_unload) em vez de
            # deixar a fila (e o pallet) parados sem aviso nenhum.
            print("ATENÇÃO: UNLOAD isolado em %s terminou sem concluir (%s) -- tentando de novo, pallet pode continuar no garfo." % (
                current["dropoff"], status))
            state["currentRoute"] = None
            state["pendingPostPickupUnload"] = {
                "dropoff": current["dropoff"],
                "user": current["user"],
                "palletType": current.get("palletType", "wood"),
                "palletTop": current.get("palletTop", False),
                "palletHeights": current.get("palletHeights"),
            }
            return True

        # NÃO promove pendingRoute/routeQueue: não sabemos o que o dispatch
        # faz com elas quando a task ativa morre por fora (pode ter derrubado
        # junto), e presumir que dá pra seguir já causou o bug "robô para e
        # volta pra energia" (ver CONTEXT.md). pendingRoute órfã volta a
        # fazer sentido no próximo disparo pelo Ponto a Ponto.
        state["currentRoute"] = None
        state["pickupCleared"] = False
        # Se fazia parte de uma sequência, o resto do grupo perdeu a validade
        # junto (decisão do usuário: cancelar o resto) — e as tarefas do
        # mesmo envio que dependiam desta (dependsOn).
        _drop_dependents_from_queue(state, current)
        return True
    return False  # ainda em execução — nada a fazer, tenta de novo no próximo tick


# Parada de emergência ATIVA: mantém o robô parado onde está. A cada tick
# (rápido, ver EMERGENCY_POLL_INTERVAL_SECONDS):
#  1. `cancel_goal` na API SLAM — o comando que de fato FREIA o robô (o
#     dispatch/all-cancel só mexe na fila, não no movimento — bug de campo
#     2026-09-11). Vai SEMPRE, mesmo sem task ativa: o robô pode estar
#     andando por uma navegação que não é uma task (recovery, retorno pra
#     carga que falhou de planejar, etc.).
#  2. all-cancel no dispatch se surgiu QUALQUER task ativa (a AUTO_SYSTEM de
#     carga que o robô recria sozinho ao ficar sem fila).
# MELHOR ESFORÇO, não fail-safe: se o servidor/rede cair, o robô volta ao
# normal sozinho. NÃO substitui o E-stop físico.
def _emergency_suppress():
    try:
        robot_stop_navigation()
    except Exception as err:
        print("Emergência: cancel_goal falhou: %s" % err)
    try:
        records = robot_fetch_recent_task_records(size=5)
    except Exception:
        return  # robô/rede indisponível agora — tenta de novo no próximo tick
    if not any(not _is_terminal_status(r.get("status")) for r in records):
        return
    try:
        robot_cancel_all_tasks()
    except Exception as err:
        print("Emergência: falha ao cancelar a task recriada pelo robô: %s" % err)


# Tick da thread de fundo — devolve quantos segundos esperar até o próximo
# (curto durante a emergência, normal fora dela). Porta do useEffect de
# sondagem em MainApp.jsx, incluindo o Caso 2 (desmarcar origem assim que o
# PICKUP terminar, via finishTime não-nulo — nunca vimos o valor de status
# de uma ação concluída com sucesso).
# Limpeza automática da fila parada (ver QUEUE_IDLE_TIMEOUT_SECONDS). Em vez
# de carimbar "última atividade" em cada handler (enfileirar, cancelar,
# reordenar, avanço da fila...), compara a cada tick uma "impressão digital"
# do que importa no estado: mudou => houve atividade, zera o contador. Pega
# qualquer mudança, inclusive as que vierem a existir depois, sem ninguém
# lembrar de carimbar. Os flags de espera entram na impressão pra que sair
# de uma espera legítima (abaixo) também zere o contador.
def _queue_activity_fingerprint(state):
    current = state.get("currentRoute") or {}
    pending = state.get("pendingRoute") or {}
    return json.dumps([
        current.get("id"), current.get("taskName"),
        pending.get("id"), pending.get("taskName"),
        [r.get("id") for r in state.get("routeQueue") or []],
        bool(state.get("pickupCleared")),
        bool(state.get("pendingPostPickupUnload")),
        bool(state.get("cancelPending")),
        bool(state.get("turnBlocked")),
        bool(state.get("awaitingCharge")),
    ])


# Horário de parede (time.time, não monotonic) e persistido no
# queue_state.json — sobrevive a reinício do servidor. Quando estoura:
#  - o que só está ESPERANDO (pendingRoute, routeQueue, currentRoute ainda
#    RESERVADA) sai na hora, como no _clear_stale_queue_on_startup;
#  - a rota EM ANDAMENTO no robô (com taskName) NÃO é cancelada à força:
#    vira `cancelPending`, exatamente como se o operador tivesse clicado em
#    cancelar — mesma espera de giro seguro/eixo do docking, e com pallet no
#    garfo o fluxo pós-pickup devolve o pallet à origem;
#  - o UNLOAD isolado pós-pickup (unloadOnly) é deixado em paz: é o pallet
#    voltando pra origem, cancelar só o faria ser recriado.
# Não conta tempo durante esperas legítimas que podem passar de 1h: cancela-
# mento adiado (cancelPending), esperando o robô chegar na energia
# (awaitingCharge) e UNLOAD pós-pickup pendente. Emergência nem chega aqui
# (_queue_tick retorna antes). Chamada de rede só no instante da limpeza,
# FORA do QUEUE_LOCK; no caminho comum é só uma leitura do estado.
def _refresh_idle_queue_timeout():
    now = time.time()
    with QUEUE_LOCK:
        state = _read_queue_state()
        fingerprint = _queue_activity_fingerprint(state)
        if fingerprint != state.get("idleFingerprint"):
            state["idleFingerprint"] = fingerprint
            state["idleSince"] = now
            _write_queue_state(state)
            return
        if state.get("cancelPending") or state.get("awaitingCharge") or state.get("pendingPostPickupUnload"):
            return
        if now - (state.get("idleSince") or now) < QUEUE_IDLE_TIMEOUT_SECONDS:
            return

        dropped = []
        to_cancel_on_robot = []
        pending = state.get("pendingRoute")
        if pending:
            log_route_completed(pending["id"], "cancelled")
            if pending.get("taskName"):
                to_cancel_on_robot.append(pending["taskName"])
            dropped.append(pending)
            state["pendingRoute"] = None
        for route in state.get("routeQueue") or []:
            log_route_completed(route["id"], "cancelled")
            dropped.append(route)
        state["routeQueue"] = []
        current = state.get("currentRoute")
        if current and not current.get("taskName"):
            log_route_completed(current["id"], "cancelled")
            dropped.append(current)
            state["currentRoute"] = None
            state["turnBlocked"] = False
            current = None
        cancel_current = bool(current) and not current.get("unloadOnly")
        if cancel_current:
            state["cancelPending"] = True
        if not dropped and not cancel_current:
            return  # fila vazia (ou só o UNLOAD pós-pickup rodando) — nada a limpar
        _write_queue_state(state)

    print("Fila parada há mais de %d min — limpa automaticamente: %d rota(s) em espera descartada(s)%s." % (
        QUEUE_IDLE_TIMEOUT_SECONDS // 60, len(dropped),
        ", cancelamento da rota em andamento pedido (aguarda posição segura)" if cancel_current else ""))
    for task_name in to_cancel_on_robot:
        try:
            _robot_try_cancel(task_name)
        except Exception as err:
            print("Limpeza automática: não deu pra cancelar '%s' no robô: %s" % (task_name, err))


def _queue_tick():
    _refresh_robot_status()  # sempre, independente de emergência/rota em andamento
    _refresh_stall_at_origin()  # só gasta chamadas ao robô com o alerta de parado já disparado
    _refresh_route_planning_wait()  # só pergunta a pose com rota disparada, não-RUNNING e robô parado

    # Emergência tem precedência sobre tudo: a fila já foi esvaziada (ver
    # _queue_emergency), então aqui só se reprime a task de carga recriada.
    # _emergency_suppress só fala com o robô (não toca no estado), então roda
    # FORA do QUEUE_LOCK — senão uma chamada lenta ao robô (timeout 10s)
    # seguraria o lock e travaria os GET /api/live-state de todo mundo, e
    # agora isso acontece a cada 1,5s.
    with QUEUE_LOCK:
        emergency = bool(_read_queue_state().get("emergency"))
    if emergency:
        _clear_fork_after_drop()  # garfo não se mexe sozinho depois de uma emergência
        _emergency_suppress()
        return EMERGENCY_POLL_INTERVAL_SECONDS

    _refresh_fork_after_drop()  # no-op sem depósito recente

    # Antes do bloco de cancelPending logo abaixo: se a limpeza automática
    # pedir o cancelamento da rota em andamento, ele já é tratado neste tick.
    _refresh_idle_queue_timeout()

    # Destravamento manual do ROTATE_ERROR (ver CONTEXT.md) — só faz sentido
    # quando a fila está genuinamente ociosa (é sempre a AUTO_SYSTEM nativa
    # indo pra energia que trava assim, nunca uma rota nossa) e o robô não
    # está carregando ainda. Cheque leve (um GET), roda toda vez.
    with QUEUE_LOCK:
        state = _read_queue_state()
        idle_now = (not state.get("currentRoute") and not state.get("pendingRoute")
                    and not (state.get("routeQueue") or []))
    if idle_now and not bool(_robot_status_cache.get("charging")):
        _recover_from_rotate_error_if_stuck()

    # Cancelamento adiado até giro seguro (ver CONTEXT.md) — o operador já
    # pediu pra cancelar, mas na hora não tinha espaço pra girar. Decide
    # FORA do lock se precisa perguntar "já dá pra girar?" pro bridge —
    # mesma cautela de _emergency_suppress acima: essa chamada pode ser
    # lenta (timeout de rede) e esse tick passa a rodar mais rápido
    # (CANCEL_PENDING_POLL_INTERVAL_SECONDS) enquanto isso está pendente,
    # então prender o QUEUE_LOCK durante ela travaria os
    # GET /api/live-state de todo mundo com mais frequência ainda.
    with QUEUE_LOCK:
        state = _read_queue_state()
        cancel_pending_now = bool(state.get("cancelPending"))
        cancel_pending_current = state.get("currentRoute") if cancel_pending_now else None
        cancel_pending_pickup_cleared = bool(state.get("pickupCleared"))
    cancel_poll_interval = _cancel_poll_interval(cancel_pending_now and bool(cancel_pending_current))
    if cancel_pending_now and cancel_pending_current:
        # Checagem fresca ANTES de decidir (ver CONTEXT.md, incidente
        # 2026-09-30 — mesmo cuidado do handler HTTP em _queue_cancel_current).
        cancel_pending_pickup_cleared = _resolve_pickup_cleared_for_cancel(cancel_pending_current, cancel_pending_pickup_cleared)
        forced = _limit_breaker_active()
        if forced or _current_route_cancel_ready(cancel_pending_current, cancel_pending_pickup_cleared):
            executed = False
            with QUEUE_LOCK:
                state = _read_queue_state()
                current = state.get("currentRoute")
                if current and state.get("cancelPending"):
                    if cancel_pending_pickup_cleared:
                        state["pickupCleared"] = True
                    try:
                        _execute_cancel_current_locked(state, current)
                        executed = True
                    except Exception as err:
                        # tenta de novo no próximo tick — a rota atual
                        # continua rodando normalmente entretanto, sem
                        # risco extra (é exatamente o comportamento
                        # "adiado" que queremos).
                        print("cancelPending: erro ao executar cancelamento após janela segura: %s" % err)
                _write_queue_state(state)
            # Cancelou pela regra do eixo = robô sobre o docking, garfo fora
            # do lote: devolve o garfo à altura de navegação antes da próxima
            # tarefa (ou da devolução do pallet) -- o app não faz isso depois
            # de cancelamento. Cancelamento forçado pode ter sido em qualquer
            # lugar: não mexe no garfo.
            # Com pallet no garfo (devolução pendente) não espera o garfo
            # chegar: o robô fica sem task nesse intervalo e a AUTO_SYSTEM
            # nasce e sai andando pra energia antes do UNLOAD (campo
            # 2026-10-27, #68474 antes do UNLOAD #68475). O comando continua
            # indo ANTES do UNLOAD -- se a origem for perto, a altura de
            # depósito do app não pode chegar antes do nosso 300 mm.
            if executed and not forced:
                with QUEUE_LOCK:
                    returning_pallet = bool(_read_queue_state().get("pendingPostPickupUnload"))
                robot_fork_to_nav_height("depois do cancelamento", settle=not returning_pallet)
            # Pós-pickup (ver CONTEXT.md, "Cancelamento pós-pickup"): resolve
            # já, no mesmo tick, em vez de esperar o ciclo normal (4s) — o
            # pallet está no garfo, quanto antes melhor. Idempotente/no-op
            # se não havia nada pendente (caminho comum, sem pallet).
            _try_dispatch_post_pickup_unload()
            with QUEUE_LOCK:
                still_pending_unload = bool(_read_queue_state().get("pendingPostPickupUnload"))
            return DOCKING_ALIGNMENT_CANCEL_POLL_INTERVAL_SECONDS if still_pending_unload else QUEUE_POLL_INTERVAL_SECONDS
        # ainda sem espaço pra girar / ainda não alinhou no docking point --
        # a rota ATUAL continua rodando normalmente (nada abaixo trata isso
        # diferente), só sondamos de novo mais rápido no final desta função.

    # Check-turn no início de tarefas (ver "check-turn no início de tarefas"
    # acima): se há uma currentRoute RESERVADA (sem taskName — rota nova, ou
    # promovida de pendingRoute/routeQueue depois de um término/cancelamento)
    # esperando o check-turn liberar, tenta disparar agora. Idempotente e
    # auto-contido (própria chamada de rede fora do lock) — no-op se não há
    # nada reservado pra disparar.
    _try_dispatch_current()

    # Pós-pickup (ver CONTEXT.md, "Cancelamento pós-pickup"): se sobrou um
    # UNLOAD isolado pendente (1ª tentativa falhou por rede, ver
    # _try_dispatch_post_pickup_unload), tenta de novo aqui — roda em TODO
    # tick, não só no instante do cancelamento, porque o pallet continua no
    # garfo enquanto isso não resolve. Idempotente/no-op se não há nada
    # pendente (a checagem de leitura evita a chamada de rede à toa).
    with QUEUE_LOCK:
        has_pending_unload = bool(_read_queue_state().get("pendingPostPickupUnload"))
    if has_pending_unload:
        _try_dispatch_post_pickup_unload()

    with QUEUE_LOCK:
        state = _read_queue_state()
        current = state.get("currentRoute")
        if not current or not current.get("taskName"):
            # Ou não há currentRoute nenhuma, ela ainda está RESERVADA
            # esperando giro seguro (turnBlocked) ou o robô chegar na energia
            # (awaitingCharge) pra começar, ou tem um UNLOAD isolado ainda
            # pendente (pendingPostPickupUnload) — nada rodando de verdade
            # no robô ainda pra sondar status.
            turn_blocked_now = bool(state.get("turnBlocked"))
            awaiting_charge_now = bool(state.get("awaitingCharge"))
            pending_unload_now = bool(state.get("pendingPostPickupUnload"))
            fast = cancel_pending_now or turn_blocked_now or awaiting_charge_now or pending_unload_now
            interval = DOCKING_ALIGNMENT_CANCEL_POLL_INTERVAL_SECONDS if pending_unload_now else cancel_poll_interval
            return interval if fast else QUEUE_POLL_INTERVAL_SECONDS
        try:
            record = (robot_fetch_task_record_by_id(current["taskRecordId"]) if current.get("unloadOnly")
                      else robot_fetch_latest_task_record(current["taskName"]))
        except Exception:
            return cancel_poll_interval if cancel_pending_now else QUEUE_POLL_INTERVAL_SECONDS  # falha de rede pontual — tenta de novo no próximo tick
        if not record:
            return cancel_poll_interval if cancel_pending_now else QUEUE_POLL_INTERVAL_SECONDS

        # Caso 2: desmarca a origem assim que o PICKUP terminar COM SUCESSO —
        # o pallet saiu fisicamente de lá.
        #
        # CUIDADO: só age se a rota NÃO foi cancelada. Uma ação (ou a task
        # inteira) cancelada também ganha um `finishTime` (é o carimbo do
        # cancelamento, não de conclusão) — e já vimos `status: "CANCELLED"`
        # numa ação em campo. Sem esse guard, cancelar uma rota com o robô
        # ainda A CAMINHO da coleta apagava o X da origem de um pallet que
        # ele nunca chegou a pegar. Rota cancelada => deixa a ocupação como
        # está; a suposição segura é que o pallet continua onde estava.
        pickup_just_cleared = False
        if not state.get("pickupCleared") and record.get("status") != "CANCELLED":
            try:
                actions = robot_fetch_action_records(record["id"])
                pickup_action = next((a for a in actions if a.get("serialNumber") == 1), None)
                if (pickup_action
                        and pickup_action.get("finishTime")
                        and pickup_action.get("status") != "CANCELLED"):
                    state["pickupCleared"] = True
                    pickup_just_cleared = True
                    set_occupied_state(current["pickup"], False)
            except Exception:
                pass  # melhor esforço — tenta de novo no próximo tick

        _note_route_record(current, record)  # só lê o que já veio: o aviso "planejando a rota" não faz chamada extra
        advanced = _apply_record_status(state, current, record)
        # pickupCleared PRECISA ir pro disco na hora (bug até 2026-10-28: só
        # era gravado junto com um avanço de status, então no meio da rota
        # ele era recalculado e descartado a cada tick — o ícone do robô
        # nunca mostrava o pallet e o cancelamento dependia só da checagem
        # fresca de _pickup_actually_completed)
        if advanced or pickup_just_cleared:
            _write_queue_state(state)
        cancel_pending_now = bool(state.get("cancelPending"))
        turn_blocked_now = bool(state.get("turnBlocked"))
        awaiting_charge_now = bool(state.get("awaitingCharge"))

    if advanced:
        # A rota que acabou de terminar/morrer promoveu a próxima (RESERVADA,
        # sem taskName) — tenta disparar já, no mesmo tick, em vez de esperar
        # o próximo ciclo. No caminho comum (giro seguro) isso mantém o gap
        # entre rotas praticamente igual a zero, como era antes; só demora de
        # verdade quando o check-turn diz "ainda não".
        _try_dispatch_current()
        with QUEUE_LOCK:
            state = _read_queue_state()
            cancel_pending_now = bool(state.get("cancelPending"))
            turn_blocked_now = bool(state.get("turnBlocked"))
            awaiting_charge_now = bool(state.get("awaitingCharge"))
    else:
        # Nossa rota continua disparada e não terminou — nenhuma AUTO_SYSTEM
        # pode estar ativa agora (ver _cancel_charge_task_hijacking_route).
        # Fora do QUEUE_LOCK: são chamadas de rede.
        _cancel_charge_task_hijacking_route(current["taskName"])

    fast = cancel_pending_now or turn_blocked_now or awaiting_charge_now
    return _cancel_poll_interval(cancel_pending_now) if fast else QUEUE_POLL_INTERVAL_SECONDS


def _clear_stale_queue_on_startup(state):
    """Ao subir, descarta tudo que ficou ESPERANDO de uma sessão anterior
    (pedido do usuário, 2026-10-07): fila, próxima rota e descarregamento
    pós-pickup pendente — pra ligar o robô de manhã sem ele começar tarefas
    que ninguém concluiu no dia anterior. A próxima rota (pendingRoute) já
    foi despachada pro robô, então também é cancelada lá (melhor esforço).
    Uma rota EM ANDAMENTO já disparada (currentRoute com taskName) NÃO é
    descartada aqui: é o que o robô está fazendo de verdade, e perder o
    rastro dela seria pior — a conferência logo abaixo limpa se já acabou.
    A rota só RESERVADA (sem taskName, nunca foi pro robô) é descartada.
    Parada de emergência e ocupação (calibration.json) ficam como estão."""
    dropped = []
    pending = state.get("pendingRoute")
    if pending:
        if pending.get("taskName"):
            try:
                _robot_try_cancel(pending["taskName"])
            except Exception as err:
                print("Aviso: não deu pra cancelar no robô a próxima rota '%s' ao subir (%s) — ela pode continuar lá." % (pending["taskName"], err))
        log_route_completed(pending["id"], "cancelled")
        dropped.append(pending)
        state["pendingRoute"] = None
    for route in state.get("routeQueue") or []:
        log_route_completed(route["id"], "cancelled")
        dropped.append(route)
    state["routeQueue"] = []
    current = state.get("currentRoute")
    if current and not current.get("taskName"):
        log_route_completed(current["id"], "cancelled")
        dropped.append(current)
        state["currentRoute"] = None
        current = None
    if state.get("pendingPostPickupUnload"):
        state["pendingPostPickupUnload"] = None
        dropped.append({})
    if not current:
        state["cancelPending"] = False
        state["turnBlocked"] = False
        state["awaitingCharge"] = False
    if dropped:
        _write_queue_state(state)
        print("Fila limpa ao subir: %d tarefa(s) de antes descartada(s)." % len(dropped))


def _reconcile_queue_state_on_startup():
    """Ao subir, não confia cegamente no que sobrou em queue_state.json —
    o robô pode ter terminado/cancelado a rota enquanto o processo estava
    fora do ar (ex: reinício pra trocar ROBOT_HOST). Confere contra o robô
    de verdade antes de aceitar o estado persistido como válido, evitando
    mostrar pra todo mundo um "em andamento" que já acabou faz tempo."""
    with QUEUE_LOCK:
        state = _read_queue_state()
        _clear_stale_queue_on_startup(state)
        if state.get("emergency"):
            print("Parada de emergência estava ATIVA quando o servidor caiu — continua ativa, reprimindo a task de carga. Libere pelo botão no app quando for seguro.")
            return
        current = state.get("currentRoute")
        if not current:
            return
        if not current.get("taskName"):
            # RESERVADA, esperando o check-turn liberar o disparo (ver
            # "check-turn no início de tarefas") — nunca chegou a ir pro
            # robô, nada pra reconciliar aqui. O tick de fundo, assim que
            # subir, tenta disparar normalmente.
            return
        try:
            record = (robot_fetch_task_record_by_id(current["taskRecordId"]) if current.get("unloadOnly")
                      else robot_fetch_latest_task_record(current["taskName"]))
        except Exception:
            print("Aviso: não deu pra confirmar com o robô o status da rota salva (rede/robô indisponível agora) — mantendo o estado salvo, a sondagem de fundo tenta de novo em breve.")
            return
        if not record:
            return
        if _apply_record_status(state, current, record):
            _write_queue_state(state)
            print("Estado da fila reconciliado com o robô ao subir (a rota salva já tinha terminado/sido cancelada enquanto o servidor estava fora do ar).")


# Thread de fundo da fila — parável, pro botão de power da GUI do .exe:
# desligar o servidor precisa MATAR essa thread também, senão religar
# deixaria duas rodando (sondagem/promoção duplicada).
#
# `_queue_wake` (ver CONTEXT.md, "Latência de até 4s no cancelamento
# adiado" — incidente de campo 2026-09-30): incidente de campo mostrou o
# UNLOAD já rodando 44s antes do cancelamento pós-pickup sair — uma
# hipótese real é essa aqui, não específica de pickup/dropoff: em operação
# normal a thread dorme QUEUE_POLL_INTERVAL_SECONDS (4s) inteiros entre
# ticks; se o clique de cancelar chegar bem no início desse sono e o robô
# ainda não estiver alinhado, `cancelPending` fica True mas NINGUÉM sonda o
# alinhamento até a thread acordar sozinha — até 4s de janela morta,
# comível o bastante pra engolir a margem de 30° inteira. `_poke_queue_
# thread()` acorda a thread NA HORA sempre que algo passa a exigir atenção
# rápida (por enquanto: `cancelPending`/`turnBlocked`/`awaitingCharge`
# virando True), em vez de esperar o sono atual terminar. Idempotente — se
# a thread já está acordada processando um tick, o poke não faz nada
# (ela vai reler o estado atualizado de qualquer jeito no próximo `wait`).
#
# Reaproveita o MESMO Event pra "acordar por parada" e "acordar por poke":
# um `wait()` só, sem precisar escolher entre dois Events — quem acorda
# confere `_queue_stop.is_set()` pra saber se é hora de sair ou só de rodar
# mais um tick.
_queue_thread = None
_queue_stop = threading.Event()
_queue_wake = threading.Event()


def _poke_queue_thread():
    _queue_wake.set()


def _start_queue_thread():
    global _queue_thread
    if _queue_thread is not None and _queue_thread.is_alive():
        return  # já rodando — idempotente
    _queue_stop.clear()
    _queue_wake.clear()

    def _loop():
        interval = QUEUE_POLL_INTERVAL_SECONDS
        while True:
            _queue_wake.wait(interval)  # acorda no timeout OU num _poke_queue_thread()
            if _queue_stop.is_set():
                return
            _queue_wake.clear()
            try:
                interval = _queue_tick() or QUEUE_POLL_INTERVAL_SECONDS
                fired_at = _route_fired_at["t"]
                if fired_at is not None and time.monotonic() - fired_at < ROUTE_FIRED_WATCH_SECONDS:
                    interval = min(interval, ROUTE_FIRED_WATCH_INTERVAL_SECONDS)
                if _fork_after_drop["point"]:
                    interval = min(interval, FORK_AFTER_DROP_POLL_INTERVAL_SECONDS)
            except Exception as err:
                print("Erro inesperado na sondagem da fila: %s" % err)
                interval = QUEUE_POLL_INTERVAL_SECONDS

    _queue_thread = threading.Thread(target=_loop, daemon=True)
    _queue_thread.start()


def _stop_queue_thread():
    global _queue_thread
    _queue_stop.set()
    _queue_wake.set()  # acorda a thread AGORA pra ela conferir _queue_stop e sair, em vez de esperar o timeout atual
    if _queue_thread is not None:
        # join generoso: um tick pode estar no meio de uma chamada ao robô
        # (timeout 10s) segurando o QUEUE_LOCK.
        _queue_thread.join(timeout=12)
        if _queue_thread.is_alive():
            print("Aviso: a thread da fila não encerrou a tempo (chamada ao robô presa?) — segue como daemon.")
        _queue_thread = None


# --- ciclo de vida do servidor (pro botão de power da GUI) ----------------
# O modo CLI (python3 server.py) e a GUI do .exe usam o MESMO start_server/
# stop_server. serve_forever roda numa thread pra start_server não bloquear
# (a GUI precisa seguir respondendo); o CLI só fica dormindo enquanto
# is_running().
_httpd = None


def start_server(robot_host=None, port=None):
    global _httpd
    if _httpd is not None:
        return  # já no ar
    if robot_host:
        set_robot_host(robot_host)  # IP explícito (ex: digitado na GUI do .exe) — respeita, não varre por cima
    else:
        discover_robot_host()
    listen_port = port or LISTEN_PORT
    _seed_calibration_if_missing()
    _bootstrap_users_if_missing()
    _reconcile_queue_state_on_startup()
    _start_queue_thread()
    _start_obstacle_thread()
    handler = functools.partial(Handler, directory=STATIC_DIR)
    _httpd = http.server.ThreadingHTTPServer(("0.0.0.0", listen_port), handler)
    threading.Thread(target=_httpd.serve_forever, daemon=True).start()


def stop_server():
    global _httpd
    if _httpd is None:
        return
    srv, _httpd = _httpd, None
    srv.shutdown()
    srv.server_close()
    _stop_queue_thread()


def is_running():
    return _httpd is not None


# Login (múltiplos operadores, cada um via tablet — ver CONTEXT.md, "Sistema
# de login"). Mesma filosofia zero-dependência do resto do projeto: usuários
# num arquivo local (users.json, mesmo padrão de calibration.json/
# route_log.json), senha nunca em texto puro (PBKDF2-HMAC-SHA256 com salt
# próprio por usuário), sessão como cookie ASSINADO (HMAC com uma chave
# secreta só do servidor) em vez de sessão em memória — sobrevive a restart
# do processo sem precisar de banco nenhum. HTTP simples (sem HTTPS) é
# aceitável aqui de propósito: rede local isolada, sem exposição à internet
# (ver CONTEXT.md) — a senha trafega em claro dentro dessa rede, troca
# consciente pra esse contexto, mas o cookie de sessão pelo menos não pode
# ser forjado sem conhecer a chave secreta guardada só no servidor.
USERS_FILE = _app_dir() / "users.json"
USERS_LOCK = threading.Lock()
SESSION_SECRET_FILE = _app_dir() / "session_secret.key"
SESSION_COOKIE_NAME = "lifty_session"
SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600  # 30 dias — tablet de uso diário, não vale reforçar login toda hora
PBKDF2_ITERATIONS = 200_000
LOGIN_MAX_ATTEMPTS = 3  # senha errada 3x seguidas bloqueia a conta (por username) até um admin desbloquear

LOGIN_PATH = "/api/login"
LOGOUT_PATH = "/api/logout"
SESSION_PATH = "/api/session"
SESSION_THEME_PATH = "/api/session/theme"  # preferência de tema do PRÓPRIO usuário logado (self-service, não é coisa de admin)
SESSION_FULLSCREEN_PATH = "/api/session/fullscreen"  # idem, ver _user_fullscreen
USERS_PATH = "/api/users"


def _load_or_create_session_secret():
    if SESSION_SECRET_FILE.exists():
        return bytes.fromhex(SESSION_SECRET_FILE.read_text(encoding="utf-8").strip())
    secret = secrets.token_bytes(32)
    SESSION_SECRET_FILE.write_text(secret.hex(), encoding="utf-8")
    return secret


SESSION_SECRET = _load_or_create_session_secret()


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return salt.hex() + "$" + digest.hex()


def verify_password(password, stored):
    try:
        salt_hex, _ = stored.split("$", 1)
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    return hmac.compare_digest(hash_password(password, salt), stored)


def make_session_token(username):
    expiry = int(time.time()) + SESSION_MAX_AGE_SECONDS
    payload = ("%s:%d" % (username, expiry)).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    sig = hmac.new(SESSION_SECRET, payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return payload_b64 + "." + sig


def verify_session_token(token):
    if not token or "." not in token:
        return None
    payload_b64, _, sig = token.rpartition(".")
    expected_sig = hmac.new(SESSION_SECRET, payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        return None
    try:
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        username, expiry_str = base64.urlsafe_b64decode(padded).decode("utf-8").rsplit(":", 1)
        expiry = int(expiry_str)
    except (ValueError, UnicodeDecodeError):
        return None
    if time.time() > expiry:
        return None
    return username


def _read_users():
    if not USERS_FILE.exists():
        return []
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _write_users(users):
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")


# Preferência de tema por CONTA (não por dispositivo): o operador loga em
# qualquer tablet e encontra o tema dele, em vez de ter que trocar toda vez.
# Antes isso vivia só no localStorage do navegador, ou seja, morria a cada
# troca de aparelho.
DEFAULT_THEME = "dark"  # mesmo padrão do site (ver index.css/theme.js)
VALID_THEMES = ("dark", "light")


def _user_theme(user):
    theme = user.get("theme")
    return theme if theme in VALID_THEMES else DEFAULT_THEME


# Preferência de tela cheia por CONTA (pedido do usuário, 2026-10-01) —
# mesmo espírito do tema acima: fica vinculada à conta, não ao tablet.
# Diferença importante: a API de Fullscreen do navegador só entra em tela
# cheia dentro de um gesto do usuário (toque/clique) — nenhum navegador
# deixa um `requestFullscreen()` disparar sozinho ao carregar a página, por
# segurança. Então esta flag não "força" nada por si só: o front (ver
# MainApp.jsx) usa ela pra decidir se deve entrar em tela cheia no PRÓXIMO
# toque do operador no app, já que ele vai tocar em algo de qualquer jeito.
def _user_fullscreen(user):
    return bool(user.get("fullscreen"))


# Senha da conta inicial (pedido do usuário, 2026-10-15): "admin"/"admin" pra
# facilitar o primeiro acesso numa máquina nova (a VM da empresa) — quem
# instala só abre o endereço e entra, sem caçar a senha no log. É uma senha
# FRACA conhecida: a rede é fechada (porta 8000 não sai pra internet) e o
# 1º passo depois de entrar tem que ser trocar a senha na tela de Usuários.
# (Antes era uma senha aleatória impressa uma única vez no console.)
INITIAL_ADMIN_PASSWORD = "admin"


def _bootstrap_users_if_missing():
    """Primeiro boot sem users.json: cria a conta inicial admin/admin. Só
    roda quando NÃO existe users.json — uma instalação que já tem usuários
    (inclusive levada de outra máquina) nunca é tocada."""
    if USERS_FILE.exists():
        return
    _write_users([
        {"username": "admin", "passwordHash": hash_password(INITIAL_ADMIN_PASSWORD), "isAdmin": True},
    ])
    print("=" * 70)
    print("Nenhum users.json encontrado — usuário inicial criado:")
    print("  usuário: admin")
    print("  senha:   " + INITIAL_ADMIN_PASSWORD)
    print("TROQUE a senha no 1º acesso pela tela de Usuários (modo admin).")
    print("=" * 70)


class Handler(http.server.SimpleHTTPRequestHandler):
    # Tipos MIME explícitos dos arquivos do app. Sem isso o Python consulta o
    # registro do Windows (HKEY_CLASSES_ROOT) pra descobrir o tipo — e numa
    # máquina com o registro "sujo" um `.js` pode sair como text/plain, o que
    # faz o navegador RECUSAR o bundle do React (tela em branco, sem erro no
    # servidor). No Linux isso nunca aparece; no Windows/VM, é um clássico.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
        ".css": "text/css", ".json": "application/json",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
        ".ico": "image/x-icon", ".webm": "audio/webm", ".mp3": "audio/mpeg",
    }

    # Arquivos estáticos (index.html, bundle JS/CSS, imagens) continuam
    # públicos de propósito: é o SPA React que decide mostrar a tela de
    # login ou não, então ele precisa carregar SEM sessão pra poder mostrar
    # essa tela em primeiro lugar. Tudo que é dado/ação de verdade (proxy do
    # robô, calibração, histórico, usuários) fica atrás de _require_auth/
    # _require_admin abaixo.

    # CUIDADO — já mordeu (2026-09-14): SimpleHTTPRequestHandler não manda
    # Cache-Control nenhum, então o navegador decide sozinho por heurística
    # — e em tablet/Chrome mobile isso costuma significar "guarda o
    # index.html em cache local e nem revalida". Como o `index.html`
    # referencia o JS/CSS pelo nome com HASH DE CONTEÚDO (Vite), um
    # index.html cacheado prende o tablet numa versão VELHA do app pra
    # sempre — precisava de "limpar cache do site" manual em cada tablet a
    # cada atualização. Forçando `no-cache` só no index.html (raiz), o
    # navegador sempre revalida antes de usar — os arquivos em /assets/
    # (o hash muda sozinho quando o conteúdo muda) continuam livres pra
    # cachear à vontade, sem risco de servir algo desatualizado.
    def end_headers(self):
        if self.path in ("/", "/index.html"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith(API_PREFIX):
            if not self._require_auth():
                return
            self._proxy("GET")
        elif self.path == CALIBRATION_PATH:
            if not self._require_auth():
                return
            self._get_calibration()
        elif self.path == ROUTE_LOG_PATH:
            if not self._require_auth():
                return
            self._get_route_log()
        elif self.path == LIVE_STATE_PATH:
            if not self._require_auth():
                return
            self._get_live_state()
        elif self.path == ROBOT_POSE_PATH:
            if not self._require_auth():
                return
            self._relay(200, "application/json", json.dumps(_cached_robot_pose()).encode("utf-8"))
        elif self.path == ROUTE_GRAPH_PATH:
            if not self._require_auth():
                return
            try:
                self._relay(200, "application/json", json.dumps(_route_graph(), ensure_ascii=False).encode("utf-8"))
            except Exception as err:
                self._relay(502, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
        elif self.path == SESSION_PATH:
            self._get_session()
        elif self.path == USERS_PATH:
            if not self._require_admin():
                return
            self._get_users()
        elif self.path == KANBANS_PATH:
            if not self._require_auth():
                return
            self._get_kanbans()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith(API_PREFIX):
            if not self._require_auth():
                return
            self._proxy("POST")
        elif self.path == CALIBRATION_PATH:
            if not self._require_auth():
                return
            self._save_calibration()
        elif self.path == QUEUE_ENQUEUE_BATCH_PATH:
            user = self._require_auth()
            if not user:
                return
            self._queue_enqueue_batch(user)
        elif self.path == QUEUE_CANCEL_CURRENT_PATH:
            user = self._require_auth()
            if not user:
                return
            self._queue_cancel_current(user)
        elif self.path == QUEUE_REMOVE_QUEUED_PATH:
            user = self._require_auth()
            if not user:
                return
            self._queue_remove_queued(user)
        elif self.path == QUEUE_CLEAR_ALL_PATH:
            user = self._require_auth()
            if not user:
                return
            self._queue_clear_all(user)
        elif self.path == QUEUE_REORDER_PATH:
            user = self._require_auth()
            if not user:
                return
            self._queue_reorder(user)
        elif self.path == QUEUE_EMERGENCY_PATH:
            if not self._require_auth():
                return
            self._queue_emergency()
        elif self.path == DEV_LIMIT_BREAKER_PATH:
            user = self._require_auth()
            if not user:
                return
            self._set_limit_breaker(user)
        elif self.path == OCCUPIED_SET_PATH:
            if not self._require_auth():
                return
            self._occupied_set()
        elif self.path == OCCUPIED_SET_MANY_PATH:
            if not self._require_auth():
                return
            self._occupied_set_many()
        elif self.path == PALLET_HEIGHTS_PATH:
            if not self._require_auth():
                return
            self._pallet_heights_set()
        elif self.path == LOGIN_PATH:
            self._login()
        elif self.path == LOGOUT_PATH:
            self._logout()
        elif self.path == SESSION_THEME_PATH:
            user = self._require_auth()
            if not user:
                return
            self._set_own_theme(user)
        elif self.path == SESSION_FULLSCREEN_PATH:
            user = self._require_auth()
            if not user:
                return
            self._set_own_fullscreen(user)
        elif self.path == USERS_PATH:
            if not self._require_admin():
                return
            self._create_user()
        else:
            self.send_error(404, "Not Found")

    def do_PUT(self):
        if self.path.startswith(USERS_PATH + "/"):
            if not self._require_admin():
                return
            username = urllib.parse.unquote(self.path[len(USERS_PATH) + 1:])
            self._update_user(username)
        else:
            self.send_error(404, "Not Found")

    def do_DELETE(self):
        if self.path.startswith(USERS_PATH + "/"):
            admin = self._require_admin()
            if not admin:
                return
            username = urllib.parse.unquote(self.path[len(USERS_PATH) + 1:])
            if username == admin["username"]:
                self._relay(400, "application/json", '{"error":"n\\u00e3o d\\u00e1 pra excluir o pr\\u00f3prio usu\\u00e1rio logado"}'.encode("utf-8"))
                return
            self._delete_user(username)
        else:
            self.send_error(404, "Not Found")

    # --- autenticação --------------------------------------------------------
    def _get_session_cookie(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            return None
        morsel = jar.get(SESSION_COOKIE_NAME)
        return morsel.value if morsel else None

    def _get_authenticated_user(self):
        username = verify_session_token(self._get_session_cookie())
        if not username:
            return None
        with USERS_LOCK:
            users = _read_users()
        user = next((u for u in users if u["username"] == username), None)
        if not user:
            return None
        # theme/fullscreen viajam junto da sessão pro app já montar certo pro
        # usuário, sem piscar errado antes de buscar em outro lugar.
        return {"username": user["username"], "isAdmin": bool(user.get("isAdmin")), "isMaster": bool(user.get("isMaster")), "kanbanIds": _user_kanban_ids(user), "theme": _user_theme(user), "fullscreen": _user_fullscreen(user)}

    def _require_auth(self):
        user = self._get_authenticated_user()
        if not user:
            self._relay(401, "application/json", b'{"error":"n\xc3\xa3o autenticado"}')
            return None
        return user

    def _require_admin(self):
        user = self._require_auth()
        if user is None:
            return None
        if not user["isAdmin"]:
            self._relay(403, "application/json", b'{"error":"apenas admin"}')
            return None
        return user

    def _set_session_cookie_header(self, token, max_age):
        self.send_header(
            "Set-Cookie",
            "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (SESSION_COOKIE_NAME, token, max_age),
        )

    def _login(self):
        try:
            payload = self._read_json_body()
            username = payload["username"]
            password = payload["password"]
        except (json.JSONDecodeError, KeyError):
            self._relay(400, "application/json", b'{"error":"usu\xc3\xa1rio e senha obrigat\xc3\xb3rios"}')
            return
        with USERS_LOCK:
            users = _read_users()
            user = next((u for u in users if u["username"] == username), None)

            # Conta já bloqueada (3+ senhas erradas seguidas, ver
            # LOGIN_MAX_ATTEMPTS) — rejeita sem nem checar a senha, mesmo se
            # ela estiver certa dessa vez. Só um admin destrava (painel
            # "Usuários", cadeado ao lado do nome — ver UsersPanel.jsx).
            # Admin NUNCA bloqueia (pedido explícito do usuário) — o `and
            # not user.get("isAdmin")` aqui é defesa em profundidade (users.json
            # editado à mão poderia, em teoria, ter os dois campos
            # inconsistentes); o de baixo garante que isso nunca acontece
            # pelo fluxo normal.
            if user and user.get("locked") and not user.get("isAdmin"):
                msg = '{"error":"conta bloqueada após muitas tentativas erradas — peça pra um admin desbloquear"}'
                self._relay(423, "application/json", msg.encode("utf-8"))
                return

            if not user or not verify_password(password, user["passwordHash"]):
                if user:
                    user["failedAttempts"] = user.get("failedAttempts", 0) + 1
                    # Admin nunca é bloqueado, mesmo errando a senha várias
                    # vezes — perder acesso de admin por engano (ou ataque de
                    # força bruta deliberado) travaria a conta que resolveria
                    # o problema.
                    if user["failedAttempts"] >= LOGIN_MAX_ATTEMPTS and not user.get("isAdmin"):
                        user["locked"] = True
                    _write_users(users)
                self._relay(401, "application/json", b'{"error":"usu\xc3\xa1rio ou senha inv\xc3\xa1lidos"}')
                return

            if user.get("failedAttempts"):
                user["failedAttempts"] = 0
                _write_users(users)
        token = make_session_token(username)
        body = json.dumps({"ok": True, "username": username, "isAdmin": bool(user.get("isAdmin")), "isMaster": bool(user.get("isMaster")), "kanbanIds": _user_kanban_ids(user), "theme": _user_theme(user), "fullscreen": _user_fullscreen(user)}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._set_session_cookie_header(token, SESSION_MAX_AGE_SECONDS)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _logout(self):
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._set_session_cookie_header("", 0)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _get_session(self):
        user = self._get_authenticated_user()
        if not user:
            self._relay(401, "application/json", b'{"error":"n\xc3\xa3o autenticado"}')
            return
        self._relay(200, "application/json", json.dumps(user).encode("utf-8"))

    def _set_own_theme(self, requester):
        """Cada um muda só o PRÓPRIO tema — o usuário vem da sessão, nunca
        de um campo do payload, então não dá pra alterar a preferência de
        outra conta mandando outro nome."""
        try:
            payload = self._read_json_body()
            theme = payload["theme"]
            if theme not in VALID_THEMES:
                raise ValueError("tema precisa ser 'dark' ou 'light'")
        except (json.JSONDecodeError, KeyError, ValueError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        with USERS_LOCK:
            users = _read_users()
            user = next((u for u in users if u["username"] == requester["username"]), None)
            if not user:
                self._relay(404, "application/json", b'{"error":"usu\xc3\xa1rio n\xc3\xa3o encontrado"}')
                return
            user["theme"] = theme
            _write_users(users)
        self._relay(200, "application/json", b'{"ok":true}')

    def _set_own_fullscreen(self, requester):
        """Mesma ideia de _set_own_theme acima — cada um só muda a própria
        preferência de tela cheia, pela sessão."""
        try:
            payload = self._read_json_body()
            fullscreen = bool(payload["fullscreen"])
        except (json.JSONDecodeError, KeyError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        with USERS_LOCK:
            users = _read_users()
            user = next((u for u in users if u["username"] == requester["username"]), None)
            if not user:
                self._relay(404, "application/json", b'{"error":"usu\xc3\xa1rio n\xc3\xa3o encontrado"}')
                return
            user["fullscreen"] = fullscreen
            _write_users(users)
        self._relay(200, "application/json", b'{"ok":true}')

    # --- administração de usuários (admin only) -------------------------------
    def _get_users(self):
        with USERS_LOCK:
            users = _read_users()
        body = json.dumps(
            [{
                "username": u["username"],
                "isAdmin": bool(u.get("isAdmin")),
                "isMaster": bool(u.get("isMaster")),
                "kanbanIds": _user_kanban_ids(u),
                "locked": bool(u.get("locked")),
            } for u in users],
            ensure_ascii=False,
        ).encode("utf-8")
        self._relay(200, "application/json", body)

    def _create_user(self):
        try:
            payload = self._read_json_body()
            username = payload["username"].strip()
            password = payload["password"]
            is_admin = bool(payload.get("isAdmin", False))
            is_master = bool(payload.get("isMaster", False))
            kanban_ids = payload.get("kanbanIds") or []
            if not isinstance(kanban_ids, list):
                raise ValueError("kanbanIds precisa ser uma lista")
        except (json.JSONDecodeError, KeyError, AttributeError, ValueError) as err:
            self._relay(400, "application/json", ('{"error":"%s"}' % str(err)).encode("utf-8"))
            return
        if not username or not password:
            self._relay(400, "application/json", b'{"error":"usu\xc3\xa1rio e senha obrigat\xc3\xb3rios"}')
            return
        # Admin e Mestre nunca precisam de kanban (não têm restrição de
        # origem nenhuma) — um usuário COMUM precisa de pelo menos um,
        # senão não haveria como ele enviar/cancelar nada (pedido explícito
        # do usuário: restrição é escolha do admin, mas precisa ser
        # configurada JÁ na criação, não deixada "sem restrição" por
        # esquecimento).
        if not is_admin and not is_master and not kanban_ids:
            self._relay(400, "application/json", b'{"error":"usu\xc3\xa1rio comum precisa de pelo menos um kanban"}')
            return
        with USERS_LOCK:
            users = _read_users()
            if any(u["username"] == username for u in users):
                self._relay(409, "application/json", b'{"error":"usu\xc3\xa1rio j\xc3\xa1 existe"}')
                return
            users.append({
                "username": username,
                "passwordHash": hash_password(password),
                "isAdmin": is_admin,
                "isMaster": is_master,
                "kanbanIds": kanban_ids,
                "failedAttempts": 0,
                "locked": False,
                "theme": DEFAULT_THEME,
                "fullscreen": False,
            })
            _write_users(users)
        self._relay(200, "application/json", b'{"ok":true}')

    def _update_user(self, username):
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError as err:
            self._relay(400, "application/json", ('{"error":"%s"}' % str(err)).encode("utf-8"))
            return
        with USERS_LOCK:
            users = _read_users()
            user = next((u for u in users if u["username"] == username), None)
            if not user:
                self._relay(404, "application/json", b'{"error":"usu\xc3\xa1rio n\xc3\xa3o encontrado"}')
                return
            if payload.get("password"):
                user["passwordHash"] = hash_password(payload["password"])
            if "isAdmin" in payload:
                new_is_admin = bool(payload["isAdmin"])
                # trava de segurança: nunca deixar zero admins (senão ninguém
                # mais consegue entrar na tela de Usuários pra corrigir).
                if not new_is_admin and user.get("isAdmin"):
                    remaining = sum(1 for u in users if u.get("isAdmin") and u["username"] != username)
                    if remaining == 0:
                        self._relay(400, "application/json", b'{"error":"precisa sobrar pelo menos um admin"}')
                        return
                user["isAdmin"] = new_is_admin
                if new_is_admin:
                    # Admin nunca fica bloqueado (ver _login) — promover
                    # alguém que estava bloqueado precisa destravar junto,
                    # senão viraria um admin sem conseguir logar.
                    user["locked"] = False
                    user["failedAttempts"] = 0
            if "isMaster" in payload:
                user["isMaster"] = bool(payload["isMaster"])
            # Mesma trava de criação (ver _create_user): usuário COMUM
            # (nem admin, nem Mestre) precisa de pelo menos um kanban. Só
            # valida quando o payload de fato toca em algo que poderia
            # deixar essa combinação inválida — uma edição qualquer (ex:
            # só trocar senha) numa conta antiga sem kanban configurado
            # não é bloqueada à força por esta trava.
            if "kanbanIds" in payload:
                new_kanban_ids = payload["kanbanIds"]
                if not isinstance(new_kanban_ids, list):
                    self._relay(400, "application/json", b'{"error":"kanbanIds precisa ser uma lista"}')
                    return
                user["kanbanIds"] = new_kanban_ids
            if ("isAdmin" in payload or "isMaster" in payload or "kanbanIds" in payload) \
                    and not user.get("isAdmin") and not user.get("isMaster") and not _user_kanban_ids(user):
                self._relay(400, "application/json", b'{"error":"usu\xc3\xa1rio comum precisa de pelo menos um kanban"}')
                return
            if "locked" in payload:
                # Desbloquear (painel "Usuários", clique no cadeado) também
                # zera o contador — senão a próxima senha errada rebloquearia
                # com só 1 tentativa em vez das LOGIN_MAX_ATTEMPTS de novo.
                user["locked"] = bool(payload["locked"])
                if not user["locked"]:
                    user["failedAttempts"] = 0
            _write_users(users)
        self._relay(200, "application/json", b'{"ok":true}')

    def _delete_user(self, username):
        with USERS_LOCK:
            users = _read_users()
            user = next((u for u in users if u["username"] == username), None)
            if not user:
                self._relay(404, "application/json", b'{"error":"usu\xc3\xa1rio n\xc3\xa3o encontrado"}')
                return
            if user.get("isAdmin"):
                remaining = sum(1 for u in users if u.get("isAdmin") and u["username"] != username)
                if remaining == 0:
                    self._relay(400, "application/json", b'{"error":"precisa sobrar pelo menos um admin"}')
                    return
            users = [u for u in users if u["username"] != username]
            _write_users(users)
        self._relay(200, "application/json", b'{"ok":true}')

    # --- persistência da calibração (pontos avulsos + lotes, editor React) --
    def _get_calibration(self):
        with CALIBRATION_LOCK:
            payload = CALIBRATION_FILE.read_bytes() if CALIBRATION_FILE.exists() else EMPTY_CALIBRATION
        self._relay(200, "application/json", payload)

    # Kanbans (Close Ups da vista 'top') elegíveis pra restringir um
    # usuário (painel Usuários, dropdown "KANBANS") — exclui os "livres pra
    # todos" (FREE_KANBAN_IDS, ver acima). Só id+nome: o admin escolhe pelo
    # nome, mas tudo que persiste é o id (ver pedido do usuário — nome pode
    # ser renomeado depois sem quebrar quem já está restrito a ele).
    def _get_kanbans(self):
        with CALIBRATION_LOCK:
            cal = _read_calibration()
        kanbans = [
            {"id": c["id"], "name": c.get("name") or c["id"]}
            for c in cal["top"]["closeUps"]
            if c["id"] not in FREE_KANBAN_IDS
        ]
        self._relay(200, "application/json", json.dumps(kanbans, ensure_ascii=False).encode("utf-8"))

    def _save_calibration(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else EMPTY_CALIBRATION
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or "top" not in data or "iso" not in data:
                raise ValueError('payload precisa ser {"top":{"points":[...],"lots":[...]},"iso":{...}}')
        except (json.JSONDecodeError, ValueError) as err:
            payload = ('{"error":"%s"}' % str(err)).encode("utf-8")
            self._relay(400, "application/json", payload)
            return
        with CALIBRATION_LOCK:
            # Este endpoint é conceitualmente "salvar pontos/lotes" (editor
            # do modo desenvolvedor) — useCalibration.js, no cliente, nem
            # manda mais "occupied" no payload (ver CONTEXT.md, "Fila de
            # rotas compartilhada": ocupação virou mutação cirúrgica própria,
            # /api/occupied/*). SEMPRE preserva o occupied que já está em
            # disco aqui, em vez de confiar no que veio (ou não veio) no
            # payload — senão qualquer edição de ponto/lote apagaria a
            # ocupação ao vivo de todo mundo.
            current = _read_calibration()
            data["occupied"] = current.get("occupied") or []
            # palletHeights: mesmo raciocínio do occupied — mutação cirúrgica
            # própria (/api/pallet-heights), o cliente não manda no snapshot,
            # então preserva o que já está em disco.
            data["palletHeights"] = _pallet_heights(current)
            CALIBRATION_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self._relay(200, "application/json", b'{"ok":true}')

    # Altura do pallet azul (editor, modo desenvolvedor, sub-seção "Altura de
    # pallets"). Mutação cirúrgica só da chave palletHeights do
    # calibration.json — não reenvia pontos/lotes. blueBase = andar de baixo
    # (layer 2, "Altura do pallet azul padrão"); blueTop = 2º andar do pallet
    # de cima (layer 3, "Altura do segundo pallet"). Madeira não usa nada
    # disso (não empilha).
    def _pallet_heights_set(self):
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        with CALIBRATION_LOCK:
            cal = _read_calibration()
            heights = _pallet_heights(cal)  # começa do que já está salvo
            if "blueBase" in payload:
                heights["blueBase"] = _coerce_height(payload.get("blueBase"), heights["blueBase"])
            if "blueTop" in payload:
                heights["blueTop"] = _coerce_height(payload.get("blueTop"), heights["blueTop"])
            cal["palletHeights"] = heights
            CALIBRATION_FILE.write_text(json.dumps(cal, ensure_ascii=False, indent=2), encoding="utf-8")
        self._relay(200, "application/json", json.dumps({"ok": True, "palletHeights": heights}).encode("utf-8"))

    # --- histórico de rotas (painel "Histórico", modo desenvolvedor) --------
    # A gravação (log_route_requested/log_route_completed, lá em cima) não
    # é mais chamada por HTTP vindo do cliente — quem grava agora é o
    # próprio servidor, direto, ao disparar/concluir rotas (ver "Fila de
    # rotas compartilhada"). Só sobra a LEITURA aqui, pro painel Histórico.
    def _get_route_log(self):
        with ROUTE_LOG_LOCK:
            entries = _read_route_log()
        payload = json.dumps(entries, ensure_ascii=False).encode("utf-8")
        self._relay(200, "application/json", payload)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b"{}"
        return json.loads(body)

    # --- fila de rotas compartilhada (ver bloco "Fila de rotas
    # compartilhada" acima pra lógica de verdade — daqui só parse de
    # request/resposta HTTP) -------------------------------------------------
    def _get_live_state(self):
        with QUEUE_LOCK:
            state = _read_queue_state()
        with CALIBRATION_LOCK:
            cal = _read_calibration()
        body = json.dumps({
            "currentRoute": state.get("currentRoute"),
            "pendingRoute": state.get("pendingRoute"),
            "routeQueue": state.get("routeQueue") or [],
            "occupied": cal.get("occupied") or [],
            "emergency": bool(state.get("emergency")),
            "cancelPending": bool(state.get("cancelPending")),
            "cancelPendingMessage": CANCEL_PENDING_MESSAGE if state.get("cancelPending") else None,
            "turnBlocked": bool(state.get("turnBlocked")),
            "turnBlockedMessage": TURN_BLOCKED_START_MESSAGE if state.get("turnBlocked") else None,
            "awaitingCharge": bool(state.get("awaitingCharge")),
            "awaitingChargeMessage": AWAITING_CHARGE_MESSAGE if state.get("awaitingCharge") else None,
            "postPickupUnloadMessage": POST_PICKUP_UNLOAD_MESSAGE if (
                state.get("pendingPostPickupUnload") or (state.get("currentRoute") or {}).get("unloadOnly")
            ) else None,
            "robotCharging": _robot_status_cache.get("charging"),
            "robotBattery": _robot_status_cache.get("battery"),
            "robotReturningToCharge": bool(_robot_status_cache.get("returningToCharge")),
            "robotStalledMessage": _robot_stalled_message(state),
            "routePlanningMessage": _route_planning_message(state),
            "limitBreaker": _limit_breaker_active(),
            "robotCarrying": _robot_carrying(state),
            # Devolução do pallet decidida mas o UNLOAD ainda não criado no
            # robô (janela de ~1 tick): o mapa já desenha o caminho até ela.
            "pendingUnloadDropoff": (state.get("pendingPostPickupUnload") or {}).get("dropoff"),
        }, ensure_ascii=False).encode("utf-8")
        self._relay(200, "application/json", body)

    # Enfileira N pares origem→destino de uma vez (N=1 no modo normal, N>1
    # no modo "Lotes em sequência" — ver CONTEXT.md). É SEMPRE em lote, sem
    # caminho separado pro par único: a validação em cadeia com um passo só
    # é idêntica à validação antiga, então unificar sai de graça e evita
    # duas implementações da mesma regra divergindo com o tempo.
    def _queue_enqueue_batch(self, requester):
        try:
            payload = self._read_json_body()
            pairs = payload["pairs"]
            pallet_type = payload.get("palletType", "wood")
            pallet_top = bool(payload.get("palletTop", False))
            if not isinstance(pairs, list) or not pairs:
                raise ValueError("pairs precisa ser uma lista não vazia")
            for pair in pairs:
                if not isinstance(pair, dict) or "pickup" not in pair or "dropoff" not in pair:
                    raise ValueError("cada par precisa ter pickup e dropoff")
        except (json.JSONDecodeError, KeyError, ValueError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return

        with CALIBRATION_LOCK:
            cal = _read_calibration()

        # Restrição por kanban (ver "Kanbans" acima, pedido do usuário
        # 2026-10-01): GATE no servidor, não só feedback de UI — um usuário
        # restrito só pode PEGAR (origem) do(s) kanban(s) atribuído(s) a
        # ele (ou dos "livres pra todos"), mas pode ENTREGAR em qualquer
        # lugar sem restrição nenhuma.
        for pair in pairs:
            if not _user_can_pick_up_from(requester, pair["pickup"], cal):
                self._relay(403, "application/json", json.dumps(
                    {"error": "Sua conta não tem permissão pra retirar pallets de %s — fora do seu kanban." % pair["pickup"]},
                    ensure_ascii=False).encode("utf-8"))
                return

        # Caso 3 (fronteira/FIFO) como GATE FINAL, não só feedback do
        # cliente — e em cadeia, simulando a ocupação passo a passo (ver
        # validate_route_chain).
        error = validate_route_chain(cal["top"]["lots"], cal.get("occupied") or [], pairs)
        if error:
            self._relay(400, "application/json", json.dumps({"error": error}, ensure_ascii=False).encode("utf-8"))
            return

        # As alturas do pallet azul são capturadas AGORA (no enfileiramento) e
        # viajam junto de cada rota — igual a palletType/user. Se o admin
        # mudar a altura depois, rota que já está na fila mantém a que tinha
        # quando foi montada (ver CONTEXT.md, mesma lógica de palletType).
        heights = _pallet_heights(cal)

        # groupId só existe quando há sequência de verdade: com um par só
        # não há "resto do grupo" pra cancelar se ele falhar.
        #
        # "Tarefas aguardando envio" (ver CONTEXT.md): o botão "Iniciar
        # tarefas" manda a lista preparada inteira num envio só — precisa ser
        # um só pra validate_route_chain acima projetar a ocupação através de
        # TODAS elas (enviadas uma a uma, uma tarefa que depende de outra
        # anterior seria recusada). Mas a lista mistura tarefas avulsas e
        # grupos de "Lotes em sequência", cada um com seu pallet — então cada
        # par pode trazer `group` (chave de grupo do cliente, ou null pra
        # avulsa) e `palletType`/`palletTop` próprios. Sem `group` em nenhum
        # par, é o formato antigo: o lote inteiro vira um grupo só.
        if any("group" in pair for pair in pairs):
            client_groups = {}
            group_ids = []
            for pair in pairs:
                key = pair.get("group")
                if key is None:
                    group_ids.append(None)
                else:
                    if key not in client_groups:
                        client_groups[key] = secrets.token_hex(8)
                    group_ids.append(client_groups[key])
        else:
            legacy_group_id = secrets.token_hex(8) if len(pairs) > 1 else None
            group_ids = [legacy_group_id] * len(pairs)
        routes = [{
            "id": secrets.token_hex(8),
            "pickup": pair["pickup"],
            "dropoff": pair["dropoff"],
            "palletType": pair.get("palletType", pallet_type),
            "palletTop": bool(pair.get("palletTop", pallet_top)),
            "palletHeights": heights,
            "user": requester["username"],
            "groupId": group_ids[i],
        } for i, pair in enumerate(pairs)]
        # Dependências dentro DESTE envio (ver _batch_dependencies): se uma
        # rota for cancelada/falhar/sair da fila, as que dependiam dela caem
        # junto (_drop_dependents_from_queue). Só entre rotas do mesmo envio
        # — de propósito, é o que o operador montou junto.
        for route, dep_indexes in zip(routes, _batch_dependencies(cal["top"]["lots"], cal.get("occupied") or [], pairs)):
            if dep_indexes:
                route["dependsOn"] = [routes[i]["id"] for i in sorted(dep_indexes)]

        first_slot = None
        with QUEUE_LOCK:
            state = _read_queue_state()
            if state.get("emergency"):
                self._relay(409, "application/json", json.dumps(
                    {"error": "Parada de emergência ativa — libere o robô antes de enviar rotas."},
                    ensure_ascii=False).encode("utf-8"))
                return
            # Concorrência (ver _find_route_conflict acima): barra ANTES de
            # despachar qualquer rota do lote — uma checa, todas ficam de
            # fora, pra nunca despachar metade de uma sequência e rejeitar o
            # resto. Contra o estado da FILA (lido agora, sob o mesmo lock
            # que decide os slots logo abaixo — duas requisições concorrentes
            # disputam o QUEUE_LOCK, a segunda a entrar já vê a rota que a
            # primeira acabou de enfileirar).
            active_routes = _active_routes(state)
            for pair in pairs:
                conflicting_name, conflict = _find_route_conflict(pair["pickup"], pair["dropoff"], active_routes)
                if conflict:
                    who = conflict.get("user") or "outro operador"
                    msg = ("Não dá pra enviar %s → %s: %s já está reservado por outra rota em "
                           "andamento/fila (%s → %s, enviada por %s). Aguarde ela terminar ou "
                           "cancele-a antes.") % (
                        pair["pickup"], pair["dropoff"], conflicting_name,
                        conflict["pickup"], conflict["dropoff"], who,
                    )
                    self._relay(409, "application/json", json.dumps({"error": msg}, ensure_ascii=False).encode("utf-8"))
                    return
            # Enfileirar é SEMPRE local, sem chamada nenhuma ao robô (ver
            # "check-turn no início de tarefas" acima) — mesmo a rota que cai
            # no slot "current" só fica RESERVADA aqui (sem taskName); quem
            # dispara de verdade, gateado pelo check-turn, é
            # _try_dispatch_current logo abaixo, já fora do QUEUE_LOCK.
            for route in routes:
                if not state.get("currentRoute"):
                    state["currentRoute"] = route
                    # Fila estava REALMENTE vazia antes desta rota (ver
                    # _advance_queue_locked acima, onde promoções marcam
                    # False) — é o único caso onde uma AUTO_SYSTEM nativa
                    # pode já estar rodando há um tempo desconhecido, então
                    # é o único caso que precisa checar retorno pra energia
                    # em _try_dispatch_current.
                    state["currentRouteFresh"] = True
                    state["pickupCleared"] = False
                    slot = "current"
                elif not state.get("pendingRoute"):
                    state["pendingRoute"] = route
                    slot = "pending"
                else:
                    state["routeQueue"] = (state.get("routeQueue") or []) + [route]
                    slot = "queued"
                if first_slot is None:
                    first_slot = slot
            _write_queue_state(state)
        # Tenta disparar a currentRoute reservada AGORA (fora do lock) — no
        # caminho comum (giro seguro) isso mantém a resposta tão rápida
        # quanto antes; só demora de verdade quando o check-turn diz "ainda
        # não" (aí a próxima sondagem de fundo tenta de novo sozinha).
        _try_dispatch_current()
        # "slot" (o da PRIMEIRA rota) diz onde ela caiu — o cliente usa só
        # pra escolher a mensagem de feedback, não afeta nada no servidor.
        body = json.dumps({"ok": True, "slot": first_slot, "count": len(routes)}, ensure_ascii=False)
        self._relay(200, "application/json", body.encode("utf-8"))

    # Cancela SÓ a rota em andamento e deixa a fila seguir — a próxima rota
    # (pendingRoute/routeQueue, ainda RESERVADA — ver "check-turn no início
    # de tarefas" acima) assume o lugar dela. NÃO é mais uma parada de
    # emergência que derruba tudo.
    #
    # Se a currentRoute ainda nem tinha sido disparada de verdade (esperando
    # o check-turn liberar), cancela na hora, sem chamada nenhuma ao robô —
    # ver o primeiro `if` abaixo. Só a partir daqui (rota DE VERDADE em
    # andamento) que entra o cancelamento adiado até giro seguro (ver
    # CONTEXT.md, "Cancelamento adiado até giro seguro" — pedido explícito do
    # usuário, 2026-09-22): cancelar a rota EM ANDAMENTO enquanto o robô não
    # tem espaço pra girar podia deixá-lo travado (ROTATE_ERROR), exigindo
    # modo manual. Antes de cancelar de verdade, pergunta pro bridge
    # (`robot_can_turn_safely`, ver acima) "posso girar aqui?":
    #   - Sim (True) ou bridge indisponível (None, trata como "não sei",
    #     mantém o comportamento antigo em vez de travar por causa disso) →
    #     cancela na hora, como sempre foi.
    #   - Não (False) → NÃO cancela ainda. Marca `cancelPending`, devolve a
    #     mensagem de espera, e deixa a rota ATUAL rodando normalmente — a
    #     thread de fundo (`_queue_tick`) pergunta de novo a cada
    #     CANCEL_PENDING_POLL_INTERVAL_SECONDS e cancela sozinha assim que
    #     der, sem o operador precisar fazer nada além de esperar o aviso
    #     sumir da tela.
    # Liga/renova ou desliga a licença do limit breaker (ver
    # LIMIT_BREAKER_LEASE_SECONDS). Só admin. `on: true` repetido só empurra o
    # vencimento pra frente — o tablet chama isso a cada poucos segundos
    # enquanto o Doomguy está sorrindo.
    def _set_limit_breaker(self, requester):
        if not requester.get("isAdmin"):
            self._relay(403, "application/json", json.dumps({"error": "só admin"}, ensure_ascii=False).encode("utf-8"))
            return
        try:
            on = bool(self._read_json_body().get("on"))
        except json.JSONDecodeError:
            on = False
        was_active = _limit_breaker_active()
        if on:
            _limit_breaker["until"] = time.monotonic() + LIMIT_BREAKER_LEASE_SECONDS
            _limit_breaker["by"] = requester["username"]
            if not was_active:
                print("LIMIT BREAKER LIGADO por %s — sem travas de cancelamento/início de rota." % requester["username"])
        else:
            _limit_breaker["until"] = 0.0
            if was_active:
                print("LIMIT BREAKER desligado por %s." % requester["username"])
        self._relay(200, "application/json", json.dumps(
            {"ok": True, "active": on, "leaseSeconds": LIMIT_BREAKER_LEASE_SECONDS}).encode("utf-8"))

    def _queue_cancel_current(self, requester):
        # "Limit breaker" (botão do Doomguy, modo desenvolvedor — ver
        # CONTEXT.md): `force` pula TODO o tratamento de cancelamento seguro
        # (cancelamento adiado/check-turn e alinhamento de docking pré-pickup)
        # e cancela na hora. Vem POR REQUISIÇÃO e nunca é guardado aqui — de
        # propósito: não existe "modo ligado" no servidor que possa sobrar
        # depois de um reload/reinício. Só vale pra conta admin (o modo
        # desenvolvedor em si é só uma trava de UI, a senha fica no bundle).
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError:
            payload = {}
        force = (bool(payload.get("force")) and bool(requester.get("isAdmin"))) or _limit_breaker_active()
        # Limit breaker (e só ele — o modo desenvolvedor em si não muda como as
        # tarefas rodam): cancelar depois do pickup NÃO devolve o pallet à
        # origem. `force` já só vale pra admin ou licença ativa.
        skip_unload = force
        if force:
            print("LIMIT BREAKER: cancelamento forçado por %s (sem espera de giro seguro)." % requester["username"])
        # Lido ANTES do QUEUE_LOCK de propósito — CALIBRATION_LOCK e
        # QUEUE_LOCK nunca são aninhados neste código, pra nunca arriscar
        # ordem de lock trocada/deadlock com outro trecho.
        with CALIBRATION_LOCK:
            cal = _read_calibration()
        with QUEUE_LOCK:
            state = _read_queue_state()
            current = state.get("currentRoute")
            if not current:
                self._relay(200, "application/json", b'{"ok":true}')
                return
            # Restrição por kanban (ver "Kanbans" acima) — só se aplica
            # quando há uma origem de verdade (current["pickup"]); UNLOAD
            # isolado pós-cancelamento (pickup None) não tem origem pra
            # checar, e de qualquer forma não tem botão de cancelar normal
            # na UI (ver CONTEXT.md, "Cancelamento pós-pickup").
            if current.get("pickup") and not force and not _user_can_pick_up_from(requester, current["pickup"], cal):
                self._relay(403, "application/json", json.dumps(
                    {"error": "Sua conta não tem permissão pra cancelar uma rota com origem em %s — fora do seu kanban." % current["pickup"]},
                    ensure_ascii=False).encode("utf-8"))
                return
            if not current.get("taskName"):
                # RESERVADA, ainda esperando o check-turn liberar o disparo
                # (ver "check-turn no início de tarefas" acima) — nada rodando
                # no robô pra frear, então cancela na hora, sem chamada
                # nenhuma ao robô nem espera de cancelPending (essa espera só
                # faz sentido pra rota DE VERDADE em andamento).
                _cancel_reserved_current_locked(state, current)
                _write_queue_state(state)
                reserved_cancelled = True
            else:
                reserved_cancelled = False
                already_pending = bool(state.get("cancelPending"))
                pickup_cleared = bool(state.get("pickupCleared"))
        if reserved_cancelled:
            # A promoção pode já disparar a próxima na hora, se o giro
            # estiver seguro (mesma otimização do fim de rota normal).
            _try_dispatch_current()
            self._relay(200, "application/json", b'{"ok":true}')
            return
        if already_pending and not force:
            # clique repetido enquanto já está esperando — idempotente.
            self._relay(200, "application/json", json.dumps(
                {"ok": True, "pending": True, "message": CANCEL_PENDING_MESSAGE},
                ensure_ascii=False).encode("utf-8"))
            return

        # Chamada de rede FORA do lock (mesmo cuidado de _emergency_suppress/
        # _queue_tick) — não prende QUEUE_LOCK durante uma chamada que pode
        # ser lenta (timeout de rede até 3s, ver TURN_CHECK_TIMEOUT_SECONDS).
        # Confere de novo, fresco, se o pickup já terminou de verdade ANTES
        # de mandar qualquer cancelamento (ver CONTEXT.md, incidente
        # 2026-09-30 — a sondagem periódica pode ter perdido essa corrida).
        # ANTES do pickup usa o alinhamento de docking (mais confiável, ver
        # _current_route_cancel_ready acima); DEPOIS, o check-turn de sempre.
        pickup_cleared = _resolve_pickup_cleared_for_cancel(current, pickup_cleared)
        safe = True if force else _current_route_cancel_ready(current, pickup_cleared)

        with QUEUE_LOCK:
            state = _read_queue_state()
            current = state.get("currentRoute")
            if not current:
                # terminou por conta própria enquanto perguntávamos.
                self._relay(200, "application/json", b'{"ok":true}')
                return
            if skip_unload:
                state["skipPostPickupUnload"] = True
            # Propaga a checagem fresca acima pro estado que
            # _execute_cancel_current_locked vai ler daqui a pouco — ela
            # decide pré/pós-pickup direto de `state["pickupCleared"]`.
            if pickup_cleared:
                state["pickupCleared"] = True

            if safe is False:
                state["cancelPending"] = True
                _write_queue_state(state)
                # Acorda a thread de fundo AGORA (ver "Latência de até 4s no
                # cancelamento adiado" — incidente de campo 2026-09-30): sem
                # isso, a sondagem rápida só começa quando o sono atual da
                # thread terminar sozinho, até QUEUE_POLL_INTERVAL_SECONDS
                # (4s) de janela morta bem no início da corrida contra o
                # reconhecimento de câmera na docagem.
                _poke_queue_thread()
                self._relay(200, "application/json", json.dumps(
                    {"ok": True, "pending": True, "message": CANCEL_PENDING_MESSAGE},
                    ensure_ascii=False).encode("utf-8"))
                return

            # _robot_try_cancel (dentro de _execute_cancel_current_locked)
            # tolera a task já estar terminal (FAILED, CANCELLED, etc.) ou
            # nem existir. Só levanta em erro de verdade (robô fora do ar,
            # 5xx): aí não dá pra assumir que a task parou.
            try:
                _execute_cancel_current_locked(state, current)
            except Exception as err:
                self._relay(502, "application/json", json.dumps({"error": "Erro ao cancelar a rota atual: " + str(err)}, ensure_ascii=False).encode("utf-8"))
                return
            _write_queue_state(state)
        # Garfo de volta à altura de navegação (ver robot_fork_to_nav_height)
        # -- só quando quem liberou foi a regra do eixo do docking; forçado
        # (Limit Breaker) pode ter cancelado com o garfo dentro do lote.
        if not force and not _limit_breaker_active():
            robot_fork_to_nav_height("depois do cancelamento")
        # Pós-pickup (ver CONTEXT.md, "Cancelamento pós-pickup"): resolve já,
        # na mesma resposta, em vez de esperar o próximo tick — o pallet está
        # no garfo, quanto antes melhor. No caminho comum (sem pallet), é
        # idempotente/no-op e a promoção normal abaixo é quem dispara.
        _try_dispatch_post_pickup_unload()
        # A promoção pode já disparar a próxima na hora, se o giro
        # estiver seguro (mesma otimização do fim de rota normal).
        _try_dispatch_current()
        self._relay(200, "application/json", b'{"ok":true}')

    # Modo desenvolvedor (lixeira no painel Fila): zera TODA a fila e
    # cancela no robô tudo que já tinha sido despachado (rota em andamento e
    # próxima), mas SEM o tratamento robusto de cancelamento: não espera giro
    # seguro, não alinha em docking, não devolve pallet ao ponto de origem.
    # Só admin. Parada de emergência e ocupação ficam como estão.
    def _queue_clear_all(self, requester):
        if not requester.get("isAdmin"):
            self._relay(403, "application/json", json.dumps({"error": "só admin"}, ensure_ascii=False).encode("utf-8"))
            return
        with QUEUE_LOCK:
            state = _read_queue_state()
            routes = [r for r in [state.get("currentRoute"), state.get("pendingRoute")] + list(state.get("routeQueue") or []) if r]
            for route in routes:
                log_route_completed(route["id"], "cancelled")
            emergency = state.get("emergency")
            new_state = _empty_queue_state()
            new_state["emergency"] = emergency
            _write_queue_state(new_state)
        # Rede FORA do lock. Só rotas que de fato foram pro robô (taskName).
        failed = []
        for route in routes:
            if route.get("taskName"):
                try:
                    _robot_try_cancel(route["taskName"])
                except Exception as err:
                    failed.append(route["taskName"])
                    print("clear-all: não deu pra cancelar '%s' no robô: %s" % (route["taskName"], err))
        try:
            robot_stop_navigation()
        except Exception as err:
            print("clear-all: cancel_goal falhou: %s" % err)
        print("FILA LIMPA por %s (%d rota(s) descartada(s))." % (requester["username"], len(routes)))
        body = {"ok": True}
        if failed:
            body["warning"] = "Fila limpa, mas o robô não confirmou o cancelamento de: " + ", ".join(failed)
        self._relay(200, "application/json", json.dumps(body, ensure_ascii=False).encode("utf-8"))

    # Cancela uma rota que ainda NÃO está em andamento: pendingRoute ou uma da
    # routeQueue — nenhuma das duas chegou a ser disparada pro robô (ver
    # "check-turn no início de tarefas" acima), então as duas só somem do
    # estado local, sem chamada nenhuma ao robô. A currentRoute segue rodando
    # intacta. Se o slot de pending esvaziar e ainda houver fila, a próxima
    # sobe pra pending na hora (ainda RESERVADA — o robô nunca fica sem
    # "próxima" localmente, mesmo que ainda não tenha sido disparada).
    def _queue_remove_queued(self, requester):
        try:
            payload = self._read_json_body()
            route_id = payload["id"]
        except (json.JSONDecodeError, KeyError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        # Lido ANTES do QUEUE_LOCK de propósito — ver mesmo comentário em
        # _queue_cancel_current (nunca aninhar CALIBRATION_LOCK dentro de
        # QUEUE_LOCK).
        with CALIBRATION_LOCK:
            cal = _read_calibration()
        with QUEUE_LOCK:
            state = _read_queue_state()
            pending = state.get("pendingRoute")
            queue = state.get("routeQueue") or []

            is_pending = bool(pending and pending["id"] == route_id)
            target = pending if is_pending else next((r for r in queue if r["id"] == route_id), None)
            if target is None:
                # já saiu (outro operador removeu, ou já virou currentRoute) —
                # idempotente, não é erro.
                self._relay(200, "application/json", b'{"ok":true}')
                return

            # Restrição por kanban (ver "Kanbans" acima, pedido do usuário:
            # a mesma regra de cancelar vale pra remover da fila de espera).
            if target.get("pickup") and not _user_can_pick_up_from(requester, target["pickup"], cal):
                self._relay(403, "application/json", json.dumps(
                    {"error": "Sua conta não tem permissão pra remover uma rota com origem em %s — fora do seu kanban." % target["pickup"]},
                    ensure_ascii=False).encode("utf-8"))
                return

            if is_pending:
                log_route_completed(pending["id"], "cancelled")
                state["pendingRoute"] = None
            else:
                state["routeQueue"] = [r for r in queue if r["id"] != route_id]
            # Parte de uma sequência: cancela TODO o resto do grupo que ainda
            # não rodou. E as tarefas do mesmo envio que dependiam desta
            # (dependsOn, ver _batch_dependencies) caem junto. A currentRoute,
            # mesmo do mesmo grupo, não é tocada — ela é anterior, não depende
            # das seguintes.
            _drop_dependents_from_queue(state, target)

            # Esvaziou o pending mas ainda tem fila — a próxima sobe pra
            # pending (RESERVADA, sem taskName — só dispara quando virar
            # currentRoute de verdade).
            if not state.get("pendingRoute") and state.get("currentRoute"):
                q = state.get("routeQueue") or []
                if q:
                    state["pendingRoute"] = q[0]
                    state["routeQueue"] = q[1:]
            _write_queue_state(state)
        self._relay(200, "application/json", b'{"ok":true}')

    # Arrastar-e-soltar em "Próximas rotas" (pedido do usuário, 2026-10-05)
    # — reordena `routeQueue`, NUNCA `pendingRoute` (ela já está "reservada"
    # pro próximo disparo, igual a rota EM ANDAMENTO já é intocável — ver
    # CONTEXT.md). `taskId` identifica QUALQUER tarefa da unidade sendo
    # arrastada (uma rota avulsa, ou qualquer uma das pernas de um lote em
    # sequência — a unidade inteira se move junto, mesmo espírito do
    # StagedTasksPanel); `toIndex` é a posição de destino em nível de
    # UNIDADE (não de tarefa achatada), mesma indexação que o cliente já
    # usa pra montar a prévia do arrasto.
    def _queue_reorder(self, requester):
        try:
            payload = self._read_json_body()
            task_id = payload["taskId"]
            to_index = int(payload["toIndex"])
        except (json.JSONDecodeError, KeyError, ValueError, TypeError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        # Lido ANTES do QUEUE_LOCK de propósito — ver mesmo comentário em
        # _queue_cancel_current/_queue_remove_queued.
        with CALIBRATION_LOCK:
            cal = _read_calibration()
        with QUEUE_LOCK:
            state = _read_queue_state()
            pending = state.get("pendingRoute")
            if pending and pending.get("id") == task_id:
                self._relay(400, "application/json", json.dumps(
                    {"error": "Essa rota já está reservada como a próxima a rodar — não dá pra reordenar ela."},
                    ensure_ascii=False).encode("utf-8"))
                return
            queue = state.get("routeQueue") or []
            units = _group_queue_units(queue)
            from_index = next((i for i, u in enumerate(units) if any(r["id"] == task_id for r in u["routes"])), None)
            if from_index is None:
                # Já saiu da fila local por outro motivo nesse meio-tempo
                # (outro operador cancelou/removeu, ou já virou pendingRoute
                # sozinha) — idempotente, não é erro: devolve o estado atual
                # pro cliente conferir no próximo refresh.
                self._relay(200, "application/json", b'{"ok":true}')
                return
            unit = units[from_index]
            # Restrição por kanban (ver "Kanbans" acima) — vale pra TODAS as
            # pernas da unidade (nunca arrasta um grupo parcialmente fora do
            # kanban do usuário).
            for route in unit["routes"]:
                if route.get("pickup") and not _user_can_pick_up_from(requester, route["pickup"], cal):
                    self._relay(403, "application/json", json.dumps(
                        {"error": "Sua conta não tem permissão pra mover uma rota com origem em %s — fora do seu kanban." % route["pickup"]},
                        ensure_ascii=False).encode("utf-8"))
                    return
            units.pop(from_index)
            units.insert(max(0, min(to_index, len(units))), unit)
            new_queue = [route for u in units for route in u["routes"]]
            # Mesma validação de cadeia de ocupação do enfileiramento (ver
            # _queue_enqueue_batch) — reordenar não pode criar uma sequência
            # fisicamente impossível (ex: pegar num ponto que só ficaria
            # livre depois, na ordem nova).
            pairs = [{"pickup": r["pickup"], "dropoff": r["dropoff"]} for r in new_queue]
            error = validate_route_chain(cal["top"]["lots"], cal.get("occupied") or [], pairs)
            if error:
                self._relay(400, "application/json", json.dumps({"error": error}, ensure_ascii=False).encode("utf-8"))
                return
            state["routeQueue"] = new_queue
            _write_queue_state(state)
        self._relay(200, "application/json", b'{"ok":true}')

    # Parada de emergência — liga/desliga (`{"active": true|false}`).
    # LIGAR: cancela TUDO no robô (all-cancel) e esvazia a fila local; a
    #   thread de fundo passa a reprimir a task de carga a cada
    #   EMERGENCY_POLL_INTERVAL_SECONDS (ver _emergency_suppress) — é o que
    #   mantém o robô parado no lugar. Enfileirar rota fica bloqueado.
    # DESLIGAR: só apaga o flag; o robô volta ao normal sozinho (recria a
    #   task de carga e ninguém mais a cancela) e operadores podem enviar
    #   rota de novo.
    # Idempotente: pedir o estado em que já está é no-op (dois tablets
    #   clicando quase junto convergem, tudo sob QUEUE_LOCK).
    def _queue_emergency(self):
        try:
            payload = self._read_json_body()
            active = bool(payload["active"])
        except (json.JSONDecodeError, KeyError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        warnings = []
        with QUEUE_LOCK:
            state = _read_queue_state()
            already = bool(state.get("emergency"))
            if active and not already:
                # Best effort: tenta parar tudo AGORA (frear + esvaziar a
                # fila), mas mesmo que o robô recuse os comandos (engine
                # travada, 4xx/5xx), a emergência PRECISA engatar — a thread
                # de fundo segue martelando cancel_goal + all-cancel a cada
                # tick. NÃO engatar era um buraco real (bug 2026-09-11): robô
                # travado -> all-cancel 400 -> 502 -> flag nunca setada ->
                # botão de emergência não fazia NADA.
                try:
                    robot_stop_navigation()
                except Exception as err:
                    warnings.append("cancel_goal falhou: %s" % err)
                    print("Emergência: cancel_goal falhou: %s" % err)
                try:
                    robot_cancel_all_tasks()
                except Exception as err:
                    warnings.append("all-cancel falhou: %s" % err)
                    print("Emergência: all-cancel falhou (%s) — engatou mesmo assim." % err)
                for route in [state.get("currentRoute"), state.get("pendingRoute"), *(state.get("routeQueue") or [])]:
                    if route:
                        log_route_completed(route["id"], "cancelled")
                state["currentRoute"] = None
                state["pendingRoute"] = None
                state["routeQueue"] = []
                state["pickupCleared"] = False
                state["cancelPending"] = False
                state["turnBlocked"] = False
                state["awaitingCharge"] = False
                state["currentRouteFresh"] = False
                state["emergency"] = True
                _write_queue_state(state)
                _clear_fork_after_drop()
            elif not active and already:
                state["emergency"] = False
                _write_queue_state(state)
        body = {"ok": True, "emergency": active}
        if warnings:
            body["warning"] = " / ".join(warnings)
        self._relay(200, "application/json", json.dumps(body, ensure_ascii=False).encode("utf-8"))

    # --- ocupação (Caso 1, modo "mark") -------------------------------------
    def _occupied_set(self):
        try:
            payload = self._read_json_body()
            name = payload["name"]
            is_occupied = bool(payload["occupied"])
        except (json.JSONDecodeError, KeyError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        set_occupied_state(name, is_occupied)
        self._relay(200, "application/json", b'{"ok":true}')

    def _occupied_set_many(self):
        try:
            payload = self._read_json_body()
            names = payload["names"]
            is_occupied = bool(payload["occupied"])
            if not isinstance(names, list):
                raise ValueError("names precisa ser uma lista")
        except (json.JSONDecodeError, KeyError, ValueError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
        set_occupied_many(names, is_occupied)
        self._relay(200, "application/json", b'{"ok":true}')

    def _proxy(self, method):
        target = ROBOT_HOST + self.path
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(target, data=body, method=method)
        if body:
            req.add_header(
                "Content-Type", self.headers.get("Content-Type", "application/json")
            )

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                self._relay(resp.status, resp.headers.get("Content-Type"), resp.read())
        except urllib.error.HTTPError as err:
            # o dispatch service respondeu com um erro HTTP (400/500) — repassa como veio
            self._relay(err.code, "application/json", err.read())
        except Exception as err:  # rede indisponível, timeout, robô desligado, etc.
            _note_possible_ip_change(err)
            payload = ('{"code":4,"message":"Proxy: %s"}' % str(err)).encode("utf-8")
            self._relay(502, "application/json", payload)

    def _relay(self, status, content_type, payload):
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        # a pose do robô é sondada a ~1 Hz por tablet com o mapa aberto: não
        # vale uma linha de log cada (erros continuam aparecendo)
        if self.path == ROBOT_POSE_PATH and len(args) > 1 and str(args[1]) == "200":
            return
        print("[%s] %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    if not (Path(STATIC_DIR) / "index.html").exists():
        print(f"AVISO: {STATIC_DIR}/index.html não encontrado — rode 'npm run build' dentro de web/ antes.")
    start_server()
    print(f"Painel disponivel em      http://localhost:{LISTEN_PORT}")
    print(f"Proxy encaminhando {API_PREFIX} -> {ROBOT_HOST}{API_PREFIX}")
    print(f"Calibração persistida em  {CALIBRATION_FILE}")
    print(f"Histórico de rotas em     {ROUTE_LOG_FILE}")
    print(f"Usuários persistidos em   {USERS_FILE}")
    print(f"Fila de rotas em          {QUEUE_STATE_FILE}")
    try:
        while is_running():
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nEncerrando...")
        stop_server()
