# SOPS-managed app secrets

`cosmos-app-secrets.enc.yaml` is a k8s `Secret` (`stringData`) encrypted with [SOPS](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age). The age **public** recipient is pinned in `.sops.yaml`; the matching **private** key (`~/.config/sops/age/keys.txt` on the lab) is the one thing that is never committed.

```bash
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
sops -d cosmos-app-secrets.enc.yaml | kubectl apply -f -   # decrypt + apply
sops cosmos-app-secrets.enc.yaml                           # edit in place (re-encrypts on save)
sops --set '["stringData"]["KEY"] "value"' cosmos-app-secrets.enc.yaml   # surgical single-value set
```

## Invariants (verify before committing)

| Key | Invariant | Generate / check |
|---|---|---|
| `SSO_VAULT_KEY` | base64 string that decodes to **exactly 32 bytes** (AES-256) | `openssl rand -base64 32` — **never `48`**. Check: `sops -d --extract '["stringData"]["SSO_VAULT_KEY"]' cosmos-app-secrets.enc.yaml \| base64 -d \| wc -c` must print `32` |
| `WORM_MANIFEST_HMAC_KEY` | HMAC key (no fixed length requirement) | `openssl rand -base64 32` |
| `COSMOS_APP_PASSWORD` | least-priv `cosmos_app` DB role password | — |
| `INTERNAL_ADMINS` | comma-separated admin emails | — |

**Why 32 and not 48:** in legacy mode (`SSO_VAULT_KEYS` unset) `SSO_VAULT_KEY` is the *active* key. `decodeKey` (`src/lib/crypto/vault.ts`, `KEY_BYTES = 32`) throws `must decode to exactly 32 bytes` on the first SSO crypto call — a 48-byte key passes a naive "looks like base64" eyeball but crashes SSO at runtime. A wrong-length key applied over a working cluster also orphans any data already sealed under the old key, so **rotate by re-keying sealed data, not by swapping the key blindly**.
