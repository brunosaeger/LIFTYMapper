#!/usr/bin/env python3
"""GUI do LIFTY empacotado (.exe).

Janelinha "plug and play": digita o IP do robô, aperta o botão de power, e o
servidor (server.py, rodando DENTRO deste mesmo processo — não é subprocess)
sobe. Fechar no X só minimiza pra barra de tarefas; pra encerrar de verdade
tem o botão "Sair".

Só biblioteca padrão (tkinter) — mesma filosofia zero-dependência do
server.py. Empacotado com PyInstaller junto do server.py e do web/dist (ver
packaging/lifty.spec + .github/workflows/build-exe.yml).
"""
import json
import socket
import sys
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, ttk

# server.py vive na raiz do repo (um nível acima). No .exe empacotado os
# dois ficam lado a lado e isso é no-op; rodando `python3 packaging/lifty_gui.py`
# em dev, garante que o import acha.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

CONFIG_FILE = server._app_dir() / "lifty_config.json"
LOCAL_URL = f"http://localhost:{server.LISTEN_PORT}"

COLOR_OFF = "#c0392b"   # vermelho — servidor desligado
COLOR_ON = "#27ae60"    # verde — servidor no ar
COLOR_BUSY = "#7f8c8d"  # cinza — transição


def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(cfg):
    try:
        CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
    except OSError:
        pass  # sem permissão de escrita ao lado do .exe — não é fatal


def lan_ip():
    """IP da interface de rede real desta máquina (o que os tablets usam).
    Truque do socket UDP: 'conecta' a um IP externo sem mandar nada e lê o
    endereço local que o SO escolheu pra rota."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class LiftyApp:
    def __init__(self, root):
        self.root = root
        root.title("LIFTY — Painel do Forklift")
        root.geometry("420x340")
        root.resizable(False, False)

        cfg = load_config()

        pad = {"padx": 16, "pady": 6}
        tk.Label(root, text="IP do robô na rede de hoje", font=("Segoe UI", 10)).pack(anchor="w", **pad)
        self.ip_var = tk.StringVar(value=cfg.get("robotHost", "192.168.43.74"))
        self.ip_entry = tk.Entry(root, textvariable=self.ip_var, font=("Consolas", 12))
        self.ip_entry.pack(fill="x", padx=16)

        self.power_btn = tk.Button(
            root, text="LIGAR SERVIDOR", font=("Segoe UI", 13, "bold"),
            bg=COLOR_OFF, fg="white", activebackground=COLOR_OFF, activeforeground="white",
            relief="flat", height=2, command=self.toggle,
        )
        self.power_btn.pack(fill="x", padx=16, pady=14)

        self.status = tk.Label(root, text="", font=("Segoe UI", 10), justify="left", fg="#333")
        self.status.pack(anchor="w", padx=16)

        self.open_btn = tk.Button(root, text="Abrir no navegador", command=self.open_browser, state="disabled")
        self.open_btn.pack(anchor="w", padx=16, pady=(8, 0))

        ttk.Separator(root, orient="horizontal").pack(fill="x", padx=16, pady=12)
        tk.Button(root, text="Sair", width=12, command=self.quit).pack(side="right", padx=16, pady=(0, 12))

        # X da janela só minimiza — servidor segue rodando. Encerrar de
        # verdade é só pelo botão "Sair".
        root.protocol("WM_DELETE_WINDOW", root.iconify)

        self._render_stopped()

    # --- ações -----------------------------------------------------------
    def toggle(self):
        if server.is_running():
            self._stop()
        else:
            self._start()

    def _start(self):
        host = self.ip_var.get().strip()
        if not host:
            messagebox.showwarning("Falta o IP", "Digite o IP do robô antes de ligar.")
            return
        self._set_busy("Iniciando…")
        self.root.update_idletasks()
        try:
            server.start_server(robot_host=host)
        except OSError as err:
            self._render_stopped()
            messagebox.showerror(
                "Não deu pra iniciar",
                f"Erro ao abrir a porta {server.LISTEN_PORT}:\n{err}\n\n"
                "Já tem outro LIFTY (ou algo na porta 8000) rodando?",
            )
            return
        save_config({"robotHost": host})
        self._render_running()
        self.open_browser()

    def _stop(self):
        self._set_busy("Desligando…")
        self.root.update_idletasks()
        server.stop_server()
        self._render_stopped()

    def open_browser(self):
        webbrowser.open(LOCAL_URL)

    def quit(self):
        if server.is_running():
            server.stop_server()
        self.root.destroy()

    # --- estados visuais ------------------------------------------------
    def _set_busy(self, text):
        self.power_btn.config(text=text, bg=COLOR_BUSY, activebackground=COLOR_BUSY, state="disabled")

    def _render_stopped(self):
        self.power_btn.config(text="LIGAR SERVIDOR", bg=COLOR_OFF, activebackground=COLOR_OFF, state="normal")
        self.ip_entry.config(state="normal")
        self.open_btn.config(state="disabled")
        self.status.config(text="Servidor desligado.")

    def _render_running(self):
        self.power_btn.config(text="DESLIGAR SERVIDOR", bg=COLOR_ON, activebackground=COLOR_ON, state="normal")
        self.ip_entry.config(state="disabled")  # não troca o IP com o servidor no ar
        self.open_btn.config(state="normal")
        ip = lan_ip()
        self.status.config(
            text=(
                "Servidor NO AR.\n\n"
                f"Neste computador:  {LOCAL_URL}\n"
                f"Nos tablets:       http://{ip}:{server.LISTEN_PORT}\n\n"
                "(no 1º uso o Windows pode pedir pra liberar na rede — permita)"
            )
        )


def main():
    root = tk.Tk()
    LiftyApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
