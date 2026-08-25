import { useState } from 'react';

// Modal de senha pro modo desenvolvedor (ver App.jsx: DEV_PASSWORD, mode
// gating no Toolbar). Estado do input/erro fica local ao componente — não
// precisa vazar pro App, some sozinho ao fechar/enviar com sucesso.
export default function DevModeModal({ open, onSubmit, onClose }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  if (!open) return null;

  function handleSubmit(e) {
    e.preventDefault();
    if (onSubmit(password)) {
      setPassword('');
      setError('');
    } else {
      setError('Senha incorreta.');
      setPassword('');
    }
  }

  function handleClose() {
    setPassword('');
    setError('');
    onClose();
  }

  return (
    <div className="dev-modal__backdrop" onClick={handleClose}>
      <form className="dev-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <h2 className="dev-modal__title">Modo desenvolvedor</h2>
        <p className="dev-modal__hint">Digite a senha pra liberar a edição de pontos e lotes.</p>
        <input
          type="password"
          className="dev-modal__input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          placeholder="Senha"
        />
        {error && <p className="dev-modal__error">{error}</p>}
        <div className="dev-modal__actions">
          <button type="button" className="dev-modal__cancel" onClick={handleClose}>Cancelar</button>
          <button type="submit" className="dev-modal__submit">Entrar</button>
        </div>
      </form>
    </div>
  );
}
