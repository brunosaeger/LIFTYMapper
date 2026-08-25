// Mesma paleta de src/index.css, em hex literal — Konva desenha em canvas e
// não lê custom properties do CSS, então os valores precisam existir também
// aqui. Mantenha os dois em sincronia se a paleta mudar.
const DARK_COLORS = {
  panelBase: '#0e1116',
  panelRaised: '#171c22',
  panelRaisedHi: '#1e242c',
  panelLine: '#262e38',
  accentAmber: '#f5a524',
  accentAmberDim: '#8a611c',
  accentCyan: '#2dd4bf',
  accentCyanDim: '#1c766c',
  textPrimary: '#edeff3',
  textMuted: '#8a93a3',
  stateError: '#f45b69',
  stateSuccess: '#4ade80',
};

// Só os tokens de superfície/texto mudam no claro — ver o mesmo comentário
// em index.css sobre por que cor de acento/estado fica igual nos dois
// temas.
const LIGHT_COLORS = {
  ...DARK_COLORS,
  panelBase: '#f4f5f7',
  panelRaised: '#ffffff',
  panelRaisedHi: '#e9ebef',
  panelLine: '#d3d7de',
  textPrimary: '#1b1f27',
  textMuted: '#5b6270',
};

// Konva lê `COLORS.xxx` direto (não é CSS, não reage a re-render sozinho)
// — por isso é o MESMO objeto sempre (import estável em todo componente),
// só com as propriedades sobrescritas em lugar (Object.assign) quando o
// tema muda. applyTheme (chamada em App.jsx) muta esse objeto; quem
// dispara o redesenho é o React re-renderizando o Stage/Layer depois —
// ver useEffect de tema em App.jsx.
export const COLORS = { ...DARK_COLORS };

export function applyTheme(theme) {
  Object.assign(COLORS, theme === 'light' ? LIGHT_COLORS : DARK_COLORS);
}

// Cores de lote selecionáveis pelo usuário (painel de lotes). Chave = valor
// salvo em lot.color; preenchimento usa o hex cheio com alpha (hexToRgba), a
// borda usa uma versão mais escura do mesmo hex (darkenHex) — mais contraste
// contra o preenchimento semitransparente, deixa a divisão entre células
// grudadas mais evidente do que usar a mesma cor vivo em ambos.
export const LOT_COLORS = {
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
};

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function darkenHex(hex, amount = 0.4) {
  const { r, g, b } = hexToRgb(hex);
  const scale = 1 - amount;
  return `rgb(${Math.round(r * scale)}, ${Math.round(g * scale)}, ${Math.round(b * scale)})`;
}
