---
title: "Multi-Tenant Argo CD: Apps in Any Namespace"
date: 2026-04-10
description: "Every team piling Applications into argocd creates name collisions, bloated RBAC, and noisy events. Apps in Any Namespace lets each team own their Applications while keeping a shared control plane."
image: /blog/images/apps-any-namespace-hero.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - multi-tenancy
---

<div class="blog-hero">
  <img src="/blog/images/apps-any-namespace-hero.svg" alt="Kubernetes namespace icons with a subscript Argo CD logo on each" width="600" style="display: inline-block;">
</div>

You run a shared Argo CD instance for the whole company. Every team's Application manifests land in the `argocd` namespace. Team A names their frontend `web`. Team B wants to call theirs `web` too. They can't. So you invent a prefix scheme like `teamb-web` and document it in a wiki that nobody reads. Then team C asks for RBAC to manage only their apps, and you spend an afternoon writing Casbin policies full of wildcard prefixes. A month later, the audit log is full of noisy events from apps that have nothing to do with each other, and the `argocd` namespace has four hundred Application objects in it.

This is the default way most people run Argo CD, and it gets ugly at scale. The control plane namespace becomes a shared junk drawer. RBAC becomes prefix-matching gymnastics. Resource events from every team pile up in one place. There is no natural blast radius between tenants.

Apps in Any Namespace fixes this. It lets you keep a single shared Argo CD control plane but stores each team's Application resources in their own namespaces. Teams get a real boundary, RBAC gets a real scope, and you stop playing naming-convention whack-a-mole.

This post walks through what the feature does, how to enable it safely, how AppProject `sourceNamespaces` gate what gets reconciled, what changes for RBAC and the CLI, why you should switch resource tracking methods before turning it on, and the security mistakes that are easy to make. If you are still getting familiar with how AppProjects and RBAC fit together, my [AppProjects and RBAC post](/blog/argo-cd-appprojects-rbac/) is a good primer.

## What Changes With Apps in Any Namespace

By default, Argo CD only reconciles Application resources that live in its own control plane namespace, typically `argocd`. With Apps in Any Namespace enabled, you can list other namespaces where Application resources are also watched and reconciled. Those Applications are still owned by a project, still managed by the same application controller, and still show up in the same UI. The only difference is where the YAML lives.

The feature has been available since Argo CD v2.5 and is no longer a beta. It is a prerequisite for multi-tenant setups where you want per-team isolation without running a separate Argo CD instance per team.

There is one important constraint up front: you must be running a cluster-scoped Argo CD installation. The namespace-scoped install mode cannot use this feature because the controller does not have permissions to watch resources outside its own namespace.

## Check Your Resource Tracking Method First

Before you turn anything on, check how Argo CD tracks ownership of the resources it manages. In Argo CD v3.0 and later, the tracking method defaults to `annotation`, which uses the `argocd.argoproj.io/tracking-id` annotation. In v2.x installs, the default was `label`, which stamps the `app.kubernetes.io/instance` label on every managed resource with the Application name.

Label-based tracking works fine when every Application lives in `argocd`, because the name is unique within a single namespace. Once Applications can live in multiple namespaces, the effective identifier becomes `<namespace>/<name>`, and Kubernetes label values are limited to 63 characters. Long combinations will hit the limit and break tracking.

If you are still on a 2.x install with label tracking, switch to `annotation` before enabling Apps in Any Namespace. Annotations have no 63-character limit and do not conflict with other tools that also write the `app.kubernetes.io/instance` label. If you are already on v3.0 or later, the default is already `annotation` and there is nothing to change here, though it is worth confirming that your `argocd-cm` has not been overridden to `label` in your GitOps config.

Update the `argocd-cm` ConfigMap if a change is needed:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  application.resourceTrackingMethod: annotation
```

If you have external tools that still read the `app.kubernetes.io/instance` label, you can use `annotation+label` instead. Argo CD will use the annotation for actual tracking and write the label as well for compatibility.

After changing the tracking method, you need to refresh or resync your Applications for the change to take effect on their managed resources.

## Enabling the Feature

With tracking sorted, enable Apps in Any Namespace by setting `application.namespaces` in the `argocd-cmd-params-cm` ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  application.namespaces: "team-alpha, team-beta, platform-*"
```

The value is a comma-separated list. It supports three pattern types: literal names like `team-alpha`, shell-style wildcards like `platform-*`, and Go regular expressions wrapped in forward slashes like `/^((?!kube-).*)$/`. A single `*` allows any namespace, which is almost never what you want in a shared cluster.

After updating the ConfigMap, restart the API server and the application controller so they pick up the new namespace list:

```bash
kubectl rollout restart -n argocd deployment argocd-server
kubectl rollout restart -n argocd statefulset argocd-application-controller
```

You also need to grant the API server the cluster-wide RBAC permissions to manage Application resources across namespaces. The Argo CD repository ships [example manifests](https://github.com/argoproj/argo-cd/tree/master/examples/k8s-rbac/argocd-server-applications) that define the required ClusterRole and ClusterRoleBinding. Apply those before anyone tries to use the feature, otherwise the API server will fail when attempting to read or write Applications in the new namespaces.

## AppProject sourceNamespaces: The Second Gate

Enabling the namespace list in `argocd-cmd-params-cm` is only half the story. It tells Argo CD which namespaces are eligible in principle. The second gate is the AppProject, which decides which of those namespaces each project actually allows.

An Application in a non-control-plane namespace will only reconcile if both conditions are true: its namespace is listed in `application.namespaces`, and the AppProject it references has that namespace in `spec.sourceNamespaces`. Miss either one, and the controller refuses to touch the Application.

Here is an AppProject that scopes team-alpha's apps to their own namespace:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-alpha
  namespace: argocd
spec:
  description: Team Alpha workloads
  sourceRepos:
    - https://github.com/acme/team-alpha-*
  destinations:
    - namespace: team-alpha-*
      server: https://kubernetes.default.svc
  sourceNamespaces:
    - team-alpha
  clusterResourceWhitelist: []
  namespaceResourceWhitelist:
    - group: "*"
      kind: "*"
```

The `sourceNamespaces` entries accept shell-style wildcards, so you could write `team-alpha-*` to cover multiple team namespaces under one project if that matches your tenancy model.

Two rules worth being explicit about:

**Never add untrusted namespaces to the `default` AppProject.** The `default` project has permissive settings out of the box, and adding a user-controlled namespace to its `sourceNamespaces` effectively gives that user the ability to deploy anywhere the project allows. Create purpose-built projects for each tenant and keep the default project reserved for the control plane.

**Never list `argocd` in `sourceNamespaces` for a user-facing project.** Applications in the control plane namespace get legacy behavior and bypass the `sourceNamespaces` check entirely for backwards compatibility. If you add `argocd` to a tenant project, you are giving that tenant a path to impersonate the control plane's trust boundary.

## Creating an Application in a Team Namespace

With the feature enabled and an AppProject scoped to `team-alpha`, a developer on that team can now drop an Application manifest into their own namespace:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: web
  namespace: team-alpha
spec:
  project: team-alpha
  source:
    repoURL: https://github.com/acme/team-alpha-web
    targetRevision: HEAD
    path: deploy
  destination:
    server: https://kubernetes.default.svc
    namespace: team-alpha-prod
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Team Beta can have a completely separate Application named `web` in the `team-beta` namespace, and there is no conflict. Each namespace is its own key space for Application names. The full identity of this app is now `team-alpha/web`, and Team Beta's is `team-beta/web`.

## CLI and UI Changes

In the CLI, applications outside the control plane namespace are addressed as `<namespace>/<name>`. For example, to fetch status on the app above:

```bash
argocd app get team-alpha/web
argocd app sync team-alpha/web
argocd app manifests team-alpha/web
```

For Applications that still live in the `argocd` control plane namespace, the old single-name form continues to work, so `argocd app get web` is equivalent to `argocd app get argocd/web`. This backwards compatibility means you do not have to migrate existing Applications to change how you address them.

The UI and API follow the same convention. In the application list, tenant-namespace apps render with the namespace prefix, while control-plane apps render with just the name.

## RBAC Format Changes

Once Applications can live outside `argocd`, the RBAC policy format gains an extra segment. The object expression changes from `<project>/<application>` to `<project>/<namespace>/<application>`.

Rules written in the old two-segment form still apply to Applications in the control plane namespace, which preserves backwards compatibility for existing policies. New rules targeting tenant namespaces need the three-segment form. Here is a policy giving `team-alpha-admin` full control over their own namespace and read-only access across the cluster:

```
p, role:team-alpha-admin, applications, *, team-alpha/team-alpha/*, allow
p, role:team-alpha-admin, applications, get, */*/*, allow
g, team-alpha-leads, role:team-alpha-admin
```

The first rule reads as: allow any action on Applications in project `team-alpha`, namespace `team-alpha`, with any name. The second rule reads as: allow `get` on Applications in any project, any namespace, with any name. Both segments support wildcards, and you can mix them. If you want to give a role visibility into one namespace across all projects, write something like `*/team-alpha/*`.

The same pattern applies to related resource types like `logs` and `exec`. Rules for those resources also take the three-segment form once the feature is enabled.

## Notifications in Tenant Namespaces

One of the quieter benefits of Apps in Any Namespace is that each team can own their own notification configuration. By default, Argo CD notifications are configured globally in the `argocd-notifications-cm` ConfigMap in the control plane namespace. That centralizes Slack channels, PagerDuty routes, and templates in one place, which can become a bottleneck.

With tenant-namespace Applications, teams can place their own `argocd-notifications-cm` ConfigMap and optionally an `argocd-notifications-secret` in the namespace where their Application lives. The notifications controller will read the local config and send alerts based on it, while still supporting global configuration from the control plane namespace.

This is not automatic. Admins must explicitly enable self-service notifications by setting `notificationscontroller.selfservice.enabled` in `argocd-cmd-params-cm`:

```yaml
data:
  notificationscontroller.selfservice.enabled: "true"
```

The notifications controller also needs cluster-wide RBAC to watch Applications and read config across namespaces. The Argo CD repository ships `argocd-notifications-controller-rbac-clusterrole.yaml` and `argocd-notifications-controller-rbac-clusterrolebinding.yaml` in the [same example RBAC directory](https://github.com/argoproj/argo-cd/tree/master/examples/k8s-rbac/argocd-server-applications) for exactly this purpose. Apply those alongside the API server RBAC before teams start configuring their own notifications. If you have not set up Argo CD notifications before, the [notifications post](/blog/argo-cd-notifications/) covers triggers and templates from the ground up.

## What About ApplicationSets?

Apps in Any Namespace handles Application resources, but ApplicationSet resources live in the control plane namespace by default. There is a separate feature called ApplicationSet in Any Namespace, introduced as a beta in v2.8, that lets you place ApplicationSet resources in tenant namespaces as well.

You enable it with a parallel ConfigMap key in `argocd-cmd-params-cm`:

```yaml
data:
  applicationsetcontroller.namespaces: "team-alpha, team-beta"
```

There are two constraints to know about. First, Apps in Any Namespace must already be enabled, with matching namespace lists. An ApplicationSet cannot generate Applications into a namespace that Apps in Any Namespace does not permit. Second, an ApplicationSet generates its child Applications in the same namespace as the ApplicationSet itself. You cannot put an ApplicationSet in `argocd` and have it create Applications in `team-alpha`. If team-alpha wants ApplicationSet-based generation, their ApplicationSet has to live in their own namespace.

Because ApplicationSet generators like SCM Provider and Pull Request can pull secrets and reach external URLs, running them in tenant namespaces opens an SCM token exfiltration path if unchecked. Admins should restrict allowed SCM provider URLs with `ARGOCD_APPLICATIONSET_CONTROLLER_ALLOWED_SCM_PROVIDERS` and, if available in your version, enable `tokenref.strict.mode` to require that referenced secrets carry the `argocd.argoproj.io/secret-type: scm-creds` label.

## Gotchas

A handful of things can surprise you on first use.

**Resource tracking label overflow.** I mentioned this above, but it is worth repeating. If your install still uses label tracking and you enable Apps in Any Namespace without switching to annotation tracking, any Application whose namespace plus name exceeds 63 characters will break. The Application will show as out of sync or fail to reconcile with label errors. Argo CD v3.0 and later ship with annotation tracking as the default, so most modern installs will not hit this unless their `argocd-cm` was explicitly overridden.

**Restarts matter.** After changing `argocd-cmd-params-cm`, restart both the API server deployment and the application controller StatefulSet. If you restart only the API server, the controller will keep ignoring Applications in new namespaces until it restarts too.

**Control plane Applications bypass sourceNamespaces.** Applications in the `argocd` namespace ignore the `sourceNamespaces` check in their project. This is backwards-compatible behavior, but it means you should not treat the control plane as just another tenant namespace. Put platform and shared-infra apps in `argocd`, and put team apps in their own namespaces.

**Cluster-scoped installations only.** A namespace-scoped Argo CD install, where the controller only has RBAC inside its own namespace, cannot support this feature. If you installed with `install-namespace-install.yaml`, you will need to migrate to the cluster-scoped install before enabling.

**Do not grant write access to unknown namespaces.** It is tempting to set `application.namespaces: "*"` and move on. Do not. That lets anyone who can create namespaces also create Applications in them, and unless every AppProject is tightly locked down, that is a path to unexpected deployments. Enumerate the namespaces you actually want, or use a regex that explicitly excludes system namespaces.

## When This Is Worth It

Apps in Any Namespace is the right move when multiple teams share one Argo CD instance and you want each team to own their Applications as YAML files in their own namespaces. If you are running Argo CD for a single team, or if you have a small number of Applications, the feature adds configuration overhead without a real payoff.

The sweet spot is somewhere around the point where RBAC rules for the control plane namespace start growing into prefix-matching Casbin policies, or where Application names are forced into `team-` prefixes to avoid collisions. That is the symptom of a shared namespace trying to act like a multi-tenant system. Apps in Any Namespace gives you the real thing.

It also plays well with AppProjects. Each AppProject can scope its `sourceNamespaces` to exactly the tenant namespaces it covers, and the RBAC rules for that project can be written in terms of the real namespace structure rather than string prefixes. Combined with per-namespace notifications, each team ends up with a self-contained slice of the Argo CD experience, while platform teams keep a single control plane to operate.

## Wrapping Up

Apps in Any Namespace is one of the more impactful multi-tenancy features Argo CD has shipped. It is not flashy, but it rearranges the mental model enough that shared Argo CD installations stop feeling cramped. Switch your resource tracking method first, list your allowed namespaces in `argocd-cmd-params-cm`, configure each AppProject's `sourceNamespaces`, apply the extra RBAC manifests for the API server and notifications controller, and you are done. Tenants get real namespaces, RBAC gets a real scope, and the `argocd` namespace stops being a pile of everybody's YAML.

If you need help setting up Apps in Any Namespace for your team or want to talk through your multi-tenancy strategy, feel free to [reach out](/contact).
