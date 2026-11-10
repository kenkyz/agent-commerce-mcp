# agent-commerce-mcp

**给 AI 购物 Agent 用的电商基础设施。**
搜真实商品、比真实报价、记录你推荐了什么、给用户一个还能点的链接——一个 MCP 端点就够了。

[![transport](https://img.shields.io/badge/transport-MCP%20Streamable%20HTTP-4C6EF5)](./docs/zh/contract.md)
[![license](https://img.shields.io/badge/license-MIT-8F5A2C)](./LICENSE)
[![status](https://img.shields.io/badge/status-developer%20preview-D98C2A8)](./docs/zh/troubleshooting.md)

这个仓库是**接入层**——客户端示例、工具契约、接入文档。
背后的服务是托管的，**不开源**。见 [哪些公开、哪些不公开](#哪些公开哪些不公开)。

---

## 为什么要用它

给 AI Agent 加购物能力，通常意味着先把这些做完：

| 要做的事 | 自己做 | 用这个服务 |
|---|---|---|
| 保持新鲜的商品feed | 自己爬、自己调度、自己去重 | `search_products` |
| 归一化的商品属性 | 自己解析各家listing标题 | `condition` 用稳定词表 |
| 报价比价 | 自己分组、自己排序 | `compare_offers`，按币种分组 |
| 点击归因 | 自己写跳转服务、自己跑事件管道 | `record_recommendation` → `record_impression` → `create_purchase_link` |
| 知道到底卖出去多少 | 自己匹配转化 | `recommendation_analytics` |

这些都不是你产品最难的部分。这个服务替你省掉的就是那一个月。

## 你会拿到什么

- **一个活的商品库。** 跨来源归一化的商品，每个商品带全部报价：
  价格、币种、成色、库存、配送、发货地。
- **六个 MCP 工具。** 整个接口面一次能看完。
- **点击之后依然成立的归因。** 推荐、曝光、点击挂在同一个 item id 上，
  所以你能回答"用户点的是列表里的第几条"。

---

## 快速开始

### 1. 拿一把试用 Key

向服务方申请——入口页上带着联系方式：
**[commerce.bitfund.ltd/docs](https://commerce.bitfund.ltd/docs)**。
也可以直接开一个 GitHub issue，用 *Integration Feedback* 模板。

明文**只在签发时返回一次**，没有"找回"这个操作。丢了就再发一把。

> 两个环境，**Key 不通用**：
> 试用 `https://staging.bitfund.ltd/mcp`，正式 `https://commerce.bitfund.ltd/mcp`。

### 2. 让客户端指过来

Claude Desktop、Cursor，或者任何会讲 MCP 的东西：

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

> **必须显式配 `x-api-key`**（或 `Authorization: Bearer`）。多数 MCP 客户端
> 默认假设服务要走 OAuth，不配凭据时它报 `auth_required`，而不是直接连上。
> 本服务用静态 Key，不发 `WWW-Authenticate`，客户端没法自己猜该带什么头。

### 3. 发一次调用

```bash
curl -X POST https://commerce.bitfund.ltd/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: $YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"q":"wireless headphones under 200","limit":3}}}'
```

两个 `Accept` 类型都要有——这是 MCP 规范要求，少一个直接 `406`。

**完事。** 完整走一遍：[docs/zh/quickstart.md](./docs/zh/quickstart.md) ·
English: [docs/quickstart.md](./docs/quickstart.md)

---

## 六个工具

| 工具 | 权限 | 作用 |
|---|---|---|
| `search_products` | `catalog:read` | 搜商品，返回商品及其全部报价 |
| `compare_offers` | `catalog:read` | 比同一个商品的各报价，按币种分组 |
| `create_purchase_link` | `catalog:read` | 生成带归因的购买链接 |
| `record_recommendation` | `recommendations:write` | 记录推荐，返回 item id |
| `record_impression` | `recommendations:write` | 上报曝光（幂等） |
| `recommendation_analytics` | `analytics:read` | 读推荐 → 曝光 → 点击 → 转化漏斗 |

工具清单**按 Key 的权限过滤**：没有 `analytics:read` 的 Key，
`tools/list` 里根本不会出现 `recommendation_analytics`。

完整规范：[docs/zh/contract.md](./docs/zh/contract.md) ·
速查表：[docs/zh/tools.md](./docs/zh/tools.md) ·
报错与症状：[docs/zh/troubleshooting.md](./docs/zh/troubleshooting.md)

---

## 跑起来看看

一个完整购物 Agent，一个文件：调哪个工具、传什么参数由模型决定，
商品供给和归因由服务负责。

```bash
npm install
cp .env.example .env        # 填 MCP_API_KEY 和模型 Key
npm run demo -- --query "200 以内的无线耳机"
```

**模型提供商是配置项，不是绑定。** 任何 OpenAI 兼容的 `/chat/completions`
都行——MiniMax、DeepSeek、Qwen、OpenRouter、自建 vLLM、本地 Ollama。
换模型只改环境变量，不改代码。

其它示例：

| 示例 | 展示什么 |
|---|---|
| `examples/shopping-agent/` | 完整 Agent：搜索 → 比价 → 推荐 → 曝光 → 购买链接，模型在回路里 |
| `examples/sdk-client/` | 同一套流程，走官方 MCP SDK，带逐项断言 |
| `examples/agent-step/` | 单次工具调用，由调用方决定传什么——Agent 真正的用法 |

---

## 仓库结构

```
agent-commerce-mcp/
├── docs/
│   ├── quickstart.md          # 15 分钟完成第一次成功调用
│   ├── tools.md               # 速查：工具、权限、参数
│   ├── troubleshooting.md     # 按症状组织
│   ├── contract.md            # 完整规范（权威）
│   └── zh/                    # 中文版
├── examples/
│   ├── shopping-agent/        # 完整 Agent，模型在回路里
│   ├── sdk-client/            # 官方 SDK 客户端，跑通整条链路
│   └── agent-step/            # 单次工具调用
├── tools/                     # 仓库自检：密钥扫描、文档一致性
└── .github/                   # Issue 模板、CI
```

## 哪些公开、哪些不公开

**这里公开的**

- 工具契约——名字、参数、返回结构、错误码。
- 快速开始与排查手册（中英双语）。
- 三个可以直接抄的客户端。

**不公开的**

- 服务端实现：商品同步、商品归一化、匹配引擎、归因引擎。
- 电商后端和它的数据库。

公开这一层的理由很简单：**怎么接进去是别人的事，商品库怎么建不是。**
接入不应该要求你先读完别人的业务逻辑。

## 文档

- **[快速开始](./docs/zh/quickstart.md)** —— 15 分钟第一次成功调用
- **[工具速查](./docs/zh/tools.md)**
- **[完整契约](./docs/zh/contract.md)** —— 权威规范
- **[排查手册](./docs/zh/troubleshooting.md)** —— 按症状查
- **English** — [Quick start](./docs/quickstart.md) · [Tools](./docs/tools.md) · [Contract](./docs/contract.md) · [Troubleshooting](./docs/troubleshooting.md)
- **线上文档** —— <https://commerce.bitfund.ltd/docs>

## 参与贡献

Issue 和 PR 都欢迎。如果哪里跟文档说的不一样，开一个 *Integration Feedback*
issue 最有价值——那是最有用的反馈。
见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

**千万别提交真的 API Key。** CI 会跑 `npm run scan:secrets`，发现了直接红。

## 许可证

[MIT](./LICENSE) —— 适用于本仓库里的示例、文档和工具。
