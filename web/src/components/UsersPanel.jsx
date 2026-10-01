import { useEffect, useState } from 'react';
import { fetchUsers, createUser, updateUser, deleteUser, fetchKanbans } from '../api/auth';

// Painel "Usuários" — só visível pra quem logou como admin (ver App.jsx,
// gate por user.isAdmin, independente do modo desenvolvedor de edição de
// pontos/lotes, que é outra trava). Decisão do usuário (ver CONTEXT.md,
// "Sistema de login"): cadastro/gestão de conta é tudo feito por aqui,
// sem fluxo de "esqueci minha senha" — quem tem acesso de admin troca a
// senha de qualquer um direto nesta tela.
//
// Kanbans (pedido do usuário, 2026-10-01, ver CONTEXT.md "Delimitação de
// usuários por grupo de lotes"): um usuário COMUM (nem admin, nem Mestre)
// pode ser restrito a só RETIRAR pallets de kanban(s) específico(s) — a
// lista completa de kanbans elegíveis (exclui os "livres pra todos", ver
// server.py FREE_KANBAN_IDS) é buscada uma vez aqui e repassada pro
// KanbanPicker tanto na criação quanto em cada linha existente.
// `onFocusKanban(kanbanId)` (vem de MainApp.jsx): zoom + contorno tracejado
// no mapa, pro admin confirmar visualmente qual área é cada kanban.
export default function UsersPanel({ currentUsername, showToast, onFocusKanban }) {
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | idle | error
  const [kanbans, setKanbans] = useState([]);
  // Busca por nome (pedido do usuário, 2026-10-01): filtra a lista ao vivo
  // conforme digita — sem endpoint novo, a lista inteira já está carregada.
  const [query, setQuery] = useState('');
  const visibleUsers = query.trim()
    ? users.filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase()))
    : users;

  function load() {
    setStatus('loading');
    fetchUsers()
      .then((data) => { setUsers(data); setStatus('idle'); })
      .catch(() => setStatus('error'));
  }

  useEffect(load, []);
  useEffect(() => {
    fetchKanbans().then(setKanbans).catch(() => {});
  }, []);

  async function handleToggleAdmin(user) {
    try {
      await updateUser(user.username, { isAdmin: !user.isAdmin });
      load();
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
    }
  }

  // "Mestre" (pedido do usuário): acesso a qualquer kanban + cancelamento
  // de qualquer tarefa, mas sem acesso às abas Histórico/Usuários (igual
  // um operador comum hoje) — ver server.py, isMaster.
  async function handleToggleMaster(user) {
    try {
      await updateUser(user.username, { isMaster: !user.isMaster });
      load();
    } catch (err) {
      showToast('Erro: ' + err.message, 'error');
    }
  }

  async function handleChangeKanbans(username, kanbanIds) {
    try {
      await updateUser(username, { kanbanIds });
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

  async function handleCreate({ username, password, isAdmin, isMaster, kanbanIds }) {
    await createUser({ username, password, isAdmin, isMaster, kanbanIds });
    load();
    showToast('Usuário "' + username + '" criado.', 'success');
  }

  return (
    <div className="users-panel">
      <div className="users-panel__head">
        <h2 className="points-panel__title">Usuários</h2>
        <div className="users-panel__search">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className="users-panel__search-input"
            placeholder="Buscar usuário…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar usuário por nome"
          />
          {query && (
            <button
              type="button"
              className="users-panel__search-clear"
              onClick={() => setQuery('')}
              aria-label="Limpar busca"
              title="Limpar busca"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {status === 'loading' && <p className="points-panel__empty">Carregando…</p>}
      {status === 'error' && <p className="points-panel__empty">Erro ao carregar usuários.</p>}
      {status === 'idle' && visibleUsers.length === 0 && (
        <p className="points-panel__empty">Nenhum usuário encontrado com esse nome.</p>
      )}
      {status === 'idle' && (
        <ul className="points-panel__list users-panel__list">
          {visibleUsers.map((u) => (
            <UserRow
              key={u.username}
              user={u}
              isSelf={u.username === currentUsername}
              kanbans={kanbans}
              onFocusKanban={onFocusKanban}
              onToggleAdmin={() => handleToggleAdmin(u)}
              onToggleMaster={() => handleToggleMaster(u)}
              onChangeKanbans={(ids) => handleChangeKanbans(u.username, ids)}
              onChangePassword={(pw) => handleChangePassword(u.username, pw)}
              onDelete={() => handleDelete(u.username)}
              onUnlock={() => handleUnlock(u.username)}
            />
          ))}
        </ul>
      )}
      <NewUserForm onCreate={handleCreate} kanbans={kanbans} onFocusKanban={onFocusKanban} />
    </div>
  );
}

// Seletor de kanbans compartilhado (criação E edição de usuário já
// existente) — chips dos kanbans já escolhidos (clicar num chip foca ele
// de novo no mapa, pro admin reconferir) + "+" abre um dropdown com os
// ainda não escolhidos (escolher um já foca ele no mapa na hora, pra
// confirmar visualmente que é a área certa antes de salvar).
function KanbanPicker({ kanbanIds, kanbans, onChange, onFocusKanban }) {
  const [open, setOpen] = useState(false);
  const selected = kanbans.filter((k) => kanbanIds.includes(k.id));
  const available = kanbans.filter((k) => !kanbanIds.includes(k.id));

  function addKanban(id) {
    onChange([...kanbanIds, id]);
    onFocusKanban?.(id);
    setOpen(false);
  }

  function removeKanban(e, id) {
    e.stopPropagation();
    onChange(kanbanIds.filter((k) => k !== id));
  }

  return (
    <div className="users-panel__kanbans">
      <div className="users-panel__kanban-chips">
        {selected.map((k) => (
          <button
            key={k.id}
            type="button"
            className="users-panel__kanban-chip"
            onClick={() => onFocusKanban?.(k.id)}
            title="Ver este kanban no mapa"
          >
            {k.name}
            <span className="users-panel__kanban-chip-remove" onClick={(e) => removeKanban(e, k.id)} title="Remover">✕</span>
          </button>
        ))}
        <button
          type="button"
          className="users-panel__kanban-add"
          onClick={() => setOpen((o) => !o)}
          aria-label="Adicionar kanban"
          title="Adicionar kanban"
        >
          +
        </button>
      </div>
      {open && (
        <ul className="users-panel__kanban-dropdown">
          {available.length === 0 && <li className="users-panel__kanban-empty">Nenhum kanban disponível</li>}
          {available.map((k) => (
            <li key={k.id}>
              <button type="button" onClick={() => addKanban(k.id)}>{k.name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UserRow({ user, isSelf, kanbans, onFocusKanban, onToggleAdmin, onToggleMaster, onChangeKanbans, onChangePassword, onDelete, onUnlock }) {
  const [newPassword, setNewPassword] = useState('');
  // Usuário COMUM (nem admin, nem Mestre) é quem tem restrição de kanban —
  // admin/Mestre não têm essa seção (ver server.py, _user_can_pick_up_from).
  const restrictable = !user.isAdmin && !user.isMaster;

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
        <span className="users-panel__role-toggles">
          <label className="users-panel__admin-toggle">
            <input type="checkbox" checked={user.isAdmin} onChange={onToggleAdmin} />
            admin
          </label>
          <label className="users-panel__admin-toggle">
            <input type="checkbox" checked={user.isMaster} onChange={onToggleMaster} />
            mestre
          </label>
        </span>
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
      {/* KANBANS (ver CONTEXT.md, "Delimitação de usuários por grupo de
          lotes") — só pra usuário comum; admin/Mestre usam qualquer um sem
          restrição, não faz sentido atribuir kanban a eles. */}
      {restrictable && (
        <div className="users-panel__kanbans-section">
          <span className="users-panel__kanbans-label">KANBANS</span>
          <KanbanPicker
            kanbanIds={user.kanbanIds || []}
            kanbans={kanbans}
            onChange={onChangeKanbans}
            onFocusKanban={onFocusKanban}
          />
        </div>
      )}
    </li>
  );
}

function NewUserForm({ onCreate, kanbans, onFocusKanban }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [isMaster, setIsMaster] = useState(false);
  const [kanbanIds, setKanbanIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Usuário COMUM precisa de pelo menos um kanban pra ser criado (pedido
  // explícito do usuário — ver server.py, mesma trava do lado do
  // servidor). Admin/Mestre nunca precisam.
  const needsKanban = !isAdmin && !isMaster;
  const canSubmit = username.trim() && password && (!needsKanban || kanbanIds.length > 0);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({ username: username.trim(), password, isAdmin, isMaster, kanbanIds });
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      setIsMaster(false);
      setKanbanIds([]);
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
      <span className="users-panel__role-toggles">
        <label className="users-panel__admin-toggle">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          admin
        </label>
        <label className="users-panel__admin-toggle">
          <input type="checkbox" checked={isMaster} onChange={(e) => setIsMaster(e.target.checked)} />
          mestre
        </label>
      </span>
      {needsKanban && (
        <div className="users-panel__kanbans-section">
          <span className="users-panel__kanbans-label">KANBANS</span>
          <KanbanPicker kanbanIds={kanbanIds} kanbans={kanbans} onChange={setKanbanIds} onFocusKanban={onFocusKanban} />
          {kanbanIds.length === 0 && (
            <p className="users-panel__kanbans-hint">Escolha pelo menos um kanban pra poder criar este usuário.</p>
          )}
        </div>
      )}
      {error && <p className="dev-modal__error">{error}</p>}
      <button type="submit" className="users-panel__btn" disabled={busy || !canSubmit}>{busy ? 'Criando…' : 'Criar'}</button>
    </form>
  );
}
