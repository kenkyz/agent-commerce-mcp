# MCP Troubleshooting

Organized by **symptom**: find the one you are seeing and jump to it.

- The integration steps are in [`quickstart.md`](./quickstart.md)
- The full contract (tools, error codes) is in [`docs/api/mcp.md`](./contract.md)

---

## Do this first: get the requestId

This service sends an `x-request-id` response header with every request.
**Give that value to the service provider when reporting a problem** — it lets
them locate the log for that exact call, which is far more useful than
"a call failed yesterday".

```bash
curl -i -X POST https://staging.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 1. Cannot connect / handshake fails

### `405 Method Not Allowed`

You used `GET` or `DELETE`. **This service only accepts `POST`**.

A 405 on `GET` is explicitly allowed by the MCP specification: it means the
server does not support server-initiated push.

### `406 Not Acceptable`

The `Accept` header is missing something. You must write **both**:

```
Accept: application/json, text/event-stream
```

Missing one gets you rejected. This is not a quirk of this service — it is
what the MCP specification requires.

### `auth_required` / "Interactive OAuth requires a TTY"

**Third-party MCP clients assume the service speaks OAuth.** The client first
treats the server as an OAuth service, finds that there is no OAuth flow to
run, and reports this error — it has not connected to your service yet.

Fix: **configure static credentials explicitly** instead of waiting for the
client to discover them.

```json
{
  "mcpServers": {
    "agent-commerce": {
      "url": "https://staging.bitfund.ltd/mcp",
      "headers": { "x-api-key": "ac_trial_xxxxxxxx" }
    }
  }
}
```

Claude Desktop / Cursor also accept `Authorization: Bearer <key>` — both forms
are recognized and carry the same value.

> This service uses a static API key and **never** sends `WWW-Authenticate` in
> a 401 response, so a client has no clue what header it should send. You must
> configure it.

### `Connection refused` / timeout

- **Wrong environment**: trial is `staging.bitfund.ltd`, production is
  `commerce.bitfund.ltd`.
- **Key from the wrong environment**: keys are **not shared** between the two
  environments. Confirm with the service provider which environment this key
  belongs to.
- Check the network first with `curl <base>/health` — it needs no credentials.

---

## 2. Authentication problems (401 / 403)

| Status | `error` | Cause |
|---|---|---|
| 401 | `UNAUTHORIZED` | no credentials at all |
| 401 | `API_KEY_INVALID` | the key does not exist or does not match |
| 401 | `API_KEY_REVOKED` | the key has been revoked |
| 401 | `API_KEY_EXPIRED` | the key has expired |
| 403 | `API_CLIENT_SUSPENDED` | the client account owning the key is suspended |
| 403 | `INSUFFICIENT_SCOPE` | the credential is valid but lacks the scope this tool needs |

### "The key is clearly right, why 401?"

Check these three things in order:

1. **Was the key truncated?** Copying a few characters too few is common, and
   the **server only says "invalid credential" — never "your value was
   truncated"**. Comparing lengths is faster than doubting the token itself.
2. **Is the environment right?** A staging key against production returns 401,
   and vice versa.
3. **Did you send the correct one of the two headers?** `x-api-key` and
   `Authorization: Bearer` are both accepted, but **once a credential is
   present there is no fallback** — an invalid key never silently degrades into
   administrator rights.

### `INSUFFICIENT_SCOPE` even though the tool name is there

**The tool list is filtered by this key's permissions**: a tool whose scope is
missing does **not appear in `tools/list` at all**. So if you saw a tool in
`tools/list`, calling it should not fail with a scope error.

If it does, you are calling a REST endpoint rather than an MCP tool — the scope
names are the same on both sides but the check happens at a different point.

### Revocation and expiry take effect **immediately**

Every call reads the state from the database; nothing is cached. There is
nothing to wait for after a revocation.

---

## 3. Tool call failures (`isError: true`)

A failing tool is **not** a JSON-RPC level error — it comes back inside
`result`:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "{\"error\":\"PRODUCT_NOT_FOUND\", ...}" }],
  "structuredContent": { "error": "PRODUCT_NOT_FOUND", "message": "..." }
}
```

**Read `structuredContent.error`** — that is the stable error code, and the
agent can use it to decide whether to retry, to change the arguments, or to
request the missing permission.

| Error code | Meaning | Typical response |
|---|---|---|
| `PRODUCT_NOT_FOUND` | the product id does not exist in the database | the id is wrong, or the product is delisted |
| `OFFER_NOT_FOUND` | the offer id does not exist in the database | same |
| `RECOMMENDATION_ITEM_NOT_FOUND` | the recommendation item does not exist, or does not belong to your integration | you used an item id from another session, or from another integration |
| `RECOMMENDATION_ITEM_OFFER_MISMATCH` | the offer exists but does not belong to the declared product/item | item id and offer id do not match |
| `INVALID_RECOMMENDATION_REQUEST` | invalid recommendation request body | duplicate `position`, too many items, etc. |
| `INVALID_IMPRESSION_REQUEST` | invalid impression request body | `impressedAt` without a timezone offset, etc. |
| `IMPRESSION_EVENT_KEY_CONFLICT` | the same `eventKey` carried different content | **not a retry**: the key was misused |
| `RECOMMENDATION_ANALYTICS_FAILED` | the stats query failed | the window spans more than 366 days |
| `TOOL_EXECUTION_FAILED` | unexpected internal exception | contact the service provider with the requestId |

### What "calling a tool that does not exist" looks like

Two shapes that must **not** be mixed up — an agent reads them differently:

- Calling a **tool that does not exist** → `isError: true` plus the text
  `MCP error -32602: Tool xxx not found` (the SDK stops it at the tool layer,
  there is no JSON-RPC level error).
- Calling a **method that does not exist** (such as `tools/callX`) → a
  top-level JSON-RPC error `{"code":-32601,"message":"Method not found"}`.

### Argument validation errors have no stable error code

**Unknown fields, wrong types, out-of-range values** are stopped by the SDK
before the tool runs. They show up as `isError: true` with a message naming
the offending field.

That layer is protocol-level validation, not a business error, so there is
**no** `structuredContent.error`. Do not make your retry logic depend on
these having a stable code.

### `Invalid UUID at eventKey`

`eventKey` (the idempotency key) and `recommendationItemId` **must be
UUIDs**. A value such as `"impression-1"` or `"exp-2026-11-07"` is stopped
before the tool runs:

```
MCP error -32602: Input validation error: Invalid arguments for tool record_impression: Invalid UUID at eventKey
```

This layer has no stable error code, but it is easy to recognize: **whenever you
see `Invalid UUID at xxx`, some id field was not a UUID.**

- `recommendationItemId`: must be the **exact** `items[].id` returned by
  `record_recommendation`.
- `eventKey`: generate it with `randomUUID()`; a **retry of the same
  impression reuses the same value**.

### Request bodies reject unknown fields

A misspelled field name is rejected explicitly instead of being silently
ignored — silent ignoring hands you a recommendation record that "looks fine"
but is missing content.

---

## 4. Rate limiting (429)

```
HTTP/1.1 429 Too Many Requests
retry-after: 30
x-ratelimit-limit: 120
x-ratelimit-remaining: 0
```

- **120 requests per key per minute** by default; adjustable per key.
- **One complete flow (steady state) is 6 requests**: 5 tool calls plus 1 click
  redirect. Design batch work against that number;
  **the first integration round is 8** (one extra handshake and one
  `tools/list`).
- The window is aligned to whole minutes on the database clock.
- Counters live in the **database**: a redeploy does not reset the quota, and
  multiple replicas share the same ledger.
- **Authentication comes before rate limiting** — so a flood of invalid
  credentials cannot consume a legitimate caller's quota. Put the other way
  around: if you receive a 429, **authentication already passed** and your key
  is valid.

---

## 5. The result is wrong (not an error, just odd data)

### `condition` is `null`

**This means "unknown", not "new".** Two causes:

1. The listing's **details have never been fetched** — only price, title and
   link are known; nobody fetched condition and availability from the upstream
   source. The catalog contains a batch of such listings.
2. The details were fetched, but the upstream had no condition at that moment.

When you write code against it:

```ts
// Right: explicitly require new
const isNew = offer.condition === "new";

// Wrong: null counts as "not used", so unknown-condition items get pushed
const isNew = offer.condition !== "used";
```

### Condition values you may not recognize

Condition is a **stable vocabulary** with exactly four values:

| Value | Meaning |
|---|---|
| `new` | brand new |
| `used` | second-hand |
| `refurbished` | refurbished (all grades land here) |
| `open_box` | open box |

When it cannot be determined it is `null`. **Free-form upstream text never
appears verbatim in this field**, so you do not need to handle wording such as
"Good - Refurbished".

### The price comparison looks wrong

Most likely **you are not looking at condition**. `condition` /
`shippingOptions` / `itemLocation` are **offer (listing) level** attributes:
the same product may be new from one seller and used from another, free
shipping from one and paid from another. Without those three fields, the
prices you compared may not even be the same thing.

Another common cause: **different currencies**. This service **does not
provide exchange rates**, so comparisons never draw a conclusion across
currencies — `comparison.currencies[]` is grouped by currency, and there is no
"who is cheaper" answer between different currencies.

### `availability` is `unknown`

Same as `condition`: the listing's details were never fetched, or the
upstream did not report a stock state. `availability` stores the lower-cased
upstream value (`in_stock` / `out_of_stock`) and is **not semantically
rewritten** — when the upstream invents a new value, the lower-cased original
is still readable.

### Search returns nothing

- The keyword is too narrow (`q` takes 1–100 characters and matches title,
  brand and category loosely).
- The catalog really has nothing for that word. **Staging is the sandbox
  market**: its catalog is completely different from production, and **the two
  are not interchangeable**.

---

## 6. The attribution chain is broken

### The impression was reported but does not show up in the stats

**The stats window may not have arrived yet after the impression is
reported.** Also remember:

- `impressions` being `null` rather than `0` means **no impression data
  was collected** (impression reporting is not wired up yet), not "the user
  saw nothing". The two must be kept apart.
- The stats cohort is determined by the **recommendation request**: impressions,
  clicks and conversions all belong to that recommendation, even when the event
  itself happens after the window closed.

### The click count stays at 0

**The click record is written when the user actually opens the link**, not when
the link is generated. `create_purchase_link` only produces an attributed URL;
by itself it writes nothing.

When testing, really request that URL:

```bash
curl -i "https://staging.bitfund.ltd/go/offer_xxx?recommendation_item_id=<uuid>&session_id=xxx"
# expect 302, with Location pointing at the eBay product page
```

### The click is not attributed to the recommendation

`recommendationItemId` must be the `items[].id` returned by **that same**
`record_recommendation` call. Using `recommendationId` instead gives you
`RECOMMENDATION_ITEM_NOT_FOUND`.

Use `&` when adding query parameters — the purchase link **already carries**
`?recommendation_item_id=`, and using `?` again turns the value into
`uuid?session_id=...`, which fails the server's UUID validation and returns
400 directly.

---

## 7. The client connects but the tool list is wrong

### Tools are missing

Tools whose scope is missing do not appear in `tools/list`. A trial key has
`catalog:read` + `recommendations:write` by default, so there are only 5
tools; `recommendation_analytics` requires `analytics:read` to be requested
separately.

### The `initialize` instructions are empty

That means the handshake had a problem. `connect` again and look once more.

The instructions are **generated from the current permissions**: they state
which tools this credential can use and which scope a missing tool needs. Once
the agent has read them it knows what to request instead of guessing.

---

## 8. Still stuck

Send the service provider:

1. **`x-request-id`** (the most important one)
2. the **environment endpoint** you used (staging or production)
3. the **first 8 characters of the key** (not the full key) and **when it was
   issued**
4. the complete **`tools/call` request body** and **response body** (with the
   key masked)
5. the **client and version** you use (Claude Desktop / Cursor / your own, plus
   the SDK version)

### How the service provider investigates

```bash
# find this call by requestId
curl -H "x-import-token: $ADMIN_TOKEN" \
  "https://staging.bitfund.ltd/v1/admin/api-requests?limit=50"

# call stats and success rate per integration
curl -H "x-import-token: $ADMIN_TOKEN" \
  "https://staging.bitfund.ltd/v1/admin/stats"
```

> **MCP failures hide inside the JSON-RPC `isError` while the HTTP status
> code is still 200.** Counting HTTP requests misses those failures entirely —
> so this service logs by **tool call**: `method='MCP'`,
> `path='/mcp/tools/<tool name>'`. Look at the numbers by that measure, not by
> HTTP status code.

---

## Appendix: one-minute self-check list

```bash
BASE=https://staging.bitfund.ltd
KEY=$YOUR_API_KEY

# 1. Is the service alive?
curl -s $BASE/health

# 2. Are the credentials right? How many tools do you see?
curl -s -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400

# 3. Can you find anything?
curl -s -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_products","arguments":{"q":"iphone","limit":1}}}' | head -c 400
```

If all three pass, the integration is fine. Whichever step breaks, go to the
matching section above.
