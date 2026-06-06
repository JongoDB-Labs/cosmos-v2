# syntax=docker/dockerfile:1
# --- deps ---
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build ---
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096
# NEXT_PUBLIC_APP_VERSION reads npm_package_version, which is empty under a raw
# `next build`; pass it explicitly so the sidebar version isn't "0.0.0".
ARG APP_VERSION=0.1.0
ENV npm_package_version=$APP_VERSION
COPY --from=deps /app/node_modules ./node_modules
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
RUN node -e "const fs=require('fs'),p=require('path'); const sd='.next/server', dd='.next/standalone/.next/server'; const cp=(rel)=>{const s=p.join(sd,rel),d=p.join(dd,rel); if(!fs.existsSync(s)){console.error('[instr-copy] missing source',s);return;} fs.mkdirSync(p.dirname(d),{recursive:true}); fs.copyFileSync(s,d); console.log('[instr-copy]',rel);}; cp('instrumentation.js'); const nft=p.join(sd,'instrumentation.js.nft.json'); if(fs.existsSync(nft)){for(const f of JSON.parse(fs.readFileSync(nft,'utf8')).files){cp(f.replace(/^\.\//,''));}} else {console.error('[instr-copy] no nft manifest — instrumentation hook will not run');}"
# Bake the MiniLM embeddings model (~87MB ONNX) into the build layer so the
# runtime image loads it OFFLINE (gov can't download at runtime). The cache lands
# in node_modules/@huggingface/transformers/.cache/ (resolved relative to the
# package dir) and is COPY'd into the runtime stage below.
RUN node -e "import('@huggingface/transformers').then(({pipeline})=>pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2')).then(()=>console.log('model cached')).catch(e=>{console.error(e);process.exit(1)})"

# --- migrate: one-shot job image with the FULL prisma toolchain ---
# The slim standalone runtime omits the `prisma` CLI and its hoisted deps (effect, etc.),
# so migrations run from the build stage (complete node_modules, root → no cache/home EACCES).
# Defined BEFORE runtime so that `docker build` (no --target) defaults to the app runtime.
FROM build AS migrate
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# --- runtime (standalone) — the default build target ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 HOME=/home/cosmos
# In-boundary embeddings run fully offline (gov): the MiniLM model is baked into
# the image (below), so the HF hub must never be contacted at runtime.
# OMP_NUM_THREADS=1 silences a harmless onnxruntime pthread_setaffinity_np warning.
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=1
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
# Slim onnxruntime-node for a CPU-only, linux/x64 runtime: drop the GPU execution
# providers (CUDA ~315MB + TensorRT) we never load, and the macOS/Windows native
# binaries we never run. CPU inference (linux/x64) is unaffected — verified by the
# in-container EMBED OK acceptance. Saves ~475MB.
RUN rm -f node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so \
          node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/onnxruntime-node/bin/napi-v6/win32
USER cosmos
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
