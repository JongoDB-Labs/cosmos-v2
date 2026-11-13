# Runbook: Outbound endpoints and private networks

Cosmos calls URLs that someone other than the operator chose:

| Who chose it | What | May reach a private address? |
|---|---|---|
| Any project admin | Webhooks | Never |
| Cosmo, from a chat | `fetch_url` | Never |
| An org admin | OpenAI-compatible model endpoint, Jira site, MCP server URL | Only inside `OUTBOUND_ALLOW_PRIVATE_CIDRS` |

Every one of these goes through `src/lib/security/outbound-post.server.ts`:

- The host name is resolved and **every** address it resolves to must be allowed.
- Cosmos connects to the address it checked, so a second DNS answer can't redirect it.
- Redirects are never followed. A 3xx is reported as a failure.
- One overall deadline covers the whole exchange, including a slow body.
- An error is reported by its HTTP status. The remote body is never shown or stored.

The same rules are checked earlier, when the URL is saved, so an admin sees the
refusal right away. The save-time check can only judge the text of the URL; the
send-time check judges what the name resolves to at that moment.

## Never reachable

These are refused for every caller, whatever the operator configures:

- `169.254.0.0/16` and `fe80::/10` (link-local, including the cloud metadata service)
- `fd00:ec2::254` (the IPv6 metadata service)
- the metadata host names `metadata`, `metadata.google.internal`, `metadata.goog`,
  `instance-data`, `instance-data.ec2.internal`
- any IPv4 address written as IPv6 (`::a.b.c.d`, `::ffff:a.b.c.d`, `::ffff:0:a.b.c.d`)

## Allowing a self-hosted model or Jira on a private network

Set `OUTBOUND_ALLOW_PRIVATE_CIDRS` in the app's environment to the narrowest
ranges that hold those services. With docker compose that is `.env`. The Helm
chart has no value for it yet, so on Kubernetes add it to the `cosmos`
container's `env` in `charts/cosmos/templates/app.yaml`.


```
OUTBOUND_ALLOW_PRIVATE_CIDRS=10.20.30.0/24,fd12:3456:789a::/48
```

- It applies only to endpoints an org admin configured. Webhooks and `fetch_url`
  never use it.
- It is an instance setting, not an org setting: on a shared instance every org's
  admins can then point an endpoint into these ranges. List only what every
  tenant may reach.
- `localhost` and `127.0.0.0/8` are private like any other range. List
  `127.0.0.0/8` only if a model really runs on the same host.
- Restart the app after changing it.
- An entry that isn't a CIDR range makes every call or save that needs a
  private address fail with an error naming the bad entry. Public endpoints
  keep working.

## Checking a refusal

When a save is refused, the response says why (for example "That address isn't
public"). When a call is refused or times out, the error says "not sent or not
finished" with the reason. Confirm what the host name resolves to from the app
host, then either add the range above or use a public address.
