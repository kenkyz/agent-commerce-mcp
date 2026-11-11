# MCP 服务契约

> **契约版本：** 2026-11-10 · **状态：** Developer Preview
>
> 只有破坏性变更才升版本。报障时带上它，我们就知道你对接的是哪一版契约。

本文件描述**面向外部 AI Agent 开放的 MCP 入口**：接入地址、传输方式、鉴权、
权限、工具清单、限流、日志与兼容性承诺。

MCP（Model Context Protocol）是给 AI Agent 用的工具协议。与 REST 的区别只是
"怎么问"：REST 是 Agent 自己拼 HTTP 请求，MCP 是 Agent 通过 MCP 客户端
（Claude Desktop、Cursor、自建 Agent 框架等）发现并调用工具。

**底层数据、权限模型、限流口径与 REST 那套完全同源**——同一个商品、
同一条推荐、同一次点击归因，从哪个入口拿到的都是同一份数据。

---

## 1. 这套入口和 REST 试用接口的关系

| | REST 试用接口 | MCP 入口 |
|---|---|---|
| 路径 | `/v1/agent/*` | `/mcp` |
| 协议 | HTTP + JSON | MCP over Streamable HTTP |
| 鉴权 | API Key（`x-api-key`）+ scope | **同一把 API Key**，同一个 scope 体系 |
| 能力 | 商品搜索、记录推荐、曝光、统计 | **同一批能力**，只是换成工具形态 |
| 兼容承诺 | 有 | **有**，见 §8 |

两者的关系是"同一个后端的两种问法"，不是两套实现：

- 服务端同一批模块函数；
- 同一把 API Key、同一套 scope、同一份库内限流计数；
- 同一张 `api_request_logs` 表。

**外部接入方可以只挑一种用。** 已经有 REST 集成的接入方不需要改；
想接 MCP 客户端的接入方申请同一把 Key 即可，不用换 Key、不用重新申请权限。

> 仓库里刻意**没有**引入 `mcp:*` 这类新 scope。权限粒度对着**能力**，
> 不对着协议——MCP 和 REST 暴露的能力完全同构，拆成两套 scope 只会让
> 已签发的 Key 全部失效，试用阶段还得挨个重发。

## 2. 接入地址与传输

```
POST https://staging.bitfund.ltd/mcp
```

传输方式是 **MCP Streamable HTTP**，本服务的具体取舍：

- **无状态**：服务端不签发 session id。每个请求自成一个世界，
  不存在"会话过期"这种接入方要处理的东西，部署多副本也不会掉会话。
- **JSON 响应**：一次请求回一个 JSON-RPC 响应（`application/json`），
  不走 SSE 事件流。本服务的工具调用都是"问一句答一句"，
  没有需要流式推送的长任务。
- **只接受 POST**：`GET /mcp` 与 `DELETE /mcp` 返回 `405`。
  这是 MCP 规范明确允许的行为，表示服务端不支持服务端主动推送。
- **必须带两个 Accept 类型**：`Accept: application/json, text/event-stream`。
  规范要求两个都写，少一个会被服务端以 `406` 拒掉。

请求体是标准的 JSON-RPC 2.0 消息：

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
x-api-key: ac_trial_xxxxxxxx

{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

### 2.1 客户端配置示例

Claude Desktop / Cursor 这类客户端的配置大致长这样：

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

## 3. 鉴权

### 3.1 凭据

两种写法都认，取值相同、权限完全一致：

```
x-api-key: ac_trial_xxxxxxxx
```

```
Authorization: Bearer ac_trial_xxxxxxxx
```

多认 `Bearer` 是因为 MCP 客户端的配置格式几乎清一色是 `headers` 或
`Authorization`，不少根本不会去设置私有的 `x-api-key` 头。

另外，`x-import-token`（管理员令牌）也能连上——那是运维后门，
拥有全部 scope，不计入对外发放的配额体系。

**优先级：`x-api-key` → `Authorization: Bearer` → 管理员令牌。**
带了凭据就不再往回退：一把无效的 Key 静默降级成管理员权限，等于认证形同虚设。

Key 的签发方式、只返回一次明文、库里只存哈希——与 REST 那套完全相同，
见 [`agent-trial.md`](https://commerce.bitfund.ltd/docs/api/agent-trial) §2.1。

### 3.2 鉴权失败怎么表现

认证失败发生在 HTTP 层，返回的是普通 HTTP 错误（不是 JSON-RPC 错误）：

| 情况 | 状态码 | `error` |
|---|---|---|
| 没有提供任何凭据 | 401 | `UNAUTHORIZED` |
| Key 不存在或不匹配 | 401 | `API_KEY_INVALID` |
| Key 已被吊销 | 401 | `API_KEY_REVOKED` |
| Key 已过期 | 401 | `API_KEY_EXPIRED` |
| Key 所属接入方已暂停 | 403 | `API_CLIENT_SUSPENDED` |
| 超出每分钟额度 | 429 | `RATE_LIMIT_EXCEEDED` |

吊销与过期**立刻生效**：每次调用都读库里的状态，不依赖任何缓存。

## 4. 权限（scope）

沿用 REST 那三个 scope，含义完全一致：

| scope | 覆盖的工具 |
|---|---|
| `catalog:read` | `search_products`、`compare_offers`、`create_purchase_link` |
| `recommendations:write` | `record_recommendation`、`record_impression` |
| `analytics:read` | `recommendation_analytics` |

**工具清单按这把 Key 的权限过滤**：缺 scope 的工具**根本不会出现在
`tools/list` 里**，调用它会得到"没有这个工具"的失败结果。

这么设计是有意的：试用阶段默认发放 `catalog:read` + `recommendations:write`，
`analytics:read` 不默认发。而"效果统计"恰恰是 Agent 最想调的那个工具——
让它一上来就撞一次权限墙，浪费的是最容易流失的第一印象。

想要更多能力就去申请对应 scope；缺哪个，申请单里写哪个。

`initialize` 的响应里带一份**按当前权限生成**的 `instructions`，
里面写清楚这把凭据现在能用哪些工具、哪些工具缺哪个 scope。
Agent 读完就知道该去申请什么，不用靠猜。

## 5. 工具清单

所有工具的**返回结构**都放在 `structuredContent` 里，同时在 `content`
里给一份同样内容的 JSON 文本——两种读法都支持。

工具入参**拒绝未知字段**：拼错的字段名会被明确拒绝，而不是被静默忽略。

> **工具 `name` 是契约，`title` 与 `description` 跟着请求语言走。**
> 服务端读 `Accept-Language`，**默认英文**；带 `Accept-Language: zh` 拿到中文。
> `initialize` 的 instructions 同样如此。`name`、入参字段、返回字段、错误码
> 在任何语言下都一模一样，变的只有说明文字。

### 5.1 `search_products`

按关键词搜索标准化商品，返回每个商品的全部跨来源报价。

| 参数 | 类型 | 说明 |
|---|---|---|
| `q` | string | 必填，1–100 字符 |
| `limit` | number | 可选，1–50，默认 10 |

返回 `products[]`（每个含 `id`、`title`、`brand`、`category`、`gtin`、
`offers[]`）与 `meta`。

`offers[]` 含 `id`、`source`、`price`、`currency`、`availability`、
`condition`、`shippingOptions`、`itemLocation`、`productUrl`、`imageUrl`、
`affiliateUrl`、`fetchedAt`、`lastVerifiedAt`、`clickUrl`。

- `clickUrl` 是**绝对地址**，可直接交给用户点击。
- `affiliateUrl` 是来源侧的联盟推广链接——做佣金归因的接入方需要它；
  该报价没有联盟来源时为 `null`。
- `price` 是定点小数字符串（主单位、两位小数，如 `"799.00"`），
  **不同币种不可直接比较**。
- `availability` 存的是上游值的小写形式（如 `"in_stock"`），**不做语义
  改写**：上游出现新的状态值时，小写原值至少还是可读的，映射到自定的
  词表反而会把没见过的状态一并归进 `"unknown"`。
- `condition` 是**报价（listing）级**属性，不是商品级：同一个 eBay 商品，
  一个卖家全新、一个卖家二手，两条报价的 `condition` 可以不同。

  `condition` 是**归一化后的稳定词表**，只有四个值：

  | 值 | 含义 |
  |---|---|
  | `new` | 全新 |
  | `used` | 二手 |
  | `refurbished` | 翻新（各档位都归到这里） |
  | `open_box` | 开箱品 |

  取不到时是 `null`，**表示"不知道"，不是"全新"**——
  判断"要不要全新机"要写 `condition === "new"`，
  而不是 `condition !== "used"`。

  上游的自由文本（"Good - Refurbished"、"Excellent - Refurbished" 等）**不会**
  原样出现在这个字段里，所以接入方不需要为上游措辞写判断。

- `availability` **只来自** eBay 的 `get_item`（明细）——
  搜索结果不带库存状态。取不到明细的报价，它的 `availability` 是 `"unknown"`，
  `condition` 是 `null`。
这不是数据缺失，是"这条 listing 的明细还没取过"：
目录里存在一批从未取过明细的 listing，它们只有价格、标题、链接。
补齐流程由服务方维护。

### 5.2 `compare_offers`

按商品 id 比价。

| 参数 | 类型 | 说明 |
|---|---|---|
| `productId` | string | 必填，来自 `search_products` 的结果 |

返回 `product`、`offers[]`（按 `(币种, 价格)` 升序）与 `comparison`。

`comparison` 含 `currencies[]` 与 `note`（口径提示，随请求语言变化）。

`comparison.currencies[]` 每项含 `currency`、`offerCount`、
`lowest`（`offerId`/`price`/`source`）、`highest`。

**不提供跨币种的最低价**——那需要汇率，本服务不提供汇率。
币种不同就没有"谁更便宜"的答案，给一个数字反而是在误导。

商品不存在时报 `PRODUCT_NOT_FOUND`。

### 5.3 `create_purchase_link`

为某个报价生成带归因的购买链接（绝对 URL）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `offerId` | string | 必填，来自搜索或比价结果 |
| `recommendationItemId` | string(uuid) | 可选，来自 `record_recommendation` |
| `sessionId` | string | 可选，上游会话标识 |

返回 `url`、`path`、`offerId`、`productId`、`productTitle`、`price`、
`currency`、`availability`、`condition` 与 `note`（口径提示，随请求语言变化）。

**这一步不写数据**：点击记录发生在用户真正点开链接时。
但它会先校验报价与推荐条目确实存在且彼此匹配——与其给用户发一条
注定 404 的链接，不如现在报错让 Agent 换一个报价。

可能的错误：`OFFER_NOT_FOUND`、`RECOMMENDATION_ITEM_NOT_FOUND`、
`RECOMMENDATION_ITEM_OFFER_MISMATCH`。

**推荐条目按接入方隔离**：带上的 `recommendationItemId` 必须属于**你的**接入方，
别人的条目 id 一律按"不存在"处理（`RECOMMENDATION_ITEM_NOT_FOUND`）。

### 5.4 `record_recommendation`

记录一次推荐。

| 参数 | 类型 | 说明 |
|---|---|---|
| `scenario` | string | 必填，推荐场景标识 |
| `query` | string | 必填，触发本次推荐的用户提问原文 |
| `sessionKey` | string | 可选，上游会话标识 |
| `metadata` | object | 可选，非敏感扩展信息 |
| `items` | array | 必填，1–50 条 |

每个 item 含 `productId`、`offerId`、`position`，可选 `reason`、`snapshot`。
`position` 必须唯一。

返回 `recommendationId`、`itemCount`、`items[]`（每条带自己的 `id`）。

**那些 id 是后续曝光与点击归属的唯一凭据**：只拿到 `recommendationId`
是没法回答"用户点的是推荐列表里的第几条"。

### 5.5 `record_impression`

上报一条曝光。

| 参数 | 类型 | 说明 |
|---|---|---|
| `recommendationItemId` | string(uuid) | 必填，必须是**本接入方**已存在的推荐条目 id |
| `eventKey` | string(uuid) | 必填，幂等键 |
| `impressedAt` | string | 必填，ISO 8601，必须带时区偏移 |
| `metadata` | object | 可选 |

返回 `impressionId` 与 `inserted`。

- `inserted: true` = 这次真的写入了一条曝光。
- `inserted: false` = 同一次曝光的重试（`eventKey` 与内容都相同）。

同一个 `eventKey` 携带**不同**内容时报 `IMPRESSION_EVENT_KEY_CONFLICT`——
那是调用方把 key 用错了，不是重试。

**推荐条目按接入方隔离**：引用**别的接入方**的条目 id 时报
`RECOMMENDATION_ITEM_NOT_FOUND`（和"条目不存在"同一个答案），
不区分"存在但不是你的"。

### 5.6 `recommendation_analytics`

读取推荐效果统计。需要 `analytics:read`。

| 参数 | 类型 | 说明 |
|---|---|---|
| `from` | string | 必填，闭区间下界，ISO 8601 带时区偏移 |
| `to` | string | 必填，开区间上界，ISO 8601 带时区偏移 |
| `asOf` | string | 可选，观察时点，默认取数据库当前时刻 |
| `scenario` | string | 可选，按推荐场景过滤 |

返回 `period`、`funnel`、`dataQuality`、`commissions` 与 `meta`。

| 字段 | 含什么 |
|---|---|
| `period` | `from`/`to`/`asOf`、归因窗口天数、队列成熟状态与成熟时间 |
| `funnel` | `requests`、`requestsWithItems`、`items`、`impressions`、`clicks`、`conversions` |
| `dataQuality` | 曝光数据状态、缺成交时间的转化数、窗口外的归因转化数 |
| `commissions` | 按 `(network, currency, status)` 分组的佣金与销售额 |
| `meta` | `window`（`[from, to)` 口径）、`scenario`、`amountNote`、`maxQueryRangeDays` |

单次查询跨度上限 366 天。

**金额口径**：这里的金额是**最小货币单位**的十进制字符串，
按 `(network, currency, status)` 分组，**不存在跨币种合计字段**。
注意这与商品报价的 `price` 口径不同——商品价是主单位定点小数。

## 6. 错误处理

工具失败返回的是 **MCP 工具失败结果**（`isError: true`），
而不是 JSON-RPC 层的 error：

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "{\"error\":\"PRODUCT_NOT_FOUND\",...}" }],
  "structuredContent": { "error": "PRODUCT_NOT_FOUND", "message": "..." }
}
```

`structuredContent.error` 是**稳定错误码**，Agent 可以据此决定
是重试、换参数，还是去申请缺失的权限。

工具执行失败时 `structuredContent.error` 的取值：

| 错误码 | 含义 |
|---|---|
| `PRODUCT_NOT_FOUND` | 商品 id 在库中不存在 |
| `OFFER_NOT_FOUND` | 报价 id 在库中不存在 |
| `RECOMMENDATION_ITEM_NOT_FOUND` | 推荐条目不存在，或不属于你的接入方 |
| `RECOMMENDATION_ITEM_OFFER_MISMATCH` | 报价存在，但不属于声明的商品/条目 |
| `RECOMMENDATION_OFFER_NOT_FOUND` | 推荐条目引用的报价在库中不存在 |
| `RECOMMENDATION_CREATE_FAILED` | 记录推荐时发生未预期的内部错误 |
| `IMPRESSION_EVENT_KEY_CONFLICT` | 同一个 eventKey 携带了不同的内容 |
| `IMPRESSION_RECORD_FAILED` | 记录曝光时发生未预期的内部错误 |
| `RECOMMENDATION_ANALYTICS_FAILED` | 统计查询失败 |
| `TOOL_EXECUTION_FAILED` | 未预期的内部异常（原因只进服务端日志） |

`INVALID_RECOMMENDATION_REQUEST` 与 `INVALID_IMPRESSION_REQUEST` 是
**REST 那条路**的入参错误码。MCP 复用同一套 schema，但入参非法会被 SDK
在进工具之前拦下（见下文），走不到这两个码。

**参数不合法**（未知字段、类型不对、越界）由 SDK 在进工具之前拦下，
表现为 `isError: true` 的失败结果，消息里写明是哪个字段不合法。
这一层没有稳定错误码——它是协议层的校验，不是业务错误。

**工具不存在或未授权**（含缺 scope，见 §4）同样是协议层拦下的：
表现为 `isError: true`，文本形如 `MCP error -32602: Tool xxx not found`，
**没有 `structuredContent`**。要判断"该去申请哪个权限"，读 `initialize` 的
instructions——那里按这把凭据的权限逐条列出了缺哪个 scope。

## 7. 限流与调用日志

### 7.1 限流

限流计数存在数据库里，**与 REST 那套共用同一份额度**：同一把 Key
换条协议就拿到双倍配额，那等于限流形同虚设。

- 窗口：固定一分钟。
- 默认额度：每分钟 120 次（`AGENT_API_DEFAULT_RATE_LIMIT` 可调）。
- **按工具调用计**：一次请求里带几个 `tools/call` 就扣几次额度。
  JSON-RPC 批量（一次 HTTP 请求带一个数组）同样按条数扣——否则一次批量
  请求就能换到成倍的调用量。不含工具调用的请求（握手、`tools/list`）
  按 1 次计。
- 响应头：`x-ratelimit-limit`、`x-ratelimit-remaining`、`x-ratelimit-reset`、
  超限时附 `retry-after`。

### 7.2 调用日志

MCP 的调用日志**按工具调用记**，不按 HTTP 请求记：

| 字段 | MCP 下的取值 |
|---|---|
| `method` | `MCP` |
| `path` | `/mcp/tools/<工具名>`，如 `/mcp/tools/search_products` |
| `status_code` | 成功 200；失败按错误性质给 4xx/5xx |
| `error_code` | 失败时的稳定错误码，成功为 null |

认证失败、限流、以及**被协议层拦下的工具调用**（入参非法、工具不存在或
未授权），记在 `path = /mcp` 上，错误码分别是 `UNAUTHORIZED` /
`RATE_LIMIT_EXCEEDED` / `TOOL_CALL_REJECTED`。

为什么按工具记：MCP 的工具失败藏在 JSON-RPC 的 `isError` 里，
HTTP 状态码照样是 200。按 HTTP 请求统计会把这些失败**整个漏掉**，
而"哪个工具被调了多少次、失败率多少"恰恰是外部开发者试用阶段
最需要的那张表。

```sql
SELECT path, count(*), count(*) FILTER (WHERE status_code >= 400) AS failures
FROM api_request_logs
WHERE method = 'MCP'
GROUP BY path
ORDER BY count(*) DESC;
```

## 8. 兼容性承诺

和 REST 那套同一套原则：

- **破坏性变更才升版本**，纯新增工具、新增可选字段不升版本。
- **工具名与入参字段只增不改**。新增工具不影响既有接入方；
  既有工具新增**可选**字段也是兼容性变更。
- **稳定错误码不换名**。同一个失败原因不会换一个错误码。
- **工具入参拒绝未知字段**。
- **金额单位与分组口径不变**。
- **限流与鉴权语义不得放宽**：额度只调高不调低是允许的，
  反向收紧需要走版本升级。
- **底层数据口径不变**：MCP 返回的商品与报价与 REST 那套同源同义。

## 9. 怎么验证接入方真的能用

本仓库在 [`../../examples/`](../../examples/) 下放了三个可直接跑的客户端，
只需要你自己的 API Key，不需要管理员令牌：

| 示例 | 验什么 | 命令 |
|---|---|---|
| [`../../examples/sdk-client/`](../../examples/sdk-client/) | **官方 SDK 客户端**连上并跑完整条购物链路——外部接入方真正会写的那套客户端代码 | `npm run sdk-client` |
| [`../../examples/agent-step/`](../../examples/agent-step/) | **单次工具调用**，由调用方（Agent）决定传什么 | `npm run agent-step -- --tool search_products --args '{"q":"iphone","limit":3}'` |
| [`../../examples/shopping-agent/`](../../examples/shopping-agent/) | **完整 Agent**——调哪个工具、传什么参数由模型决定，整条链路自己跑完 | `npm run demo` |

Demo 里的模型提供商是配置项：任何 OpenAI 兼容的 `/chat/completions` 端点都行。

### 9.1 用 MCP Inspector 手测

```powershell
npx @modelcontextprotocol/inspector --cli https://staging.bitfund.ltd/mcp \
  --method tools/list --header "x-api-key: ac_trial_xxxxxxxx"

npx @modelcontextprotocol/inspector --cli https://staging.bitfund.ltd/mcp \
  --method tools/call --tool-name search_products \
  --tool-arg q=iphone --tool-arg limit=3 \
  --header "x-api-key: ac_trial_xxxxxxxx"
```

加 `--strict` 还能让 Inspector 检查工具 schema 的可移植性
（2026-11-04 实测：0 errors / 3 warnings，warning 都在
`metadata` / `snapshot` 这类自由对象上）。

> **第三方客户端默认会假设服务要走 OAuth。**
> Inspector 不带 header 时会报 `auth_required`（"Interactive OAuth requires a TTY"），
> 因为它先按 OAuth 服务处理。本服务用静态 API Key，
> **不会**在 401 响应里发 `WWW-Authenticate`——
> 所以接入方必须**显式**配 `x-api-key` 或 `Authorization: Bearer`，
> 别等客户端自己发现。

### 9.2 额度是按 Key 算的

默认每把 Key 每分钟 120 次，**按工具调用计**（见 §7.1）。
**一次完整链路（稳态）是 6 次请求**：5 次工具调用 + 1 次点击跳转，
跑批量任务要按这个口径设计；**首次接入那一轮是 8 次**
（多一次握手与一次 `tools/list`）。超限返回 `429` + `retry-after`。

注意：**点击跳转（`/go/...`）不消耗这把 Key 的额度**——它不走 MCP，
也不按 Key 计。上面把它算进 6 次，是为了让"一次链路"的说法前后一致；
真正扣额度的是那 5 次工具调用。

## 10. 已知边界

- **没有服务端主动推送**。`GET /mcp` 返回 `405`。本服务目前没有需要
  推送的通知；将来真需要（比如长任务的进度），再改传输层。
- **没有 Resources 与 Prompts**，只提供 Tools。
- **无状态**，所以不支持"跨请求的服务端会话状态"。需要连续上下文，
  由 Agent 自己维护。
- **不提供汇率**，所以比价不跨币种给结论（见 §5.2）。
- **管理员令牌能连上并拥有全部工具**——它是运维后门，不是对外发放的凭据。
