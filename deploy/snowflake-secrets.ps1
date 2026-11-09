# Saves the Snowflake sign-in's client ID and secret (from the data team's security integration) as new versions of the app's
# two secrets in Secret Manager. Paste each value when asked: nothing is shown, written to disk for longer than one command,
# or kept in your command history. The app picks them up within 10 minutes; no redeploy is needed for this step.
#   powershell -ExecutionPolicy Bypass -File deploy\snowflake-secrets.ps1
$ErrorActionPreference = "Continue"
$g = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$p = "revenue-operations-475018"

# Google expires this computer's Google Cloud sign-in every so often; when it has, sign in again here (a browser window opens)
& $g auth print-access-token --quiet *> $null
if ($LASTEXITCODE) {
  Write-Host "`nYour Google Cloud sign-in on this computer has expired. A browser window opens now: sign in as your @wsc-sports.com account.`n"
  & $g auth login
  & $g auth print-access-token --quiet *> $null
  if ($LASTEXITCODE) { throw "Google Cloud sign-in didn't complete, so nothing was saved. Run this script again to retry." }
}

function Plain([securestring]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Save($name, $value) {
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, $value)   # UTF-8, no BOM, no trailing newline
    & $g secrets versions add $name --data-file=$tmp --project $p
    if ($LASTEXITCODE) { throw "Couldn't save $name." }
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# The client ID isn't secret (it travels in every sign-in link), so it shows as you paste; the secret stays hidden. Snowflake's
# are 28 and 44 characters: a paste that lost characters is caught here, before it's saved.
$id = (Read-Host "Snowflake OAUTH_CLIENT_ID").Trim()
$sec = (Plain (Read-Host "Snowflake OAUTH_CLIENT_SECRET (the first one; hidden as you paste)" -AsSecureString)).Trim()
if (-not $id -or -not $sec) { throw "Both values are needed; nothing was saved." }
Write-Host "`n  Client ID: $id  ($($id.Length) characters)`n  Secret:    $($sec.Length) characters"
if ($id.Length -ne 28 -or $sec.Length -ne 44) {
  Write-Host "  Snowflake's client IDs are 28 characters and its secrets 44: check you copied each one whole, from the first character." -ForegroundColor Yellow
}
if ((Read-Host "`nSave these? (y/n)") -notmatch '^\s*y') { Write-Host "Nothing was saved."; exit }
Save "snowflake-oauth-client-id" $id
Save "snowflake-oauth-client-secret" $sec
Write-Host "`nSaved. Within 10 minutes the app shows a Connect Snowflake button: reload it, click it and sign in to Snowflake."
