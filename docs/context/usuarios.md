# Login, usuários, kanbans e horário de operação

Ler junto: [fila.md](fila.md) (onde as permissões são aplicadas),
[ocupacao.md](ocupacao.md) (kanban na marcação), [servidor.md](servidor.md).

## Login e sessão (`server.py`)

- `users.json` (gitignored, **nunca commitar nem compartilhar**):
  `{username, passwordHash, isAdmin, isMaster, kanbanIds, failedAttempts,
  locked, theme, fullscreen}`. Senha: PBKDF2-HMAC-SHA256, salt por usuário,
  200k iterações (`hash_password`/`verify_password`). Não dá pra mostrar
  senha existente.
- Primeiro boot sem `users.json`: cria `admin` com senha aleatória impressa
  no console uma vez (`_bootstrap_users_if_missing`).
- Sessão = cookie HttpOnly assinado (HMAC com `session_secret.key`,
  gitignored), `usuário:validade`, 30 dias. Sobrevive a restart.
- Tudo atrás de `_require_auth`, exceto os estáticos (`web/dist`) e o login.
  `_require_admin` pros endpoints de admin. HTTP puro é aceito (rede
  isolada) — senha trafega em claro na LAN.
- 3 senhas erradas seguidas bloqueiam a conta (HTTP 423, `LOGIN_MAX_ATTEMPTS`);
  só admin desbloqueia (`PUT /api/users/{u}` `{locked:false}`, zera o
  contador). **Admin nunca bloqueia.** Promover a admin desbloqueia.
- Nunca deixa zerar o último admin nem excluir o próprio usuário logado.
- Endpoints: `POST /api/login`, `/api/logout`, `GET /api/session`,
  `POST /api/session/theme`, `/api/session/fullscreen` (só o próprio
  usuário), `GET/POST /api/users`, `PUT/DELETE /api/users/{u}`.
- `route["user"]` e o histórico usam o usuário da SESSÃO, nunca do payload.

## Papéis

| Papel | Pode |
|---|---|
| Admin | tudo; aba Usuários e Histórico; horário de operação; limit breaker |
| Mestre (`isMaster`) | qualquer kanban, cancela/remove qualquer tarefa, limpar fila; **não** vê Histórico/Usuários |
| Comum | só RETIRA (origem) e marca nos kanbans dele; entrega em qualquer lugar |

- Comum precisa de **pelo menos um kanban já na criação** (400 sem). Conta
  comum antiga sem nenhum kanban = sem restrição.
- Kanbans guardados por **id** do Close Up (nome pode mudar).
  `FREE_KANBAN_IDS` = "SAÍDAS 69/71" e "SAÍDAS 47,40,61,52,35": livres pra
  todos, nunca aparecem na lista (`GET /api/kanbans`).
- Geometria no servidor (`_closeup_id_for_name`, `_user_can_pick_up_from`,
  `_user_can_mark`): mesma conta do front (`contentPositionOf` /
  `closeUpContaining`, o menor Close Up que contém). Pontos avulsos laranja
  ficam livres na marcação.
- Gates: enqueue (todas as origens do lote), cancel-current, remove-queued,
  reorder, marcação (403 com `denied`). `_read_calibration()` feito ANTES
  de entrar no `QUEUE_LOCK` (nunca aninhar CALIBRATION dentro de QUEUE).

## Aba Usuários (`UsersPanel.jsx`, `mode === 'users'`, só admin)

Gated por `user.isAdmin` da sessão — independente do modo desenvolvedor.
Lista, admin/mestre, troca de senha, exclusão, 🔒 clicável pra desbloquear,
`KanbanPicker` (chips; escolher foca o kanban no mapa com contorno
tracejado — `closeUpFocusRequest`, `CloseUpMarker previewing`). Sem
"esqueci minha senha". Busca e senhas com `autoComplete` off/`new-password`
(o gerenciador do PC preenchia a busca); olhinho nas senhas novas.

## Horário de operação (seção no topo da aba Usuários)

- `operation_hours.json` (`manual`, `start`, `end`; gitignored, entra no
  exportar-dados). Relógio da VM. `GET/POST /api/operation-hours` (POST
  admin).
- A faixa é a de OPERAÇÃO ("Opera a partir das" / "Até as" — o usuário
  corrigiu: não é faixa de recusa). Bloqueado = manual OU fora da faixa;
  fora dela o switch "Recusar tarefas do robô" aparece ligado e travado.
  Faixa pode virar a meia-noite; só início = até 00:00; só fim = desde
  00:00; início = fim recusado.
- Gate só em `enqueue-batch` (409, `operationBlocked: true`), só tarefa
  NOVA; o que já está na fila segue. Admin também é barrado.
- Mensagem por proximidade circular da borda: "Tarefa recusada - Não é
  permitido operação após as {fim}." / "...antes das {início}." / "...
  desligado pelo administrador." (`_operation_status`).

## Preferências por conta

Tema (`theme`, padrão `dark`) e tela cheia (`fullscreen`) vêm na sessão;
`App.jsx` repassa a resposta INTEIRA do login/sessão (já mordeu: escolher
campos a dedo descartava o tema). Tela cheia só entra num gesto do usuário
— o próximo toque em qualquer lugar satisfaz. Tela de login é sempre escura.
Modo desenvolvedor persiste por conta no `localStorage`
(`lifty.devMode.<user>`), é só trava de UI (senha `DEV_PASSWORD` no bundle).
