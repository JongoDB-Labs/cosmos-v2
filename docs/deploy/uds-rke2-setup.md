# Deploying COSMOS on RKE2 + UDS Core

> **Living runbook** — how the COSMOS UDS-native Kubernetes platform is brought up, end to end, and how the `cosmos` Helm chart is deployed onto it. Written against a single-node lab (`cosmos-x86`, Ubuntu 24.04 VM), but the steps are the same shape for multi-node RKE2.
>
> Sections track the SP1 migration tasks: **T0** stands up the platform, **T1+** build and deploy the `cosmos` chart. The design rationale lives in `/pontis/docs/specs/2026-06-24-k8s-migration-north-star-design.md`.
>
> **Why RKE2 (not k3s/k3d):** RKE2 is Rancher's government-grade distro (CIS-hardenable, STIG'd, FIPS-capable) — the same distro DoD Big Bang / Platform One run. k3s/k3d are lighter and "just work" because they bundle a StorageClass and a LoadBalancer; RKE2 ships neither on purpose. We add them by hand below. Running the lab on RKE2 means we hit RKE2's real behavior here, not in production.

---

## T0 — Platform bring-up

### 0. Host prerequisites
- A **VM** (not an LXC container — k8s needs kernel features unprivileged LXC restricts). ≥4 vCPU (8 recommended for full UDS Core), 16–32 GiB RAM, ~100 GiB disk.
- Ubuntu 24.04, a sudo-capable user, **swap off**, `/dev/kmsg` present.

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

## T4–T7 — (appended as completed)
_Next: T4 SOPS secrets → T5 migrate hook (creates `cosmos_app` + DB-contract grants) → T6 app + Istio VirtualService + Package CR → T7 bring-up + smoke._
