# Atualiza o LIFTY na VM com UM comando (PowerShell COMO ADMINISTRADOR):
#
#   powershell -ExecutionPolicy Bypass -File C:\LIFTY\atualizar.ps1
#
# Na 1a vez (antes deste script existir em C:\LIFTY), baixa ele e roda, numa linha:
#
#   [Net.ServicePointManager]::SecurityProtocol='Tls12'; irm https://raw.githubusercontent.com/brunosaeger/LIFTYMapper/main/packaging/vm/atualizar.ps1 -OutFile C:\LIFTY\atualizar.ps1; powershell -ExecutionPolicy Bypass -File C:\LIFTY\atualizar.ps1
#
# Depois disso o proprio instalar.ps1 mantem o C:\LIFTY\atualizar.ps1 em dia.
#
# O que faz, nesta ordem (para no primeiro problema, sem trocar nada):
#   1. confere se o robo esta ocioso (nenhuma rota rodando nem na fila);
#   2. baixa o pacote LIFTY-VM.zip da ultima Release do GitHub;
#   3. guarda o programa atual em C:\LIFTY\backups\programa-anterior;
#   4. roda o instalar.ps1 do pacote novo (so troca o .exe; dados ficam) e religa.
#
# Opcoes:
#   -Zip C:\caminho\LIFTY-VM.zip   usa um zip ja baixado (VM sem internet)
#   -Forcar                        atualiza mesmo com rota na fila (NAO recomendado)
#   -Voltar                        volta pro programa anterior (o do passo 3)
#
# Sem 'exit' de proposito: rodando via 'irm | iex', exit fecharia a janela.
param(
    [string]$Zip,
    [switch]$Forcar,
    [switch]$Voltar,
    [string]$Pasta = 'C:\LIFTY'
)
$ErrorActionPreference = 'Stop'
$Servico = 'LIFTY-SERVICE'
$Url = 'https://github.com/brunosaeger/LIFTYMapper/releases/latest/download/LIFTY-VM.zip'
$anterior = Join-Path $Pasta 'backups\programa-anterior'

function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
function Para($t) { Write-Host ""; Write-Host "PAREI: $t" -ForegroundColor Red; Write-Host "Nada foi trocado." -ForegroundColor Yellow }

& {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { Para "abra o PowerShell como Administrador."; return }
    $nssm = Join-Path $Pasta 'nssm.exe'
    if (-not (Test-Path (Join-Path $Pasta 'LIFTY-SERVICE.exe')) -or -not (Test-Path $nssm)) {
        Para "nao achei o LIFTY instalado em $Pasta (1a instalacao e pelo instalar.ps1 com -Dados)."; return
    }

    if ($Voltar) {
        if (-not (Test-Path (Join-Path $anterior 'LIFTY-SERVICE.exe'))) { Para "nao existe programa anterior guardado em $anterior."; return }
        Write-Host "Voltando pro programa anterior..."
        & $nssm stop $Servico | Out-Null; Start-Sleep 3
        Copy-Item (Join-Path $anterior 'LIFTY-SERVICE.exe') $Pasta -Force
        if (Test-Path (Join-Path $anterior 'VERSAO.txt')) { Copy-Item (Join-Path $anterior 'VERSAO.txt') $Pasta -Force }
        & $nssm start $Servico | Out-Null
        Ok "programa anterior de volta e servico religado."
        return
    }

    # 1. robo ocioso? (o servidor guarda a fila em queue_state.json)
    $fila = Join-Path $Pasta 'queue_state.json'
    if (Test-Path $fila) {
        $q = Get-Content $fila -Raw -Encoding UTF8 | ConvertFrom-Json
        $ocupado = [bool]$q.currentRoute -or [bool]$q.pendingRoute -or (@($q.routeQueue | Where-Object { $_ }).Count -gt 0)
        if ($ocupado -and -not $Forcar) { Para "tem rota rodando ou na fila. Espere o robo ficar ocioso e rode de novo."; return }
        if ($ocupado) { Write-Host "  !!  rota na fila, atualizando mesmo assim (-Forcar)" -ForegroundColor Yellow } else { Ok "robo ocioso (fila vazia)" }
    }

    # 2. pacote novo
    $tmp = Join-Path $env:TEMP ('lifty-atualizacao-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    if (-not $Zip) {
        Write-Host "Baixando a ultima versao do GitHub..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $Zip = Join-Path $tmp 'LIFTY-VM.zip'
        try { Invoke-WebRequest $Url -OutFile $Zip -UseBasicParsing -TimeoutSec 300 }
        catch { Para "nao consegui baixar ($($_.Exception.Message)). Sem internet na VM? Baixe o LIFTY-VM.zip em outro PC e rode com -Zip."; return }
    }
    if (-not (Test-Path $Zip)) { Para "zip nao encontrado: $Zip"; return }
    Expand-Archive $Zip (Join-Path $tmp 'pacote') -Force
    $instalar = Get-ChildItem (Join-Path $tmp 'pacote') -Recurse -Filter instalar.ps1 | Select-Object -First 1
    if (-not $instalar) { Para "o zip nao tem o instalar.ps1 -- e o LIFTY-VM.zip certo?"; return }
    $novo = $instalar.DirectoryName
    $versaoNova = if (Test-Path (Join-Path $novo 'VERSAO.txt')) { (Get-Content (Join-Path $novo 'VERSAO.txt') -TotalCount 1).Trim() } else { '(sem VERSAO.txt)' }
    $versaoAtual = if (Test-Path (Join-Path $Pasta 'VERSAO.txt')) { (Get-Content (Join-Path $Pasta 'VERSAO.txt') -TotalCount 1).Trim() } else { '(desconhecida)' }
    Ok "pacote pronto: versao $versaoNova (instalada hoje: $versaoAtual)"

    # 3. guarda o programa atual (copiar o .exe rodando e so leitura -- pode)
    New-Item -ItemType Directory -Force $anterior | Out-Null
    Copy-Item (Join-Path $Pasta 'LIFTY-SERVICE.exe') $anterior -Force
    if (Test-Path (Join-Path $Pasta 'VERSAO.txt')) { Copy-Item (Join-Path $Pasta 'VERSAO.txt') $anterior -Force }
    Ok "programa atual guardado em $anterior"

    # 4. troca e religa (instalar.ps1 sem -Dados = so atualiza o programa)
    Write-Host ""
    & powershell -NoProfile -ExecutionPolicy Bypass -File $instalar.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "O instalar.ps1 deu erro (acima). Pra voltar: powershell -ExecutionPolicy Bypass -File C:\LIFTY\atualizar.ps1 -Voltar" -ForegroundColor Red
        return
    }
    if (Test-Path (Join-Path $novo 'VERSAO.txt')) { Copy-Item (Join-Path $novo 'VERSAO.txt') $Pasta -Force }
    Copy-Item (Join-Path $novo 'atualizar.ps1') $Pasta -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "Atualizado para $versaoNova." -ForegroundColor Green
    Write-Host "Se algo ficou estranho: powershell -ExecutionPolicy Bypass -File C:\LIFTY\atualizar.ps1 -Voltar"
}
