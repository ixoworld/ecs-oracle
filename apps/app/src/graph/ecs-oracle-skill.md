---
name: ecs-oracle
description: >
  Emerging Cooking Solutions (ECS / SupaMoto) business-data skill. Provides
  access to ECS customer overviews, Thousand Day Household claims, and other
  ECS datasets via the ECS server's REST API. Data is fetched inside the user's
  sandbox container, written to /workspace/data/output/ecs-oracle/ as a JSON
  artifact, and exposed back to the agent as a small metadata envelope
  (rowCount, schema, sampleRows) plus an `artifact.path` that can be turned
  into a presigned URL by the sandbox's `artifact_get_presigned_url` tool.
  Use this whenever the user asks ANY question about ECS business data
  (customers, onboarding, claims, stoves, metrics, country breakdowns, etc.).
version: 1.0.0
author: ixo
license: MIT
compatibility: Node.js 22+
allowed-tools: shell
secrets:
  oracle:
    - ECS_MCP_URL: 'ECS server URL (deployed value points at /mcp; the skill strips that suffix and hits the REST endpoints at /data/* under the same host). e.g. https://supamoto-onboarding.devmx.ixo.earth/mcp'
    - ECS_MCP_AUTH_TOKEN: 'Bearer token for the ECS server (same token works for both /mcp and /data/*).'
  user: []
context:
  - _SKILL_CONTEXT_USER_DID
  - _SKILL_CONTEXT_SANDBOX_ID
  - _SKILL_CONTEXT_TIMESTAMP
---

# ECS Oracle Data Skill

This skill is how the **ECS Oracle** fetches and queries Emerging Cooking
Solutions (SupaMoto) business data.

The skill runs **inside the user's sandbox container**. It calls the ECS MCP
server, writes the resulting rows to R2 via the `/workspace/data/output/`
FUSE mount as a plain JSON file, and prints back a small metadata envelope
the agent can reason about. The rows themselves never enter the agent's
context — counts / filters / aggregations go through `query.js`, and the
front-end reads the file directly via a presigned R2 URL when the user
wants to see a table.

## Quick decision guide for the agent

| User wants                                                                    | What to do                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any ECS data (customers, claims, etc.) — first call in the conversation       | Run `fetch.js <dataset>`. The script writes the rows to R2 and prints a small metadata envelope (rowCount, schema, sampleRows, artifact.path). Use what you need from the envelope to answer the user, or proceed to `query.js` for a precise number.                         |
| A question about the data you already loaded (count, group-by, top-N, join …) | Run `query.js <artifactPath> "<sql>"` with a normal DuckDB SELECT. The skill runs the SQL server-side and returns just the result set (capped at 100 KB). DO NOT re-fetch — the artifact is on the R2-backed `/workspace/data/` mount and persists across sandbox sleep/wake. |
| To **show** the data to the user as a table/chart                             | (a) Call `artifact_get_presigned_url({ path })` to mint a presigned R2 URL. (b) Emit a `call_ag-ui_agent` tool call with `dataHandle = artifact.path`, `fetchToken = previewUrl`, and a SQL string using `{table}`. The frontend reads R2 directly into DuckDB-WASM.          |

## Tools provided by this skill

### `fetch.js` — Fetch a dataset and offload to the vault

```bash
node scripts/fetch.js <dataset>
```

**Datasets supported:**

| Dataset     | Description                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers` | Full customer overview (calls ECS tool `get_customer_overview`). Returns all customers across all countries with their subscription/status fields. |
| `claims`    | Thousand Day Household claims (calls ECS tool `get_thousand_day_household_claims`).                                                                |

**Behaviour:**

1. Reads the ECS server base URL + bearer token from `_ORACLE_SECRET_ECS_BASE_URL` and `_ORACLE_SECRET_ECS_API_TOKEN` (injected by the oracle as `x-os-*` headers when the agent calls `sandbox_run` with this skill's CID).
2. Issues a plain `GET ${ECS_BASE_URL}/data/<dataset>` over HTTP. The ECS server runs gzip compression on the REST endpoints — Node's built-in `fetch` decodes transparently, so the wire payload is ~5-8× smaller than the legacy MCP/SSE path.
3. Extracts the row array (`customers` / `claims`) from the response JSON.
4. Pipes the row array through `zlib.createGzip()` and writes it to `/workspace/data/output/ecs-oracle/<dataset>-<isoTimestamp>.json.gz`. R2 picks it up automatically via the FUSE mount. DuckDB's `read_json_auto(..., compression='gzip')` reads it natively in `query.js`, and the front-end decompresses with `DecompressionStream('gzip')` after the presigned-URL download.
5. Prints **only a small metadata envelope to stdout** (~2 KB), suitable for the agent to read. The agent never sees the rows.

**stdout shape** (this is what the agent receives):

```json
{
  "success": true,
  "dataset": "customers",
  "artifact": {
    "path": "/workspace/data/output/ecs-oracle/customers-2026-05-13T18-18-00.json.gz",
    "filename": "customers-2026-05-13T18-18-00.json.gz",
    "compression": "gzip",
    "uncompressedBytes": 17760342
  },
  "rowCount": 22829,
  "schema": [{"key": "customer_id", "type": "string"}, ...],
  "sampleRows": [<5 rows for the agent's schema understanding>],
  "columnStats": {
    "country": {"unique": 3, "top": [{"value": "ZM", "count": 21000}, ...]},
    "cx_status": {"unique": 3, "top": [...]},
    ...
  },
  "fetchedAt": "2026-05-13T18:18:00.000Z"
}
```

**After `fetch.js` returns, what to do next depends on what the user wants:**

- For agent-internal questions about the data (counts, group-bys, filters,
  joins, any answer you'll write back as text), run `query.js` against the
  artifact path. You do NOT need a presigned URL for this — the SQL runs
  server-side inside the sandbox.
- Only when the user wants to **see** the data (a table, chart, or
  downloadable file), call the MCP tool
  `artifact_get_presigned_url({ path: <artifact.path> })` to mint a
  `previewUrl`, then pass that URL as `fetchToken` to `call_ag-ui_agent`.

The skill deliberately does NOT generate the presigned URL itself — that's
a separate MCP tool already exposed by the sandbox layer.

> **Never answer questions from `sampleRows` alone** — it's only 5 rows. Use
> `query.js` for anything that needs all rows.

If the ECS server is unreachable, returns:

```json
{ "success": false, "error": "...", "errorType": "UPSTREAM_UNAVAILABLE" }
```

If the user's DID isn't whitelisted (whitelist is checked by the oracle
_before_ this skill runs, so this isn't normally seen) — just an upstream
error.

### `query.js` — Run a DuckDB SQL query against an already-vaulted dataset

```bash
node scripts/query.js <artifactPath> "<sql>"
```

**Why this exists:** any time the agent needs a precise answer from the
data ("how many customers in ZM?", "top 10 countries by claim volume",
"average stove uptime by region last month"), `query.js` runs the SQL
inside the sandbox against the vaulted JSON artifact and returns just the
result rows. The agent never has to re-fetch from the ECS MCP, and the
rows themselves never enter your context — only the query result does.

**SQL grammar:** any read-only DuckDB SELECT (or `WITH ... SELECT`) is
allowed. Reference the dataset using the literal placeholder `{table}` —
the skill rewrites it to an in-memory view over `read_json_auto(<path>)`.
You can also write `FROM rows` directly; the placeholder is just the
convention shared with the front-end DuckDB-WASM path so the same SQL
string works in both places.

```bash
# Count
node scripts/query.js <path> "SELECT count(*) AS n FROM {table}"

# Count with filter
node scripts/query.js <path> \
  "SELECT count(*) AS n FROM {table} WHERE country = 'ZM'"

# Group-by with count
node scripts/query.js <path> \
  "SELECT country, count(*) AS n FROM {table} GROUP BY country ORDER BY n DESC LIMIT 20"

# Top-N rows projecting specific columns, with WHERE
node scripts/query.js <path> \
  "SELECT customer_id, full_name, country FROM {table} \
   WHERE cx_status = 'active' \
   ORDER BY customer_id DESC LIMIT 50"

# Look up a single record
node scripts/query.js <path> \
  "SELECT * FROM {table} WHERE customer_id = 'CFDEDF0D8' LIMIT 1"

# Window functions / aggregates / CTEs all work — it's just DuckDB.
node scripts/query.js <path> \
  "WITH per_country AS ( \
     SELECT country, count(*) AS n FROM {table} GROUP BY country \
   ) \
   SELECT *, n * 100.0 / sum(n) OVER () AS pct FROM per_country ORDER BY n DESC"
```

**SQL guardrails:** only a single statement, and only `SELECT` / `WITH`.
Any `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ATTACH`, `COPY`, `INSTALL`,
`LOAD`, `PRAGMA`, `SET`, … is rejected with `errorType: "BAD_QUERY"`.

**Result size cap:** results are hard-capped at **100 KB serialized JSON**
so the agent's context window stays safe. If a result would exceed the cap
the skill returns `{"success": false, "errorType": "RESULT_TOO_LARGE", ...}`
with recovery guidance — typically: aggregate further, project fewer
columns, add a WHERE clause, drop the LIMIT, or — if the user wants to
actually see the data — render via AG-UI instead, where DuckDB-WASM can
handle arbitrarily large result sets client-side without ever shipping
them through your context.

## Worked example — agent flow

User: _"How many customers in Zambia?"_

```
1. sandbox_run({
     code: "node /workspace/skills/ecs-oracle/scripts/fetch.js customers",
     cid: <thisSkillCid>
   })
   → returns metadata envelope with sampleRows + rowCount + artifact.path

2. Agent sees rowCount = 22829, decides it needs a precise filtered count.
   (NO artifact_get_presigned_url call — the agent only needs to read the
    answer, not render anything.)

3. sandbox_run({
     code: "node /workspace/skills/ecs-oracle/scripts/query.js <artifactPath> \"SELECT count(*) AS n FROM {table} WHERE country = 'ZM'\"",
     cid: <thisSkillCid>
   })
   → returns { "success": true, "rowCount": 1, "rows": [{ "n": 18241 }] }

4. Agent replies to user: "There are 18,241 customers in Zambia."
```

User: _"Show me a table of the active customers"_

```
1. (fetch already cached from prior call — skip; reuse the path from earlier)

2. artifact_get_presigned_url({ path: <the artifact path> })
   → returns { previewUrl, downloadUrl, path, expiresIn, url }

3. Agent emits AG-UI tool call:
   create_data_table({
     id: "ecs_active_customers",
     title: "Active ECS Customers",
     columns: [...derived from schema...],
     dataHandle: "<artifact.path>",             // same path used everywhere
     fetchToken: "<previewUrl>",                // R2 presigned URL
     query: "SELECT customer_id, full_name, country FROM {table} WHERE cx_status='active' LIMIT 500"
   })
   → frontend reads R2 directly via DuckDB-WASM and renders the table
```

## What the agent must NEVER do

- **Don't try to print() the full rows from fetch.js.** The skill is designed
  so the agent only ever receives the metadata envelope. Dumping rows back
  through stdout defeats the whole point — use `query.js` for aggregations
  and the presigned R2 URL for visual rendering.

- **Don't write a SELECT that returns the entire dataset.** The 100 KB
  byte budget is enforced by the skill, not the caller. If you want to
  show every row, render via AG-UI — the frontend can stream it from R2
  without ever serializing it through your context.

- **Don't call `artifact_get_presigned_url` unless you actually plan to
  render the data.** Presigned URLs are only needed for AG-UI / downloads.
  For agent-internal Q&A, go straight from `fetch.js` to `query.js`.

- **Don't re-fetch on every question.** `/workspace/data/` is an R2-backed
  mount — once `fetch.js` has written the artifact, it persists across
  sandbox sleep/wake (and even across sandbox replacements for the same
  user). Reuse the artifact path you got back from the first `fetch.js`
  call. Only call `fetch.js` again if you actually want fresh data from
  upstream ECS, or if a `query.js` call returns `ARTIFACT_NOT_FOUND`.

## Errors you may see

| `errorType`            | Meaning                                                                        | Recovery                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM_UNAVAILABLE` | ECS server is down or the REST endpoint returned non-2xx                       | Tell the user the ECS data service is temporarily unavailable.                                                                        |
| `AUTH_FAILED`          | ECS server returned 401/403 — the API token is wrong or revoked                | Oracle-side configuration problem; tell the operator. Don't retry mechanically.                                                       |
| `NOT_FOUND`            | ECS server returned 404 — the endpoint path is wrong                           | Configuration / version mismatch between skill and ECS server. Tell the operator.                                                     |
| `TIMEOUT`              | ECS REST call did not respond within 120 s                                     | Tell the user it's slow; offer to retry once.                                                                                         |
| `BAD_QUERY`            | `query.js` rejected the SQL (not a SELECT/WITH, multi-statement, forbidden kw) | Fix the SQL and resubmit. Only single `SELECT` / `WITH ... SELECT` statements are accepted.                                           |
| `QUERY_FAILED`         | DuckDB rejected the SQL (syntax error, unknown column, type mismatch)          | Fix the SQL — the error message from DuckDB is in `error`.                                                                            |
| `RESULT_TOO_LARGE`     | A `query.js` result exceeded the 100 KB output budget                          | Tighten the query (aggregate, filter, LIMIT, project fewer columns) or render via AG-UI where the front-end can handle large results. |
| `ARTIFACT_NOT_FOUND`   | The artifact path you passed to `query.js` doesn't exist on the R2 mount       | Re-run `fetch.js` once to repopulate the artifact, then retry your query.                                                             |
| `MISSING_SECRET`       | `ECS_BASE_URL` or `ECS_API_TOKEN` not in env                                   | Oracle-side configuration problem; tell the operator.                                                                                 |
