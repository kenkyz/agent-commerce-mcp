# Security policy

## What this repository is

Client examples, documentation and tooling for the **agent-commerce MCP
service**. The service itself is hosted and is not part of this repository.

## Reporting a vulnerability

**In the service** (the MCP endpoint, the API keys, the catalog, the redirect
and attribution path):

Report it privately to **kenkyz@foxmail.com** rather than opening a public
issue. Include the request id, the endpoint, the timestamp and a description
of the impact. You will get an acknowledgement.

**In this repository** (a leaked key in an example, a broken link in the
docs, an unsafe instruction): open a normal issue — but see the note below
about keys.

## If you find a key in this repository

Do not open an issue that quotes it, and do not quietly "fix" it in a pull
request.

1. **Revoke or rotate the key first.** A key that was published must be
   considered compromised, even if it was removed afterwards.
2. Then open an issue (or a PR, if you prefer) that says *where* it was, in
   which revision, without quoting the value.

Keys are issued per integration and can be revoked individually. The service
stores only a hash, so a plaintext key is shown exactly once at issue time.

## What not to put in an issue

- API keys, even ones you think are expired.
- Customer data, order details, or anything pulled from a production database.
- Personal data of your users — the `query` you pass to
  `record_recommendation` is stored verbatim.
