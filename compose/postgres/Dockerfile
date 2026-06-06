# Cosmos Postgres image: pgvector (for the embeddings migration) + pgBackRest
# (for WAL archiving + base backups to the in-boundary MinIO S3 repo — CP-9/10).
#
# Pinned by digest (DSOP supply-chain hygiene); matches the base used elsewhere.
FROM pgvector/pgvector@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc

# pgBackRest from Debian bookworm. --no-install-recommends keeps the runtime lean
# (least functionality — 3.4.6/3.4.7). Clean apt lists to shrink the layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pgBackRest needs writable log + spool dirs owned by the postgres user (the image's
# DB superuser). The config itself is generated at start by the entrypoint wrapper
# (env → /etc/pgbackrest/pgbackrest.conf) so no secret is baked into the image.
RUN mkdir -p /etc/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest \
 && chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest

COPY compose/postgres/pgbackrest.conf.template /etc/pgbackrest/pgbackrest.conf.template
COPY compose/postgres/render-pgbackrest-conf.sh /usr/local/bin/render-pgbackrest-conf.sh
COPY compose/postgres/docker-entrypoint-wrapper.sh /usr/local/bin/docker-entrypoint-wrapper.sh
COPY compose/postgres/cosmos-backup.sh /usr/local/bin/cosmos-backup.sh
COPY compose/postgres/pgbackrest-archive-push.sh /usr/local/bin/pgbackrest-archive-push.sh
COPY compose/postgres/cosmos-stanza-create.sh /usr/local/bin/cosmos-stanza-create.sh
RUN chmod +x /usr/local/bin/render-pgbackrest-conf.sh \
             /usr/local/bin/docker-entrypoint-wrapper.sh \
             /usr/local/bin/cosmos-backup.sh \
             /usr/local/bin/pgbackrest-archive-push.sh \
             /usr/local/bin/cosmos-stanza-create.sh

# Wrap the stock postgres entrypoint: render the pgBackRest conf from env first, then
# hand off to the original entrypoint (which drops to the postgres user and runs the
# `command:` from compose with archive_mode etc.).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint-wrapper.sh"]
CMD ["postgres"]
