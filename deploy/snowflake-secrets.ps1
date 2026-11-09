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

# The values come from the clipboard, never typed or pasted into this window (pasting into a prompt drops characters), and
# only as the whole {...} line the data team sent: the script asks again until the clipboard holds it, and saves nothing
# that doesn't look exactly like Snowflake's client ID (28 characters) and secret (44). The clipboard is cleared afterwards.
# Spaces and line breaks are dropped (a narrow chat window can wrap the line mid-value when it's copied; neither the keys nor
# the values contain any), and chat apps' curly quotes count as quotes. OAUTH_CLIENT_SECRET is the first secret, not _2.
function Clip { try { [string](Get-Clipboard -Raw) -replace '\s+', '' } catch { "" } }
$quotes = '[' + (-join [char[]](0x201C, 0x201D, 0x201E, 0x201F, 0x2033, 0x2036, 0xAB, 0xBB)) + ']'
$id = $null; $sec = $null
while ($true) {
  $answer = Read-Host "`nCopy the whole line the data team sent (the {...} with OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET), then press Enter here (q to quit)"
  if ($answer -match '^\s*q') { Write-Host "Nothing was saved."; exit }
  $raw = (Clip) -replace $quotes, '"'
  $mi = [regex]::Match($raw, '"OAUTH_CLIENT_ID":"([A-Za-z0-9+/=]+)"'); $ms = [regex]::Match($raw, '"OAUTH_CLIENT_SECRET":"([A-Za-z0-9+/=]+)"')
  if (-not ($mi.Success -and $ms.Success)) { Write-Host "  The clipboard doesn't hold that line yet. Copy all of it, from { to }, and press Enter again." -ForegroundColor Yellow; continue }
  $id = $mi.Groups[1].Value; $sec = $ms.Groups[1].Value
  if ($id -notmatch '^[A-Za-z0-9+/]{27}=$' -or $sec -notmatch '^[A-Za-z0-9+/]{43}=$') {
    Write-Host "  That line's values aren't the usual 28 and 44 characters ($($id.Length) and $($sec.Length)): copy it again, all of it, and press Enter." -ForegroundColor Yellow
    continue
  }
  break
}
try { Set-Clipboard -Value " " } catch {}
# the client ID isn't secret (it travels in every sign-in link), so it's shown; the secret only by its length
Write-Host "`n  Client ID: $id  (28 characters)`n  Secret:    44 characters"
if ((Read-Host "`nSave these? (y/n)") -notmatch '^\s*y') { Write-Host "Nothing was saved."; exit }
Save "snowflake-oauth-client-id" $id
Save "snowflake-oauth-client-secret" $sec
Write-Host "`nSaved. Within 10 minutes the app uses them: reload it, click Disconnect at the top if it shows you signed in, then Connect Snowflake."
