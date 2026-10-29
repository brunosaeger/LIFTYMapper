// Painel lateral do modo "Editar closes" (ver Toolbar.jsx/MainApp.jsx) —
// mesma forma de LotsPanel.jsx, sem swatches de cor: a área de Close Up é
// sempre desenhada no laranja fixo do tema (ver FloorPlanCanvas.jsx,
// CloseUpMarker), não é escolhida pelo desenvolvedor.
export default function CloseUpsPanel({
  closeUps, selectedCloseUpId, addActive, onStartAdd, onCancelAdd, onSelect, onRename, onDelete,
  robotGraphEditing, onToggleRobotGraph, robotFrameAdjusted, onResetRobotFrame,
  robotGraphTool, onRobotGraphToolChange, robotWarpRadiusM, onRobotWarpRadiusChange,
  robotWarpCount, onUndoRobotWarp, onClearRobotWarp, routeOpacity, onRouteOpacityChange,
}) {
  return (
    <div className="lots-panel">
      <h2 className="points-panel__title">Close Up ({closeUps.length})</h2>
      <button
        type="button"
        className={'closeups-panel__add' + (addActive ? ' is-active' : '')}
        onClick={() => (addActive ? onCancelAdd() : onStartAdd())}
      >
        {addActive ? 'Arraste na planta…' : '+ Close Up'}
      </button>
      {closeUps.length === 0 && !addActive && (
        <p className="points-panel__empty">Nenhuma área criada ainda.</p>
      )}
      <ul className="points-panel__list">
        {closeUps.map((c) => (
          <li key={c.id} className="lots-panel__row">
            <div
              className={'points-panel__row lots-panel__row-main' + (c.id === selectedCloseUpId ? ' is-selected' : '')}
              onClick={() => onSelect(c.id)}
            >
              <input
                className="points-panel__input"
                value={c.name}
                onChange={(e) => onRename(c.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                aria-label="Nome da área de Close Up"
              />
              <button
                type="button"
                className="points-panel__delete"
                aria-label={'Remover Close Up ' + c.name}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm('Remover a área "' + c.name + '"?')) onDelete(c.id);
                }}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="points-panel__hint">
        Cada área serve pra centralizar um zoom no modo Interação — o
        operador toca dentro dela e o mapa amplia automaticamente aquele
        grupo de kanban.
      </p>
      {/* Ajuste fino do grafo de rotas do robô sobre a planta (RobotOverlay.jsx).
          Só aparece ligado: a caixa cobre quase a planta toda e, sempre
          visível, roubaria o toque das áreas de Close Up embaixo dela. */}
      <h2 className="points-panel__title">Grafo do robô</h2>
      <button
        type="button"
        className={'closeups-panel__add' + (robotGraphEditing ? ' is-active' : '')}
        onClick={onToggleRobotGraph}
      >
        {robotGraphEditing ? 'Concluir ajuste' : 'Ajustar grafo do robô'}
      </button>
      {robotGraphEditing && (
        <>
          {/* rota desenhada no mapa (a que o operador vê), não o grafo ciano */}
          <label className="graph-tools__radius">
            Opacidade da rota: <strong>{Math.round(routeOpacity * 100)}%</strong>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={Math.round(routeOpacity * 100)}
              onChange={(e) => onRouteOpacityChange(Number(e.target.value) / 100)}
            />
          </label>
          <div className="graph-tools" role="radiogroup" aria-label="Ferramenta do grafo">
            <button
              type="button"
              role="radio"
              aria-checked={robotGraphTool === 'frame'}
              className={'graph-tools__option' + (robotGraphTool === 'frame' ? ' is-active' : '')}
              onClick={() => onRobotGraphToolChange('frame')}
            >
              Mover / esticar
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={robotGraphTool === 'warp'}
              className={'graph-tools__option' + (robotGraphTool === 'warp' ? ' is-active' : '')}
              onClick={() => onRobotGraphToolChange('warp')}
            >
              Deformar
            </button>
          </div>
          {robotGraphTool === 'frame' ? (
            <>
              <button
                type="button"
                className="closeups-panel__add"
                disabled={!robotFrameAdjusted}
                onClick={() => {
                  if (window.confirm('Voltar o grafo pro encaixe automático (descarta mover/esticar/girar)?')) onResetRobotFrame();
                }}
              >
                Resetar ajuste
              </button>
              <p className="points-panel__hint">
                Arraste dentro da caixa pra mover; alças dos lados/cantos esticam,
                a de cima gira. Salva ao soltar.
              </p>
            </>
          ) : (
            <>
              <label className="graph-tools__radius">
                Área de influência: <strong>{robotWarpRadiusM} m</strong>
                <input
                  type="range"
                  min={2}
                  max={30}
                  step={1}
                  value={robotWarpRadiusM}
                  onChange={(e) => onRobotWarpRadiusChange(Number(e.target.value))}
                />
              </label>
              <div className="graph-tools__row">
                <button type="button" className="closeups-panel__add" disabled={!robotWarpCount} onClick={onUndoRobotWarp}>
                  Desfazer última
                </button>
                <button
                  type="button"
                  className="closeups-panel__add"
                  disabled={!robotWarpCount}
                  onClick={() => {
                    if (window.confirm('Apagar todas as ' + robotWarpCount + ' deformações do grafo?')) onClearRobotWarp();
                  }}
                >
                  Limpar todas
                </button>
              </div>
              <p className="points-panel__hint">
                Clique perto de um trecho do grafo e arraste: ele vai junto e a
                vizinhança dentro do círculo acompanha, cada vez menos. O robô e
                as rotas seguem a mesma deformação. {robotWarpCount} deformaç{robotWarpCount === 1 ? 'ão' : 'ões'} salva{robotWarpCount === 1 ? '' : 's'}.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
