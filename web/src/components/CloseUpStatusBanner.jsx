// Mesmo retângulo semitransparente do RobotStatusBanner (ver esse arquivo),
// mas centro-INFERIOR da tela em vez de superior — indica qual área de
// Close Up o operador está olhando de perto. `name` já vem resolvido (ou
// null) do MainApp.jsx: aparece ao tocar um Close Up no modo Interação, ou
// ao visualizar uma tarefa da lista de envio; some ao sair do modo, resetar
// o zoom ou sair da visualização.
//
// `task` ("Visualizar tarefa", ver MainApp.jsx): `pickups`/`dropoffs` SÃO
// LISTAS (mesmo quando só existe um par — o chamador sempre empacota em
// lista de 1) — origem(ns) → destino(s), cada ponto clicável, tocar leva o
// mapa até o kanban onde ele está. Empilhado em duas colunas (origens,
// depois destinos) em vez de lado a lado quando há mais de um — caso do
// GRUPO de "Lotes em sequência" visualizado por inteiro (bug corrigido
// 2026-10-02: antes só mostrava o 1º par, como se o resto não existisse).
// `active` ({kind, index}) destaca qual ponto específico está sendo visto.
//
// `robot` ({ label, color }): o mapa está seguindo o robô (tocou no ícone
// dele, ver RobotOverlay.jsx) — "VISUALIZANDO: ROBÔ / STATUS: ...", com o
// status na mesma cor do brilho do ícone. Tem prioridade sobre `name` (tocar
// no robô já solta o kanban).
//
// `onToggleFlip`/`flipped` (TESTE, 2026-10-30): botão redondo ao lado do
// banner quando ele mostra um KANBAN — vira a visualização do mapa 180° (só
// neste aparelho), pra quem marca do outro lado do lote. Ver FloorPlanCanvas,
// "Girar a visualização".
export default function CloseUpStatusBanner({ name, task, robot, onFocusEndpoint, wide, flipped, onToggleFlip }) {
  if (!name && !task && !robot) return null;
  const showFlip = !!name && !robot && !!onToggleFlip;

  const className = 'closeup-status-banner'
    + (task ? ' closeup-status-banner--task' : '')
    + (wide ? ' closeup-status-banner--wide' : '');

  return (
    <div className={className} aria-hidden={task || showFlip ? undefined : 'true'}>
      {showFlip && (
        <button
          type="button"
          className={'closeup-flip' + (flipped ? ' is-active' : '')}
          onClick={onToggleFlip}
          aria-pressed={!!flipped}
          aria-label={flipped ? 'Desvirar o mapa' : 'Virar o mapa (ver do outro lado)'}
          title={flipped ? 'Desvirar o mapa' : 'Virar o mapa'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
            <path d="M4 4v4h4" />
            <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
            <path d="M20 20v-4h-4" />
          </svg>
        </button>
      )}
      <div>
        {/* Prefixo em destaque (mint vibrante), resto do texto em branco —
            pedido explícito do usuário, ver CONTEXT.md. */}
        <span className="closeup-status-banner__prefix">VISUALIZANDO</span>
        {robot ? (
          <span className="closeup-status-banner__rest">
            : ROBÔ / STATUS: <span style={robot.color ? { color: robot.color } : undefined}>{robot.label.toUpperCase()}</span>
          </span>
        ) : name && <span className="closeup-status-banner__rest">: KANBAN {name}</span>}
      </div>
      {task && (
        <div className={'closeup-status-banner__task' + (task.pickups.length > 1 || task.dropoffs.length > 1 ? ' closeup-status-banner__task--group' : '')}>
          {['pickup', 'dropoff'].map((kind, i) => {
            const labels = kind === 'pickup' ? task.pickups : task.dropoffs;
            return (
              <span key={kind} className="closeup-status-banner__task-stack">
                {i === 1 && <span className="closeup-status-banner__arrow">→</span>}
                <span className="closeup-status-banner__task-stack-items">
                  {labels.map((label, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={'closeup-status-banner__endpoint closeup-status-banner__endpoint--' + kind
                        + (task.active.kind === kind && task.active.index === idx ? ' is-active' : '')}
                      disabled={!label}
                      onClick={() => onFocusEndpoint(kind, idx)}
                      title={kind === 'pickup' ? 'Ver origem no mapa' : 'Ver destino no mapa'}
                    >
                      {label || '—'}
                    </button>
                  ))}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
