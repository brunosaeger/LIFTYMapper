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

  function loadRoutes() {
    setRoutesStatus('loading');
    fetchRouteLog()
      .then((data) => {
        setRoutes([...data].reverse()); // mais recente primeiro — o arquivo é gravado em ordem de chegada
        setRoutesStatus('idle');
      })
      .catch(() => setRoutesStatus('error'));
  }

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
        <div className="history-panel__list">
          {routesStatus === 'loading' && <p className="points-panel__empty">Carregando…</p>}
          {routesStatus === 'error' && <p className="points-panel__empty">Erro ao carregar histórico de rotas.</p>}
          {routesStatus === 'idle' && routes.length === 0 && (
            <p className="points-panel__empty">Nenhuma rota registrada ainda.</p>
          )}
          {routesStatus === 'idle' && routes.map((entry) => (
            <div key={entry.id} className="history-route">
              <div className="history-route__path">{entry.pickup} → {entry.dropoff}</div>
              <div className="history-route__time">Solicitada: {entry.requestedAt}</div>
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
