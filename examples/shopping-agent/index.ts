/**
 * A minimal shopping agent — a complete shopping flow through this service's
 * MCP tools.
 *
 * ## What it proves
 *
 * A complete, repeatable agent: the model decides which tool to call, with
 * what arguments, and how to explain the result. The other examples in this
 * repository hardcode every step, which proves the service works; this one
 * proves that **a different developer, with a different model, can reproduce
 * the flow**.
 *
 * ## The model provider is a configuration value
 *
 * Deliberately **not bound to any vendor**: anything that speaks an
 * OpenAI-compatible `/chat/completions` works — MiniMax, DeepSeek, Qwen,
 * OpenRouter, a self-hosted vLLM, a local Ollama.
 *
 * Switching models **requires no change to the MCP client code**, only
 * environment variables.
 *
 * ## Configuration
 *
 *   MCP_URL=https://commerce.bitfund.ltd     # no /mcp — this script appends it
 *   MCP_API_KEY=ac_trial_xxxxxxxx
 *   LLM_BASE_URL=https://api.minimax.chat/v1
 *   LLM_API_KEY=sk-xxxxxxxx
 *   LLM_MODEL=MiniMax-M2
 *   LLM_PROVIDER=minimax                      # label, written into the User-Agent
 *
 * ## Run
 *
 *   npx tsx examples/shopping-agent/index.ts --query "wireless headphones under 200"
 */

import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Config {
  mcpUrl: string;
  mcpApiKey: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmProvider: string;
  scenario: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      "Missing environment variable " + name + ". See .env.example for the full list.",
    );
  }

  return value;
}

function loadConfig(): Config {
  return {
    mcpUrl: (process.env.MCP_URL ?? "https://commerce.bitfund.ltd").replace(/\/+$/, ""),
    mcpApiKey: requireEnv("MCP_API_KEY"),
    llmBaseUrl: requireEnv("LLM_BASE_URL").replace(/\/+$/, ""),
    llmApiKey: requireEnv("LLM_API_KEY"),
    llmModel: requireEnv("LLM_MODEL"),
    llmProvider: process.env.LLM_PROVIDER?.trim() || "openai-compatible",
    scenario: process.env.SCENARIO?.trim() || "demo-shopping-agent",
  };
}

function parseArgs(argv: string[]): { query: string } {
  const index = argv.indexOf("--query");

  if (index >= 0 && argv[index + 1]) {
    return { query: argv[index + 1] };
  }

  return { query: "wireless headphones under 200" };
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

/**
 * MCP client.
 *
 * Uses the official SDK (`@modelcontextprotocol/sdk`) — the same client code
 * an external integration uses. Protocol negotiation, the Accept header and
 * the protocol version are handled by the transport; none of it is our
 * business here.
 */
class McpShoppingClient {
  private readonly client: Client;

  private readonly transport: StreamableHTTPClientTransport;

  constructor(private readonly config: Config) {
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.mcpUrl + "/mcp"),
      {
        requestInit: {
          headers: {
            "x-api-key": config.mcpApiKey,
            "user-agent": "shopping-agent-demo/" + config.llmProvider,
          },
        },
      },
    );

    this.client = new Client(
      { name: "agent-commerce-shopping-agent", version: "1.0.0" },
      { capabilities: {} },
    );

    this.transport = transport;
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * List the available tools.
   *
   * `inputSchema` is the **server's** argument schema — it is part of the
   * contract. Feeding it straight to the model means this demo never carries
   * its own copy of the parameter definitions.
   */
  async listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  > {
    const listed = await this.client.listTools();
    return listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Call a tool.
   *
   * On failure it **does not throw** — the failure is returned as-is. The
   * model sees the error and can retry with different arguments, which is
   * exactly the behaviour this demo is here to show.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const result: any = await this.client.callTool({
      name,
      arguments: args,
    });

    if (result?.isError) {
      const payload = result?.structuredContent ?? {};
      const code = payload.error ?? "TOOL_ERROR";
      const message = payload.message ?? "";
      return { ok: false, error: message ? code + ": " + message : String(code) };
    }

    return { ok: true, data: result?.structuredContent ?? null };
  }
}

// ---------------------------------------------------------------------------
// LLM client (OpenAI compatible)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * An OpenAI-compatible chat completions client.
 *
 * It uses `fetch` and no model SDK on purpose: that way "switching models"
 * really is only an environment variable, with no reinstall and no code
 * change.
 */
class LlmClient {
  constructor(private readonly config: Config) {}

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<ChatMessage> {
    const response = await fetch(this.config.llmBaseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.config.llmApiKey,
      },
      body: JSON.stringify({
        model: this.config.llmModel,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error("Model service returned " + response.status + ": " + detail.slice(0, 300));
    }

    const payload: any = await response.json();
    const message = payload?.choices?.[0]?.message;

    if (!message) {
      throw new Error("The model service returned no message");
    }

    return {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a shopping assistant agent. You help users find products through the MCP tools.",
  "",
  "How to work:",
  "1. Start with search_products to find what the user wants.",
  "2. Use compare_offers to see how the offers differ in condition, shipping and item location.",
  "3. Pick the 1-3 best offers yourself and say why.",
  "4. Use record_recommendation to record the recommendation (scenario uses the default, query is the user's original question).",
  "   - Every item needs productId, offerId and position (starting at 1, no duplicates); reason is optional.",
  "5. Use record_impression to report one impression per recommended item",
  "   (eventKey is a random UUID, impressedAt is the current ISO timestamp).",
  "6. Use create_purchase_link to create a purchase link for every recommended offer",
  "   (pass offerId and the matching recommendationItemId).",
  "",
  "Rules:",
  "- condition is a stable vocabulary: new / used / refurbished / open_box, and null means unknown.",
  "  When the user explicitly wants a brand-new item, only condition === \"new\" qualifies.",
  "- price is a string; prices in different currencies cannot be compared directly.",
  "- When a tool fails, read the error code, change the arguments and retry. Never invent a product.",
  "- Answer in the user's language.",
  "",
  "If record_impression or create_purchase_link fails, do not abandon the whole flow —",
  "finish what you can and say at the end which step did not succeed.",
].join("\n");

/**
 * One tool definition.
 *
 * `inputSchema` is the **server's** argument schema — it is part of the contract.
 */
interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Local parameter notes, used only to add the descriptions the server schema
 * leaves out.
 *
 * The server schema is authoritative (parameter names, required fields and
 * ranges all live there), but it does not say what a parameter is *for*; this
 * local copy fills that in so the model knows what to pass.
 */
const LOCAL_PARAM_HINTS: Record<string, Record<string, unknown>> = {
  search_products: {
    type: "object",
    properties: {
      q: { type: "string", description: "Search keyword" },
      limit: { type: "number", description: "How many results to return, 1-50" },
    },
    required: ["q"],
  },
  compare_offers: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Product id, from search_products" },
    },
    required: ["productId"],
  },
  record_recommendation: {
    type: "object",
    properties: {
      scenario: { type: "string" },
      query: { type: "string" },
      sessionKey: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productId: { type: "string" },
            offerId: { type: "string" },
            position: { type: "number" },
            reason: { type: "string" },
          },
          required: ["productId", "offerId", "position"],
        },
      },
    },
    required: ["scenario", "query", "items"],
  },
  record_impression: {
    type: "object",
    properties: {
      recommendationItemId: { type: "string" },
      eventKey: { type: "string", description: "Idempotency key, a UUID" },
      impressedAt: { type: "string", description: "ISO 8601, with a timezone offset" },
    },
    required: ["recommendationItemId", "eventKey", "impressedAt"],
  },
  create_purchase_link: {
    type: "object",
    properties: {
      offerId: { type: "string" },
      recommendationItemId: { type: "string" },
      sessionId: { type: "string" },
    },
    required: ["offerId"],
  },
};

function buildTools(listed: ListedTool[]): ToolDefinition[] {
  return listed
    .filter((tool) => tool.inputSchema || LOCAL_PARAM_HINTS[tool.name])
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: mergeSchemas(tool.inputSchema, LOCAL_PARAM_HINTS[tool.name]),
      },
    }));
}

/**
 * Use the **server's** schema as the base and merge the local notes into it.
 *
 * The order matters: the contract belongs to the server, the local copy only
 * adds descriptions the server did not write. When the server renames a
 * parameter or changes what is required, this follows automatically — the
 * demo never calls the service with a stale definition.
 */
function mergeSchemas(
  serverSchema: unknown,
  localHints: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const server = (serverSchema ?? null) as Record<string, any> | null;

  if (!server) return localHints ?? {};
  if (!localHints) return server;

  const properties = { ...(server.properties ?? {}) };
  const localProperties = (localHints.properties ?? {}) as Record<string, any>;

  for (const [key, hint] of Object.entries(localProperties)) {
    const target = properties[key];

    if (target && !target.description && hint?.description) {
      properties[key] = { ...target, description: hint.description };
    }
  }

  return { ...server, properties };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 8;

async function main(): Promise<void> {
  const config = loadConfig();
  const { query } = parseArgs(process.argv.slice(2));

  const mcp = new McpShoppingClient(config);
  await mcp.connect();

  const listed = await mcp.listTools();
  console.log(
    "Connected to " + config.mcpUrl + ", available tools: " +
      listed.map((tool) => tool.name).join(", "),
  );
  console.log("User question: " + query + "\n");

  const llm = new LlmClient(config);
  const tools = buildTools(listed as ListedTool[]);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: query },
  ];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const reply = await llm.chat(messages, tools);

    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      console.log("\n=== The agent's final answer ===");
      console.log(reply.content ?? "(empty)");
      return;
    }

    messages.push(reply);

    for (const call of reply.tool_calls) {
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }

      // Backstop: the model occasionally omits these required fields.
      if (call.function.name === "record_recommendation") {
        args.scenario = args.scenario ?? config.scenario;
        args.query = args.query ?? query;
      }

      if (call.function.name === "record_impression") {
        args.eventKey = args.eventKey ?? randomUUID();
        args.impressedAt = args.impressedAt ?? new Date().toISOString();
      }

      console.log("[round " + round + "] calling " + call.function.name);

      const outcome = await mcp.call(call.function.name, args);

      if (outcome.ok) {
        const text = JSON.stringify(outcome.data);
        console.log("  ok: " + text.slice(0, 300));
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      } else {
        console.log("  failed: " + outcome.error);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: outcome.error }),
        });
      }
    }
  }

  console.log(
    "\nReached the maximum number of rounds (" + MAX_ROUNDS +
      ") without wrapping up. That usually means the model is retrying the same failure.",
  );
}

main().catch((error: unknown) => {
  console.error("Run failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
