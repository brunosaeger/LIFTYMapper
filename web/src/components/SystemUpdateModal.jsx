import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSystemUpdate, startSystemUpdate } from '../api/auth';

// "Atualizar sistema" (botão ⟳ do Toolbar, modo desenvolvedor + admin — ver
// packaging/CONTEXT.md). Mostra a versão instalada e a última do GitHub,
// atualiza ou volta pra anterior. O servidor entrega o atualizar.ps1 pro
// Agendador do Windows e REINICIA: aqui a gente espera ele cair e voltar e
// recarrega a página sozinho.
const POLL_MS = 3000;
const GIVE_UP_MS = 5 * 60 * 1000;

export default function SystemUpdateModal({ open, onClose }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null); // 'update' | 'rollback'
  const [running, setRunning] = useState(null); // { action, since, wentDown }
  const timer = useRef(null);

  const load = useCallback(() => {
    setError('');
    fetchSystemUpdate().then(setInfo).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (open) { setInfo(null); setConfirm(null); setRunning(null); load(); }
    return () => clearTimeout(timer.current);
  }, [open, load]);

  // Esperando o serviço reiniciar: caiu e voltou → recarrega a página.
  useEffect(() => {
    if (!running) return undefined;
    function tick() {
      fetchSystemUpdate()
        .then((data) => {
          if (running.wentDown) { window.location.reload(); return; }
          setInfo(data);
          // O script parou sozinho antes de trocar (o log recomeça a cada execução).
          if (Date.now() - running.since > 8000 && (data.lastLog || '').includes('PAREI')) {
            setRunning(null);
            setError('A atualização parou antes de trocar o programa — nada mudou. Veja o log abaixo.');
            return;
          }
          if (Date.now() - running.since > GIVE_UP_MS) {
            setRunning(null);
            setError('O sistema não reiniciou. Veja o log abaixo (o atualizar.ps1 pode ter parado antes de trocar).');
            return;
          }
          timer.current = setTimeout(tick, POLL_MS);
        })
        .catch(() => {
          setRunning((r) => (r ? { ...r, wentDown: true } : r)); // caiu: está trocando
          timer.current = setTimeout(tick, POLL_MS);
        });
    }
    timer.current = setTimeout(tick, POLL_MS);
    return () => clearTimeout(timer.current);
  }, [running]);

  if (!open) return null;

  async function start(action) {
    setConfirm(null);
    setError('');
    try {
      await startSystemUpdate(action);
      setRunning({ action, since: Date.now(), wentDown: false });
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  const latestTag = info?.latest?.tag;
  const upToDate = !!(info?.version && latestTag && info.version === latestTag);
  const blockedReason = info?.blocker || (info?.queueBusy ? 'Tem rota rodando ou na fila. Espere o robô ficar ocioso.' : null);

  return (
    <div className="dev-modal__backdrop" onClick={running ? undefined : onClose}>
      <div className="dev-modal system-update" onClick={(e) => e.stopPropagation()}>
        <h2 className="dev-modal__title">Atualizar sistema</h2>

        {!info && !error && <p className="dev-modal__hint">Consultando…</p>}

        {info && (
          <dl className="system-update__facts">
            <dt>Instalada</dt>
            <dd>{info.version || 'desconhecida'}{info.commit ? ' (' + info.commit + ')' : ''}</dd>
            <dt>Última no GitHub</dt>
            <dd>{latestTag || '—'}{info.latest?.publishedAt ? ' · ' + info.latest.publishedAt.slice(0, 10) : ''}</dd>
          </dl>
        )}
        {info?.latestError && <p className="dev-modal__hint system-update__warn">{info.latestError}</p>}

        {running ? (
          <p className="system-update__running">
            {running.action === 'rollback' ? 'Voltando pra versão anterior' : 'Atualizando'}… o sistema reinicia sozinho
            (uns 30 s a 1 min) e esta página recarrega quando ele voltar. Os tablets ficam sem conexão nesse tempo.
          </p>
        ) : confirm ? (
          <div className="system-update__confirm">
            <p>
              {confirm === 'rollback'
                ? 'Voltar pra versão anterior? O sistema reinicia (~1 min).'
                : 'Atualizar para ' + (latestTag || 'a última versão') + '? O sistema reinicia (~1 min) e os tablets ficam sem conexão nesse tempo.'}
            </p>
            <div className="dev-modal__actions">
              <button type="button" className="dev-modal__cancel" onClick={() => setConfirm(null)}>Não</button>
              <button type="button" className="dev-modal__submit" onClick={() => start(confirm)}>Sim</button>
            </div>
          </div>
        ) : (
          info && (
            <>
              {blockedReason && <p className="dev-modal__hint system-update__warn">{blockedReason}</p>}
              {upToDate && !blockedReason && <p className="dev-modal__hint">Já está na última versão.</p>}
              <div className="dev-modal__actions system-update__actions">
                <button type="button" className="dev-modal__cancel" onClick={onClose}>Fechar</button>
                {info.hasPrevious && (
                  <button type="button" className="dev-modal__cancel" disabled={!!blockedReason} onClick={() => setConfirm('rollback')}>
                    Voltar à anterior
                  </button>
                )}
                <button
                  type="button"
                  className="dev-modal__submit"
                  disabled={!!blockedReason || !latestTag || upToDate}
                  onClick={() => setConfirm('update')}
                >
                  Atualizar{latestTag && !upToDate ? ' para ' + latestTag : ''}
                </button>
              </div>
            </>
          )
        )}

        {error && <p className="dev-modal__error">{error}</p>}
        {info?.lastLog && (
          <details className="system-update__log">
            <summary>Log da última atualização</summary>
            <pre>{info.lastLog}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
