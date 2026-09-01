import { useState } from 'react';

// Tela cheia (não modal sobre o app — ver App.jsx: enquanto não há sessão,
// NADA do app renderiza, só isto) pra login de operador. Múltiplos
// operadores, cada um via tablet, mesma rede local fechada (ver
// CONTEXT.md, "Sistema de login").
export default function LoginScreen({ onSubmit }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(username.trim(), password);
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-screen__card" onSubmit={handleSubmit}>
        <div className="login-screen__brand">
          <span className="toolbar__brand-33">33</span>
          <span>LIFTY MAPPER</span>
        </div>
        <h1 className="login-screen__title">Entrar</h1>
        <input
          type="text"
          className="dev-modal__input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Usuário"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
        />
        <input
          type="password"
          className="dev-modal__input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Senha"
        />
        {error && <p className="dev-modal__error">{error}</p>}
        <button type="submit" className="login-screen__submit" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
