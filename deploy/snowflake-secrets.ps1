# Saves the Snowflake sign-in's client ID and secret (from the data team's security integration) as new versions of the app's
# two secrets in Secret Manager. It reads them from the clipboard (copy the data team's {...} line, press Enter): the secret
# isn't shown, written to disk for longer than one command, or kept in your command history, and the clipboard is cleared.
# The app picks them up within 10 minutes; no redeploy is needed for this step.
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

function Save($name, $value) {
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, $value)   # UTF-8, no BOM, no trailing newline
    & $g secrets versions add $name --data-file=$tmp --project $p
    if ($LASTEXITCODE) { throw "Couldn't save $name." }
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# The values come from the clipboard, not typed or pasted into this window (pasting into a prompt can drop characters):
# ideally the whole {...} line the data team sent, else each value in turn. The clipboard is cleared afterwards.
# (spaces and line breaks are dropped: a narrow chat window can wrap the line mid-value when it's copied, and neither the
# keys nor the values contain any)
function Clip { try { [string](Get-Clipboard -Raw) -replace '\s+', '' } catch { "" } }
Write-Host "`nCopy the whole line the data team sent, the {...} with OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET in it, then press Enter here."
[void](Read-Host)
$j = $null; try { $j = (Clip).Trim() | ConvertFrom-Json } catch {}
if ($j -and $j.OAUTH_CLIENT_ID -and $j.OAUTH_CLIENT_SECRET) {
  $id = ([string]$j.OAUTH_CLIENT_ID).Trim(); $sec = ([string]$j.OAUTH_CLIENT_SECRET).Trim()
} else {
  Write-Host "That isn't the {...} line. Copy just the client ID (OAUTH_CLIENT_ID), then press Enter."; [void](Read-Host); $id = (Clip).Trim()
  Write-Host "Now copy just the first client secret (OAUTH_CLIENT_SECRET), then press Enter."; [void](Read-Host); $sec = (Clip).Trim()
}
try { Set-Clipboard -Value " " } catch {}
if (-not $id -or -not $sec) { throw "Both values are needed; nothing was saved." }
# the client ID isn't secret (it travels in every sign-in link), so it's shown; the secret only by its length
# (Snowflake's are 28 and 44 characters, so a value copied short is caught before it's saved)
Write-Host "`n  Client ID: $id  ($($id.Length) characters)`n  Secret:    $($sec.Length) characters"
if ($id.Length -ne 28 -or $sec.Length -ne 44) {
  Write-Host "  Snowflake's client IDs are 28 characters and its secrets 44: check you copied each one whole, from the first character." -ForegroundColor Yellow
}
if ((Read-Host "`nSave these? (y/n)") -notmatch '^\s*y') { Write-Host "Nothing was saved."; exit }
Save "snowflake-oauth-client-id" $id
Save "snowflake-oauth-client-secret" $sec
Write-Host "`nSaved. Within 10 minutes the app shows a Connect Snowflake button: reload it, click it and sign in to Snowflake."
