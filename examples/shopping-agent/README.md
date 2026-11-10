# Runnable shopping agent

A **complete, repeatable** shopping agent: the model decides which MCP tool to
call, with what arguments, how to explain the result, and finally produces a
recommendation with a purchase link.

## Quick start

```bash
npm install
cp .env.example .env       # fill in MCP_API_KEY + the model settings
npm run demo -- --query "wireless headphones under 200"
```

## Configuration

**The model provider is a configuration value, not a binding.** Anything that
speaks an OpenAI-compatible `/chat/completions` works — MiniMax, DeepSeek,
Qwen, OpenRouter, a self-hosted vLLM, a local Ollama.

| Variable | Required | Meaning | Example |
|---|---|---|---|
| `MCP_URL` | no | MCP endpoint (**without** `/mcp`; the script appends it) | `https://commerce.bitfund.ltd` |
| `MCP_API_KEY` | **yes** | MCP credential | `ac_trial_xxxxxxxx` |
| `LLM_BASE_URL` | **yes** | base URL of the model service | `https://api.minimax.chat/v1` |
| `LLM_API_KEY` | **yes** | credential for the model service | `sk-xxxxxxxx` |
| `LLM_MODEL` | **yes** | model name | `MiniMax-M2` |
| `LLM_PROVIDER` | no | only written into the User-Agent, to tell call sources apart | `minimax` |
| `SCENARIO` | no | recommendation scenario identifier | `demo-shopping-agent` |

**Switching models requires no code change at all**, only environment
variables.

> This example deliberately **brings in no model SDK** — it only uses
> `fetch` against `/chat/completions`. One dependency fewer means one fewer
> reason to touch the code when you change models.

## What it does

One complete flow where **every step is decided by the model**:

```
search_products        search
     ↓
compare_offers        compare offers (condition / shipping / location differences)
     ↓
record_recommendation  record the recommendation → get items[].id
     ↓
record_impression      report the impression (once per item)
     ↓
create_purchase_link   create the attributed purchase link
     ↓
final answer (product, price, condition, link, and why this one)
```

### Decision rules written into the prompt

- **`condition` is a stable vocabulary** (`new` / `used` / `refurbished` /
  `open_box`, where `null` means unknown). When the user explicitly wants a
  brand-new device, only `condition === "new"` qualifies — `null` is **not**
  the same as new.
- **`price` is a string**, and prices in different currencies cannot be
  compared directly.
- When a tool fails, read the error code, change the arguments and retry —
  **never invent a product**.
- A failure of `record_impression` / `create_purchase_link` must **not**
  abandon the whole flow.

## Known boundaries

- **At most 8 rounds.** Hitting the limit stops the run and says so — it
  usually means the model is retrying the same failure over and over.
- **Only OpenAI-compatible `tool_calls` are supported.** A model without
  function calling cannot run this.
- Running it leaves recommendation and impression records in the service
  (`scenario` = the `SCENARIO` you configured). Ask the service provider to
  clean them up if you need the data gone.

## Making it your own agent

This demo is a reference implementation, **do not copy it**. Your agent only
has to:

1. connect to `/mcp` with an MCP client;
2. feed the result of `tools/list` into the model's tool definitions;
3. loop over `tool_calls`;
4. pass the `items[].id` returned by `record_recommendation` into the
   later calls;

and the integration is done. **The real integration is only the first two
steps** — steps 3 and 4 are business requirements.

The full contract is in [`../../docs/contract.md`](../../docs/contract.md), and the
integration steps are in [`../../docs/quickstart.md`](../../docs/quickstart.md).
