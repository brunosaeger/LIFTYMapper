# Migração do `server.py` pra uma VM — checklist

Contexto: hoje o `server.py` roda num computador local, ligado na mesma
rede wifi do robô (ex. `PALMARES_ADM`). A ideia é mudar pra uma VM do
servidor da empresa, com os tablets sempre apontando pro mesmo IP fixo —
sem depender de inicializar nada numa máquina local.

Esse documento responde três perguntas: o que passar pro técnico de
infra, o que você precisa saber dele, e quais cuidados extras pesam nessa
migração.

## 1. O que passar pro técnico da infra

**Material**:
- O código: `server.py` (a aplicação em si) e a pasta `web/dist/` (o
  frontend já compilado/pronto pra servir — ver abaixo, não precisa
  compilar de novo na VM).
- Os arquivos de **dados já existentes** da máquina atual — isso é tão
  importante quanto o código:
  - `calibration.json` (o mapa calibrado: pontos, lotes, kanbans)
  - `users.json` (as contas e senhas já cadastradas)
  - `route_log.json` (histórico de rotas)
  - `queue_state.json` (estado da fila — pode ir vazio/zerado, mas o ideal
    é migrar com o robô parado e a fila vazia, pra não perder nada no meio)
  - `session_secret.key` (chave que assina os cookies de sessão — se não
    migrar, todo mundo loga de novo, sem problema real, mas é bom saber)

  **Se esses arquivos não forem copiados, o `server.py` simplesmente cria
  tudo do zero (mapa vazio, sem usuários além do admin padrão)** — ele faz
  isso sozinho, mas não é o que você quer numa migração.

**Requisitos de ambiente pra passar pro técnico**:
- **Python 3** instalado na VM (testado com 3.12 nesta sessão; qualquer
  3.10+ deve servir — o `server.py` só usa biblioteca padrão do Python,
  nenhuma dependência externa pra instalar via pip).
- **Não precisa de Node.js/npm na VM**, desde que a pasta `web/dist/` já
  venha compilada (é só servir arquivo estático). Node só seria necessário
  se quiserem recompilar o frontend diretamente na VM no futuro.
- **Porta**: o servidor escuta na porta **8000** (`LISTEN_PORT` em
  `server.py`). O técnico precisa garantir que essa porta está liberada no
  firewall da VM.
- **Processo persistente**: pedir que `server.py` rode como **serviço**
  (systemd se a VM for Linux, ou Serviço do Windows / Tarefa Agendada no
  boot se for Windows) — não como um `python3 server.py` manual numa
  sessão de terminal, que morre ao desconectar. O serviço precisa:
  - iniciar sozinho quando a VM ligar/reiniciar;
  - reiniciar sozinho se o processo cair;
  - redirecionar a saída (stdout/stderr) pra um arquivo de log.

## 2. O que você precisa saber da infra (pro IP do tablet)

- **O IP fixo que a VM vai ter** dentro da rede acessível pelos tablets —
  peça que seja uma **reserva de DHCP** pelo MAC da VM (ou IP estático
  configurado nela), não um IP dinâmico qualquer. Esse é o endereço que
  vai pro atalho de todo tablet.
- **Confirmação de que os tablets alcançam essa VM**: pergunte
  explicitamente "um dispositivo na rede wifi dos tablets consegue acessar
  o IP da VM na porta 8000?" — isso não é garantido só por "estar na
  mesma empresa". Veja o cuidado #1 abaixo, é o ponto mais arriscado dessa
  migração.
- **Confirmação de que a VM alcança o robô**: pergunte se a VM tem rota de
  rede até o IP do robô (hoje algo como `192.168.5.195`, mas confirme o
  atual). Sem isso, o `server.py` não despacha tarefa nenhuma, mesmo
  rodando perfeitamente.

## 3. Cuidados que pesam nessa migração

1. **VLAN/segmentação de rede entre a VM e a rede wifi do chão de
   fábrica** — esse é o risco real, não o Python em si. VMs de servidor
   corporativo costumam viver numa rede de datacenter SEPARADA da rede
   wifi do chão de fábrica, por segurança. Se a VM não tiver rota
   liberada até os tablets E até o robô, nada funciona, mesmo com tudo
   configurado certo. Vale validar isso com a infra ANTES de desligar a
   máquina atual.
2. **Relógio da VM sincronizado (NTP)** — o histórico de rotas usa o
   horário da máquina que roda o `server.py` pra carimbar cada registro.
   Se o relógio da VM estiver errado, os horários no Histórico ficam
   errados.
3. **Não expor a porta 8000 pra internet** — o sistema foi desenhado pra
   rede local fechada (ver conversa anterior sobre dependência de rede vs.
   internet). Reforce com a infra que isso NÃO deve ter NAT/port-forward
   pra fora, nem ficar acessível fora da rede local da empresa.
4. **Testar ponta a ponta ANTES de trocar os atalhos de todos os
   tablets** — com a VM de pé, confirme que ela consegue falar com o robô
   (abrir o app, ver o status do robô ao vivo) antes de atualizar o
   atalho em cada tablet. Só depois disso desligar/aposentar a máquina
   antiga.
5. **Backup antes de migrar** — tire uma cópia dos arquivos de dados
   (item 1) e, se possível, um snapshot da VM recém-configurada, antes de
   depender dela em produção.
6. **Decidir o destino da máquina antiga** — mantê-la como standby por
   um tempo (caso a VM dê problema) é mais seguro do que desligar na hora.
