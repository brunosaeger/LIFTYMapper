import { useEffect, useRef, useState } from 'react';

// Sub-seção "Altura de pallets" do editor (modo desenvolvedor), ANTES de
// "Pontos avulsos" e "Lotes". Dois campos de altura do pallet AZUL:
//  - "Altura do pallet azul padrão"  -> blueBase (andar de baixo, layer 2).
//    Pré-setado sempre no valor que o azul já recebe (8).
//  - "Altura do segundo pallet"      -> blueTop (2º andar do pallet de dois
//    níveis, layer 3). Sem padrão de fábrica — o valor exibido é sempre o
//    último que foi salvo (o operário sem modo desenvolvedor não vê nem
//    mexe nisso; só usa a checkbox "Pallet de cima" no Ponto a Ponto).
// Madeira não empilha, então não tem campo — sua altura continua 0.
//
// Inputs NÃO-controlados (defaultValue + key = valor do servidor): assim o
// campo gerencia o próprio texto enquanto edita, e quando o valor do
// servidor muda (load, ou outro dispositivo salvou) o key troca e o React
// remonta com o novo defaultValue — sem estado local nem efeito de sync.
// Salva no blur (ou Enter) via mutação cirúrgica (/api/pallet-heights).
export default function PalletHeightsPanel({ heights, onSave }) {
  const [flash, setFlash] = useState(null); // 'saved' | 'error' | null
  const flashTimer = useRef(null);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  function showFlash(kind) {
    setFlash(kind);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2000);
  }

  function commit(key, rawEl, serverVal) {
    const n = Number(rawEl.value);
    if (!Number.isFinite(n) || n < 0) {
      rawEl.value = String(serverVal); // valor inválido — volta pro do servidor
      return;
    }
    const rounded = Math.round(n);
    rawEl.value = String(rounded);
    if (rounded === serverVal) return; // nada mudou
    onSave({ [key]: rounded }).then(() => showFlash('saved')).catch(() => showFlash('error'));
  }

  function field(key, label, serverVal) {
    return (
      <label className="pallet-heights__row">
        <span className="pallet-heights__label">{label}</span>
        <input
          key={key + '-' + serverVal}
          type="number" min="0" step="1" inputMode="numeric"
          className="pallet-heights__input"
          defaultValue={serverVal}
          onBlur={(e) => commit(key, e.currentTarget, serverVal)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </label>
    );
  }

  return (
    <div className="points-panel pallet-heights">
      <h2 className="points-panel__title">Altura de pallets</h2>
      {field('blueBase', 'Altura do pallet azul padrão', heights.blueBase)}
      {field('blueTop', 'Altura do segundo pallet', heights.blueTop)}
      {flash && (
        <p className={'pallet-heights__flash' + (flash === 'error' ? ' is-error' : '')}>
          {flash === 'error' ? 'Erro ao salvar' : 'Salvo ✓'}
        </p>
      )}
      <p className="points-panel__hint">
        O andar de baixo é o pallet azul rente aos pezinhos. O “segundo pallet” é
        o andar de cima do pallet de dois níveis — o operador liga pela checkbox
        <strong> “Pallet de cima”</strong> no Ponto a Ponto. Madeira não empilha.
      </p>
    </div>
  );
}
