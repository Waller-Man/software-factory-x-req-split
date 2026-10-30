$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'harness')
try {
    foreach ($script in @('scripts/typecheck.mjs', 'scripts/build.mjs', 'scripts/prepare-python.mjs')) {
        & node $script
        if ($LASTEXITCODE -ne 0) { throw "构建失败：$script" }
    }
} finally { Pop-Location }
Write-Host '构建和 Python 安装准备完成；请在现有 DSH 中安装并启用。'
