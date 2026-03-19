---
title: "Secrets Management for GitOps: A Deep Dive into External Secrets Operator"
date: 2026-03-19
description: "A practical guide to managing secrets in GitOps workflows using External Secrets Operator. Learn how SecretStores, ExternalSecrets, and PushSecrets bridge the gap between external secret providers and Kubernetes, and how ESO integrates with Argo CD for secure, automated secret delivery."
image: /blog/images/eso-logo.svg
ogBackground: dark
tags:
  - kubernetes
  - gitops
  - secrets
  - argo-cd
  - external-secrets-operator
---

<div class="blog-hero">
  <img src="/blog/images/eso-logo.svg" alt="External Secrets Operator logo" width="200" style="display: inline-block;">
</div>

If you have been following my previous posts, you should have a solid GitOps foundation. Git is your source of truth, Argo CD reconciles your clusters, Kargo promotes changes between environments, and Argo Rollouts handles progressive delivery. But there is one topic we have not addressed yet, and it is probably the one that causes the most anxiety: secrets.

Every Kubernetes application needs credentials. Database passwords, API keys, TLS certificates, OAuth tokens. In a GitOps world, everything is supposed to live in Git, but you obviously cannot commit plaintext secrets to a repository. This tension between "everything in Git" and "secrets must be protected" is the fundamental challenge of GitOps secrets management, and it is exactly what External Secrets Operator solves.

## The Problem with Secrets in GitOps

Before diving into External Secrets Operator, it is worth understanding why secrets are so awkward in GitOps workflows.

Kubernetes has a native Secret resource, but it only base64-encodes values rather than encrypting them. Committing a base64-encoded Secret to Git is effectively the same as committing the plaintext value. Anyone with repository access can decode it instantly.

Teams have tried various workarounds over the years. Some encrypt secrets in Git using tools like Sealed Secrets or SOPS. Others inject secrets during the CI/CD pipeline using vault plugins. Both approaches work, but they come with tradeoffs. Sealed Secrets requires per-cluster encryption keys and does not scale well across many clusters. Pipeline-based injection means Argo CD needs direct access to your secret store, which the Argo CD documentation itself [recommends against](https://argo-cd.readthedocs.io/en/stable/operator-manual/secret-management/).

The approach that the Kubernetes ecosystem has converged on is operator-based secret management: a controller running in your cluster that synchronizes secrets from an external provider into native Kubernetes Secrets. External Secrets Operator is the leading implementation of this pattern, and it is now a CNCF project.

## What is External Secrets Operator?

External Secrets Operator (ESO) is a Kubernetes operator that reads secrets from external APIs and creates Kubernetes Secret resources automatically. It supports over 40 secret providers, including AWS Secrets Manager, HashiCorp Vault, Google Cloud Secret Manager, Azure Key Vault, 1Password, Doppler, and many more.

The key insight behind ESO is separation of concerns. Your Git repository contains ExternalSecret resources that describe *what* secrets your application needs and *where* to find them, but never the secret values themselves. The operator running in your cluster handles the actual retrieval and creates the corresponding Kubernetes Secrets at runtime.

This means your Git repositories stay clean. Argo CD syncs the ExternalSecret manifests like any other Kubernetes resource. ESO watches those ExternalSecrets and populates the actual Secret objects. Your applications consume native Kubernetes Secrets as usual, completely unaware that ESO is involved.

## Core Resources

ESO introduces a small set of custom resources that model the entire secrets lifecycle. Understanding these resources is essential to working with the operator effectively.

### SecretStore and ClusterSecretStore

A SecretStore defines how to connect to an external secret provider. It contains the authentication configuration, the provider type, and any connection-specific settings. SecretStore is namespace-scoped, meaning each namespace can have its own store with its own credentials.

Here is a SecretStore configured for AWS Secrets Manager:

```yaml
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: aws-secrets
  namespace: my-app
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        secretRef:
          accessKeyIDSecretRef:
            name: aws-credentials
            key: access-key-id
          secretAccessKeySecretRef:
            name: aws-credentials
            key: secret-access-key
```

If you prefer a single store that serves the entire cluster, ClusterSecretStore does exactly that. It is cluster-scoped and can be referenced by ExternalSecrets in any namespace. This is useful when a platform team manages the provider credentials centrally and application teams just consume secrets.

```yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.example.com"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
```

This ClusterSecretStore authenticates to HashiCorp Vault using Kubernetes service account authentication, which avoids storing any long-lived credentials. The Vault server validates the service account token and issues a short-lived Vault token scoped to the configured role.

### ExternalSecret

The ExternalSecret is the core resource that application teams interact with. It declares what data to fetch from the external provider and how to map it into a Kubernetes Secret.

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: my-app-db-credentials
  namespace: my-app
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets
    kind: SecretStore
  target:
    name: db-credentials
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: prod/my-app/database
        property: username
    - secretKey: password
      remoteRef:
        key: prod/my-app/database
        property: password
```

This ExternalSecret tells ESO to fetch the `username` and `password` properties from the `prod/my-app/database` secret in AWS Secrets Manager, and create a Kubernetes Secret named `db-credentials` with those values. The `refreshInterval` of one hour means ESO will re-fetch the values periodically, so if someone rotates the database password in AWS Secrets Manager, the Kubernetes Secret updates automatically within an hour.

The `creationPolicy: Owner` setting means the ExternalSecret owns the resulting Kubernetes Secret. If you delete the ExternalSecret, the Secret gets cleaned up too. You can also use `Orphan` if you want the Secret to persist after the ExternalSecret is removed, or `Merge` if you want ESO to add keys to an existing Secret without taking ownership.

### ClusterExternalSecret

For platform teams that need to distribute the same secret across multiple namespaces, ClusterExternalSecret is the answer. It is a cluster-scoped resource that creates ExternalSecret resources in target namespaces based on a selector.

```yaml
apiVersion: external-secrets.io/v1
kind: ClusterExternalSecret
metadata:
  name: shared-tls-cert
spec:
  namespaceSelectors:
    - matchLabels:
        needs-tls: "true"
  externalSecretSpec:
    refreshInterval: 24h
    secretStoreRef:
      name: vault-backend
      kind: ClusterSecretStore
    target:
      name: tls-cert
    data:
      - secretKey: tls.crt
        remoteRef:
          key: shared/tls/wildcard
          property: certificate
      - secretKey: tls.key
        remoteRef:
          key: shared/tls/wildcard
          property: private_key
```

Every namespace with the label `needs-tls: "true"` gets an ExternalSecret that fetches the wildcard TLS certificate from Vault. When a new namespace is created with that label, the ClusterExternalSecret controller automatically creates the ExternalSecret in that namespace.

### PushSecret

While ExternalSecret pulls secrets from external providers into Kubernetes, PushSecret does the reverse. It takes an existing Kubernetes Secret and pushes it to an external provider. This is useful for bootstrapping scenarios or when a Kubernetes-native process generates credentials that need to be stored externally.

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-generated-cert
  namespace: cert-manager
spec:
  refreshInterval: 10m
  secretStoreRefs:
    - name: aws-secrets
      kind: SecretStore
  selector:
    secret:
      name: wildcard-tls
  data:
    - match:
        secretKey: tls.crt
        remoteRef:
          remoteKey: infra/tls/wildcard
          property: certificate
    - match:
        secretKey: tls.key
        remoteRef:
          remoteKey: infra/tls/wildcard
          property: private_key
```

In this example, cert-manager generates a TLS certificate and stores it as a Kubernetes Secret. PushSecret picks it up and writes the certificate and private key to AWS Secrets Manager, where other systems outside the cluster can access it.

## Installing External Secrets Operator

ESO installs via Helm, which makes it straightforward to manage with Argo CD:

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace
```

In a GitOps workflow, you would define this as an Argo CD Application pointing at the Helm chart rather than running the command manually. This ensures ESO itself is managed declaratively.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-secrets
  namespace: argocd
spec:
  project: infrastructure
  source:
    repoURL: https://charts.external-secrets.io
    chart: external-secrets
    targetRevision: 2.1.0
    helm:
      values: |
        installCRDs: true
        serviceAccount:
          annotations:
            eks.amazonaws.com/role-arn: arn:aws:iam::123456789:role/external-secrets
  destination:
    server: https://kubernetes.default.svc
    namespace: external-secrets
  syncPolicy:
    automated: {}
    syncOptions:
      - CreateNamespace=true
```

This Application deploys ESO with IRSA (IAM Roles for Service Accounts) on EKS, so the operator authenticates to AWS using its service account rather than static credentials.

## Templating Secrets

One of ESO's more powerful features is secret templating. Instead of using the raw values from the external provider, you can transform them using Go templates before they land in the Kubernetes Secret.

This is particularly useful for constructing connection strings or configuration files from individual secret values:

{% raw %}
```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: database-url
  namespace: my-app
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets
    kind: SecretStore
  target:
    name: database-config
    template:
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:5432/{{ .dbname }}?sslmode=require"
  data:
    - secretKey: username
      remoteRef:
        key: prod/database
        property: username
    - secretKey: password
      remoteRef:
        key: prod/database
        property: password
    - secretKey: host
      remoteRef:
        key: prod/database
        property: host
    - secretKey: dbname
      remoteRef:
        key: prod/database
        property: dbname
```
{% endraw %}

The resulting Kubernetes Secret contains a single `DATABASE_URL` key with the fully constructed connection string. Your application only needs to read one environment variable instead of assembling the URL itself.

Templating also supports creating non-opaque secret types. You can set the `type` field in the template to create Secrets of type `kubernetes.io/tls`, `kubernetes.io/dockerconfigjson`, or any other Kubernetes secret type.

## Refresh Policies

ESO offers three refresh policies that control when secrets are synchronized from the external provider.

**Periodic** is the default. The `refreshInterval` field controls how often ESO re-fetches the secret values. Set this based on how frequently your secrets change and how quickly you need rotations to propagate. A one-hour interval is reasonable for most workloads. For high-security environments where credential rotation happens frequently, you might reduce it to minutes.

**CreatedOnce** fetches the secret values once when the ExternalSecret is created and never updates them. This is useful for immutable credentials like encryption keys that should not change after initial provisioning.

**OnChange** only refreshes when the ExternalSecret resource itself is modified. This gives you explicit control over when secrets are re-fetched, which can be useful if you want to tie secret updates to your GitOps deployment workflow.

## Integration with Argo CD

ESO integrates naturally with Argo CD because ExternalSecrets are standard Kubernetes custom resources. Argo CD manages ExternalSecret manifests the same way it manages Deployments or Services. When Argo CD syncs an application that includes ExternalSecret resources, the ESO controller detects them and creates the corresponding Kubernetes Secrets.

From Argo CD's perspective, the ExternalSecret resource goes through its normal sync lifecycle. Argo CD does not need access to the secret provider because it never touches the actual secret values. The ESO controller, running independently in the cluster, handles all communication with the external provider.

This separation is exactly what the Argo CD documentation recommends. Argo CD manages the declarative intent (the ExternalSecret), while ESO handles the operational concern of fetching and synchronizing the actual credentials. Argo CD's repo-server and Redis cache never see the secret values, which significantly reduces the attack surface.

For health checking, ESO sets status conditions on ExternalSecret resources that Argo CD can interpret. A healthy ExternalSecret shows `SecretSynced: True` in its status. If the secret cannot be fetched, for example due to a permissions error or a missing secret in the provider, the status reflects the failure and Argo CD reports the resource as degraded.

## Multi-Environment Secrets with Kargo

If you are using [Kargo for promotion pipelines](/blog/kargo/), ExternalSecrets fit seamlessly into the model. Each environment has its own SecretStore (or references a ClusterSecretStore with environment-specific paths), and the ExternalSecrets in each environment's manifests point to the appropriate secret paths.

When Kargo promotes an application from staging to production, the promotion steps update the manifests in Git. The ExternalSecrets in those manifests already reference the correct paths for each environment because they are part of your Kustomize overlays or Helm values. ESO in the production cluster fetches the production secrets from the provider. No secret values flow through the promotion pipeline.

A typical structure looks like this:

```
environments/
  base/
    external-secret.yaml    # Template with placeholder paths
  staging/
    kustomization.yaml      # Patches secret paths to staging/
  production/
    kustomization.yaml      # Patches secret paths to production/
```

The base ExternalSecret defines the structure. The overlays patch the `remoteRef.key` values to point to the correct paths in the secret provider for each environment. Kargo promotes the image tag and configuration changes, while the secret paths are already correct for each environment by virtue of the overlay structure.

## Security Best Practices

Running ESO securely requires attention to a few key areas.

**Use workload identity when possible.** On EKS, GKE, and AKS, you can authenticate to the secret provider using the pod's service account rather than static credentials. This eliminates the need to store provider credentials as Kubernetes Secrets, which would be a circular problem. IRSA on EKS, Workload Identity on GKE, and Azure Workload Identity all integrate directly with ESO.

**Scope access narrowly.** The IAM role or Vault policy that ESO uses should have read-only access to only the secret paths it needs. If you are using ClusterSecretStore, be aware that any namespace can reference it. Consider using namespace-scoped SecretStores for sensitive secrets and ClusterSecretStore only for truly shared credentials.

**Set appropriate refresh intervals.** Shorter intervals mean faster propagation of rotated credentials, but they also increase the load on your secret provider. One hour is a good default. For secrets that are rotated by an automated process, match the refresh interval to the rotation window.

**Monitor ExternalSecret status.** ESO emits events and sets status conditions on ExternalSecret resources. Set up alerting on `SecretSyncedError` conditions so you know immediately if a secret cannot be fetched. A missing secret in production usually means an application is running with stale or missing credentials.

**Audit access to the secret provider.** ESO's access to your secret provider should be visible in the provider's audit logs. AWS CloudTrail, Vault audit logs, and GCP audit logs all capture the API calls ESO makes. Review these periodically to ensure access patterns match expectations.

## Getting Started

If you have Argo CD running and want to add proper secrets management, here is the path I recommend:

1. Install ESO in your cluster, either manually or as an Argo CD Application. Use workload identity if your cloud provider supports it.
2. Create a SecretStore or ClusterSecretStore that connects to your secret provider of choice.
3. Pick one application and convert its manually created Kubernetes Secrets into ExternalSecret resources.
4. Commit the ExternalSecret manifests to Git and let Argo CD sync them. Verify that ESO creates the Kubernetes Secrets correctly.
5. Remove the manually created Secrets and confirm the application is using the ESO-managed ones.
6. Expand to more applications and environments as you gain confidence.

The [External Secrets Operator documentation](https://external-secrets.io/) has guides for every supported provider with authentication examples and YAML manifests you can adapt for your environment. The [Argo CD secret management documentation](https://argo-cd.readthedocs.io/en/stable/operator-manual/secret-management/) provides additional context on why this approach is recommended over alternatives.

## Wrapping Up

Secrets have always been the awkward edge case in GitOps. You want everything in Git, but secret values cannot go there. External Secrets Operator resolves this by letting you declare your secret requirements in Git as ExternalSecret resources while keeping the actual values safely in a dedicated secret management system.

Combined with Argo CD, ESO gives you a fully declarative, auditable secrets workflow. Argo CD syncs the ExternalSecrets. ESO fetches the values. Your applications consume native Kubernetes Secrets. Nobody has to manually create secrets in the cluster, and nobody has to commit sensitive values to a repository.

If you are building out your GitOps platform and have not addressed secrets management yet, External Secrets Operator should be your next addition. It closes the last major gap in the GitOps model and integrates cleanly with the rest of the Argo ecosystem.

If you need help implementing External Secrets Operator, designing a secrets management strategy, or integrating it with your existing Argo CD and Kargo setup, [get in touch](/contact).
