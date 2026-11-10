# agent-commerce-mcp

**Commerce infrastructure for AI shopping agents.**
Search real products, compare real offers, record what you recommended, and hand the user a link that still works — over MCP, one endpoint.

[![transport](https://img.shields.io/badge/transport-MCP%20Streamable%20HTTP-4C6EF5)](./docs/contract.md)
[![license](https://img.shields.io/badge/license-MIT-8F5A2C)](./LICENSE)
[![status](https://img.shields.io/badge/status-developer%20preview-D98C2A8)](./docs/troubleshooting.md)

This repository is the **integration layer** — client examples, the tool contract, and the docs.
The service behind it is hosted and **not** open source.
See [What is and isn't open](#what-is-and-isnt-open).

---

## Why you would use this

Adding shopping to an AI agent usually means building all of this first:

| The work | Without this service | With it |
|---|---|---|
| A product feed that stays fresh | your own crawler, scheduler, dedup | `search_products` |
| Normalized attributes | parse raw listing titles yourself | `condition` from a stable vocabulary |
| Offer comparison | your own grouping and ranking | `compare_offers`, grouped per currency |
| Click attribution | your own redirect service and event pipeline | `record_recommendation` → `record_impression` → `create_purchase_link` |
| Knowing what actually sold | your own conversion matching | `recommendation_analytics` |

None of that is the hard part of your product. This service is the part you
would otherwise spend a month on.

## What you get

- **A live catalog.** Products normalized across sources, each carrying every
  offer: price, currency, condition, availability, shipping, location.
- **Six MCP tools.** The whole surface fits in one sitting.
- **Attribution that survives the click.** The recommendation, the impression
  and the click hang off the same item id — so you can answer *"which entry of
  the list did the user pick?"*.

---

## Quick start

### 1. Get a trial key

Request a key from the service provider — the entry page carries the contact
details: **[commerce.bitfund.ltd/docs](https://commerce.bitfund.ltd/docs)**.
You can also open a GitHub issue using the *Integration Feedback* template.

The plaintext is shown **once**, at issue time. There is no "retrieve it later"
operation — if you lose it, you get a new one.

> Two environments exist and **keys are not shared between them**:
> trial `https://staging.bitfund.ltd/mcp`, production `https://commerce.bitfund.ltd/mcp`.

### 2. Point your client at it

Claude Desktop, Cursor, or anything that speaks MCP:

```json
{
  "mcpServers": {
    "agent-commerce": {
      "url": "https://commerce.bitfund.ltd/mcp",
      "headers": {
        "x-api-key": "<YOUR_API_KEY>"
      }
    }
  }
}
```

> **Set `x-api-key` (or `Authorization: Bearer`) explicitly.** Most MCP clients
> assume the server speaks OAuth and fail with `auth_required` instead of
> connecting. This service uses a static key and never sends
> `WWW-Authenticate`, so a client cannot work out on its own what to send.

### 3. Make one call

```bash
curl -X POST https://commerce.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"q":"wireless headphones under 200","limit":3}}}'
```

Both `Accept` types are required by the MCP specification — drop one and the
request is rejected with `406`.

**That's it.** Full walkthrough: [docs/quickstart.md](./docs/quickstart.md) ·
中文版：[docs/zh/quickstart.md](./docs/zh/quickstart.md)

---

## The six tools

| Tool | Scope | What it does |
|---|---|---|
| `search_products` | `catalog:read` | Search the catalog; returns products with every offer |
| `compare_offers` | `catalog:read` | Compare the offers of one product, grouped per currency |
| `create_purchase_link` | `catalog:read` | Build an attributed purchase URL for an offer |
| `record_recommendation` | `recommendations:write` | Record what you recommended; returns the item ids |
| `record_impression` | `recommendations:write` | Report that an item was shown (idempotent) |
| `recommendation_analytics` | `analytics:read` | Read the recommendation → impression → click → conversion funnel |

The list is **filtered by the key's scopes**: a key without `analytics:read`
simply does not see `recommendation_analytics` in `tools/list`.

Full specification: [docs/contract.md](./docs/contract.md) ·
Quick reference: [docs/tools.md](./docs/tools.md) ·
Errors and symptoms: [docs/troubleshooting.md](./docs/troubleshooting.md)

---

## Run the demo agent

A complete shopping agent in one file: the model decides which tool to call
and what to pass, the service supplies the catalog and the attribution.

```bash
npm install
cp .env.example .env        # fill in MCP_API_KEY and your model key
npm run demo -- --query "wireless headphones under 200"
```

The model provider is a **configuration value, not a binding**. Any
OpenAI-compatible `/chat/completions` endpoint works — MiniMax, DeepSeek,
Qwen, OpenRouter, self-hosted vLLM, local Ollama. Switching models is an
environment variable, not a code change.

Other examples:

| Example | What it shows |
|---|---|
| `examples/shopping-agent/` | A full agent: search → compare → recommend → impression → purchase link, with the model in the loop |
| `examples/sdk-client/` | The same flow through the official MCP SDK, with pass/fail assertions |
| `examples/agent-step/` | One tool call, with the caller deciding what to pass — the shape an agent actually uses |

---

## Repository layout

```
agent-commerce-mcp/
├── docs/
│   ├── quickstart.md          # 15 minutes to your first successful call
│   ├── tools.md               # quick reference: tool, scope, parameters
│   ├── troubleshooting.md     # organized by symptom
│   ├── contract.md            # the full specification (authoritative)
│   └── zh/                    # 中文版
├── examples/
│   ├── shopping-agent/        # full agent, model in the loop
│   ├── sdk-client/            # official SDK client, end-to-end flow
│   └── agent-step/            # single tool call
├── tools/                     # repo checks: secret scan, docs consistency
└── .github/                   # issue templates, CI
```

## What is and isn't open

**Open here**

- The tool contract — names, parameters, response shapes, error codes.
- The quick start and troubleshooting guides (English and Chinese).
- Three runnable clients you can copy.

**Not open**

- The service implementation: catalog sync, product normalization, the
  matching engine, the attribution engine.
- The commerce backend and its database.

The point of publishing this layer is that **how you connect matters, how the
catalog is built does not**. Integration should not require reading somebody
else's business logic.

## Documentation

- **[Quick start](./docs/quickstart.md)** — first successful call in 15 minutes
- **[Tool reference](./docs/tools.md)** — quick reference
- **[Full contract](./docs/contract.md)** — authoritative specification
- **[Troubleshooting](./docs/troubleshooting.md)** — organized by symptom
- **中文版** — [快速开始](./docs/zh/quickstart.md) · [工具参考](./docs/zh/tools.md) · [契约](./docs/zh/contract.md) · [排查手册](./docs/zh/troubleshooting.md)
- **Live docs** — <https://commerce.bitfund.ltd/docs>

## Contributing

Issues and pull requests are welcome — start with an *Integration Feedback*
issue if something did not work as documented; that is the most useful signal
you can send. See [CONTRIBUTING.md](./CONTRIBUTING.md).

Please **never** commit a real API key. `npm run scan:secrets` runs in CI and
will fail the build if one shows up.

## License

[MIT](./LICENSE) — applies to the examples, docs and tooling in this
repository.
