# Ocupação, material do pallet e regra de fronteira

Onde tem pallet, de que material, e por onde o robô pode entrar num lote.
Ocupação é **global** (fato físico do armazém, não por vista).

Ler junto: [fila.md](fila.md) (quem marca sozinho e valida a cadeia),
[ponto-a-ponto.md](ponto-a-ponto.md) (validação no clique),
[mapa.md](mapa.md) (desenho), [usuarios.md](usuarios.md) (kanban),
[chat-solicitacoes.md](chat-solicitacoes.md) (marcas amarelas que saem
quando a posição é ocupada/limpa).

## Dados (`calibration.json`)

- `occupied`: lista de nomes técnicos ocupados.
- `palletMaterials` {nome: `"wood"|"blue"`} — só pra posição ocupada;
  `_prune_pallet_materials` (em TODA gravação, `_write_calibration`) apaga
  material de posição vazia.
- `palletHeights` {`blueBase`, `blueTop`} — altura do azul (`blueBase`
  padrão 7, `PALLET_BASE_HEIGHT_DEFAULT`). Editada em "Altura de pallets"
  (modo dev, `PalletHeightsPanel`, `POST /api/pallet-heights`). Aceita uma
  casa decimal (template `...MT6_5`), **mas o app do robô trunca**: 6,5 cm
  vira 60 mm — só cm inteiros importam.
- O `POST /api/calibration` do editor **preserva** do disco `occupied`,
  `palletMaterials`, `palletHeights` (o cliente nem manda) — senão editar um
  ponto apagaria a ocupação de todo mundo.
- Toda mudança de ocupação passa por `_write_calibration` sob
  `CALIBRATION_LOCK` (mutação cirúrgica; o antigo snapshot inteiro perdia
  marcações concorrentes).

Endpoints: `POST /api/occupied/set`, `/set-many`, `/material {names,
material|null}` (`set_pallet_material_many`: material = marca e ocupa; null
= esvazia).

## Marcação (modo `mark`, `OccupancyPanel.jsx`)

- Pincel de material: Madeira / Azul / "Remover marcação" (X). Nada
  escolhido = remover. Tocar aplica; tocar numa posição que já tem esse
  material a esvazia.
- **Só clique** (desde 2026-11-13): o gesto marca o quadrado onde começou;
  sair pra outro anula. A maquinaria de arrasto continua no código mas
  nunca passa de 1 quadrado.
- Desenho: fundo vivo na cor do lote (`MATERIAL_FILL_ALPHA` 0,85) + textura
  (madeira `pallet-wood.png`; azul no mapa `pallet-blue-map.jpg`, botões
  `pallet-blue.png`). X = ocupação antiga SEM material (o painel conta).
- **Kanban**: usuário restrito só marca células dos kanbans dele (+ os
  livres); pontos avulsos laranja são livres pra todos. Gate no servidor
  (`_reject_outside_kanban`, 403 com `denied`) → toast + pulso.
- **Posições reservadas** (`_reserved_positions`, no live-state): origem
  (até a coleta) e destino de rota atual/pendente/na fila e destino de
  devolução. Os POSTs de marcação recusam (`_reject_reserved`: grava só as
  livres e devolve `blocked`; tudo reservado = 409). Motivo: a rota leva o
  material congelado no envio. Gravações do robô não passam por essa trava.
- Depois de marcar, o site relê o chat na hora (`chat.hideRequests` +
  `chat.confirm`) — a marca amarela de solicitação some no ato.

## Marcação automática pelo robô ("Caso 2", no `_queue_tick`)

- PICKUP com `finishTime` **e** status ≠ CANCELLED (da ação e da task) →
  desocupa a origem (`pickupCleared`). `finishTime` também é carimbado no
  cancelamento — já mordeu: apagava o X de um pallet que continuava lá.
- Task `FINISHED` → ocupa o destino **com o `palletType` da rota**.
- `pickupCleared` é gravado na hora (antes só ia pro disco quando a fila
  avançava).

## Regra de fronteira ("Caso 3")

Dentro do MESMO lote (não entre lotes): o robô entra numa coluna só por uma
ponta. Ocupada bloqueia qualquer posição "atrás" (índice maior) como
DESTINO e qualquer "antes" como ORIGEM.
- Validada nos dois lados: `isPickupAllowed`/`isDropoffAllowed` (MainApp,
  feedback no clique) e `is_pickup_allowed`/`is_dropoff_allowed` +
  `validate_route_chain` (server.py, **o gate de verdade**, vista `top`).
- **Ocupação projetada**: cada tarefa de um envio é validada contra o
  armazém como ele ESTARÁ quando ela rodar (`projectedOccupancy` /
  `validate_route_chain`). É por isso que `A → A2 → A3` vale na origem e
  `B3 → B2 → B` no destino — o mesmo princípio dos dois lados.
- "Buraco" na coluna vale (A e A3 ocupados, A2 vazio: pegar A3 depois de A).
- **Pontos avulsos** (quadrados laranja, "lotes curinga" de uma célula):
  sem regra de ordem, mas coleta exige ocupado e entrega exige livre (já
  houve bug de `return true` antecipado pulando isso). Mensagens próprias
  ("não tem pallet marcado ali" / "já tem pallet ali").

## Material na tarefa

O Ponto a Ponto não escolhe pallet: cada tarefa usa o material marcado na
ORIGEM, ou o que uma tarefa anterior da mesma lista entrega ali
(`materialForPickup`/`fillMaterials` em MainApp). Origem sem material =
recusada. Na lista de envio dá pra trocar o pallet de uma tarefa; isso muda
a marcação da origem (se o pallet já está lá) e as tarefas seguintes que
levam o mesmo pallet.

**"Pallet de cima"** (2º andar do azul, camada 3, `blueTop`): DORMENTE —
`const palletTop = false` no MainApp; o servidor ainda sabe montar. A versão
com a caixinha está no branch local `experimento/destino-segundo-andar`
(`dde6bdf`, não enviado). Reativar = devolver os checkboxes.

## Pendências registradas

Remarcar todo o armazém com material (ocupação zerada em testes de 30/10 —
sem material nenhuma tarefa sai); validar em campo coleta azul e madeira
com a altura vinda da marcação; manual REV-01 pág. 26 ainda fala em
"toque e arraste" e em escolher pallet no Ponto a Ponto.
