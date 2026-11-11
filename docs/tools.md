# Tool reference

The **authoritative** specification is [contract.md](./contract.md). This page
is the quick version: one section per tool, only what you actually pass.

**Contract version: 2026-11-10.**

The two cannot drift apart — CI compares the tool names listed here against
the contract and fails the build if they differ.

## At a glance

| Tool | Scope | Purpose | Writes data |
|---|---|---|---|
| `search_products` | `catalog:read` | Search the catalog | no |
| `compare_offers` | `catalog:read` | Compare the offers of one product | no |
| `create_purchase_link` | `catalog:read` | Build an attributed purchase URL | no |
| `record_recommendation` | `recommendations:write` | Record what you recommended | **yes** |
| `record_impression` | `recommendations:write` | Report that an item was shown | **yes** |
| `recommendation_analytics` | `analytics:read` | Read the performance funnel | no |

`create_purchase_link` writes nothing — the click is recorded when the user
opens the link.

## The list is filtered by scopes

`tools/list` only returns the tools your key can actually use. A key with
`catalog:read` + `recommendations:write` sees **five** tools;
`recommendation_analytics` needs `analytics:read` requested separately.

If a tool is missing, it is not a bug — it is the scope filter.

---

## `search_products`

Search normalized products by keyword. Returns every cross-source offer of
each product.

| Parameter | Type | Meaning |
|---|---|---|
| `q` | string | **required**, 1–100 characters |
| `limit` | number | optional, 1–50, default 10 |

**Returns** `products[]` — each with `id`, `title`, `brand`, `category`,
`gtin`, `offers[]` — plus `meta`.

Each offer carries `id`, `source`, `price`, `currency`, `availability`,
`condition`, `shippingOptions`, `itemLocation`, `productUrl`,
`imageUrl`, `affiliateUrl`, `fetchedAt`, `lastVerifiedAt`, `clickUrl`.

**Watch out**

- `price` is a **string** (fixed-point decimal, major unit). Never parse it as
  a float, and never compare across currencies.
- `condition` is a stable vocabulary: `new` / `used` / `refurbished` /
  `open_box`, and `null` when unknown. `null` means *unknown*, **not** *new*.
- `availability` is the lower-cased upstream value; `unknown` means the
  listing's details were never fetched.
- `condition`, `shippingOptions` and `itemLocation` describe the **offer**,
  not the product. The same product can be new from one seller and used from
  another.
- `clickUrl` is an absolute URL — hand it to the user as-is.

## `compare_offers`

Compare the offers of one product.

| Parameter | Type | Meaning |
|---|---|---|
| `productId` | string | **required**, from `search_products` |

**Returns** `product`, `offers[]` (ascending by currency, then price) and
`comparison`.

`comparison.currencies[]` carries `currency`, `offerCount`, `lowest`
(`offerId` / `price` / `source`) and `highest`.

**Watch out**

- There is **no cross-currency lowest price** — the service does not provide
  exchange rates, so "who is cheaper" has no answer across currencies. One
  number would be misleading.
- A missing product returns `PRODUCT_NOT_FOUND`.

## `create_purchase_link`

Build an attributed purchase link for an offer.

| Parameter | Type | Meaning |
|---|---|---|
| `offerId` | string | **required**, from a search or comparison result |
| `recommendationItemId` | string (uuid) | optional, from `record_recommendation` |
| `sessionId` | string | optional, upstream session identifier |

**Returns** `url`, `path`, `offerId`, `productId`, `productTitle`,
`price`, `currency`, `availability`, `condition`.

**Watch out**

- **This step writes no data.** The click is recorded when the user opens the
  link (302 to the product page).
- It verifies that the offer and the recommendation item exist and match —
  better to fail now than to hand out a link that 404s.
- Recommendation items are **isolated per integration**: another
  integration's item id reads as `RECOMMENDATION_ITEM_NOT_FOUND`.
- Possible errors: `OFFER_NOT_FOUND`, `RECOMMENDATION_ITEM_NOT_FOUND`,
  `RECOMMENDATION_ITEM_OFFER_MISMATCH`.

## `record_recommendation`

Record what you recommended.

| Parameter | Type | Meaning |
|---|---|---|
| `scenario` | string | **required**, scenario identifier |
| `query` | string | **required**, the raw user question behind this recommendation |
| `sessionKey` | string | optional, upstream session identifier |
| `metadata` | object | optional, non-sensitive extension data |
| `items` | array | **required**, 1–50 entries |

Each item carries `productId`, `offerId`, `position` (unique), plus
optional `reason` and `snapshot`.

**Returns** `recommendationId`, `itemCount` and `items[]` — and every item
has **its own `id`**.

**Watch out**

- Those item ids are the **only credential** that later impressions and clicks
  attach to. `recommendationId` alone cannot answer "which entry did the user
  click?".
- `query` is stored verbatim and there is no self-service deletion. Do not
  put identity information, addresses or phone numbers in it.

## `record_impression`

Report that an item was shown.

| Parameter | Type | Meaning |
|---|---|---|
| `recommendationItemId` | string (uuid) | **required**, must belong to **your** integration |
| `eventKey` | string (uuid) | **required**, idempotency key |
| `impressedAt` | string | **required**, ISO 8601 **with a timezone offset** |
| `metadata` | object | optional |

**Returns** `impressionId` and `inserted`.

- `inserted: true` — a row was really written this time.
- `inserted: false` — a retry of the same impression (same `eventKey`, same
  content).

**Watch out**

- `eventKey` **must be a UUID**, and a retry **must reuse the same value**.
- The same `eventKey` with *different* content is
  `IMPRESSION_EVENT_KEY_CONFLICT` — that is key misuse, not a retry.
- Item ids from another integration read as `RECOMMENDATION_ITEM_NOT_FOUND`.

## `recommendation_analytics`

Read the recommendation performance stats. Requires `analytics:read`.

| Parameter | Type | Meaning |
|---|---|---|
| `from` | string | **required**, inclusive lower bound, ISO 8601 with timezone offset |
| `to` | string | **required**, exclusive upper bound, ISO 8601 with timezone offset |
| `asOf` | string | optional, observation point (defaults to current database time) |
| `scenario` | string | optional, filter by scenario |

**Returns** `period`, `funnel`, `dataQuality`, `commissions`, `meta`.

- `funnel` — `requests`, `requestsWithItems`, `items`, `impressions`,
  `clicks`, `conversions`.
- `dataQuality` — impression data status, conversions missing a transaction
  timestamp, conversions linked outside the window.
- `commissions` — commissions and sales grouped by (network, currency, status).

**Watch out**

- A single query spans at most **366 days**.
- Amounts here are decimal strings in the **smallest currency unit**,
  grouped by currency, and never summed across currencies. An offer's
  `price` is a different unit — a fixed-point decimal in the major unit.
- `impressions` being `null` means *no impression data was collected*,
  **not** "nobody looked at it".
- Conversion figures appear **only when valid conversion data is available**
  (affiliate-network attribution or imported events). Click tracking alone
  does not confirm a purchase — treat an empty `conversions` field as
  "no conversion data yet", not "nobody bought anything".

---

## Error codes you can act on

Tool failures arrive inside the result (`isError: true`), not as a JSON-RPC
error. Read `structuredContent.error`:

| Code | Meaning | Usually |
|---|---|---|
| `PRODUCT_NOT_FOUND` | the product id does not exist | wrong id, or the product is gone |
| `OFFER_NOT_FOUND` | the offer id does not exist | same |
| `RECOMMENDATION_ITEM_NOT_FOUND` | the item does not exist, or is not yours | an item id from another session or integration |
| `RECOMMENDATION_ITEM_OFFER_MISMATCH` | the offer does not belong to the item | mismatched ids |
| `INVALID_RECOMMENDATION_REQUEST` | the body is invalid | duplicate `position`, too many items |
| `INVALID_IMPRESSION_REQUEST` | the body is invalid | `impressedAt` without a timezone offset |
| `IMPRESSION_EVENT_KEY_CONFLICT` | same `eventKey`, different content | key misuse, not a retry |
| `RECOMMENDATION_ANALYTICS_FAILED` | the stats query failed | window longer than 366 days |
| `TOOL_EXECUTION_FAILED` | unexpected internal error | report the request id |

Authentication and quota failures happen at the HTTP layer instead:
`401 UNAUTHORIZED`, `401 API_KEY_INVALID`, `401 API_KEY_REVOKED`,
`401 API_KEY_EXPIRED`, `403 API_CLIENT_SUSPENDED`,
`403 INSUFFICIENT_SCOPE`, `429 RATE_LIMIT_EXCEEDED`.

Argument validation errors (unknown field, wrong type, out of range) are
caught before the tool runs — they have **no stable error code**, only a
message naming the offending field. Do not build retries on them.

More: [troubleshooting.md](./troubleshooting.md) ·
中文版：[tools.md](./zh/tools.md)
