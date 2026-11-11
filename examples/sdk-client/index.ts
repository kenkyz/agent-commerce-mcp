/**
 * The official MCP SDK client running the whole shopping flow.
 *
 * Why this file exists: a hand-written JSON-RPC client proves the service
 * matches our understanding. This one uses the **same client code an external
 * integration would actually use** — the official SDK — and proves that
 * following the docs gets you a working connection.
 *
 * The two cannot replace each other: a protocol that passes a hand-written
 * client can still fail the SDK client (Accept headers, session handling,
 * protocol version negotiation).
 *
 * Usage:
 *   npx tsx examples/sdk-client/index.ts --base https://staging.bitfund.ltd
 *
 * The key comes from --api-key, or from MCP_API_KEY in the environment.
 * This example only ever uses YOUR key — it never issues or revokes one.
 */

import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface Args {
  base: string;
  apiKey: string | null;
  query: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const index = argv.indexOf("--" + name);
    if (index < 0) return null;
    const value = argv[index + 1];
    return value && !value.startsWith("--") ? value : null;
  };

  return {
    base: (get("base") ?? process.env.MCP_URL ?? "https://staging.bitfund.ltd").replace(
      /\/+$/,
      "",
    ),
    apiKey: get("api-key") ?? process.env.MCP_API_KEY ?? null,
    query: get("query") ?? "iphone",
    limit: Number(get("limit") ?? "5"),
  };
}

const args = parseArgs(process.argv.slice(2));

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}

/** Read the structured payload out of a CallToolResult. */
function structured(result: any): any {
  return result?.structuredContent ?? null;
}

async function main(): Promise<void> {
  console.log("Official SDK client check: " + args.base);

  if (!args.apiKey) {
    console.error(
      "  no API key — pass --api-key <key> or set MCP_API_KEY in the environment",
    );
    process.exitCode = 2;
    return;
  }

  // The transport layer handles protocol negotiation and the Accept headers.
  const transport = new StreamableHTTPClientTransport(new URL(args.base + "/mcp"), {
    requestInit: {
      headers: {
        "x-api-key": args.apiKey,
        "user-agent": "agent-commerce-example/1",
      },
    },
  });

  const client = new Client(
    { name: "agent-commerce-sdk-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  check("handshake succeeded", true, "server=" + (client.getServerVersion()?.name ?? "?"));

  const instructions = client.getInstructions();

  check(
    "handshake returns instructions generated for these permissions",
    typeof instructions === "string" && instructions.length > 0,
    instructions ? instructions.slice(0, 80) : "",
  );

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);

  // The tool list is filtered by the key's scopes: a key without
  // analytics:read never sees recommendation_analytics at all.
  const REQUIRED = [
    "search_products",
    "compare_offers",
    "create_purchase_link",
    "record_recommendation",
    "record_impression",
  ];

  const missing = REQUIRED.filter((name) => !toolNames.includes(name));

  check("every tool this flow needs is available", missing.length === 0, toolNames.join(", "));

  const searchTool = listed.tools.find((tool) => tool.name === "search_products");

  check(
    "tools carry an inputSchema (the SDK validates arguments against it)",
    Boolean(searchTool?.inputSchema),
    searchTool?.inputSchema
      ? "required=" + JSON.stringify((searchTool.inputSchema as any).required ?? [])
      : "",
  );

  // --- search ---
  const searched: any = await client.callTool({
    name: "search_products",
    arguments: { q: args.query, limit: args.limit },
  });

  const products = structured(searched)?.products ?? [];

  check("search returned products", products.length > 0, products.length + " found");

  const product = products[0];
  const offer = product?.offers?.[0];

  if (!product || !offer) {
    console.log("  no product/offer available — skipping the rest of the flow");
    await client.close();
    return;
  }

  check(
    "offers carry an absolute clickUrl",
    /^https?:\/\//.test(offer.clickUrl ?? ""),
    offer.clickUrl ?? "",
  );

  check(
    "offers carry price, currency and source",
    typeof offer.price === "string" &&
      typeof offer.currency === "string" &&
      typeof offer.source === "string",
    offer.price + " " + offer.currency + " @ " + offer.source,
  );

  // --- compare ---
  const compared: any = await client.callTool({
    name: "compare_offers",
    arguments: { productId: product.id },
  });

  const currencies = structured(compared)?.comparison?.currencies ?? [];

  check(
    "comparison is grouped by currency",
    currencies.length > 0,
    currencies
      .map(
        (group: any) =>
          group.currency + ": " + group.offerCount + " offers, lowest " + group.lowest?.price,
      )
      .join("; "),
  );

  // --- record the recommendation ---
  const scenario = "agent_mcp_example_" + Date.now();

  const recorded: any = await client.callTool({
    name: "record_recommendation",
    arguments: {
      scenario,
      query: args.query,
      items: [{ productId: product.id, offerId: offer.id, position: 1 }],
    },
  });

  const recommendationItemId = structured(recorded)?.items?.[0]?.id ?? null;

  check(
    "recommendation recorded, item id returned",
    Boolean(recommendationItemId),
    recommendationItemId ?? "",
  );

  // --- impression ---
  const impressed: any = await client.callTool({
    name: "record_impression",
    arguments: {
      recommendationItemId,
      // eventKey is the idempotency key and must be a UUID.
      eventKey: randomUUID(),
      impressedAt: new Date().toISOString(),
    },
  });

  check(
    "impression recorded",
    structured(impressed)?.inserted === true,
    "impressionId=" + structured(impressed)?.impressionId,
  );

  // --- purchase link ---
  const linked: any = await client.callTool({
    name: "create_purchase_link",
    arguments: { offerId: offer.id, recommendationItemId },
  });

  const url = structured(linked)?.url ?? "";

  check("absolute purchase link returned", /^https?:\/\//.test(url), url);

  check("purchase link points at the service redirect", url.includes("/go/"), url);

  // --- open the link: THIS is what writes the click ---
  const sessionId = "agent-mcp-example-" + Date.now();

  // Query parameters must be joined with "&": the purchase link already
  // carries "?recommendation_item_id=", so adding another "?" would glue the
  // uuid and the next parameter together and the server would reject it.
  const separator = url.includes("?") ? "&" : "?";

  const clicked = await fetch(
    url + separator + "session_id=" + encodeURIComponent(sessionId),
    { redirect: "manual", headers: { "user-agent": "agent-commerce-example/1" } },
  );

  check(
    "opening the link returns 302 to the product page",
    clicked.status === 302,
    "status=" + clicked.status +
      " location=" + (clicked.headers.get("location") ?? "").slice(0, 90),
  );

  // --- analytics (needs the analytics:read scope) ---
  if (toolNames.includes("recommendation_analytics")) {
    const now = new Date();

    const analytics: any = await client.callTool({
      name: "recommendation_analytics",
      arguments: {
        from: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
        to: new Date(now.getTime() + 60 * 1000).toISOString(),
      },
    });

    const funnel = structured(analytics)?.funnel ?? {};

    check(
      "the click shows up in the stats",
      Number(funnel.clicks ?? 0) > 0,
      "requests=" + funnel.requests +
        " items=" + funnel.items +
        " impressions=" + funnel.impressions +
        " clicks=" + funnel.clicks,
    );
  } else {
    console.log("  SKIP  analytics check — this key has no analytics:read scope");
  }

  await client.close();
}

main()
  .catch((error: unknown) => {
    console.error("The example aborted:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = checks.filter((item) => !item.ok);

    console.log("");
    console.log(
      "=== summary ===  " +
        checks.length +
        " checks: " +
        (checks.length - failed.length) +
        " PASS, " +
        failed.length +
        " FAIL",
    );

    for (const item of failed) console.log("  FAIL  " + item.name + " — " + item.detail);

    if (failed.length > 0) process.exitCode = 1;
  });
