# Forecast dashboard app: Snowflake sign-in

**For the data team.** One-time setup so the RevOps forecast dashboard app can read Razieli's saved forecast
submissions from Snowflake, with each viewer's own Snowflake account.

## What the app is

- **Address:** https://forecast-dashboard-csqpugca5q-ew.a.run.app
- **Hosting:** Cloud Run service `forecast-dashboard`, Google Cloud project `revenue-operations-475018`, region
  `europe-west1`. Only @wsc-sports.com Google accounts can open it.
- **Code:** https://github.com/ShirFuchs/forecast-dashboard (private; ask Shir Fuchs for access). The Snowflake parts
  are in `app/server.js`.

## How it uses Snowflake

- Each viewer clicks **Connect Snowflake** once and signs in with their own Snowflake account, through the company
  SSO (OAuth, authorization code with PKCE). The app never sees a password. It keeps the viewer's refresh token in
  an encrypted cookie in their own browser, nowhere else.
- **Account:** `https://ufawbbj-sm32288.snowflakecomputing.com`
- **Role:** `WSC_BA_VIEWER` (requested as `session:role:WSC_BA_VIEWER`)
- **Warehouse:** `WSC_MCP_WH`
- **What it reads:** read-only SELECTs, and only these two tables:
  - `WSC_PROD.DWH_REVOPS.REVOPS_ARR_WATERFALL_PRODUCTS_BINARY_SNAPSHOT` (the VP's submissions)
  - `WSC_PROD.DWH_REVOPS.REVOPS_ARR_WATERFALL_PRODUCTS_BINARY_REGION_LEAD_SNAPSHOT` (the region leads' submissions)
- **Query shapes:** the server refuses any other statement. It allows exactly two:
  1. a lead's submissions for a quarter: `SUBMISSION_ID`, the submission time, and the largest row at the quarter end;
  2. one submission's rows at the quarter end: opportunity, stage, forecast category, region, owner, product and ARR.

## What we need from you

1. **Create the OAuth security integration** (or adjust its name to your conventions):

   ```sql
   CREATE SECURITY INTEGRATION WSC_FORECAST_APP_OAUTH
     TYPE = OAUTH
     ENABLED = TRUE
     OAUTH_CLIENT = CUSTOM
     OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
     OAUTH_REDIRECT_URI = 'https://forecast-dashboard-csqpugca5q-ew.a.run.app/oauth/snowflake/callback'
     OAUTH_ISSUE_REFRESH_TOKENS = TRUE
     OAUTH_REFRESH_TOKEN_VALIDITY = 7776000   -- 90 days
     OAUTH_ENFORCE_PKCE = TRUE
     PRE_AUTHORIZED_ROLES_LIST = ('WSC_BA_VIEWER');
   ```

2. **Get the client ID and secret:**

   ```sql
   SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('WSC_FORECAST_APP_OAUTH');
   ```

3. **Send the client ID and one client secret to Shir Fuchs** over a secure channel, not a plain Slack message. She
   stores them in Google Secret Manager as `snowflake-oauth-client-id` and `snowflake-oauth-client-secret`. The app
   picks them up within 10 minutes, with no redeploy.

4. **Check that viewers who should see forecast submissions have the `WSC_BA_VIEWER` role** and can use `WSC_MCP_WH`.

If you'd rather use a different role, warehouse or redirect setup, tell Shir: the role and warehouse are app settings
and can change without code changes.
