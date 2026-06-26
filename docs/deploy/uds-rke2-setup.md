# Deploying COSMOS on RKE2 + UDS Core

> **Living runbook** — how the COSMOS UDS-native Kubernetes platform is brought up, end to end, and how the `cosmos` Helm chart is deployed onto it. Written against a single-node lab (`cosmos-x86`, Ubuntu 24.04 VM), but the steps are the same shape for multi-node RKE2.
>
> Sections track the SP1 migration tasks: **T0** stands up the platform, **T1+** build and deploy the `cosmos` chart. The design rationale lives in `/pontis/docs/specs/2026-06-24-k8s-migration-north-star-design.md`.
>
> **One target of many:** this runbook is RKE2 on a single VM — the *most* hands-on target by design, which is why it surfaces every platform gotcha. The [**Deployment targets**](#deployment-targets) section near the end generalizes it to cloud VMs and managed Kubernetes (EKS/AKS/GKE), grounded in the [UDS prerequisites](https://uds.defenseunicorns.com/reference/uds-core/prerequisites/).
>
> **Why RKE2 (not k3s/k3d):** RKE2 is Rancher's government-grade distro (CIS-hardenable, STIG'd, FIPS-capable) — the same distro DoD Big Bang / Platform One run. k3s/k3d are lighter and "just work" because they bundle a StorageClass and a LoadBalancer; RKE2 ships neither on purpose. We add them by hand below. Running the lab on RKE2 means we hit RKE2's real behavior here, not in production.

---

## T0 — Platform bring-up

### 0. Host prerequisites
- A **VM** (not an LXC container — k8s needs kernel features unprivileged LXC restricts). **≥4 vCPU / 16 GiB** runs the app + *slim* Core (init+core-base); **full UDS Core wants 12+ vCPU / 32+ GiB** per the [UDS prereqs](https://uds.defenseunicorns.com/reference/uds-core/prerequisites/) — size for the flavor you'll run. ~100 GiB disk.
- Ubuntu 24.04 (kernel **6.8** — UDS ambient mesh + Falco need **kernel ≥5.8** for the Modern-eBPF probes), a sudo-capable user, **swap off**, `/dev/kmsg` present.

### 1. Kernel prep
Kubernetes routes pod traffic through the host bridge + iptables, so enable forwarding and load the bridge/overlay modules (persistently):
```bash
sudo modprobe overlay && sudo modprobe br_netfilter
printf 'overlay\nbr_netfilter\n' | sudo tee /etc/modules-load.d/k8s.conf
cat <<'SYSCTL' | sudo tee /etc/sysctl.d/99-k8s.conf
net.ipv4.ip_forward=1
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
SYSCTL
sudo sysctl --system
```
(Docker is **not** required — RKE2 ships its own containerd. Docker is only needed if you ever use the k3d dev path.)

### 2. Install RKE2 (the cluster)
RKE2 config disables its bundled ingress-nginx (Istio's gateway is our ingress) and makes the kubeconfig readable:
```bash
sudo mkdir -p /etc/rancher/rke2
cat <<'CFG' | sudo tee /etc/rancher/rke2/config.yaml
write-kubeconfig-mode: "0644"
disable:
  - rke2-ingress-nginx
CFG
curl -sfL https://get.rke2.io | sudo sh -
sudo systemctl enable --now rke2-server.service          # ~2-3 min to converge
mkdir -p ~/.kube && sudo cp /etc/rancher/rke2/rke2.yaml ~/.kube/config && sudo chown "$(id -u):$(id -g)" ~/.kube/config
kubectl get nodes -o wide                                 # node should be Ready, version v1.35.x+rke2r2
```

### 3. Toolchain
Install (pin versions in your own runbook): `kubectl`, `helm`, `uds` (UDS CLI), `zarf`, `cosign`, `sops`, `age`, `kubeconform`. Tested versions for this lab: kubectl 1.36, helm 3.21, uds 0.33, zarf 0.79, cosign 3.1, sops 3.13, age 1.1, kubeconform 0.8.
> ⚠️ **Tag gotcha:** resolve "latest" by the right tag series. `zarf` moved org to `zarf-dev/zarf`. Tools like MetalLB publish both app (`v0.15.x`) and chart (`name-chart-x.y.z`) tags — `/releases/latest` can resolve to the chart tag and break a raw-manifest URL.

### 4. Storage — local-path-provisioner (RKE2 gap #1)
**RKE2 ships no default StorageClass** (k3s does). Without one, every PVC hangs (`no storage class is set`). Install local-path and make it default:
```bash
LP=$(curl -fsSI https://github.com/rancher/local-path-provisioner/releases/latest | sed -n 's@.*/tag/@@p' | tr -d '\r')
kubectl apply -f "https://raw.githubusercontent.com/rancher/local-path-provisioner/${LP}/deploy/local-path-storage.yaml"
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

### 5. UDS Core (slim) onto the existing cluster
The `k3d-core-slim-dev` *bundle* contains three Zarf packages: `uds-k3d-dev` (creates a k3d cluster — we **skip** it on RKE2), `init` (zarf bootstrap: in-cluster registry + mutating agent), and `core-base` (the slim core: Istio ambient mesh + the Pepr uds-operator). Cherry-pick the two we want:
```bash
uds deploy ghcr.io/defenseunicorns/packages/uds/bundles/k3d-core-slim-dev:1.7.0 \
  --packages init,core-base --confirm
```
> Flavors: `…/uds/core:1.7.0-**upstream**` uses upstream images; `…-**registry1**` uses **Iron Bank** hardened images (the eventual DoD/ATO path). The lab uses upstream.

### 6. LoadBalancer — MetalLB (RKE2 gap #2) + the UDS gotchas
**RKE2 has no LoadBalancer controller**, so Istio's gateways stay `<pending>` and the core deploy times out. Install MetalLB — but in a UDS/zarf cluster this surfaces two more gotchas:

```bash
# 1) Install MetalLB (pin the APP version, not the chart tag)
kubectl delete ns metallb-system --ignore-not-found
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.15.3/config/manifests/metallb-native.yaml

# 2) GOTCHA — zarf's mutating agent rewrites EVERY pod image to the in-cluster
#    registry (the airgap mechanism). MetalLB wasn't seeded there, so its image
#    pull fails. Opt the namespace out of mutation, then recreate the pods:
kubectl label ns metallb-system zarf.dev/agent=ignore --overwrite
kubectl -n metallb-system rollout restart deploy/controller ds/speaker

# 3) GOTCHA — UDS Core's Pepr policy DENIES host-network/NET_RAW and MUTATES pods
#    to run non-root. MetalLB's speaker needs all of those. Grant a narrow,
#    auditable Exemption (only cluster-admins can, in uds-policy-exemptions):
cat <<'EX' | kubectl apply -f -
apiVersion: uds.dev/v1alpha1
kind: Exemption
metadata: { name: metallb-speaker, namespace: uds-policy-exemptions }
spec:
  exemptions:
    - policies: [ DisallowHostNamespaces, RestrictHostPorts, RestrictCapabilities, RequireNonRootUser ]
      matcher: { namespace: metallb-system, name: "^speaker-.*" }
EX
kubectl -n metallb-system rollout restart ds/speaker

# 4) Hand MetalLB a pool of FREE IPs on the node's subnet (verify they're unused!)
cat <<'CRS' | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata: { name: lab-pool, namespace: metallb-system }
spec: { addresses: [ "192.168.86.240-192.168.86.245" ] }
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata: { name: lab-l2, namespace: metallb-system }
spec: { ipAddressPools: [ lab-pool ] }
CRS
```
After this, the Istio gateways get real IPs (`kubectl get svc -A | grep LoadBalancer`) — admin + tenant. The **tenant** gateway is the one application traffic (our cosmos app) rides.

### T0 result
RKE2 + slim UDS Core (Istio ambient: istiod/ztunnel/cni, the Pepr uds-operator, the zarf registry) + local-path storage + MetalLB. Verify everything is `Running`:
```bash
kubectl get pods -A | grep -v Completed
```

---

## The RKE2/UDS gotcha cheat-sheet

| # | Surprise (vs k3d) | Symptom | Fix |
|---|---|---|---|
| 1 | No default StorageClass | PVCs `Pending`, `no storage class is set` | install `local-path-provisioner`, mark default |
| 2 | No LoadBalancer controller | gateway svc `EXTERNAL-IP <pending>`, deploy times out | install MetalLB + L2 `IPAddressPool` |
| 3 | zarf agent image-rewrite | `ImagePullBackOff` from `127.0.0.1:31999/...` | label ns `zarf.dev/agent=ignore` (for manually-applied infra) |
| 4 | UDS Pepr policy **deny** | admission webhook denies host-ns / host-ports / `NET_RAW` | `Exemption` CR (DisallowHostNamespaces, RestrictHostPorts, RestrictCapabilities) |
| 5 | UDS Pepr policy **mutate** | pod runs non-root → `permission denied` reading its ConfigMap | add `RequireNonRootUser` to the Exemption |
| 6 | UDS denies `hostPath` | local-path's `helper-pod` (hostPath) denied → PVC `Pending` | `Exemption` for `helper-pod-*` (RestrictVolumeTypes, RestrictHostPathWrite, RequireNonRootUser) |
| 7 | helper-pod image rewrite | PVC `create process timeout after 120s` | also label `local-path-storage` `zarf.dev/agent=ignore` (gotcha #3, on storage) |

The lesson: UDS is **secure-by-default** — it both *denies* unsafe pod specs and *mutates* pods to harden them. Privileged platform infra needs narrow, admin-owned exemptions; this is a feature, not a bug.

---

## T1 — The `cosmos` chart scaffold

The chart lives in `charts/cosmos/`. Operators (CrunchyData PGO, MinIO) are installed cluster-wide out-of-chart; the chart ships the *instances* + the app + the UDS `Package` CR.

```
charts/cosmos/
  Chart.yaml                  # identity: version (chart) vs appVersion (cosmos release)
  values.yaml                 # config surface; images DIGEST-pinned to the signed release
  values-small.yaml           # sizing overlays — combine with -f
  values-large.yaml
  values-posture-dod.yaml     # hardening overlay (orthogonal to sizing)
  templates/_helpers.tpl      # DRY labels (define/include)
```

Validate the chart (the T1 gate):
```bash
helm lint charts/cosmos
helm template charts/cosmos | kubeconform -strict -ignore-missing-schemas -summary
```

Sizing × posture is just **values layering**, e.g.:
```bash
helm install cosmos charts/cosmos -f values-large.yaml -f values-posture-dod.yaml
```

---

## T2 — Object storage (MinIO)

A single-instance MinIO lives in the chart (`templates/minio.yaml` = Service + StatefulSet; `templates/minio-init.yaml` = bucket Job). Deploy into a `cosmos` namespace **labeled `zarf.dev/agent=ignore`** so our images pull from upstream on the connected lab (SP5/6 package them into zarf for airgap):

```bash
kubectl create ns cosmos && kubectl label ns cosmos zarf.dev/agent=ignore
# ephemeral lab creds (SOPS-managed from T4)
kubectl -n cosmos create secret generic cosmos-minio-creds \
  --from-literal=MINIO_ROOT_USER=cosmos-minio-root \
  --from-literal=MINIO_ROOT_PASSWORD="$(openssl rand -hex 16)" \
  --from-literal=S3_ACCESS_KEY=cosmos-app \
  --from-literal=S3_SECRET_KEY="$(openssl rand -hex 16)"
helm upgrade --install cosmos charts/cosmos -n cosmos --wait
```
Result: MinIO `1/1 Running` + 3 buckets (`cosmos-uploads`, `cosmos-pgbackrest`, object-locked `cosmos-audit-worm` COMPLIANCE/3650d) + the least-priv `cosmos-app` account.

### The local-path ↔ UDS storage fight (gotchas #6–#7)
Provisioning a PVC surfaces issues **on the helper pod** local-path launches to create the volume dir:
1. UDS policy **denies hostPath** + the helper runs as **root** → `Exemption` for `helper-pod-*` (RestrictVolumeTypes, RestrictHostPathWrite, RequireNonRootUser). The provisioner backs off after ~15 failures, so **delete the stuck PVC+pod** to force a fresh attempt.
2. zarf then **rewrites the helper's busybox image** → `create process timeout`; fix by labeling `local-path-storage` `zarf.dev/agent=ignore`.
3. A standard non-root snag: `mc` can't write `$HOME/.mc` as uid 1000 → give it a writable `HOME` via an `emptyDir`.

> **Our own workloads are UDS-compliant by construction** (non-root, drop-all-caps, seccomp `RuntimeDefault`) so they pass the Pepr baseline with **no exemption** — only privileged *infra* (MetalLB, local-path) needs them. In real prod, a CSI driver (cloud disks / Longhorn) sidesteps the local-path helper-pod issues entirely.

## T3 — Database (CrunchyData PGO + Postgres 16 + pgvector)

Install the PGO operator cluster-wide, then the chart's `PostgresCluster` (`templates/postgrescluster.yaml`) brings up Postgres + pgBackRest:
```bash
kubectl create ns postgres-operator && kubectl label ns postgres-operator zarf.dev/agent=ignore
helm install pgo oci://registry.developers.crunchydata.com/crunchydata/pgo -n postgres-operator
helm upgrade --install cosmos charts/cosmos -n cosmos      # adds the PostgresCluster
```
Result: `cosmos-pg-instance1-*` (4/4), `cosmos-pg-repo-host-*` (pgBackRest) + an initial backup. **pgvector is bundled** in `crunchy-postgres:ubi9-16.14` (matches compose/defcon 16.14); the `cosmos` superuser/owner role is created by PGO.

Notes / gotchas:
- **PGO operator + all Postgres pods pass the UDS Pepr baseline with NO exemption** — Crunchy images are non-root/least-priv by design (contrast with MetalLB/local-path).
- **PGO usernames can't contain `_`** (DNS-label regex) → the least-priv **`cosmos_app`** role is created by the **migrate step (T5)** as the `cosmos` superuser, where its audit/WORM grants belong anyway.
- **pgBackRest uses a local *volume* repo** for now; the MinIO-S3 repo (the `cosmos-pgbackrest` bucket) is a refinement once MinIO serves **TLS** (pgBackRest requires HTTPS for S3).

## T4 — Secrets with SOPS (encrypted in git)

`kubectl create secret` puts plaintext in your shell history and never lets the secret live in git. **SOPS** encrypts each value so the *ciphertext* is safe to commit, and only the cluster's **age** private key can decrypt it.

```bash
# 1. one-time: the cluster's age keypair — the private key stays OUT of git
#    (in prod, Flux holds it as a Secret and decrypts on reconcile)
age-keygen -o ~/.config/sops/age/keys.txt
PUB=$(age-keygen -y ~/.config/sops/age/keys.txt)

# 2. .sops.yaml binds *.enc.yaml files to that recipient (safe to commit)
cat > deploy/secrets/.sops.yaml <<EOF
creation_rules:
  - path_regex: .*\.enc\.yaml$
    age: ${PUB}
EOF

# 3. author a Secret manifest INTO the .enc.yaml name, then encrypt in-place
#    (sops matches the creation rule by the file's path — hence the naming)
sops --encrypt --in-place deploy/secrets/cosmos-app-secrets.enc.yaml

# 4. decrypt + apply (Flux/CI does this automatically; by hand for the lab)
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
sops -d deploy/secrets/cosmos-app-secrets.enc.yaml | kubectl apply -f -
```
In the committed file each value reads `SSO_VAULT_KEY: ENC[AES256_GCM,...]` — the plaintext (`SSO_VAULT_KEY`, `WORM_MANIFEST_HMAC_KEY`, `INTERNAL_ADMINS`) only ever exists in-cluster. **The age private key is the one thing you never commit.**

> Lab note: MinIO's `cosmos-minio-creds` was created ad-hoc in T2 and left as-is (re-keying live MinIO is out of scope); a clean install SOPS-manages it the same way.

## T5 — Migrate hook (`cosmos_app` + 65 migrations)

A Helm **pre-upgrade hook** (`templates/migrate-job.yaml`) reproduces the compose DB bring-up:
- **initContainer** (psql, as the `cosmos` superuser): creates the least-priv `cosmos_app` LOGIN role — ports `compose/init/01-app-role.sh`.
- **main container**: `prisma migrate deploy` as `cosmos` → applies all **65 migrations**, which themselves install **pgvector** and `cosmos_app`'s audit/WORM `GRANT`/`REVOKE`s (the `audit_immutability` migration).

```bash
# our app/migrate images are PRIVATE on GHCR → the cluster needs a pull secret
# (in airgap, zarf seeds these into the in-cluster registry — no secret needed)
kubectl -n cosmos create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<gh-user> --docker-password="$(gh auth token)"
kubectl -n cosmos patch serviceaccount default -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'

helm upgrade --install cosmos charts/cosmos -n cosmos   # the pre-upgrade hook runs the migrate
```
Result: `migrations_applied=65`, the `cosmos_app` role, `pgvector` installed, **112 public tables**.

Gotchas:
- **Private GHCR images → 401** without a pull secret (gotcha #8). MinIO/Postgres are public; ours aren't.
- **The migrate image runs as root** (the Dockerfile `migrate` stage sets no `USER`) → forced `runAsUser: 1000` for UDS + a writable `/tmp` emptyDir. Clean fix: add `USER` to the migrate stage (CI follow-up).
- **PGO requires TLS** → append `?sslmode=require` to the connection URI.

## T6 — The app (Deployment + Service)

`templates/app.yaml` — the Next.js standalone app, running as the image's **non-root `cosmos` user** (UDS-compliant, no exemption). Wired to Postgres (`cosmos_app`), MinIO (S3 over HTTP, path-style), and the SOPS secrets. A distinct **`component: web`** selector avoids colliding with MinIO's labels.

```bash
helm upgrade --install cosmos charts/cosmos -n cosmos
kubectl -n cosmos port-forward svc/cosmos 8080:3000 &
curl -s localhost:8080/api/health      # {"ok":true,"db":"up",...}
```

The one real gotcha (gotcha #9): **PGO enforces TLS with a self-signed CA**, and Prisma's query engine **verifies the chain** (compose Postgres was plaintext, so this never came up). Fix = mount PGO's CA and point Prisma at it — *verified* TLS, not cert-ignoring:
```yaml
env:
  - name: DATABASE_URL
    value: "postgresql://cosmos_app:$(COSMOS_APP_PASSWORD)@cosmos-pg-primary:5432/cosmos?sslmode=require&sslrootcert=/etc/pg-ca/ca.crt"
volumes:
  - name: pg-ca
    secret: { secretName: cosmos-pg-cluster-cert, items: [ { key: ca.crt, path: ca.crt } ] }
```
Result: `/api/health` → `{"ok":true,"db":"up"}`, both replicas healthy.

## T7 — Gateway exposure (UDS Package) + smoke ✅

`templates/uds-package.yaml` — a single UDS `Package` CR. The uds-operator reconciles it into an **Istio VirtualService** on the **tenant gateway** (`cosmos.uds.dev`) plus **default-deny NetworkPolicies** + **AuthorizationPolicies** (UDS secure-by-default). The intra-namespace `allow` rules are essential — without them the namespace default-deny would sever the app↔Postgres / app↔MinIO connections:
```yaml
spec:
  network:
    expose:
      - { service: cosmos, selector: { app.kubernetes.io/name: cosmos, app.kubernetes.io/component: web }, host: cosmos, gateway: tenant, port: 3000 }
    allow:
      - { direction: Egress,  remoteGenerated: IntraNamespace }
      - { direction: Ingress, remoteGenerated: IntraNamespace }
```
Smoke (use `--resolve` so the gateway gets the right SNI for its TLS cert):
```bash
GWIP=$(kubectl -n istio-tenant-gateway get svc tenant-ingressgateway -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -k --resolve cosmos.uds.dev:443:$GWIP https://cosmos.uds.dev/api/health   # 200 {"ok":true,"db":"up"}
```

---

## Done — the full cosmos stack runs UDS-native on RKE2

**T0 platform → T7 live app.** `https://cosmos.uds.dev` returns `200 {"ok":true,"db":"up"}`; `GET /` → `307` to login. To browse from your laptop, add `cosmos.uds.dev → <tenant-gateway-IP>` to `/etc/hosts` (or DNS).

### The complete k3d → RKE2/UDS gotcha catalog
| # | Surprise | Symptom | Fix |
|---|---|---|---|
| 1 | No default StorageClass | PVCs `Pending` | install `local-path-provisioner`, mark default |
| 2 | No LoadBalancer controller | gateway IP `<pending>` | MetalLB + L2 `IPAddressPool` |
| 3 | zarf agent rewrites images | `ImagePullBackOff` from `127.0.0.1:31999` | `zarf.dev/agent=ignore` on infra namespaces |
| 4 | UDS Pepr policy **deny** | host-ns / NET_RAW denied | `Exemption` CR in `uds-policy-exemptions` |
| 5 | UDS Pepr policy **mutate** | forced non-root → file `permission denied` | add `RequireNonRootUser` to the Exemption |
| 6 | UDS denies `hostPath` | local-path helper pod blocked → PVC `Pending` | `Exemption` for `helper-pod-*` |
| 7 | helper-pod image rewrite | PVC `create process timeout` | zarf-ignore `local-path-storage` |
| 8 | private GHCR images → 401 | app/migrate `ImagePullBackOff` | `imagePullSecret` on the namespace default SA |
| 9 | PGO self-signed TLS, Prisma verifies | `self-signed certificate in certificate chain` | mount PGO CA + `?sslmode=require&sslrootcert=…` |
| 10 | Batch Jobs hang on `cosmos-pg-primary` | migrate hook / ops Jobs hang `waiting for postgres…` | **symptom of #11** — degraded Patroni left the *primary* Service with no endpoint; the `KubeAPI` allow fixes it (it was never an ambient-mesh issue, as first assumed) |
| 11 | PGO/Patroni needs **`KubeAPI`** egress | PG `database` CrashLoopBackOff after a restart — Patroni *"No more API server nodes"*; also a chronic `3/4` pod | add `- { direction: Egress, remoteGenerated: KubeAPI }` to the Package `allow` — Patroni uses the kube API as its DCS |
| 12 | RKE2 already ships metrics-server | UDS `core-metrics-server` deploy fails: APIService `v1beta1.metrics.k8s.io` *"cannot be imported"* (owned by `rke2-metrics-server`) | **skip the layer** — `kubectl top` already works via RKE2's; `uds zarf package remove core-metrics-server --confirm` |

The throughline: **UDS is secure-by-default** (deny + mutate + default-deny netpol). Privileged *infra* (MetalLB, local-path) needs narrow exemptions; well-behaved *workloads* (MinIO, Postgres, the app) pass clean. That's the whole point — and the lab made every one of these failures visible, which is exactly why we run RKE2 here instead of k3d. Detailed **Symptom → Diagnose → Fix** for each (plus the post-reboot recovery procedure) is in the [Troubleshooting playbook](#troubleshooting-playbook) below.

---

## Deployment targets

**What's portable, what's platform-specific.** Everything from **T1 onward is portable** — the `cosmos` Helm chart, the UDS `Package` CR, PGO, MinIO, the migrate hook all run unchanged on any [CNCF-conformant Kubernetes that isn't EOL](https://uds.defenseunicorns.com/reference/uds-core/prerequisites/): RKE2, K3s, **EKS, AKS, GKE**. What changes per target is the **platform layer beneath UDS Core** — storage, load-balancing, DNS/TLS, CNI, kernel. That's all the T0 bring-up and the gotcha catalog really are: on a bare RKE2 VM you supply that layer by hand; managed clouds supply most of it for you.

Read UDS Core's own prerequisites first for any target — they *define* this platform layer:
[Prerequisites](https://uds.defenseunicorns.com/reference/uds-core/prerequisites/) · [Distribution support](https://uds.defenseunicorns.com/reference/uds-core/distribution-support/) · [Deployment flavors](https://uds.defenseunicorns.com/reference/deployment/flavors/) · [Production overview](https://docs.defenseunicorns.com/core/getting-started/production/overview/)

| Platform capability (UDS prereq) | Baremetal / on-prem VM *(our lab)* | Self-managed cloud VM (EC2, Azure VM) | Managed Kubernetes (EKS / AKS / GKE) |
|---|---|---|---|
| **Default StorageClass** (dynamic PVs) | you provide — `local-path`, Longhorn, Ceph/Rook *(gotcha #1)* | same, or run the cloud CSI driver yourself | **built-in** (gp3 / Azure Disk / PD); set `allowVolumeExpansion` |
| **LoadBalancer** for the Istio gateway | **MetalLB / kube-vip** *(gotcha #2)* | MetalLB, or wire the cloud LB controller | **built-in** cloud LB (AWS LB Controller / Azure / GCP) |
| **Wildcard DNS + TLS** | run DNS + bring certs (lab faked SNI with `--resolve`) | Route 53 / Azure DNS + ACME | cloud DNS + ACM / Key Vault / Google-managed certs |
| **CNI with NetworkPolicy** | RKE2 Canal (built-in) | same | EKS: VPC-CNI policy add-on or Cilium; AKS: Azure-CNI / Cilium |
| **Object storage** (Loki, Velero, app S3) | **MinIO** in-cluster *(we deploy it)* | MinIO, or the cloud bucket | **S3 / Blob / GCS** + workload identity ([IRSA on EKS](https://uds.defenseunicorns.com/reference/configuration/external-dependencies/irsa-configuration/)) |
| **Keycloak DB** (production) | external Postgres / PGO | managed PG (RDS / Flexible Server) | RDS / Azure DB / Cloud SQL |
| **metrics-server** | UDS ships it | UDS ships it | often already present (GKE/AKS) — disable UDS's copy to avoid conflict |
| **Kernel ≥5.8** (ambient + Falco eBPF) | you own the node (Ubuntu 24.04 = 6.8 ✓) | same | managed node images already satisfy it |

**The throughline:** the further up the managed-service ladder you climb, the more of the T0 + gotcha work the platform does for you. A bare RKE2 VM is the *most* hands-on target — which is exactly why this lab surfaced every gotcha. On EKS/AKS, storage + LB + DNS + metrics-server are handed to you, so a UDS Core deploy there **skips gotchas #1, #2, #6, #7**; the UDS-layer behaviors (secure-by-default policy, default-deny netpols, the ambient mesh — gotchas #3–#5, #10/#11) and the app-layer ones (#8, #9) are **identical everywhere**. Choose the target by how much platform you want to own — not by any difference in the app.

> **Airgap:** the cloud columns assume connectivity. Disconnected/airgap (the DoD case) keeps the *same* chart + Package — Zarf just seeds the images into an in-cluster registry first. That's SP6.

---

## Postscript — gotcha #10, root-caused (and the lesson)

The first pass at this lab **misdiagnosed gotcha #10.** Batch Jobs (the migrate pre-upgrade hook, the SP3 ops Jobs) hung on `cosmos-pg-primary` with `waiting for postgres…`, and — because the namespace is in the ambient mesh — I assumed the mesh was blocking short-lived pods, parked SP3, and blamed the 4-vCPU lab. Opting Jobs out of the mesh didn't help, which in hindsight was the tell.

The actual cause was **gotcha #11**: the `Package` never allowed **`KubeAPI`** egress, so PGO/Patroni couldn't reach the API server to run leader election. A degraded Patroni leaves the `cosmos-pg-primary` Service **with no primary endpoint** — so *anything* opening a fresh connection to it (Jobs *and* the app) hangs. It looked like a mesh problem; it was a missing netpol allow. Adding `remoteGenerated: KubeAPI` fixed **both #10 and #11 in one line**: Postgres went `4/4`, the migrate hook now completes in seconds, `helm upgrade` is healthy, and **SP3 is unblocked**.

**The lesson** (and why "reference the docs" mattered): the symptom pointed at the most recently-touched layer — the ambient mesh — but the [UDS Packages CR docs](https://uds.defenseunicorns.com/reference/configuration/custom-resources/packages-v1alpha1-cr/) name `KubeAPI` as a first-class egress target and explicitly call out Patroni-style DCS workloads. Reading that beat another round of reverse-engineering. **Under a default-deny mesh, enumerate every egress a workload needs from its docs** — for PGO that's intra-namespace *and* the kube API (`KubeAPI`), and for cloud object storage it'd add `CloudMetadata`/`Anywhere`.

The VM resize to 12 vCPU / 32+ GiB was still the right call — it's the documented floor for **full UDS Core (SP2)**, and the reboot it required is exactly what surfaced the latent `KubeAPI` bug. SP1 runs green; on to SP2.

---

## SP2 — full UDS Core (SSO, runtime-security, observability)

With the cluster resized, the remaining UDS Core **functional layers** go on top of `core-base`. UDS Core ships them as **separate OCI Zarf packages**, all released together — pin every layer to the **same version as `core-base`** (here `1.7.0-upstream`) or risk CRD/operator drift. Deploy incrementally, in dependency order:

```bash
for L in core-identity-authorization core-runtime-security core-monitoring; do
  uds zarf package deploy oci://ghcr.io/defenseunicorns/packages/uds/$L:1.7.0-upstream --confirm
done
```

| Layer | Deploys | Notes |
|---|---|---|
| `core-identity-authorization` | **Keycloak 26 + Authservice** | SSO foundation — **required** by the console layers |
| `core-runtime-security` | **Falco** | runtime threat detection (the ConMon signal). UDS Core 1.7 **replaced NeuVector with Falco** — the deploy even removes legacy NeuVector CRDs |
| `core-monitoring` | **kube-prometheus-stack** (Prometheus / Alertmanager / node + kube-state metrics) + **Grafana** | metrics + dashboards |
| `core-metrics-server` | — | **skipped — gotcha #12**: RKE2 already ships one |

Dependency order matters: `base` → `identity-authorization` → the rest (monitoring & runtime-security SSO their consoles through Keycloak). `core-logging` (Loki) and `core-backup-restore` (Velero) are **deferred** — both need an S3/MinIO-Operator backend (a later slice).

UDS **auto-exposes each console on the admin gateway, SSO-protected by Keycloak** — no manual wiring:

| Console | URL | Gateway |
|---|---|---|
| Keycloak admin | `https://keycloak.admin.uds.dev` | admin (`192.168.86.240`) |
| Grafana | `https://grafana.admin.uds.dev` | admin |
| Keycloak SSO | `https://sso.uds.dev` | tenant |
| cosmos app | `https://cosmos.uds.dev` | tenant (`192.168.86.241`) |

Browse from a laptop by adding both gateway IPs to `/etc/hosts`:
```
192.168.86.240  keycloak.admin.uds.dev grafana.admin.uds.dev
192.168.86.241  cosmos.uds.dev sso.uds.dev
```

**Verify:** every UDS `Package` reports `Ready`; `kubectl top nodes` returns data (RKE2 metrics-server); `https://cosmos.uds.dev/api/health` still `db:up` (the new layers' default-deny netpols don't touch the cosmos app — it has its own Package allow-list).

**Still open for SP2:** wire the **cosmos app itself** to authenticate via Keycloak (the app's OIDC IdP → a Keycloak client). That's app-level SSO, distinct from the auto-SSO'd UDS consoles, and ties into the runtime SSO toggle (SP8).

---

## SP3 — gov audit/compliance ops (CronJobs)

The compliance controls run as **CronJobs on the migrate image** (it already carries `scripts/dsop/*`), as the least-priv `cosmos_app` role over the same verified PGO TLS as the app. `component: ops` labels (no `instance`) keep these pods out of MinIO's Service selector; DB connectivity rides the Package's `IntraNamespace` + `KubeAPI` allows — **no mesh opt-out needed** (that was the gotcha-#10 red herring; once Patroni can elect a primary, batch→PG just works).

**`verify-audit-chain`** (AU-9 tamper-evidence) — every 6h, runs the in-DB `verify_audit_chain()` over `audit_logs` + `egress_decisions` and exits non-zero on any broken hash-chain link:
```bash
kubectl -n cosmos create job vac --from=cronjob/verify-audit-chain   # run on demand
# → audit_logs INTACT · egress_decisions INTACT · allIntact:true
```

**`purge-audit`** (AU-11 retention) and **`rotate-vault-key`** are **on-demand admin ops**, not scheduled — same migrate-image + least-priv pattern, triggered manually:
```bash
# purge-audit: the ONE legitimate path that DELETES audit rows older than the
# retention floor (gov floor ≥1095d, guarded), after the WORM exporter has archived
# them — destructive; needs the owner role + --worm-toseq coordination.
node scripts/dsop/purge-audit.mjs --table audit_logs --retention-days 1095
# rotate-vault-key: re-wrap SSO secrets to the active keyring kid (needs SSO_VAULT_KEYS).
node scripts/dsop/rotate-vault-key.mjs
```
Wire these as **suspended CronJobs** for a real deployment (provide WORM S3 creds + the keyring) so an admin triggers them with `kubectl create job --from=cronjob/<name>`. Left out of the lab chart on purpose — `purge-audit` would delete the very hash-chain we just verified.

> **Note:** `pg`/`pg-connection-string` now treats `sslmode=require` as `verify-full` — which is exactly what we want here (the CA is mounted, so full verification passes). The deprecation warning is harmless; pin `sslmode=verify-full` explicitly when the chart moves to pg v9.

---

## SP4 — signed OCI Helm chart (supply chain)

The chart is the k8s delivery artifact, so it gets the **same gov-grade signing as the images**. `release.yml`'s `chart` job runs after the image `merge` on a `vX.Y.Z` tag and:
1. **pins** the chart to the exact image digests this release just built (`yq` rewrites `image.app/migrate.digest` — the chart ships the images that were scanned + signed),
2. `helm package` → `helm push` to `oci://ghcr.io/<owner>/charts/cosmos:<version>`,
3. **signs** it — cosign keyless (OIDC → Fulcio/Rekor) always, KMS additionally when `COSIGN_KEY` is set,
4. attaches a **SLSA provenance** attestation, and
5. a **verify-after-sign gate** fails the release if the signature isn't verifiable (no green-but-unsigned chart).

Tag → digest → signature is now unbroken from image to chart, so an airgap UDS/Zarf bundle (SP6) can verify the whole set offline. **Verify a chart before deploying:**
```bash
cosign verify \
  --certificate-identity-regexp "^https://github.com/JongoDB-Labs/cosmos-v2/" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/jongodb-labs/charts/cosmos@<digest>
helm install cosmos oci://ghcr.io/jongodb-labs/charts/cosmos --version <X.Y.Z> -n cosmos
```
> Exercised only on a real `vX.Y.Z` release tag (the user cuts releases), so it's not yet run live. Validated as far as possible offline: the chart lints + packages clean, the workflow is valid YAML, and every new `uses:` is SHA-pinned so the `security.yml` config gate passes.

---

## SP5 — Zarf airgap package

`deploy/airgap/zarf.yaml` packages the cosmos chart + its 7 images into a single tarball for disconnected delivery:
```bash
zarf package create deploy/airgap                                  # pull images + chart → tarball (needs GHCR auth)
zarf package deploy zarf-package-cosmos-2.102.2-amd64.tar.zst      # seed images + install chart
```
On deploy the zarf agent rewrites every image ref to the **in-cluster registry**, so **gotcha #8 (the GHCR pull-secret) disappears in airgap** — zarf seeds the images, nothing to authenticate.

Images carried: app + migrate (digest-pinned to the signed release), MinIO + `mc`, `postgres:16-alpine` (the migrate init), and the two Crunchy images the PostgresCluster pulls (`crunchy-postgres` + `crunchy-pgbackrest`). `zarf dev lint` passes; the three upstream images are tag-pinned (a hardened `registry1`/Iron-Bank flavor would digest-pin all of them).

**Target-cluster prereqs** (bundled together in SP6): UDS Core, CrunchyData PGO, and the cosmos secrets (provided out-of-band — SOPS/Flux; not baked into the package). Production points the chart at the **signed OCI chart** (SP4) so the airgap deploy verifies its signature before install.

---

## SP6 — UDS bundle (the airgap deliverable)

`deploy/airgap/uds-bundle.yaml` composes the **entire stack** into one tarball — the DoD disconnected-delivery milestone:
```bash
uds create deploy/airgap                                          # every package's images → one bundle
uds deploy uds-bundle-cosmos-stack-2.102.2-*.tar.zst --confirm    # deploy the whole stack offline
```
Package order = deploy order: zarf `init` → `core-base` → `core-identity-authorization` (Keycloak) → `core-runtime-security` (Falco) + `core-monitoring` → `cosmos`. This is exactly the SP2 layer sequence, now bundled with the app. Every UDS Core layer is pinned to `1.7.0` (mismatched layers drift — SP2's lesson); `upstream` flavor for the lab, `registry1` (Iron Bank) for a hardened ATO build.

**One piece still to package:** CrunchyData PGO. The cosmos chart creates a `PostgresCluster` the PGO operator reconciles, so a PGO Zarf package belongs between `core-base` and `cosmos` (PGO ships as a Helm chart — wrap its operator image + CRDs in a `zarf.yaml`). Until then PGO is a documented prereq. With it added, `uds deploy` brings up the full COSMOS platform on a disconnected cluster from a single signed tarball — SP1→SP2→SP5→SP6, the airgap critical path, complete.

---

## Troubleshooting playbook

Every failure this lab hit, as **Symptom → Diagnose → Fix** with commands. Numbers map to the gotcha catalog. Triage by layer: is it the *platform*, UDS's *secure-by-default* posture, the *app/DB*, or *post-reboot recovery*?

### Platform layer — self-managed only (EKS/AKS/GKE provide these)

**#1 · PVCs stuck `Pending`**
- *Diagnose:* `kubectl get pvc -A` shows `Pending`; `kubectl get storageclass` returns nothing default.
- *Fix:* install `local-path-provisioner`, then `kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'`.

**#2 · Gateway `EXTERNAL-IP` stuck `<pending>`**
- *Diagnose:* `kubectl -n istio-tenant-gateway get svc` → `<pending>`; no LoadBalancer controller on the cluster.
- *Fix:* install MetalLB + an L2 `IPAddressPool` + `L2Advertisement` over a free LAN range.

**#6 / #7 · local-path PVC never binds under UDS**
- *Diagnose:* `kubectl -n local-path-storage get events` shows a Pepr deny on the `helper-pod-*` hostPath, or the helper is stuck `create process timeout` (zarf rewrote its busybox image).
- *Fix:* an `Exemption` for `helper-pod-*` (RestrictVolumeTypes / RestrictHostPathWrite) **and** `kubectl label ns local-path-storage zarf.dev/agent=ignore`; then delete the stuck PVC + helper pod to retrigger provisioning.

**#12 · UDS `core-metrics-server` won't install**
- *Diagnose:* `uds zarf package deploy …core-metrics-server` errors — APIService `v1beta1.metrics.k8s.io` *"cannot be imported"* (already owned by `rke2-metrics-server` in kube-system). The distro ships its own.
- *Fix:* skip the layer — `kubectl top nodes` already works via RKE2's. Clean the failed release: `uds zarf package remove core-metrics-server --confirm`.

### UDS secure-by-default — identical on every target

**#3 · `ImagePullBackOff` from `127.0.0.1:31999`**
- *Diagnose:* the zarf mutating agent rewrote a pod image to the in-cluster registry in a namespace that shouldn't be mutated.
- *Fix:* `kubectl label ns <ns> zarf.dev/agent=ignore`, then recreate the pods.

**#4 / #5 · Pod denied, or crashes as forced-non-root**
- *Diagnose:* `kubectl get events` shows admission denied for host-namespace / hostPort / NET_RAW, **or** a privileged infra pod crashes on a file `permission denied` after UDS mutated it to non-root.
- *Fix:* an `Exemption` CR in `uds-policy-exemptions` naming the exact policies (`DisallowHostNamespaces`, `RestrictHostPorts`, `RestrictCapabilities`, **`RequireNonRootUser`**, …), scoped to that one workload — never blanket.

**#10 / #11 · Anything hitting Postgres hangs; PG `database` CrashLoopBackOff (the big one)**
- *Symptom:* `psql … → "waiting for postgres…"` forever (migrate hook, ops Jobs); PG pod chronic `3/4`; after any restart the `database` container crash-loops.
- *Diagnose:* `kubectl -n cosmos logs <pg-pod> -c database` → Patroni `K8sConnectionFailed('No more API server nodes')` / `ReadTimeoutError … 10.43.0.1:443`. Patroni can't reach the kube API (its DCS) → no elected leader → the `cosmos-pg-primary` Service has **no endpoint** → every fresh connection to it hangs.
- *Fix (live, no helm upgrade):* `kubectl -n cosmos patch package cosmos --type=json -p '[{"op":"add","path":"/spec/network/allow/-","value":{"direction":"Egress","remoteGenerated":"KubeAPI"}}]'`, then restart PG (`kubectl -n cosmos delete pod <pg-pod>`). Bake `- { direction: Egress, remoteGenerated: KubeAPI }` into the Package template so it persists.
- *Lesson:* under a default-deny mesh, enumerate **every** egress a workload needs from its docs — PGO needs `IntraNamespace` **and** `KubeAPI`. The symptom (mesh) was not the cause (missing netpol allow).

### App / database layer

**#8 · app or migrate `ImagePullBackOff` (401 from GHCR)**
- *Diagnose:* private `ghcr.io/...` image with no pull secret.
- *Fix:* `kubectl -n cosmos create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<user> --docker-password="$(gh auth token)"`, then add it to the namespace default ServiceAccount's `imagePullSecrets`. (Airgap: zarf seeds the images — no secret needed.)

**#9 · app `db:down`, `self-signed certificate in certificate chain`**
- *Diagnose:* Prisma verifies TLS and PGO presents its own CA.
- *Fix:* mount `cosmos-pg-cluster-cert/ca.crt` and append `?sslmode=require&sslrootcert=/etc/pg-ca/ca.crt` to `DATABASE_URL` / `DIRECT_URL`.

### Recovery — after a host reboot

A hard reboot restarts everything at once; on a single node the ambient mesh + PGO can lose the startup race. Expected, and recoverable:

1. **Wait ~2–3 min.** RKE2 → CoreDNS → the Istio data-plane (`istiod` / `ztunnel` / `istio-cni`) and Pepr must be up first. Confirm: `kubectl -n istio-system get pods` and `kubectl -n pepr-system get pods` all `1/1`.
2. **Restart workloads that lost the race** (PVCs/data untouched — StatefulSets recreate same-named pods): `kubectl -n cosmos delete pod <pg-instance-pod> minio-0`.
3. **App** recovers once the DB is back; clear its crash-loop backoff with `kubectl -n cosmos rollout restart deployment cosmos`.
4. If PG keeps crash-looping, it's **#10/#11** — confirm the egress allow exists: `kubectl -n cosmos get netpol | grep kubeapi`.
5. **Verify end-to-end:** `curl -k --resolve cosmos.uds.dev:443:<gw-ip> https://cosmos.uds.dev/api/health` → `{"ok":true,"db":"up"}`.
