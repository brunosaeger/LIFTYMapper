#!/usr/bin/env python3
"""Bridge minimo e independente: expoe check_turn_angle (ROS) como HTTP.

ATENCAO — roda no COMPUTADOR DE BORDO DO ROBO (a mesma maquina que serve o
dispatch service via wifi, ver CONTEXT.md "Descoberta do check_turn_angle
via ROS"), NUNCA na maquina que roda o server.py. E um consumidor
independente dos topicos ROS que ja existem no robo, nada mais:

- NAO faz parte de nenhum workspace catkin/colcon da REEMAN.
- NAO compila nada (sem colcon build / catkin_make).
- NAO altera, sobrescreve ou sequer le nenhum arquivo da REEMAN.
- NAO mexe em launch files, systemd, firewall ou configuracao de rede.
- So usa tipos de mensagem PADRAO do ROS (std_msgs.Float32/Bool), que vem
  de fabrica em qualquer instalacao ROS — nunca um pacote/mensagem custom
  da REEMAN.
- Fala com os topicos /robot_api/turn_check_angle e /robot_api/turn_check_ok
  exatamente como `rostopic pub`/`echo` ja fizeram manualmente antes deste
  arquivo existir (mesma categoria de acao, so que programatica).

Modo de uso pretendido (por enquanto): MANUAL, sob demanda, via SSH — nao
e um systemd service, nao inicia sozinho no boot. So vira permanente se/
quando isso for decidido explicitamente depois de validado em campo.

Uso:
    source /opt/ros/*/setup.bash   # so ambiente da sessao, nada em disco
    python3 lifty_turn_check_bridge.py
    # Ctrl+C pra parar -- nada fica rodando depois.

Teste local (outra janela SSH, mesma maquina):
    curl "http://localhost:8091/check-turn?angle=180"

Teste remoto (de qualquer maquina na mesma wifi, ex. a que roda server.py):
    curl "http://192.168.5.195:8091/check-turn?angle=180"
    (troca o IP se o robo estiver noutra rede -- ver ROBOT_HOST/robot_host.txt)
"""
import http.server
import json
import threading
import urllib.parse

import rospy
from std_msgs.msg import Bool, Float32

PORT = 8091
RESPONSE_TIMEOUT_SECONDS = 5

_lock = threading.Lock()  # serializa: o par de topicos nao tem "numero de pedido" amarrando pergunta->resposta
_response_event = threading.Event()
_last_response = {"value": None}

pub = None  # setado no __main__, antes do HTTP server comecar a atender


def _on_turn_check_ok(msg):
    _last_response["value"] = bool(msg.data)
    _response_event.set()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/check-turn":
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        try:
            angle = float(params["angle"][0])
        except (KeyError, ValueError, IndexError):
            self._json(400, {"error": "parametro 'angle' (numero, graus) obrigatorio"})
            return

        with _lock:  # uma pergunta por vez -- evita cruzar resposta de duas chamadas concorrentes
            _response_event.clear()
            _last_response["value"] = None
            pub.publish(Float32(data=angle))
            got = _response_event.wait(timeout=RESPONSE_TIMEOUT_SECONDS)
            if not got:
                self._json(504, {"error": "robo nao respondeu a tempo"})
                return
            self._json(200, {"safe": _last_response["value"], "angle": angle})

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    rospy.init_node("lifty_turn_check_bridge", anonymous=True)
    pub = rospy.Publisher("/robot_api/turn_check_angle", Float32, queue_size=1)
    rospy.Subscriber("/robot_api/turn_check_ok", Bool, _on_turn_check_ok)
    rospy.sleep(0.5)  # da tempo do publisher se registrar no master antes do 1o uso

    httpd = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    print("Bridge rodando: http://0.0.0.0:%d/check-turn?angle=<graus>" % PORT)
    print("Ctrl+C pra parar.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrado -- nada fica rodando depois disso.")
