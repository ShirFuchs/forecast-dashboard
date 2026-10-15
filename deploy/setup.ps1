# One-time setup for the forecast-dashboard Cloud Run app in project revenue-operations-475018.
# Run it yourself from the repo folder:   powershell -ExecutionPolicy Bypass -File deploy\setup.ps1
# Safe to run again: anything that already exists is left as it is.
#
# What it creates:
#   - service account forecast-dashboard@..., which runs the app and can read only the secrets below
#   - read access for that account to the existing RAZIELI_TOKEN and sf-jwt-key secrets
#   - secret forecast-dashboard-session-key: a random key that encrypts viewers' Snowflake sign-in cookies
#     (generated here and sent straight to Secret Manager; it is never printed)
#   - secrets snowflake-oauth-client-id / snowflake-oauth-client-secret holding "PENDING" until the data team adds the
#     Snowflake app's id and secret as new versions
#   - the IAP service agent (needed for Google sign-in in front of Cloud Run; already exists if other dashboards use IAP)

# gcloud reports progress on stderr, which Windows PowerShell would turn into errors under "Stop"; failures are caught by exit code
$ErrorActionPreference = "Continue"
$g = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$p = "revenue-operations-475018"
$sa = "forecast-dashboard@$p.iam.gserviceaccount.com"

function Run { & $g @args; if ($LASTEXITCODE) { throw "failed: gcloud $($args -join ' ')" } }
function Exists { & $g @args *> $null; return $LASTEXITCODE -eq 0 }
function New-Secret($name, $value) {
  if (Exists secrets describe $name --project $p) { Write-Host "secret $name already exists, left as is"; return }
  $tmp = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($tmp, $value)
    Run secrets create $name --project $p --replication-policy automatic --data-file $tmp
  } finally { Remove-Item $tmp -Force }
}

if (Exists iam service-accounts describe $sa --project $p) { Write-Host "service account already exists" }
else { Run iam service-accounts create forecast-dashboard --project $p --display-name "Forecast dashboard (Cloud Run)" --description "Runs the forecast-dashboard Cloud Run service; reads only its own secrets" }

$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
New-Secret "forecast-dashboard-session-key" ([Convert]::ToBase64String($bytes))
New-Secret "snowflake-oauth-client-id" "PENDING"
New-Secret "snowflake-oauth-client-secret" "PENDING"

foreach ($s in "RAZIELI_TOKEN", "sf-jwt-key", "forecast-dashboard-session-key", "snowflake-oauth-client-id", "snowflake-oauth-client-secret") {
  Run secrets add-iam-policy-binding $s --project $p --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor --format "value(etag)"
}

Run beta services identity create --service=iap.googleapis.com --project $p
Write-Host "`nSetup done. Next: powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1"
