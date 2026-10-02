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
