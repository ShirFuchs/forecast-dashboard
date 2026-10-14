# Forecast snapshot & movement

A single-page dashboard (`index.html`) published as a claude.ai artifact:
https://claude.ai/artifact/CiBnM2LWjTVMCjigtFWLZg

It shows WSC's forecast for the company (Shaka, VP forecast) and for each region lead
(Daniel Pesce: North America + LATAM, Lidor Oz: EMEA + ROW, Guy Port: APAC), with two views per tab:

- **Forecast weekly snapshot** — the lead's latest submission on or before the compare end date, read
  from Razieli's saved submission snapshots in Snowflake, plus the lead's judgment.
- **Pipeline status** — live deal status from Salesforce at the compare end date.

Both views have a waterfall between the two compare dates, a "What changed" deal list and CSV export.

A third tab, **Forecast accuracy**, compares every lead's Forecast at each Razieli submission (the number
they enter, not best case) with the ARR the quarter closed at: a table per quarter (last forecast, average
weekly miss, bias), a timeline chart per lead, a cross-quarter table and a CSV of every submission.
It reads a copy of Razieli's `get_judgment_history` plus each quarter's closed ARR from
`get_forecast_rollup`, embedded in `index.html` (`ACCURACY`, dated by `ACC_AS_OF`), so it needs no connector.
Razieli's history starts on 2 Jun 2026.

## Data sources (read through the viewer's own claude.ai connectors)

| Connector | Used for |
|---|---|
| SalesForce Read Only (`soqlQuery`) | ARR Breakdown rows, opportunity field history, bookings and booking history |
| Snowflake (`sql_exec`) | `WSC_PROD.DWH_REVOPS.REVOPS_ARR_WATERFALL_PRODUCTS_BINARY_SNAPSHOT` (VP) and `..._REGION_LEAD_SNAPSHOT` (region leads) |
| Slack (`slack_read_channel`) | #forecast-update posts: submission times and calendar dots |

Judgment amounts and notes come from Razieli and are a fixed copy in `index.html` (`JUDGMENT`,
dated by `JUDGMENT_AS_OF`); update them when a lead resubmits. The same goes for the accuracy history
(`ACCURACY`, `ACC_AS_OF`).

## Viewers without connectors (shared copy)

The owner or an editor, with the connectors, clicks **Refresh shared data**. That saves the selected
quarter's data (the last ~92 days of history, all four leads' Snowflake snapshots and the Slack
submission times) into the artifact's database (`shared/<period>`, gzipped, in parts). Viewers
without the Salesforce connector automatically see that copy, labelled with when it was refreshed;
viewers without only Snowflake take its snapshots. **Preview viewer copy** shows exactly what they see.
Only the owner and editors can write the copy (db rule `shared`: read view, write admin).

## Known data issues

- Three Snowflake snapshots from 22–28 Sep 2026 have every row inflated (a one-time pipeline bug).
  The page treats any snapshot with a single row above $50M as corrupted and rebuilds that
  submission from Salesforce history instead (`SNAP_ROW_LIMIT`).
- Region tabs split deals by account region; Razieli groups by the owner's reporting line, so
  region totals can differ by roughly $0.1–0.2M.

## Updating

Edit `index.html`, commit, then republish the artifact to the same URL.
Never commit credentials (for example a Razieli API token) — the page doesn't need any.
