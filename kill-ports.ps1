$ports = @(5175, 5176, 11888)
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $pid = $conn.OwningProcess
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        Write-Host "Port $port -> PID $pid ($($proc.ProcessName))"
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Write-Host "  Killed"
    }
}
