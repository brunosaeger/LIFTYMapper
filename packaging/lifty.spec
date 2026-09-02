# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec — gera LIFTY.exe (onefile) a partir da GUI tkinter.
#
# Rodar de qualquer lugar (o CI faz `pyinstaller packaging/lifty.spec`):
#     cd web && npm run build && cd ..     # gera web/dist ANTES
#     pyinstaller packaging/lifty.spec
#
# PyInstaller resolve caminhos relativos à pasta DO SPEC (packaging/), não ao
# CWD — por isso tudo aqui é absoluto, montado a partir de SPECPATH (que o
# PyInstaller injeta = pasta deste .spec) e subindo um nível pra raiz do repo.
#
# O que entra no .exe:
#   - packaging/lifty_gui.py (entrypoint) + server.py (import, na raiz)
#   - web/dist/**            (o app React buildado, servido estático)
#   - LIFTY.ico              (ícone do executável)
# Os 5 arquivos de dado (calibration/route_log/queue_state/users/session_secret)
# NÃO entram — server.py os cria/lê ao lado do .exe em runtime (_app_dir).
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))

a = Analysis(
    [os.path.join(ROOT, 'packaging', 'lifty_gui.py')],
    pathex=[ROOT],  # pra achar server.py na raiz
    binaries=[],
    datas=[(os.path.join(ROOT, 'web', 'dist'), 'web/dist')],
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
    # play" limpo.
    console=True,
    disable_windowed_traceback=False,
    icon=os.path.join(ROOT, 'packaging', 'LIFTY.ico'),
)
