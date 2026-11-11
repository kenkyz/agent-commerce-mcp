# Examples

Three runnable clients, in increasing order of "how much of the loop do you
want to own".

| Example | Who decides the arguments | Use it when |
|---|---|---|
| [`agent-step/`](./agent-step/) | you, or the model reading the previous result | you want one tool call and nothing else |
| [`sdk-client/`](./sdk-client/) | the script (but every step is asserted) | you want to verify an integration end to end |
| [`shopping-agent/`](./shopping-agent/) | the model | you want to see a real agent do the whole flow |

All three use the **official MCP SDK client** — the same client code an
external integration would write.

## Before you run anything

You need:

1. **An API key.** Request one from the service provider; the entry page
   carries the contact details: <https://commerce.bitfund.ltd/docs>.
   The plaintext is shown once, at issue time.
2. **Node.js 20 or newer.**

```bash
npm install
cp .env.example .env
# fill in MCP_API_KEY (and the model settings, for the shopping agent)
```

The examples read their configuration from environment variables. With Node 20+:

```bash
node --env-file=.env --import tsx examples/agent-step/index.ts --tool search_products --args '{"q":"iphone","limit":3}'
```

or through the npm scripts, which pick up `.env` for you:

```bash
npm run agent-step -- --tool search_products --args '{"q":"iphone","limit":3}'
npm run sdk-client
npm run demo -- --query "wireless headphones under 200"
```

## Which environment?

| Environment | Endpoint | Catalog |
|---|---|---|
| **trial** (default) | `https://staging.bitfund.ltd` | eBay sandbox — every listing is `New` and `in_stock` |
| production | `https://commerce.bitfund.ltd` | the live eBay market |

**Keys are not shared between the two.** If you get a 401 on a key you are
sure about, check that you are using the environment the key was issued for.
