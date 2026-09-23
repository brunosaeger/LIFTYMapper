#!/usr/bin/env python3
"""Bridge minimo e independente: expoe check_turn_angle e o liga/desliga do
sensor de obstaculo 3D (ambos ROS) como HTTP.

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
- /robot_api/set_obs3d_switch (std_msgs/Bool) — descoberto ao vivo via
  `rostopic list -v | grep -i obs` em 2026-09-24 (mesmo namespace
  /robot_api/* do turn_check, oficial da REEMAN pra controle externo).
  Liga/desliga o sensor de obstaculo 3D (camera de profundidade) —
  usado pelo server.py pra desligar SO durante o giro inicial de rotas
  pra energia que travam por sensor conservador demais em espaco
  apertado (ver CONTEXT.md "obs_3d ligado/desligado durante giro"),
  sempre com teto de tempo do lado do server.py — este bridge nunca
  decide sozinho por quanto tempo fica desligado, so publica o Bool
  que pedirem.

Modo de uso pretendido (por enquanto): MANUAL, sob demanda, via SSH — nao
e um systemd service, nao inicia sozinho no boot. So vira permanente se/
quando isso for decidido explicitamente depois de validado em campo.

Uso:
    source /opt/ros/*/setup.bash   # so ambiente da sessao, nada em disco
    python3 lifty_turn_check_bridge.py
    # Ctrl+C pra parar -- nada fica rodando depois.

    ATENCAO (bug de campo 2026-09-23): rodando assim, em primeiro plano, o
    processo MORRE se a sessao SSH cair -- inclusive so por desconectar o
    cabo/fechar o terminal (SIGHUP), sem precisar de Ctrl+C nenhum. Isso ja
    aconteceu: bridge "sumiu" (connection refused na porta 8091, robo
    normal em tudo mais) so porque o cabo do SSH foi desconectado depois de
    ja ter rodado o comando. Se for deixar a sessao SSH sem monitorar (ou
    desconectar o cabo de propósito), usa nohup pra sobreviver:

        nohup python3 lifty_turn_check_bridge.py > bridge.log 2>&1 &

    Isso NAO muda a natureza "manual, sob demanda" do processo (ainda nao
    e systemd, ainda nao inicia sozinho no boot, ainda precisa ser morto
    na mao -- `pkill -f lifty_turn_check_bridge` -- quando quiser parar de
    verdade) -- so evita a morte ACIDENTAL por desconexao de sessao.

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
obs3d_pub = None  # idem -- publisher do /robot_api/set_obs3d_switch


def _on_turn_check_ok(msg):
    _last_response["value"] = bool(msg.data)
    _response_event.set()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/check-turn":
            self._handle_check_turn(parsed)
        elif parsed.path == "/obstacle-3d":
            self._handle_obstacle_3d(parsed)
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_check_turn(self, parsed):
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

    # Liga/desliga o sensor de obstaculo 3D -- so publica, sem esperar
    # resposta nenhuma (o topico /robot_api/set_obs3d_switch nao tem par de
    # confirmacao como o turn_check tem). Por isso nao precisa do _lock:
    # publicar um Bool nao tem corrida possivel entre chamadas concorrentes.
    # QUEM decide por quanto tempo fica desligado e o server.py (teto de
    # seguranca do lado de la) -- este bridge so executa o que pedirem, uma
    # vez, sem guardar estado nenhum sobre "esta desligado ha quanto tempo".
    def _handle_obstacle_3d(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        try:
            on = params["on"][0] in ("1", "true", "True")
        except (KeyError, IndexError):
            self._json(400, {"error": "parametro 'on' (1 ou 0) obrigatorio"})
            return
        obs3d_pub.publish(Bool(data=on))
        self._json(200, {"obs3d": on})

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def address_string(self):
        # BaseHTTPRequestHandler.address_string() por padrao faz um DNS
        # reverso (socket.getfqdn) antes de toda resposta -- numa rede
        # industrial sem DNS isso trava/falha e derruba a resposta ANTES de
        # mandar qualquer byte (visto na pratica: funcionava via localhost,
        # dava "resposta vazia" pra qualquer IP de rede de verdade). So usa
        # o IP puro, sem lookup nenhum.
        return self.client_address[0]

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    rospy.init_node("lifty_turn_check_bridge", anonymous=True)
    pub = rospy.Publisher("/robot_api/turn_check_angle", Float32, queue_size=1)
    rospy.Subscriber("/robot_api/turn_check_ok", Bool, _on_turn_check_ok)
    obs3d_pub = rospy.Publisher("/robot_api/set_obs3d_switch", Bool, queue_size=1)
    rospy.sleep(0.5)  # da tempo dos publishers se registrarem no master antes do 1o uso

    httpd = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    print("Bridge rodando:")
    print("  http://0.0.0.0:%d/check-turn?angle=<graus>" % PORT)
    print("  http://0.0.0.0:%d/obstacle-3d?on=<1 ou 0>" % PORT)
    print("Ctrl+C pra parar.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrado -- nada fica rodando depois disso.")
