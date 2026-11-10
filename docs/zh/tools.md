# 工具速查

**权威规范**是 [contract.md](./contract.md)。这一页是速查版：
一个工具一节，只写你真正会传的参数。

两份不会漂移——CI 会比对本文件与契约里的工具名，不一致直接让构建失败。

## 一览

| 工具 | 权限 | 作用 | 写数据 |
|---|---|---|---|
| `search_products` | `catalog:read` | 搜商品 | 否 |
| `compare_offers` | `catalog:read` | 比同一个商品的各报价 | 否 |
| `create_purchase_link` | `catalog:read` | 生成带归因的购买链接 | 否 |
| `record_recommendation` | `recommendations:write` | 记录推荐 | **是** |
| `record_impression` | `recommendations:write` | 上报曝光 | **是** |
| `recommendation_analytics` | `analytics:read` | 读效果漏斗 | 否 |

`create_purchase_link` 本身不写数据——点击记录发生在**用户打开链接**时。

## 工具清单按权限过滤

`tools/list` 只返回这把 Key 真能用的工具。只有
`catalog:read` + `recommendations:write` 的 Key 看到 **5 个**工具；
`recommendation_analytics` 需要另外申请 `analytics:read`。

工具少了不是 bug，是权限过滤。

---

## `search_products`

按关键词搜归一化后的商品，返回每个商品的跨来源报价。

| 参数 | 类型 | 说明 |
|---|---|---|
| `q` | string | **必填**，1–100 字符 |
| `limit` | number | 可选，1–50，默认 10 |

**返回** `products[]`——每个带 `id`、`title`、`brand`、`category`、
`gtin`、`offers[]`，外加 `meta`。

每个报价带 `id`、`source`、`price`、`currency`、`availability`、
`condition`、`shippingOptions`、`itemLocation`、`productUrl`、
`imageUrl`、`affiliateUrl`、`fetchedAt`、`lastVerifiedAt`、`clickUrl`。

**注意**

- `price` 是**字符串**（定点小数，主单位）。别按浮点解析，也别跨币种比大小。
- `condition` 是稳定词表：`new` / `used` / `refurbished` / `open_box`，
  取不到是 `null`。`null` 是"不知道"，**不是**"全新"。
- `availability` 是上游原值小写；`unknown` 表示这条 listing 的明细从没取过。
- `condition`、`shippingOptions`、`itemLocation` 描述的是**报价**不是商品——
  同一件商品可能一个卖家全新一个二手。
- `clickUrl` 是绝对地址，可以直接交给用户点。

## `compare_offers`

比同一个商品的各报价。

| 参数 | 类型 | 说明 |
|---|---|---|
| `productId` | string | **必填**，来自 `search_products` |

**返回** `product`、`offers[]`（按币种、再按价格升序）和 `comparison`。

`comparison.currencies[]` 带 `currency`、`offerCount`、`lowest`
（`offerId` / `price` / `source`）、`highest`。

**注意**

- **没有跨币种的最低价**——本服务不提供汇率，跨币种"谁更便宜"没有答案，
  给一个数反而是误导。
- 商品不存在返回 `PRODUCT_NOT_FOUND`。

## `create_purchase_link`

给报价生成带归因的购买链接。

| 参数 | 类型 | 说明 |
|---|---|---|
| `offerId` | string | **必填**，来自搜索或比价结果 |
| `recommendationItemId` | string（uuid） | 可选，来自 `record_recommendation` |
| `sessionId` | string | 可选，上游会话标识 |

**返回** `url`、`path`、`offerId`、`productId`、`productTitle`、
`price`、`currency`、`availability`、`condition`。

**注意**

- **这一步不写数据。** 点击记录发生在用户打开链接时（302 跳商品页）。
- 它会先校验报价与推荐条目存在且互相匹配——早失败好过给一个必然 404 的链接。
- 推荐条目**按接入方隔离**：别家接入方的 item id 一律是
  `RECOMMENDATION_ITEM_NOT_FOUND`。
- 可能报错：`OFFER_NOT_FOUND`、`RECOMMENDATION_ITEM_NOT_FOUND`、
  `RECOMMENDATION_ITEM_OFFER_MISMATCH`。

## `record_recommendation`

记录这次推荐。

| 参数 | 类型 | 说明 |
|---|---|---|
| `scenario` | string | **必填**，场景标识 |
| `query` | string | **必填**，触发这次推荐的用户原话 |
| `sessionKey` | string | 可选，上游会话标识 |
| `metadata` | object | 可选，非敏感扩展数据 |
| `items` | array | **必填**，1–50 条 |

每条带 `productId`、`offerId`、`position`（不重复），可选 `reason`、
`snapshot`。

**返回** `recommendationId`、`itemCount` 和 `items[]`，**每条 item 有自己的 `id`**。

**注意**

- 这些 item id 是后续曝光与点击挂靠的**唯一凭据**。只有 `recommendationId`
  没法回答"用户点的是第几条"。
- `query` 原样入库且**没有自助删除入口**——别把身份信息、地址、电话塞进去。

## `record_impression`

上报一次曝光。

| 参数 | 类型 | 说明 |
|---|---|---|
| `recommendationItemId` | string（uuid） | **必填**，必须属于**你的**接入方 |
| `eventKey` | string（uuid） | **必填**，幂等键 |
| `impressedAt` | string | **必填**，ISO 8601，**必须带时区偏移** |
| `metadata` | object | 可选 |

**返回** `impressionId` 和 `inserted`。

- `inserted: true`——这次真的写进了一行。
- `inserted: false`——同一次曝光的重试（相同 `eventKey`、相同内容）。

**注意**

- `eventKey` **必须是 UUID**，重试**必须复用同一个值**。
- 同一个 `eventKey` 带**不同**内容是 `IMPRESSION_EVENT_KEY_CONFLICT`——
  那是 key 用错了，不是重试。
- 别人的接入方的 item id 一律是 `RECOMMENDATION_ITEM_NOT_FOUND`。

## `recommendation_analytics`

读推荐效果统计。需要 `analytics:read`。

| 参数 | 类型 | 说明 |
|---|---|---|
| `from` | string | **必填**，含下界，ISO 8601 带时区偏移 |
| `to` | string | **必填**，不含上界，ISO 8601 带时区偏移 |
| `asOf` | string | 可选，观测点（默认当前数据库时间） |
| `scenario` | string | 可选，按场景过滤 |

**返回** `period`、`funnel`、`dataQuality`、`commissions`、`meta`。

- `funnel`——`requests`、`requestsWithItems`、`items`、`impressions`、
  `clicks`、`conversions`。
- `dataQuality`——曝光数据状态、缺交易时间戳的转化、窗口外挂的转化。
- `commissions`——按 (network, currency, status) 分组的佣金与销售额。

**注意**

- 一次查询跨度最多 **366 天**。
- 这里的金额是**最小币种单位**的十进制字符串，按币种分组，**不跨币种求和**。
  报价的 `price` 是另一个单位——主单位的定点小数。
- `impressions` 是 `null` 表示**没采到曝光数据**，不是"没人看"。

---

## 你能据此行动的错误码

工具失败在结果里（`isError: true`），不是 JSON-RPC 层的 error。
读 `structuredContent.error`：

| 错误码 | 含义 | 通常怎么办 |
|---|---|---|
| `PRODUCT_NOT_FOUND` | 商品 id 不存在 | id 写错，或商品已下架 |
| `OFFER_NOT_FOUND` | 报价 id 不存在 | 同上 |
| `RECOMMENDATION_ITEM_NOT_FOUND` | 条目不存在，或不属于你 | 用了别的会话或别家的 item id |
| `RECOMMENDATION_ITEM_OFFER_MISMATCH` | 报价不属于该条目 | id 配错了 |
| `INVALID_RECOMMENDATION_REQUEST` | 请求体非法 | `position` 重复、条数超限 |
| `INVALID_IMPRESSION_REQUEST` | 请求体非法 | `impressedAt` 缺时区偏移 |
| `IMPRESSION_EVENT_KEY_CONFLICT` | 同一 `eventKey` 内容不同 | key 用错，不是重试 |
| `RECOMMENDATION_ANALYTICS_FAILED` | 统计查询失败 | 窗口超过 366 天 |
| `TOOL_EXECUTION_FAILED` | 未预期的内部异常 | 带上 requestId 找服务方 |

鉴权与限流失败发生在 HTTP 层：`401 UNAUTHORIZED`、`401 API_KEY_INVALID`、
`401 API_KEY_REVOKED`、`401 API_KEY_EXPIRED`、`403 API_CLIENT_SUSPENDED`、
`403 INSUFFICIENT_SCOPE`、`429 RATE_LIMIT_EXCEEDED`。

参数校验错误（未知字段、类型不对、越界）在进工具之前就被拦下，
**没有稳定错误码**，只有一条指明字段名的消息——别在它上面建重试逻辑。

更多：[troubleshooting.md](./troubleshooting.md) ·
English: [tools.md](./tools.md)
