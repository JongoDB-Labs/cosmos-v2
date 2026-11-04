# Cosmos front-door image: upstream Caddy with THIS repo's Caddyfile baked in.
#
# Why this image exists at all. The Caddyfile used to be host-mounted
# (`./compose/Caddyfile:/etc/caddy/Caddyfile:ro`), and the deploy only rewrites
# image pins in docker-compose.override.yml -- it never pulls, fetches or checks
# out anything from the repo. So a Caddyfile change could pass CI, merge, tag,
# release and deploy while having NO effect on the running system. That is
# exactly what happened to 2.517.0's `encode zstd gzip`: shipped, deployed,
# inert, until the directive was applied to the host by hand. The host checkout
# was found sitting ~870 PRs behind with 456 dirty files, so syncing it is not a
# safe option either.
#
# Baking the config into a digest-pinned, signed image puts it on the ONE path
# that demonstrably works: the deploy already resolves signed digests and pulls
# runtime, migrate and postgres this way. Config now ships with the release,
# rolls back with the release, and is covered by the same cosign signature and
# SLSA provenance as the rest.
#
# Mirrors compose/postgres/Dockerfile, which is the existing precedent for a
# small purpose-built image whose Dockerfile lives under compose/.
#
# NO SECRETS: this image is published to a registry that may be public, and the
# Caddyfile is pure routing plus `{$ENV}` placeholders resolved at RUNTIME by
# Caddy from the container's environment. Nothing here is substituted at build.
FROM caddy@sha256:cb9d71ad83182011b79355cd57692686374bd78d6fe327efe0ff8507da03ab13

COPY compose/Caddyfile /etc/caddy/Caddyfile
