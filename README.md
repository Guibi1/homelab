# Homelab

[![test](https://github.com/fluxcd/flux2-kustomize-helm-example/workflows/test/badge.svg)](https://github.com/fluxcd/flux2-kustomize-helm-example/actions)
[![e2e](https://github.com/fluxcd/flux2-kustomize-helm-example/workflows/e2e/badge.svg)](https://github.com/fluxcd/flux2-kustomize-helm-example/actions)
[![license](https://img.shields.io/github/license/fluxcd/flux2-kustomize-helm-example.svg)](https://github.com/fluxcd/flux2-kustomize-helm-example/blob/main/LICENSE)

My GitOps Kubernetes setup using FluxCD.

## Repository structure

The Git repository contains the following top directories:

- **apps** dir contains Helm releases with a custom configuration per cluster
- **infrastructure** dir contains common infra tools such as ingress-nginx and cert-manager
- **clusters** dir contains the Flux configuration per cluster

```
├── apps
│   ├── base
│   ├── production 
│   └── staging
├── infrastructure
│   ├── configs
│   └── controllers
└── clusters
    ├── production
    └── staging
```

### Applications

The apps configuration is structured into:

- **apps/base/** dir contains namespaces and Helm release definitions
- **apps/production/** dir contains the production Helm release values
- **apps/staging/** dir contains the staging values

```
./apps/
├── base
│   └── podinfo
│       ├── kustomization.yaml
│       ├── namespace.yaml
│       ├── release.yaml
│       └── repository.yaml
├── production
│   ├── kustomization.yaml
│   └── podinfo-patch.yaml
└── staging
    ├── kustomization.yaml
    └── podinfo-patch.yaml
```

This allows production and staging environments to apply custom patches.

## Setup

```sh
kubectl create secret generic cloudflare-api-token-secret --namespace cert-manager --from-literal=api-token='YOUR_API_TOKEN'
export GITHUB_TOKEN=<your-token>
```

Verify that your cluster satisfies the prerequisites with:

```sh
flux check --pre
```

Bootstrap Flux:

```sh
flux bootstrap github \
    --context=production \
    --owner=Guibi1 \
    --repository=homelab \
    --branch=main \
    --path=clusters/production
```

## Managing

You can see all the HelmReleases' status using this command:

```console
$ watch flux get helmreleases --all-namespaces

NAMESPACE    	NAME         	REVISION	SUSPENDED	READY	MESSAGE 
cert-manager 	cert-manager 	v1.11.0 	False    	True 	Release reconciliation succeeded
ingress-nginx	ingress-nginx	4.4.2   	False    	True 	Release reconciliation succeeded
podinfo      	podinfo      	6.3.0   	False    	True 	Release reconciliation succeeded
```

Watch the pods reconciliation:

```console
$ flux get kustomizations --watch

NAME             	REVISION     	SUSPENDED	READY	MESSAGE                         
apps             	main/696182e	False    	True 	Applied revision: main/696182e	
flux-system      	main/696182e	False    	True 	Applied revision: main/696182e	
infra-configs    	main/696182e	False    	True 	Applied revision: main/696182e	
infra-controllers	main/696182e	False    	True 	Applied revision: main/696182e	
```

## Add clusters

If you want to add a cluster to your fleet, first clone your repo locally:

```sh
git clone https://github.com/${GITHUB_USER}/${GITHUB_REPO}.git
cd ${GITHUB_REPO}
```

Create a dir inside `clusters` with your cluster name:

```sh
mkdir -p clusters/dev
```

Copy the sync manifests from staging:

```sh
cp clusters/staging/infrastructure.yaml clusters/dev
cp clusters/staging/apps.yaml clusters/dev
```

You could create a dev overlay inside `apps`, make sure
to change the `spec.path` inside `clusters/dev/apps.yaml` to `path: ./apps/dev`. 

Push the changes to the main branch:

```sh
git add -A && git commit -m "add dev cluster" && git push
```

Set the kubectl context and path to your dev cluster and bootstrap Flux:

```sh
flux bootstrap github \
    --context=dev \
    --owner=${GITHUB_USER} \
    --repository=${GITHUB_REPO} \
    --branch=main \
    --personal \
    --path=clusters/dev
```

## Testing

Any change to the Kubernetes manifests or to the repository structure should be validated in CI before
a pull requests is merged into the main branch and synced on the cluster.

This repository contains the following GitHub CI workflows:

* the [test](./.github/workflows/test.yaml) workflow validates the Kubernetes manifests and Kustomize overlays with [kubeconform](https://github.com/yannh/kubeconform)
* the [e2e](./.github/workflows/e2e.yaml) workflow starts a Kubernetes cluster in CI and tests the staging setup by running Flux in Kubernetes Kind. DISABLED BECAUSE OF HOSTPATH
