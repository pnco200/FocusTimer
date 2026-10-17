$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$baselineDirectory = Join-Path $repositoryRoot '.artifacts\reference-baseline'
& (Join-Path $repositoryRoot 'Reference-FocusTimer-SourceCode\build.ps1') -OutputDirectory $baselineDirectory
$baselineReport = Join-Path $baselineDirectory 'results.txt'
$baselineProcess = Start-Process `
    -FilePath (Join-Path $baselineDirectory 'Studytime.exe') `
    -ArgumentList ('--self-test "' + $baselineReport + '"') `
    -WindowStyle Hidden -PassThru -Wait
if (Test-Path -LiteralPath $baselineReport) {
    Get-Content -LiteralPath $baselineReport
}
if ($baselineProcess.ExitCode -ne 0) {
    throw "Reference self-test failed with exit code $($baselineProcess.ExitCode)"
}
