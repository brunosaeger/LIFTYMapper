# LIFTY Mapper — índice de contexto

Painel de controle de uma empilhadeira autônoma REEMAN (`rbot55f`, Hercules
3.0) num armazém com lotes de pallets. `server.py` (Python puro, zero
dependências) é a autoridade da fila e fala com o robô; o site React (`web/`)
roda nos tablets dos operadores (~10). **Em produção na fábrica (Palmares)**,
numa VM Windows (`192.168.5.252`, serviço `LIFTY-SERVICE`) — mudança no
servidor é mudança de produção.

## Diretriz: leia antes de mexer

1. **Antes de alterar uma funcionalidade, leia o contexto dela** (tabela
   abaixo) **e os contextos listados em "Depende de / conflita com"**. Cada
   subcontexto também tem um "Ler junto" no topo.
2. Leia só o necessário — não abra o código inteiro procurando o que um
   contexto já responde.
3. Depois de mudar, **atualize o subcontexto** no mesmo trabalho (o que mudou,
   por quê, armadilhas novas). Funcionalidade nova sem lugar → crie um
   subcontexto novo e acrescente uma linha aqui.
4. Contexto é o estado ATUAL + o porquê + erros que não podem voltar. Nada
   de diário de sessão, investigação encerrada ou código removido (o git
   guarda a história). Se algo deixou de valer, apague.
5. Ao terminar uma alteração, confira se o contexto bate com o código.

## Mapa de contextos

| Funcionalidade | Contexto | Depende de / conflita com |
|---|---|---|
| Servidor: execução, arquivos de dados, modo teste, encoding, IP do robô | [docs/context/servidor.md](docs/context/servidor.md) | packaging, usuarios |
| API do robô (dispatch + SLAM), comportamentos e diagnóstico de erros | [docs/context/robo-api.md](docs/context/robo-api.md) | fila, avisos-robo, robot-bridge |
| Fila, disparo, cancelamento, pós-pickup, AUTO_SYSTEM, garfo, limpezas | [docs/context/fila.md](docs/context/fila.md) | robo-api, ocupacao, avisos-robo, robot-bridge, usuarios |
| Status e avisos do robô (banner, obstáculo, câmera, planejando, sons) | [docs/context/avisos-robo.md](docs/context/avisos-robo.md) | fila, robot-bridge, mapa |
| Ocupação, material, regra de fronteira, posições reservadas | [docs/context/ocupacao.md](docs/context/ocupacao.md) | fila, ponto-a-ponto, usuarios, chat-solicitacoes |
| Ponto a Ponto, lista de envio, Visualizar, painel Fila | [docs/context/ponto-a-ponto.md](docs/context/ponto-a-ponto.md) | ocupacao, fila, mapa, web |
| Mapa (Konva): calibração, zoom, gestos, robô ao vivo, grafo | [docs/context/mapa.md](docs/context/mapa.md) | web, ponto-a-ponto, ocupacao, usuarios (geometria de kanban) |
| Login, papéis, kanbans, horário de operação, preferências | [docs/context/usuarios.md](docs/context/usuarios.md) | fila, ocupacao, servidor |
| Chat geral e Solicitação de pallets | [docs/context/chat-solicitacoes.md](docs/context/chat-solicitacoes.md) | ocupacao, mapa, web |
| Histórico de rotas e erros do robô | [docs/context/historico.md](docs/context/historico.md) | fila, ponto-a-ponto |
| Site: arquitetura, modos, peek modes, modo dev, padrões de UI | [web/CONTEXT.md](web/CONTEXT.md) | todos os de front |
| Bridge no robô (ROS/SSH), vigia do bridge, regras do robô | [robot-bridge/CONTEXT.md](robot-bridge/CONTEXT.md) | fila, avisos-robo, robo-api |
| Empacotamento, VM, CI, scripts de instalação/atualização | [packaging/CONTEXT.md](packaging/CONTEXT.md) | servidor, robot-bridge |

Fora do mapa: `MIGRACAO_VM_FINAL.md` (guia da VM), `legacy/` (versão antiga,
não servida), `docss/` (PDFs do fabricante), `robot_simulator.py`.

O antigo `CONTEXT.md` (5,7 mil linhas) foi distribuído nestes subcontextos em
2026-11-26 e apagado (o histórico completo está no git, commit `a338486`).
Os comentários do código apontam pro subcontexto certo (ex.: "ver
docs/context/fila.md, ..."). O nome de seção entre aspas que alguns citam é
do arquivo antigo e pode não existir igual no novo — procure o termo no
subcontexto apontado. Comentário novo: apontar pro subcontexto, nunca pro
`CONTEXT.md`.

## Regras permanentes (do usuário)

- **Robô**: só leitura por padrão. Nunca alterar arquivo da REEMAN, nunca
  mexer em boot/systemd/firewall/rede do robô; comandos de escrita, `sudo`,
  instalar algo ou abrir porta só com acordo explícito. Detalhes em
  [robot-bridge/CONTEXT.md](robot-bridge/CONTEXT.md).
- **Teste local sempre com `python server.py --teste`** — nunca dois
  servidores falando com o mesmo robô. Nunca reiniciar o servidor com rota
  em andamento ou na fila.
- **Commit, push, tag e atualizar a VM só quando o usuário pedir.**
- Nunca commitar/compartilhar dados (`users.json`, `session_secret.key`,
  chave SSH `lifty_robot`, `*.json` de estado), `tools/`, `tools/field-data`
  nem `reemansniff.md`. Nenhuma senha ou credencial em arquivo.
- Backup antes de editar qualquer configuração.
- Reversão de trabalho: confirmar o escopo antes de descartar.
- Respostas ao usuário: português, curtas e diretas.
