# syntax=docker/dockerfile:1
# --- deps ---
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node (via @huggingface/transformers) has a postinstall that DOWNLOADS the
# GPU execution providers from api.nuget.org. Its per-platform requirement table is
# `linux/x64: ["cuda12"]` and `[]` for everything else — so a macOS/arm64 dev machine
# never sees it and every linux/x64 CI job and `docker build` does. That is 301MB of
# libonnxruntime_providers_cuda.so (+ tensorrt) fetched on every cache-busting build,
# only for the runtime stage to `rm` it again below. It also put a third-party CDN in
# the critical path of shipping: on 2026-08-10 api.nuget.org became unreachable from
# GitHub's runners and `npm ci` failed with ETIMEDOUT, blocking a merge twice.
#
# `skip` is the documented flag (script/install.js exits 0 on it). Do NOT set this via
# .npmrc instead: it works today, but npm warns "Unknown project config ... will stop
# working in the next major version of npm" — i.e. it would fail OPEN, silently
# resuming the 301MB download with every check still green. The env var is the
# supported mechanism.
#
# Verified on real linux/x64: CPU feature-extraction produces a BIT-IDENTICAL 384-dim
# embedding with these binaries absent (they are GPU-only; the CPU runtime
# libonnxruntime.so.1 is bundled in the npm tarball, not downloaded).
ENV ONNXRUNTIME_NODE_INSTALL=skip
# The assert is the point: if a dependency bump, an npm change, or a dropped ENV ever
# revives the download, the build FAILS here instead of quietly regaining a 301MB layer
# and a CDN dependency that nothing would surface.
RUN npm ci --no-audit --no-fund \
 && if [ -e node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so ]; then \
      echo "FATAL: ONNXRUNTIME_NODE_INSTALL=skip is no longer suppressing the CUDA EP download."; \
      echo "       The build just pulled ~301MB from api.nuget.org. Fix the flag, do not delete this check."; \
      exit 1; \
    fi

# --- build ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY --from=deps /app/node_modules ./node_modules
# Bake the MiniLM embeddings model (~87MB ONNX) into node_modules so the runtime
# loads it OFFLINE (gov can't fetch at runtime). It sits before `COPY . .` so a pure
# code change reuses the cached layer — BUT a version bump changes package.json, which
# busts npm ci → the deps copy → this layer, so on a real deploy it re-downloads.
# The HuggingFace fetch is intermittently flaky (rate-limited 403 on CI's shared runner
# IPs, or timeouts), so RETRY with backoff and surface the real error instead of aborting.
# When the hf_token build secret is provided (release.yml wires secrets.HF_TOKEN), export
# it so the download AUTHENTICATES — anonymous per-IP limits are what 403 a version-bump
# rebuild. `required=false` + the `|| true` fallback keep an un-tokened build (forks, local
# `docker build` without --secret) on the prior anonymous path, unchanged.
# The cache lands in node_modules/@huggingface/transformers/.cache/ and is COPY'd to
# the runtime stage; node_modules is .dockerignore'd so the later `COPY . .` can't clobber it.
RUN --mount=type=secret,id=hf_token,required=false set -e; \
    export HF_TOKEN="$(cat /run/secrets/hf_token 2>/dev/null || true)"; \
    for i in 1 2 3 4 5; do \
      if node -e "import('@huggingface/transformers').then(({pipeline})=>pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2')).then(()=>console.log('model cached')).catch(e=>{console.error('[model] '+String(e&&e.message||e).slice(0,300));process.exit(1)})"; then \
        exit 0; \
      fi; \
      echo "[model] download attempt $i failed; retrying in $((i*8))s"; sleep $((i*8)); \
    done; \
    echo "[model] FAILED after 5 attempts"; exit 1
# NEXT_PUBLIC_APP_VERSION reads npm_package_version, which is empty under a raw
# `next build`; pass it explicitly so the sidebar version isn't "0.0.0".
ARG APP_VERSION=0.1.0
ENV npm_package_version=$APP_VERSION
# Brand the image at build time (cosmos, or a brand a plugin registers). next.config.ts reads this and
# inlines it as NEXT_PUBLIC_PRODUCT. Defaults to cosmos so an un-parameterized
# build is unchanged; an alternate-brand image is built with --build-arg PRODUCT=<brand>.
ARG PRODUCT=cosmos
ENV PRODUCT=$PRODUCT
COPY . .
RUN npx prisma generate && npm run build
# SI-4 observability: Next's standalone output (Turbopack) does NOT copy the
# `instrumentation.js` server hook or the chunks it lazily loads — they are listed in
# .next/server/instrumentation.js.nft.json but the standalone tracer drops them. Without
# them the OTel register() hook never runs, so no traces/metrics are exported (silent
# observability gap). Replay the instrumentation NFT trace into the standalone tree so the
# hook + its chunks (and the bundled @vercel/otel / OTLP metric SDK inside them) ship.
# The OTel library chunks ([root-of-the-server]__*) are shared with routes and already
# copied; this fills the instrumentation-specific gap. Idempotent; no-op if Next fixes it.
# `strict` makes the two TELEMETRY-CRITICAL conditions FAIL THE BUILD (exit 1) rather than
# ship a silently telemetry-blind image: (1) the instrumentation.js hook artifact is missing,
# or (2) its NFT manifest is missing — both mean a future Next/Turbopack layout change that
# this replay no longer matches. Per-traced-file misses stay lenient (the NFT can reference
# files outside .next/server that legitimately aren't present). Entries ALREADY in the
# standalone tree (placed there by the route/app trace) are SKIPPED — this step only fills
# the instrumentation-specific GAP and must never clobber what the app trace already wrote.
# That skip also sidesteps Prisma 7's generated client, a DIRECTORY (`.next/node_modules/
# @prisma/client-<hash>`) that enters instrumentation's trace once a plugin server hook
# (loaded via registry/server) touches prisma in a composed image: copyFileSync throws
# EISDIR on it, and even cpSync cannot overwrite the file the app trace already placed there
# — but the app trace HAS placed it, so there is nothing to fill. cpSync (recursive) then
# copies a genuinely-missing entry whether it is a file or a dir.
RUN node -e "const fs=require('fs'),p=require('path'); const sd='.next/server', dd='.next/standalone/.next/server'; const cp=(rel,strict)=>{const s=p.join(sd,rel),d=p.join(dd,rel); if(!fs.existsSync(s)){console.error('[instr-copy]'+(strict?' FATAL':'')+' missing source',s); if(strict)process.exit(1); return;} if(fs.existsSync(d))return; fs.mkdirSync(p.dirname(d),{recursive:true}); fs.cpSync(s,d,{recursive:true}); console.log('[instr-copy]',rel);}; cp('instrumentation.js',true); const nft=p.join(sd,'instrumentation.js.nft.json'); if(fs.existsSync(nft)){for(const f of JSON.parse(fs.readFileSync(nft,'utf8')).files){cp(f.replace(/^\.\//,''),false);}} else {console.error('[instr-copy] FATAL no nft manifest — instrumentation hook would not run'); process.exit(1);}"
# --- migrate-deps: the prisma CLI closure, pruned out of the LOCKFILE tree ---
# Derived from `deps` (node_modules only — no .next, no app source) and then pruned
# to the declared dependency closure of `prisma` + `dotenv`. See
# scripts/docker/migrate-closure.mjs for why the tree is pruned rather than
# reinstalled: every surviving package stays bit-identical to what `npm ci`
# produced from package-lock.json, so the image that touches the production schema
# runs the exact tree CI tested. A fresh `npm install` in a clean stage would
# resolve transitively OUTSIDE the lockfile.
FROM deps AS migrate-deps
WORKDIR /app
COPY scripts/docker/migrate-closure.mjs ./scripts/docker/
RUN node scripts/docker/migrate-closure.mjs

# --- migrate: one-shot job image with the prisma toolchain ---
# Was `FROM build`, i.e. the ENTIRE build stage: full node_modules (2.7 GB), the
# whole .next output (~1.7 GB) and the app source — ~3.2 GB of image to run one
# command, and ~134s of every build spent pushing it. `migrate deploy` needs the
# prisma CLI, the migrations and the config; it never loads the app or @prisma/client.
#
# Defined BEFORE runtime so that `docker build` (no --target) defaults to the app runtime.
# Run as a non-root user (mirrors the runtime stage) so the image is non-root BY
# CONSTRUCTION. `prisma migrate deploy` only reads node_modules/prisma (world-readable
# from npm ci) and writes to HOME for its engine/checkpoint cache — so -m (writable home)
# + ENV HOME is all it needs; no chown of the large /app tree required. The chart's
# runAsUser/HOME override (charts/cosmos/templates/migrate-job.yaml) is then
# belt-and-suspenders, not the only thing forcing non-root at deploy time.
FROM node:24-bookworm-slim AS migrate
WORKDIR /app
# NOTE: no `apt-get install openssl` here, for the same reason the runtime stage
# documents below — installing openssl 3.0.x flips Prisma to require an engine the
# client is not generated for (the v2.95.0 outage). The slim base omits it and
# Prisma falls back to its bundled openssl-1.1.x engine.
COPY --from=migrate-deps /app/node_modules ./node_modules
# prisma.config.ts is TypeScript and is loaded by the Prisma 7 CLI; package.json
# must be present too or npm/node treats /app as a bare directory.
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
RUN groupadd -r cosmos && useradd -r -g cosmos -m -d /home/cosmos cosmos
ENV HOME=/home/cosmos
USER cosmos
# ACCEPTANCE GATE — this is what makes the pruning safe to ship.
#
# migrate-closure.mjs only proves node_modules/.bin/prisma still resolves, which is
# far too weak: `dotenv` is a devDependency that prisma.config.ts imports at module
# scope, so dropping it leaves .bin/prisma perfectly intact while the CLI can no
# longer load its config — no schema, no datasource. That failure would surface for
# the first time against a PRODUCTION database.
#
# `prisma validate` exercises the whole chain offline and with no DATABASE_URL (the
# config carries a placeholder URL for exactly this): CLI starts, prisma.config.ts
# loads (proving dotenv survived), the schema is found and parsed. It runs as the
# non-root user, so it also proves HOME is writable for the engine cache.
#
# Deliberately AFTER `USER cosmos` so it validates the shipped configuration, not a
# root-only one. The "failed to detect libssl" warning it prints is the documented
# benign fallback to the bundled openssl-1.1.x engine — see the runtime stage note.
RUN node_modules/.bin/prisma validate
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# --- runtime (standalone) — the default build target ---
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 HOME=/home/cosmos
# In-boundary embeddings run fully offline (gov): the MiniLM model is baked into
# the image (below), so the HF hub must never be contacted at runtime.
# OMP_NUM_THREADS=1 silences a harmless onnxruntime pthread_setaffinity_np warning.
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=1
# Security: patch the base OS for the two CRITICAL libgnutls30 CVEs fixed in
# bookworm-security — CVE-2026-33845 (DTLS DoS) + CVE-2026-42010 (auth bypass);
# 3.7.9-2+deb12u6 -> deb12u7. --only-upgrade keeps the layer minimal (no new
# packages). The remaining base CRITICALs (perl/zlib) have no upstream fix and
# are accepted as POA&M items in .trivyignore.
# NOTE: do NOT install `openssl` here. The slim base omits it, so Prisma falls back
# to its bundled openssl-1.1.x engine (the "Defaulting to openssl-1.1.x" warning is
# benign). Installing openssl (3.0.x) flips Prisma to REQUIRE the openssl-3.0.x
# engine, which the client isn't generated for (no binaryTargets) → runtime engine
# mismatch + DB down (the v2.95.0 regression). To move to 3.0.x, add binaryTargets
# to prisma/schema.prisma AND install openssl together — never one without the other.
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade libgnutls30 \
 && rm -rf /var/lib/apt/lists/*
# -m -d gives the non-root user a writable home (prisma/node tooling expect one).
RUN groupadd -r cosmos && useradd -r -g cosmos -m -d /home/cosmos cosmos
# Standalone server + static assets + Prisma engine/migrations for the migrate job.
COPY --from=build --chown=cosmos:cosmos /app/.next/standalone ./
COPY --from=build --chown=cosmos:cosmos /app/.next/static ./.next/static
COPY --from=build --chown=cosmos:cosmos /app/public ./public
COPY --from=build --chown=cosmos:cosmos /app/prisma ./prisma
# node_modules/.prisma holds the generated client + query engine the runtime app needs.
COPY --from=build --chown=cosmos:cosmos /app/node_modules/.prisma ./node_modules/.prisma
# @huggingface/transformers is externalized (next.config.ts) so the standalone
# trace keeps it as a real on-disk package — but the trace does NOT reliably pull
# its native onnxruntime binaries or the baked model cache. Copy them explicitly:
#   - @huggingface/*  : transformers (+ its .cache/ MiniLM model), jinja, tokenizers
#   - onnxruntime-*   : the Node native runtime that actually runs the ONNX model
#   - sharp / @img    : transformers' image dep (loaded eagerly; native libvips)
# These land at the SAME node_modules path the app resolves (the cache dir is
# resolved relative to the transformers package dir).
COPY --from=build --chown=cosmos:cosmos /app/node_modules/@huggingface ./node_modules/@huggingface
COPY --from=build --chown=cosmos:cosmos /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=build --chown=cosmos:cosmos /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=build --chown=cosmos:cosmos /app/node_modules/onnxruntime-web ./node_modules/onnxruntime-web
COPY --from=build --chown=cosmos:cosmos /app/node_modules/sharp ./node_modules/sharp
COPY --from=build --chown=cosmos:cosmos /app/node_modules/@img ./node_modules/@img
# Slim onnxruntime-node for a CPU-only, linux/x64 runtime. CPU inference (linux/x64) is
# unaffected — verified by the in-container EMBED OK acceptance.
#
# The two GPU provider rm's are now BELT-AND-BRACES: ONNXRUNTIME_NODE_INSTALL=skip in the
# deps stage means they were never downloaded, and the deps stage asserts as much. They
# stay so that if that flag is ever defeated, the *runtime* image still cannot ship GPU
# libraries — the assert fails the build loudly, this keeps the artifact clean quietly.
#
# The darwin/win32 rm -rf is NOT redundant: those binaries are bundled in the npm tarball
# itself (not downloaded), so they survive `skip` and are ~176MB of macOS/Windows native
# code in a linux image. This is the line actually earning its keep now.
RUN rm -f node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so \
          node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/onnxruntime-node/bin/napi-v6/win32
# Security: the runtime never invokes npm (CMD is `node server.js`, the healthcheck
# runs `node -e`, and the migrate job calls node_modules/.bin/prisma directly), so
# drop the global npm CLI that the slim base ships. It vendors node-tar
# (CVE-2026-59873, CRITICAL, fixed in 7.5.19) — removing npm deletes that copy at
# its source and clears the only FIXABLE image CRITICAL, keeping the scan gate green.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER cosmos
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
