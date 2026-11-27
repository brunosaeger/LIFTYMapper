import { useEffect, useRef, useState } from 'react';
import { PalletBoxIcon, RaisedHandIcon } from './RequestIcons';

// Painel do Chat (ver docs/context/chat-solicitacoes.md). Lista de mensagens
// + barrinha de escrever embaixo, com a mãozinha (abre a "Solicitação de
// pallets", ver PalletRequestPanel) e o enviar (setinha). Mensagens
// `palletRequest` viram um cartão clicável que mostra as posições no mapa;
// quem enviou tem um botão largo com X embaixo pra cancelar.
// Responder (igual WhatsApp/Instagram): SEGURAR uma mensagem ~0,45 s mostra a
// prévia dela em cima da barrinha; a mensagem enviada vai com a citação em
// cima. Tocar na citação rola até a original (se ainda existir).
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_PX = 10;
const MATERIAL_LABEL = { wood: 'madeira', blue: 'azul' };

export default function ChatPanel({
  messages, currentUsername, onSend, showToast, onStartRequest, onViewRequest,
  onCancelRequest, palletRequests, labelOf,
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState(null); // mensagem sendo respondida
  const [flashId, setFlashId] = useState(null); // original destacada ao tocar na citação
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const press = useRef(null); // { timer, x, y, fired }

  // Sempre rola pro fim quando chega mensagem nova (ou ao abrir).
  const newestId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newestId]);

  useEffect(() => () => clearTimeout(press.current?.timer), []);

  async function submit(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text, replyTo ? replyTo.id : null);
      setDraft('');
      setReplyTo(null);
    } catch (err) {
      showToast('Não deu pra enviar: ' + err.message, 'error');
    } finally {
      setSending(false);
    }
  }

  // --- segurar pra responder -------------------------------------------------
  function pressStart(e, msg) {
    if (e.button !== undefined && e.button !== 0) return;
    clearTimeout(press.current?.timer);
    const state = { x: e.clientX, y: e.clientY, fired: false };
    state.timer = setTimeout(() => {
      state.fired = true;
      setReplyTo(msg);
      try { navigator.vibrate?.(30); } catch { /* sem vibração */ }
      inputRef.current?.focus();
    }, LONG_PRESS_MS);
    press.current = state;
  }
  function pressMove(e) {
    const p = press.current;
    if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_MOVE_PX) clearTimeout(p.timer);
  }
  function pressEnd() {
    clearTimeout(press.current?.timer);
  }
  // O clique que vem logo depois de um "segurar" não pode abrir o mapa.
  function swallowClickAfterPress(e) {
    if (press.current?.fired) {
      e.preventDefault();
      e.stopPropagation();
      press.current = null;
      return true;
    }
    return false;
  }
  const pressHandlers = (msg) => ({
    onPointerDown: (e) => pressStart(e, msg),
    onPointerMove: pressMove,
    onPointerUp: pressEnd,
    onPointerLeave: pressEnd,
    onPointerCancel: pressEnd,
  });

  function jumpTo(id) {
    const el = listRef.current?.querySelector('[data-msg-id="' + id + '"]');
    if (!el) {
      showToast('A mensagem original já saiu do chat (12 h).', 'info');
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashId(id);
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1400);
  }

  return (
    <div className="chat-panel">
      <h2 className="points-panel__title">Chat</h2>
      <p className="chat-panel__note">As mensagens somem sozinhas 12 horas depois de enviadas. Segure uma mensagem pra responder.</p>
      <ul className="chat-panel__list" ref={listRef}>
        {messages.length === 0 && <li className="points-panel__empty">Nenhuma mensagem nas últimas 12 horas.</li>}
        {messages.map((m, i) => {
          const mine = m.user === currentUsername;
          const prev = messages[i - 1];
          const showName = !mine && (!prev || prev.user !== m.user);
          return (
            <li
              key={m.id}
              data-msg-id={m.id}
              className={'chat-msg' + (mine ? ' chat-msg--mine' : '') + (flashId === m.id ? ' is-flash' : '')
                + (replyTo && replyTo.id === m.id ? ' is-replying' : '')}
            >
              {showName && <span className="chat-msg__user">{m.user}</span>}
              {m.kind === 'palletRequest' ? (
                <PalletRequestCard
                  msg={m}
                  mine={mine}
                  palletRequests={palletRequests}
                  labelOf={labelOf}
                  pressHandlers={pressHandlers(m)}
                  onView={(e) => { if (!swallowClickAfterPress(e)) onViewRequest(m); }}
                  onCancel={() => onCancelRequest(m)}
                />
              ) : (
                <span className="chat-msg__bubble" {...pressHandlers(m)} onClickCapture={swallowClickAfterPress}>
                  {m.replyTo && (
                    <button
                      type="button"
                      className="chat-quote"
                      onClick={(e) => { if (!swallowClickAfterPress(e)) jumpTo(m.replyTo.id); }}
                    >
                      <span className="chat-quote__user">{m.replyTo.user === currentUsername ? 'Você' : m.replyTo.user}</span>
                      <span className="chat-quote__text">{quoteText(m.replyTo, labelOf)}</span>
                    </button>
                  )}
                  <span className="chat-msg__text">{m.text}</span>
                  <span className="chat-msg__time">{(m.at || '').slice(11, 16)}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {replyTo && (
        <div className="chat-reply-preview">
          <span className="chat-reply-preview__body">
            <span className="chat-quote__user">Respondendo {replyTo.user === currentUsername ? 'a você' : replyTo.user}</span>
            <span className="chat-quote__text">{quoteText(replyTo, labelOf)}</span>
          </span>
          <button
            type="button"
            className="chat-reply-preview__close"
            onClick={() => setReplyTo(null)}
            aria-label="Cancelar resposta"
            title="Cancelar resposta"
          >
            ✕
          </button>
        </div>
      )}
      <form className="chat-panel__bar" onSubmit={submit}>
        <textarea
          ref={inputRef}
          className="chat-panel__input"
          rows={1}
          maxLength={500}
          placeholder={replyTo ? 'Escreva a resposta…' : 'Escreva uma mensagem…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e);
            if (e.key === 'Escape') setReplyTo(null);
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

// Texto curto da mensagem citada (mensagem comum ou solicitação de pallets).
function quoteText(msg, labelOf) {
  if (msg.kind === 'palletRequest') {
    const names = (msg.positions || []).map((p) => labelOf(typeof p === 'string' ? p : p.name)).join(', ');
    return 'Solicitação de pallets: ' + names + (msg.text ? ' — ' + msg.text : '');
  }
  return msg.text || '';
}

// Cartão "SOLICITAÇÃO DE PALLETS" — tocar mostra as posições no mapa. Diz
// quantas ainda estão esperando pallet (a marca amarela some quando o robô
// entrega ali ou alguém marca madeira/azul/X, ver server.py). Quem enviou vê
// um botão largo com X embaixo pra cancelar enquanto ainda há o que esperar.
function PalletRequestCard({ msg, mine, palletRequests, labelOf, pressHandlers, onView, onCancel }) {
  const [busy, setBusy] = useState(false);
  const positions = msg.positions || [];
  const waiting = msg.cancelled ? 0
    : positions.filter((p) => palletRequests[p.name] && palletRequests[p.name].msgId === msg.id).length;
  const counts = positions.reduce((acc, p) => ({ ...acc, [p.material]: (acc[p.material] || 0) + 1 }), {});
  const summary = Object.keys(counts).map((k) => counts[k] + ' ' + (MATERIAL_LABEL[k] || k)).join(' · ');
  const status = msg.cancelled ? 'Cancelada'
    : waiting === 0 ? 'Atendida'
    : waiting === positions.length ? 'Aguardando pallets'
    : waiting + ' de ' + positions.length + ' aguardando';

  async function cancel() {
    if (busy) return;
    setBusy(true);
    try { await onCancel(); } finally { setBusy(false); }
  }

  return (
    <div className="chat-request-wrap">
      <button
        type="button"
        className={'chat-request' + (msg.cancelled ? ' is-cancelled' : waiting === 0 ? ' is-done' : '')}
        onClick={onView}
        title="Ver no mapa"
        {...pressHandlers}
      >
        <PalletBoxIcon className="chat-request__icon" />
        <span className="chat-request__title">Solicitação de pallets</span>
        <span className="chat-request__names">{positions.map((p) => labelOf(p.name)).join(', ')}</span>
        <span className="chat-request__meta">{summary}</span>
        {msg.text && <span className="chat-request__text">{msg.text}</span>}
        <span className="chat-request__status">{status}{' · '}{(msg.at || '').slice(11, 16)}</span>
      </button>
      {mine && !msg.cancelled && waiting > 0 && (
        <button
          type="button"
          className="chat-request__cancel"
          onClick={cancel}
          disabled={busy}
          aria-label="Cancelar minha solicitação"
          title="Cancelar minha solicitação"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
