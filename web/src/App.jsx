import { useEffect, useState } from 'react';
import MainApp from './MainApp';
import LoginScreen from './components/LoginScreen';
import { fetchSession, login, logout } from './api/auth';
import './App.css';

// Camada de autenticação (ver CONTEXT.md, "Sistema de login") — decide
// entre tela de login e o app de verdade (MainApp). De propósito o app de
// verdade só MONTA depois de sessão confirmada: os hooks de MainApp (ex:
// useCalibration) disparam fetch autenticado já no primeiro render, e esse
// efeito roda uma vez só — se MainApp existisse desde o início (só
// escondido visualmente), um login bem-sucedido depois não teria como
// re-disparar essas cargas sem recarregar a página inteira.
//
// user: undefined enquanto ainda não se sabe (checando /api/session no
// primeiro load), null quando confirmadamente deslogado, { username,
// isAdmin } quando logado.
export default function App() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    fetchSession()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  async function handleLogin(username, password) {
    const data = await login(username, password);
    // Repassa a resposta inteira em vez de escolher campos a dedo: o
    // caminho do fetchSession (reload de página) já faz isso, e montar um
    // objeto reduzido aqui fazia o `theme` da conta se perder justamente no
    // login — o app abria sempre no tema padrão.
    setUser(data);
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // melhor esforço — mesmo se a chamada falhar (ex: rede caiu), a
      // sessão local é esquecida e a tela de login volta a aparecer
    }
    setUser(null);
  }

  if (user === undefined) return null; // checando sessão — evita "piscar" a tela de login antes da resposta
  if (user === null) return <LoginScreen onSubmit={handleLogin} />;
  return <MainApp user={user} onLogout={handleLogout} />;
}
