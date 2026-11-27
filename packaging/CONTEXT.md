# Empacotamento, VM de produção e atualização

**Produção**: em operação na fábrica (Palmares), operadores autônomos
desde ~2026-11-04 — mudança no servidor É mudança de produção.

Ler junto: [../docs/context/servidor.md](../docs/context/servidor.md),
[../robot-bridge/CONTEXT.md](../robot-bridge/CONTEXT.md),
`MIGRACAO_VM_FINAL.md` (guia completo: pedidos pra infra, rede, firewall,
chave SSH, validação, restauração de backup — substitui o `MIGRACAO_VM.md`).

## A VM

- Windows Server 2019 `aplsrv`, IP fixo `192.168.5.252`. Tablets acessam
  `http://192.168.5.252:8000` (todos o MESMO endereço).
- Serviço do Windows `LIFTY-SERVICE` (NSSM) rodando `C:\LIFTY\LIFTY-SERVICE.exe`
  como SYSTEM. Dados, `backups\` e `logs\lifty.log` em `C:\LIFTY`.
- Precisa alcançar o robô nas portas 80 (dispatch/SLAM), 8091 (bridge) e
  22 (SSH da vigia), com cliente OpenSSH e a chave `lifty_robot` com
  permissão só pra SYSTEM/Administradores (o ssh do Windows recusa chave
  aberta demais).
- Firewall do Windows precisa liberar a 8000 pros tablets.

## Artefatos (`.github/workflows/build-exe.yml`, runner Windows)

Dispara na mão (Actions) ou por tag `v*`. Node 20 → `npm ci && npm run
build` → Python 3.12 → `pyinstaller==6.11.1`:
- `packaging/lifty_headless.spec` → `LIFTY-SERVICE.exe` (o `__main__` do
  `server.py`: `start_server()` com descoberta automática do IP) — **é o
  de produção**.
- `packaging/lifty.spec` → `LIFTY.exe`, GUI tkinter (`lifty_gui.py`: campo
  de IP em `lifty_config.json`, botão liga/desliga in-process, X só
  minimiza, impede o Windows de suspender). Uso manual, não na VM.
- Pacote `LIFTY-VM` (serviço + nssm + scripts); com tag, vira a Release
  `LIFTY-VM.zip` de onde a VM baixa.
- `packaging/calibration.seed.json`: mapa de fábrica pra install novo
  (atualizar = copiar o `calibration.json` e rebuildar).

## Scripts da VM (`packaging/vm/`, PowerShell como admin)

- `testar-rede.ps1` — VM → robô (80, 8091, 22) e tablet → VM (8000). Não
  altera nada.
- `instalar.ps1 -Dados <pasta>` (instala, não inicia) / `-Iniciar`.
- `atualizar.ps1` — baixa a última Release, **confere se o robô está
  ocioso**, guarda o programa atual e troca só o .exe (dados ficam).
  `-Voltar` desfaz; `-Zip <arquivo>` sem internet.
- `exportar-dados.ps1` — tira os dados da máquina antiga
  (`LIFTY-dados-AAAA-MM-DD_HHMM`). Lista `$recomendados`: todo arquivo de
  dado novo entra aqui.

## Atualizar pelo site (botão ⟳, 2026-11-27)

No Toolbar, ao lado do tema, **só no modo desenvolvedor e só pra admin**
(o servidor também exige admin: 403 pros outros). Abre `SystemUpdateModal`:
versão instalada (`VERSAO.txt`), última Release do GitHub (a VM precisa de
internet), "Atualizar para vX" e "Voltar à anterior" (se houver backup), log
da última execução.
- `GET/POST /api/system/update {action: update|rollback}`. Recusa no modo
  teste, fora do exe congelado/Windows, sem o `atualizar.ps1` ao lado, com
  fila ocupada (inclui UNLOAD pendente) ou com outra atualização em curso.
- O servidor **não se troca**: grava `atualizar-via-site.ps1` (wrapper que
  joga toda a saída em `logs\atualizar.log`) e agenda/dispara a tarefa
  `LIFTY-Atualizar` no Agendador como SYSTEM (`schtasks /Create … /RU SYSTEM
  /RL HIGHEST /F` + `/Run`). Precisa ser FORA do serviço: o atualizar.ps1
  para o serviço e o NSSM mata os filhos junto.
- Enquanto isso, `enqueue-batch` recusa tarefa nova (10 min).
- A tela espera o serviço cair e voltar e recarrega; se o log mostrar
  "PAREI" (o script desistiu antes de trocar), avisa na hora.
- **Só funciona a partir da versão que tem o botão** — a VM precisa ser
  atualizada uma vez pela infra (instalar.ps1 do pacote) pra ganhar ele.
- Testado: unidade com `schtasks` simulado (13 casos) e tela no modo teste.
  A execução real como SYSTEM só dá pra validar na VM.

## Como publicar uma versão (o que o "um comando" da VM precisa)

1. Commit + `git push origin main` + tag anotada `vX.Y` + `git push origin vX.Y`.
   Sem tag `v*` não há Release e o `atualizar.ps1` baixa a anterior.
2. O CI (~2 min) gera a Release com `LIFTY-VM.zip`. Conferir sem `gh`:
   `https://api.github.com/repos/brunosaeger/LIFTYMapper/releases/latest`.
3. Na VM (admin, robô parado):
   `powershell -ExecutionPolicy Bypass -File C:\LIFTY\atualizar.ps1`.
4. Se o bridge mudou desde a última atualização: atualizar no robô (ver
   [../robot-bridge/CONTEXT.md](../robot-bridge/CONTEXT.md)) — o pacote da
   VM não leva o bridge. Conferir o hash do blob commitado (`git show
   <commit>:robot-bridge/lifty_turn_check_bridge.py | sha256sum`; a cópia do
   Windows pode ter CRLF e dar outro hash).

Última publicada: **v1.3** (2026-11-27, commit `e220a3c`, com o botão ⟳).
A VM roda o build de 2026-11-06 até a infra instalar a v1.3 uma vez (o build
antigo não tem `atualizar.ps1` nem o botão); o bridge do robô está sem as
mudanças do v1.1 (`980d643`: sinal `blocked`, câmera) até o passo 4.

## Regras de deploy

- Commit/push/tag/atualizar a VM **só quando o usuário pedir**.
- Atualizar a VM exige o robô parado (sem rota em andamento ou na fila).
- Mudança no bridge: além do exe, atualizar o arquivo no robô (`curl` do
  raw GitHub — precisa estar pushado; ver robot-bridge).
- `tools/` (inclusive `tools/field-data`) e `reemansniff.md` nunca vão pro
  repositório.

## Pendências

- Fullscreen do tablet: um site não entra sozinho em tela cheia; opção não
  feita = instalar como app (`display: fullscreen` já no manifest) com o
  endereço marcado como seguro, ou navegador de quiosque.
