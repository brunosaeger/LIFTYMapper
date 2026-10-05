# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec — gera LIFTY-SERVICE.exe (onefile, SEM interface gráfica)
# a partir do PRÓPRIO server.py — pensado pra rodar como Serviço do Windows
# numa VM (ver MIGRACAO_VM.md), sem precisar de ninguém clicando em nada.
#
# Diferença do lifty.spec (GUI com botão LIGAR/DESLIGAR, pra uso manual
# numa máquina com alguém na frente): aqui o entrypoint é o PRÓPRIO
# server.py (`if __name__ == "__main__": start_server(); ...`, no fim do
# arquivo) — ele já sobe sozinho com descoberta automática do IP do robô
# na rede local, sem precisar de IP digitado nem botão nenhum. É o MESMO
# comportamento que já roda em dev (`python3 server.py`) a sessão inteira
# — este spec só empacota ele como .exe autossuficiente (sem precisar de
# Python instalado na VM).
#
# Rodar de qualquer lugar (o CI faz `pyinstaller packaging/lifty_headless.spec`):
#     cd web && npm run build && cd ..     # gera web/dist ANTES
#     pyinstaller packaging/lifty_headless.spec
#
# Depois de gerado, registrar LIFTY-SERVICE.exe como Serviço do Windows
# (ex. via NSSM — https://nssm.cc/) pra subir sozinho no boot da VM e
# reiniciar sozinho se cair. Ver MIGRACAO_VM.md.
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))

a = Analysis(
    [os.path.join(ROOT, 'server.py')],
    pathex=[ROOT],
    binaries=[],
    datas=[
        (os.path.join(ROOT, 'web', 'dist'), 'web/dist'),
        # mapa "de fábrica" — server.py copia pro lado do .exe num install
        # novo (_seed_calibration_if_missing); install que já tem mapa não
        # é tocado. Na VM, o ideal é levar o calibration.json REAL já
        # existente (ver MIGRACAO_VM.md) em vez de depender deste seed.
        (os.path.join(ROOT, 'packaging', 'calibration.seed.json'), '.'),
    ],
    hiddenimports=[],
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
    name='LIFTY-SERVICE',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    # console=True: os prints de status (IP do robô descoberto, caminho
    # dos arquivos de dado, erros da fila) ficam visíveis -- útil rodando
    # na mão uma vez pra testar antes de virar serviço de verdade. A
    # maioria dos gerenciadores de serviço (ex. NSSM) já redireciona isso
    # pra um arquivo de log, independente deste flag.
    console=True,
    disable_windowed_traceback=False,
    icon=os.path.join(ROOT, 'packaging', 'LIFTY.ico'),
)
