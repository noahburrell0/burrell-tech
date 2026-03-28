---
title: "Argo CD Multi-Source Applications: Combining Helm Charts with Git-Hosted Values"
date: 2026-03-28
description: "A practical guide to Argo CD multi-source Applications. Learn how to pair external Helm charts with Git-hosted values files, layer additional manifests on top of charts, use the ref field for cross-repository references, and scale the pattern with ApplicationSets."
image: /blog/images/multi-source-hero.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - helm
---

<div class="blog-hero">
  <img src="/blog/images/multi-source-hero.svg" alt="Argo CD multi-source application combining Helm and Git repositories into a single deployment" width="500" style="display: inline-block;">
</div>

There is a common friction point that shows up the moment a team adopts GitOps with Argo CD and tries to consume a third-party Helm chart. You want to use the upstream chart from its official Helm repository, but you also need to override its default values with your own configuration stored in Git. The traditional approach forces a compromise: either vendor the chart into your Git repo so the values file lives alongside it, or set Helm parameters directly in the Application spec where they are harder to review and version alongside your other configuration.

Argo CD's multi-source feature eliminates this trade-off. Instead of a single `source` pointing to one repository, you define a `sources` array that pulls from multiple repositories. Argo CD generates manifests from each source independently, combines them, and reconciles the result as a single Application. The chart stays upstream, your values stay in your config repo, and both are tracked together in one Application resource.

If you are new to Argo CD, my [getting started guide](/blog/argo-cd/) covers installation and core concepts. This post assumes you have a working Argo CD instance and want to use multi-source to solve real repository layout problems.

## How Multi-Source Works

When you specify the `sources` field (plural) on an Application, Argo CD ignores the singular `source` field entirely. It processes each entry in the `sources` array independently, generating manifests from each one, then combines all the resulting resources into a single set for reconciliation.

The merging logic is straightforward but has an important edge case. If two sources produce a resource with the same `group`, `kind`, `name`, and `namespace`, the last source in the array wins. Argo CD will still sync the resource, but it logs a `RepeatedResourceWarning` so you know something is being shadowed. This is actually useful. You can use a later source to deliberately override a resource produced by an earlier source, such as replacing a default ConfigMap from a Helm chart with your own version.

Here is the simplest possible multi-source Application, combining manifests from two Git repositories:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: billing-app
  namespace: argocd
spec:
  project: default
  destination:
    server: https://kubernetes.default.svc
    namespace: billing
  sources:
    - repoURL: https://github.com/mycompany/billing-app.git
      path: manifests
      targetRevision: v2.4.0
    - repoURL: https://github.com/mycompany/common-config.git
      path: configmaps-billing
      targetRevision: HEAD
```

Both repositories contribute manifests, and the resulting Kubernetes resources are applied together. If the billing-app repo and the common-config repo both define a ConfigMap called `billing-settings`, the version from `common-config` takes precedence because it is the last source in the array.

## External Helm Charts with Git-Hosted Values

This is the pattern that makes multi-source worth learning. You want to deploy Prometheus using the community Helm chart, but your team maintains its own `values.yaml` in a configuration repository. Without multi-source, you would either fork the chart, vendor it, or inline every override as `helm.parameters` in the Application spec. None of those options are great at scale.

With multi-source, the Helm chart stays upstream and your values file stays in Git:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: prometheus
  namespace: argocd
spec:
  project: default
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  sources:
    - repoURL: https://prometheus-community.github.io/helm-charts
      chart: prometheus
      targetRevision: 28.14.0
      helm:
        valueFiles:
          - $values/clusters/production/prometheus-values.yaml
    - repoURL: https://github.com/mycompany/platform-config.git
      targetRevision: main
      ref: values
```

There are two entries in `sources`. The first is the Helm chart source. It specifies the Helm repository URL in `repoURL`, the chart name in `chart`, and the version in `targetRevision`. Under `helm.valueFiles`, the path starts with `$values`, which is a variable that resolves to the root of the second source.

The second entry is the Git repository containing your values file. It does not produce any Kubernetes manifests on its own because `path` is omitted. The `ref: values` field maps this source to the `$values` variable used in the first source's value file paths. The variable name comes directly from the `ref` value, so `ref: values` creates `$values`, `ref: myconfig` would create `$myconfig`, and so on.

A few rules govern how `ref` works. The `$values` variable can only appear at the beginning of a value file path. You cannot use it in the middle of a path like `/some/$values/thing`. The path after the variable is always relative to the root of the referenced repository. And critically, a source with `ref` set cannot also have a `chart` field. The `ref` source is a value provider, not a chart source.

### Multiple Values Files

Helm's values precedence applies here just as it does in a standard `helm install` command. When you list multiple files in `valueFiles`, each subsequent file overrides values from the previous ones. You can combine this with multi-source to layer a base values file from one repository on top of the chart's defaults, then apply environment-specific overrides from another:

```yaml
sources:
  - repoURL: https://prometheus-community.github.io/helm-charts
    chart: prometheus
    targetRevision: 28.14.0
    helm:
      valueFiles:
        - $defaults/charts/prometheus/base-values.yaml
        - $env/clusters/production/prometheus-values.yaml
  - repoURL: https://github.com/mycompany/chart-defaults.git
    targetRevision: main
    ref: defaults
  - repoURL: https://github.com/mycompany/env-config.git
    targetRevision: main
    ref: env
```

In this setup, `base-values.yaml` from the defaults repo is applied first, then `prometheus-values.yaml` from the environment-specific repo overrides any conflicting keys. The chart's own `values.yaml` is always the lowest priority.

### Combining Values Files with Inline Parameters

The `valueFiles` approach and `helm.parameters` are not mutually exclusive. If you need most of your configuration in a values file but want to override a single value at the Application level, perhaps to inject a cluster-specific endpoint that changes per Application rather than per environment, you can combine both:

```yaml
sources:
  - repoURL: https://prometheus-community.github.io/helm-charts
    chart: prometheus
    targetRevision: 28.14.0
    helm:
      valueFiles:
        - $values/prometheus/values.yaml
      parameters:
        - name: server.persistentVolume.storageClass
          value: gp3
  - repoURL: https://github.com/mycompany/platform-config.git
    targetRevision: main
    ref: values
```

Argo CD applies Helm values in a specific precedence order from lowest to highest: the chart's default `values.yaml`, then files listed in `valueFiles` (in order), then inline `values`, then `valuesObject`, and finally `parameters`. A `parameters` entry always wins over a conflicting key in a values file, and `valuesObject` takes precedence over `values` if both are specified.

### Handling Optional Values Files

Sometimes you want a values file to apply only if it exists. For example, you might have a shared configuration repo where some clusters have a `monitoring-overrides.yaml` and others do not. Argo CD will fail the sync if a file referenced in `valueFiles` is missing, unless you set `ignoreMissingValueFiles`:

```yaml
sources:
  - repoURL: https://prometheus-community.github.io/helm-charts
    chart: prometheus
    targetRevision: 28.14.0
    helm:
      ignoreMissingValueFiles: true
      valueFiles:
        - $values/base/prometheus-values.yaml
        - $values/clusters/us-east-1/prometheus-overrides.yaml
  - repoURL: https://github.com/mycompany/platform-config.git
    targetRevision: main
    ref: values
```

With `ignoreMissingValueFiles` set to `true`, any file in the `valueFiles` list that does not exist is silently skipped rather than causing a sync failure. This applies to all entries in the list, so you should be confident that your base values file path is correct since a typo there would be silently ignored too. The trade-off is worth it when you have optional per-cluster or per-region override files that only exist for some environments. It lets you add customization incrementally without creating empty placeholder files everywhere.

## Supplementing a Helm Chart with Extra Manifests

The values overlay pattern handles most customization, but sometimes you need to deploy resources alongside a Helm chart that the chart does not template at all. Maybe you need a `ServiceMonitor` for Prometheus Operator, a `NetworkPolicy`, or an `ExternalSecret` that the chart has no opinion about. You can add a second source that contributes plain manifests:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
spec:
  project: default
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  sources:
    - repoURL: https://charts.jetstack.io
      chart: cert-manager
      targetRevision: v1.20.0
      helm:
        valueFiles:
          - $values/cert-manager/values.yaml
    - repoURL: https://github.com/mycompany/platform-config.git
      targetRevision: main
      ref: values
    - repoURL: https://github.com/mycompany/platform-config.git
      targetRevision: main
      path: cert-manager/extras
```

The third source points to a `cert-manager/extras` directory in the same platform-config repository. Any YAML manifests in that directory (a `ClusterIssuer` for Let's Encrypt, a `NetworkPolicy`, whatever you need) are rendered and combined with the output of the Helm chart. Notice that this source uses the same `repoURL` as the `ref` source but specifies `path` instead of `ref`, which means it generates manifests from that directory.

This is also where the resource precedence rule becomes useful. If the Helm chart produces a `ConfigMap` that you want to replace entirely, you can put your replacement in the `cert-manager/extras` directory. Because it appears later in the `sources` array, your version takes precedence.

## Multi-Source with ApplicationSets

If you manage multiple environments or clusters, you probably use [ApplicationSets](/blog/argo-cd-applicationsets/) to generate Applications from templates. Multi-source works inside ApplicationSet templates, which means you can parameterize the values file path or chart version per environment.

Here is an ApplicationSet that deploys Prometheus to three environments, each with its own values file:

{% raw %}
```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: prometheus
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - list:
        elements:
          - env: dev
            cluster: https://dev.k8s.example.com
            revision: main
          - env: staging
            cluster: https://staging.k8s.example.com
            revision: main
          - env: production
            cluster: https://prod.k8s.example.com
            revision: v2.1.0
  template:
    metadata:
      name: 'prometheus-{{ .env }}'
    spec:
      project: default
      destination:
        server: '{{ .cluster }}'
        namespace: monitoring
      sources:
        - repoURL: https://prometheus-community.github.io/helm-charts
          chart: prometheus
          targetRevision: 28.14.0
          helm:
            valueFiles:
              - '$values/envs/{{ .env }}/prometheus-values.yaml'
        - repoURL: https://github.com/mycompany/platform-config.git
          targetRevision: '{{ .revision }}'
          ref: values
```
{% endraw %}

Each generated Application gets its own values file path based on the environment name. The production environment pins a specific Git revision for the values repo while dev and staging follow `main`. This gives you a clean separation between environment configurations while sharing a single ApplicationSet definition.

## Limitations and When to Avoid Multi-Source

Multi-source is designed for combining a small number of tightly related sources into one Application, not as a general-purpose way to group unrelated workloads. The Argo CD documentation explicitly warns against abusing it. If you find yourself adding more than two or three entries to the `sources` array, reconsider your repository layout. An app-of-apps pattern or ApplicationSets are better tools for managing genuinely separate applications.

The `ref` field and `chart` field are mutually exclusive on the same source. A source that provides values via `ref` cannot also be a Helm chart. If you need to use one Helm chart's output as values for another chart, you will need to approach it differently, either by extracting the relevant values into a Git-managed file or by restructuring your charts.

Multi-source also does not change how Argo CD handles sync operations. All sources are rendered together and applied as one unit. You cannot sync one source independently of the others. If you need independent lifecycle management for different components, they should be separate Applications.

## Putting It Together

Multi-source solves a specific set of problems cleanly. The core use case is consuming external Helm charts without vendoring them while keeping your configuration in Git where it belongs. The secondary use case is supplementing a chart with additional manifests that the chart does not provide. Combined with ApplicationSets, you get a scalable pattern for managing the same chart across multiple environments with per-environment configuration.

One pattern that works well for platform teams is a single config repository organized by environment and service, with each service directory containing a `values.yaml` and an optional `extras/` directory for additional manifests:

```
platform-config/
  envs/
    dev/
      prometheus/
        values.yaml
      cert-manager/
        values.yaml
        extras/
          cluster-issuer.yaml
    staging/
      prometheus/
        values.yaml
      cert-manager/
        values.yaml
        extras/
          cluster-issuer.yaml
    production/
      prometheus/
        values.yaml
      cert-manager/
        values.yaml
        extras/
          cluster-issuer.yaml
          network-policy.yaml
```

Each service gets an ApplicationSet that templates the environment name into the values file path and extras path. The Helm charts stay upstream, the values stay in Git, and the additional manifests live next to the values they relate to. Changes to any of these paths trigger a sync in the relevant environment without touching the others.

If you are working with ApplicationSets, my [ApplicationSets deep dive](/blog/argo-cd-applicationsets/) covers generators, templating, and progressive sync in detail. And if you are managing the values files themselves through a promotion pipeline, [Kargo](/blog/kargo/) can automate the process of moving configuration changes across environments.
