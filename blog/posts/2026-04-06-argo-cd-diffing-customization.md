---
title: "Fix Phantom Drift: Argo CD Diffing and Ignore Differences"
date: 2026-04-06
description: "Your app just synced but it's already OutOfSync. Mutating webhooks, defaulting controllers, and HPA all cause phantom drift. Here's how to fix it with ignoreDifferences, diff strategies, and server-side diff."
image: /blog/images/git-compare.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - diffing
---

<div class="blog-hero">
  <img src="/blog/images/git-compare.svg" alt="Git compare icon representing Argo CD diff customization" width="200" style="display: inline-block;">
</div>

You sync an Application in Argo CD. The sync succeeds. Thirty seconds later the dashboard shows OutOfSync again. You did not change anything in Git, nobody pushed a commit, and the Application resources look exactly like they should. But Argo CD insists something is different.

This is phantom drift, and it is one of the most common frustrations teams hit after getting past the basics of Argo CD. The underlying cause is almost always the same: something between the Git manifest and the live cluster state is modifying the resource after Argo CD applies it. Mutating admission webhooks inject sidecars or add labels. The Horizontal Pod Autoscaler overwrites `spec.replicas`. Controllers add default values that were not in your manifest. Kubernetes itself normalizes fields like resource quantities, converting `100m` to `0.1` or reordering container environment variables.

Argo CD compares the desired state from Git against the live state from the cluster. When those two states diverge for any reason, the Application goes OutOfSync. The tool does not know the difference between an intentional change you need to reconcile and a cosmetic difference injected by a webhook. It reports both the same way.

This post covers every mechanism Argo CD provides to control how diffs work: `ignoreDifferences` at the Application and system level, JQ path expressions for complex ignores, managed fields managers for controller-owned fields, diff strategies including the newer server-side diff, and the configuration knobs that control status field handling and known Kubernetes types. If you have been fighting OutOfSync indicators that should not be there, this is the post to read.

If you are new to Argo CD, my [getting started guide](/blog/argo-cd/) covers installation and core concepts. My post on [custom health checks](/blog/argo-cd-custom-health-checks/) is a useful companion to this one since both deal with how Argo CD interprets resource state.

## Why Resources Drift After Sync

Before fixing the problem, it helps to understand the common sources of phantom drift.

**Mutating admission webhooks** are the most common source. If you run Istio, Linkerd, Vault Agent, or any other tool that uses a MutatingWebhookConfiguration, those webhooks modify your resources after Argo CD applies them. An Istio sidecar injector adds an init container, a sidecar container, volumes, and volume mounts to every Pod spec that matches its selector. None of that is in your Git manifest, so Argo CD sees a diff.

**Defaulting by controllers and the API server** is the second most common source. Kubernetes itself fills in fields you did not set. If you omit `spec.replicas` from a Deployment, the API server defaults it to 1. If you omit `spec.revisionHistoryLimit`, it defaults to 10. These fields appear in the live resource but not in your Git manifest. Some controllers go further. The cert-manager webhook, for instance, writes a `caBundle` into MutatingWebhookConfiguration and ValidatingWebhookConfiguration resources.

**Horizontal Pod Autoscaler (HPA)** is a specific and very common case. The HPA controller continuously adjusts `spec.replicas` on Deployments, ReplicaSets, and StatefulSets. Every time the HPA changes the replica count, the live state diverges from Git and Argo CD reports OutOfSync.

**Resource quantity normalization** is a subtle source. Kubernetes normalizes resource quantities in different ways. `cpu: 500m` and `cpu: 0.5` are equivalent, but if your manifest says one and the cluster stores the other, Argo CD sees a diff. The same applies to memory values where `128Mi` might be stored as `134217728`.

**Field reordering** can also trigger diffs. Some controllers or webhooks reorder list elements. Environment variables, container ports, or annotation keys might come back in a different order than you specified. With the legacy diff strategy, this can appear as a change.

## ignoreDifferences: The Primary Tool

The `ignoreDifferences` field is the most direct way to tell Argo CD to stop comparing specific fields. It supports three matching mechanisms: JSON pointers, JQ path expressions, and managed fields managers.

### JSON Pointers at the Application Level

The simplest form targets a specific field across all resources of a given kind within an Application. This is the classic HPA fix:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

The `group` field is the Kubernetes API group without the version. For core resources like Services and ConfigMaps, you can omit the group or set it to an empty string. The `kind` field is case-sensitive and must match the resource kind exactly.

You can narrow the scope to a specific resource by adding `name` and optionally `namespace`:

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      name: my-api
      namespace: production
      jsonPointers:
        - /spec/replicas
```

Multiple JSON pointers can be listed for the same resource:

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
        - /spec/template/metadata/annotations
```

One thing to watch for with JSON pointers: forward slashes in field names need to be escaped as `~1` per the RFC 6902 spec. If you need to ignore a label like `node-role.kubernetes.io/worker`, the pointer is `/metadata/labels/node-role.kubernetes.io~1worker`. Tildes are escaped as `~0`.

### JQ Path Expressions

JSON pointers work well for simple, fixed-path fields. They do not work well for list elements, because the index of an element in a list can change. If a mutating webhook injects a container into position 0 of `spec.template.spec.containers`, the container you defined shifts to position 1 and a JSON pointer targeting `/spec/template/spec/containers/0` would ignore the wrong thing.

JQ path expressions solve this by letting you match list elements based on their content rather than their position:

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jqPathExpressions:
        - .spec.template.spec.initContainers[] | select(.name == "istio-init")
        - .spec.template.spec.containers[] | select(.name == "istio-proxy")
```

This ignores the Istio sidecar containers regardless of where they appear in the list. The JQ expression selects list elements by name, so it works even if the webhook inserts them at different positions.

JQ expressions are more powerful than JSON pointers and can handle nested selection, filtering, and even conditional logic. Here are a few more examples:

Ignoring a specific annotation regardless of its value:

```yaml
jqPathExpressions:
  - .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]
```

Ignoring all labels that start with a specific prefix:

```yaml
jqPathExpressions:
  - .metadata.labels | to_entries[] | select(.key | startswith("app.kubernetes.io/"))
```

Ignoring a specific environment variable in all containers:

```yaml
jqPathExpressions:
  - .spec.template.spec.containers[].env[] | select(.name == "INJECTED_VAR")
```

One thing to be aware of: JQ expressions have a default timeout of one second. If you write a complex expression that exceeds this, Argo CD logs a "JQ patch execution timed out" error and the ignore rule silently fails. You can increase the timeout in the `argocd-cmd-params-cm` ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  ignore.normalizer.jq.timeout: "5s"
```

### Managed Fields Managers

Kubernetes tracks which controller or user owns each field in a resource through the `metadata.managedFields` mechanism. Argo CD can use this information to automatically ignore all changes made by a specific field manager.

This is particularly useful for ignoring changes from the kube-controller-manager, which manages fields like `status` and can update metadata on certain resources:

```yaml
spec:
  ignoreDifferences:
    - group: '*'
      kind: '*'
      managedFieldsManagers:
        - kube-controller-manager
```

The wildcard `*` applies to all groups and kinds. You can also target specific resource types:

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      managedFieldsManagers:
        - kube-controller-manager
        - hpa-controller
```

Managed fields managers are the cleanest solution when the source of drift is a well-defined controller. Instead of listing every field a controller might touch, you tell Argo CD to ignore everything that controller owns. The downside is that not all controllers set their field manager name consistently, and some older controllers do not use server-side apply, which means they may not appear in `managedFields` at all.

## System-Level Ignore Rules

Application-level `ignoreDifferences` works fine for individual Applications, but if you have hundreds of Applications and they all suffer from the same drift source (like an Istio sidecar injector), configuring each one individually is painful. System-level ignore rules solve this.

### Per-Resource-Type Rules

System-level rules are configured in the `argocd-cm` ConfigMap using the key pattern `resource.customizations.ignoreDifferences.<group>_<kind>`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations.ignoreDifferences.apps_Deployment: |
    jsonPointers:
    - /spec/replicas
    managedFieldsManagers:
    - kube-controller-manager
```

This ignores the replicas field and all kube-controller-manager changes for every Deployment in every Application managed by this Argo CD instance. The key format uses the API group (with literal dots) separated from the kind by an underscore.

For resources in the core API group (like Services, ConfigMaps, and Secrets), omit the group prefix entirely. For example, to ignore a field on all Services:

```yaml
data:
  resource.customizations.ignoreDifferences.Service: |
    jsonPointers:
    - /spec/clusterIP
    - /spec/clusterIPs
```

A common system-level rule for environments running a service mesh is to ignore the injected sidecar containers globally:

```yaml
data:
  resource.customizations.ignoreDifferences.apps_Deployment: |
    jqPathExpressions:
    - .spec.template.spec.initContainers[] | select(.name == "istio-init")
    - .spec.template.spec.containers[] | select(.name == "istio-proxy")
```

Another common one is the cert-manager caBundle injection into webhook configurations:

```yaml
data:
  resource.customizations.ignoreDifferences.admissionregistration.k8s.io_MutatingWebhookConfiguration: |
    jqPathExpressions:
    - '.webhooks[]?.clientConfig.caBundle'
  resource.customizations.ignoreDifferences.admissionregistration.k8s.io_ValidatingWebhookConfiguration: |
    jqPathExpressions:
    - '.webhooks[]?.clientConfig.caBundle'
```

### Global Rules

If you want a rule to apply across all resource types in all Applications, use the special `all` key:

```yaml
data:
  resource.customizations.ignoreDifferences.all: |
    managedFieldsManagers:
    - kube-controller-manager
    jsonPointers:
    - /metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration
```

Use global rules sparingly. Ignoring too much at the global level undermines the entire point of GitOps drift detection.

### Configuration Hierarchy

When multiple ignore rules apply to the same resource, they are merged. Application-level rules are combined with system-level resource-specific rules and system-level global rules. You do not need to worry about one overriding the other. They are additive.

## Diff Strategies

Beyond ignoring specific fields, Argo CD also supports different algorithms for computing diffs. The choice of diff strategy affects how the comparison is performed at a fundamental level.

### Legacy Diff (Default)

The legacy strategy applies a three-way diff based on the live state, the desired state from Git, and the `last-applied-configuration` annotation. This is the same approach kubectl uses when you run `kubectl apply`. It works well in most cases, but it has limitations with defaulted fields and normalized values.

The legacy strategy compares the full resource, which means any field present in the live state but absent from the Git manifest is flagged as a diff. This is why defaulted fields cause so many OutOfSync issues with the legacy strategy.

### Server-Side Diff

Server-side diff, stable since Argo CD v3.1, takes a fundamentally different approach. Instead of computing the diff client-side, Argo CD sends the desired manifest to the Kubernetes API server as a server-side apply dry run. The API server applies all its defaulting, normalization, and validation, then returns what the resource would look like after the apply. Argo CD compares that result against the live state.

This is a significant improvement because the API server handles all the normalization that causes phantom drift. Resource quantities are normalized consistently. Default values are filled in. The comparison is between what the resource would look like after a real apply and what it actually looks like, which eliminates an entire class of false diffs.

Enable server-side diff globally in the `argocd-cmd-params-cm` ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  controller.diff.server.side: "true"
```

This requires restarting the argocd-application-controller.

You can also enable or disable it per Application using an annotation:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  annotations:
    argocd.argoproj.io/compare-options: ServerSideDiff=true
```

To disable server-side diff for a specific Application when it is enabled globally:

```yaml
metadata:
  annotations:
    argocd.argoproj.io/compare-options: ServerSideDiff=false
```

#### Mutation Webhooks and Server-Side Diff

By default, server-side diff excludes changes from mutating admission webhooks. This is usually what you want because those mutations are applied outside of Git. But if you want the diff to include webhook mutations (for example, to verify that your Istio sidecar configuration is correct), you can enable it:

```yaml
metadata:
  annotations:
    argocd.argoproj.io/compare-options: ServerSideDiff=true,IncludeMutationWebhook=true
```

The `IncludeMutationWebhook` option only works when server-side diff is enabled.

#### Caching

Server-side diff caches results aggressively. A new server-side apply dry run only happens when the application is refreshed, a new Git revision is detected, the Application spec changes, or the resource version of the live state changes. This keeps the API server load reasonable even with many Applications.

## Status Field Handling

Many CRDs store runtime information in their `.status` field. If you commit CRDs with their status to Git (which some tools like Crossplane do), Argo CD needs to compare the status field. But for most resources, the status is set by controllers and should be ignored entirely.

Argo CD controls this with the `ignoreResourceStatusField` option in `argocd-cm`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.compareoptions: |
    ignoreResourceStatusField: all
```

The options are:

- `all` — Ignore the status field on all resources. This is the default.
- `crd` — Only ignore the status field on resources that are defined by a CustomResourceDefinition. Use this if you have resources where you intentionally commit status to Git.
- `none` — Do not ignore the status field on any resource. This is rarely useful and will cause a lot of noise.

If you use Crossplane or a similar tool that expects status to be part of the desired state, `crd` is the right choice.

## Known Type Fields

Some CRDs embed standard Kubernetes types in their spec. Argo Rollouts, for example, includes a `PodSpec` under `spec.template.spec`. The problem is that Kubernetes normalizes fields inside PodSpec in specific ways (resource quantities, duration strings, etc.), but Argo CD does not know that a CRD field contains a PodSpec unless you tell it.

The `knownTypeFields` configuration tells Argo CD to apply the same normalization rules it uses for built-in types to specific CRD fields:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations.knownTypeFields.argoproj.io_Rollout: |
    - field: spec.template.spec
      type: core/v1/PodSpec
    - field: spec.strategy.canary.stableMetadata.labels
      type: map[string]string
```

The supported types include `core/v1/PodSpec`, `core/Quantity`, and `meta/v1/Duration`. This is particularly relevant for Argo Rollouts, Knative, and any CRD that includes a PodSpec in its schema.

## Aggregated ClusterRoles

If you use Kubernetes aggregated ClusterRoles (ClusterRoles with an `aggregationRule` that pulls in rules from other ClusterRoles), you will see drift because the aggregated rules are added by the controller at runtime. They are not in your Git manifest.

Enable this in the `argocd-cm` ConfigMap:

```yaml
data:
  resource.compareoptions: |
    ignoreAggregatedRoles: true
```

This tells Argo CD to ignore changes to the `rules` field in ClusterRoles that have an `aggregationRule` defined.

## Debugging Diff Issues

When you cannot figure out why an Application is OutOfSync, the Argo CD CLI has useful debugging tools.

### Viewing the Diff

The `argocd app diff` command shows you exactly what Argo CD sees as different:

```bash
argocd app diff my-app
```

This outputs a standard diff between the desired state and the live state. If you have already configured `ignoreDifferences`, those fields will be excluded from the output.

### Testing Ignore Rules

The `argocd admin settings resource-overrides ignore-differences` command lets you test your system-level ignore rules against a live resource without deploying the change:

```bash
argocd admin settings resource-overrides ignore-differences ./my-resource.yaml \
  --argocd-cm-path ./argocd-cm.yaml
```

This applies the ignore rules from the provided ConfigMap to the resource and shows you what remains after the ignored fields are removed.

### Checking Resource Customizations

To see all resource customizations currently in effect:

```bash
argocd admin settings resource-overrides list
```

This lists every customization including ignore differences, health checks, and actions, giving you a full picture of what Argo CD is doing differently from its defaults.

## Putting It Together: A Common Setup

Here is a practical starting configuration for teams running Argo CD with an Istio service mesh and HPA-managed workloads. This goes in the `argocd-cm` ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # Ignore replicas managed by HPA across all Deployments
  resource.customizations.ignoreDifferences.apps_Deployment: |
    jsonPointers:
    - /spec/replicas
    jqPathExpressions:
    - .spec.template.spec.initContainers[] | select(.name == "istio-init")
    - .spec.template.spec.containers[] | select(.name == "istio-proxy")
    - .spec.template.metadata.annotations["sidecar.istio.io/status"]
    managedFieldsManagers:
    - kube-controller-manager

  # Ignore caBundle injected by cert-manager
  resource.customizations.ignoreDifferences.admissionregistration.k8s.io_MutatingWebhookConfiguration: |
    jqPathExpressions:
    - '.webhooks[]?.clientConfig.caBundle'

  resource.customizations.ignoreDifferences.admissionregistration.k8s.io_ValidatingWebhookConfiguration: |
    jqPathExpressions:
    - '.webhooks[]?.clientConfig.caBundle'

  # Ignore aggregated ClusterRole rules
  resource.compareoptions: |
    ignoreAggregatedRoles: true
```

And in the `argocd-cmd-params-cm` ConfigMap, enable server-side diff to eliminate most normalization-related drift:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  controller.diff.server.side: "true"
```

Server-side diff alone eliminates a huge number of phantom drift cases. Combined with targeted `ignoreDifferences` rules for known mutation sources like Istio and cert-manager, most teams find that their OutOfSync issues disappear entirely.

The key principle is to be specific. Do not blanket-ignore entire resource trees. Each ignore rule should target a known source of drift, and you should be able to explain why each rule exists. Argo CD's diff detection is one of its most important features, and overly aggressive ignoring turns it off.

If you need help tracking down phantom drift, tuning ignore rules, or rolling out server-side diff across your Argo CD instance, [get in touch](/contact).

## Further Reading

- [Argo CD Diff Customization docs](https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/)
- [Argo CD Diff Strategies docs](https://argo-cd.readthedocs.io/en/stable/user-guide/diff-strategies/)
- [Custom Health Checks](/blog/argo-cd-custom-health-checks/) for controlling how Argo CD evaluates resource health
- [Sync Waves and Hooks](/blog/argo-cd-sync-waves-and-hooks/) for controlling sync ordering
