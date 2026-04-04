---
title: "Why Your CRDs Show Healthy When They're Broken: Argo CD Custom Health Checks"
date: 2026-04-04
description: "Argo CD marks unknown CRDs as Healthy by default, hiding failures behind a green dashboard. Learn how to write Lua health checks that surface real status for cert-manager, Crossplane, and your own custom resources."
image: /blog/images/lua-logo.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - health-checks
---

<div class="blog-hero">
  <img src="/blog/images/lua-logo.svg" alt="Lua language logo representing Argo CD health check scripting" width="200" style="display: inline-block;">
</div>

You deploy a cert-manager Certificate, a Crossplane Composition, or a custom operator CRD through Argo CD. The dashboard shows a green Healthy status. Everything looks fine. Except the certificate never issued, the cloud resource never provisioned, and the operator is stuck in a reconciliation loop. Argo CD told you everything was fine because it did not know any better.

By default, Argo CD marks any custom resource as Healthy the moment it exists in the cluster. It has no way to inspect the `.status` block of resources it does not recognize. For core Kubernetes types like Deployments, Services, and Jobs, Argo CD has built-in health assessments written in Go. And for over a hundred popular CRD API groups, including cert-manager, Crossplane, Istio, Knative, Strimzi Kafka, Flux, Kyverno, and many more, Argo CD ships pre-written Lua health checks in its [resource_customizations](https://github.com/argoproj/argo-cd/tree/master/resource_customizations) directory. But if you are running an operator that is not in that list, or if the built-in check does not match the behavior you need, you are back to a green checkmark that means nothing more than "the resource was accepted by the API server."

Custom health checks fix this. They are short Lua scripts that teach Argo CD how to read the status of any resource type and report an accurate health state. This post covers how the health check system works end to end, walks through the patterns used by the built-in checks so you can write your own, and explains how to override or extend the checks that ship with Argo CD.

If you are new to Argo CD, my [getting started guide](/blog/argo-cd/) covers installation and core concepts. This post assumes you have a running Argo CD instance and at least one CRD-based operator deployed through it.

## How Argo CD Evaluates Health

Argo CD evaluates Application health in two layers. First, it checks each individual resource managed by the Application. Then, it aggregates those results into an overall Application health status by taking the worst status across all resources.

The priority order from best to worst is: Healthy, Suspended, Progressing, Missing, Degraded, Unknown. If one resource is Degraded and everything else is Healthy, the Application shows Degraded. This means a single misconfigured health check can drag down your entire Application status, and a single missing health check can hide a real failure behind a Healthy status.

For built-in Kubernetes types, Argo CD uses Go-based health assessments that understand the nuances of each resource. A Deployment is Healthy when its desired replica count matches its available replica count. A Job is Healthy when it completes successfully and Degraded when it fails. A PersistentVolumeClaim is Healthy when it reaches Bound status. These checks are hardcoded and handle edge cases well.

For custom resources that have a pre-written Lua health check (either shipped with Argo CD or configured by you), the Lua script evaluates the resource's status and returns an appropriate health state. For custom resources that do not have any health check defined, Argo CD falls back to a simple rule: if the resource exists, it is Healthy. This default exists because Argo CD cannot assume anything about the status structure of an arbitrary CRD. The problem is obvious. A `DatabaseCluster` that failed to provision, a `Queue` that is misconfigured, a custom operator CRD that is stuck in a reconciliation loop, all of these show as Healthy if Argo CD does not have a health check for them.

## Writing Your First Health Check

Custom health checks are Lua scripts configured in the `argocd-cm` ConfigMap. The key follows the pattern `resource.customizations.health.<group>_<kind>`, where dots in the API group are literal and the group is separated from the kind by an underscore.

The script receives the full resource object as a global variable called `obj`. It must return a table with a `status` field (one of `Healthy`, `Progressing`, `Degraded`, or `Suspended`) and an optional `message` field that appears in the Argo CD UI.

Here is a health check for a hypothetical `DatabaseCluster` CRD from the API group `db.example.com`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations.health.db.example.com_DatabaseCluster: |
    local hs = {}
    if obj.status ~= nil then
      if obj.status.conditions ~= nil then
        for i, condition in ipairs(obj.status.conditions) do
          if condition.type == "Ready" and condition.status == "True" then
            hs.status = "Healthy"
            hs.message = condition.message
            return hs
          end
          if condition.type == "Ready" and condition.status == "False" then
            hs.status = "Degraded"
            hs.message = condition.message
            return hs
          end
        end
      end
    end
    hs.status = "Progressing"
    hs.message = "Waiting for database cluster to become ready"
    return hs
```

The pattern here is common across most Kubernetes operators. Check for a `Ready` condition in the status block, return `Healthy` or `Degraded` based on its value, and fall back to `Progressing` if the status has not been populated yet. This fallback is important because there is always a window between when a resource is created and when the controller first writes to its status.

After updating the ConfigMap, restart the `argocd-repo-server` and `argocd-server` pods to pick up the change. Argo CD reads resource customizations at startup and does not watch for ConfigMap changes at runtime.

## Real-World Examples

### cert-manager Certificates

cert-manager is one of the most popular CRDs in the Kubernetes ecosystem, and Argo CD ships a built-in health check for it. But understanding how it works is useful because the pattern applies to dozens of similar operators.

The cert-manager Certificate health check handles a subtlety that a naive implementation misses: the `Issuing` condition. When a certificate is being renewed, it enters an `Issuing` state before it reaches `Ready`. If you only check for `Ready`, a certificate that is in the middle of renewal would briefly show as Degraded (because `Ready` becomes `False` during reissuance) before returning to Healthy. The built-in check handles this by checking `Issuing` first:

```lua
local hs = {}
if obj.status ~= nil then
  if obj.status.conditions ~= nil then

    -- Always Handle Issuing First to ensure consistent behaviour
    for i, condition in ipairs(obj.status.conditions) do
      if condition.type == "Issuing" and condition.status == "True" then
        hs.status = "Progressing"
        hs.message = condition.message
        return hs
      end
    end

    for i, condition in ipairs(obj.status.conditions) do
      if condition.type == "Ready" and condition.status == "False" then
        hs.status = "Degraded"
        hs.message = condition.message
        return hs
      end
      if condition.type == "Ready" and condition.status == "True" then
        hs.status = "Healthy"
        hs.message = condition.message
        return hs
      end
    end
  end
end

hs.status = "Progressing"
hs.message = "Waiting for certificate"
return hs
```

The two-pass approach, scanning for `Issuing` first and then for `Ready`, prevents false Degraded alerts during certificate renewal. This is the kind of operator-specific behavior that makes generic health checks insufficient. You need to know how the controller uses its status conditions.

### Bitnami Sealed Secrets

Sealed Secrets is another common CRD. The controller decrypts `SealedSecret` resources into regular Kubernetes `Secret` resources. The health check uses the `Synced` condition type rather than `Ready`:

```lua
local health_status={}
if obj.status ~= nil then
    if obj.status.conditions ~= nil then
        for i, condition in ipairs(obj.status.conditions) do
            if condition.type == "Synced" and condition.status == "False" then
                health_status.status = "Degraded"
                health_status.message = condition.message
                return health_status
            end
            if condition.type == "Synced" and condition.status == "True" then
                health_status.status = "Healthy"
                health_status.message = condition.message
                return health_status
            end
        end
    end
end
health_status.status = "Progressing"
health_status.message = "Waiting for Sealed Secret to be decrypted"
return health_status
```

Both cert-manager and Sealed Secrets have built-in health checks shipped with Argo CD, so you do not need to configure these yourself on a recent Argo CD version. They are included here because they clearly demonstrate the patterns you will use for your own CRDs.

### Crossplane Resources

Crossplane is a good case study for understanding wildcard health checks because a typical Crossplane setup creates dozens of CRD types across multiple providers (AWS, GCP, Azure). Recent versions of Argo CD ship with built-in wildcard health checks for `*.crossplane.io` and `*.upbound.io` resources, so you may not need to configure these yourself. But the pattern is worth understanding because you will use the same approach for any operator that registers many CRD types under a shared API group.

Crossplane resources use two important conditions: `Synced` and `Ready`. A resource that failed to sync with the cloud provider will have `Synced: False`. A resource that synced but has not finished provisioning will have `Ready: False`. You need to check both.

The Crossplane documentation recommends configuring health checks with a wildcard to cover all Crossplane resource types at once, rather than writing individual checks for each CRD. If you need to customize the built-in checks, or if you are running an older Argo CD version that does not include them, the wildcard approach uses the nested `resource.customizations` key format:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations: |
    "*.upbound.io/*":
      health.lua: |
        local hs = {}
        if obj.status ~= nil then
          if obj.status.conditions ~= nil then
            local ready = false
            local synced = false
            local suspended = false
            for i, condition in ipairs(obj.status.conditions) do
              if condition.type == "Ready" then
                ready = true
                if condition.status == "True" then
                  hs.status = "Healthy"
                  hs.message = condition.message
                elseif condition.reason == "Unavailable" then
                  hs.status = "Degraded"
                  hs.message = condition.message
                else
                  hs.status = "Progressing"
                  hs.message = condition.message
                end
              end
              if condition.type == "Synced" then
                synced = true
                if condition.status == "False" then
                  hs.status = "Degraded"
                  hs.message = condition.message
                end
              end
              if condition.type == "Suspended" and condition.status == "True" then
                suspended = true
                hs.status = "Suspended"
                hs.message = condition.message
              end
            end
            if ready and hs.status ~= nil then
              return hs
            end
          end
        end
        hs.status = "Progressing"
        hs.message = "Waiting for resource to become ready"
        return hs
    "*.crossplane.io/*":
      health.lua: |
        local hs = {}
        if obj.status ~= nil then
          if obj.status.conditions ~= nil then
            for i, condition in ipairs(obj.status.conditions) do
              if condition.type == "Ready" and condition.status == "True" then
                hs.status = "Healthy"
                hs.message = condition.message
                return hs
              end
              if condition.type == "Synced" and condition.status == "False" then
                hs.status = "Degraded"
                hs.message = condition.message
                return hs
              end
            end
          end
        end
        hs.status = "Progressing"
        hs.message = "Waiting for resource"
        return hs
```

Notice that the keys are quoted (`"*.upbound.io/*"`) because the asterisk at the beginning would otherwise be interpreted as a YAML alias. The wildcard `*` matches any API group prefix, and the `/*` after the group matches any kind. This single configuration block covers every Crossplane-managed resource type in your cluster.

When using Crossplane with Argo CD, the Crossplane documentation also recommends ensuring your resource tracking method is set to annotation-based tracking (which became the default in Argo CD 3.0, but was available as an opt-in since 2.2) and excluding `ProviderConfigUsage` resources from the UI since they are high-volume and low-signal:

```yaml
data:
  application.resourceTrackingMethod: annotation
  resource.exclusions: |
    - apiGroups:
      - "*"
      kinds:
      - ProviderConfigUsage
```

## The Wildcard Configuration Format

When you need a single health check to cover multiple resource types within the same API group, you use the nested `resource.customizations` key instead of the flat `resource.customizations.health.<group>_<kind>` key. These two approaches cannot be mixed for the same resource. If you define a health check in both the flat key and the nested key, the flat key takes precedence.

The nested format also supports wildcards in the kind position:

```yaml
data:
  resource.customizations: |
    mycompany.io/*:
      health.lua: |
        -- This check applies to all resources in the mycompany.io API group
        local hs = {}
        if obj.status ~= nil and obj.status.phase ~= nil then
          if obj.status.phase == "Running" or obj.status.phase == "Ready" then
            hs.status = "Healthy"
          elseif obj.status.phase == "Failed" then
            hs.status = "Degraded"
          else
            hs.status = "Progressing"
          end
          hs.message = obj.status.phase
        else
          hs.status = "Progressing"
          hs.message = "Waiting for status"
        end
        return hs
```

If both a specific check (like `mycompany.io/Database`) and a wildcard check (like `mycompany.io/*`) exist, the specific check wins. This lets you set a reasonable default for an entire API group and then override it for individual resource types that need special handling.

## Overriding Built-In Go Health Checks

Argo CD has several resource types with health logic implemented in Go rather than Lua. These include Pod, Deployment, DaemonSet, StatefulSet, ReplicaSet, Job, Service, Ingress (both `extensions` and `networking.k8s.io`), PersistentVolumeClaim, HorizontalPodAutoscaler, APIService, and the Argo project's own Workflow CRD. If the built-in behavior does not match your needs, you can override it with a Lua script using the same ConfigMap approach.

For example, the default Ingress health check reports Progressing until the load balancer IP is assigned. If you are using an ingress controller that does not populate the load balancer status (some internal-only controllers skip this), every Ingress will be stuck in Progressing forever. You can override it:

```yaml
data:
  resource.customizations.health.networking.k8s.io_Ingress: |
    local hs = {}
    hs.status = "Healthy"
    hs.message = "Ingress created"
    return hs
```

This is a blunt override that marks all Ingresses as Healthy immediately. In practice you would add more nuance, but it demonstrates the mechanism. Any Lua script you provide for a built-in type takes precedence over the Go implementation.

## Security: Lua Standard Libraries

By default, Argo CD disables access to the Lua standard libraries in health check scripts. This means you cannot use functions like `os.execute()`, `io.open()`, or `string.format()` in your health check code. The restriction exists to prevent health check scripts from performing side effects or accessing the filesystem of the repo server pod.

If your health check needs standard library functions, such as `string.format()` for building message strings or `math` functions for calculating thresholds, you can enable them per resource type:

```yaml
data:
  resource.customizations.useOpenLibs.mycompany.io_MyResource: "true"
```

Only enable this when you need it, and only for resource types whose health checks you control. If you are running a multi-tenant Argo CD instance and users can define their own resource customizations, leaving open libs enabled could allow unintended access to the Lua runtime environment.

## Ignoring Resources in Health Aggregation

Sometimes you want Argo CD to manage a resource (so it gets synced and pruned) but you do not want its health status to affect the Application's overall health. The `argocd.argoproj.io/ignore-healthcheck` annotation excludes a resource from the health aggregation:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
  annotations:
    argocd.argoproj.io/ignore-healthcheck: "true"
```

This is useful for one-shot Jobs that run during sync (like database migrations) where you do not want a completed-but-technically-failed-then-retried Job to permanently mark the Application as Degraded. It is also useful for resources that have known health check issues you cannot fix immediately.

## Debugging Health Check Failures

When a health check is not working as expected, the debugging workflow is straightforward.

First, check whether your health check is actually being loaded. A common mistake is a typo in the ConfigMap key. The key must match the exact API group and kind of your resource. You can verify the API group and kind by looking at the resource:

```bash
kubectl get crd myclusters.db.example.com -o jsonpath='{.spec.group}'
# db.example.com

kubectl get crd myclusters.db.example.com -o jsonpath='{.spec.names.kind}'
# MyCluster
```

The ConfigMap key would be `resource.customizations.health.db.example.com_MyCluster`. Note that the kind is case-sensitive.

Second, check that the status block you are reading actually exists on the resource. Operators populate status at different speeds and some do not populate it at all until certain conditions are met:

```bash
kubectl get mycluster my-db -o jsonpath='{.status}' | jq .
```

If the status is empty or missing the conditions you are checking, your health check will fall through to whatever default you specified. Make sure your fallback behavior is correct for the case where status has not been populated yet. Returning `Progressing` is almost always the right default for a newly created resource.

Third, you can test health check scripts locally using the `argocd admin settings resource-overrides health` command:

```bash
argocd admin settings resource-overrides health ./my-resource.yaml \
  --argocd-cm-path ./argocd-cm.yaml
```

This runs the health check script against a sample resource definition and prints the result without requiring a running Argo CD instance.

Finally, remember that changes to the `argocd-cm` ConfigMap require a restart of the Argo CD server components:

```bash
kubectl rollout restart deployment/argocd-server -n argocd
kubectl rollout restart deployment/argocd-repo-server -n argocd
```

## Common Patterns and Mistakes

**Always return a status.** If your Lua script exits without returning a table that has a `status` field, Argo CD treats the resource as Unknown. This is worse than Healthy because it can block sync operations depending on your health assessment configuration.

**Handle the nil case.** Lua does not throw errors when you access nil fields, but chaining accesses like `obj.status.conditions` will fail if `obj.status` is nil. Always check each level:

```lua
if obj.status ~= nil then
  if obj.status.conditions ~= nil then
    -- safe to iterate
  end
end
```

**Do not assume condition order.** The Kubernetes API does not guarantee the order of conditions in the status block. Some operators write `Ready` first, others write it last, and the order can change between versions. Always iterate through all conditions rather than accessing a specific index.

**Use Progressing as your default, not Healthy.** If your script cannot determine the health of a resource because the status has not been populated yet, return `Progressing`. Returning `Healthy` as a default defeats the purpose of the health check because it replicates the same problem you are trying to solve.

**Watch out for condition types you do not expect.** Some operators add custom condition types that your health check does not know about. If your script only checks for `Ready`, it will ignore a `Degraded` condition type that some operators use. Read the documentation for each operator you support and check for all relevant condition types.

## Contributing Health Checks Upstream

If you write a health check for a popular CRD, consider contributing it back to the Argo CD project. Upstream health checks live in the `resource_customizations` directory of the [argoproj/argo-cd](https://github.com/argoproj/argo-cd) repository. Each check follows a specific directory structure:

```
resource_customizations/
  your.crd.group.io/
    MyKind/
      health.lua
      health_test.yaml
      testdata/
        healthy.yaml
        degraded.yaml
        progressing.yaml
```

The `health_test.yaml` file defines test cases that map resource definitions to expected health statuses:

```yaml
tests:
  - healthStatus:
      status: Healthy
      message: "Certificate is up to date and has not expired"
    inputPath: testdata/healthy.yaml
  - healthStatus:
      status: Degraded
      message: "Certificate issuance failed"
    inputPath: testdata/degraded.yaml
  - healthStatus:
      status: Progressing
      message: "Waiting for certificate"
    inputPath: testdata/progressing.yaml
```

You can run the test suite locally with:

```bash
go test -v ./util/lua/
```

Contributing upstream means every Argo CD user benefits from the health check without configuring it themselves. The project has accepted health checks for hundreds of CRDs including cert-manager, Sealed Secrets, Crossplane, Istio, Knative, Strimzi Kafka, and many more.

## Putting It Together

Custom health checks are a small feature with outsized impact on operational trust. Argo CD ships with Lua health checks for over a hundred CRD API groups, covering most of the popular operators in the ecosystem. But if you are running anything custom, niche, or internal, those built-in checks will not cover you, and your dashboard will lie to you with a green status that means nothing.

Start by auditing which CRDs you deploy through Argo CD today. For each one, check whether Argo CD already ships a built-in health check by looking at the [resource_customizations directory](https://github.com/argoproj/argo-cd/tree/master/resource_customizations) in the Argo CD repository. For any that are missing, read the operator's documentation to understand its status conditions, then write a Lua script using the patterns in this post. If the built-in check exists but does not match the behavior you need, you can override it with a custom Lua script in your `argocd-cm` ConfigMap. Test with real resources, not just happy-path YAML, and make sure your fallback returns `Progressing` rather than `Healthy`.

The effort per CRD is small. A typical health check is ten to twenty lines of Lua. The payoff is knowing that when your dashboard says Healthy, your infrastructure actually is.
