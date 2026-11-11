# MCP Quick Start

This guide is for developers connecting to this service's MCP endpoint **for the first time**.
**Goal:** one successful tool call within 15 minutes.

- Full contract (tool list, error codes, compatibility promises): [`docs/api/mcp.md`](./contract.md)
- The same capabilities over REST: [`docs/api/agent-trial.md`](https://commerce.bitfund.ltd/docs/en/api/agent-trial)
- When something does not work: [`troubleshooting.md`](./troubleshooting.md)

---

## 0. What you need

| | |
|---|---|
| An API key | Request one from the service provider; it looks like `ac_trial_xxxxxxxx`. **The plaintext is shown once** — there is no way to retrieve it afterwards |
| An MCP client | Claude Desktop, Cursor, or your own agent (code below) |
| Node.js 20+ | Only needed for the "build your own agent" section |

> **Endpoints:** trial environment `https://staging.bitfund.ltd/mcp`,
> production `https://commerce.bitfund.ltd/mcp`.
> When you ask the service provider for a key, they will also tell you which
> endpoint to use — **keys are not shared between the two environments**.

---

## 1. Confirm the service is alive in thirty seconds

No credentials required:

```bash
curl https://staging.bitfund.ltd/health
```

Expect:

```json
{ "status": "ok", "service": "agent-commerce-api" }
```

If you see `{"status":"ok"}`, the network path works and the service is up.
Carry on.

---

## 2. List the available tools

```bash
curl -X POST https://staging.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`tools/list` should contain these 6 tools (**the names are the contract** — these are
what you call):

```
search_products
compare_offers
create_purchase_link
record_recommendation
record_impression
recommendation_analytics
```

Each tool also carries a human-readable `title` and `description`; those follow the
request language (English by default) and are not part of the names above.

**Both headers are required**: `Content-Type` and `Accept`. Omitting `Accept`
gets you a `406`. The `Accept` header must list **both** `application/json`
and `text/event-stream` — that is the MCP specification, not a quirk of this
service.

**The tool list is filtered by this key's permissions**: a tool whose scope is
missing does not appear in `tools/list` at all. A trial key has `catalog:read`
+ `recommendations:write` by default, so you will only see 5
(`recommendation_analytics` needs `analytics:read` requested separately).

> **The names are the contract; the descriptions follow your language.**
> Each tool carries a machine-readable `name` (the one to call), plus a
> human-readable `title` and `description`. The service picks the language
> from the `Accept-Language` header and **defaults to English**; send
> `Accept-Language: zh` to get the Chinese wording instead. The `name`,
> the argument fields and the error codes are identical in every language.

---

## 3. Your first search

```bash
curl -X POST https://staging.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_products","arguments":{"q":"iphone","limit":3}}}'
```

The product list is in `result.structuredContent.products`; every product
carries an `offers[]` array:

```json
{
  "products": [
    {
      "id": "prod_...",
      "title": "Apple iPhone 17 256GB",
      "offers": [
        {
          "id": "offer_...",
          "price": "799.00",
          "currency": "USD",
          "availability": "in_stock",
          "condition": "new",
          "clickUrl": "https://staging.bitfund.ltd/go/offer_...",
          "productUrl": "https://www.ebay.com/itm/..."
        }
      ]
    }
  ]
}
```

### Four traps when reading the results

1. **`price` is a string**, a fixed-point decimal (major unit, two decimals).
   Do not parse it as a float, and do not compare prices across currencies —
   two prices with different `currency` values **cannot be compared directly**.
2. **`condition` is a stable vocabulary**: `new` / `used` / `refurbished` /
   `open_box`, and `null` when it cannot be determined. **`null` means
   "unknown", not "new"** — to recommend a brand-new device, check
   `condition === "new"`, not `condition !== "used"`.
3. **`availability` is the upstream value, lower-cased** (such as `in_stock`,
   `out_of_stock`); it is not semantically rewritten. If the upstream invents a
   new value, the lower-cased original is still readable.
4. **`condition` / `shippingOptions` / `itemLocation` describe the offer
   (listing), not the product.** The same product may be new from one seller
   and used from another, free shipping from one and paid from another. Without
   those three fields, the prices you compared may not even be the same thing.

> **`clickUrl` is an absolute URL** and can be handed to the user as-is.
> Opening it writes the attribution record and then 302-redirects to the real
> product page.

---

## 4. Connect an MCP client

### Claude Desktop / Cursor

Add this to your MCP server configuration:

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

> **You must set `x-api-key` (or `Authorization: Bearer`) explicitly.**
> Third-party MCP clients assume the service speaks OAuth: with no credentials
> configured they fail with `auth_required` ("Interactive OAuth requires a
> TTY") instead of connecting. This service uses a static API key and never
> sends `WWW-Authenticate`, so a client cannot work out on its own which
> header to send.

### Building your own agent (official SDK)

```bash
npm install @modelcontextprotocol/sdk
```

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("https://staging.bitfund.ltd/mcp"),
  {
    requestInit: {
      headers: { "x-api-key": process.env.MCP_API_KEY! },
    },
  },
);

const client = new Client(
  { name: "my-shopping-agent", version: "1.0.0" },
  { capabilities: {} },
);

await client.connect(transport);

const tools = await client.listTools();
console.log(tools.tools.map((t) => t.name));

const result = await client.callTool({
  name: "search_products",
  arguments: { q: "iphone", limit: 3 },
});

console.log(result.structuredContent);

await client.close();
```

Protocol negotiation, the `Accept` header and the protocol version are all
handled by the SDK — you do not have to think about any of them.

### No SDK? Try it by hand with the Inspector

```bash
npx @modelcontextprotocol/inspector --cli https://staging.bitfund.ltd/mcp \
  --method tools/call --tool-name search_products \
  --tool-arg q=iphone --tool-arg limit=3 \
  --header "x-api-key: $YOUR_API_KEY"
```

---

## 5. Run one complete shopping flow

These 6 steps are a complete "search → recommend → impression → purchase
redirect" flow. A full runnable script lives in
[`examples/shopping-agent/`](../examples/shopping-agent/).

### Running it

The script needs the service URL and your key in the environment, plus a
model provider for the agent itself (`LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_MODEL` — any OpenAI-compatible endpoint works, see the example's README).

**macOS / Linux**

```bash
export MCP_URL="https://staging.bitfund.ltd"
export MCP_API_KEY="ac_trial_xxxxxxxx"
npx tsx examples/shopping-agent/index.ts --query "wireless headphones under 200"
```

**Windows (PowerShell)**

```powershell
$env:MCP_URL = "https://staging.bitfund.ltd"
$env:MCP_API_KEY = "ac_trial_xxxxxxxx"
npx tsx examples/shopping-agent/index.ts --query "wireless headphones under 200"
```

| Step | Tool | What to watch |
|---|---|---|
| 1 | `search_products` | get `product.id` and `offer.id` |
| 2 | `compare_offers` | compare by `productId`; see how condition/shipping differ per offer |
| 3 | `record_recommendation` | the returned `items[].id` is the **only credential** that later impressions and clicks attach to |
| 4 | `record_impression` | `eventKey` is an idempotency key and **must be a UUID**; a retry must reuse the same value |
| 5 | `create_purchase_link` | pass `offerId` + `recommendationItemId` and get an absolute attributed URL |
| 6 | open that URL | 302 to the product page — **this is the step that writes the click record** |

### Step 3's return value deserves a second look

```json
{
  "recommendationId": "3f2b6c14-...",
  "itemCount": 2,
  "items": [
    { "id": "8c1d2e3f-...", "productId": "prod_...", "offerId": "offer_...", "position": 1 }
  ]
}
```

**Keep every item `id`**: `recommendationId` alone cannot answer "which entry
of the recommendation list did the user click?". Both impressions and clicks
attach to the item id.

---

## 6. Minimal script for the complete flow

```ts
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.MCP_URL ?? "https://staging.bitfund.ltd";

const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { "x-api-key": process.env.MCP_API_KEY! } },
});
const client = new Client({ name: "quickstart", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.structuredContent)}`);
  return r.structuredContent;
};

const { products } = await call("search_products", { q: "iphone", limit: 3 });
const product = products[0];
const offer = product.offers[0];

await call("compare_offers", { productId: product.id });

const rec = await call("record_recommendation", {
  scenario: "quickstart",
  query: "iPhone",
  items: [{ productId: product.id, offerId: offer.id, position: 1 }],
});
const recommendationItemId = rec.items[0].id;

await call("record_impression", {
  recommendationItemId,
  // eventKey must be a UUID: it is the idempotency key, and a retry of the
  // same impression reuses the same value
  eventKey: randomUUID(),
  impressedAt: new Date().toISOString(),
});

const link = await call("create_purchase_link", { offerId: offer.id, recommendationItemId });
console.log("Purchase link:", link.url);

await client.close();
```

---

## 7. What we log

**This comes first because you may pass user input into it.**

| What is stored | Where | Why |
|---|---|---|
| **The raw `query` you pass to `record_recommendation`** | `recommendation_sessions.query` | Lets us answer "which question was this recommendation answering?" |
| `scenario`, `sessionKey`, item ids, condition/price snapshots | same table and related tables | Attribution and performance analysis |
| Call time, tool name, status code, duration, source IP, User-Agent | `api_request_logs` | **request and response bodies are not stored** |

- `query` is **required** and there is no "do not record" switch.
  Please **do not put real identity information, addresses or phone numbers into
  `query`** — it is stored verbatim and there is **no self-service deletion**
  (when deletion is needed the service provider runs `db:cleanup:client` by
  agreement, see [`developer-onboarding.md`](https://commerce.bitfund.ltd/docs/en/mcp/developer-onboarding)).
- Recommended practice: pass **the user's question itself** (for example "I
  want an iPhone under 3000"), not the whole conversation.
- Call logs are kept for 30 days by default; recommendation records are kept as
  business data. See [`docs/api/agent-trial.md` §5](https://commerce.bitfund.ltd/docs/en/api/agent-trial#5-request-logs).
- The service provider can clean up a given integration's recommendation
  records by agreement (tool: `db:cleanup:client`, deleted precisely by
  integration; see [`developer-onboarding.md`](https://commerce.bitfund.ltd/docs/en/mcp/developer-onboarding)).

---

## 8. Rate limits

- **120 requests per key per minute** (adjustable per key).
- The window is aligned to whole minutes on the database clock.
- Response headers carry `x-ratelimit-limit` / `x-ratelimit-remaining` /
  `x-ratelimit-reset`; exceeding the limit returns `429` plus `retry-after`.
- **One complete flow (steady state) is 6 requests**: 5 tool calls plus 1 click
  redirect. Design batch work against that number.
  **The very first integration round is 8** (one extra handshake and one
  `tools/list`).

---

## 9. Next steps

- Something does not work → [`troubleshooting.md`](./troubleshooting.md)
- You want the full contract → [`docs/api/mcp.md`](./contract.md)
- You want a complete runnable agent → [`examples/shopping-agent/`](../examples/shopping-agent/)
