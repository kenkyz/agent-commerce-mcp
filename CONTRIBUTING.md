# Contributing

Issues and pull requests are welcome. The most useful thing you can send is a
report that the integration did **not** work as documented.

## Before you open a pull request

```bash
npm install
npm run check
```

That runs three things:

| Check | What it protects |
|---|---|
| `npm run typecheck` | the examples still compile against the SDK |
| `npm run check:docs` | the tool list in `docs/tools.md` still matches `docs/contract.md`, the examples only call tools that exist, and no link is broken |
| `npm run scan:secrets` | no key, token or password in the working tree **or the git history** |

All three also run in CI.

## Rules

- **Never commit a real key, token or password.** Not in an example, not in a
  test fixture, not in a comment. The secret scan covers the history too, so
  "I deleted it in the next commit" is not good enough — rotate it.
- **English and Chinese change together.** `docs/` and `docs/zh/` are the same
  document in two languages; if you change one, change the other in the same
  pull request.
- **Do not edit `docs/contract.md` by hand.** It is the contract, and it is
  maintained in the service repository and copied here. If something in it is
  wrong, open an issue describing what is wrong — changing it here would make
  this repository disagree with the service.
- **Do not add a dependency** unless the example genuinely needs it. The point
  of the demo agent is that switching models costs zero code changes.
- Keep the examples runnable. If you add one, it must run against the real
  service with nothing but an API key.

## Reporting an integration problem

Use the **Integration Feedback** issue template. Include:

- what you were building,
- where you got stuck and what you worked around,
- the endpoint you used and the `x-request-id` if you have it.

Please mask your key in anything you paste.
