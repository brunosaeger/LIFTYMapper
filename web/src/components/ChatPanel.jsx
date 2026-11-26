import { useEffect, useRef, useState } from 'react';
import { PalletBoxIcon, RaisedHandIcon } from './RequestIcons';

// Painel do Chat (pedido do usuário, 2026-11-24 — ver server.py, "Chat").
// Lista de mensagens + barrinha de escrever embaixo (abre o teclado do
// tablet), com o botão de solicitação (mãozinha — abre a "Solicitação de
// pallets", ver PalletRequestPanel) e o de enviar (setinha). Mensagens
// `palletRequest` viram um cartão clicável que mostra as posições no mapa.
export default function ChatPanel({ messages, currentUsername, onSend, showToast, onStartRequest, onViewRequest, palletRequests, labelOf }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  // Sempre rola pro fim quando chega mensagem nova (ou ao abrir).
  const newestId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newestId]);

  async function submit(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setDraft('');
    } catch (err) {
      showToast('Não deu pra enviar: ' + err.message, 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-panel">
      <h2 className="points-panel__title">Chat</h2>
      <p className="chat-panel__note">As mensagens somem sozinhas 12 horas depois de enviadas.</p>
      <ul className="chat-panel__list" ref={listRef}>
        {messages.length === 0 && <li className="points-panel__empty">Nenhuma mensagem nas últimas 12 horas.</li>}
        {messages.map((m, i) => {
          const mine = m.user === currentUsername;
          const prev = messages[i - 1];
          const showName = !mine && (!prev || prev.user !== m.user);
          return (
            <li key={m.id} className={'chat-msg' + (mine ? ' chat-msg--mine' : '')}>
              {showName && <span className="chat-msg__user">{m.user}</span>}
              {m.kind === 'palletRequest' ? (
                <PalletRequestCard msg={m} palletRequests={palletRequests} labelOf={labelOf} onView={() => onViewRequest(m)} />
              ) : (
              <span className="chat-msg__bubble">
                <span className="chat-msg__text">{m.text}</span>
                <span className="chat-msg__time">{(m.at || '').slice(11, 16)}</span>
              </span>
              )}
            </li>
          );
        })}
      </ul>
      <form className="chat-panel__bar" onSubmit={submit}>
        <textarea
          className="chat-panel__input"
          rows={1}
          maxLength={500}
          placeholder="Escreva uma mensagem…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e);
          }}
        />
        <button
          type="button"
          className="chat-panel__icon-btn chat-panel__request-btn"
          onClick={onStartRequest}
          title="Solicitar pallets"
          aria-label="Solicitar pallets"
        >
          <RaisedHandIcon />
        </button>
        <button
          type="submit"
          className="chat-panel__icon-btn chat-panel__send"
          disabled={!draft.trim() || sending}
          title="Enviar"
          aria-label="Enviar mensagem"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </div>
  );
}

const MATERIAL_LABEL = { wood: 'madeira', blue: 'azul' };

// Cartão "SOLICITAÇÃO DE PALLETS" — tocar mostra as posições no mapa. Diz
// quantas ainda estão esperando pallet (a marca amarela some quando o robô
// entrega ali ou alguém marca madeira/azul, ver server.py).
function PalletRequestCard({ msg, palletRequests, labelOf, onView }) {
  const positions = msg.positions || [];
  const waiting = positions.filter((p) => palletRequests[p.name] && palletRequests[p.name].msgId === msg.id).length;
  const counts = positions.reduce((acc, p) => ({ ...acc, [p.material]: (acc[p.material] || 0) + 1 }), {});
  const summary = Object.keys(counts).map((k) => counts[k] + ' ' + (MATERIAL_LABEL[k] || k)).join(' · ');
  return (
    <button
      type="button"
      className={'chat-request' + (waiting === 0 ? ' is-done' : '')}
      onClick={onView}
      title="Ver no mapa"
    >
      <PalletBoxIcon className="chat-request__icon" />
      <span className="chat-request__title">Solicitação de pallets</span>
      <span className="chat-request__names">{positions.map((p) => labelOf(p.name)).join(', ')}</span>
      <span className="chat-request__meta">{summary}</span>
      {msg.text && <span className="chat-request__text">{msg.text}</span>}
      <span className="chat-request__status">
        {waiting === 0 ? 'Atendida' : waiting === positions.length ? 'Aguardando pallets' : waiting + ' de ' + positions.length + ' aguardando'}
        {' · '}{(msg.at || '').slice(11, 16)}
      </span>
    </button>
  );
}
