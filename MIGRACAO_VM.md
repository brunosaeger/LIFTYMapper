# Migração do LIFTY Mapper pra VM Windows — guia e checklist

> **DESATUALIZADO (2026-10-29): use o [`MIGRACAO_VM_FINAL.md`](MIGRACAO_VM_FINAL.md).**
> Este guia diz que a porta 8091 não é usada — hoje é, e a VM também precisa
> da porta 22 do robô e da chave SSH. Mantido só como histórico.

**Situação**: hoje o `server.py` roda numa máquina local ligada na wifi do
robô. O destino é uma VM **Windows Server 2019** da empresa (`aplsrv`, IP fixo
combinado: `192.168.5.252`), rodando um executável **sem interface**
(`LIFTY-SERVICE.exe`) registrado como **Serviço do Windows**. Os tablets passam
a abrir sempre o mesmo endereço: **`http://192.168.5.252:8000`** (confirmar o IP
na seção 4 antes de configurar qualquer atalho).

Tudo é um programa só: o `LIFTY-SERVICE.exe` serve o app dos tablets, guarda os
dados e fala com o robô. Não precisa instalar Python, Node nem nada na VM.

---

## 1. Gerar o executável (você, uma vez, e a cada atualização)

O `.exe` só pode ser compilado num Windows — o GitHub Actions faz isso de graça.

1. Garanta que o código está commitado e enviado: `git push origin main`.
2. No GitHub: repositório `brunosaeger/LIFTYMapper` → aba **Actions** →
   workflow **"Build LIFTY.exe"** → **Run workflow**.
3. Quando terminar, baixe o artefato **`LIFTY-SERVICE-windows`** (é um zip com o
   `LIFTY-SERVICE.exe`). O outro artefato (`LIFTY-windows`) é a versão com janela
   e **não** é a que vai pra VM.
4. Esse `.exe` já leva dentro o app compilado (`web/dist`), os manuais, os
   ícones e os sons.

> Antivírus/SmartScreen podem estranhar um `.exe` sem assinatura digital. Peça
> pra infra liberar o arquivo (exceção por caminho) antes de registrar o serviço.

## 2. O que entregar pro técnico de infra

**Arquivos**
- `LIFTY-SERVICE.exe` (artefato do passo 1).
- `nssm.exe` (https://nssm.cc/ — o infra pode baixar; é quem transforma o `.exe`
  em serviço).
- Os **arquivos de dados desta máquina** (copiar pra mesma pasta do `.exe`) —
  são tão importantes quanto o código, e **não estão no GitHub** (de propósito):
  | Arquivo | O que é | Obrigatório? |
  |---|---|---|
  | `calibration.json` | o mapa calibrado: pontos, lotes, kanbans, ocupação | **sim** |
  | `users.json` | contas e senhas já criadas | **sim** |
  | `session_secret.key` | chave que assina os logins (sem ela todo mundo só loga de novo) | recomendado |
  | `route_log.json` | histórico de rotas | opcional |
  | `queue_state.json` | fila | **não levar** — o servidor limpa a fila toda vez que sobe |
  | `robot_host.txt` | IP do robô (ver seção 3, item "robô") | opcional, recomendado |

  Sem `calibration.json`/`users.json`, o servidor cria tudo do zero (mapa
  de fábrica e o usuário **`admin` com senha `admin`**). Evite: leve os
  arquivos (ou, num install realmente novo, **troque a senha do `admin` no
  1º acesso**).

**Pedidos pra infra** (cada um tem um motivo):
1. **Pasta própria com escrita**, por exemplo `C:\LIFTY\` — **não** em
   `Program Files`. O serviço grava os arquivos de dados ao lado do `.exe`.
2. **Serviço do Windows** via NSSM, iniciando sozinho no boot e reiniciando se
   cair (comandos na seção 5).
3. **IP fixo da VM**: reserva por MAC no DHCP **ou** IP estático configurado na
   VM — não um IP dinâmico qualquer. É o endereço que vai no atalho dos tablets.
4. **Firewall da VM**: liberar entrada **TCP 8000**.
5. **Rotas de rede (o ponto mais arriscado)**:
   - **tablets → VM**, porta 8000. Pergunte explicitamente: "um aparelho na
     wifi dos tablets consegue abrir `http://192.168.5.252:8000`?".
   - **VM → robô**, porta **80** (API do dispatch e SLAM). Sem isso o servidor
     roda, mas nenhuma tarefa é despachada. (A porta 8091, do bridge de "posso
     girar aqui?", **não é usada** — ver "Bridge" abaixo.)
   - VMs de datacenter costumam ficar em rede separada da wifi do chão de fábrica
     por segurança: validar **antes** de desligar a máquina atual.
6. **Relógio sincronizado (NTP)** — o histórico carimba horários com o relógio
   da VM.
7. **Não expor a porta 8000 pra internet** (sem NAT/port-forward). O sistema foi
   desenhado pra rede local fechada, em HTTP simples.
8. **Antivírus**: exceção pra `C:\LIFTY\LIFTY-SERVICE.exe`.
9. **Backup**: snapshot da VM e cópia periódica dos arquivos de dados acima.
10. **Acesso remoto** pra você (RDP) à VM, pra ver o log e reiniciar o serviço.

## 3. Pontos de atenção (o que eu verifiquei no código)

- **Executável sem interface**: o `lifty_headless.spec` empacota o próprio
  `server.py`. Ao subir ele faz, sozinho: descoberta do IP do robô, limpeza da
  fila antiga (cancelando no robô a "próxima rota" que tivesse sobrado), e fica
  escutando em `0.0.0.0:8000`. Não precisa de ninguém clicando.
- **Dados ficam ao lado do `.exe`** (não na pasta temporária), então reiniciar a
  VM ou atualizar o `.exe` **não perde nada** — desde que a pasta seja mantida.
- **Ao subir, a fila é descartada** de propósito: reiniciar o serviço (ou a VM)
  cancela o que estava esperando, pra o robô não começar tarefa velha. Uma rota
  **em andamento** já disparada é mantida e conferida contra o robô.
- **IP do robô (`192.168.5.195` hoje)**: se `robot_host.txt` existir com o IP, o
  servidor usa direto. Se o robô trocar de IP, ele varre a rede /24 da VM (254
  endereços, ~3 s) procurando quem responde — **isso só funciona se a VM e o
  robô estiverem na mesma faixa `192.168.5.x`**. Pra evitar essa varredura
  (que alguns firewalls leem como "port scan"), peça uma **reserva de DHCP pro
  robô** também e deixe o `robot_host.txt` com o IP dele.
- **Bridge do robô (porta 8091): NÃO usado** (decisão do usuário, 2026-10-15).
  A checagem de "giro seguro" está desligada no `server.py`
  (`TURN_CHECK_ENABLED = False`): as rotas começam e os cancelamentos acontecem
  sem esperar essa confirmação, sem abrir conexão nenhuma na 8091. Não precisa
  liberar essa porta nem subir nada no robô. (Pra voltar a usar: ligar a
  constante e rodar o `robot-bridge/` no robô.)
- **Duas correções que fiz agora no `server.py`** (só pra rodar como serviço no
  Windows, sem mexer em nada de fila/robô):
  1. **Saída sempre em UTF-8**: as mensagens de erro do dispatch vêm em chinês; no
     Windows, com a saída redirecionada pra arquivo, isso podia gerar erro dentro
     de um tratamento de erro e derrubar a thread da fila.
  2. **Tipos de arquivo (MIME) explícitos**: no Windows o Python consulta o
     registro; em máquina com registro "sujo" um `.js` sai como `text/plain` e o
     navegador **recusa o app (tela em branco)**.
- **Primeira execução sem `users.json`** cria o usuário `admin` com senha `admin`
  (o log avisa). Levando o `users.json`, isso não acontece. Numa instalação
  nova, o 1º passo é trocar essa senha pela tela de Usuários.
- **Log**: o serviço imprime uma linha por requisição (cada tablet consulta a
  cada 4 s) — configure rotação de log no NSSM (seção 5), senão cresce sem parar.
- **Executável "onefile"**: a cada início ele se extrai numa pasta temporária
  (`_MEIxxxxx`, ~25 MB). Num reinício normal ele limpa; se o processo for
  morto à força, a pasta fica. Irrelevante pra poucos reinícios; se virar
  problema, dá pra gerar uma versão "onedir".
- **Sem HTTPS**: de propósito (rede industrial local). Os tablets abrem
  `http://IP:8000`. O Chrome mostra "não seguro" — é esperado.

## 4. Checklist: descobrir/confirmar o IP que vai no atalho dos tablets

O endereço é o IP da **VM** (não o do robô), porta 8000. Todos os tablets usam
o **mesmo** endereço.

- [ ] Infra confirmou **por escrito** o IP da VM e que é **fixo** (reserva por MAC
      ou estático). IP previsto: `192.168.5.252`. ____________
- [ ] Na VM (PowerShell): `ipconfig /all` → o "Endereço IPv4" bate com o
      combinado, e em "DHCP habilitado" aparece **Não** (estático) — ou a infra
      mostra a reserva por MAC.
- [ ] Na VM: o serviço está rodando — `Get-Service LIFTY-SERVICE` → `Running`.
- [ ] Na VM: `Test-NetConnection 192.168.5.195 -Port 80` → `TcpTestSucceeded: True`
      (VM alcança o robô). A 8091 não é usada.
- [ ] Na própria VM: abrir `http://localhost:8000` → aparece a tela de login.
- [ ] **De um tablet, na wifi do chão de fábrica**: abrir
      `http://192.168.5.252:8000` no Chrome → aparece a tela de login. **Este é o
      teste que decide tudo** — se falhar aqui e funcionar na VM, é rede/firewall,
      não o programa.
- [ ] Logar com um usuário e ver o status do robô ao vivo (barra no topo mostra
      carga/bateria) → prova que a VM está falando com o robô.
- [ ] Só então: em **cada tablet**, no Chrome, abrir `http://192.168.5.252:8000` →
      menu (⋮) → **Adicionar à tela inicial**. (Apague o atalho antigo antes —
      o Chrome grava o ícone na criação.)
- [ ] Testar uma tarefa de verdade, com o robô parado e acompanhado: enviar,
      acompanhar na Fila, cancelar.
- [ ] Só depois de tudo isso: desligar a máquina antiga (idealmente deixá-la um
      tempo como reserva).

Dica: se o IP um dia mudar, **todos os atalhos precisam ser refeitos**. Por isso
a reserva fixa é tão importante. (Usar o nome `aplsrv` em vez do IP só funciona
se o DNS da wifi dos tablets resolver esse nome — não conte com isso.)

## 5. Registrar como serviço (PowerShell como administrador, na VM)

```powershell
# 1) copie LIFTY-SERVICE.exe, nssm.exe e os arquivos de dados pra C:\LIFTY\
mkdir C:\LIFTY\logs

# 2) firewall
New-NetFirewallRule -DisplayName "LIFTY 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow

# 3) serviço
C:\LIFTY\nssm.exe install LIFTY-SERVICE C:\LIFTY\LIFTY-SERVICE.exe
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppDirectory C:\LIFTY
C:\LIFTY\nssm.exe set LIFTY-SERVICE Start SERVICE_AUTO_START
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppStdout C:\LIFTY\logs\lifty.log
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppStderr C:\LIFTY\logs\lifty.log
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppRotateFiles 1
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppRotateBytes 10485760
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppExit Default Restart
C:\LIFTY\nssm.exe set LIFTY-SERVICE AppRestartDelay 5000
C:\LIFTY\nssm.exe start LIFTY-SERVICE
```

Pra atualizar o programa depois: `nssm stop LIFTY-SERVICE`, trocar o `.exe`
(mantendo os arquivos de dados), `nssm start LIFTY-SERVICE`. Parar/subir o
serviço descarta a fila (ver seção 3) — faça com o robô ocioso.

## 6. Pós-migração

- Conferir o log (`C:\LIFTY\logs\lifty.log`): deve mostrar o IP do robô
  encontrado e "Painel disponivel em http://localhost:8000".
- Se um `users.json` novo foi criado (`admin` / `admin`), **trocar a senha do
  `admin`** pela tela de Usuários antes de liberar o endereço pros operadores.
- Guardar uma cópia dos arquivos de dados num lugar seguro depois do primeiro dia
  de uso real.
