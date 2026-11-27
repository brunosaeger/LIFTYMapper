import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelPalletRequest, fetchChat, markChatRead, sendChatMessage, sendPalletRequest } from '../api/chat';

const POLL_MS = 4000; // mesmo ritmo do /api/live-state
const NO_REQUESTS = {};

// Estado do chat (ver server.py, "Chat"): sonda o servidor a cada 4 s, conta
// as não lidas (de OUTROS usuários, depois da última lida desta conta) e,
// com o chat aberto, marca tudo como lido sozinho. Também traz as marcas
// amarelas da "Solicitação de pallets" ({nome: {material, msgId, user}}).
export function useChat(username, open) {
  const [messages, setMessages] = useState([]);
  const [lastReadId, setLastReadId] = useState(0);
  const [palletRequests, setPalletRequests] = useState(NO_REQUESTS);
  const sigRef = useRef(null);

  const apply = useCallback((data) => {
    const sig = JSON.stringify(data);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setMessages(data.messages || []);
    setLastReadId(data.lastReadId || 0);
    setPalletRequests(data.palletRequests || NO_REQUESTS);
  }, []);

  const refresh = useCallback(() => fetchChat().then(apply).catch(() => {}), [apply]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const newestId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    if (!open || newestId <= lastReadId) return;
    setLastReadId(newestId);
    markChatRead(newestId).catch(() => {});
  }, [open, newestId, lastReadId]);

  const unread = open ? 0 : messages.filter((m) => m.id > lastReadId && m.user !== username).length;

  const send = useCallback(async (text, replyTo = null) => {
    apply(await sendChatMessage(text, replyTo));
  }, [apply]);

  const sendRequest = useCallback(async (positions, text) => {
    apply(await sendPalletRequest(positions, text));
  }, [apply]);

  // A resposta já traz o chat atualizado: o amarelo some na hora.
  const cancelRequest = useCallback(async (id) => {
    apply(await cancelPalletRequest(id));
  }, [apply]);

  // Marcação/X do modo Marcação: tira o amarelo da tela NO ATO (otimista);
  // confirm() relê do servidor ignorando o cache de assinatura — se o
  // servidor recusou alguma posição (reservada/fora do kanban), ela volta.
  const hideRequests = useCallback((names) => {
    setPalletRequests((cur) => {
      if (!names.some((n) => cur[n])) return cur;
      const next = { ...cur };
      names.forEach((n) => { delete next[n]; });
      return next;
    });
  }, []);
  const confirm = useCallback(() => {
    sigRef.current = null;
    return refresh();
  }, [refresh]);

  return { messages, unread, palletRequests, send, sendRequest, cancelRequest, refresh, hideRequests, confirm };
}
