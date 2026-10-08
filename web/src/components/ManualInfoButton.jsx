// Ícone "i" cinza, colado ao lado do título de um menu — abre o manual na
// página dessa seção (ver ManualViewer.jsx). `manual`: 'user' (padrão, manual
// do operador) ou 'admin' (manual dos administradores, só nas telas de admin).
export default function ManualInfoButton({ page, manual = 'user', onOpen }) {
  if (!onOpen) return null;
  return (
    <button
      type="button"
      className="manual-info-btn"
      aria-label="Abrir o manual nesta seção"
      title="Ajuda — abrir o manual"
      onClick={() => onOpen({ manual, page })}
    >
      i
    </button>
  );
}
