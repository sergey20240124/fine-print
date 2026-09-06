# Синхронизация с GitHub одной командой: .\sync.ps1 "сообщение коммита"
#
# Порядок неслучаен: сначала фиксируем своё, потом подтягиваем чужое
# (бот коммитит data/ после каждого прогона), потом отправляем.
#
# ВАЖНО про $ErrorActionPreference: он намеренно НЕ "Stop". git пишет
# предупреждения и прогресс в stderr, а PowerShell в режиме Stop считает
# любой вывод в stderr ошибкой и валит скрипт на ровном месте. У нативных
# команд надёжный признак один — $LASTEXITCODE, его и проверяем.

param([string]$m = "правки")

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

function Die($text) { Write-Host "`n$text" -ForegroundColor Red; exit 1 }

if (git status --porcelain) {
    git add -A
    git commit -m $m
    if ($LASTEXITCODE -ne 0) { Die "коммит не прошёл" }
    Write-Host "закоммичено: $m" -ForegroundColor Green
} else {
    Write-Host "локальных изменений нет" -ForegroundColor DarkGray
}

git pull --rebase
if ($LASTEXITCODE -ne 0) {
    Die @"
Rebase остановился. Если конфликт в data/ — берите удалённую версию:
  git checkout --theirs data/ ; git add data/ ; git rebase --continue ; git push
"@
}

git push
if ($LASTEXITCODE -ne 0) { Die "push не прошёл" }

Write-Host "`nотправлено. Пересборка: Actions -> daily scan -> Run workflow" -ForegroundColor Green
