# Public hostname + TLS (the front door)

COSMOS is domain-agnostic: it derives its public origin (OAuth `redirect_uri`, email
links, redirects) from the `X-Forwarded-Host` / `X-Forwarded-Proto` headers the
bundled Caddy (`reverse-proxy` service) sets. Nothing about the domain is hardcoded
or stored — so a domain change needs no app change or redeploy, only edge/DNS/proxy.

## Two front-door modes

The `reverse-proxy` (Caddy) service supports both via one env var, `COSMOS_SITE_ADDRESS`:

### 1. Caddy terminates TLS (recommended — no external proxy needed)
Set `COSMOS_SITE_ADDRESS` to your public hostname. Caddy obtains and auto-renews a
Let's Encrypt certificate and serves HTTPS on 443 (redirecting 80). No nginx,
Cloudflare tunnel, or load balancer required.

```
# .env on the host
COSMOS_SITE_ADDRESS=cosmos.example.com
```

Requirements:
- **DNS**: an A record `cosmos.example.com` → the host's public IP.
- **Inbound 80 + 443 reachable** from the internet (80 is needed for the ACME
  HTTP-01 challenge and the http→https redirect). On AWS: a **stable Elastic IP**
  associated with the instance (in a public subnet with an Internet Gateway — the
  public↔private NAT is automatic, there is no per-hostname rule) and a **Security
  Group** allowing inbound TCP 80 and 443.
- Certs persist in the `caddy-data` volume across the `--force-recreate` every deploy
  does (do not remove it, or you will re-request certs and hit Let's Encrypt limits).

### 2. TLS terminates upstream (proxy / tunnel / cloud LB in front)
Leave `COSMOS_SITE_ADDRESS` unset. Caddy serves plaintext `:80`; the upstream
terminates TLS and **must** forward `X-Forwarded-Host: <public hostname>` and
`X-Forwarded-Proto: https` (getting `X-Forwarded-Proto` wrong breaks OAuth with a
`redirect_uri` mismatch). Bind the port loopback-only in `docker-compose.override.yml`
if the upstream runs on the same host.

## OAuth redirect URIs (both modes)
Register these exact callback paths in the Google and Entra apps:
- Google:  `https://<public-hostname>/api/auth/google/callback`
- Entra:   `https://<public-hostname>/api/auth/microsoft/callback`
(The domain alone is not enough — the full path must match.)

## Cutover: from a Cloudflare-tunnel deploy to direct Caddy auto-HTTPS
1. Register the OAuth redirect URIs for the new hostname (above).
2. AWS: associate a stable Elastic IP; open the Security Group to inbound 80 + 443.
3. DNS: point the new hostname's A record at that Elastic IP.
4. On the host: set `COSMOS_SITE_ADDRESS=<new hostname>` in `.env`, and remove the
   loopback `ports:` override for `reverse-proxy` in `docker-compose.override.yml`
   (so 80/443 publish). Then `docker compose up -d --force-recreate reverse-proxy`
   and watch the log for the issued certificate.
5. Verify `https://<new hostname>` serves and login works.
6. Decommission the tunnel + host nginx: `sudo systemctl disable --now cloudflared
   nginx`. (Cookies are host-only, so users re-log-in on the new domain — expected.)
