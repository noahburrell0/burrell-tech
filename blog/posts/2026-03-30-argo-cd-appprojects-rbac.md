---
title: "How to Lock Down Argo CD for Multiple Teams with AppProjects and RBAC"
date: 2026-03-30
modified: 2026-04-04
description: "Sharing one Argo CD instance across teams without proper isolation is asking for trouble. Learn how to scope access with AppProjects, Casbin policies, and OIDC role bindings."
image: /blog/images/appproject-rbac-hero.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - security
  - multi-tenancy
---

<div class="blog-hero">
  <img src="/blog/images/appproject-rbac-hero.svg" alt="Argo CD AppProject RBAC controlling access for multiple teams" width="200" style="display: inline-block;">
</div>

A single Argo CD instance can serve an entire organization, but only if every team trusts every other team with full access to every cluster and every application. In practice that never holds. The frontend team should not be able to delete the payment service. The intern experimenting with a dev cluster should not be able to sync to production. And nobody outside the platform team should be deploying CRDs or ClusterRoles.

Argo CD solves this with two mechanisms that work together: AppProjects and RBAC. An AppProject defines the boundaries of what an Application can do, restricting which repositories it can pull from, which clusters and namespaces it can deploy to, and which Kubernetes resource types it is allowed to create. RBAC defines who can do what within those boundaries, controlling which users and groups can view, sync, delete, or manage Applications belonging to a given Project.

If you are new to Argo CD, my [getting started guide](/blog/argo-cd/) covers installation and core concepts. This post assumes you have a working Argo CD instance and at least one Application deployed, and you want to move beyond the permissive defaults toward a production-grade access model.

## The Default Project and Why You Should Stop Using It

Every Argo CD installation ships with a built-in Project called `default`. It permits any source repository, any destination cluster and namespace, and all resource types. When you follow a quickstart tutorial and create an Application without specifying a project, it lands in `default` and everything works because nothing is restricted.

This is fine for learning but dangerous for production. An Application in the `default` project can deploy a ClusterRole that grants itself admin privileges across the cluster. It can pull manifests from any Git repository, including one controlled by someone outside your organization if the URL is misconfigured. It can write resources into `kube-system` or any other sensitive namespace.

The first step toward a secure multi-tenant setup is to restrict the `default` project and create purpose-built projects for each team or workload category. You cannot delete the `default` project, but you can lock it down so that no Applications can use it:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: default
  namespace: argocd
spec:
  sourceRepos: []
  destinations: []
  clusterResourceWhitelist: []
  namespaceResourceWhitelist: []
```

With empty lists for source repos and destinations, any Application assigned to the `default` project will fail to sync. This forces teams to explicitly assign their Applications to a project that has been configured with appropriate boundaries.

## Creating an AppProject

An AppProject is a namespaced custom resource that lives in the same namespace as Argo CD, typically `argocd`. Here is a project for a hypothetical payments team:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments
  namespace: argocd
spec:
  description: "Applications owned by the payments team"
  sourceRepos:
    - 'https://github.com/mycompany/payments-*.git'
    - 'https://charts.example.com/*'
  destinations:
    - server: https://kubernetes.default.svc
      namespace: 'payments-*'
    - server: https://kubernetes.default.svc
      namespace: payments
  clusterResourceWhitelist: []
  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'
```

This project allows Applications to pull from any GitHub repo matching the `payments-*` pattern and any chart from the company Helm repository. It allows deployments only to the in-cluster server and only to namespaces that start with `payments-` or the exact `payments` namespace. The `clusterResourceWhitelist` is empty, which means Applications in this project cannot create cluster-scoped resources like Namespaces, ClusterRoles, or CRDs. The `namespaceResourceWhitelist` allows all namespaced resource types.

### Source Repository Controls

The `sourceRepos` field accepts exact URLs and glob patterns. You can also negate entries using the `!` prefix to create deny rules:

```yaml
spec:
  sourceRepos:
    - 'https://github.com/mycompany/*'
    - '!https://github.com/mycompany/infrastructure-secrets.git'
```

This permits any repo under the company GitHub org except the infrastructure-secrets repo. The evaluation logic works in two steps: first, at least one allow rule must match the source URL; second, no deny rule can match it. If both an allow and a deny rule match, the deny wins.

### Destination Controls

Destinations are pairs of a server URL and a namespace. Both support glob patterns and negation:

```yaml
spec:
  destinations:
    - server: '*'
      namespace: '*'
    - server: '*'
      namespace: '!kube-system'
    - server: '!https://production.k8s.example.com'
      namespace: '*'
```

This configuration allows deployment to any namespace on any cluster, except `kube-system` on all clusters and except the production cluster entirely. The same two-step evaluation applies: an allow rule must match, and no deny rule can reject it.

### Resource Type Restrictions

You have four fields that control which Kubernetes resource types an Application can manage:

`clusterResourceWhitelist` and `clusterResourceBlacklist` control cluster-scoped resources like Namespaces, ClusterRoles, ClusterRoleBindings, CRDs, and IngressClasses. `namespaceResourceWhitelist` and `namespaceResourceBlacklist` control namespaced resources like Deployments, Services, ConfigMaps, and Secrets.

When neither whitelist nor blacklist is specified for namespace resources, the default behavior is to allow all namespaced resource types. For cluster-scoped resources, the intended default is to deny all, but there have been edge cases in older versions where an empty whitelist was treated as permissive. To be explicit about denying cluster-scoped resources, you can combine an empty whitelist with a wildcard blacklist:

```yaml
spec:
  clusterResourceWhitelist: []
  clusterResourceBlacklist:
    - group: '*'
      kind: '*'
```

A common pattern for application teams is to deny all cluster resources and allow all namespace resources, which is what we did in the payments example. Platform teams that need to manage infrastructure might get a more permissive project:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: platform
  namespace: argocd
spec:
  description: "Infrastructure managed by the platform team"
  sourceRepos:
    - 'https://github.com/mycompany/platform-*.git'
    - 'https://charts.example.com/*'
  destinations:
    - server: '*'
      namespace: '*'
  clusterResourceWhitelist:
    - group: '*'
      kind: '*'
  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'
```

If you want to be more surgical, you can allow specific cluster resource types rather than wildcarding everything:

```yaml
spec:
  clusterResourceWhitelist:
    - group: ''
      kind: Namespace
    - group: rbac.authorization.k8s.io
      kind: ClusterRole
    - group: rbac.authorization.k8s.io
      kind: ClusterRoleBinding
    - group: networking.k8s.io
      kind: IngressClass
```

You can also restrict cluster resources by name using the `name` field with glob patterns:

```yaml
spec:
  clusterResourceWhitelist:
    - group: ''
      kind: Namespace
      name: 'payments-*'
```

This lets the project create Namespaces, but only ones whose names start with `payments-`. Attempts to create a Namespace with any other name will be rejected.

## How RBAC Works in Argo CD

AppProjects define boundaries for Applications, but they do not control which users can interact with those Applications. That is the job of RBAC.

Argo CD's RBAC system is built on [Casbin](https://casbin.org/), an open-source access control library. Policies are stored in the `argocd-rbac-cm` ConfigMap in the `argocd` namespace. Each policy line follows a specific format:

```
p, <subject>, <resource>, <action>, <object>, <effect>
```

The subject is a role name, a user, or an SSO group. The resource is one of Argo CD's resource types. The action is what the subject wants to do. The object identifies the specific resource instance. And the effect is either `allow` or `deny`.

Here is a concrete example that gives the `payments-dev` role read-only access to all Applications in the `payments` project:

```
p, role:payments-dev, applications, get, payments/*, allow
```

The `payments/*` object follows the pattern `<project-name>/<application-name>`. The wildcard means any Application within the payments project.

### Resource Types and Actions

Each Argo CD resource type supports specific actions:

**applications**: `get`, `create`, `update`, `delete`, `sync`, `action`, `override`

**applicationsets**: `get`, `create`, `update`, `delete`

**clusters**: `get`, `create`, `update`, `delete`

**projects**: `get`, `create`, `update`, `delete`

**repositories**: `get`, `create`, `update`, `delete`

**accounts**: `get`, `update`

**certificates**: `get`, `create`, `delete`

**gpgkeys**: `get`, `create`, `delete`

**logs**: `get`

**exec**: `create`

**extensions**: `invoke`

The `logs` and `exec` resources deserve special attention. The `logs` resource controls access to application pod logs through the Argo CD UI and API. The `exec` resource controls the web terminal feature that lets users execute commands inside running pods. Both use the `<project>/<application>` object format.

### Built-in Roles

Argo CD provides two built-in roles:

`role:readonly` grants `get` access to all resources. `role:admin` grants unrestricted access to everything. You assign users or groups to these roles with group binding lines:

```
g, my-admin-group, role:admin
g, readonly-users, role:readonly
```

For most production setups, you will want custom roles that sit between these extremes.

### Fine-Grained Sub-Resource Permissions

The `update` and `delete` actions on applications support an extended format that targets specific Kubernetes resource types within an Application:

```
p, role:payments-ops, applications, delete/*/Pod/*/*, payments/*, allow
```

The format after the action is `<action>/<api-group>/<kind>/<namespace>/<name>`. This policy allows the `payments-ops` role to delete Pods within any Application in the payments project, but not Deployments, Services, or any other resource type. This is useful for allowing teams to restart pods without giving them the ability to delete an entire Application.

### Deny Rules

The `deny` effect creates explicit rejections that override allow rules. If a subject matches both an allow and a deny policy for the same request, the deny wins:

```
p, role:payments-dev, applications, *, payments/*, allow
p, role:payments-dev, applications, delete, payments/payments-production, deny
```

This grants the `payments-dev` role full access to all Applications in the payments project, except it explicitly prevents deletion of the `payments-production` Application. Deny rules are a safety net for protecting critical resources even from users who otherwise have broad permissions.

## Binding SSO Groups to Roles

Argo CD supports local accounts configured in the `argocd-cm` ConfigMap, including a built-in `admin` account. You can create additional local users and assign them passwords or restrict them to API-only access. However, local accounts do not support group membership, which limits how you can structure RBAC around them. For production multi-tenant setups, most organizations use an SSO provider like Okta, Azure AD, Keycloak, or Dex (which ships with Argo CD) because SSO tokens carry group claims that map cleanly to RBAC role bindings.

Here is a complete `argocd-rbac-cm` ConfigMap that defines roles for two teams:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:authenticated
  policy.csv: |
    # Default role for authenticated users - intentionally grants no permissions
    p, role:authenticated, *, *, */*, deny

    # Payments team roles
    p, role:payments-admin, applications, *, payments/*, allow
    p, role:payments-admin, applicationsets, *, payments/*, allow
    p, role:payments-admin, logs, get, payments/*, allow
    p, role:payments-admin, exec, create, payments/*, allow
    p, role:payments-admin, repositories, get, payments/*, allow

    p, role:payments-viewer, applications, get, payments/*, allow
    p, role:payments-viewer, logs, get, payments/*, allow

    # Frontend team roles
    p, role:frontend-admin, applications, *, frontend/*, allow
    p, role:frontend-admin, applicationsets, *, frontend/*, allow
    p, role:frontend-admin, logs, get, frontend/*, allow
    p, role:frontend-admin, repositories, get, frontend/*, allow

    p, role:frontend-viewer, applications, get, frontend/*, allow

    # SSO group bindings
    g, payments-engineers, role:payments-admin
    g, payments-oncall, role:payments-viewer
    g, frontend-engineers, role:frontend-admin
    g, frontend-oncall, role:frontend-viewer

    # Platform team SSO group gets admin
    g, platform-admins, role:admin
  scopes: '[groups]'
```

The `policy.default: role:authenticated` line is important. The [Argo CD RBAC documentation](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/) recommends creating a `role:authenticated` with the minimum set of permissions possible and assigning it as the default. Here we define `role:authenticated` with an explicit deny-all policy, so any authenticated user who does not match a group binding can still log in but will have no access to applications, projects, or other resources. The [official example ConfigMap](https://github.com/argoproj/argo-cd/blob/master/docs/operator-manual/argocd-rbac-cm.yaml) shows `policy.default: role:readonly` as a starting point, but that grants every authenticated user read access to every Application across every project, which is too permissive for a multi-tenant setup.

The `scopes` field tells Argo CD which OIDC claims to use for group membership. The value `[groups]` is the most common configuration and maps to the `groups` claim in the OIDC token.

### Composing Policies Across Multiple ConfigMap Keys

For organizations with many teams, a single `policy.csv` can become unwieldy. Argo CD supports splitting policies across multiple keys using the `policy.<name>.csv` naming convention:

```yaml
data:
  policy.csv: |
    g, platform-admins, role:admin
  policy.payments.csv: |
    p, role:payments-admin, applications, *, payments/*, allow
    g, payments-engineers, role:payments-admin
  policy.frontend.csv: |
    p, role:frontend-admin, applications, *, frontend/*, allow
    g, frontend-engineers, role:frontend-admin
```

Argo CD concatenates the main `policy.csv` with all `policy.<name>.csv` keys in alphabetical order by key name. The result is a single combined policy set.

## Project Roles and JWT Tokens

In addition to SSO-based RBAC, AppProjects support their own role definitions with JWT tokens. This is primarily useful for CI/CD pipelines and automation that needs to interact with Argo CD's API programmatically.

Project roles are defined inline within the AppProject spec:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments
  namespace: argocd
spec:
  roles:
    - name: ci-deployer
      description: "Used by the CI pipeline to sync Applications"
      policies:
        - p, proj:payments:ci-deployer, applications, sync, payments/*, allow
        - p, proj:payments:ci-deployer, applications, get, payments/*, allow
    - name: monitoring
      description: "Used by monitoring tools to read application status"
      policies:
        - p, proj:payments:monitoring, applications, get, payments/*, allow
```

The policy subject must follow the pattern `proj:<project-name>:<role-name>`. This is different from the global RBAC policies in `argocd-rbac-cm`, which use `role:<role-name>`.

After defining the role, you generate a JWT token for it:

```bash
argocd proj role create-token payments ci-deployer
```

The token is printed once and not stored by Argo CD. Treat it like any other secret and store it in your secrets manager. The token inherits the role's policies, and any changes to those policies take effect immediately for existing tokens without needing to regenerate them.

You can use the token with the Argo CD CLI or API:

```bash
argocd app sync payments-api --auth-token "$ARGOCD_TOKEN"
```

Or as an environment variable:

```bash
export ARGOCD_AUTH_TOKEN="$ARGOCD_TOKEN"
argocd app sync payments-api
```

Tokens can be created with an expiration time using the `-e` flag:

```bash
argocd proj role create-token payments ci-deployer -e 24h
```

To revoke a token before it expires, you need its ID. The token ID is the Unix timestamp of when it was issued. You can look it up with `argocd proj role get`:

```bash
argocd proj role get payments ci-deployer
```

This prints the role's policies and a table of JWT tokens showing their ID, issued-at time, and expiration. Pass the ID to `delete-token`:

```bash
argocd proj role delete-token payments ci-deployer 1696769937
```

You can also bind project roles to SSO groups instead of (or in addition to) using JWT tokens:

```yaml
spec:
  roles:
    - name: admin
      description: "Payments project admins"
      groups:
        - payments-engineers
      policies:
        - p, proj:payments:admin, applications, *, payments/*, allow
        - p, proj:payments:admin, logs, get, payments/*, allow
```

When a project role has both a `groups` binding and JWT tokens, both authentication methods are valid.

## Project-Scoped Repositories and Clusters

By default, repositories and clusters are global in Argo CD. Any project can reference any repository that has been registered, and any project can deploy to any cluster that has been added. Project-scoped resources change this so that specific repositories and clusters belong to a specific project and are invisible to others.

To add a repository that is scoped to a project:

```bash
argocd repo add https://github.com/mycompany/payments-config.git \
  --username argocd-bot \
  --password ghp_xxxxxxxxxxxx \
  --project payments
```

The equivalent declarative Secret looks like this:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: repo-payments-config
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
type: Opaque
stringData:
  project: payments
  url: https://github.com/mycompany/payments-config.git
  username: argocd-bot
  password: ghp_xxxxxxxxxxxx
```

Applications in the `payments` project can use this repository, but Applications in other projects cannot see it. This is useful when teams use different Git credentials or when certain repositories should not be accessible outside their owning team.

You need to grant RBAC permissions for teams to manage their own project-scoped repositories:

```
p, role:payments-admin, repositories, *, payments/*, allow
```

The same pattern works for clusters. You can scope a cluster to a project and then enable the `permitOnlyProjectScopedClusters` field on the AppProject to prevent its Applications from deploying to any cluster that is not explicitly scoped to it:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments
  namespace: argocd
spec:
  permitOnlyProjectScopedClusters: true
  destinations:
    - server: https://payments-cluster.example.com
      namespace: 'payments-*'
```

This is a strong isolation mechanism for organizations that need hard boundaries between teams at the cluster level.

## Testing Policies Before Deploying

Argo CD includes CLI tools for validating and testing RBAC policies without deploying them. This catches syntax errors and logic mistakes before they affect real users. The `--policy-file` flag accepts two formats: a raw CSV file containing just the policy lines, or a full Kubernetes ConfigMap YAML file in the same format as `argocd-rbac-cm` (with `policy.csv` and optionally `policy.default` as data keys). You must provide either `--policy-file` or `--namespace`, not both.

### Validating against a local CSV file

If you have a standalone `policy.csv` file with just the Casbin policy lines:

```bash
argocd admin settings rbac validate --policy-file policy.csv
```

### Validating against a ConfigMap YAML

If you manage your RBAC as a Kubernetes ConfigMap manifest (which is more likely in a GitOps workflow), you can pass that file directly:

```bash
argocd admin settings rbac validate --policy-file argocd-rbac-cm.yaml
```

### Validating against the live cluster

If you want to validate the policies currently applied to your cluster, pass the namespace where Argo CD is installed instead of a file:

```bash
argocd admin settings rbac validate --namespace argocd
```

### Testing specific permissions

The `argocd admin settings rbac can` command tests whether a specific subject can perform an action. It accepts the same `--policy-file` or `--namespace` options:

```bash
# Test against a local ConfigMap file
argocd admin settings rbac can role:payments-admin \
  sync applications payments/payments-api \
  --policy-file argocd-rbac-cm.yaml

# Test against the live cluster
argocd admin settings rbac can role:payments-admin \
  sync applications payments/payments-api \
  --namespace argocd
```

This returns `Yes` or `No` and is invaluable for debugging complex policy sets.

If you are managing RBAC policies in Git (which you should be, since this is a GitOps blog), you can add policy validation to your CI pipeline. A check that runs `argocd admin settings rbac validate --policy-file argocd-rbac-cm.yaml` on every pull request prevents broken policies from reaching your cluster.

## Glob vs Regex Matching

Argo CD supports two pattern matching modes for RBAC policy evaluation, configured in `argocd-rbac-cm`:

```yaml
data:
  policy.matchMode: glob
```

The default is `glob`, which treats each token in the policy as a simple pattern where `*` matches any sequence of characters. Importantly, in glob mode the `/` character is not treated as a separator, so `payments/*` matches `payments/api` and `payments/web/frontend` equally.

If you need more precise matching, you can switch to `regex` mode:

```yaml
data:
  policy.matchMode: regex
```

In regex mode, the same object field uses standard regular expressions:

```
p, role:payments-admin, applications, *, payments/[^/]+, allow
```

The pattern `payments/[^/]+` matches `payments/api` but not `payments/web/frontend`. This level of control is rarely needed but available when you have complex naming conventions.

## Putting It All Together: A Complete Multi-Tenant Setup

Here is what a production multi-tenant Argo CD configuration looks like when you combine AppProjects and RBAC. This example supports three teams: platform, payments, and frontend.

First, the AppProjects:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: platform
  namespace: argocd
spec:
  description: "Cluster infrastructure managed by the platform team"
  sourceRepos:
    - 'https://github.com/mycompany/platform-*.git'
    - 'https://charts.example.com/*'
  destinations:
    - server: '*'
      namespace: '*'
  clusterResourceWhitelist:
    - group: '*'
      kind: '*'
  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'
---
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments
  namespace: argocd
spec:
  description: "Applications owned by the payments team"
  sourceRepos:
    - 'https://github.com/mycompany/payments-*.git'
    - 'https://charts.example.com/*'
  destinations:
    - server: https://kubernetes.default.svc
      namespace: 'payments-*'
    - server: https://kubernetes.default.svc
      namespace: payments
  clusterResourceWhitelist: []
  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'
  roles:
    - name: ci-deployer
      description: "CI pipeline sync access"
      policies:
        - p, proj:payments:ci-deployer, applications, sync, payments/*, allow
        - p, proj:payments:ci-deployer, applications, get, payments/*, allow
---
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: frontend
  namespace: argocd
spec:
  description: "Applications owned by the frontend team"
  sourceRepos:
    - 'https://github.com/mycompany/frontend-*.git'
    - 'https://charts.example.com/*'
  destinations:
    - server: https://kubernetes.default.svc
      namespace: 'frontend-*'
    - server: https://kubernetes.default.svc
      namespace: frontend
  clusterResourceWhitelist: []
  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'
  roles:
    - name: ci-deployer
      description: "CI pipeline sync access"
      policies:
        - p, proj:frontend:ci-deployer, applications, sync, frontend/*, allow
        - p, proj:frontend:ci-deployer, applications, get, frontend/*, allow
```

Then the RBAC ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:authenticated
  scopes: '[groups]'
  policy.csv: |
    # Default role - deny all access
    p, role:authenticated, *, *, */*, deny

    # Platform team - full admin
    g, platform-admins, role:admin

    # Payments team
    p, role:payments-admin, applications, *, payments/*, allow
    p, role:payments-admin, applicationsets, *, payments/*, allow
    p, role:payments-admin, logs, get, payments/*, allow
    p, role:payments-admin, exec, create, payments/*, allow
    p, role:payments-admin, repositories, *, payments/*, allow
    p, role:payments-viewer, applications, get, payments/*, allow
    p, role:payments-viewer, logs, get, payments/*, allow
    g, payments-engineers, role:payments-admin
    g, payments-oncall, role:payments-viewer

    # Frontend team
    p, role:frontend-admin, applications, *, frontend/*, allow
    p, role:frontend-admin, applicationsets, *, frontend/*, allow
    p, role:frontend-admin, logs, get, frontend/*, allow
    p, role:frontend-admin, exec, create, frontend/*, allow
    p, role:frontend-admin, repositories, *, frontend/*, allow
    p, role:frontend-viewer, applications, get, frontend/*, allow
    p, role:frontend-viewer, logs, get, frontend/*, allow
    g, frontend-engineers, role:frontend-admin
    g, frontend-oncall, role:frontend-viewer
```

And lock down the default project:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: default
  namespace: argocd
spec:
  sourceRepos: []
  destinations: []
  clusterResourceWhitelist: []
  namespaceResourceWhitelist: []
```

With this configuration in place, each team can only see and manage their own Applications. The payments team cannot sync the frontend team's Applications, and neither team can create cluster-scoped resources. The platform team retains full admin access for infrastructure management. CI pipelines authenticate with project-scoped JWT tokens that only allow syncing within their respective projects.

If you are using [ApplicationSets](/blog/argo-cd-applicationsets/) to generate Applications from templates, those Applications inherit the project specified in the template spec, so the same RBAC boundaries apply automatically.

The key principle is defense in depth. AppProjects constrain what Applications can do. RBAC constrains what users can do to those Applications. Together they create an access model where each team has exactly the permissions they need and nothing more.
