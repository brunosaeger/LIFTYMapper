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
import functools
import http.server
import json
import threading
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# CONFIGURAÇÃO — confirme o IP do robô antes da demo (ver seção 1.1 do PDF /
# ip_nav confirmado em testes anteriores).
# ---------------------------------------------------------------------------
ROBOT_HOST = "http://192.168.43.74"
LISTEN_PORT = 8000
# ---------------------------------------------------------------------------

API_PREFIX = "/api/reeman-dispatch-service"
CALIBRATION_PATH = "/api/calibration"
STATIC_DIR = "web/dist"
CALIBRATION_FILE = Path(__file__).parent / "calibration.json"
EMPTY_CALIBRATION = b'{"top":{"points":[],"lots":[]},"iso":{"points":[],"lots":[]},"occupied":[]}'

# Histórico de rotas (modo desenvolvedor, painel "Histórico" no app React) —
# guarda quando cada rota foi SOLICITADA e CONCLUÍDA usando o relógio DESTA
# máquina (a que roda este processo), de propósito: nem o relógio do robô
# (dispatch service) nem o do tablet/navegador do operador são confiáveis
# como referência única — cada um pode estar em fuso/hora diferente. O app
# React só manda pickup/dropoff/taskName; quem carimba requestedAt/
# completedAt é sempre este servidor.
ROUTE_LOG_PATH = "/api/route-log"
ROUTE_LOG_REQUEST_PATH = "/api/route-log/request"
ROUTE_LOG_COMPLETE_PATH = "/api/route-log/complete"
ROUTE_LOG_FILE = Path(__file__).parent / "route_log.json"
ROUTE_LOG_MAX_ENTRIES = 500  # roda 24/7 num armazém, sem manutenção — evita o arquivo crescer pra sempre
ROUTE_LOG_LOCK = threading.Lock()  # ThreadingHTTPServer atende requisições em paralelo; protege o ciclo ler-modificar-escrever do arquivo


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith(API_PREFIX):
            self._proxy("GET")
        elif self.path == CALIBRATION_PATH:
            self._get_calibration()
        elif self.path == ROUTE_LOG_PATH:
            self._get_route_log()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith(API_PREFIX):
            self._proxy("POST")
        elif self.path == CALIBRATION_PATH:
            self._save_calibration()
        elif self.path == ROUTE_LOG_REQUEST_PATH:
            self._route_log_request()
        elif self.path == ROUTE_LOG_COMPLETE_PATH:
            self._route_log_complete()
        else:
            self.send_error(404, "Not Found")

    # --- persistência da calibração (pontos avulsos + lotes, editor React) --
    def _get_calibration(self):
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
        CALIBRATION_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        self._relay(200, "application/json", b'{"ok":true}')

    # --- histórico de rotas (painel "Histórico", modo desenvolvedor) --------
    def _read_route_log(self):
        if not ROUTE_LOG_FILE.exists():
            return []
        try:
            return json.loads(ROUTE_LOG_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return []

    def _write_route_log(self, entries):
        ROUTE_LOG_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2))

    def _get_route_log(self):
        with ROUTE_LOG_LOCK:
            entries = self._read_route_log()
        payload = json.dumps(entries, ensure_ascii=False).encode("utf-8")
        self._relay(200, "application/json", payload)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b"{}"
        return json.loads(body)

    def _route_log_request(self):
        try:
            payload = self._read_json_body()
            entry_id = payload["id"]
            pickup = payload["pickup"]
            dropoff = payload["dropoff"]
        except (json.JSONDecodeError, KeyError) as err:
            self._relay(400, "application/json", ('{"error":"%s"}' % str(err)).encode("utf-8"))
            return
        with ROUTE_LOG_LOCK:
            entries = self._read_route_log()
            entries.append({
                "id": entry_id,
                "pickup": pickup,
                "dropoff": dropoff,
                "taskName": payload.get("taskName"),
                "requestedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "completedAt": None,
                "status": "requested",
            })
            entries = entries[-ROUTE_LOG_MAX_ENTRIES:]
            self._write_route_log(entries)
        self._relay(200, "application/json", b'{"ok":true}')

    def _route_log_complete(self):
        try:
            payload = self._read_json_body()
            entry_id = payload["id"]
            status = payload["status"]
        except (json.JSONDecodeError, KeyError) as err:
            self._relay(400, "application/json", ('{"error":"%s"}' % str(err)).encode("utf-8"))
            return
        with ROUTE_LOG_LOCK:
            entries = self._read_route_log()
            for entry in entries:
                if entry.get("id") == entry_id:
                    entry["completedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    entry["status"] = status
                    break
            self._write_route_log(entries)
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
    if not (Path(__file__).parent / STATIC_DIR / "index.html").exists():
        print(f"AVISO: {STATIC_DIR}/index.html não encontrado — rode 'npm run build' dentro de web/ antes.")
    handler = functools.partial(Handler, directory=STATIC_DIR)
    with http.server.ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), handler) as httpd:
        print(f"Painel disponivel em      http://localhost:{LISTEN_PORT}")
        print(f"Proxy encaminhando {API_PREFIX} -> {ROBOT_HOST}{API_PREFIX}")
        print(f"Calibração persistida em  {CALIBRATION_FILE}")
        print(f"Histórico de rotas em     {ROUTE_LOG_FILE}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nEncerrado.")
