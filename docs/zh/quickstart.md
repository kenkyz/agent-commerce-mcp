# MCP Quick Start

面向**第一次接入本服务 MCP 入口**的开发者。目标：15 分钟内完成一次成功的工具调用。

- 完整契约（工具清单、错误码、兼容性承诺）：[`docs/api/mcp.md`](../contract.md)
- 同一套能力的 REST 契约：[`docs/api/agent-trial.md`](https://commerce.bitfund.ltd/docs/api/agent-trial)
- 调不通时看：[`troubleshooting.md`](./troubleshooting.md)

---

## 0. 你需要准备什么

| | |
|---|---|
| 一把 API Key | 向服务方索取，形如 `ac_trial_xxxxxxxx`。**明文只给一次**，本服务不提供找回 |
| 一个 MCP 客户端 | Claude Desktop、Cursor，或你自己的 Agent（下面给代码） |
| Node.js 20+ | 只有写代码那一节需要 |

> **服务地址**：试用环境 `https://staging.bitfund.ltd/mcp`，
> 正式环境 `https://commerce.bitfund.ltd/mcp`。
> 向服务方索取 Key 时会一并告知用哪个地址——**两个环境的 Key 不通用**。

---

## 1. 三十秒确认服务活着

不需要凭据，直接打：

```bash
curl https://staging.bitfund.ltd/health
```

期望：

```json
{ "status": "ok", "service": "agent-commerce-api" }
```

看到 `{"status":"ok"}` 就说明网络通、服务在跑。继续下一步。

---

## 2. 列出可用工具

```bash
curl -X POST https://staging.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`tools/list` 里应该有这 6 个工具（**名字是契约**，调用时用它）：

```
search_products
compare_offers
create_purchase_link
record_recommendation
record_impression
recommendation_analytics
```

每个工具还带一个给人看的 `title` 与 `description`——它们跟着 `Accept-Language` 走
（默认英文），不在上面的名字里。

**两个头都不能少**：`Content-Type` 和 `Accept`。少 `Accept` 会被拒成 `406`。
`Accept` 里必须同时有 `application/json` 和 `text/event-stream`——这是 MCP 规范要求，
不是本服务的怪癖。

**工具清单按这把 Key 的权限过滤**：缺 scope 的工具根本不会出现在 `tools/list` 里。
试用 Key 默认有 `catalog:read` + `recommendations:write`，所以你只会看到 5 个
（`recommendation_analytics` 需要另外申请 `analytics:read`）。

> **工具名是契约，描述跟着请求语言走。** 每个工具都有机器可读的 `name`（调用时用它），
> 以及给人看的 `title` 与 `description`。服务端按 `Accept-Language` 选语言，
> **默认英文**；带 `Accept-Language: zh` 就能拿到中文。
> `name`、参数字段、错误码在任何语言下都完全一样。

---

## 3. 第一次搜索

```bash
curl -X POST https://staging.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_products","arguments":{"q":"iphone","limit":3}}}'
```

返回里 `result.structuredContent.products` 是商品列表，每个商品带 `offers[]`：

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

### 读结果时最容易踩的四个坑

1. **`price` 是字符串**，定点小数（主单位、两位）。不要用浮点解析，
   也不要用它跨币种比大小——`currency` 不同的两个价格**不可直接比较**。
2. **`condition` 是稳定词表**：`new` / `used` / `refurbished` / `open_box`，
   取不到时是 `null`。**`null` 表示"不知道"，不是"全新"**——
   想推全新机，要判断 `condition === "new"`，而不是 `condition !== "used"`。
3. **`availability` 是上游原值的小写形式**（如 `in_stock`、`out_of_stock`），
   不做语义改写。上游出现新值时小写原值仍然可读。
4. **`condition` / `shippingOptions` / `itemLocation` 是报价（listing）级的**，
   不是商品级。同一件商品可能一个卖家全新一个二手、一个包邮一个不包邮。
   不看这三个字段，比出来的价格可能根本不是同一个东西。

> **`clickUrl` 是绝对地址**，可直接交给用户点击。点击会写归因记录，
> 并 302 跳到真实商品页。

---

## 4. 接入 MCP 客户端

### Claude Desktop / Cursor

在 MCP 服务端配置里加一段：

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

> **必须显式配 `x-api-key`（或 `Authorization: Bearer`）。**
> 第三方 MCP 客户端默认假设服务要走 OAuth：不配凭据时它会报
> `auth_required`（"Interactive OAuth requires a TTY"），
> 而不是直接连接。本服务用静态 API Key，不会发 `WWW-Authenticate`，
> 客户端不会自己发现该带什么。

### 自己写 Agent（官方 SDK）

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

传输层的协议协商、`Accept` 头、协议版本都由 SDK 处理，你不用管。

### 不想装 SDK：用 Inspector 手测

```bash
npx @modelcontextprotocol/inspector --cli https://staging.bitfund.ltd/mcp \
  --method tools/call --tool-name search_products \
  --tool-arg q=iphone --tool-arg limit=3 \
  --header "x-api-key: $YOUR_API_KEY"
```

---

## 5. 跑通一条完整购物链路

这 6 步就是一次完整的"搜索 → 推荐 → 曝光 → 购买跳转"。
完整可运行的脚本见 [`examples/shopping-agent/`](../../examples/shopping-agent/)。

### 跑起来

脚本需要把服务地址和 Key 放进环境变量；Agent 本身还需要一个模型服务
（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，任何 OpenAI 兼容的端点都行，
详见示例的 README）。

**macOS / Linux**

```bash
export MCP_URL="https://staging.bitfund.ltd"
export MCP_API_KEY="ac_trial_xxxxxxxx"
npx tsx examples/shopping-agent/index.ts --query "wireless headphones under 200"
```

**Windows（PowerShell）**

```powershell
$env:MCP_URL = "https://staging.bitfund.ltd"
$env:MCP_API_KEY = "ac_trial_xxxxxxxx"
npx tsx examples/shopping-agent/index.ts --query "wireless headphones under 200"
```

| 步骤 | 工具 | 关键点 |
|---|---|---|
| 1 | `search_products` | 拿到 `product.id` 和 `offer.id` |
| 2 | `compare_offers` | 按 `productId` 比价，看清各报价的成色/运费差异 |
| 3 | `record_recommendation` | 返回的 `items[].id` 是后续曝光与点击归属的**唯一凭据** |
| 4 | `record_impression` | `eventKey` 是幂等键，**必须是 UUID**，重试必须复用同一个值 |
| 5 | `create_purchase_link` | 传 `offerId` + `recommendationItemId`，得到带归因的绝对 URL |
| 6 | 打开该 URL | 302 跳到商品页，**这一步才写点击记录** |

### 第 3 步的返回值得多看一眼

```json
{
  "recommendationId": "3f2b6c14-...",
  "itemCount": 2,
  "items": [
    { "id": "8c1d2e3f-...", "productId": "prod_...", "offerId": "offer_...", "position": 1 }
  ]
}
```

**每条 item 的 `id` 都要留着**：只拿到 `recommendationId` 是没法回答
"用户点的是推荐列表里的第几条"的。曝光和点击都挂在 item id 上。

---

## 6. 完整链路的最小脚本

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
  if (r.isError) throw new Error(`${name} 失败: ${JSON.stringify(r.structuredContent)}`);
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
  // eventKey 必须是 UUID：幂等键，同一次曝光的重试复用同一个值
  eventKey: randomUUID(),
  impressedAt: new Date().toISOString(),
});

const link = await call("create_purchase_link", { offerId: offer.id, recommendationItemId });
console.log("购买链接：", link.url);

await client.close();
```

---

## 7. 我们会记录什么

**这条要说在前面**，因为你可能要把用户输入转进来。

| 记什么 | 存在哪 | 说明 |
|---|---|---|
| **你传给 `record_recommendation` 的 `query` 原文** | `recommendation_sessions.query` | 用于回溯"这次推荐是回答了哪个问题" |
| `scenario`、`sessionKey`、条目 id、成色价格快照 | 同表及关联表 | 归因与效果分析用 |
| 调用时间、工具名、状态码、耗时、来源 IP、User-Agent | `api_request_logs` | **不含请求体和响应体** |

- `query` 字段是**必填**，没有"不记录"的开关。
  请**不要把用户真实身份信息、地址、电话等敏感内容拼进 `query`**——
  它会原样入库，且**没有自助删除入口**（需要删除时由服务方按约定执行
  `db:cleanup:client`，见 [`developer-onboarding.md`](https://commerce.bitfund.ltd/docs/mcp/developer-onboarding)）。
- 建议做法：传**用户问题本身**（例如"想买个 3000 以内的 iPhone"），
  而不是传整段对话。
- 调用日志默认保留 30 天；推荐记录按业务数据保留。
  详见 [`docs/api/agent-trial.md` §5](https://commerce.bitfund.ltd/docs/api/agent-trial#5-请求日志)。
- 服务方可以在不影响你接入的前提下，按约定清理指定接入方的推荐记录
  （工具：`db:cleanup:client`，按接入方精确删；见
  [`developer-onboarding.md`](https://commerce.bitfund.ltd/docs/mcp/developer-onboarding)）。

---

## 8. 限流

- 每把 Key 每分钟 **120 次**（可单独调整）。
- 窗口按数据库时钟对齐到整分钟。
- 响应头带 `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset`；
  超限返回 `429` + `retry-after`。
- **一次完整链路（稳态）是 6 次请求**：5 次工具调用 + 1 次点击跳转。
  做批量任务请按这个口径设计。**首次接入那一轮是 8 次**（多一次握手与一次 `tools/list`）。

---

## 9. 下一步

- 调不通 → [`troubleshooting.md`](./troubleshooting.md)
- 要完整契约 → [`docs/api/mcp.md`](../contract.md)
- 要可运行的完整 Agent → [`examples/shopping-agent/`](../../examples/shopping-agent/)
