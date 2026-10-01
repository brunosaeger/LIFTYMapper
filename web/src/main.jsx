import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// App de tablet: segurar o dedo (arrastar tarefa, marcar ponto no mapa...)
// não pode abrir o menu do Chrome (baixar, imprimir, modo de leitura...).
// Campos de texto ficam de fora — ali o menu serve pra colar.
document.addEventListener('contextmenu', (e) => {
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return
  e.preventDefault()
})

// Altura real da tela (ver App.css, `.app`/`.login-screen`) — `100vh` mente
// em vários WebViews Android (principalmente tablets mais simples/com skin
// customizada, ex. Lenovo ZUI): ele mede a altura "cheia" da tela, não a
// área realmente visível depois da barra de navegação do sistema. Isso faz
// o app se achar maior do que a tela de verdade, empurrando o fim da
// sidebar (onde fica o botão "Enviar tarefa") pra fora — sem nada
// "transbordando" do ponto de vista do CSS, então o `overflow-y: auto` da
// sidebar nunca liga (achava que já cabia tudo) e não tinha como rolar até
// lá. `window.innerHeight` reflete a área visível de verdade nesses casos.
function setRealViewportHeight() {
  document.documentElement.style.setProperty('--app-vh', window.innerHeight + 'px')
}
setRealViewportHeight()
window.addEventListener('resize', setRealViewportHeight)
window.addEventListener('orientationchange', setRealViewportHeight)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
