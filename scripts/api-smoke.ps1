$ErrorActionPreference = 'Stop'

$base = 'http://127.0.0.1:3001'

function Test-Endpoint($name, $scriptBlock) {
  try {
    $result = & $scriptBlock
    Write-Host "[PASS] $name" -ForegroundColor Green
    return @{ name = $name; pass = $true; detail = $result }
  } catch {
    Write-Host "[FAIL] $name -> $($_.Exception.Message)" -ForegroundColor Red
    return @{ name = $name; pass = $false; detail = $_.Exception.Message }
  }
}

$results = @()

$results += Test-Endpoint 'env-check returns diagnostics' {
  $r = Invoke-RestMethod -Method GET -Uri "$base/api/debug/env-check"
  if (-not $r.diagnostics) { throw 'Missing diagnostics payload' }
  $r.diagnostics.ok | Out-Null
  'ok'
}

$results += Test-Endpoint 'search empty body returns 400' {
  try {
    Invoke-RestMethod -Method POST -Uri "$base/api/search" -ContentType 'application/json' -Body '{}' | Out-Null
    throw 'Expected failure but got success'
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 400) { throw "Expected 400 got $($_.Exception.Response.StatusCode.value__)" }
  }
  'ok'
}

$results += Test-Endpoint 'search with query returns controlled response' {
  $body = '{"query":"test query","sources":["Web"],"mode":"open"}'
  try {
    $r = Invoke-RestMethod -Method POST -Uri "$base/api/search" -ContentType 'application/json' -Body $body
    if (-not $r) { throw 'No response body' }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -ne 500 -and $code -ne 200) { throw "Unexpected status: $code" }
  }
  'ok'
}

$results += Test-Endpoint 'twitter oauth route reachable' {
  try {
    Invoke-WebRequest -Method GET -Uri "$base/api/auth/twitter" -MaximumRedirection 0 | Out-Null
  } catch {
    # redirect expected in many cases
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -lt 300 -or $code -ge 500) { throw "Unexpected status: $code" }
  }
  'ok'
}

$results += Test-Endpoint 'linkedin oauth route reachable' {
  try {
    Invoke-WebRequest -Method GET -Uri "$base/api/auth/linkedin" -MaximumRedirection 0 | Out-Null
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -lt 300 -or $code -ge 500) { throw "Unexpected status: $code" }
  }
  'ok'
}

$results += Test-Endpoint 'reddit oauth route reachable' {
  try {
    Invoke-WebRequest -Method GET -Uri "$base/api/auth/reddit" -MaximumRedirection 0 | Out-Null
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -lt 300 -or $code -ge 500) { throw "Unexpected status: $code" }
  }
  'ok'
}

$pass = ($results | Where-Object { -not $_.pass }).Count -eq 0
if ($pass) {
  Write-Host "All smoke tests passed." -ForegroundColor Green
  exit 0
} else {
  Write-Host "Smoke tests had failures." -ForegroundColor Yellow
  exit 1
}
