# MCP Service Contract

This file describes the **MCP endpoint offered to external AI agents**:
endpoint, transport, authentication, permissions, tool list, rate limits,
logging and compatibility promises.

MCP (Model Context Protocol) is a tool protocol for AI agents. The only
difference from REST is how you ask: with REST the agent builds HTTP requests
itself, with MCP the agent discovers and calls tools through an MCP client
(Claude Desktop, Cursor, a self-built agent framework, and so on).

**The underlying data, permission model, rate-limit accounting and REST side
are exactly the same** — the same product, the same recommendation, the same
click attribution, whichever endpoint you reach them through.

---

## 1. How this endpoint relates to the REST trial API

| | REST trial API | MCP endpoint |
|---|---|---|
| Path | `/v1/agent/*` | `/mcp` |
| Protocol | HTTP + JSON | MCP over Streamable HTTP |
| Authentication | API Key (`x-api-key`) + scope | **the same API key**, the same scope system |
| Capabilities | product search, recording recommendations, impressions, stats | **the same capabilities**, in tool form |
| Compatibility promise | yes | **yes**, see §8 |

They are "two ways of asking the same backend", not two implementations:

- the same module functions on the service side;
- the same API key, the same scopes, the same rate-limit counters in the
  database;
- the same `api_request_logs` table.

**External integrations may pick either one.** An integration that already
uses REST does not have to change; an integration that wants an MCP client
asks for the same key — no new key, no new permission request.

> The repository deliberately has **no new `mcp:*` scope**. Permissions are
> granted against **capabilities**, not protocols — MCP and REST expose exactly
> the same capabilities, so splitting them into two scope systems would
> invalidate every key already issued and force us to reissue them one by one
> during the trial phase.

---

## 2. Endpoint and transport

```
POST https://staging.bitfund.ltd/mcp
```

The transport is **MCP Streamable HTTP**, with these specifics:

- **Stateless**: the server issues no session id. Each request stands on its
  own, so there is no "session expired" state for the integration to handle,
  and rolling out multiple replicas does not drop sessions.
- **JSON responses**: one request returns one JSON-RPC response
  (`application/json`), no SSE event stream. All tool calls here are
  "one question, one answer" — there are no long-running tasks that need
  streaming.
- **POST only**: `GET /mcp` and `DELETE /mcp` return `405`. This is
  explicitly allowed by the MCP specification and means the server does not
  support server-initiated push.
- **Both Accept types required**:
  `Accept: application/json, text/event-stream`. The specification requires
  both; missing one gets the request rejected with `406`.

The request body is a standard JSON-RPC 2.0 message:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
x-api-key: ac_trial_xxxxxxxx

{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

### 2.1 Client configuration example

Claude Desktop / Cursor configurations look roughly like this:

```json
{
  "mcpServers": {
    "agent-commerce": {
      "url": "https://staging.bitfund.ltd/mcp",
      "headers": {
        "x-api-key": "ac_trial_xxxxxxxx"
      }
    }
  }
}
```

## 3. Authentication

### 3.1 Credentials

Both forms are accepted; the value and the permissions are identical:

```
x-api-key: ac_trial_xxxxxxxx
```

```
Authorization: Bearer ac_trial_xxxxxxxx
```

`Bearer` is also accepted because MCP client configuration is almost always
either `headers` or `Authorization`; many clients never set a private
`x-api-key` header at all.

In addition, `x-import-token` (the administrator token) can connect — that is
an operations backdoor with every scope, and it does not count against the
quota issued to integrations.

**Priority: `x-api-key` → `Authorization: Bearer` → administrator token.**
Once a credential is present there is no fallback: an invalid key silently
degrading into administrator rights would make authentication meaningless.

How keys are issued, why the plaintext is returned only once and why only a
hash is stored are exactly the same as on the REST side — see
[`agent-trial.md`](https://commerce.bitfund.ltd/docs/en/api/agent-trial) §2.1.

### 3.2 What an authentication failure looks like

Authentication failures happen at the HTTP layer and return a plain HTTP
error (not a JSON-RPC error):

| Situation | Status | `error` |
|---|---|---|
| No credentials at all | 401 | `UNAUTHORIZED` |
| Key does not exist or does not match | 401 | `API_KEY_INVALID` |
| Key has been revoked | 401 | `API_KEY_REVOKED` |
| Key has expired | 401 | `API_KEY_EXPIRED` |
| The client owning the key is suspended | 403 | `API_CLIENT_SUSPENDED` |
| Over the per-minute quota | 429 | `RATE_LIMIT_EXCEEDED` |

Revocation and expiry **take effect immediately**: every call reads the state
from the database; nothing is cached.

## 4. Permissions (scopes)

The same three scopes as the REST side, with identical meaning:

| Scope | Tools it covers |
|---|---|
| `catalog:read` | `search_products`, `compare_offers`, `create_purchase_link` |
| `recommendations:write` | `record_recommendation`, `record_impression` |
| `analytics:read` | `recommendation_analytics` |

**The tool list is filtered by this key's permissions**: a tool whose scope is
missing **does not appear in `tools/list` at all**, and calling it returns a
"no such tool" failure.

This is deliberate: during the trial phase the default issue is
`catalog:read` + `recommendations:write`, and `analytics:read` is not
issued by default. "Performance stats" is exactly the tool agents want to
call — making it hit a permission wall on the first try wastes the first
impression, which is the easiest one to lose.

Want more capability? Request the matching scope; say which one is missing in
the request.

The `initialize` response carries **`instructions` generated from the
current permissions**, stating which tools this credential can use and which
scope a missing tool needs. The agent reads them and knows what to request
instead of guessing.

## 5. Tool list

Every tool returns its payload in `structuredContent`, and also provides the
same content as JSON text in `content` — both ways of reading are supported.

Tool arguments **reject unknown fields**: a misspelled field name is rejected
explicitly rather than silently ignored.

> **The tool `name` is the contract; `title` and `description` follow
> the request language.** The service reads `Accept-Language` and **defaults
> to English**; send `Accept-Language: zh` to get Chinese instead. The same
> applies to the `initialize` instructions block. The `name`, the argument
> fields, the response fields and the error codes are identical in every
> language — only the prose changes.

### 5.1 `search_products`

Search normalized products by keyword and return every cross-source offer of
each product.

| Parameter | Type | Meaning |
|---|---|---|
| `q` | string | required, 1–100 characters |
| `limit` | number | optional, 1–50, default 10 |

Returns `products[]` (each with `id`, `title`, `brand`, `category`,
`gtin`, `offers[]`) and `meta`.

`offers[]` contains `id`, `source`, `price`, `currency`,
`availability`, `condition`, `shippingOptions`, `itemLocation`,
`productUrl`, `imageUrl`, `affiliateUrl`, `fetchedAt`, `lastVerifiedAt`,
`clickUrl`.

- `clickUrl` is an **absolute URL** and can be handed to the user as-is.
- `affiliateUrl` is the source-side affiliate link — an integration doing
  commission attribution needs it; it is `null` when the offer has no
  affiliate source.
- `price` is a fixed-point decimal string (major unit, two decimals, such as
  `"799.00"`); **prices in different currencies cannot be compared
  directly**.
- `availability` stores the lower-cased upstream value (such as
  `"in_stock"`) and is **not semantically rewritten**: when the upstream
  introduces a new status, the lower-cased original is still readable, while
  mapping it onto a self-defined vocabulary would sweep every unseen status
  into `"unknown"`.
- `condition` is an **offer (listing) level** attribute, not a product level
  one: for the same eBay product, one seller may be new and another used, and
  the two offers can carry different `condition` values.

  `condition` is a **normalized stable vocabulary** with exactly four values:

  | Value | Meaning |
  |---|---|
  | `new` | brand new |
  | `used` | second-hand |
  | `refurbished` | refurbished (all grades land here) |
  | `open_box` | open box |

  When it cannot be determined it is `null`, which **means "unknown", not
  "new"** — to decide "do I need a brand-new device" you must check
  `condition === "new"`, not `condition !== "used"`.

  Free-form upstream text ("Good - Refurbished", "Excellent - Refurbished",
  …) **never** appears verbatim in this field, so integrations do not need to
  handle upstream wording.

- `availability` comes **only** from eBay's `get_item` (the details call) —
  search results carry no stock state. An offer whose details were never
  fetched has `availability` of `"unknown"` and `condition` of `null`.
  This is not missing data, it means "the details of this listing have never
  been fetched": the catalog contains a batch of listings that only ever had a
  price, a title and a link. The backfill procedure is documented by the service provider.

### 5.2 `compare_offers`

Compare offers by product id.

| Parameter | Type | Meaning |
|---|---|---|
| `productId` | string | required, from a `search_products` result |

Returns `product`, `offers[]` (ascending by `(currency, price)`) and
`comparison`.

`comparison` carries `currencies[]` and `note` (a wording note that follows
the request language).

Each `comparison.currencies[]` entry carries `currency`, `offerCount`,
`lowest` (`offerId`/`price`/`source`) and `highest`.

**There is no cross-currency lowest price** — that would need exchange rates,
and this service does not provide them. Across currencies there is no "who is
cheaper" answer, and giving a single number would be misleading.

A missing product returns `PRODUCT_NOT_FOUND`.

### 5.3 `create_purchase_link`

Create an attributed purchase link (absolute URL) for an offer.

| Parameter | Type | Meaning |
|---|---|---|
| `offerId` | string | required, from a search or comparison result |
| `recommendationItemId` | string(uuid) | optional, from `record_recommendation` |
| `sessionId` | string | optional, upstream session identifier |

Returns `url`, `path`, `offerId`, `productId`, `productTitle`,
`price`, `currency`, `availability`, `condition` and `note` (a wording
note that follows the request language).

**This step writes no data**: the click record is written when the user
actually opens the link. But it first verifies that the offer and the
recommendation item exist and match each other — better to report an error
now and let the agent pick another offer than to hand the user a link that is
guaranteed to 404.

Possible errors: `OFFER_NOT_FOUND`, `RECOMMENDATION_ITEM_NOT_FOUND`,
`RECOMMENDATION_ITEM_OFFER_MISMATCH`.

**Recommendation items are isolated per integration**: a `recommendationItemId`
must belong to **your** integration. Another integration's item id is treated
as "not found" (`RECOMMENDATION_ITEM_NOT_FOUND`).

### 5.4 `record_recommendation`

Record a recommendation.

| Parameter | Type | Meaning |
|---|---|---|
| `scenario` | string | required, recommendation scenario identifier |
| `query` | string | required, the raw user question that triggered this recommendation |
| `sessionKey` | string | optional, upstream session identifier |
| `metadata` | object | optional, non-sensitive extension data |
| `items` | array | required, 1–50 entries |

Each item contains `productId`, `offerId`, `position`, plus optional
`reason` and `snapshot`. `position` must be unique.

Returns `recommendationId`, `itemCount`, `items[]` (each with its own
`id`).

**Those ids are the only credential that later impressions and clicks attach
to**: having only `recommendationId` cannot answer "which entry of the
recommendation list did the user click?".

### 5.5 `record_impression`

Report one impression.

| Parameter | Type | Meaning |
|---|---|---|
| `recommendationItemId` | string(uuid) | required, must be a recommendation item id that **belongs to your own integration** |
| `eventKey` | string(uuid) | required, idempotency key |
| `impressedAt` | string | required, ISO 8601, must carry a timezone offset |
| `metadata` | object | optional |

Returns `impressionId` and `inserted`.

- `inserted: true` = an impression row was really written this time.
- `inserted: false` = this is a retry of the same impression (same
  `eventKey` and same content).

The same `eventKey` with **different** content returns
`IMPRESSION_EVENT_KEY_CONFLICT` — that is the caller misusing the key, not a
retry.

**Recommendation items are isolated per integration**: referencing an item that
belongs to **another** integration returns `RECOMMENDATION_ITEM_NOT_FOUND` —
the same answer as "no such item".

### 5.6 `recommendation_analytics`

Read recommendation performance stats. Requires `analytics:read`.

| Parameter | Type | Meaning |
|---|---|---|
| `from` | string | required, inclusive lower bound, ISO 8601 with timezone offset |
| `to` | string | required, exclusive upper bound, ISO 8601 with timezone offset |
| `asOf` | string | optional, observation point, defaults to the current database time |
| `scenario` | string | optional, filter by recommendation scenario |

Returns `period`, `funnel`, `dataQuality`, `commissions` and `meta`.

| Field | Contains |
|---|---|
| `period` | `from`/`to`/`asOf`, the attribution window in days, the cohort maturity status and when it matures |
| `funnel` | `requests`, `requestsWithItems`, `items`, `impressions`, `clicks`, `conversions` |
| `dataQuality` | impression data status, conversions missing a transaction timestamp, conversions linked outside the window |
| `commissions` | commissions and sales grouped by `(network, currency, status)` |
| `meta` | `window` (the `[from, to)` convention), `scenario`, `amountNote`, `maxQueryRangeDays` |

A single query spans at most 366 days.

**Amount unit**: amounts here are decimal strings in the **smallest currency
unit**, grouped by `(network, currency, status)`, and **there is no
cross-currency total field**. Note that this differs from the `price` unit
of product offers — product prices are fixed-point decimals in the major unit.

## 6. Error handling

A failing tool returns an **MCP tool failure result** (`isError: true`), not
a JSON-RPC level error:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "{\"error\":\"PRODUCT_NOT_FOUND\",...}" }],
  "structuredContent": { "error": "PRODUCT_NOT_FOUND", "message": "..." }
}
```

`structuredContent.error` is the **stable error code**, and the agent can
use it to decide whether to retry, to change the arguments, or to request the
missing permission.

Possible values of `structuredContent.error` on tool failure:

| Error code | Meaning |
|---|---|
| `PRODUCT_NOT_FOUND` | the product id does not exist in the database |
| `OFFER_NOT_FOUND` | the offer id does not exist in the database |
| `RECOMMENDATION_ITEM_NOT_FOUND` | the recommendation item does not exist, or does not belong to your integration |
| `RECOMMENDATION_ITEM_OFFER_MISMATCH` | the offer exists but does not belong to the declared product/item |
| `RECOMMENDATION_OFFER_NOT_FOUND` | the offer referenced by a recommendation item does not exist |
| `RECOMMENDATION_CREATE_FAILED` | unexpected internal error while recording the recommendation |
| `IMPRESSION_EVENT_KEY_CONFLICT` | the same eventKey carried different content |
| `IMPRESSION_RECORD_FAILED` | unexpected internal error while recording the impression |
| `RECOMMENDATION_ANALYTICS_FAILED` | the stats query failed |
| `TOOL_EXECUTION_FAILED` | unexpected internal exception (the reason only goes to the server log) |

`INVALID_RECOMMENDATION_REQUEST` and `INVALID_IMPRESSION_REQUEST` are the
**REST side** input error codes. MCP reuses the same schemas, but invalid
arguments are stopped by the SDK before the tool runs (see below), so those
two codes are never reached here.

**Invalid arguments** (unknown fields, wrong types, out-of-range values) are
stopped by the SDK before the tool runs, and show up as an `isError: true`
result whose message names the offending field. This layer has no stable error
code — it is protocol-level validation, not a business error.

**A missing or unauthorized tool** (including a missing scope, see §4) is
stopped at the same layer: it shows up as `isError: true` with a text like
`MCP error -32602: Tool xxx not found`, and it has **no
`structuredContent`**. To find out which permission to request, read the
`initialize` instructions — they list, for this credential, which scope is
missing.

## 7. Rate limits and call logs

### 7.1 Rate limits

The counters live in the database and **share the same quota as the REST
side**: getting a double quota just by switching protocol would make rate
limiting pointless.

- Window: a fixed one minute.
- Default quota: 120 per minute (`AGENT_API_DEFAULT_RATE_LIMIT` is
  adjustable).
- **Counted per tool call**: a request carrying N `tools/call` messages draws
  down N units of quota. JSON-RPC batching (one HTTP request carrying an
  array) is counted the same way — otherwise a single batched request would
  buy a multiple of the documented quota. Requests without a tool call (the
  handshake, `tools/list`) count as one.
- Response headers: `x-ratelimit-limit`, `x-ratelimit-remaining`,
  `x-ratelimit-reset`, plus `retry-after` when the limit is exceeded.

### 7.2 Call logs

MCP call logs are recorded **per tool call**, not per HTTP request:

| Field | Value under MCP |
|---|---|
| `method` | `MCP` |
| `path` | `/mcp/tools/<tool name>`, e.g. `/mcp/tools/search_products` |
| `status_code` | 200 on success; 4xx/5xx on failure, depending on the nature of the failure |
| `error_code` | the stable error code on failure, null on success |

Failures that happen **before** the tool — authentication, rate limiting, and
tool calls rejected by the protocol layer (invalid arguments, a missing or
unauthorized tool) — are recorded under `path = /mcp`, with the error codes
`UNAUTHORIZED` / `RATE_LIMIT_EXCEEDED` / `TOOL_CALL_REJECTED` respectively.

Why per tool: MCP tool failures hide inside the JSON-RPC `isError` while the
HTTP status code is still 200. Counting HTTP requests misses those failures
**entirely**, and "how often was each tool called and how often did it fail"
is exactly the table external developers need most during the trial phase.

```sql
SELECT path, count(*), count(*) FILTER (WHERE status_code >= 400) AS failures
FROM api_request_logs
WHERE method = 'MCP'
GROUP BY path
ORDER BY count(*) DESC;
```

## 8. Compatibility promises

Same principles as the REST side:

- **Only breaking changes bump the version**; adding tools or optional fields
  does not.
- **Tool names and argument field names are only added, never changed.**
  Adding a tool does not affect existing integrations, and adding an
  **optional** field to an existing tool is a compatible change.
- **Stable error codes are never renamed.** The same failure reason never
  gets a different code.
- **Tool arguments reject unknown fields.**
- **Amount units and grouping stay the same.**
- **Rate limiting and authentication semantics are never loosened**: raising a
  quota is allowed, tightening it requires a version bump.
- **The underlying data semantics stay the same**: the products and offers
  returned over MCP are the same data with the same meaning as on the REST
  side.

## 9. How to verify that an integration really works

This repository ships three runnable clients under [`../examples/`](../examples/).
Each one needs only your own API key — no administrator token:

| Example | What it verifies | Command |
|---|---|---|
| [`../examples/sdk-client/`](../examples/sdk-client/) | the **official SDK client** connecting and running the whole shopping flow — the client code an external integration would actually use | `npm run sdk-client` |
| [`../examples/agent-step/`](../examples/agent-step/) | a **single tool call**, where the caller (an agent) decides what to pass | `npm run agent-step -- --tool search_products --args '{"q":"iphone","limit":3}'` |
| [`../examples/shopping-agent/`](../examples/shopping-agent/) | a **complete agent** — the model decides which tool to call and what to pass, and the flow runs end to end | `npm run demo` |

The model provider in the demo is a configuration value: any OpenAI-compatible
`/chat/completions` endpoint works.

### 9.1 Test it by hand with the MCP Inspector

```powershell
npx @modelcontextprotocol/inspector --cli https://commerce.bitfund.ltd/mcp \
  --method tools/list --header "x-api-key: ac_trial_xxxxxxxx"

npx @modelcontextprotocol/inspector --cli https://commerce.bitfund.ltd/mcp \
  --method tools/call --tool-name search_products \
  --tool-arg q=iphone --tool-arg limit=3 \
  --header "x-api-key: ac_trial_xxxxxxxx"
```

Adding `--strict` also lets the Inspector check the portability of the tool
schemas (measured on 2026-11-04: 0 errors / 3 warnings, all warnings on free
form objects such as `metadata` / `snapshot`).

> **Third-party clients assume the service speaks OAuth.** The Inspector
> without a header reports `auth_required` ("Interactive OAuth requires a
> TTY"), because it treats the server as an OAuth service first. This service
> uses a static API key and **never** sends `WWW-Authenticate` in a 401
> response — so integrations must **explicitly** configure `x-api-key` or
> `Authorization: Bearer`, instead of waiting for the client to discover it.

### 9.2 Quotas are per key

120 requests per key per minute by default, counted **per tool call** (see
§7.1). **One complete flow (steady state) is 6 requests**: 5 tool calls plus 1
click redirect, so design batch work against that number; **the first
integration round is 8** (one extra handshake and one `tools/list`).
Exceeding the limit returns `429` plus `retry-after`.

Note: the **click redirect (`/go/...`) does not consume this key's quota** —
it does not go through MCP and is not counted per key. It is included in the
6 above only so that "one complete flow" means the same thing everywhere;
what actually draws down the quota is those 5 tool calls.

## 10. Known boundaries

- **No server-initiated push.** `GET /mcp` returns `405`. The service has
  nothing to push right now; if that changes (progress of a long task, say),
  the transport will be revisited.
- **No Resources and no Prompts**, only Tools.
- **Stateless**, so there is no server-side session state across requests.
  Continuous context is the agent's job.
- **No exchange rates**, so comparisons never conclude across currencies (see
  §5.2).
- **The administrator token can connect and owns every tool** — it is an
  operations backdoor, not a credential issued to integrations.
