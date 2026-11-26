// Chat entre usuários (ver server.py, "Chat") — mensagens somem sozinhas 12 h
// depois de enviadas; `lastReadId` é por conta, pro contador de não lidas.

async function jsonRequest(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch { /* resposta vazia ou não-JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('Falha HTTP ' + res.status));
    err.data = data;
    throw err;
  }
  return data;
}

export function fetchChat() {
  return jsonRequest('/api/chat');
}

export function sendChatMessage(text) {
  return jsonRequest('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// Solicitação de pallets: positions = [{ name, material: 'wood'|'blue' }].
export function sendPalletRequest(positions, text) {
  return jsonRequest('/api/chat/pallet-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positions, text }),
  });
}

export function markChatRead(id) {
  return jsonRequest('/api/chat/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}
