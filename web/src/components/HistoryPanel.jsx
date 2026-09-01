import { useEffect, useState } from 'react';
import { fetchRouteLog, fetchErrorRecords } from '../api/lifty';

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

function displayDescription(rec) {
  if (ERROR_LABELS[rec.error]) return ERROR_LABELS[rec.error];
  if (!rec.description) return rec.description;
  let text = rec.description;
  for (const [zh, pt] of KNOWN_PHRASES) {
    if (text.includes(zh)) text = text.split(zh).join(pt);
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

// Painel "Histórico" (modo desenvolvedor) — duas seções independentes, cada
// uma com seu próprio scroll (ver CSS .history-panel__list): histórico de
// rotas (nosso server.py, route_log.json — requestedAt/completedAt
// carimbados pelo relógio da máquina que hospeda o servidor, ver
// lifty.js/server.py) e erros/avisos do robô (GET /error/records do
// dispatch service, schema validado contra resposta real).
export default function HistoryPanel() {
  const [routes, setRoutes] = useState([]);
  const [routesStatus, setRoutesStatus] = useState('loading'); // loading | idle | error
  const [errors, setErrors] = useState([]);
  const [errorsStatus, setErrorsStatus] = useState('loading');
  // Filtro por data (ícone de calendário abaixo do título) — string
  // 'YYYY-MM-DD' (valor nativo de <input type="date">) ou '' pra "sem
  // filtro". Comparação é sempre local (a lista inteira já foi carregada),
  // não é um novo fetch por data.
  const [dateFilter, setDateFilter] = useState('');

  function loadRoutes() {
    setRoutesStatus('loading');
    fetchRouteLog()
      .then((data) => {
        setRoutes([...data].reverse()); // mais recente primeiro — o arquivo é gravado em ordem de chegada
        setRoutesStatus('idle');
      })
      .catch(() => setRoutesStatus('error'));
  }

  const visibleRoutes = dateFilter
    ? routes.filter((entry) => entry.requestedAt && entry.requestedAt.slice(0, 10) === dateFilter)
    : routes;

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

  return (
    <div className="history-panel">
      <section className="history-panel__section">
        <div className="history-panel__section-head">
          <h2 className="points-panel__title">Histórico de rotas</h2>
          <button type="button" className="history-panel__refresh" onClick={loadRoutes} aria-label="Atualizar histórico de rotas" title="Atualizar">↻</button>
        </div>

        {/* Filtro por data — o <input type="date"> fica invisível (opacity:0)
            por cima do ícone, então o toque/clique cai nele mesmo assim e
            abre o calendário NATIVO do navegador (Android Chrome abre isso
            direto num toque em qualquer lugar do campo, sem precisar de
            showPicker()/JS — mais simples e mais confiável no tablet do que
            tentar disparar isso programaticamente). O ícone visível é só
            decoração (pointer-events: none), ver CSS .history-panel__calendar. */}
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

        <div className="history-panel__list">
          {routesStatus === 'loading' && <p className="points-panel__empty">Carregando…</p>}
          {routesStatus === 'error' && <p className="points-panel__empty">Erro ao carregar histórico de rotas.</p>}
          {routesStatus === 'idle' && routes.length === 0 && (
            <p className="points-panel__empty">Nenhuma rota registrada ainda.</p>
          )}
          {routesStatus === 'idle' && routes.length > 0 && visibleRoutes.length === 0 && (
            <p className="points-panel__empty">Nenhuma rota em {formatDateBR(dateFilter)}.</p>
          )}
          {routesStatus === 'idle' && visibleRoutes.map((entry) => (
            <div key={entry.id} className="history-route">
              <div className="history-route__path">{entry.pickup} → {entry.dropoff}</div>
              <div className="history-route__time">
                Solicitada{entry.user ? ' por ' + entry.user : ''}: {entry.requestedAt}
              </div>
              <div className="history-route__time">
                {entry.completedAt
                  ? (entry.status === 'cancelled' ? 'Cancelada: ' : 'Concluída: ') + entry.completedAt
                  : 'Em andamento…'}
              </div>
            </div>
          ))}
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
