// Mesmo retângulo semitransparente do RobotStatusBanner (ver esse arquivo),
// mas centro-INFERIOR da tela em vez de superior — indica qual área de
// Close Up o operador está olhando de perto. `name` já vem resolvido (ou
// null) do MainApp.jsx: aparece ao tocar um Close Up no modo Interação, ou
// ao visualizar uma tarefa da lista de envio; some ao sair do modo, resetar
// o zoom ou sair da visualização.
//
// `task` ("Visualizar tarefa", ver MainApp.jsx): segunda linha com
// ORIGEM → DESTINO, cada um clicável — tocar leva o mapa até o kanban onde
// aquele ponto está. `active` destaca qual das duas pontas está sendo vista.
export default function CloseUpStatusBanner({ name, task, onFocusEndpoint, wide }) {
  if (!name && !task) return null;

  const className = 'closeup-status-banner'
    + (task ? ' closeup-status-banner--task' : '')
    + (wide ? ' closeup-status-banner--wide' : '');

  return (
    <div className={className} aria-hidden={task ? undefined : 'true'}>
      <div>
        {/* Prefixo em destaque (mint vibrante), resto do texto em branco —
            pedido explícito do usuário, ver CONTEXT.md. */}
        <span className="closeup-status-banner__prefix">VISUALIZANDO</span>
        {name && <span className="closeup-status-banner__rest">: KANBAN {name}</span>}
      </div>
      {task && (
        <div className="closeup-status-banner__task">
          {['pickup', 'dropoff'].map((kind, i) => {
            const label = kind === 'pickup' ? task.pickupLabel : task.dropoffLabel;
            return (
              <span key={kind} className="closeup-status-banner__task-part">
                {i === 1 && <span className="closeup-status-banner__arrow">→</span>}
                <button
                  type="button"
                  className={'closeup-status-banner__endpoint closeup-status-banner__endpoint--' + kind
                    + (task.active === kind ? ' is-active' : '')}
                  disabled={!label}
                  onClick={() => onFocusEndpoint(kind)}
                  title={kind === 'pickup' ? 'Ver origem no mapa' : 'Ver destino no mapa'}
                >
                  {label || '—'}
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
