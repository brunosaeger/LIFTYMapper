# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec — gera LIFTY.exe (onefile) a partir da GUI tkinter.
#
# Rodar SEMPRE da raiz do repo (o web/dist já tem que existir, buildado):
#     cd web && npm run build && cd ..
#     pyinstaller packaging/lifty.spec
#
# O que entra no .exe:
#   - packaging/lifty_gui.py  (entrypoint) + server.py (import)
#   - web/dist/**             (o app React buildado, servido estático)
#   - LIFTY.ico               (ícone do executável)
# Os 5 arquivos de dado (calibration/route_log/queue_state/users/session_secret)
# NÃO entram — server.py os cria/lê ao lado do .exe em runtime (ver _app_dir).
import os

ROOT = os.path.abspath(os.getcwd())

a = Analysis(
    ['packaging/lifty_gui.py'],
    pathex=[ROOT],
    binaries=[],
    datas=[('web/dist', 'web/dist')],
    hiddenimports=['server'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='LIFTY',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    # console=True mostra os prints do server.py (reconciliação, erros da
    # fila, senha do admin no 1º boot) numa janelinha preta. Deixe assim
    # enquanto está testando; troque pra False quando quiser o "plug and
    # play" limpo (aí a senha do 1º admin só sai no messagebox / precisa
    # olhar users.json).
    console=True,
    disable_windowed_traceback=False,
    icon='packaging/LIFTY.ico',
)
