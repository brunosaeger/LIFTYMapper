import { useEffect, useState } from 'react';
import { fetchUsers, createUser, updateUser, deleteUser } from '../api/auth';

// Painel "Usuários" — só visível pra quem logou como admin (ver App.jsx,
// gate por user.isAdmin, independente do modo desenvolvedor de edição de
// pontos/lotes, que é outra trava). Decisão do usuário (ver CONTEXT.md,
// "Sistema de login"): cadastro/gestão de conta é tudo feito por aqui,
// sem fluxo de "esqueci minha senha" — quem tem acesso de admin troca a
// senha de qualquer um direto nesta tela.
export default function UsersPanel({ currentUsername, showToast }) {
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | idle | error

  function load() {
    setStatus('loading');
    fetchUsers()
      .then((data) => { setUsers(data); setStatus('idle'); })
      .catch(() => setStatus('error'));
  }

  useEffect(load, []);

  async function handleToggleAdmin(user) {
    try {
      await updateUser(user.username, { isAdmin: !user.isAdmin });
      load();
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
    }
  }

  // Conta bloqueada sozinha depois de 3 senhas erradas seguidas (ver
  // server.py, LOGIN_MAX_ATTEMPTS) — só um admin destrava, clicando no
  // cadeado ao lado do nome (ver UserRow). Desbloquear já zera o contador
  // de tentativas no servidor também.
  async function handleUnlock(username) {
    try {
      await updateUser(username, { locked: false });
      load();
      showToast(username + ' desbloqueado.', 'success');
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
    }
  }

  async function handleChangePassword(username, newPassword) {
    try {
      await updateUser(username, { password: newPassword });
      showToast('Senha de ' + username + ' atualizada.', 'success');
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
    }
  }

  async function handleDelete(username) {
    if (!window.confirm('Excluir o usuário "' + username + '"?')) return;
    try {
      await deleteUser(username);
      load();
      showToast('Usuário excluído.', 'success');
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
    }
  }

  async function handleCreate({ username, password, isAdmin }) {
    await createUser({ username, password, isAdmin });
    load();
    showToast('Usuário "' + username + '" criado.', 'success');
  }

  return (
    <div className="users-panel">
      <h2 className="points-panel__title">Usuários</h2>
      {status === 'loading' && <p className="points-panel__empty">Carregando…</p>}
      {status === 'error' && <p className="points-panel__empty">Erro ao carregar usuários.</p>}
      {status === 'idle' && (
        <ul className="points-panel__list users-panel__list">
          {users.map((u) => (
            <UserRow
              key={u.username}
              user={u}
              isSelf={u.username === currentUsername}
              onToggleAdmin={() => handleToggleAdmin(u)}
              onChangePassword={(pw) => handleChangePassword(u.username, pw)}
              onDelete={() => handleDelete(u.username)}
              onUnlock={() => handleUnlock(u.username)}
            />
          ))}
        </ul>
      )}
      <NewUserForm onCreate={handleCreate} />
    </div>
  );
}

function UserRow({ user, isSelf, onToggleAdmin, onChangePassword, onDelete, onUnlock }) {
  const [newPassword, setNewPassword] = useState('');

  function submitPassword() {
    if (!newPassword) return;
    onChangePassword(newPassword);
    setNewPassword('');
  }

  return (
    <li className={'users-panel__row' + (user.locked ? ' is-locked' : '')}>
      <div className="users-panel__row-main">
        <span className="users-panel__name-group">
          <span className="users-panel__username">{user.username}{isSelf ? ' (você)' : ''}</span>
          {user.locked && (
            <button
              type="button"
              className="users-panel__lock"
              onClick={onUnlock}
              title="Conta bloqueada após 3 senhas erradas — clique pra desbloquear"
            >
              🔒
            </button>
          )}
        </span>
        <label className="users-panel__admin-toggle">
          <input type="checkbox" checked={user.isAdmin} onChange={onToggleAdmin} />
          admin
        </label>
      </div>
      <div className="users-panel__row-actions">
        <input
          type="password"
          className="points-panel__input"
          placeholder="nova senha"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <button type="button" className="users-panel__btn" onClick={submitPassword} disabled={!newPassword}>Trocar</button>
        <button
          type="button"
          className="points-panel__delete"
          onClick={onDelete}
          disabled={isSelf}
          title={isSelf ? 'Não dá pra excluir o próprio usuário logado' : 'Excluir'}
        >
          ✕
        </button>
      </div>
    </li>
  );
}

function NewUserForm({ onCreate }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({ username: username.trim(), password, isAdmin });
      setUsername('');
      setPassword('');
      setIsAdmin(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="users-panel__new" onSubmit={handleSubmit}>
      <h3 className="users-panel__new-title">Novo usuário</h3>
      <input
        type="text"
        className="points-panel__input"
        placeholder="usuário"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <input
        type="password"
        className="points-panel__input"
        placeholder="senha"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <label className="users-panel__admin-toggle">
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        admin
      </label>
      {error && <p className="dev-modal__error">{error}</p>}
      <button type="submit" className="users-panel__btn" disabled={busy}>{busy ? 'Criando…' : 'Criar'}</button>
    </form>
  );
}
