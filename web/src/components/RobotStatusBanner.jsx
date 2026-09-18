// Ícone de pilha (4 "pauzinhos") — quantos acendem e a cor mudam com o
// nível: <20% vermelho (crítico), <50% âmbar (atenção), senão mint (bom).
// Barras que não acendem ficam num traço fraco só pra dar a forma da pilha
// inteira (senão pareceria quebrada com poucos % de carga).
function batteryColor(pct) {
  if (pct < 20) return 'var(--state-error)';
  if (pct < 50) return 'var(--accent-amber)';
  return 'var(--accent-cyan)';
}

function BatteryIcon({ pct }) {
  const color = batteryColor(pct);
  const barsLit = pct <= 0 ? 0 : Math.min(4, Math.ceil(pct / 25));
  return (
    <svg viewBox="0 0 26 14" width="22" height="12" aria-hidden="true">
      <rect x="0.75" y="0.75" width="21.5" height="12.5" rx="2.5" fill="none" stroke={color} strokeWidth="1.5" />
      <rect x="23" y="4" width="3" height="6" rx="1" fill={color} />
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={3.5 + i * 4.5}
          y="3"
          width="3"
          height="8"
          rx="0.75"
          fill={i < barsLit ? color : 'none'}
          opacity={i < barsLit ? 1 : 0.35}
          stroke={i < barsLit ? 'none' : color}
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}

// Retângulo semitransparente centralizado sobre o mapa — indicação rápida
// de longe (chão de fábrica) do que o robô está fazendo. Lógica BINÁRIA de
// propósito por enquanto (ver CONTEXT.md): `charging` vem de
// GET /reeman/base_encode (chargeFlag==2, confirmado em campo 2026-09-14),
// sondado pela thread de fundo — este componente só lê o que já veio no
// /api/live-state, nunca fala com o robô direto.
//
// `charging` null = servidor ainda não conseguiu ler o robô (boot, ou
// robô fora do ar) — não mostra nada em vez de arriscar um rótulo errado.
// `battery` (0-100 ou null — ver server.py, _normalize_battery, campo
// documentado mas NÃO confirmado em campo ainda) some sozinho se vier
// null: o resto do banner continua funcionando normal sem ele.
export default function RobotStatusBanner({ charging, battery }) {
  if (charging === null || charging === undefined) return null;
  const hasBattery = typeof battery === 'number';

  return (
    <div className={'robot-status-banner' + (charging ? ' is-charging' : '')} aria-hidden="true">
      <span className="robot-status-banner__dot" />
      {/* "ROBÔ" na cor neutra das abas do header (Editar pontos/Histórico/
          Usuários); o status em si (mint = operando, âmbar = recarregando)
          — ver .robot-status-banner__status no CSS. */}
      <span className="robot-status-banner__label">Robô:</span>
      <span className="robot-status-banner__status">{charging ? 'Recarregando' : 'Em Operação'}</span>
      {hasBattery && (
        <span className="robot-status-banner__battery">
          <BatteryIcon pct={battery} />
          <span className="robot-status-banner__battery-pct" style={{ color: batteryColor(battery) }}>{battery}%</span>
        </span>
      )}
    </div>
  );
}
