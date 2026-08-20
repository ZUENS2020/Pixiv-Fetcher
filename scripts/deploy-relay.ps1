# Deploy the Pixiv Ajax / translation relay with Docker.
# Local:  .\scripts\deploy-relay.ps1
# Remote: $env:SSH_HOST="myserver"; $env:RELAY_PUBLIC_URL="https://relay.example.com"; .\scripts\deploy-relay.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$EnvFile = Join-Path $Root "relay\.env"
$RemoteDir = if ($env:REMOTE_DIR) { $env:REMOTE_DIR } else { "~/pixiv-fetcher-relay" }
$SshHost = $env:SSH_HOST
$RelayPublicUrl = $env:RELAY_PUBLIC_URL

if (-not (Test-Path $EnvFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  Set-Content -Path $EnvFile -Value "RELAY_SECRET=$secret" -NoNewline
  Write-Host "Created relay/.env"
}

$relaySecret = (Get-Content $EnvFile | Where-Object { $_ -match "^RELAY_SECRET=" }) -replace "^RELAY_SECRET=", ""
if (-not $relaySecret -or $relaySecret -eq "change-me-to-a-long-random-string") {
  throw "Set RELAY_SECRET in relay/.env"
}

if ($SshHost) {
  Write-Host "Sync to ${SshHost}:${RemoteDir}"
  ssh $SshHost "mkdir -p $RemoteDir"
  scp "$Root\relay\Dockerfile" "$Root\relay\docker-compose.yml" "$Root\relay\server.mjs" "$Root\relay\openai-stream.mjs" $EnvFile "${SshHost}:${RemoteDir}/"
  Write-Host "Docker compose up"
  ssh $SshHost "cd $RemoteDir; docker compose up -d --build"
} else {
  Write-Host "Docker compose up (local relay/)"
  Push-Location (Join-Path $Root "relay")
  try {
    docker compose up -d --build
  } finally {
    Pop-Location
  }
}

Write-Host ""
Write-Host "Relay is up (host port 127.0.0.1:8789)."
Write-Host "Expose it with HTTPS, then:"
Write-Host "  npx wrangler secret put PIXIV_RELAY_URL"
Write-Host "  npx wrangler secret put PIXIV_RELAY_SECRET"
if ($RelayPublicUrl) {
  Write-Host "Suggested PIXIV_RELAY_URL=$RelayPublicUrl"
}
