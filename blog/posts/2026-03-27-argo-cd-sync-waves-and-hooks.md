---
title: "Argo CD Sync Waves and Hooks: Controlling Deployment Order in GitOps"
date: 2026-03-27
description: "A deep dive into Argo CD sync waves and hooks. Learn how to use PreSync, PostSync, and SyncFail hooks alongside sync wave ordering to run database migrations before deployments, execute smoke tests after rollouts, and handle failures gracefully."
image: /blog/images/sync-waves-hero.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - automation
---

<div class="blog-hero">
  <img src="/blog/images/sync-waves-hero.svg" alt="Argo CD sync waves and hooks deployment phases" width="300" style="display: inline-block;">
</div>

Argo CD syncs your desired state from Git to your cluster, but real-world deployments are rarely as simple as applying a flat set of manifests all at once. Database schemas need to migrate before the new application code starts. Namespaces and CRDs need to exist before anything references them. Smoke tests should run after a rollout completes, and someone should be notified if the whole thing falls over. Sync waves and hooks give you that control without leaving the declarative GitOps model.

If you are new to Argo CD, my [getting started guide](/blog/argo-cd/) covers installation and core concepts. This post assumes you already have a working Argo CD instance and want to layer ordering and lifecycle logic on top of your existing Applications.

## Sync Phases

Every Argo CD sync operation moves through a fixed sequence of phases. Understanding this sequence is the foundation for everything else in this post.

**PreSync** runs first. Resources annotated with the PreSync hook execute before any of your application manifests are applied. This is where database migrations, backup jobs, and other preparatory work belong. If a PreSync hook fails, Argo CD stops the entire sync and none of your application resources are touched.

**Sync** is the main phase. Your application manifests, along with any resources annotated with the Sync hook, are applied here. Within this phase sync waves control the ordering, which we will cover shortly.

**PostSync** runs after the Sync phase completes and all resources in that phase are healthy. This is the natural home for smoke tests, integration checks, and deployment notifications.

**SyncFail** triggers only when the sync operation fails. Use it for cleanup or rollback logic. SyncFail hooks do not run on success.

**Skip** is a special annotation that tells Argo CD to ignore a resource during sync entirely. The resource stays in your Git repo but Argo CD will not apply it. This is useful for documentation manifests, examples, or resources managed by a different controller.

**PreDelete** runs before Argo CD deletes an Application's resources. If you need to drain connections, deregister from a service mesh, or run any cleanup logic before teardown, PreDelete hooks handle it. A failing PreDelete hook blocks the deletion.

**PostDelete** runs after all of an Application's resources have been deleted. It was introduced in Argo CD v2.10.

The phase order is always PreSync, then Sync, then PostSync on success or SyncFail on failure. PreDelete and PostDelete are separate from the sync lifecycle and only execute during Application deletion.

## Sync Waves

Within each phase, Argo CD uses sync waves to control the order that resources are applied. You assign a wave number to a resource using an annotation, and Argo CD applies resources from the lowest wave number to the highest.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "-5"
```

Resources without a sync-wave annotation default to wave 0. Negative values are valid and commonly used for foundational resources that everything else depends on.

The ordering rules within a sync operation follow this precedence:

1. Phase (PreSync before Sync before PostSync)
2. Wave number within the phase (lowest first)
3. Resource kind (Namespaces before other core resources, core resources before custom resources)
4. Resource name (alphabetical)

Argo CD will not advance to the next wave until all resources in the current wave are healthy and synced. This means that if you put a Deployment in wave 1 with proper readiness probes, Argo CD will wait for all its pods to pass health checks before moving to wave 2. This health-gating behavior is what makes sync waves genuinely useful rather than just a suggestion about ordering.

There is a configurable delay between waves controlled by the `ARGOCD_SYNC_WAVE_DELAY` environment variable on the application controller. The default is 2 seconds. In most cases you should not need to change it, but if you have external dependencies that need time to propagate (DNS, cloud load balancers), a longer delay can help.

### A Practical Wave Strategy

Choosing wave numbers is partly convention and partly dictated by your application's dependency graph. Here is a starting point that works well for the Sync phase:

| Wave | Resource Type | Rationale |
|------|--------------|-----------|
| -5 | CRDs, Operators | Must exist before any custom resources reference them |
| -3 | Namespaces | Must exist before resources are created inside them |
| -1 | RBAC, ServiceAccounts | Permissions should be in place before workloads start |
| 0 | ConfigMaps, Secrets | Default wave, configuration consumed by later resources |
| 1 | Databases, Caches | Stateful services that application code connects to |
| 3 | Application Deployments, Services | The main workload |
| 5 | Ingress, Gateway routes | Expose the application only after it is healthy |

Tasks like database migrations are better suited to PreSync hooks rather than Sync waves, since they need to complete before any application resources are applied. We will cover that pattern in the hooks section below.

Leave gaps between your wave numbers. Using -5, -3, -1, 0, 1, 3, 5 rather than consecutive integers gives you room to insert intermediate steps later without renumbering everything.

## Hooks in Practice

A hook is any Kubernetes resource with the `argocd.argoproj.io/hook` annotation. The annotation value tells Argo CD which phase the resource belongs to. Hooks are most commonly Kubernetes Jobs, but they can be any resource type.

### PreSync: Database Migrations

The most common PreSync use case is running database migrations before a new version of your application starts. Here is a Job that runs Liquibase migrations:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
    argocd.argoproj.io/sync-wave: "-1"
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: liquibase
          image: liquibase/liquibase:4.31-alpine
          args:
            - --changeLogFile=changelog/db.changelog-master.xml
            - --url=$(DATABASE_URL)
            - --username=$(DB_USER)
            - --password=$(DB_PASS)
            - update
          envFrom:
            - secretRef:
                name: db-credentials
```

A few things to note here. The `activeDeadlineSeconds` field is critical. Without it, a hung migration will block your sync indefinitely. Setting `backoffLimit` to a small number prevents Kubernetes from retrying a fundamentally broken migration over and over. The `BeforeHookCreation` delete policy ensures the previous Job is cleaned up before a new sync creates a fresh one.

### PostSync: Smoke Tests

After your application is deployed and healthy, you want to verify it actually works. A PostSync hook running basic HTTP checks is a lightweight way to catch deployment issues before they reach users:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-test
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 120
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: test
          image: curlimages/curl:8.7.1
          command:
            - sh
            - -c
            - |
              set -e
              echo "Testing health endpoint..."
              curl -sf --retry 5 --retry-delay 5 \
                http://my-app.my-app.svc.cluster.local/health
              echo "Testing readiness..."
              curl -sf --retry 3 --retry-delay 3 \
                http://my-app.my-app.svc.cluster.local/ready
              echo "All smoke tests passed"
```

The `HookSucceeded` delete policy cleans up the Job after it passes. If the test fails, the Job and its logs stick around so you can debug. You can combine policies by separating them with commas if you want both behaviors: `HookSucceeded,HookFailed`.

### SyncFail: Rolling Back Migrations

When a sync fails after a PreSync migration has already run, you may need to undo those schema changes so the currently running application code remains compatible with the database. A SyncFail hook can run Liquibase's `rollbackCount` command to revert the changes that were just applied:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: sync-fail-rollback
  annotations:
    argocd.argoproj.io/hook: SyncFail
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: liquibase-rollback
          image: liquibase/liquibase:4.31-alpine
          args:
            - --changeLogFile=changelog/db.changelog-master.xml
            - --url=$(DATABASE_URL)
            - --username=$(DB_USER)
            - --password=$(DB_PASS)
            - rollbackCount
            - "1"
          envFrom:
            - secretRef:
                name: db-credentials
```

A few caveats with this approach. Your Liquibase changesets need valid rollback definitions for this to work. Additive changes like adding a nullable column are straightforward, but destructive changes like dropping a column cannot be automatically reversed. The `BeforeHookCreation` delete policy keeps the most recent Job around for debugging while ensuring a clean slate on the next sync attempt. For alerting on failures, pair this with [Argo CD Notifications](/blog/argo-cd-notifications/) rather than relying on another SyncFail hook.

### PreDelete: Graceful Teardown

PreDelete hooks were added in Argo CD 3.3 and solve a long-standing pain point. Before they existed, deleting an Application would immediately remove all its resources with no way to run cleanup logic first. Now you can drain connections, deregister from service discovery, or back up state before teardown:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pre-delete-drain
  annotations:
    argocd.argoproj.io/hook: PreDelete
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 180
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: drain
          image: bitnami/kubectl:1.30
          command:
            - sh
            - -c
            - |
              echo "Deregistering from service mesh..."
              kubectl annotate svc my-app \
                mesh.example.com/drain=true --overwrite
              echo "Waiting for connections to drain..."
              sleep 30
              echo "Drain complete"
```

If a PreDelete hook fails, the deletion is blocked. This prevents data loss scenarios where a backup job needs to succeed before the database is removed.

## Combining Waves and Hooks

The real power comes from combining phases and waves. Consider a typical web application deployment with a database dependency:

```yaml
# PreSync: Run database migrations before the new code rolls out
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  namespace: my-app
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: my-app/migrations:v2.4.0
          envFrom:
            - secretRef:
                name: db-credentials
---
# Wave -3, Sync: Namespace must exist before other resources
apiVersion: v1
kind: Namespace
metadata:
  name: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "-3"
---
# Wave 0, Sync: Database credentials
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "0"
type: Opaque
stringData:
  DATABASE_URL: jdbc:postgresql://db.example.com:5432/myapp
  DB_USER: myapp
  DB_PASS: changeme
---
# Wave 0, Sync: ConfigMap consumed by the app
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-app-config
  namespace: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "0"
data:
  LOG_LEVEL: "info"
  DB_POOL_SIZE: "10"
---
# Wave 3, Sync: The application Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: my-app/server:v2.4.0
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
---
# Wave 3, Sync: Service for the application
apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  selector:
    app: my-app
  ports:
    - port: 8080
      targetPort: 8080
---
# Wave 5, Sync: Expose after healthy
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: my-app
  annotations:
    argocd.argoproj.io/sync-wave: "5"
spec:
  rules:
    - host: my-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 8080
---
# SyncFail: Roll back the database migration if the sync fails
apiVersion: batch/v1
kind: Job
metadata:
  name: sync-fail-rollback
  namespace: my-app
  annotations:
    argocd.argoproj.io/hook: SyncFail
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: liquibase-rollback
          image: liquibase/liquibase:4.31-alpine
          args:
            - --changeLogFile=changelog/db.changelog-master.xml
            - --url=$(DATABASE_URL)
            - --username=$(DB_USER)
            - --password=$(DB_PASS)
            - rollbackCount
            - "1"
          envFrom:
            - secretRef:
                name: db-credentials
---
# PostSync: Smoke test
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-test
  namespace: my-app
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 120
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: test
          image: curlimages/curl:8.7.1
          command:
            - sh
            - -c
            - |
              curl -sf --retry 5 --retry-delay 5 \
                http://my-app.my-app.svc.cluster.local:8080/health
```

This is a relatively simple example, but the execution order is deterministic and you can see how this level of orchestration becomes powerful in more complex deployments with dozens of interdependent resources:

1. Database migration runs (PreSync)
2. Namespace is created (Sync, wave -3)
3. Secret and ConfigMap are applied (Sync, wave 0)
4. Deployment and Service are created, Argo CD waits for healthy pods (Sync, wave 3)
5. Ingress is created only after the Deployment and Service are healthy (Sync, wave 5)
6. Smoke test runs after everything is synced and healthy (PostSync)
7. If any step in the Sync phase fails, the database migration is rolled back (SyncFail)

If the migration fails at step 1, none of the application resources are touched. If the Deployment fails at step 4, the Ingress is never created, traffic never routes to unhealthy pods, and the SyncFail hook reverts the schema changes so the existing application code stays compatible with the database.

## Hook Delete Policies

Managing the lifecycle of hook resources is important because Jobs do not clean themselves up by default. Argo CD provides three delete policies that you set with the `argocd.argoproj.io/hook-delete-policy` annotation:

**BeforeHookCreation** is the default when no policy is specified. Before Argo CD creates a new hook resource, it deletes any existing resource with the same name. This gives you a clean slate for each sync while preserving the most recent hook resource between syncs for debugging.

**HookSucceeded** deletes the hook resource immediately after it completes successfully. This keeps your cluster clean but means you cannot inspect the logs of a successful hook after the fact (unless you are shipping logs externally).

**HookFailed** deletes the hook resource after it fails. This is less commonly used on its own but can be combined with HookSucceeded if you want hooks cleaned up regardless of outcome.

You can combine multiple policies by separating them with commas:

```yaml
argocd.argoproj.io/hook-delete-policy: HookSucceeded,BeforeHookCreation
```

This combination cleans up after success and also ensures a clean slate before the next run. It is the most common production pattern.

## Things to Watch Out For

**Hooks do not run during selective sync.** If you use Argo CD's selective sync feature to sync only specific resources, none of your hooks will execute. This is by design but catches people off guard when they selectively sync a Deployment and expect the PreSync migration to run. If you rely on hooks, sync the full Application.

**Multiple hook types on one resource.** You can assign multiple hook types to a single resource by separating them with commas: `argocd.argoproj.io/hook: PreSync,PostSync`. The resource will run in both phases. This is occasionally useful but usually means your hook is doing too much.

**Job naming conflicts.** If you use `generateName` instead of `name` on your hook Jobs, Argo CD will not be able to clean them up with BeforeHookCreation because it matches on name. Stick with fixed names for hook resources.

**Resource health checks gate wave progression.** If a resource in wave 1 never becomes healthy (a Deployment with a bad image, for example), Argo CD will wait indefinitely and never apply wave 2 resources. Make sure your health checks are well-configured and consider setting sync timeouts on your Application.

**The 2-second wave delay is per-wave, not per-resource.** All resources in the same wave are applied together, and then Argo CD waits 2 seconds (configurable via `ARGOCD_SYNC_WAVE_DELAY`) before moving to the next wave.

## Best Practices

**Always set `activeDeadlineSeconds` on hook Jobs.** A migration that hangs or a test that never completes will block your sync pipeline indefinitely. Pick a reasonable deadline and let the Job fail rather than wait forever.

**Make hooks idempotent.** Syncs can be retried, and hooks can run multiple times against the same state. Your migration tool should be able to handle running against an already-migrated database. Your smoke tests should be safe to repeat.

**Keep wave numbers sparse.** Use -5, -3, -1, 0, 1, 3, 5 instead of consecutive integers. This leaves room for future resources without renumbering.

**Use readiness probes on Deployments in waves.** The wave health-gating only works if Argo CD can determine when your Deployment is actually ready. Without readiness probes, a Deployment is considered healthy as soon as its pods exist, which defeats the purpose of ordered waves.

**Do not put critical logic in SyncFail hooks alone.** SyncFail hooks run in a degraded sync context and can themselves fail. Design them to be best-effort and keep them focused on reversible operations like rolling back a migration. For failure alerting, use [Argo CD Notifications](/blog/argo-cd-notifications/) instead of SyncFail hooks.

**Test hooks in a staging environment first.** A broken PreSync hook will block every sync for the Application. Verify your hooks work before promoting them to production.

## Wrapping Up

Sync waves and hooks transform Argo CD from a tool that applies manifests into a tool that orchestrates deployments. The key insight is that you get ordered, health-gated deployments and lifecycle hooks without giving up the declarative GitOps model. Everything is still defined in Git, everything is still version-controlled, and Argo CD still manages the reconciliation loop. You just have more control over the order it happens.

For further reading, the [official sync waves documentation](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/) covers the complete specification. If you are looking to build on this with promotion pipelines across environments, my [introduction to Kargo](/blog/kargo/) covers how Kargo orchestrates multi-stage deployments using Argo CD as the underlying sync engine.
