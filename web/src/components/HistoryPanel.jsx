import { useEffect, useMemo, useState } from 'react';
import { fetchRouteLog, fetchErrorRecords } from '../api/lifty';
import { displayCellName } from '../hooks/useCalibration';

const LEVEL_LABEL = { ERROR: 'Erro', WARN: 'Aviso' };

// A API de erro/aviso do robô mistura idioma na descrição livre — o MESMO
// código (`error`) já veio em português, inglês e mandarim dependendo do
// registro (inconsistência do lado do fabricante, não nossa). Como essa
// rede não tem internet, um tradutor de verdade está fora de cogitação —
// a saída é: pros códigos conhecidos, ignorar a descrição da API e mostrar
// um rótulo nosso, fixo, em PT-BR; só entrar na descrição crua quando o
// código não é um dos que já mapeamos. Zero rede, zero biblioteca.
const ERROR_LABELS = {
  LOCATION_LOST: 'AGV desviou da rota',
  HANDLE_CONTROL: 'Mudou para controle manual',
  CONNECTION_BROKEN: 'AGV desconectou inesperadamente',
  UNKNOW_ERROR: 'Erro não identificado',
};

// Reforço pra quando o código NÃO é um dos mapeados acima e a descrição
// ainda vem crua em mandarim — glossário pontual de frases (não palavras
// soltas) que o firmware do robô já repetiu na prática. Troca só o trecho
// conhecido, preserva o resto da string (ex: o nome do AGV) como veio.
const KNOWN_PHRASES = [
  ['切换到手动控制', 'mudou para controle manual'],
  ['偏离路线', 'desviou da rota'],
  ['断开连接', 'desconectou'],
  ['当前地图', 'mapa atual'],
  ['不在服务器中', 'não está no servidor'],
  ['未初始化或配置不完整：缺少点位和路线信息，请先完善点位和路线信息', 'não inicializado ou configuração incompleta: faltam informações de pontos e rotas — complete isso primeiro'],
  // Genérico ("地图" sozinho) — precisa vir DEPOIS de '当前地图' acima na
  // lista: esse é mais específico e já consome a ocorrência dele quando
  // aplicável, então não colide (a troca é sequencial, ver displayDescription).
  ['地图', 'Mapa'],
];

// Rede de segurança final (pedido do usuário, 2026-10-02: "não quero
// vestígio de nada chinês"): KNOWN_PHRASES só cobre o que já vimos na
// prática — um código/frase NOVO que a API mande em mandarim passaria
// direto sem isso. Qualquer caractere Han remanescente depois das trocas
// conhecidas vira um aviso genérico em PT-BR (com o código original, que é
// sempre ASCII) em vez de deixar mandarim bruto chegar na tela.
const HAN_CHARS = /[一-鿿㐀-䶿豈-﫿]/;

function displayDescription(rec) {
  if (ERROR_LABELS[rec.error]) return ERROR_LABELS[rec.error];
  if (!rec.description) return rec.description;
  let text = rec.description;
  for (const [zh, pt] of KNOWN_PHRASES) {
    if (text.includes(zh)) text = text.split(zh).join(pt);
  }
  if (HAN_CHARS.test(text)) {
    return 'Erro do robô' + (rec.error ? ' (' + rec.error + ')' : '') + ' — descrição não traduzida.';
  }
  return text;
}

// 'YYYY-MM-DD' (valor nativo de <input type="date">) -> 'DD/MM/AAAA', só
// pra exibição. Sem lib de data (zero-dependência, ver CONTEXT.md) —
// requestedAt já vem nesse formato ISO do server.py (strftime
// "%Y-%m-%d %H:%M:%S"), então comparar prefixo de string basta pra filtrar.
function formatDateBR(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return d + '/' + m + '/' + y;
}

// Rótulo do filtro de horário (ver history-panel__clock abaixo) — combina
// os dois limites (de/até) num texto só, cada um opcional.
function formatTimeRangeLabel(from, to) {
  if (from && to) return from + '–' + to;
  if (from) return 'A partir de ' + from;
  return 'Até ' + to;
}

const STATUS_TAG_LABEL = { cancelled: 'CANCELADA', failed: 'FALHOU' };

// Painel "Histórico" (modo desenvolvedor) — duas seções independentes, cada
// uma com seu próprio scroll (ver CSS .history-panel__list): histórico de
// rotas (nosso server.py, route_log.json — requestedAt/completedAt
// carimbados pelo relógio da máquina que hospeda o servidor, ver
// lifty.js/server.py) e erros/avisos do robô (GET /error/records do
// dispatch service, schema validado contra resposta real).
//
// `lots`/`points`: pra exibir o nome fantasia (displayCellName) em vez do
// nome técnico (pedido do usuário, 2026-10-01). `selectedEntryId`/
// `onSelectEntry`: clicar numa rota destaca origem/destino no mapa (ver
// MainApp.jsx, selectedHistoryRoute/mapPickupNames) — clicar de novo na
// mesma desseleciona (alternado em MainApp, não aqui).
export default function HistoryPanel({ lots, points, selectedEntryId, onSelectEntry }) {
  const [routes, setRoutes] = useState([]);
  const [routesStatus, setRoutesStatus] = useState('loading'); // loading | idle | error
  const [errors, setErrors] = useState([]);
  const [errorsStatus, setErrorsStatus] = useState('loading');
  // Filtro por data (ícone de calendário) — string 'YYYY-MM-DD' (valor
  // nativo de <input type="date">) ou '' pra "sem filtro".
  const [dateFilter, setDateFilter] = useState('');
  // Filtro por horário (ícone de relógio) — dois <input type="time">
  // nativos ('HH:MM' ou ''), aplicados em conjunto com a data (ver
  // visibleRoutes abaixo) — comparação lexicográfica de string basta pro
  // formato HH:MM, sem lib de data.
  const [timeOpen, setTimeOpen] = useState(false);
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo] = useState('');
  // Filtro por conta solicitante (ícone de busto) — busca com sugestões
  // (nomes distintos já vistos no histórico carregado, sem round-trip novo
  // ao servidor). `userQuery` é o texto digitado (abre a lista de
  // sugestões); `userFilter` é o nome DE FATO aplicado (só muda ao
  // selecionar uma sugestão, nunca direto do texto livre).
  const [userSearchOpen, setUserSearchOpen] = useState(false);
  const [userQuery, setUserQuery] = useState('');
  const [userFilter, setUserFilter] = useState('');

  function loadRoutes() {
    setRoutesStatus('loading');
    fetchRouteLog()
      .then((data) => {
        setRoutes([...data].reverse()); // mais recente primeiro — o arquivo é gravado em ordem de chegada
        setRoutesStatus('idle');
      })
      .catch(() => setRoutesStatus('error'));
  }

  // Nomes distintos de quem solicitou, só entre quem já aparece no
  // histórico carregado (não é uma lista de contas do sistema inteiro —
  // não faria sentido sugerir filtrar por alguém sem nenhuma rota).
  const knownUsers = useMemo(() => {
    const seen = new Set();
    for (const entry of routes) {
      if (entry.user) seen.add(entry.user);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [routes]);

  const userSuggestions = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return knownUsers.slice(0, 6);
    return knownUsers.filter((name) => name.toLowerCase().includes(q)).slice(0, 6);
  }, [knownUsers, userQuery]);

  const visibleRoutes = routes.filter((entry) => {
    if (dateFilter && (!entry.requestedAt || entry.requestedAt.slice(0, 10) !== dateFilter)) return false;
    if (userFilter && entry.user !== userFilter) return false;
    if ((timeFrom || timeTo) && entry.requestedAt) {
      const time = entry.requestedAt.slice(11, 16);
      if (timeFrom && time < timeFrom) return false;
      if (timeTo && time > timeTo) return false;
    }
    return true;
  });
  const hasAnyFilter = !!(dateFilter || userFilter || timeFrom || timeTo);

  function loadErrors() {
    setErrorsStatus('loading');
    fetchErrorRecords({ page: 1, size: 30 })
      .then((data) => {
        setErrors((data && data.records) || []);
        setErrorsStatus('idle');
      })
      .catch(() => setErrorsStatus('error'));
  }

  useEffect(() => {
    loadRoutes();
    loadErrors();
  }, []);

  function selectUser(name) {
    setUserFilter(name);
    setUserQuery('');
    setUserSearchOpen(false);
  }

  return (
    <div className="history-panel">
      <section className="history-panel__section">
        <div className="history-panel__section-head">
          <h2 className="points-panel__title">Histórico de rotas</h2>
          <button type="button" className="history-panel__refresh" onClick={loadRoutes} aria-label="Atualizar histórico de rotas" title="Atualizar">↻</button>
        </div>

        <div className="history-panel__filters">
          {/* Filtro por conta (busto) — clicar abre a busca com sugestões;
              selecionar uma fecha a busca e mostra o nome ao lado do ícone,
              com X pra limpar. Combina com data/horário (ver visibleRoutes). */}
          <div className="history-panel__user-filter">
            <button
              type="button"
              className={'history-panel__icon-btn' + (userFilter ? ' is-active' : '')}
              onClick={() => setUserSearchOpen((o) => !o)}
              aria-label="Filtrar histórico por conta solicitante"
              title="Filtrar por conta"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" />
              </svg>
            </button>
            {userFilter && !userSearchOpen && (
              <span className="history-panel__filter-tag">
                {userFilter}
                <button
                  type="button"
                  className="history-panel__filter-clear"
                  onClick={() => setUserFilter('')}
                  aria-label="Limpar filtro de conta"
                  title="Limpar filtro"
                >
                  ✕
                </button>
              </span>
            )}
            {userSearchOpen && (
              <div className="history-panel__user-search">
                <input
                  type="text"
                  className="history-panel__user-input"
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                  placeholder="Buscar conta…"
                  autoFocus
                  aria-label="Buscar conta solicitante"
                />
                {userFilter && (
                  <button
                    type="button"
                    className="history-panel__filter-clear"
                    onClick={() => { setUserFilter(''); setUserSearchOpen(false); setUserQuery(''); }}
                    aria-label="Limpar filtro de conta"
                    title="Limpar filtro"
                  >
                    ✕
                  </button>
                )}
                {userSuggestions.length > 0 && (
                  <ul className="history-panel__user-suggestions">
                    {userSuggestions.map((name) => (
                      <li key={name}>
                        <button type="button" onClick={() => selectUser(name)}>{name}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Filtro por data — o <input type="date"> fica invisível
              (opacity:0) por cima do ícone, então o toque/clique cai nele
              mesmo assim e abre o calendário NATIVO do navegador (Android
              Chrome abre isso direto num toque em qualquer lugar do campo,
              sem precisar de showPicker()/JS — mais simples e mais
              confiável no tablet do que tentar disparar isso
              programaticamente). O ícone visível é só decoração
              (pointer-events: none), ver CSS .history-panel__calendar. */}
          <div className="history-panel__calendar">
            <input
              type="date"
              className="history-panel__date-input"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              aria-label="Filtrar histórico de rotas por data"
            />
            <svg className="history-panel__calendar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            {dateFilter && (
              <span className="history-panel__filter-tag">
                {formatDateBR(dateFilter)}
                <button
                  type="button"
                  className="history-panel__filter-clear"
                  onClick={() => setDateFilter('')}
                  aria-label="Limpar filtro de data"
                  title="Limpar filtro"
                >
                  ✕
                </button>
              </span>
            )}
          </div>

          {/* Filtro por horário — mesmo espírito do de data, mas com DOIS
              <input type="time"> nativos (de/até, ambos opcionais) dentro
              de um popover (não dá pra sobrepor dois inputs no mesmo
              ícone). Combina com data e conta (ver visibleRoutes). */}
          <div className="history-panel__clock">
            <button
              type="button"
              className={'history-panel__icon-btn' + ((timeFrom || timeTo) ? ' is-active' : '')}
              onClick={() => setTimeOpen((o) => !o)}
              aria-label="Filtrar histórico de rotas por horário"
              title="Filtrar por horário"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </svg>
            </button>
            {(timeFrom || timeTo) && !timeOpen && (
              <span className="history-panel__filter-tag">
                {formatTimeRangeLabel(timeFrom, timeTo)}
                <button
                  type="button"
                  className="history-panel__filter-clear"
                  onClick={() => { setTimeFrom(''); setTimeTo(''); }}
                  aria-label="Limpar filtro de horário"
                  title="Limpar filtro"
                >
                  ✕
                </button>
              </span>
            )}
            {timeOpen && (
              <div className="history-panel__time-popover">
                <label>
                  De
                  <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
                </label>
                <label>
                  Até
                  <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
                </label>
                <button
                  type="button"
                  className="history-panel__time-popover-close"
                  onClick={() => setTimeOpen(false)}
                  aria-label="Fechar filtro de horário"
                >
                  ✓
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="history-panel__list">
          {routesStatus === 'loading' && <p className="points-panel__empty">Carregando…</p>}
          {routesStatus === 'error' && <p className="points-panel__empty">Erro ao carregar histórico de rotas.</p>}
          {routesStatus === 'idle' && routes.length === 0 && (
            <p className="points-panel__empty">Nenhuma rota registrada ainda.</p>
          )}
          {routesStatus === 'idle' && routes.length > 0 && visibleRoutes.length === 0 && (
            <p className="points-panel__empty">{hasAnyFilter ? 'Nenhuma rota encontrada com esses filtros.' : 'Nenhuma rota registrada ainda.'}</p>
          )}
          {routesStatus === 'idle' && visibleRoutes.map((entry) => {
            const tagLabel = STATUS_TAG_LABEL[entry.status];
            return (
              <button
                key={entry.id}
                type="button"
                className={'history-route' + (selectedEntryId === entry.id ? ' is-selected' : '')}
                onClick={() => onSelectEntry && onSelectEntry(entry)}
              >
                {/* pickup null = UNLOAD isolado pós-cancelamento (ver
                    CONTEXT.md, "Cancelamento pós-pickup") — não é uma rota
                    origem→destino normal, só termina de descarregar um
                    pallet que já estava no garfo. Nome fantasia
                    (displayCellName) em vez do nome técnico, pedido do
                    usuário 2026-10-01. */}
                <div className="history-route__head">
                  <div className="history-route__path">
                    {entry.pickup
                      ? displayCellName(entry.pickup, lots, points) + ' → ' + displayCellName(entry.dropoff, lots, points)
                      : 'Descarregando em: ' + displayCellName(entry.dropoff, lots, points)}
                  </div>
                  {tagLabel && (
                    <span className={'history-route__tag history-route__tag--' + entry.status}>{tagLabel}</span>
                  )}
                </div>
                <div className="history-route__time">
                  Solicitada{entry.user ? ' por ' + entry.user : ''}: {entry.requestedAt}
                </div>
                <div className="history-route__time">
                  {entry.completedAt
                    ? ({ cancelled: 'Cancelada: ', failed: 'Falhou: ' }[entry.status] || 'Concluída: ') + entry.completedAt
                    : 'Em andamento…'}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="history-panel__section">
        <div className="history-panel__section-head">
          <h2 className="points-panel__title">Erros e avisos</h2>
          <button type="button" className="history-panel__refresh" onClick={loadErrors} aria-label="Atualizar erros e avisos" title="Atualizar">↻</button>
        </div>
        <div className="history-panel__list">
          {errorsStatus === 'loading' && <p className="points-panel__empty">Carregando…</p>}
          {errorsStatus === 'error' && <p className="points-panel__empty">Erro ao carregar erros/avisos.</p>}
          {errorsStatus === 'idle' && errors.length === 0 && (
            <p className="points-panel__empty">Nenhum erro/aviso recente.</p>
          )}
          {errorsStatus === 'idle' && errors.map((rec) => (
            <div key={rec.id} className={'history-error history-error--' + rec.level.toLowerCase()}>
              <div className="history-error__head">
                <span className="history-error__level">{LEVEL_LABEL[rec.level] || rec.level}</span>
                <span className="history-error__time">{rec.happenTime}</span>
              </div>
              <div className="history-error__desc" title={rec.description}>{displayDescription(rec)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
