// Mesmo retângulo semitransparente do RobotStatusBanner/CloseUpStatusBanner
// (ver esses arquivos) — indica que um cancelamento foi solicitado mas
// ainda NÃO aconteceu de verdade, porque o robô não tem espaço pra girar
// agora (ver server.py, "Cancelamento adiado até giro seguro" no
// CONTEXT.md). Fica visível o tempo que for preciso — some sozinho quando
// o servidor cancela de fato (o próximo poll de /api/live-state já vem
// com cancelPending=false) ou quando a rota termina por conta própria
// antes de existir uma janela segura.
export default function CancelPendingBanner({ message }) {
  if (!message) return null;

  return (
    <div className="cancel-pending-banner" role="status">
      {message}
    </div>
  );
}
