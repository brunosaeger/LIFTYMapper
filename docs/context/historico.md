# Histórico de rotas e erros do robô

`web/src/components/HistoryPanel.jsx` (`mode === 'history'`; aba visível
pra admin ou no modo desenvolvedor — Mestre/comum não veem),
`server.py` (`log_route_requested`/`log_route_completed`, `route_log.json`).

Ler junto: [fila.md](fila.md) (quem grava), [ponto-a-ponto.md](ponto-a-ponto.md)
(banner VISUALIZANDO), [robo-api.md](robo-api.md) (`/error/records`).

## Histórico de rotas

- Gravado pelo próprio servidor quando a fila dispara/conclui (não por
  POST do cliente). Hora = relógio da máquina do `server.py`. Campo `user` =
  usuário da sessão que enfileirou. `route_log.json` (gitignored), capado em
  500 entradas. `GET /api/route-log`.
- UNLOAD isolado (pós-cancelamento) tem `pickup: null` → "Descarregando em:
  X". Tags `CANCELADA`/`FALHOU`.
- Filtros 100% no cliente, combináveis: data (`<input type="date">`
  invisível por cima do ícone — no Android tocar abre o calendário nativo),
  horário de/até, conta (sugestões dos nomes vistos). Apelido via
  `displayCellName`.
- Clicar numa rota = destaque + zoom + banner VISUALIZANDO + traçado
  estático no mapa (`highlightsRoute` precisa incluir `'history'` — já foi
  o bug).

## Erros e avisos do robô

`GET /error/records` pelo proxy (`fetchErrorRecords` em `api/lifty.js`,
`PROJECT_ID` 15), página mais recente (`size=30`, sem paginação).
Tradução: glossário `KNOWN_PHRASES`/`ERROR_LABELS`; rede de segurança
`HAN_CHARS` — sobrou caractere chinês, a mensagem vira aviso genérico em
PT-BR com o código (nenhum mandarim chega na tela). Sem cache nosso.

## Backlog (24/11, discutir antes de codar)

Tempo despendido por tarefa e, abaixo do título ao lado do relógio, tempo
médio por tarefa — desconsiderando canceladas e tarefas de organização
(dentro do mesmo kanban/close).
