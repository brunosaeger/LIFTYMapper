const SAVE_LABEL = {
  loading: 'Carregando…',
  idle: 'Salvo',
  saving: 'Salvando…',
  error: 'Erro ao salvar',
};

export default function Toolbar({ mode, onModeChange, addTool, onStartAddPoint, onStartAddLot, onCancelAdd, saveStatus, theme, onToggleTheme, devMode, onDevButtonClick }) {
  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__brand-33">33</span>
        <span>LIFTY MAPPER</span>
      </div>

      {/* "Editar pontos", "Histórico" e os botões de + Ponto/+ Lote abaixo só
          existem dentro do modo desenvolvedor (ver App.jsx: DEV_PASSWORD,
          botão "{ }" no fim da toolbar) — sem ele, mode nunca chega a 'edit'
          nem 'history' por nenhum caminho alcançável da UI. */}
      {devMode && (
        <div className="toolbar__modes" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            className={'toolbar__mode' + (mode === 'edit' ? ' is-active' : '')}
            onClick={() => onModeChange('edit')}
          >
            Editar pontos
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'history'}
            className={'toolbar__mode' + (mode === 'history' ? ' is-active' : '')}
            onClick={() => onModeChange('history')}
          >
            Histórico
          </button>
        </div>
      )}

      <div className="toolbar__actions">
        {devMode && mode === 'edit' && (
          <>
            <button
              type="button"
              className={'toolbar__add' + (addTool === 'point' ? ' is-active' : '')}
              onClick={() => (addTool === 'point' ? onCancelAdd() : onStartAddPoint())}
            >
              {addTool === 'point' ? 'Clique na planta…' : '+ Ponto'}
            </button>
            <button
              type="button"
              className={'toolbar__add' + (addTool === 'lot' ? ' is-active' : '')}
              onClick={() => (addTool === 'lot' ? onCancelAdd() : onStartAddLot())}
            >
              {addTool === 'lot' ? 'Arraste na planta…' : '+ Lote'}
            </button>
          </>
        )}
        <button
          type="button"
          className="toolbar__theme"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Tema escuro — clique pra mudar pro claro' : 'Tema claro — clique pra mudar pro escuro'}
          aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
        >
          {theme === 'dark' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          )}
        </button>
        <span className={'toolbar__save toolbar__save--' + saveStatus}>{SAVE_LABEL[saveStatus]}</span>
        <button
          type="button"
          className={'toolbar__dev' + (devMode ? ' is-active' : '')}
          onClick={onDevButtonClick}
          title={devMode ? 'Sair do modo desenvolvedor' : 'Entrar no modo desenvolvedor'}
          aria-label={devMode ? 'Sair do modo desenvolvedor' : 'Entrar no modo desenvolvedor'}
        >
          {'{ }'}
        </button>
      </div>
    </header>
  );
}
