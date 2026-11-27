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

// replyTo: id da mensagem respondida (ou null).
export function sendChatMessage(text, replyTo = null) {
  return jsonRequest('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, replyTo }),
  });
}

// Só quem enviou a solicitação pode cancelar (o servidor confere).
export function cancelPalletRequest(id) {
  return jsonRequest('/api/chat/pallet-request/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
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
