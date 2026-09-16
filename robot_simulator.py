#!/usr/bin/env python3
"""Simulador do dispatch service do robô REEMAN (rbot55f / Hercules 3.0).

Existe pra testar o painel (server.py + web/) SEM o robô físico ligado —
por exemplo em casa, numa rede que não alcança o robô no galpão. Implementa
a mesma API que `server.py` chama em `ROBOT_HOST` (ver CONTEXT.md, seção "A
API do dispatch service"): task-template, task-record, action-record,
error/records, e os dois endpoints "SLAM" usados à parte
(`/reeman/base_encode` pro status de carga, `/cmd/cancel_goal` pra
navegação) — o bastante pra `server.py` achar que está falando com um robô
de verdade.

O que ele simula:
- Fila FIFO de 1 task ativa por vez (mesma regra do dispatch real: mesma
  prioridade = quem chegou primeiro roda, o resto espera "pendente").
- Status fica em WAITING enquanto espera/roda e pula direto pra FINISHED
  (nunca inventa um status de "em execução" — o dispatch real também nunca
  mostrou esse texto, ver CONTEXT.md).
- Ações (PICKUP/UNLOAD) recebem `finishTime` conforme o tempo simulado avança
  (ACTION_DURATION_SECONDS por ação) — é o sinal que a marcação automática
  de ocupação usa.
- Cancelar uma task já terminal responde HTTP 400 (o dispatch real faz
  isso); cancelar uma ativa/pendente responde 200 e libera a próxima da
  fila.
- Quando a fila fica vazia, depois de um tempinho ocioso ele cria sozinho
  uma task AUTO_SYSTEM (volta pra carga) — o comportamento que motivou o
  "handoff" em server.py (fires a próxima rota como pendente ANTES de
  cancelar a carga, pra fila nunca ficar vazia de verdade). Dá pra desligar
  com SIMULATE_AUTO_CHARGE = False lá embaixo.
- `/reeman/base_encode.chargeFlag` vira 2 (carregando) quando o robô tá
  ocioso/na carga, e outra coisa quando tá rodando uma rota — pra testar o
  banner "Em Operação" / "Recarregando".

Uso:
    python3 robot_simulator.py [porta]      # default 8080

Depois aponte o ROBOT_HOST do server.py (ou o campo de IP do robô na tela
de configuração do .exe empacotado) pra este processo:
    - server.py e simulador na MESMA máquina (caso normal, testando em
      casa sozinho): http://127.0.0.1:8080/
    - máquinas diferentes na mesma rede (ex: notebook rodando o simulador,
      celular/tablet acessando o app): use o IP que este script imprime ao
      iniciar.

Sem dependências externas — só biblioteca padrão do Python 3, mesmo padrão
de `server.py`.
"""
import http.server
import json
import math
import re
import socket
import sys
import threading
import time
import urllib.parse
from datetime import datetime

API_PREFIX = "/api/reeman-dispatch-service"

# Segundos que cada ação (PICKUP/UNLOAD) leva pra terminar depois que a task
# vira "ativa" (cabeça da fila) — simula o robô dirigindo até o ponto. Baixo
# de propósito pra testar rápido; suba se quiser algo mais realista.
ACTION_DURATION_SECONDS = 5

# Se True, quando a fila fica vazia o robô cria sozinho uma task AUTO_SYSTEM
# (volta pra carga) depois de alguns segundos ocioso — ver docstring acima.
SIMULATE_AUTO_CHARGE = True
AUTO_CHARGE_IDLE_SECONDS = 3

TERMINAL_STATUSES = {"FINISHED", "CANCELLED", "FAILED"}

LOCK = threading.RLock()

STATE = {
    "next_id": 1000,
    "templates": {},   # id -> template dict
    "records": {},     # id -> task-record dict
    "actions": {},      # task_record_id -> [action dicts] (ordem = serialNumber)
    "fifo": [],          # ids de task-record em ordem; fifo[0] = ativa agora
    "idle_since": None,  # timestamp (epoch) desde quando fifo está vazia, ou None
}


def _now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _new_id():
    STATE["next_id"] += 1
    return STATE["next_id"]


def _ok(data=None, message="success"):
    return 200, {"code": 0, "message": message, "data": data}


def _err(message, status=200, code=1):
    return status, {"code": code, "message": message, "data": None}


def _paginate(items, page, size):
    page = max(1, page)
    size = max(1, size)
    total = len(items)
    start = (page - 1) * size
    records = items[start:start + size]
    return {
        "records": records,
        "total": total,
        "size": size,
        "current": page,
        "pages": max(1, math.ceil(total / size)) if total else 0,
    }


# --- ciclo de vida das tasks (thread de fundo) ------------------------------
def _cancel_record_locked(record, cancelled_status="CANCELLED"):
    now = _now_iso()
    record["status"] = cancelled_status
    record["finishTime"] = now
    # Mesma peculiaridade do robô real (ver CONTEXT.md "Bug real... cancelar
    # a rota apagava o X da origem"): finishTime da AÇÃO também é carimbado
    # no cancelamento, não só na conclusão.
    for action in STATE["actions"].get(record["id"], []):
        if action["finishTime"] is None:
            action["finishTime"] = now
            action["status"] = "CANCELLED"
    if record["id"] in STATE["fifo"]:
        STATE["fifo"].remove(record["id"])


def _tick():
    while True:
        time.sleep(1)
        with LOCK:
            fifo = STATE["fifo"]
            if not fifo:
                if STATE["idle_since"] is None:
                    STATE["idle_since"] = time.time()
                elif (
                    SIMULATE_AUTO_CHARGE
                    and time.time() - STATE["idle_since"] >= AUTO_CHARGE_IDLE_SECONDS
                ):
                    rid = _new_id()
                    STATE["records"][rid] = {
                        "id": rid,
                        "name": "AUTO_CHARGE",
                        "projectId": "13",
                        "taskType": "AUTO_SYSTEM",
                        "status": "WAITING",
                        "createTime": _now_iso(),
                        "startTime": _now_iso(),
                        "finishTime": None,
                    }
                    STATE["actions"][rid] = []
                    fifo.append(rid)
                    STATE["idle_since"] = None
                continue

            STATE["idle_since"] = None
            head_id = fifo[0]
            record = STATE["records"][head_id]
            if record["taskType"] == "AUTO_SYSTEM":
                continue  # fica "carregando" até ser preemptada/cancelada

            if record["startTime"] is None:
                record["startTime"] = _now_iso()
                record["_start_epoch"] = time.time()
            elapsed = time.time() - record["_start_epoch"]

            actions = sorted(STATE["actions"].get(head_id, []), key=lambda a: a["serialNumber"])
            for i, action in enumerate(actions):
                threshold = (i + 1) * ACTION_DURATION_SECONDS
                if elapsed >= threshold and action["finishTime"] is None:
                    if action["startTime"] is None:
                        action["startTime"] = _now_iso()
                    action["finishTime"] = _now_iso()

            if actions and all(a["finishTime"] is not None for a in actions):
                record["status"] = "FINISHED"
                record["finishTime"] = _now_iso()
                fifo.pop(0)


# --- handlers de endpoint ----------------------------------------------------
def h_template_create(body, _query, _match):
    name = (body or {}).get("name") or ""
    project_id = (body or {}).get("projectId") or "13"
    with LOCK:
        dup = next(
            (t for t in STATE["templates"].values() if t["name"] == name and t["projectId"] == project_id),
            None,
        )
        if dup:
            return _err("任务模版名称已存在", code=1)
        tid = _new_id()
        template = {
            "id": tid,
            "name": name,
            "description": (body or {}).get("description") or "",
            "supportRobotTypes": (body or {}).get("supportRobotTypes") or [],
            "projectId": project_id,
            "taskActionList": (body or {}).get("taskActionList") or [],
        }
        STATE["templates"][tid] = template
        return _ok(dict(template))


def h_template_page(_body, query, _match):
    project_id = query.get("projectId", [""])[0]
    name = query.get("name", [""])[0]
    page = int(query.get("page", ["1"])[0] or 1)
    size = int(query.get("size", ["10"])[0] or 10)
    with LOCK:
        items = [
            dict(t) for t in STATE["templates"].values()
            if t["projectId"] == project_id and (not name or name in t["name"])
        ]
    items.sort(key=lambda t: t["id"])
    return _ok(_paginate(items, page, size))


def h_task_fast(_body, _query, match):
    template_id = int(match.group(1))
    with LOCK:
        template = STATE["templates"].get(template_id)
        if not template:
            return _err("template não encontrado", status=404, code=1)
        rid = _new_id()
        STATE["records"][rid] = {
            "id": rid,
            "name": template["name"],
            "projectId": template["projectId"],
            "taskType": "FAST",
            "status": "WAITING",
            "createTime": _now_iso(),
            "startTime": None,
            "finishTime": None,
            "templateId": template_id,
        }
        STATE["actions"][rid] = [
            {
                "id": _new_id(),
                "taskRecordId": rid,
                "serialNumber": a.get("serialNumber"),
                "action": a.get("action"),
                "targetPoint": a.get("targetPoint"),
                "status": None,
                "startTime": None,
                "finishTime": None,
            }
            for a in template["taskActionList"]
        ]
        STATE["fifo"].append(rid)
    # a API real não devolve taskRecordId nessa chamada (ver CONTEXT.md)
    return _ok(None)


def h_task_record_page(_body, query, _match):
    project_id = query.get("projectId", [""])[0]
    status = query.get("status", [""])[0]
    name = query.get("name", [""])[0]
    page = int(query.get("page", ["1"])[0] or 1)
    size = int(query.get("size", ["10"])[0] or 10)
    with LOCK:
        items = [
            {k: v for k, v in r.items() if not k.startswith("_")}
            for r in STATE["records"].values()
            if r["projectId"] == project_id
            and (not status or r["status"].upper() == status.upper())
            and (not name or r["name"] == name)
        ]
    items.sort(key=lambda r: r["id"], reverse=True)  # mais recente primeiro
    return _ok(_paginate(items, page, size))


def h_task_record_cancel(_body, _query, match):
    rid = int(match.group(1))
    with LOCK:
        record = STATE["records"].get(rid)
        if not record:
            return _err("task-record não encontrada", status=404, code=1)
        if record["status"] in TERMINAL_STATUSES:
            return _err("task já está terminal", status=400, code=1)
        _cancel_record_locked(record)
        return _ok(None)


def h_task_record_all_cancel(_body, _query, match):
    project_id = match.group(1)
    with LOCK:
        for record in STATE["records"].values():
            if record["projectId"] == project_id and record["status"] not in TERMINAL_STATUSES:
                _cancel_record_locked(record)
        return _ok(None)


def h_action_record_list(_body, _query, match):
    rid = int(match.group(1))
    with LOCK:
        actions = [dict(a) for a in STATE["actions"].get(rid, [])]
    return _ok(actions)


def h_action_type_list_all(_body, _query, _match):
    return _ok(["FAST", "TIMED", "TEMP_TASK_CHAIN", "CAMERA", "AUTO_SYSTEM", "BUTTON_TASK"])


def h_error_records(_body, query, _match):
    page = int(query.get("page", ["1"])[0] or 1)
    size = int(query.get("size", ["10"])[0] or 10)
    return _ok(_paginate([], page, size))


def h_base_encode(_body, _query, _match):
    with LOCK:
        fifo = STATE["fifo"]
        head = STATE["records"].get(fifo[0]) if fifo else None
        charging = head is None or head["taskType"] == "AUTO_SYSTEM"
    return 200, {"chargeFlag": 2 if charging else 0}


def h_cancel_goal(_body, _query, _match):
    return 200, {"code": 0, "message": "success"}


ROUTES = [
    ("POST", API_PREFIX + r"/task-template/create$", h_template_create),
    ("GET", API_PREFIX + r"/task-template/page$", h_template_page),
    ("POST", API_PREFIX + r"/task-template/generic/task-fast/(\d+)$", h_task_fast),
    ("GET", API_PREFIX + r"/task-record/page$", h_task_record_page),
    ("POST", API_PREFIX + r"/task-record/cancel/(\d+)$", h_task_record_cancel),
    ("POST", API_PREFIX + r"/task-record/all-cancel/([^/]+)$", h_task_record_all_cancel),
    ("GET", API_PREFIX + r"/action-record/list/(\d+)$", h_action_record_list),
    ("GET", API_PREFIX + r"/action-type/list-all$", h_action_type_list_all),
    ("GET", API_PREFIX + r"/error/records$", h_error_records),
    ("GET", r"/reeman/base_encode$", h_base_encode),
    ("POST", r"/cmd/cancel_goal$", h_cancel_goal),
]

COMPILED_ROUTES = [(method, re.compile(pattern), handler) for method, pattern, handler in ROUTES]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[robot_simulator] %s - %s" % (self.address_string(), fmt % args))

    def _dispatch(self, method):
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        body = None
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                body = None
        for m, pattern, handler in COMPILED_ROUTES:
            if m != method:
                continue
            match = pattern.match(parsed.path)
            if match:
                status, payload = handler(body, query, match)
                self._send(status, payload)
                return
        self._send(404, {"code": 1, "message": "endpoint não simulado: %s %s" % (method, parsed.path), "data": None})

    def _send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")


def _local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    threading.Thread(target=_tick, daemon=True).start()
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    ip = _local_ip()
    print("Robô simulado (dispatch service falso) rodando.")
    print("  Nesta máquina (server.py + simulador juntos): http://127.0.0.1:%d/" % port)
    print("  Na rede local (server.py em outra máquina):    http://%s:%d/" % (ip, port))
    print("Aponte ROBOT_HOST (server.py) ou o campo de IP do robô (tela do .exe) pra um desses.")
    print("Ctrl+C pra parar.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
