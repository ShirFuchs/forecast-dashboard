# Builds and deploys the forecast-dashboard Cloud Run app (project revenue-operations-475018, europe-west1), behind
# Google sign-in for @wsc-sports.com. Run deploy\setup.ps1 once first. Run this from anywhere:
#   powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
# Every step is safe to repeat; a redeploy after a code change is just this script again.

# gcloud reports progress on stderr, which Windows PowerShell would turn into errors under "Stop"; failures are caught by exit code
$ErrorActionPreference = "Continue"
$g = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$p = "revenue-operations-475018"; $r = "europe-west1"; $svc = "forecast-dashboard"
$sa = "forecast-dashboard@$p.iam.gserviceaccount.com"
$iapAgent = "service-1000251352147@gcp-sa-iap.iam.gserviceaccount.com"
# who may change Aviv's forecast inputs in the app (everyone else at wsc-sports.com can view them)
$avivEditors = @("shir.fuchs@wsc-sports.com", "aviv@wsc-sports.com")
function Run { & $g @args; if ($LASTEXITCODE) { throw "failed: gcloud $($args -join ' ')" } }

Set-Location (Split-Path $PSScriptRoot -Parent)

# The Salesforce login is the one vertical-planning uses: same connected app and user, read from that service's settings
$vp = (& $g run services describe vertical-planning --project $p --region europe-west1 --format json) -join "`n" | ConvertFrom-Json
$sfEnv = @{}; foreach ($e in $vp.spec.template.spec.containers[0].env) { if ($e.name -like "SF_*" -and $e.value) { $sfEnv[$e.name] = $e.value } }
foreach ($k in "SF_CLIENT_ID", "SF_USERNAME") { if (-not $sfEnv[$k]) { throw "vertical-planning has no $k setting" } }
$sfVars = "SF_CLIENT_ID=$($sfEnv.SF_CLIENT_ID),SF_USERNAME=$($sfEnv.SF_USERNAME),SF_LOGIN_URL=$(if ($sfEnv.SF_LOGIN_URL) { $sfEnv.SF_LOGIN_URL } else { 'https://login.salesforce.com' }),SF_API_VERSION=v64.0"

# 1. build from source (Dockerfile; .gcloudignore keeps everything but the app out of the upload) and deploy
Run run deploy $svc --source . --project $p --region $r --service-account $sa `
  --no-allow-unauthenticated --ingress all --memory 1Gi --cpu 1 --timeout 300 --max-instances 4 `
  --update-env-vars "$sfVars,IAP_AUDIENCE=/projects/1000251352147/locations/$r/services/$svc,AVIV_EDITORS=$($avivEditors -join ';')"

# 2. Google sign-in in front (Cloud Run's built-in IAP), as for vertical-planning: only IAP may call the service,
#    and anyone with a @wsc-sports.com Google account may pass IAP
Run run services update $svc --project $p --region $r --iap --ingress all
Run run services add-iam-policy-binding $svc --project $p --region $r --member "serviceAccount:$iapAgent" --role roles/run.invoker --format "value(etag)"
Run iap web add-iam-policy-binding --resource-type=cloud-run --service=$svc --project $p --region=$r --member=domain:wsc-sports.com --role=roles/iap.httpsResourceAccessor --format "value(etag)"

# 3. the app's own address, used for the Snowflake sign-in's return address
$url = (& $g run services describe $svc --project $p --region $r --format "value(status.url)").Trim()
Run run services update $svc --project $p --region $r --update-env-vars "PUBLIC_URL=$url"

Write-Host "`nDeployed: $url"
Write-Host "Snowflake return address for the data team: $url/oauth/snowflake/callback"
