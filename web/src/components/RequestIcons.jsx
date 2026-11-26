// Ícones da Solicitação de pallets — desenho próprio, traço grosso em
// isométrico (pallet visto de cima/lado). Cor = currentColor; as faces da
// caixa usam o fundo do painel pra esconder as linhas do pallet atrás dela.
// Conta: P(x,y,z) = (6 + x + y, 44 + x/2 - y/2 - z) — pallet 26×26, deck em z=6.

const SVG_PROPS = {
  viewBox: '0 0 64 64',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 3,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
  'aria-hidden': true,
};

// Pallet com uma caixa em cima (cartão da solicitação no chat).
export function PalletBoxIcon(props) {
  return (
    <svg {...SVG_PROPS} {...props}>
      {/* tampo do pallet */}
      <polygon points="6,38 32,51 58,38 32,25" />
      {/* laterais da frente, com as aberturas do garfo */}
      <polygon points="6,38 32,51 32,57 6,44" />
      <polygon points="32,51 58,38 58,44 32,57" />
      <polygon points="14,48 14,45 24,50 24,53" />
      <polygon points="40,53 40,50 50,45 50,48" />
      <g style={{ fill: 'var(--panel-base)' }}>
        <polygon points="14,20 32,27 32,45 14,38" />
        <polygon points="32,27 50,20 50,38 32,45" />
        <polygon points="14,20 32,11 50,20 32,27" />
      </g>
      {/* fita da caixa */}
      <polyline points="23,15.5 41,24.5 41,30.5" />
    </svg>
  );
}

// Mão aberta levantada (botão de solicitação na barrinha do chat).
export function RaisedHandIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}
