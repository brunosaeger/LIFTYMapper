# Roda NA MAQUINA ANTIGA (a que hoje roda o server.py), DEPOIS de parar o
# server.py. Junta numa pasta tudo que precisa ir pra VM -- logins, sessoes,
# historico, mapa calibrado (pontos, lotes, closes, grafo deformado,
# ocupacao/materiais), IP do robo e a chave SSH do robo -- e grava um
# hashes.txt que o instalar.ps1 confere do outro lado.
#
#   powershell -ExecutionPolicy Bypass -File packaging\vm\exportar-dados.ps1
#
# Os arquivos sao COPIADOS como estao (nada e aberto/regravado). A pasta
# gerada contem a chave do robo e os hashes das senhas: trate como senha
# (pendrive/pasta de rede restrita, apagar depois da instalacao).
param(
    [string]$Origem = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$Destino = (Join-Path ([Environment]::GetFolderPath('Desktop')) ('LIFTY-dados-' + (Get-Date -Format 'yyyy-MM-dd_HHmm')))
)
$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERRO: $msg" -ForegroundColor Red; exit 1 }

# 1) servidor parado? (senao o que for mexido no site depois da copia se perde)
if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
    Fail "tem algo rodando na porta 8000 (o server.py?). Pare o servidor antes de exportar."
}

# 2) robo ocioso? (rota em andamento seria retomada pela VM -- melhor nao)
$queue = Join-Path $Origem 'queue_state.json'
if (Test-Path $queue) {
    $q = Get-Content $queue -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($q.currentRoute) { Write-Host "AVISO: havia uma rota em andamento quando o servidor parou. Confira se o robo esta ocioso." -ForegroundColor Yellow }
}

$obrigatorios = 'calibration.json', 'users.json'
$recomendados = 'session_secret.key', 'route_log.json', 'robot_host.txt', 'dock_shadow.jsonl'
foreach ($f in $obrigatorios) { if (-not (Test-Path (Join-Path $Origem $f))) { Fail "$f nao encontrado em $Origem" } }

$chave = @((Join-Path $Origem 'lifty_robot'), (Join-Path $HOME '.ssh\lifty_robot')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chave) { Fail "chave lifty_robot nao encontrada (nem na pasta do projeto nem em $HOME\.ssh)" }

New-Item -ItemType Directory -Force $Destino | Out-Null
$copiados = @()
foreach ($f in $obrigatorios + $recomendados) {
    $src = Join-Path $Origem $f
    if (Test-Path $src) { Copy-Item $src $Destino; $copiados += $f }
    else { Write-Host "  (sem $f -- ok, opcional)" -ForegroundColor DarkGray }
}
Copy-Item $chave (Join-Path $Destino 'lifty_robot'); $copiados += 'lifty_robot'

# 3) hashes pra conferir do outro lado
$linhas = foreach ($f in $copiados) { '{0};{1}' -f $f, (Get-FileHash (Join-Path $Destino $f) -Algorithm SHA256).Hash }
Set-Content -Path (Join-Path $Destino 'hashes.txt') -Value $linhas -Encoding ASCII

# 4) resumo pra conferir no site depois de subir na VM
$cal = Get-Content (Join-Path $Destino 'calibration.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$usr = Get-Content (Join-Path $Destino 'users.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hist = 0
if (Test-Path (Join-Path $Destino 'route_log.json')) {
    # atribuir antes de contar: no PowerShell 5.1, @(... | ConvertFrom-Json) de uma lista conta 1
    $log = Get-Content (Join-Path $Destino 'route_log.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $hist = @($log).Count
}
$resumo = @(
    "Exportado em $(Get-Date -Format 'yyyy-MM-dd HH:mm') de $env:COMPUTERNAME",
    "Usuarios:            $(@($usr).Count) ($((@($usr) | ForEach-Object username) -join ', '))",
    "Lotes:               $(@($cal.top.lots).Count)",
    "Pontos:              $(@($cal.top.points).Count)",
    "Closes:              $(@($cal.top.closeUps).Count)",
    "Pinos do grafo:      $(@($cal.top.robotWarp).Count)",
    "Posicoes ocupadas:   $(@($cal.occupied).Count)",
    "Rotas no historico:  $hist"
)
Set-Content -Path (Join-Path $Destino 'RESUMO.txt') -Value $resumo -Encoding ASCII

Write-Host ""
$resumo | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "Pasta pronta: $Destino" -ForegroundColor Green
Write-Host "Leve a pasta INTEIRA pra VM. Ela contem a chave do robo: nao deixe em pasta compartilhada."
