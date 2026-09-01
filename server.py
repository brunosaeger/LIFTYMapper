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
    1. Edite ROBOT_HOST abaixo com o IP do robo no dia da demo.
    2. cd web && npm run build && cd ..   (gera web/dist)
    3. python3 server.py
    4. Abra http://localhost:8000 no navegador/tablet (mesma rede do robo).

Em desenvolvimento (npm run dev dentro de web/), o Vite serve o app na 5173
e encaminha /api pra este processo na 8000 (ver web/vite.config.js) — rode
os dois processos em paralelo.

Sem dependencias externas - só biblioteca padrão do Python 3.
"""
import base64
import functools
import hashlib
import hmac
import http.cookies
import http.server
import json
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path


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
ROBOT_HOST = "http://192.168.43.74/"
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

API_PREFIX = "/api/reeman-dispatch-service"
CALIBRATION_PATH = "/api/calibration"
# Sempre absoluto, nunca relativo ao diretório de trabalho do processo —
# SimpleHTTPRequestHandler resolve `directory=` relativo ao CWD em tempo de
# requisição, não ao arquivo deste script. Rodar `python3 server.py` de um
# CWD diferente da raiz do projeto (ex: de dentro de web/) com STATIC_DIR
# relativo fazia ele procurar em web/web/dist e servir 404 pra tudo,
# inclusive a própria index.html — bug real, já aconteceu.
STATIC_DIR = str(_bundle_dir() / "web" / "dist")
CALIBRATION_FILE = _app_dir() / "calibration.json"
EMPTY_CALIBRATION = b'{"top":{"points":[],"lots":[]},"iso":{"points":[],"lots":[]},"occupied":[]}'
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
        return json.loads(ROUTE_LOG_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def _write_route_log(entries):
    ROUTE_LOG_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2))


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

LIVE_STATE_PATH = "/api/live-state"
QUEUE_ENQUEUE_BATCH_PATH = "/api/queue/enqueue-batch"
QUEUE_CANCEL_CURRENT_PATH = "/api/queue/cancel-current"
QUEUE_REMOVE_QUEUED_PATH = "/api/queue/remove-queued"
QUEUE_EMERGENCY_PATH = "/api/queue/emergency"
OCCUPIED_SET_PATH = "/api/occupied/set"
OCCUPIED_SET_MANY_PATH = "/api/occupied/set-many"

# --- cliente do dispatch service do robô (porta de src/api/lifty.js) ------
# Antes, essas chamadas viviam no navegador (lifty.js) e passavam pelo
# proxy genérico. Agora que o SERVIDOR é quem orquestra a fila, ele fala
# com o robô direto (mesmo ROBOT_HOST/API_PREFIX do proxy, só que a partir
# do processo Python, não a partir de uma requisição de navegador repassada).
ROBOT_PROJECT_ID = "13"
ROBOT_TARGET_MAP = "eecc4a9068e11bd9086538383a38c67d"
ROBOT_SUPPORT_TYPES = ["犀牛2.0"]
# Ver CONTEXT.md, "Diferenciação de pallets": o campo height que fica no
# topo da ação PICKUP NÃO é o que a plataforma usa pra alinhar o pallet —
# fica sempre 0; o valor de verdade mora em params.PALLET_LAYER.
PICKUP_PALLET_LAYER = {"wood": None, "blue": {"height": 8, "layer": 2}}
PALLET_NAME_SUFFIX = {"wood": "", "blue": "MT"}


class RobotError(Exception):
    pass


def _robot_call(method, path, body=None):
    target = ROBOT_HOST + API_PREFIX + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(target, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as resp:
        parsed = json.loads(resp.read())
    if parsed.get("code") != 0:
        raise RobotError(parsed.get("message") or "erro desconhecido do robô")
    return parsed.get("data")


def robot_route_task_name(pickup, dropoff, pallet_type):
    return pickup + "to" + dropoff + PALLET_NAME_SUFFIX.get(pallet_type, "")


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
def robot_create_and_run_route(pickup, dropoff, pallet_type):
    name = robot_route_task_name(pickup, dropoff, pallet_type)
    template_id = robot_find_task_template_id(name)
    if not template_id:
        pallet_layer = PICKUP_PALLET_LAYER.get(pallet_type)
        task_action_list = [
            {
                "targetMap": ROBOT_TARGET_MAP, "targetArea": "", "targetPoint": pickup,
                "height": 0, "action": "PICKUP", "groupId": 1, "serialNumber": 1,
                "params": {"PALLET_LAYER": pallet_layer} if pallet_layer else None,
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
    if record and record.get("taskType") == "AUTO_SYSTEM" and record.get("status") not in ("FINISHED", "CANCELLED"):
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


def robot_fetch_action_records(task_record_id):
    return _robot_call("GET", "/action-record/list/" + str(task_record_id)) or []


# --- estado persistido da fila (queue_state.json) --------------------------
def _empty_queue_state():
    # Função (não constante compartilhada!) de propósito — um dict
    # constante no módulo teria a lista routeQueue=[] COMPARTILHADA entre
    # todo mundo que pedisse "o estado vazio", e um .append() em qualquer
    # chamador corromperia esse "vazio" pra sempre (mutable default clássico).
    return {"currentRoute": None, "pendingRoute": None, "routeQueue": [], "pickupCleared": False, "emergency": False}


def _read_queue_state():
    if not QUEUE_STATE_FILE.exists():
        return _empty_queue_state()
    try:
        data = json.loads(QUEUE_STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return _empty_queue_state()
    merged = _empty_queue_state()
    merged.update(data)
    return merged


def _write_queue_state(state):
    QUEUE_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


# --- calibração (leitura estruturada — só pro que este bloco precisa: lotes
# da vista "top" pra validar fronteira, e o array occupied) ----------------
def _read_calibration():
    if not CALIBRATION_FILE.exists():
        return json.loads(EMPTY_CALIBRATION)
    try:
        data = json.loads(CALIBRATION_FILE.read_text())
    except (json.JSONDecodeError, OSError):
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
    CALIBRATION_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))


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


# Tira do estado local as rotas que sobraram de um grupo cuja cadeia se
# quebrou (uma rota do meio cancelada/falhou) — as seguintes só eram
# fisicamente válidas PORQUE essa ia rodar antes, então deixá-las na fila
# faria o robô tentar pegar uma posição que continua bloqueada.
#
# A pendingRoute é caso especial: ela JÁ foi disparada pro dispatch de
# verdade, então tirar do estado local não basta — precisa cancelar no robô
# também (melhor esforço; se falhar, ela roda e provavelmente falha lá, mas
# nunca é pior do que deixar o estado local mentindo).
def _drop_group_from_queue(state, group_id):
    if not group_id:
        return
    pending = state.get("pendingRoute")
    if pending and pending.get("groupId") == group_id:
        try:
            record = robot_fetch_latest_task_record(pending["taskName"])
            if record and record.get("status") not in ("FINISHED", "CANCELLED"):
                robot_cancel_task_record(record["id"])
        except Exception as err:
            print("Aviso: não deu pra cancelar no robô a próxima rota do grupo interrompido: %s" % err)
        log_route_completed(pending["id"], "cancelled")
        state["pendingRoute"] = None
    # O resto do grupo que ainda estava só na fila LOCAL some sem mais nada:
    # essas nunca chegaram a ser disparadas pro robô, e o histórico só
    # registra rota a partir do disparo (ver log_route_requested, chamado de
    # dentro de _fire_route) — então não há entrada pra marcar como
    # cancelada, do mesmo jeito que já acontece ao remover uma da fila pelo X.
    state["routeQueue"] = [r for r in (state.get("routeQueue") or []) if r.get("groupId") != group_id]


# --- disparo/avanço da fila (chamado com QUEUE_LOCK já adquirido) ---------
# Dispara de verdade no robô e devolve a rota "disparada" (com taskName
# preenchido) — NÃO atualiza state[...] sozinho, quem chama decide se vira
# current ou pending. route["user"] (capturado no momento do ENFILEIRAMENTO,
# não relido depois) é quem aparece no histórico como requisitante, mesmo
# que o disparo de verdade só aconteça bem depois, promovido
# automaticamente pela thread de fundo — mais correto do que a versão
# antiga (cliente), onde o log ficava por conta de qual ABA estava rodando
# a sondagem no momento, meio ao acaso.
def _fire_route(route, as_pending):
    charge_task_id = None
    if not as_pending:
        # Mesmo raciocínio de fireRoute em MainApp.jsx: descobre a task de
        # carga ativa ANTES de disparar (se checasse depois, o registro
        # mais recente já seria o nosso, não o dela), dispara a rota nova
        # (fica pendente atrás da carga, fila nunca some a zero), e só
        # então cancela a carga — nunca all-cancel aqui.
        try:
            charge_task_id = robot_find_active_charge_task_id()
        except Exception:
            charge_task_id = None
    task_name = robot_create_and_run_route(route["pickup"], route["dropoff"], route.get("palletType", "wood"))
    if charge_task_id:
        try:
            robot_cancel_task_record(charge_task_id)
        except Exception:
            pass  # melhor esforço — a rota nova já foi disparada de qualquer jeito
    fired = dict(route)
    fired["taskName"] = task_name
    log_route_requested(route["id"], route["pickup"], route["dropoff"], task_name, route["user"])
    return fired


# Chamado com QUEUE_LOCK já adquirido, depois que a rota atual terminou de
# verdade (FINISHED) — porta de advanceQueue() em MainApp.jsx.
def _advance_queue_locked(state):
    pending = state.get("pendingRoute")
    if pending:
        state["currentRoute"] = pending
        state["pendingRoute"] = None
        state["pickupCleared"] = False
        queue = state.get("routeQueue") or []
        if queue:
            nxt = queue[0]
            try:
                state["pendingRoute"] = _fire_route(nxt, as_pending=True)
                state["routeQueue"] = queue[1:]
            except Exception as err:
                # não conseguiu pré-disparar a próxima — deixa na fila, tenta
                # de novo no próximo tick, em vez de perder a rota.
                print("Erro ao pré-disparar a próxima rota da fila: %s" % err)
        return

    queue = state.get("routeQueue") or []
    if not queue:
        state["currentRoute"] = None
        return
    nxt = queue[0]
    try:
        state["currentRoute"] = _fire_route(nxt, as_pending=False)
        state["pickupCleared"] = False
        state["routeQueue"] = queue[1:]
    except Exception as err:
        print("Erro ao disparar automaticamente a próxima rota da fila: %s" % err)
        state["currentRoute"] = None


# Aplica o status observado do robô pro currentRoute — usado tanto pelo tick
# normal (_queue_tick) quanto pela reconciliação na subida do servidor
# (_reconcile_queue_state_on_startup). Devolve True se mudou algo (precisa
# persistir).
def _apply_record_status(state, current, record):
    status = record.get("status")
    if status == "FINISHED":
        set_occupied_state(current["dropoff"], True)
        log_route_completed(current["id"], "finished")
        _advance_queue_locked(state)
        return True
    if status == "CANCELLED":
        # Cancelamento por FORA do app (ex: alguém mexeu direto na
        # plataforma admin do robô). Diferente do cancelamento pelo botão do
        # app (_queue_cancel_current), aqui NÃO se promove pendingRoute/
        # routeQueue de propósito: não sabemos o que o dispatch faz com a
        # pendingRoute quando a task ativa é cancelada por fora (pode ter
        # derrubado ela junto), e presumir que dá pra seguir já causou o bug
        # "robô para e volta pra energia" uma vez (ver CONTEXT.md). Se
        # sobrar um pendingRoute órfão, ele volta a fazer sentido no próximo
        # disparo pelo Ponto a Ponto.
        log_route_completed(current["id"], "cancelled")
        state["currentRoute"] = None
        # Se essa rota fazia parte de uma sequência, o resto do grupo perdeu
        # a validade junto com ela (decisão do usuário: cancelar o resto).
        _drop_group_from_queue(state, current.get("groupId"))
        return True
    return False  # ainda em execução — nada a fazer, tenta de novo no próximo tick


# Parada de emergência ATIVA: mantém o robô parado onde está. A gente não
# tem um comando de "hold" na API de dispatch — o que dá pra fazer é: assim
# que a lista de tasks do robô fica vazia, ele recria sozinho a task de
# carga (AUTO_SYSTEM) e volta a andar; então a cada tick (rápido, ver
# EMERGENCY_POLL_INTERVAL_SECONDS) a gente olha se surgiu QUALQUER task
# ativa e cancela tudo de novo. Em repouso é só 1 GET leve por tick; o
# cancel só dispara quando o robô recriou a carga. É MELHOR ESFORÇO, não
# fail-safe: se o servidor/rede cair, o robô volta pra carga sozinho (por
# isso o botão do tablet não substitui o E-stop físico).
def _emergency_suppress():
    try:
        records = robot_fetch_recent_task_records(size=5)
    except Exception:
        return  # robô/rede indisponível agora — tenta de novo no próximo tick
    active = [r for r in records if r.get("status") not in ("FINISHED", "CANCELLED")]
    if not active:
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
def _queue_tick():
    # Emergência tem precedência sobre tudo: a fila já foi esvaziada (ver
    # _queue_emergency), então aqui só se reprime a task de carga recriada.
    # _emergency_suppress só fala com o robô (não toca no estado), então roda
    # FORA do QUEUE_LOCK — senão uma chamada lenta ao robô (timeout 10s)
    # seguraria o lock e travaria os GET /api/live-state de todo mundo, e
    # agora isso acontece a cada 1,5s.
    with QUEUE_LOCK:
        emergency = bool(_read_queue_state().get("emergency"))
    if emergency:
        _emergency_suppress()
        return EMERGENCY_POLL_INTERVAL_SECONDS

    with QUEUE_LOCK:
        state = _read_queue_state()
        current = state.get("currentRoute")
        if not current:
            return QUEUE_POLL_INTERVAL_SECONDS
        try:
            record = robot_fetch_latest_task_record(current["taskName"])
        except Exception:
            return QUEUE_POLL_INTERVAL_SECONDS  # falha de rede pontual — tenta de novo no próximo tick
        if not record:
            return QUEUE_POLL_INTERVAL_SECONDS

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
        if not state.get("pickupCleared") and record.get("status") != "CANCELLED":
            try:
                actions = robot_fetch_action_records(record["id"])
                pickup_action = next((a for a in actions if a.get("serialNumber") == 1), None)
                if (pickup_action
                        and pickup_action.get("finishTime")
                        and pickup_action.get("status") != "CANCELLED"):
                    state["pickupCleared"] = True
                    set_occupied_state(current["pickup"], False)
            except Exception:
                pass  # melhor esforço — tenta de novo no próximo tick

        if _apply_record_status(state, current, record):
            _write_queue_state(state)
    return QUEUE_POLL_INTERVAL_SECONDS


def _reconcile_queue_state_on_startup():
    """Ao subir, não confia cegamente no que sobrou em queue_state.json —
    o robô pode ter terminado/cancelado a rota enquanto o processo estava
    fora do ar (ex: reinício pra trocar ROBOT_HOST). Confere contra o robô
    de verdade antes de aceitar o estado persistido como válido, evitando
    mostrar pra todo mundo um "em andamento" que já acabou faz tempo."""
    with QUEUE_LOCK:
        state = _read_queue_state()
        if state.get("emergency"):
            print("Parada de emergência estava ATIVA quando o servidor caiu — continua ativa, reprimindo a task de carga. Libere pelo botão no app quando for seguro.")
            return
        current = state.get("currentRoute")
        if not current:
            return
        try:
            record = robot_fetch_latest_task_record(current["taskName"])
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
# deixaria duas rodando (sondagem/promoção duplicada). `_queue_stop` é um
# Event; `wait(interval)` acorda cedo quando ele é setado, em vez de
# `time.sleep` que ignoraria o pedido de parada por até QUEUE_POLL segundos.
_queue_thread = None
_queue_stop = threading.Event()


def _start_queue_thread():
    global _queue_thread
    if _queue_thread is not None and _queue_thread.is_alive():
        return  # já rodando — idempotente
    _queue_stop.clear()

    def _loop():
        interval = QUEUE_POLL_INTERVAL_SECONDS
        while not _queue_stop.wait(interval):
            try:
                interval = _queue_tick() or QUEUE_POLL_INTERVAL_SECONDS
            except Exception as err:
                print("Erro inesperado na sondagem da fila: %s" % err)
                interval = QUEUE_POLL_INTERVAL_SECONDS

    _queue_thread = threading.Thread(target=_loop, daemon=True)
    _queue_thread.start()


def _stop_queue_thread():
    global _queue_thread
    _queue_stop.set()
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
        set_robot_host(robot_host)
    listen_port = port or LISTEN_PORT
    _bootstrap_users_if_missing()
    _reconcile_queue_state_on_startup()
    _start_queue_thread()
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
USERS_PATH = "/api/users"


def _load_or_create_session_secret():
    if SESSION_SECRET_FILE.exists():
        return bytes.fromhex(SESSION_SECRET_FILE.read_text().strip())
    secret = secrets.token_bytes(32)
    SESSION_SECRET_FILE.write_text(secret.hex())
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
        return json.loads(USERS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def _write_users(users):
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2))


# Preferência de tema por CONTA (não por dispositivo): o operador loga em
# qualquer tablet e encontra o tema dele, em vez de ter que trocar toda vez.
# Antes isso vivia só no localStorage do navegador, ou seja, morria a cada
# troca de aparelho.
DEFAULT_THEME = "dark"  # mesmo padrão do site (ver index.css/theme.js)
VALID_THEMES = ("dark", "light")


def _user_theme(user):
    theme = user.get("theme")
    return theme if theme in VALID_THEMES else DEFAULT_THEME


def _bootstrap_users_if_missing():
    """Primeiro boot sem users.json: cria um admin inicial com senha
    aleatória impressa no console uma única vez. Evita cravar uma senha
    padrão no código (ao contrário do DEV_PASSWORD do front, que é só uma
    trava de UI — login é a fronteira de verdade, então o segredo inicial
    nasce aleatório e só quem está olhando o terminal na hora do primeiro
    boot o conhece)."""
    if USERS_FILE.exists():
        return
    default_password = secrets.token_urlsafe(9)
    _write_users([
        {"username": "admin", "passwordHash": hash_password(default_password), "isAdmin": True},
    ])
    print("=" * 70)
    print("Nenhum users.json encontrado — usuário inicial criado:")
    print("  usuário: admin")
    print("  senha:   " + default_password)
    print("Anote agora e troque depois pela tela de Usuários (modo admin).")
    print("=" * 70)


class Handler(http.server.SimpleHTTPRequestHandler):
    # Arquivos estáticos (index.html, bundle JS/CSS, imagens) continuam
    # públicos de propósito: é o SPA React que decide mostrar a tela de
    # login ou não, então ele precisa carregar SEM sessão pra poder mostrar
    # essa tela em primeiro lugar. Tudo que é dado/ação de verdade (proxy do
    # robô, calibração, histórico, usuários) fica atrás de _require_auth/
    # _require_admin abaixo.
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
        elif self.path == SESSION_PATH:
            self._get_session()
        elif self.path == USERS_PATH:
            if not self._require_admin():
                return
            self._get_users()
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
            if not self._require_auth():
                return
            self._queue_cancel_current()
        elif self.path == QUEUE_REMOVE_QUEUED_PATH:
            if not self._require_auth():
                return
            self._queue_remove_queued()
        elif self.path == QUEUE_EMERGENCY_PATH:
            if not self._require_auth():
                return
            self._queue_emergency()
        elif self.path == OCCUPIED_SET_PATH:
            if not self._require_auth():
                return
            self._occupied_set()
        elif self.path == OCCUPIED_SET_MANY_PATH:
            if not self._require_auth():
                return
            self._occupied_set_many()
        elif self.path == LOGIN_PATH:
            self._login()
        elif self.path == LOGOUT_PATH:
            self._logout()
        elif self.path == SESSION_THEME_PATH:
            user = self._require_auth()
            if not user:
                return
            self._set_own_theme(user)
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
        # theme viaja junto da sessão pro app já montar no tema certo do
        # usuário, sem piscar no tema errado antes de buscar em outro lugar.
        return {"username": user["username"], "isAdmin": bool(user.get("isAdmin")), "theme": _user_theme(user)}

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
        body = json.dumps({"ok": True, "username": username, "isAdmin": bool(user.get("isAdmin")), "theme": _user_theme(user)}).encode("utf-8")
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

    # --- administração de usuários (admin only) -------------------------------
    def _get_users(self):
        with USERS_LOCK:
            users = _read_users()
        body = json.dumps(
            [{"username": u["username"], "isAdmin": bool(u.get("isAdmin")), "locked": bool(u.get("locked"))} for u in users],
            ensure_ascii=False,
        ).encode("utf-8")
        self._relay(200, "application/json", body)

    def _create_user(self):
        try:
            payload = self._read_json_body()
            username = payload["username"].strip()
            password = payload["password"]
            is_admin = bool(payload.get("isAdmin", False))
        except (json.JSONDecodeError, KeyError, AttributeError) as err:
            self._relay(400, "application/json", ('{"error":"%s"}' % str(err)).encode("utf-8"))
            return
        if not username or not password:
            self._relay(400, "application/json", b'{"error":"usu\xc3\xa1rio e senha obrigat\xc3\xb3rios"}')
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
                "failedAttempts": 0,
                "locked": False,
                "theme": DEFAULT_THEME,
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
            CALIBRATION_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        self._relay(200, "application/json", b'{"ok":true}')

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
            if not isinstance(pairs, list) or not pairs:
                raise ValueError("pairs precisa ser uma lista não vazia")
            for pair in pairs:
                if not isinstance(pair, dict) or "pickup" not in pair or "dropoff" not in pair:
                    raise ValueError("cada par precisa ter pickup e dropoff")
        except (json.JSONDecodeError, KeyError, ValueError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return

        # Caso 3 (fronteira/FIFO) como GATE FINAL, não só feedback do
        # cliente — e em cadeia, simulando a ocupação passo a passo (ver
        # validate_route_chain).
        with CALIBRATION_LOCK:
            cal = _read_calibration()
        error = validate_route_chain(cal["top"]["lots"], cal.get("occupied") or [], pairs)
        if error:
            self._relay(400, "application/json", json.dumps({"error": error}, ensure_ascii=False).encode("utf-8"))
            return

        # groupId só existe quando há sequência de verdade: com um par só
        # não há "resto do grupo" pra cancelar se ele falhar.
        group_id = secrets.token_hex(8) if len(pairs) > 1 else None
        routes = [{
            "id": secrets.token_hex(8),
            "pickup": pair["pickup"],
            "dropoff": pair["dropoff"],
            "palletType": pallet_type,
            "user": requester["username"],
            "groupId": group_id,
        } for pair in pairs]

        first_slot = None
        with QUEUE_LOCK:
            state = _read_queue_state()
            if state.get("emergency"):
                self._relay(409, "application/json", json.dumps(
                    {"error": "Parada de emergência ativa — libere o robô antes de enviar rotas."},
                    ensure_ascii=False).encode("utf-8"))
                return
            for route in routes:
                try:
                    if not state.get("currentRoute"):
                        state["currentRoute"] = _fire_route(route, as_pending=False)
                        state["pickupCleared"] = False
                        slot = "current"
                    elif not state.get("pendingRoute"):
                        state["pendingRoute"] = _fire_route(route, as_pending=True)
                        slot = "pending"
                    else:
                        state["routeQueue"] = (state.get("routeQueue") or []) + [route]
                        slot = "queued"
                except Exception as err:
                    # As rotas anteriores do lote JÁ foram pro robô — persiste
                    # o que deu certo antes de reportar, senão o estado local
                    # mentiria sobre o que o dispatch já recebeu.
                    _write_queue_state(state)
                    msg = "Erro ao enviar rota %s → %s: %s" % (route["pickup"], route["dropoff"], err)
                    self._relay(502, "application/json", json.dumps({"error": msg}, ensure_ascii=False).encode("utf-8"))
                    return
                if first_slot is None:
                    first_slot = slot
            _write_queue_state(state)
        # "slot" (o da PRIMEIRA rota) diz onde ela caiu — o cliente usa só
        # pra escolher a mensagem de feedback, não afeta nada no servidor.
        body = json.dumps({"ok": True, "slot": first_slot, "count": len(routes)}, ensure_ascii=False)
        self._relay(200, "application/json", body.encode("utf-8"))

    # Cancela SÓ a rota em andamento e deixa a fila seguir — a próxima rota
    # (pendingRoute, que já foi disparada pro dispatch como "próxima") assume
    # o lugar dela. NÃO é mais uma parada de emergência que derruba tudo.
    #
    # Por que não some a task de carga no meio: o dispatch já tem a
    # pendingRoute na fila dele, então cancelar a atual por id nunca deixa a
    # lista do robô vazia — e a task AUTO_SYSTEM de carga só nasce quando ela
    # zera. Ainda assim, como defesa contra um piscar de "sem task", se
    # sobra o que rodar a gente procura e mata uma carga que porventura tenha
    # aparecido, ANTES de promover (mesmo cuidado do _fire_route no disparo a
    # partir de ocioso).
    def _queue_cancel_current(self):
        with QUEUE_LOCK:
            state = _read_queue_state()
            current = state.get("currentRoute")
            if not current:
                self._relay(200, "application/json", b'{"ok":true}')
                return
            try:
                record = robot_fetch_latest_task_record(current["taskName"])
                if record and record.get("status") not in ("FINISHED", "CANCELLED"):
                    robot_cancel_task_record(record["id"])
            except Exception as err:
                self._relay(502, "application/json", json.dumps({"error": "Erro ao cancelar a rota atual: " + str(err)}, ensure_ascii=False).encode("utf-8"))
                return

            log_route_completed(current["id"], "cancelled")
            state["currentRoute"] = None
            state["pickupCleared"] = False

            # Sequência ("Lotes em sequência"): o resto do grupo assumia que
            # esta rota rodaria antes (ocupação projetada), então cai junto —
            # inclusive cancelando no robô a pendingRoute do grupo. Rotas
            # INDEPENDENTES na fila não são tocadas.
            _drop_group_from_queue(state, current.get("groupId"))

            if state.get("pendingRoute") or state.get("routeQueue"):
                try:
                    charge_id = robot_find_active_charge_task_id()
                    if charge_id:
                        robot_cancel_task_record(charge_id)
                except Exception:
                    pass  # melhor esforço

            # Promove pendingRoute -> currentRoute (o dispatch já a pôs pra
            # rodar) e pré-dispara a próxima da fila como nova pendingRoute —
            # exatamente o mesmo caminho do término normal (FINISHED).
            _advance_queue_locked(state)
            _write_queue_state(state)
        self._relay(200, "application/json", b'{"ok":true}')

    # Cancela uma rota que ainda NÃO está em andamento: ou a pendingRoute (já
    # disparada pro robô como "próxima" — cancelada por id) ou uma da
    # routeQueue (nunca foi pro robô — some do estado local). A currentRoute
    # segue rodando intacta. Se o slot de pending esvaziar e ainda houver
    # fila, a próxima é pré-disparada pra pending na hora (o robô nunca fica
    # sem "próxima").
    def _queue_remove_queued(self):
        try:
            payload = self._read_json_body()
            route_id = payload["id"]
        except (json.JSONDecodeError, KeyError) as err:
            self._relay(400, "application/json", json.dumps({"error": str(err)}, ensure_ascii=False).encode("utf-8"))
            return
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

            group_id = target.get("groupId")
            if group_id:
                # Parte de uma sequência: cancela TODO o resto do grupo que
                # ainda não rodou (pendingRoute do grupo cancelada no robô +
                # membros da fila local sumindo). A currentRoute, mesmo do
                # mesmo grupo, não é tocada — ela é anterior, não depende das
                # seguintes.
                _drop_group_from_queue(state, group_id)
            elif is_pending:
                try:
                    record = robot_fetch_latest_task_record(pending["taskName"])
                    if record and record.get("status") not in ("FINISHED", "CANCELLED"):
                        robot_cancel_task_record(record["id"])
                except Exception as err:
                    self._relay(502, "application/json", json.dumps({"error": "Erro ao cancelar a próxima rota: " + str(err)}, ensure_ascii=False).encode("utf-8"))
                    return
                log_route_completed(pending["id"], "cancelled")
                state["pendingRoute"] = None
            else:
                state["routeQueue"] = [r for r in queue if r["id"] != route_id]

            # Esvaziou o pending mas ainda tem fila e uma rota em andamento —
            # pré-dispara a próxima pra pending (o robô continua com a
            # currentRoute, nunca fica vazio, então sem risco de task de carga).
            if not state.get("pendingRoute") and state.get("currentRoute"):
                q = state.get("routeQueue") or []
                if q:
                    try:
                        state["pendingRoute"] = _fire_route(q[0], as_pending=True)
                        state["routeQueue"] = q[1:]
                    except Exception as err:
                        print("Erro ao pré-disparar a próxima rota após remoção da fila: %s" % err)
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
        with QUEUE_LOCK:
            state = _read_queue_state()
            already = bool(state.get("emergency"))
            if active and not already:
                try:
                    robot_cancel_all_tasks()
                except Exception as err:
                    self._relay(502, "application/json", json.dumps(
                        {"error": "Erro ao parar o robô: " + str(err)}, ensure_ascii=False).encode("utf-8"))
                    return
                for route in [state.get("currentRoute"), state.get("pendingRoute"), *(state.get("routeQueue") or [])]:
                    if route:
                        log_route_completed(route["id"], "cancelled")
                state["currentRoute"] = None
                state["pendingRoute"] = None
                state["routeQueue"] = []
                state["pickupCleared"] = False
                state["emergency"] = True
                _write_queue_state(state)
            elif not active and already:
                state["emergency"] = False
                _write_queue_state(state)
        self._relay(200, "application/json", json.dumps({"ok": True, "emergency": active}).encode("utf-8"))

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
            payload = ('{"code":4,"message":"Proxy: %s"}' % str(err)).encode("utf-8")
            self._relay(502, "application/json", payload)

    def _relay(self, status, content_type, payload):
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
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
