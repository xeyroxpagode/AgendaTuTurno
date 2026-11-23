$ErrorActionPreference = 'Stop'
$root = 'C:\Users\thega\Desktop\YoungKingZ-U03-Implementation'
Set-Location $root
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55322/youngkingz_h06_g01_20261122'
$ctx = Get-Content 'evidence/g01/crash-context.json' -Raw | ConvertFrom-Json
Write-Output "CONTEXT business=$($ctx.businessId) order=$($ctx.orderId) operation=$($ctx.operationId)"

$out = Join-Path $root 'evidence/g01/deliver.out'
$err = Join-Path $root 'evidence/g01/deliver.err'
$proc = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'exec tsx scripts/g01-crash-recovery.ts deliver' -PassThru -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err
Write-Output "CHILD_PID=$($proc.Id)"

$saleCount = 0
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  $saleCount = [int](docker exec supabase_db_youngkingz-h01 psql -U postgres -d youngkingz_h06_g01_20261122 -Atc "select count(*) from sales.sales where business_id='$($ctx.businessId)';" 2>$null | Select-Object -First 1)
  if ($saleCount -ge 1) { break }
  if ($proc.HasExited) { break }
  Start-Sleep -Milliseconds 150
}
Write-Output "SALE_BEFORE_KILL=$saleCount"
if ($saleCount -lt 1) { throw 'No se observó la Sale antes del kill; no se ejecuta terminación.' }

Stop-Process -Id $proc.Id -Force
$proc.WaitForExit(10000) | Out-Null
Write-Output "KILLED_PID=$($proc.Id) EXIT=$($proc.ExitCode)"

docker exec supabase_db_youngkingz-h01 psql -U postgres -d youngkingz_h06_g01_20261122 -q -c 'drop trigger if exists g01_crash_sale on orders.product_orders;' | Out-Null
Write-Output 'FAULT_TRIGGER_REMOVED'

pnpm exec tsx scripts/g01-crash-recovery.ts resume | Tee-Object -FilePath 'evidence/g01/resume.out'

$assertSql = @"
select
  (select count(*) from sales.sales where business_id='$($ctx.businessId)') as sales,
  (select count(*) from checkout.checkouts where business_id='$($ctx.businessId)') as checkouts,
  (select count(*) from inventory.movements where kind='DELIVERY' and source_reference='order:$($ctx.orderId)') as deliveries,
  (select status::text from orders.product_orders where id='$($ctx.orderId)') as status,
  (select status::text from system.operation_attempts where operation_id='$($ctx.operationId)') as attempt_status;
"@
$assertion = $assertSql | docker exec -i supabase_db_youngkingz-h01 psql -U postgres -d youngkingz_h06_g01_20261122 -P pager=off
Write-Output '--- SQL ASSERTIONS ---'
Write-Output $assertion
$assertion | Out-File 'evidence/g01/crash-sql-assertions.txt' -Encoding UTF8
