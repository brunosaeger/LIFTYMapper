# Roda NA VM, no PowerShell COMO ADMINISTRADOR, de dentro da pasta do pacote
# LIFTY-VM (a que veio do GitHub Actions, ja extraida).
#
# Instalacao (1a vez), com a pasta que o exportar-dados.ps1 gerou:
#   powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -Dados C:\caminho\LIFTY-dados-AAAA-MM-DD_HHMM
#   ... confere tudo, desliga o server.py da maquina antiga, e entao:
#   powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -Iniciar
#
# Atualizacao do programa (servico ja instalado): so troca o .exe, os dados
# ficam como estao. Com o robo ocioso:
#   powershell -ExecutionPolicy Bypass -File .\instalar.ps1
#
# Pode rodar de novo sem medo: cada passo confere se ja foi feito. Dados que ja
# existem na pasta do servico NUNCA sao sobrescritos (a nao ser com
# -SobrescreverDados, que guarda uma copia antes).
param(
    [string]$Pasta = 'C:\LIFTY',
    [string]$Dados,
    [switch]$Iniciar,
    [switch]$SobrescreverDados
)
$ErrorActionPreference = 'Stop'
$Servico = 'LIFTY-SERVICE'
$aqui = $PSScriptRoot

function Passo($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERRO: $msg" -ForegroundColor Red; exit 1 }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail "abra o PowerShell como Administrador." }
foreach ($f in 'LIFTY-SERVICE.exe', 'nssm.exe') {
    if (-not (Test-Path (Join-Path $aqui $f))) { Fail "$f nao esta na pasta do pacote ($aqui)." }
}
Get-ChildItem $aqui | Unblock-File -ErrorAction SilentlyContinue  # arquivo baixado da internet
$nssm = Join-Path $Pasta 'nssm.exe'
$existe = [bool](Get-Service $Servico -ErrorAction SilentlyContinue)

Passo "1. Pasta $Pasta"
New-Item -ItemType Directory -Force (Join-Path $Pasta 'logs') | Out-Null
if ($existe -and (Get-Service $Servico).Status -ne 'Stopped') {
    Write-Host "Parando o servico pra trocar o programa..."
    & $nssm stop $Servico | Out-Null
    Start-Sleep 3
}
Copy-Item (Join-Path $aqui 'LIFTY-SERVICE.exe') $Pasta -Force
Copy-Item (Join-Path $aqui 'nssm.exe') $Pasta -Force
Write-Host "LIFTY-SERVICE.exe e nssm.exe copiados."

if ($Dados) {
    Passo "2. Dados (logins, historico, mapa calibrado, closes, grafo, chave do robo)"
    if (-not (Test-Path (Join-Path $Dados 'hashes.txt'))) { Fail "$Dados nao parece a pasta do exportar-dados.ps1 (falta hashes.txt)." }
    $lista = Get-Content (Join-Path $Dados 'hashes.txt') | ForEach-Object { $n, $h = $_ -split ';'; [pscustomobject]@{ Nome = $n; Hash = $h } }
    $jaTem = $lista | Where-Object { Test-Path (Join-Path $Pasta $_.Nome) }
    if ($jaTem -and -not $SobrescreverDados) {
        Fail ("ja existem dados em $Pasta (" + (($jaTem | ForEach-Object Nome) -join ', ') + "). Nada foi sobrescrito. Se for isso mesmo, rode de novo com -SobrescreverDados.")
    }
    if ($jaTem) {
        $bk = Join-Path $Pasta ('antes-de-sobrescrever-' + (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
        New-Item -ItemType Directory -Force $bk | Out-Null
        $jaTem | ForEach-Object { Copy-Item (Join-Path $Pasta $_.Nome) $bk }
        Write-Host "Copia dos dados antigos em $bk"
    }
    foreach ($item in $lista) {
        $dst = Join-Path $Pasta $item.Nome
        Copy-Item (Join-Path $Dados $item.Nome) $dst -Force
        $h = (Get-FileHash $dst -Algorithm SHA256).Hash
        if ($h -ne $item.Hash) { Fail "$($item.Nome) chegou DIFERENTE do original (hash nao bate). Copie a pasta de novo." }
        Write-Host ("  OK  {0}" -f $item.Nome) -ForegroundColor Green
    }
    if (Test-Path (Join-Path $Dados 'RESUMO.txt')) { Copy-Item (Join-Path $Dados 'RESUMO.txt') (Join-Path $Pasta 'RESUMO-da-migracao.txt') -Force }
}

$chave = Join-Path $Pasta 'lifty_robot'
if (Test-Path $chave) {
    Passo "3. Permissao da chave do robo (so SYSTEM e Administradores)"
    # O ssh do Windows recusa chave com permissao aberta ou de outro dono.
    # SIDs em vez de nomes: funciona com Windows em portugues ou ingles.
    icacls $chave /setowner '*S-1-5-32-544' | Out-Null
    icacls $chave /inheritance:r /grant:r '*S-1-5-18:R' '*S-1-5-32-544:F' | Out-Null
    Write-Host "Chave protegida."
} elseif (-not $existe) {
    Write-Host "AVISO: sem a chave lifty_robot em $Pasta -- o bridge nao vai religar sozinho depois de o robo reiniciar." -ForegroundColor Yellow
}

Passo "4. Cliente OpenSSH (pra religar o bridge do robo)"
if (Get-Command ssh -ErrorAction SilentlyContinue) { Write-Host "Ja instalado." }
else {
    Write-Host "Ligando o recurso do Windows (pode levar alguns minutos)..."
    try { Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' | Out-Null; Write-Host "Instalado." }
    catch { Write-Host "AVISO: nao deu pra instalar o OpenSSH ($($_.Exception.Message)). Peca pra infra." -ForegroundColor Yellow }
}

Passo "5. Firewall (entrada TCP 8000)"
if (Get-NetFirewallRule -DisplayName 'LIFTY 8000' -ErrorAction SilentlyContinue) { Write-Host "Regra ja existe." }
else { New-NetFirewallRule -DisplayName 'LIFTY 8000' -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow | Out-Null; Write-Host "Regra criada." }

Passo "6. Servico do Windows ($Servico)"
if (-not $existe) {
    & $nssm install $Servico (Join-Path $Pasta 'LIFTY-SERVICE.exe') | Out-Null
    Write-Host "Servico registrado."
}
$log = Join-Path $Pasta 'logs\lifty.log'
& $nssm set $Servico AppDirectory $Pasta | Out-Null
& $nssm set $Servico Start SERVICE_AUTO_START | Out-Null
& $nssm set $Servico AppStdout $log | Out-Null
& $nssm set $Servico AppStderr $log | Out-Null
& $nssm set $Servico AppRotateFiles 1 | Out-Null
& $nssm set $Servico AppRotateBytes 10485760 | Out-Null
& $nssm set $Servico AppExit Default Restart | Out-Null
& $nssm set $Servico AppRestartDelay 5000 | Out-Null
Write-Host "Inicia com o Windows, reinicia sozinho se cair, log em $log"

# Atualizacao: o servico ja existia e estava rodando -> volta a rodar.
if ($existe -and -not $Dados) { $Iniciar = $true }

if (-not $Iniciar) {
    Write-Host ""
    Write-Host "Instalado, mas NAO iniciado." -ForegroundColor Yellow
    Write-Host "Antes de iniciar: DESLIGUE o server.py da maquina antiga (dois servidores = dois cerebros mandando no mesmo robo)."
    Write-Host "Depois: powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -Iniciar"
    exit 0
}

Passo "7. Iniciando"
& $nssm start $Servico | Out-Null
$ok = $false
foreach ($i in 1..30) {
    Start-Sleep 1
    try { Invoke-WebRequest 'http://localhost:8000' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { }
}
if ($ok) { Write-Host "No ar: http://localhost:8000" -ForegroundColor Green }
else { Write-Host "Nao respondeu em 30 s. Veja o log abaixo." -ForegroundColor Red }
if (Test-Path $log) { Write-Host ""; Write-Host "Ultimas linhas de $log :"; Get-Content $log -Tail 15 -Encoding UTF8 }
if (Test-Path (Join-Path $Pasta 'RESUMO-da-migracao.txt')) {
    Write-Host ""; Write-Host "Confira no site se bate com o que veio da maquina antiga:"
    Get-Content (Join-Path $Pasta 'RESUMO-da-migracao.txt')
}
