// Mesmo retângulo semitransparente do RobotStatusBanner (ver esse arquivo),
// mas centro-INFERIOR da tela em vez de superior — indica qual área de
// Close Up o operador está olhando de perto no modo Interação. `name` já
// vem resolvido (ou null) do MainApp.jsx: aparece ao tocar um Close Up,
// some ao sair do modo Interação ou resetar o zoom (ver
// handleCloseUpActivate/handleToggleInteractionMode).
export default function CloseUpStatusBanner({ name }) {
  if (!name) return null;

  return (
    <div className="closeup-status-banner" aria-hidden="true">
      {/* Prefixo em destaque (mint vibrante), resto do texto em branco —
          pedido explícito do usuário, ver CONTEXT.md. */}
      <span className="closeup-status-banner__prefix">VISUALIZANDO</span>
      <span className="closeup-status-banner__rest">: KANBAN {name}</span>
    </div>
  );
}
