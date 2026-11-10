/**
 * One MCP tool call — the shape an agent actually uses.
 *
 * The full-flow examples hardcode every step, which proves the service works.
 * This one sends exactly ONE tool call; what to call and what to pass is
 * decided by the caller — a human, or a model reading the previous result.
 * That is the shape a real agent integration has.
 *
 * Usage:
 *   npx tsx examples/agent-step/index.ts \
 *     --tool search_products --args '{"q":"iphone","limit":5}'
 *
 * The key comes from --api-key, or from MCP_API_KEY in the environment.
 * It uses the official MCP SDK client — the same client code an external
 * integration would use.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface Args {
  base: string;
  apiKey: string | null;
  tool: string | null;
  args: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const index = argv.indexOf("--" + name);
    if (index < 0) return null;
    const value = argv[index + 1];
    return value && !value.startsWith("--") ? value : null;
  };

  return {
    base: (get("base") ?? process.env.MCP_URL ?? "https://commerce.bitfund.ltd").replace(
      /\/+$/,
      "",
    ),
    apiKey: get("api-key") ?? process.env.MCP_API_KEY ?? null,
    tool: get("tool"),
    args: get("args"),
  };
}

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  if (!args.apiKey || !args.tool) {
    console.error("Usage: --api-key <key> --tool <tool name> --args '<JSON>'");
    process.exitCode = 2;
    return;
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(args.base + "/mcp"),
    {
      requestInit: {
        headers: {
          "x-api-key": args.apiKey,
          "user-agent": "agent-commerce-example/1",
        },
      },
    },
  );

  const client = new Client(
    { name: "agent-commerce-agent-step", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const toolArgs = args.args ? JSON.parse(args.args) : {};

  const result: any = await client.callTool({
    name: args.tool,
    arguments: toolArgs,
  });

  const payload = result?.structuredContent ?? null;

  console.log(
    JSON.stringify(
      {
        tool: args.tool,
        isError: result?.isError === true,
        structuredContent: payload,
      },
      null,
      2,
    ),
  );

  await client.close();
}

main().catch((error: unknown) => {
  console.error("Call failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
