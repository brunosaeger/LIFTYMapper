// Retângulo semitransparente centralizado sobre o mapa — indicação rápida
// de longe (chão de fábrica) do que o robô está fazendo. Lógica BINÁRIA de
// propósito por enquanto (ver CONTEXT.md): `charging` vem de
// GET /reeman/base_encode (chargeFlag==2, confirmado em campo 2026-09-14),
// sondado pela thread de fundo — este componente só lê o que já veio no
// /api/live-state, nunca fala com o robô direto.
//
// `charging` null = servidor ainda não conseguiu ler o robô (boot, ou
// robô fora do ar) — não mostra nada em vez de arriscar um rótulo errado.
export default function RobotStatusBanner({ charging }) {
  if (charging === null || charging === undefined) return null;

  return (
    <div className={'robot-status-banner' + (charging ? ' is-charging' : '')} aria-hidden="true">
      <span className="robot-status-banner__dot" />
      {/* "ROBÔ" na cor neutra das abas do header (Editar pontos/Histórico/
          Usuários); o status em si (mint = operando, âmbar = recarregando)
          — ver .robot-status-banner__status no CSS. */}
      <span className="robot-status-banner__label">Robô:</span>
      <span className="robot-status-banner__status">{charging ? 'Recarregando' : 'Em Operação'}</span>
    </div>
  );
}
