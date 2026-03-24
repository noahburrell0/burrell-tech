---
title: "Kargo Deep Dive: Verification, Soak Times, and Reusable Promotion Tasks"
date: 2026-03-23
description: "A practical guide to building production-ready Kargo promotion pipelines. Covers post-promotion verification with AnalysisTemplates, soak time requirements for safe progressive delivery, and PromotionTasks for DRY promotion workflows across environments."
image: /blog/images/kargo-logo.svg
ogBackground: dark
tags:
  - kubernetes
  - kargo
  - gitops
  - argo-cd
  - argo-rollouts
---

<div class="blog-hero">
  <img src="/blog/images/kargo-logo.svg" alt="Kargo verification and promotion pipeline" width="180" style="display: inline-block;">
</div>

In my [introduction to Kargo](/blog/kargo/), I covered the fundamentals: Warehouses detect new artifacts, Freight packages them into promotable units, and Stages define how changes flow through your environments. If you followed along, you have the building blocks for a basic promotion pipeline. But a production pipeline needs more than just the ability to push changes forward. It needs quality gates that prevent bad releases from reaching users, time-based controls that let deployments bake before moving downstream, and reusable promotion logic that does not require copy-pasting YAML across every Stage.

This post covers the three features that turn a basic Kargo pipeline into a production-grade one: verification with AnalysisTemplates, soak time requirements, and PromotionTasks for reusable promotion workflows. These features shipped across Kargo v1.0 through v1.4 and are all stable enough for production use.

## Post-Promotion Verification

The simplest Kargo pipeline promotes Freight through Stages without checking whether the promotion actually worked. Argo CD will eventually reconcile the desired state and report health status, but that only tells you whether the Kubernetes resources are running. It does not tell you whether the application is behaving correctly. Verification closes that gap.

### How Verification Works

After a successful Promotion, a Stage enters the **Verifying** phase. Kargo spawns an AnalysisRun based on the AnalysisTemplates referenced in the Stage's `spec.verification` field. The AnalysisRun executes whatever checks you have defined, whether that is running integration tests in a Job, querying Prometheus for error rates, or hitting a health endpoint. When the AnalysisRun completes successfully, the Freight is marked as verified in that Stage and becomes eligible for promotion downstream. If it fails, the Freight stays unverified and cannot move forward.

One important constraint: while a Stage is verifying, no other Promotions to that Stage will execute. This prevents a race condition where a new version could overwrite the one being tested. Verification must complete (or be manually aborted) before the Stage accepts new work.

### Implicit vs Explicit Verification

If your Stage references Argo CD Applications but does not define any `spec.verification`, Kargo still performs a lightweight check. It waits for the referenced Applications to reach a Healthy state before marking the Freight as verified. This is implicit verification, and it provides a baseline safety net. The Application must finish syncing and all its resources (Deployments, StatefulSets, Jobs) must report healthy before the pipeline moves on.

Explicit verification gives you much more control. You define AnalysisTemplates that run specific tests against the deployed application. Here is a minimal example that runs a containerized integration test:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: integration-test
  namespace: my-project
spec:
  metrics:
  - name: integration-test
    provider:
      job:
        spec:
          template:
            spec:
              containers:
              - name: test-runner
                image: my-registry/integration-tests:latest
                env:
                - name: TARGET_URL
                  value: "http://my-app.my-project.svc.cluster.local"
              restartPolicy: Never
          backoffLimit: 1
```

This template tells Kargo to run a Job that executes your integration test suite against the application's in-cluster service URL. If the Job exits with a zero status code, verification passes. If it fails, the Freight is not verified.

### Referencing AnalysisTemplates from a Stage

To wire this up, add a `verification` block to your Stage spec:

```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: uat
  namespace: my-project
spec:
  requestedFreight:
    - sources:
        stages:
          - test
      origin:
        kind: Warehouse
        name: my-warehouse
  promotionTemplate:
    spec:
      steps:
        - uses: git-clone
          config:
            repoURL: https://github.com/example/deploy-config.git
            checkout:
              - branch: main
                path: ./src
        - uses: kustomize-set-image
          config:
            path: ./src/environments/uat
            images:
              - image: my-registry/my-app
        - uses: git-commit
          config:
            path: ./src
            messageFromSteps:
              - kustomize-set-image
        - uses: git-push
          config:
            path: ./src
        - uses: argocd-update
          config:
            apps:
              - name: my-app-uat
  verification:
    analysisTemplates:
      - name: integration-test
```

After the promotion steps complete and Argo CD syncs the application, Kargo spawns the AnalysisRun. You can monitor its progress in the Kargo UI under the Stage's Verifications tab.

### Querying Monitoring Systems

Job-based metrics are the most flexible option, but Kargo also supports querying monitoring systems directly through Argo Rollouts metric providers. If you run Prometheus, you can define an AnalysisTemplate that checks error rates after a promotion:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate-check
  namespace: my-project
spec:
  metrics:
  - name: error-rate
    interval: 30s
    count: 5
    successCondition: result[0] < 0.05
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{status=~"5.*",app="my-app",namespace="uat"}[5m]))
          /
          sum(rate(http_requests_total{app="my-app",namespace="uat"}[5m]))
```

This template queries Prometheus every 30 seconds for five iterations. If the 5xx error rate exceeds 5% in more than two of those checks, verification fails. You can combine this with the integration test template by referencing both from the same Stage:

```yaml
verification:
  analysisTemplates:
    - name: integration-test
    - name: error-rate-check
```

Both AnalysisRuns must succeed for the Freight to be marked as verified.

### Passing Dynamic Values to AnalysisTemplates

Your verification often needs context about the specific Freight being verified. Kargo supports passing arguments from the Stage to the AnalysisTemplate using expressions:

{% raw %}
```yaml
verification:
  analysisTemplates:
    - name: smoke-test
  args:
    - name: image-tag
      value: ${{ imageFrom("my-registry/my-app").Tag }}
    - name: commit-sha
      value: ${{ commitFrom("https://github.com/example/repo.git").ID }}
```

Note the `${{ }}` expression syntax used in Stage resources. The corresponding AnalysisTemplate declares these as arguments using the standard `{{ }}` syntax from Argo Rollouts:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: smoke-test
  namespace: my-project
spec:
  args:
    - name: image-tag
    - name: commit-sha
  metrics:
  - name: smoke
    provider:
      job:
        spec:
          template:
            spec:
              containers:
              - name: smoke
                image: my-registry/smoke-tests:latest
                env:
                - name: IMAGE_TAG
                  value: "{{ args.image-tag }}"
                - name: COMMIT_SHA
                  value: "{{ args.commit-sha }}"
              restartPolicy: Never
          backoffLimit: 0
```
{% endraw %}

This lets your test suite know exactly which version it is testing, which is useful for reporting and for tests that need to validate version-specific behavior.

### ClusterAnalysisTemplates for Shared Verification

If you have verification logic that applies across multiple projects, use a ClusterAnalysisTemplate instead. These are cluster-scoped resources that any Stage in any project can reference:

```yaml
verification:
  analysisTemplates:
    - name: org-wide-security-scan
      kind: ClusterAnalysisTemplate
```

This is particularly useful for organization-wide security scans, compliance checks, or baseline health validations that every application must pass before promotion.

## Soak Times

Verification tells you whether a deployment is working immediately after promotion. But some problems only surface after the application has been running under real traffic for a while. Memory leaks, connection pool exhaustion, and slow cache invalidation are all examples of issues that pass initial health checks but cause incidents hours later.

Soak times address this by requiring Freight to remain in a Stage for a minimum duration before it becomes eligible for downstream promotion. Even if verification passes immediately, the Freight cannot move forward until the soak period expires.

### Configuring Soak Times

Soak times are configured on the downstream Stage's `requestedFreight` field, not on the upstream Stage itself. This makes sense because the downstream Stage is the one imposing the requirement:

```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: production
  namespace: my-project
spec:
  requestedFreight:
    - origin:
        kind: Warehouse
        name: my-warehouse
      sources:
        stages:
          - uat
        requiredSoakTime: 2h
```

With this configuration, Freight promoted to UAT must remain there for at least two hours before it can be promoted to production. The soak timer starts when the Freight is successfully verified in the upstream Stage. If verification takes 15 minutes and the soak time is 2 hours, the total wait is 2 hours and 15 minutes.

Valid duration formats include `180s`, `30m`, `48h`, or combinations. Both automated and manual promotions respect soak times, so even an operator manually promoting Freight will be blocked until the period elapses. The one exception is manually approving Freight for a Stage, which bypasses both verification and soak time requirements. This is your escape hatch for emergencies.

### Combining Verification and Soak Times

The real power comes from combining these features. Consider a three-stage pipeline:

```mermaid
sequenceDiagram
  participant W@{ "type" : "collections" } as New Freight 
  participant D@{ "type" : "queue" } as Dev
  participant S@{ "type" : "queue" } as Staging
  participant P@{ "type" : "queue" } as Production

  W->>D: Auto-promoted
  Note over D: No verification
  D->>S: Auto-promoted
  Note over S: Integration Tests
  Note over S: Prometheus Checks
  Note over S: 1h Soak
  S->>P: Manually promoted
  Note over P: Integration Tests
  Note over P: Prometheus Checks
  ```

When a new image arrives, it flows immediately to dev. Once Argo CD reports the dev application as healthy (implicit verification), it becomes eligible for staging. In staging, Kargo runs integration tests and Prometheus checks. If those pass, the soak timer starts. The Freight must remain healthy in staging for a full hour before it can be promoted to production. When someone manually triggers the production promotion, the same verification suite runs against the production deployment.

This layered approach catches different classes of failures at each stage. Compilation and startup errors are caught in dev. Integration issues are caught by verification in staging. Time-dependent issues surface during the soak period. And the production verification confirms the deployment is healthy in the final environment.

## PromotionTasks: Reusable Promotion Workflows

If you look at promotion templates across multiple Stages, you will notice a pattern: the sequence of steps is usually identical, with only a few values changing between environments. The dev Stage clones the same repo, runs the same Kustomize commands, and pushes to the same branch as the production Stage. The only differences are the environment path and the Argo CD application name.

Copy-pasting this YAML across every Stage creates a maintenance burden. When you need to add a step (say, running a linter before commit), you have to update every Stage individually. PromotionTasks solve this by letting you define a reusable sequence of promotion steps that accepts parameters.

### Defining a PromotionTask

A PromotionTask is a namespaced Kubernetes resource that declares variables and steps:

{% raw %}
```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: PromotionTask
metadata:
  name: kustomize-promote
  namespace: my-project
spec:
  vars:
    - name: repoURL
    - name: environment
    - name: argocdApp
    - name: targetBranch
      value: main
  steps:
    - uses: git-clone
      as: clone
      config:
        repoURL: ${{ vars.repoURL }}
        checkout:
          - branch: ${{ vars.targetBranch }}
            path: ./src
    - uses: kustomize-set-image
      as: set-image
      config:
        path: ./src/environments/${{ vars.environment }}
        images:
          - image: my-registry/my-app
    - uses: kustomize-build
      as: build
      config:
        path: ./src/environments/${{ vars.environment }}
        outPath: ./out/${{ vars.environment }}
    - uses: git-commit
      as: commit
      config:
        path: ./src
        messageFromSteps:
          - set-image
    - uses: git-push
      as: push
      config:
        path: ./src
    - uses: argocd-update
      as: sync
      config:
        apps:
          - name: ${{ vars.argocdApp }}
```
{% endraw %}

The `vars` field declares the parameters. Variables without a default value must have a value provided when the PromotionTask is referenced in a Stage, while those with a `value` field have a default that can be optionally overridden by the stage. Steps reference variables using the `${{ vars.variableName }}` syntax.

### Using a PromotionTask in a Stage

Instead of listing individual steps in the Stage's promotion template, you reference the task:

```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: uat
  namespace: my-project
spec:
  requestedFreight:
    - sources:
        stages:
          - test
      origin:
        kind: Warehouse
        name: my-warehouse
  promotionTemplate:
    spec:
      steps:
        - task:
            name: kustomize-promote
          vars:
            - name: repoURL
              value: https://github.com/example/deploy-config.git
            - name: environment
              value: uat
            - name: argocdApp
              value: my-app-uat
  verification:
    analysisTemplates:
      - name: integration-test
```

The promotion logic is now defined in one place. If you need to add a step, you update the PromotionTask and every Stage that references it picks up the change.

### ClusterPromotionTasks for Cross-Project Reuse

If your organization has a standard promotion workflow that applies across multiple projects, use a ClusterPromotionTask. The syntax is identical to a PromotionTask but the resource is cluster-scoped:

{% raw %}
```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: ClusterPromotionTask
metadata:
  name: standard-kustomize-promote
spec:
  vars:
    - name: repoURL
    - name: environment
    - name: argocdApp
  steps:
    - uses: git-clone
      as: clone
      config:
        repoURL: ${{ vars.repoURL }}
        checkout:
          - branch: main
            path: ./src
    # ... remaining steps
```
{% endraw %}

Reference it from a Stage by specifying the kind:

```yaml
steps:
  - task:
      name: standard-kustomize-promote
      kind: ClusterPromotionTask
    vars:
      - name: repoURL
        value: https://github.com/example/deploy-config.git
      - name: environment
        value: uat
      - name: argocdApp
        value: my-app-uat
```

This is powerful for platform teams that want to provide a standardized promotion workflow while still letting application teams customize the specifics through variables.

### Task Outputs and Chaining

PromotionTask steps can reference outputs from preceding steps within the same task using `task.outputs`. A common pattern is opening a pull request and then waiting for it to merge:

{% raw %}
```yaml
steps:
  - uses: git-open-pr
    as: open-pr
    config:
      repoURL: ${{ vars.repoURL }}
      sourceBranch: ${{ vars.sourceBranch }}
      targetBranch: ${{ vars.targetBranch }}
  - uses: git-wait-for-pr
    as: wait-for-pr
    config:
      repoURL: ${{ vars.repoURL }}
      prNumber: ${{ task.outputs['open-pr'].pr.id }}
```
{% endraw %}

Tasks can also expose outputs to the parent promotion template using the `compose-output` step. This lets you chain multiple PromotionTasks together, with downstream tasks consuming outputs from upstream ones.

One constraint to keep in mind: PromotionTask steps cannot reference other PromotionTasks. This prevents circular dependencies and keeps the execution model straightforward. If you need composition, structure it at the promotion template level by sequencing multiple task references.

## Operational Tips

A few things I have learned from running these pipelines:

**Start without verification and add it incrementally.** Get the basic promotion flow working first. Add implicit Argo CD health checks, then soak times, then explicit AnalysisTemplates. Each layer builds on the previous one.

**Keep AnalysisTemplate Jobs fast.** Verification blocks the entire Stage from accepting new Promotions. If your integration test suite takes 30 minutes, that is 30 minutes where no other version can be promoted to that Stage. Consider running a targeted smoke test for verification and leaving the full suite for CI.

**Use ClusterAnalysisTemplates for cross-cutting concerns.** Security scans, compliance checks, and baseline health validations are good candidates for cluster-scoped templates. Application-specific tests should stay in project-scoped AnalysisTemplates.

**Set soak times based on your observability window.** If your monitoring dashboards need 15 minutes of traffic to show meaningful trends, a 15-minute soak is the minimum that makes sense. On the Stage before production, err on the side of longer soak periods.

**Use manual Freight approval as an emergency bypass.** If you need to push a hotfix through and cannot wait for soak times, manually approving the Freight for a Stage skips both verification and soak requirements. Use this sparingly, but know it exists.

## What's Next

Kargo continues to ship features at a steady pace. Version 1.7 introduced `oci-download` and `http-download` promotion steps, letting you pull OCI artifacts or remote files directly into your promotion workflows. Version 1.8 added expression-based Freight creation criteria on Warehouses, which solves a real pain point for multi-subscription Warehouses by preventing Freight from being created with incompatible artifact combinations. Most recently, v1.9 shipped live log streaming for verification runs directly in the UI, making it far easier to debug failed AnalysisRuns without leaving the Kargo dashboard.

If you are building promotion pipelines and want to go deeper, the [Kargo documentation](https://docs.kargo.io/) covers every built-in promotion step and its configuration options. For help designing pipelines for your organization, [get in touch](/contact).
