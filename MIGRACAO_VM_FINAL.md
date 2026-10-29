# Migração FINAL do LIFTY Mapper pra VM Windows — guia e checklist

> Versão de 2026-10-29. **Substitui o `MIGRACAO_VM.md`** (de 2026-10-15), que
> ficou desatualizado: de lá pra cá o servidor passou a **usar o bridge do robô**
> (porta 8091) e a **religá-lo sozinho por SSH** (porta 22). Isso muda os pedidos
> de rede e os arquivos que vão pra VM.

**Situação**: hoje o `server.py` roda numa máquina local ligada na wifi do
robô. O destino é uma VM **Windows Server 2019** da empresa (`aplsrv`, IP fixo
combinado: `192.168.5.252`), rodando um executável **sem interface**
(`LIFTY-SERVICE.exe`) registrado como **Serviço do Windows**, 24/7. Os tablets
passam a abrir sempre o mesmo endereço: **`http://192.168.5.252:8000`**
(confirmar o IP na seção 6 antes de configurar qualquer atalho).

Tudo é um programa só: o `LIFTY-SERVICE.exe` serve o app dos tablets, guarda os
dados e fala com o robô. Não precisa instalar Python, Node nem nada na VM — só
o **cliente OpenSSH** do próprio Windows (seção 7).

---

## 0. O que mudou desde o guia de 15/10

| Mudança | Impacto na VM |
|---|---|
| Robô migrou pro **projeto 15** do dispatch (21/10) | já está no código; nada a fazer |
| **Bridge do robô (8091) voltou a ser usado**: garfo na altura de navegação, avisos de obstáculo pelos sensores, modo sombra do pallet empurrado | VM precisa alcançar o robô na **porta 8091** |
| **Vigia do bridge**: o servidor religa o bridge por SSH quando o robô reinicia | VM precisa alcançar o robô na **porta 22**, ter o **cliente OpenSSH** e a **chave `lifty_robot`** |
| Robô ao vivo no mapa + rotas planejadas | usa a porta 80 do robô (já pedida); cada tablet com o mapa aberto consulta a posição 1x/s |
| Ajuste do robô no mapa (`robotFrame`) | vai dentro do `calibration.json` — levar o **atual** |
| Modo sombra grava `dock_shadow.jsonl` | arquivo de dados novo (opcional levar) |
| Limpeza automática da fila parada há 1 h | nada a fazer (pensada justamente pro 24/7) |

O check-turn ("posso girar aqui?") **continua desligado** (`TURN_CHECK_ENABLED =
False`) — a 8091 é usada pelas outras funções acima.

## 1. Antes de gerar o executável: código no GitHub

O `.exe` é compilado pelo GitHub Actions **a partir do que está no GitHub**. Na
máquina atual há trabalho ainda não enviado — sem isso o `.exe` sai velho.

1. `git status` limpo (tudo commitado — **menos** `tools/field-data`, que fica
   fora por enquanto, e os arquivos de dados, que o `.gitignore` já exclui).
2. `git push origin main`.
3. Conferir no GitHub que o último commit é o esperado.

## 2. Gerar o executável

1. GitHub: repositório `brunosaeger/LIFTYMapper` → aba **Actions** → workflow
   **"Build LIFTY.exe"** → **Run workflow**.
2. Quando terminar, baixar o artefato **`LIFTY-SERVICE-windows`** (zip com o
   `LIFTY-SERVICE.exe`). O outro (`LIFTY-windows`) é a versão com janela e
   **não** é a que vai pra VM.
3. O `.exe` já leva o app compilado (`web/dist`, com os ícones novos do robô),
   os manuais, os ícones e os sons.

> Antivírus/SmartScreen podem estranhar um `.exe` sem assinatura digital. Peça
> pra infra liberar o arquivo (exceção por caminho) antes de registrar o serviço.

## 3. O que levar pra VM

**Programas**
- `LIFTY-SERVICE.exe` (seção 2).
- `nssm.exe` (https://nssm.cc/ — transforma o `.exe` em serviço).

**Arquivos de dados desta máquina** (pasta do `server.py`) → copiar pra mesma
pasta do `.exe` na VM. **Não estão no GitHub** (de propósito):

| Arquivo | O que é | Levar? |
|---|---|---|
| `calibration.json` | mapa calibrado: pontos e lotes (posição, nome técnico e apelido), kanbans, ocupação, alturas de pallet, ajuste do robô no mapa (`robotFrame`), **grafo deformado** (`robotWarp`) e opacidade da rota | **sim** |
| `users.json` | contas, senhas (hash), admin/mestre e kanbans de cada usuário | **sim** |
| `session_secret.key` | chave que assina os logins (sem ela todo mundo loga de novo) | recomendado |
| `lifty_robot` | **chave SSH do robô** (hoje em `C:\Users\bruno\.ssh\lifty_robot`) — a vigia do bridge usa | **sim** (seção 7) |
| `robot_host.txt` | último IP do robô | recomendado |
| `route_log.json` | histórico de rotas | opcional |
| `dock_shadow.jsonl` | registros do modo sombra (pallet empurrado) | opcional — leve se ainda estiver em observação |
| `queue_state.json` | fila | **não** — ver seção 5 |
| `robot_known_hosts` | identidade do robô vista pelo SSH | **não** — a VM gera o dela na 1ª conexão |

Sem `calibration.json`/`users.json`, o servidor cria tudo do zero (mapa de
fábrica e usuário **`admin` / `admin`**). Evite.

**Quando copiar**: só **depois de parar o `server.py` da máquina antiga** (e com o
robô ocioso). Qualquer ajuste feito no site depois da cópia (ocupação marcada,
grafo mexido, usuário criado) ficaria só na máquina antiga. Copie os arquivos
como estão — não abra/salve em editor de texto (muda codificação/quebras de
linha). Guarde também uma cópia datada num lugar seguro antes de começar.

Conferir que a cópia chegou idêntica (rodar nas duas máquinas, os hashes têm
que bater):

```powershell
Get-FileHash calibration.json, users.json, session_secret.key | Format-Table Hash, Path
```

Referência de 29/10 (pra conferir no site depois de subir): 4 usuários; vista de
cima com 46 lotes e 19 pontos; grafo do robô com 172 pinos de deformação e
opacidade da rota em 60%; 51 posições ocupadas (esse número muda com o uso).

> A chave `lifty_robot` dá acesso de terminal ao robô. Trate como senha: só na
> pasta do serviço, com permissão restrita (seção 7), nunca no GitHub, nunca em
> pasta compartilhada.

## 4. Pedidos pra infra

1. **Pasta própria com escrita**, ex. `C:\LIFTY\` — **não** em `Program Files`. O
   serviço grava os arquivos de dados ao lado do `.exe`. Acesso à pasta só pra
   administradores (por causa da chave SSH).
2. **Serviço do Windows** via NSSM, iniciando no boot e reiniciando se cair.
3. **IP fixo da VM** (reserva por MAC no DHCP ou estático). É o endereço do
   atalho dos tablets.
4. **Firewall da VM**: entrada **TCP 8000**.
5. **Rotas de rede — o ponto mais arriscado**:

   | De → Para | Porta | Pra quê | Sem ela |
   |---|---|---|---|
   | tablets → VM | **8000** | o app | ninguém abre o painel |
   | VM → robô (`192.168.5.195`) | **80** | dispatch (tarefas) e SLAM (posição) | nenhuma tarefa é despachada |
   | VM → robô | **8091** | bridge: garfo, obstáculo, modo sombra | essas funções ficam no modo de reserva (sem quebrar o resto) |
   | VM → robô | **22** (SSH) | vigia religa o bridge depois de reiniciar o robô | bridge fica fora até alguém subir à mão |

   VMs de datacenter costumam ficar em rede separada da wifi do chão de fábrica:
   validar **todas** as linhas **antes** de desligar a máquina atual.
6. **Cliente OpenSSH** instalado na VM (vem com o Windows, às vezes desligado —
   comando na seção 7).
7. **Relógio sincronizado (NTP)**.
8. **Não expor a 8000 pra internet** (sem NAT/port-forward). HTTP simples,
   rede local fechada.
9. **Antivírus**: exceção pra `C:\LIFTY\LIFTY-SERVICE.exe`.
10. **Backup**: snapshot da VM e cópia periódica dos arquivos de dados.
11. **Acesso remoto** (RDP) pra você ver o log e reiniciar o serviço.

## 5. Pontos de atenção (verificados no código)

- **UM servidor só por robô.** Antes de ligar o serviço na VM, **desligue o
  `server.py` da máquina atual** — dois servidores despachariam tarefas e
  mexeriam no garfo do mesmo robô ao mesmo tempo.
- **Ao subir, a fila de espera é descartada** de propósito (reiniciar o serviço
  não faz o robô começar tarefa velha). Uma rota **em andamento** é mantida e
  conferida contra o robô. Pare/atualize o serviço com o robô ocioso.
- **IP do robô**: com `robot_host.txt`, usa direto; se o robô mudar de IP, varre
  a rede `/24` da VM (só funciona se VM e robô estiverem na mesma faixa
  `192.168.5.x`). Peça reserva de DHCP pro robô também.
- **Bridge do robô** (`~/lifty_turn_check_bridge.py`, porta 8091): **já está
  instalado no robô** e não vai no `.exe`. O servidor só o **inicia**, nunca o
  instala ou atualiza. Versão atual no robô = a do commit deste guia (backups no
  robô: `~/lifty_turn_check_bridge.py.bak-*`). Atualizar o bridge = `scp` manual
  do `robot-bridge/lifty_turn_check_bridge.py` + derrubar o processo (a vigia
  sobe o novo em até ~30 s).
- **Vigia do bridge** (`BRIDGE_WATCHDOG_*` no `server.py`): a cada 30 s confere a
  8091; fora do ar e com o robô respondendo na porta 22, roda por SSH um comando
  **fixo** que sobe o bridge (se já houver um processo vivo, não duplica; vivo
  mas mudo por 5 min = trava → mata e sobe de novo). Tentativas no máximo a cada
  2 min. **Nada no boot do robô foi alterado** (o crontab de inicialização é da
  REEMAN e fica intocado). Depois de ligar o robô, o bridge volta em ~tempo do
  ROS subir + até 30 s.
- **Log**: uma linha por requisição, exceto a posição do robô (1x/s por tablet,
  omitida quando dá certo). Configure rotação no NSSM (seção 8). Linhas úteis:
  `Bridge: ...` (vigia), `Obstáculo: ...`, `Sombra: ...`, `Garfo -> ...`.
- **Executável "onefile"**: se extrai em `%TEMP%\_MEIxxxxx` (~25 MB) a cada
  início; morto à força, a pasta fica. Irrelevante pra poucos reinícios.
- **Sem HTTPS**, de propósito. O Chrome mostra "não seguro" — esperado.
- **Primeira execução sem `users.json`** cria `admin`/`admin` — trocar no 1º
  acesso.

## 6. Checklist: rede e IP dos tablets

O endereço é o IP da **VM** (não o do robô), porta 8000, igual em todos os
tablets.

- [ ] Infra confirmou **por escrito** o IP fixo da VM. Previsto: `192.168.5.252`. ________
- [ ] Na VM: `ipconfig /all` → IPv4 bate e "DHCP habilitado: Não" (ou reserva por MAC).
- [ ] Na VM, as três portas do robô:
      ```powershell
      Test-NetConnection 192.168.5.195 -Port 80     # TcpTestSucceeded: True
      Test-NetConnection 192.168.5.195 -Port 8091   # True (bridge no ar)
      Test-NetConnection 192.168.5.195 -Port 22     # True (SSH da vigia)
      ```
- [ ] Na VM: `ssh -V` responde (cliente OpenSSH instalado).
- [ ] Na VM: `Get-Service LIFTY-SERVICE` → `Running`; `http://localhost:8000` → login.
- [ ] **De um tablet, na wifi do chão de fábrica**: `http://192.168.5.252:8000`
      → login. **Este teste decide tudo** — se falhar aqui e funcionar na VM, é
      rede/firewall, não o programa.
- [ ] Logado: status do robô ao vivo no topo e **o ícone do robô no mapa**
      (prova que a VM fala com o robô).
- [ ] Em **cada tablet**: apagar o atalho antigo → Chrome →
      `http://192.168.5.252:8000` → ⋮ → **Adicionar à tela inicial**.

Se o IP da VM um dia mudar, **todos os atalhos precisam ser refeitos**.

Endereço novo = o navegador trata como outro site: preferências guardadas só no
tablet (tema claro/escuro, modo desenvolvedor destrancado) voltam ao padrão e o
login é pedido uma vez (o cookie de login é por endereço). Os dados do mapa e
os usuários NÃO dependem disso — moram no servidor.

## 7. Instalação na VM (PowerShell como administrador)

```powershell
# 1) pasta, programas e dados
mkdir C:\LIFTY\logs
# copie LIFTY-SERVICE.exe, nssm.exe, os arquivos de dados (seção 3) e a chave
# lifty_robot pra C:\LIFTY\

# 2) cliente OpenSSH (se `ssh -V` não responder)
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0

# 3) chave SSH: só SYSTEM (o serviço) e Administradores leem.
#    O ssh do Windows RECUSA chave com permissão aberta demais.
#    (SIDs em vez de nomes: funciona com Windows em português ou inglês)
icacls C:\LIFTY\lifty_robot /inheritance:r /grant:r "*S-1-5-18:R" "*S-1-5-32-544:F"

# 4) firewall
New-NetFirewallRule -DisplayName "LIFTY 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
```

O serviço roda como **SYSTEM** (padrão do NSSM): por isso a chave fica em
`C:\LIFTY\lifty_robot` (a vigia procura primeiro ao lado do `.exe`). O
`robot_known_hosts` é criado sozinho na 1ª conexão.

## 8. Registrar o serviço

```powershell
C:\LIFTY\nssm.exe install LIFTY-SERVICE C:\LIFTY\LIFTY-SERVICE.exe
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppDirectory C:\LIFTY
C:\LIFTY\nssm.exe set LIFTY-SERVICE Start SERVICE_AUTO_START
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppStdout C:\LIFTY\logs\lifty.log
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppStderr C:\LIFTY\logs\lifty.log
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppRotateFiles 1
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppRotateBytes 10485760
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppExit Default Restart
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppRestartDelay 5000
# só depois de DESLIGAR o server.py da máquina antiga (seção 5):
C:\LIFTY\nssm.exe start LIFTY-SERVICE
```

## 9. Validação pós-migração

- [ ] Log (`C:\LIFTY\logs\lifty.log`): IP do robô encontrado e "Painel disponivel
      em http://localhost:8000".
- [ ] Em até ~1 min: `Bridge: no ar` no log (ou `Bridge: estava fora do ar --
      iniciado via SSH.`). Se aparecer `chave lifty_robot não encontrada`,
      `cliente ssh não instalado` ou `SSH falhou`, rever seção 7.
- [ ] **Teste da vigia** (robô ocioso): reiniciar o robô → depois do ROS subir, em
      até ~30 s o log mostra `iniciado via SSH` e
      `Test-NetConnection 192.168.5.195 -Port 8091` volta a dar True.
- [ ] Tarefa de verdade, robô acompanhado: enviar, ver a rota desenhada no mapa,
      acompanhar na Fila, cancelar (o garfo deve subir pra altura de navegação —
      log `Garfo -> altura de navegação`).
- [ ] **Dados vieram junto** (se algo faltar, o arquivo não foi copiado pra
      `C:\LIFTY\` — pare o serviço, copie, suba de novo; NÃO recalibre à mão):
  - [ ] login com um usuário que já existia (não `admin`/`admin`); Usuários
        lista os mesmos usuários, com os mesmos kanbans;
  - [ ] lotes e pontos no mesmo lugar e com os mesmos nomes;
  - [ ] Editar closes → "Ajustar grafo do robô": grafo com a mesma deformação
        (contador de pinos igual) e a rota com a mesma opacidade;
  - [ ] mesmas posições ocupadas (X) no mapa.
- [ ] Se um `users.json` novo foi criado: trocar a senha do `admin`.
- [ ] Guardar cópia dos arquivos de dados depois do 1º dia de uso real.
- [ ] Só então: desligar de vez a máquina antiga (idealmente mantê-la um tempo
      como reserva — **sem** o `server.py` rodando).

## 10. Atualizar o programa depois

1. Commit + `git push` → Actions → baixar `LIFTY-SERVICE-windows` (seções 1-2).
2. Com o robô ocioso: `nssm stop LIFTY-SERVICE`, trocar o `.exe` (mantendo os
   arquivos de dados e a chave), `nssm start LIFTY-SERVICE`.
3. Se a atualização mexeu em `robot-bridge/`: copiar o bridge novo pro robô
   (`scp` pro `~/lifty_turn_check_bridge.py`, com backup do anterior) e derrubar
   o processo antigo — a vigia sobe o novo sozinha.
