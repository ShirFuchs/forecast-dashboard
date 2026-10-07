# Forecast snapshot & movement

A single-page dashboard (`index.html`) published as a claude.ai artifact:
https://claude.ai/artifact/CiBnM2LWjTVMCjigtFWLZg

It shows WSC's forecast for the company (Shaka, VP forecast) and for each region lead
(Daniel Pesce: North America + LATAM, Lidor Oz: EMEA + ROW, Guy Port: APAC), with two views per tab:

- **Forecast weekly snapshot** — the lead's latest submission on or before the compare end date, read
  from Razieli's saved submission snapshots in Snowflake, plus the lead's judgment.
- **Pipeline status** — live deal status from Salesforce at the compare end date.

Both views have a waterfall between the two compare dates, a "What changed" deal list and CSV export.

## Data sources (read through the viewer's own claude.ai connectors)

| Connector | Used for |
|---|---|
| SalesForce Read Only (`soqlQuery`) | ARR Breakdown rows, opportunity field history, bookings and booking history |
| Snowflake (`sql_exec`) | `WSC_PROD.DWH_REVOPS.REVOPS_ARR_WATERFALL_PRODUCTS_BINARY_SNAPSHOT` (VP) and `..._REGION_LEAD_SNAPSHOT` (region leads) |
| Slack (`slack_read_channel`) | #forecast-update posts: submission times and calendar dots |

Judgment amounts and notes come from Razieli and are a fixed copy in `index.html` (`JUDGMENT`,
dated by `JUDGMENT_AS_OF`); update them when a lead resubmits.

## Known data issues

- Three Snowflake snapshots from 22–28 Sep 2026 have every row inflated (a one-time pipeline bug).
  The page treats any snapshot with a single row above $50M as corrupted and rebuilds that
  submission from Salesforce history instead (`SNAP_ROW_LIMIT`).
- Region tabs split deals by account region; Razieli groups by the owner's reporting line, so
  region totals can differ by roughly $0.1–0.2M.

## Updating

Edit `index.html`, commit, then republish the artifact to the same URL.
Never commit credentials (for example a Razieli API token) — the page doesn't need any.
