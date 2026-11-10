# MCP 排查手册

按**症状**组织：找到你看到的那个，直接跳到对应小节。

- 接入步骤见 [`quickstart.md`](./quickstart.md)
- 完整契约（工具、错误码）见 [`docs/api/mcp.md`](../contract.md)

---

## 先做这一步：拿到 requestId

本服务给每个请求下发 `x-request-id` 响应头。**报障时把这个值给服务方**，
对方能直接定位到那一次调用的日志，比"昨天有次失败"有用得多。

```bash
curl -i -X POST https://staging.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 一、连不上 / 握手失败

### `405 Method Not Allowed`

你用了 `GET` 或 `DELETE`。**本服务只接受 `POST`**。

`GET` 返回 405 是 MCP 规范明确允许的行为，表示服务端不支持服务端主动推送。

### `406 Not Acceptable`

`Accept` 头少了东西。必须**两个都写**：

```
Accept: application/json, text/event-stream
```

少一个就被拒。这不是本服务的怪癖，是 MCP 规范的要求。

### `auth_required` / "Interactive OAuth requires a TTY"

**第三方 MCP 客户端默认假设服务要走 OAuth。** 客户端先按 OAuth 服务处理，
发现没有 OAuth 流程可走就报这个错——它还没真正连上你的服务。

解法：**显式配静态凭据**，别等客户端自己发现。

```json
{
  "mcpServers": {
    "agent-commerce": {
      "url": "https://staging.bitfund.ltd/mcp",
      "headers": { "x-api-key": "ac_trial_xxxxxxxx" }
    }
  }
}
```

Claude Desktop / Cursor 也可以用 `Authorization: Bearer <key>`——两种写法都认，取值相同。

> 本服务用静态 API Key，**不会**在 401 响应里发 `WWW-Authenticate`，
> 所以客户端没有任何线索能自己猜出该带什么头。必须你配。

### `Connection refused` / 超时

- **打错环境了**：试用是 `staging.bitfund.ltd`，正式是 `commerce.bitfund.ltd`。
- **Key 用错环境**：两个环境的 Key **不通用**。向服务方确认这把 Key 属于哪个环境。
- 先用 `curl <base>/health` 确认网络通不通——它不需要凭据。

---

## 二、认证问题（401 / 403）

| 状态码 | `error` | 原因 |
|---|---|---|
| 401 | `UNAUTHORIZED` | 完全没带凭据 |
| 401 | `API_KEY_INVALID` | Key 不存在或不匹配 |
| 401 | `API_KEY_REVOKED` | Key 已被吊销 |
| 401 | `API_KEY_EXPIRED` | Key 已过期 |
| 403 | `API_CLIENT_SUSPENDED` | Key 所属接入方账号被暂停 |
| 403 | `INSUFFICIENT_SCOPE` | 凭据有效，但缺这个工具需要的 scope |

### "Key 明明是对的，怎么 401"

按顺序查这三件事：

1. **Key 有没有被截断。** 复制时少复制几个字符是常见情况，
   而且**服务端只会说"凭据无效"，不会说"你的值被截了"**。
   比对长度比怀疑令牌本身更快。
2. **环境对不对。** staging 的 Key 打 production 会 401，反之亦然。
3. **带的是不是两个头里正确的那一个。** `x-api-key` 和
   `Authorization: Bearer` 都认，但**带了凭据就不再往回退**——
   一把无效的 Key 不会静默降级成管理员权限。

### `INSUFFICIENT_SCOPE` 但工具名看着在那儿

**工具清单按这把 Key 的权限过滤**：缺 scope 的工具**根本不会出现在 `tools/list` 里**。
所以如果你在 `tools/list` 里看到了某个工具，调它就不该报 scope 错。

真遇到了，说明调的是 REST 接口而不是 MCP 工具——两边的 scope 名字一样但检查点不同。

### 吊销与过期**立刻生效**

每次调用都读库里的状态，不依赖任何缓存。吊销后不需要等什么。

---

## 三、工具调用失败（`isError: true`）

工具失败**不是 JSON-RPC 层的 error**，而是返回在 `result` 里：

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "{\"error\":\"PRODUCT_NOT_FOUND\", ...}" }],
  "structuredContent": { "error": "PRODUCT_NOT_FOUND", "message": "..." }
}
```

**读 `structuredContent.error`**——那是稳定错误码，Agent 可以据此决定是重试、
换参数，还是去申请缺失的权限。

| 错误码 | 含义 | 通常怎么办 |
|---|---|---|
| `PRODUCT_NOT_FOUND` | 商品 id 在库中不存在 | id 写错了，或该商品已下架 |
| `OFFER_NOT_FOUND` | 报价 id 在库中不存在 | 同上 |
| `RECOMMENDATION_ITEM_NOT_FOUND` | 推荐条目不存在，或不属于你的接入方 | 用的是别的会话里的 item id，或别人的接入方的 item id |
| `RECOMMENDATION_ITEM_OFFER_MISMATCH` | 报价存在，但不属于声明的商品/条目 | item id 与 offer id 配错了 |
| `INVALID_RECOMMENDATION_REQUEST` | 推荐请求体非法 | `position` 重复、条数超限等 |
| `INVALID_IMPRESSION_REQUEST` | 曝光请求体非法 | `impressedAt` 缺时区偏移等 |
| `IMPRESSION_EVENT_KEY_CONFLICT` | 同一个 `eventKey` 携带了不同的内容 | **不是重试**：key 用错了 |
| `RECOMMENDATION_ANALYTICS_FAILED` | 统计查询失败 | 时间窗跨度超 366 天 |
| `TOOL_EXECUTION_FAILED` | 未预期的内部异常 | 带上 requestId 找服务方 |

### "调不存在的工具" 长什么样

两种形状**不能混**，Agent 读结果的方式不同：

- 调**不存在的工具** → `isError: true` + 文本 `MCP error -32602: Tool xxx not found`
  （SDK 在工具层拦下，JSON-RPC 层没有 error）
- 调**不存在的方法**（如 `tools/callX`）→ JSON-RPC 顶层 error
  `{"code":-32601,"message":"Method not found"}`

### 参数校验错误没有稳定错误码

**未知字段、类型不对、越界**由 SDK 在进工具之前拦下，
表现为 `isError: true`，消息里写明是哪个字段不合法。

这一层是协议层校验，不是业务错误，所以**没有** `structuredContent.error`。
接入方自己的重试逻辑不要依赖这类错误有稳定码。

### `Invalid UUID at eventKey`

`eventKey`（幂等键）与 `recommendationItemId` **必须是 UUID**。
写成 `"impression-1"`、`"exp-2026-11-07"` 这类字符串，会在进工具之前被拦下：

```
MCP error -32602: Input validation error: Invalid arguments for tool record_impression: Invalid UUID at eventKey
```

这一层没有稳定错误码，但很好认：**只要报 `Invalid UUID at xxx`，就是把某个 ID 字段写成了非 UUID**。

- `recommendationItemId`：必须用 `record_recommendation` 返回的 `items[].id` **原值**。
- `eventKey`：用 `randomUUID()` 生成；同一次曝光的重试**复用同一个值**。

### 请求体拒绝未知字段

拼错的字段名会被明确拒绝，而不是被静默忽略——后者会让你拿到一份
"看起来正常"但其实少了内容的推荐记录。

---

## 四、限流（429）

```
HTTP/1.1 429 Too Many Requests
retry-after: 30
x-ratelimit-limit: 120
x-ratelimit-remaining: 0
```

- 默认每把 Key 每分钟 **120 次**，可单独调整。
- **一次完整链路（稳态）是 6 次请求**：5 次工具调用 + 1 次点击跳转。
  做批量任务要按这个口径设计；**首次接入那一轮是 8 次**（多一次握手与一次 `tools/list`）。
- 窗口按数据库时钟对齐到整分钟。
- 计数存在**数据库**里：部署重启不会让额度归零，多副本共享同一份账。
- **先认证再限流**——所以无效凭据的洪水不会消耗合法调用方的额度。
  反过来说：如果你收到 429，说明**认证已经过了**，Key 是有效的。

---

## 五、结果不对（不是报错，是数据怪）

### `condition` 是 `null`

**这是"不知道"，不是"全新"。** 两种原因：

1. 这条 listing **从来没取过商品明细**——只有价格、标题、链接，
   上游的成色和库存没人去取。目录里有一批这样的 listing。
2. 取过明细，但上游那个时点没给成色。

按你的判断写代码时：

```ts
// 对：明确要全新
const isNew = offer.condition === "new";

// 错：null 会被当成"不是二手"，于是把成色未知的也推了出去
const isNew = offer.condition !== "used";
```

### `condition` 的值认不认识

成色是**稳定词表**，只有四个值：

| 值 | 含义 |
|---|---|
| `new` | 全新 |
| `used` | 二手 |
| `refurbished` | 翻新（各档位都归到这里） |
| `open_box` | 开箱品 |

拿不到是 `null`。**上游的自由文本不会原样出现在这个字段里**——
所以你不需要写 "Good - Refurbished" 这类判断。

### 比价看着不对劲

大概率是**没看成色**。`condition` / `shippingOptions` / `itemLocation`
都是**报价（listing）级**的属性：同一件商品可能一个卖家全新一个二手、
一个包邮一个不包邮。不看这三个字段，比出来的价格可能根本不是同一个东西。

另一个常见原因：**跨币种**。本服务**不提供汇率**，所以比价不跨币种给结论——
`comparison.currencies[]` 是按币种分组的，不同币种之间没有"谁更便宜"的答案。

### `availability` 是 `unknown`

同 `condition`：这条 listing 的明细没取过，或上游没给库存状态。
`availability` 存的是上游值的小写形式（`in_stock` / `out_of_stock`），
**不做语义改写**——上游出现新值时小写原值至少还是可读的。

### 搜索结果为空

- 关键词太窄（`q` 限 1–100 字符，按标题/品牌/类目模糊匹配）。
- 这个词在当前目录里确实没有商品。**staging 是 sandbox 市场**，
  目录跟 production 完全不同，**两边的数据不可互查**。

---

## 六、归因链路断了

### 曝光报成功但统计里看不到

**曝光上报后，统计窗口可能还没到。** 另外记得：

- `impressions` 是 `null` 而不是 `0` 时，意思是**没有采集到曝光数据**
  （曝光上报还没接），不是"用户一个都没看"。这两个必须分开。
- 统计的队列由**推荐请求**决定：曝光、点击、转化都归到那次推荐上，
  哪怕事件本身发生在窗口结束之后。

### 点击数一直是 0

**点击记录发生在用户真正点开链接时**，不是生成链接时。
`create_purchase_link` 只是生成一个带归因的 URL，它本身不写数据。

自测时要真的请求那个 URL：

```bash
curl -i "https://staging.bitfund.ltd/go/offer_xxx?recommendation_item_id=<uuid>&session_id=xxx"
# 期望 302，Location 指向 eBay 商品页
```

### 点击没有归属到推荐

`recommendationItemId` 必须是**同一次** `record_recommendation` 返回的
`items[].id`。用 `recommendationId` 代替会得到
`RECOMMENDATION_ITEM_NOT_FOUND`。

拼查询参数要用 `&`——购买链接**已经自带** `?recommendation_item_id=`，
再用 `?` 会把参数值拼成 `uuid?session_id=...`，服务端校验 uuid 失败，直接 400。

---

## 七、客户端连上了，但工具列表不对

### 工具少了

缺 scope 的工具不会出现在 `tools/list` 里。试用 Key 默认是
`catalog:read` + `recommendations:write`，所以只有 5 个工具；
`recommendation_analytics` 需要另外申请 `analytics:read`。

### `initialize` 的 instructions 是空的

那说明握手有问题。重新 `connect` 一次再看。

instructions 是**按当前权限生成**的，写着这把凭据能用哪些工具、哪些工具缺哪个 scope。
Agent 读完就知道该去申请什么，不用靠猜。

---

## 八、还是不行

带上这些信息找服务方：

1. **`x-request-id`**（最重要）
2. 你用的**环境地址**（staging 还是 production）
3. **Key 前缀 8 位**（不要发完整 Key）和 **Key 的签发时间**
4. 完整的 **`tools/call` 请求体**和**响应体**（Key 打码）
5. 你用的**客户端与版本**（Claude Desktop / Cursor / 自建 + SDK 版本）

### 服务方怎么查

```bash
# 按 requestId 查这次调用
curl -H "x-import-token: $ADMIN_TOKEN" \
  "https://staging.bitfund.ltd/v1/admin/api-requests?limit=50"

# 按接入方看调用统计与成功率
curl -H "x-import-token: $ADMIN_TOKEN" \
  "https://staging.bitfund.ltd/v1/admin/stats"
```

> **MCP 的失败藏在 JSON-RPC 的 `isError` 里，HTTP 状态码照样是 200。**
> 按 HTTP 请求统计会把这些失败整个漏掉——所以本服务按**工具调用**记日志：
> `method='MCP'`、`path='/mcp/tools/<工具名>'`。
> 排查时按这个口径看，别按 HTTP 状态码数。

---

## 附：一分钟自检清单

```bash
BASE=https://staging.bitfund.ltd
KEY=$YOUR_API_KEY

# 1. 服务活着？
curl -s $BASE/health

# 2. 凭据对不对？能列几个工具？
curl -s -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400

# 3. 能搜到东西吗？
curl -s -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_products","arguments":{"q":"iphone","limit":1}}}' | head -c 400
```

三步都过 → 接入没问题。哪一步断了，就去看上面对应的章节。
