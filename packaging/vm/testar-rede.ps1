# Roda NA VM, antes de instalar (e de novo se algo nao conectar). Nao instala
# nem altera nada -- so testa.
#
#   powershell -ExecutionPolicy Bypass -File .\testar-rede.ps1
#   powershell -ExecutionPolicy Bypass -File .\testar-rede.ps1 -OuvirTablet
#
# Com -OuvirTablet, depois dos testes fica ouvindo na porta 8000 pra testar se
# um tablet alcanca a VM (precisa da regra de firewall da 8000 -- o
# instalar.ps1 cria; ou a infra). A pagina no tablet da erro, e normal: o que
# vale e aparecer "Tablet chegou" aqui.
param(
    [string]$Robo = '192.168.5.195',
    [switch]$OuvirTablet
)

$tudoOk = $true
function Linha($ok, $texto) {
    if ($ok) { Write-Host "  OK    $texto" -ForegroundColor Green }
    else { Write-Host "  FALHA $texto" -ForegroundColor Red; $script:tudoOk = $false }
}

Write-Host "IPs desta VM:"
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "  $($_.IPAddress)  ($($_.InterfaceAlias), $($_.PrefixOrigin))" }
Write-Host ""
Write-Host "Robo $Robo (precisa estar LIGADO, e com o bridge no ar pra 8091):"
foreach ($p in @(@(80, 'dispatch: tarefas e posicao'), @(8091, 'bridge: garfo, obstaculo, modo sombra'), @(22, 'SSH: religar o bridge'))) {
    $r = Test-NetConnection $Robo -Port $p[0] -WarningAction SilentlyContinue
    Linha $r.TcpTestSucceeded ("porta {0,-5} {1}" -f $p[0], $p[1])
}
Write-Host ""
Write-Host "Programas:"
$ssh = Get-Command ssh -ErrorAction SilentlyContinue
Linha ([bool]$ssh) "cliente OpenSSH (ssh) $(if ($ssh) { $ssh.Source } else { '-- o instalar.ps1 tenta ligar' })"
if (Get-NetFirewallRule -DisplayName 'LIFTY 8000' -ErrorAction SilentlyContinue) { Linha $true "regra de firewall 'LIFTY 8000'" }
else { Write-Host "  --    regra de firewall 'LIFTY 8000' ainda nao existe (o instalar.ps1 cria)" -ForegroundColor Yellow }

Write-Host ""
if ($tudoOk) { Write-Host "Tudo certo." -ForegroundColor Green }
else { Write-Host "Ha falhas acima. Portas do robo: pedir liberacao de rota pra infra. Porta 80 e obrigatoria." -ForegroundColor Yellow }

if ($OuvirTablet) {
    $l = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 8000)
    try { $l.Start() } catch { Write-Host "Nao deu pra ouvir na 8000 (servico LIFTY ja rodando?): $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
    Write-Host ""
    Write-Host "Ouvindo na 8000. No tablet, abra http://<IP desta VM>:8000 (Ctrl+C cancela)..."
    $c = $l.AcceptTcpClient()
    Write-Host "Tablet chegou! ($($c.Client.RemoteEndPoint))" -ForegroundColor Green
    $c.Close(); $l.Stop()
}
