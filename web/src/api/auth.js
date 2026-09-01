// Login/sessão + administração de usuários — chamadas pro nosso próprio
// server.py (não pro dispatch service do robô, ver lifty.js pra isso).
// Sessão vive num cookie HttpOnly assinado (ver server.py) que o navegador
// já manda sozinho em toda requisição same-origin — nenhuma chamada aqui
// precisa passar token manualmente.

async function jsonRequest(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch { /* resposta vazia ou não-JSON */ }
  if (!res.ok) {
    const msg = (data && data.error) || ('Falha HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

export async function login(username, password) {
  return jsonRequest('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export async function logout() {
  return jsonRequest('/api/logout', { method: 'POST' });
}

// Diferente das outras chamadas: 401 aqui é uma resposta esperada ("ninguém
// logado ainda"), não um erro — quem chama decide o que fazer (mostrar tela
// de login), não precisa de try/catch pra isso.
export async function fetchSession() {
  const res = await fetch('/api/session');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('Falha ao verificar sessão (HTTP ' + res.status + ')');
  return res.json();
}

// Preferência de tema da CONTA (não do dispositivo) — cada operador loga
// em qualquer tablet e encontra o tema dele. Self-service: o servidor usa
// o usuário da SESSÃO, nunca um nome vindo no payload.
export async function saveTheme(theme) {
  return jsonRequest('/api/session/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
}

export async function fetchUsers() {
  return jsonRequest('/api/users');
}

export async function createUser({ username, password, isAdmin }) {
  return jsonRequest('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, isAdmin }),
  });
}

// changes: { password?, isAdmin? } — só manda o que quer trocar, o server
// mantém o resto como está (ver _update_user em server.py).
export async function updateUser(username, changes) {
  return jsonRequest('/api/users/' + encodeURIComponent(username), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
}

export async function deleteUser(username) {
  return jsonRequest('/api/users/' + encodeURIComponent(username), { method: 'DELETE' });
}
