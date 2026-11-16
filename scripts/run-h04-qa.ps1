$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ($repoRoot -ne 'C:\Users\thega\Desktop\YoungKingZ-U03-Implementation') { throw 'Unexpected H04 workspace' }
$targetName = 'youngkingz_h04_qa_20261115'
$present = docker exec supabase_db_youngkingz-h01 psql -U postgres -d $targetName -Atc "select current_database() where to_regclass('inventory.entries') is not null"
if ($LASTEXITCODE -ne 0 -or $present -ne $targetName) { throw 'Isolated H04 QA database is not ready. See artifacts/h04/PROGRESS.md.' }
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:55322/$targetName"
Push-Location $repoRoot
try { pnpm dev } finally { Pop-Location }
