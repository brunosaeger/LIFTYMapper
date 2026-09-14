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
      {charging ? 'Robô: Recarregando' : 'Robô: Em Operação'}
    </div>
  );
}
