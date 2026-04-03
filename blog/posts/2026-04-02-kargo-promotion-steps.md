---
title: "Kargo Promotion Steps: Building Advanced GitOps Promotion Pipelines"
date: 2026-04-02
description: "A comprehensive guide to Kargo's promotion step system. Covers the built-in step library, PromotionTasks for reusable workflows, the expression language, conditional execution, error handling, and practical patterns for real-world promotion pipelines."
image: /blog/images/kargo-logo.svg
ogBackground: dark
tags:
  - kubernetes
  - kargo
  - gitops
  - argo-cd
  - automation
---

<div class="blog-hero">
  <img src="/blog/images/kargo-logo.svg" alt="Kargo promotion steps pipeline" width="200" style="display: inline-block;">
</div>

My [introduction to Kargo](/blog/kargo/) covered the high-level architecture: Warehouses watch for new artifacts, Freight bundles them into promotable units, and Stages define how those units flow through your environments. The [verification post](/blog/kargo-verification/) added quality gates. And the [v1.9 overview](/blog/kargo-v1-9/) covered the latest platform features. But I have not yet gone deep on the piece that does the actual work: promotion steps.

Promotion steps are the individual operations that Kargo executes when it promotes Freight to a Stage. They are where the rubber meets the road. Cloning a Git repo, updating an image tag in a values file, pushing to a branch, telling Argo CD to sync. Every one of those actions is a discrete step, and Kargo ships a library of over 40 built-in steps that cover Git operations, configuration management, infrastructure-as-code, CI/CD integration, and external service management. On top of that, PromotionTasks let you package step sequences into reusable units, and a purpose-built expression language lets steps share data with each other.

One thing to note before diving in: Kargo is open source, but a subset of the more advanced promotion steps are only available when running Kargo on the [Akuity Platform](https://akuity.io). I will call these out as they come up so you know what requires a platform subscription and what ships with the open-source project.

This post walks through all of it. If you have been writing promotion templates with just `git-clone`, `yaml-update`, `git-commit`, `git-push`, and `argocd-update`, there is a lot more available to you.

## Anatomy of a Promotion Step

Every step in a promotion template follows the same structure:

{% raw %}
```yaml
steps:
  - uses: git-clone
    as: clone
    config:
      repoURL: https://github.com/my-org/my-app-config.git
      checkout:
        - branch: main
          path: ./src
    if: ${{ success() }}
    continueOnError: false
    retry:
      errorThreshold: 3
      timeout: 2m
```
{% endraw %}

The `uses` field selects the built-in step to run. The optional `as` field gives the step an alias, which is how downstream steps reference its outputs through expressions like `${{ outputs.clone.commit }}`. The `config` block is step-specific and varies depending on which step you are using. Everything else controls execution behavior: `if` for conditional execution, `continueOnError` to prevent a failing step from killing the entire promotion, and `retry` for transient failures.

The `retry` block deserves a closer look. The `errorThreshold` sets how many consecutive failures Kargo tolerates before giving up. The default is 1, meaning any failure is final. Setting it to 3 means the step can fail twice and retry, only failing permanently on the third consecutive error. The `timeout` sets the maximum wall-clock time for all attempts combined. If you omit it, the step will retry indefinitely until the threshold is hit. For steps that call external services like GitHub or Jira, setting both values is good practice.

## The Built-in Step Library

Kargo organizes its built-in steps into several categories. I will cover the most important ones here with practical examples.

### Git Operations

These are the workhorses of most promotion pipelines. Nearly every pipeline starts with a `git-clone` and ends with a `git-push`.

`git-clone` checks out a repository and optionally checks out specific branches, tags, or commits. It supports sparse checkout if you only need a subset of the repository:

```yaml
- uses: git-clone
  as: clone
  config:
    repoURL: https://github.com/my-org/my-app-config.git
    checkout:
      - branch: main
        path: ./src
```

The `path` field tells Kargo where to place the working tree in the shared workspace. This matters because multiple steps operate on the same filesystem during a promotion. If you clone into `./src`, your `yaml-update` step needs to target files under `./src`.

`git-commit` creates a commit from working tree changes. You can customize the author name and email, and the commit message supports expressions:

{% raw %}
```yaml
- uses: git-commit
  as: commit
  config:
    path: ./src
    message: "promote ${{ ctx.stage }}: update image to ${{ imageFrom('my-registry.io/my-app').Tag }}"
    author:
      name: Kargo Bot
      email: kargo@my-org.com
```
{% endraw %}

`git-push` pushes the committed changes. By default it pushes to the branch that was checked out, but you can specify a different target:

```yaml
- uses: git-push
  as: push
  config:
    path: ./src
```

For workflows that require human review before changes land, `git-open-pr` creates a pull request and `git-wait-for-pr` blocks the promotion until it is merged:

{% raw %}
```yaml
- uses: git-open-pr
  as: open-pr
  config:
    repoURL: https://github.com/my-org/my-app-config.git
    sourceBranch: ${{ outputs.push.branch }}
    targetBranch: main
    title: "Promote ${{ ctx.stage }}: ${{ imageFrom('my-registry.io/my-app').Tag }}"
    description: |
      Automated promotion by Kargo.
      Stage: ${{ ctx.stage }}
      Freight: ${{ ctx.targetFreight.name }}

- uses: git-wait-for-pr
  config:
    repoURL: https://github.com/my-org/my-app-config.git
    prNumber: ${{ outputs['open-pr'].pr.id }}
  retry:
    errorThreshold: 1
    timeout: 24h
```
{% endraw %}

The `git-wait-for-pr` step will poll until the PR is merged or closed. The retry timeout of 24 hours gives your team a full day to review the change. If it is not merged within that window, the promotion fails.

Kargo v1.8 added `git-merge-pr` for cases where you want to merge the PR programmatically rather than waiting for a human:

{% raw %}
```yaml
- uses: git-merge-pr
  config:
    repoURL: https://github.com/my-org/my-app-config.git
    prNumber: ${{ outputs['open-pr'].pr.id }}
```
{% endraw %}

Finally, `git-clear` removes all files from a Git working tree while preserving the `.git` directory. This is useful when you want to completely replace the contents of a branch rather than updating individual files. A common pattern is to clone a stage-specific branch, clear it, render fresh configuration into it, then commit and push:

```yaml
- uses: git-clear
  config:
    path: ./src
```

### Configuration Management

These steps update the configuration files that Argo CD reads. Which one you use depends on how your configuration is structured.

`yaml-update` is the most common. It sets values in YAML files using dotted key paths:

{% raw %}
```yaml
- uses: yaml-update
  config:
    path: ./src/envs/staging/values.yaml
    updates:
      - key: image.tag
        value: ${{ imageFrom('my-registry.io/my-app').Tag }}
      - key: image.digest
        value: ${{ imageFrom('my-registry.io/my-app').Digest }}
```
{% endraw %}

`yaml-parse` does the opposite. It extracts values from YAML files so you can use them in later steps:

```yaml
- uses: yaml-parse
  as: current
  config:
    path: ./src/envs/staging/values.yaml
    outputs:
      - name: currentTag
        fromExpression: image.tag
```

You can then reference {% raw %}`${{ outputs.current.currentTag }}`{% endraw %} in downstream steps. Here, `current` is the step alias (from `as: current`) and `currentTag` is the output name defined in the step's `outputs` config.

For Kustomize-based projects, `kustomize-set-image` updates the image references in a `kustomization.yaml` without touching other fields:

{% raw %}
```yaml
- uses: kustomize-set-image
  config:
    path: ./src/envs/staging
    images:
      - image: my-registry.io/my-app
        tag: ${{ imageFrom('my-registry.io/my-app').Tag }}
```
{% endraw %}

`kustomize-build` renders the Kustomize output to a file, which is useful when your Argo CD Application is configured to apply a pre-rendered manifest rather than running Kustomize at sync time:

```yaml
- uses: kustomize-build
  config:
    path: ./src/envs/staging
    outPath: ./src/envs/staging/rendered.yaml
```

For Helm-based projects, `helm-update-chart` bumps dependency versions in a `Chart.yaml`. Given a chart with a dependency block like this:

```yaml
# Chart.yaml
apiVersion: v2
name: my-app-umbrella
version: 0.1.0
dependencies:
  - name: backend
    version: 1.2.3
    repository: https://charts.my-org.com
```

The following step updates the `version` field of the matching dependency to whatever version the current Freight carries:

{% raw %}
```yaml
- uses: helm-update-chart
  config:
    path: ./src/charts/my-app-umbrella
    charts:
      - repository: https://charts.my-org.com
        name: backend
        version: ${{ chartFrom('https://charts.my-org.com', 'backend').Version }}
```
{% endraw %}

Kargo matches on the `repository` and `name` fields to find the right dependency entry, then writes the new `version` value in place. The rest of the `Chart.yaml` is left untouched.

And `helm-template` renders a Helm chart to static YAML:

```yaml
- uses: helm-template
  config:
    path: ./src/charts/my-app
    releaseName: my-app
    namespace: my-namespace
    valuesFiles:
      - ./src/envs/staging/values.yaml
    outPath: ./src/envs/staging/rendered.yaml
```

There is also `json-update` and `json-parse` for JSON files, and `hcl-update` for HCL/OpenTofu configuration files. Note that `hcl-update` is **Akuity Platform only**.

### Argo CD Integration

`argocd-update` is the step that triggers Argo CD to sync after your configuration changes have been pushed. It is unique among Kargo's built-in steps because it also registers a health check that Kargo monitors after the promotion completes:

{% raw %}
```yaml
- uses: argocd-update
  config:
    apps:
      - name: my-app-staging
        sources:
          - repoURL: https://github.com/my-org/my-app-config.git
            desiredRevision: ${{ outputs.push.commit }}
```
{% endraw %}

The `name` field references an existing Argo CD Application by name. The `desiredRevision` field pins that Application to the exact commit that your promotion produced. This prevents a race condition where another commit could land between your push and Argo CD's sync.

You can update multiple Applications in a single step if your promotion touches configuration for several services:

{% raw %}
```yaml
- uses: argocd-update
  config:
    apps:
      - name: frontend-staging
        sources:
          - repoURL: https://github.com/my-org/my-app-config.git
            desiredRevision: ${{ outputs.push.commit }}
      - name: backend-staging
        sources:
          - repoURL: https://github.com/my-org/my-app-config.git
            desiredRevision: ${{ outputs.push.commit }}
```
{% endraw %}

If you would rather not set these fields imperatively through `argocd-update`, another option is to use an app-of-apps pattern where your parent Application manages child Applications defined in Git. In that model, your promotion steps update the child Application manifests directly in the repository and Argo CD picks up the changes through its normal sync cycle. That approach is a topic for its own post, but it is worth knowing it exists as an alternative.

### CI/CD Integration

Sometimes a promotion needs to trigger an external CI pipeline and wait for it to finish before proceeding. Kargo ships two steps for GitHub Actions integration. Both are **Akuity Platform only**.

`gha-dispatch-workflow` triggers a GitHub Actions workflow using the `workflow_dispatch` event:

{% raw %}
```yaml
- uses: gha-dispatch-workflow
  as: ci
  config:
    repoURL: https://github.com/my-org/my-app.git
    ref: main
    workflowFile: integration-tests.yaml
    inputs:
      environment: staging
      image_tag: ${{ imageFrom('my-registry.io/my-app').Tag }}
```
{% endraw %}

`gha-wait-for-workflow` blocks until the dispatched workflow completes, with configurable success criteria:

{% raw %}
```yaml
- uses: gha-wait-for-workflow
  config:
    repoURL: https://github.com/my-org/my-app.git
    runID: ${{ outputs.ci.runID }}
  retry:
    timeout: 30m
```
{% endraw %}

This pattern is useful when you need to run tests that cannot run inside the target cluster or when you have an existing CI pipeline you want to reuse.

### External Service Integration

Kargo includes steps for notifications, issue tracking, and change management. All of the steps in this section are **Akuity Platform only**.

`send-message` pushes notifications to Slack or email, which is useful for keeping teams informed about promotion progress:

{% raw %}
```yaml
- uses: send-message
  config:
    channel:
      kind: MessageChannel
      name: deploy-notifications
    message: |
      Promotion to *${{ ctx.stage }}* completed.
      Image: ${{ imageFrom('my-registry.io/my-app').Tag }}
      Freight: ${{ ctx.targetFreight.name }}
```
{% endraw %}

The `send-message` step references a `MessageChannel` (or `ClusterMessageChannel`) resource that you define separately in your Project namespace. The channel resource holds the Slack webhook URL, email server config, or other delivery details, keeping those credentials out of your promotion templates.

`jira` provides full Jira integration within a promotion. You can create, update, and delete issues, search with JQL, add or remove comments, and wait for an issue to reach a specific status before the promotion continues. Between the issue lifecycle management and the ability to block a promotion until a ticket reaches a specific status, it provides full issue tracking integration for teams that use Jira as part of their release process. Here is an example that adds a comment to a tracked issue:

{% raw %}
```yaml
- uses: jira
  config:
    credentials:
      secretName: jira-creds
    commentOnIssue:
      issueKey: ${{ vars.jiraTicket }}
      body: "Promoted to ${{ ctx.stage }} by Kargo. Freight: ${{ ctx.targetFreight.name }}"
```
{% endraw %}

The ServiceNow steps (`snow-create`, `snow-update`, `snow-query-for-records`, `snow-wait-for-condition`, `snow-delete`) provide full change management integration for organizations that require it. You can create a change request before deploying, wait for it to be approved, and update it with the deployment result.

### File and Network Operations

`http` makes arbitrary HTTP/HTTPS requests, which is useful for calling webhooks or REST APIs that Kargo does not have a dedicated step for:

{% raw %}
```yaml
- uses: http
  as: webhook
  config:
    method: POST
    url: https://api.my-org.com/deploy-hooks
    headers:
      - name: Authorization
        value: "Bearer ${{ secret('deploy-webhook-token').token }}"
      - name: Content-Type
        value: application/json
    body: |
      {
        "stage": "${{ ctx.stage }}",
        "image": "${{ imageFrom('my-registry.io/my-app').Tag }}"
      }
```
{% endraw %}

`http-download` and `oci-download` fetch files from remote sources. This is useful when your promotion needs to pull a configuration bundle or policy file from a central repository:

```yaml
- uses: oci-download
  config:
    imageRef: oci://my-registry.io/configs/global-policies:latest
    outPath: ./policies
```

`copy`, `delete`, and `untar` round out the file operations, letting you move files between working directories, clean up temporary artifacts, and extract archives.

## The Expression Language

{% raw %}
The expression language is what ties steps together. Delimited by `${{ }}`, expressions let you reference outputs from previous steps, access Freight metadata, read Kubernetes Secrets and ConfigMaps, and conditionally control step execution.
{% endraw %}

### Context Variables

Every promotion has access to a `ctx` object with metadata about the current promotion:

- `ctx.project` is the Kargo Project name
- `ctx.stage` is the target Stage name
- `ctx.promotion` is the Promotion resource name
- `ctx.targetFreight.name` is the Freight being promoted
- `ctx.meta.promotion.actor` is who or what triggered the promotion

### Freight Accessors

The expression functions `imageFrom()`, `commitFrom()`, and `chartFrom()` extract artifact details from the Freight being promoted:

{% raw %}
```yaml
# imageFrom() fields
${{ imageFrom('my-registry.io/my-app').RepoURL }}
${{ imageFrom('my-registry.io/my-app').Tag }}
${{ imageFrom('my-registry.io/my-app').Digest }}
${{ imageFrom('my-registry.io/my-app').Annotations }}

# commitFrom() fields
${{ commitFrom('https://github.com/my-org/my-app.git').RepoURL }}
${{ commitFrom('https://github.com/my-org/my-app.git').ID }}
${{ commitFrom('https://github.com/my-org/my-app.git').Branch }}
${{ commitFrom('https://github.com/my-org/my-app.git').Tag }}
${{ commitFrom('https://github.com/my-org/my-app.git').Message }}
${{ commitFrom('https://github.com/my-org/my-app.git').Author }}
${{ commitFrom('https://github.com/my-org/my-app.git').Committer }}

# chartFrom() fields
${{ chartFrom('https://charts.my-org.com', 'backend').RepoURL }}
${{ chartFrom('https://charts.my-org.com', 'backend').Name }}
${{ chartFrom('https://charts.my-org.com', 'backend').Version }}
```
{% endraw %}

These functions take a repository URL as the first argument and optionally a Freight origin as a second (or third) argument when you need to disambiguate artifacts that come from different Warehouses.

### Secrets and ConfigMaps

Steps often need credentials that should not be stored in YAML files. The `secret()` and `configMap()` functions let you reference Kubernetes resources in the Project namespace:

{% raw %}
```yaml
${{ secret('github-creds').token }}
${{ configMap('deploy-config').targetCluster }}
```
{% endraw %}

There is also `sharedSecret()` for secrets in the shared resources namespace (defaults to `kargo-shared-resources`, configurable via the Helm chart's `global.sharedResources.namespace` parameter) that are available across all projects. Note that `sharedSecret()` only works with secrets labeled `kargo.akuity.io/cred-type: generic`.

### Semantic Version Functions

`semverParse()` breaks a version string into its components. Given a tag like `2.4.1-rc.1+build.123`, you can access each part individually:

{% raw %}
```yaml
# For a tag of "2.4.1-rc.1+build.123":
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).Major }}        # 2
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).Minor }}        # 4
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).Patch }}        # 1
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).Prerelease }}   # rc.1
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).Metadata }}     # build.123
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).String }}       # 2.4.1-rc.1+build.123
```
{% endraw %}

It also provides increment helpers that return a new version with the specified component bumped:

{% raw %}
```yaml
# Starting from "2.4.1":
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).IncMajor }}  # 3.0.0
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).IncMinor }}  # 2.5.0
${{ semverParse(imageFrom('my-registry.io/my-app').Tag).IncPatch }}  # 2.4.2
```
{% endraw %}

`semverDiff()` compares two version strings and returns the level at which they differ. The possible return values are `Major`, `Minor`, `Patch`, `Metadata`, `None` (identical), and `Incomparable` (invalid input):

{% raw %}
```yaml
${{ semverDiff('1.2.3', '2.0.0') }}  # Major
${{ semverDiff('1.2.3', '1.3.0') }}  # Minor
${{ semverDiff('1.2.3', '1.2.4') }}  # Patch
${{ semverDiff('1.2.3', '1.2.3') }}  # None
```
{% endraw %}

This is useful for conditional logic. For example, you could skip a promotion step if the version bump is only a patch.

### Type Coercion

Expressions evaluate to strings by default but automatically coerce to JSON types when the result looks like a number, boolean, object, array, or null. If you need to force a string, wrap the expression with `quote()`:

{% raw %}
```yaml
# This might be coerced to a number if the tag is "123"
value: ${{ imageFrom('my-registry.io/my-app').Tag }}

# This is always a string
value: ${{ quote(imageFrom('my-registry.io/my-app').Tag) }}
```
{% endraw %}

## Conditional Execution

Kargo v1.3 introduced the `if` field on steps, which lets you control whether a step runs based on the outcome of previous steps. The value must be an expression that evaluates to a boolean. While you can use any valid expression here, three built-in functions cover the most common cases:

`success()` returns true if all previous steps succeeded. This is the default behavior, so steps without an `if` field only run when everything before them passed.

`failure()` returns true if any previous step failed. This is useful for cleanup or notification steps that should only run when something goes wrong:

{% raw %}
```yaml
- uses: send-message
  if: ${{ failure() }}
  config:
    channel:
      kind: MessageChannel
      name: deploy-alerts
    message: "Promotion to ${{ ctx.stage }} failed. Check the Kargo dashboard for details."
```
{% endraw %}

`always()` evaluates to true regardless of whether previous steps passed or failed. Use this for cleanup logic that must execute no matter what:

{% raw %}
```yaml
- uses: git-clear
  if: ${{ always() }}
  config:
    path: ./src
```
{% endraw %}

You are not limited to these three functions. Any expression that evaluates to a boolean works, so you can build conditions based on step outputs, Freight metadata, or comparison operators. For example, you could gate a step on whether the version bump is major:

{% raw %}
```yaml
- uses: send-message
  if: ${{ semverDiff(outputs.current.previousTag, imageFrom('my-registry.io/my-app').Tag) == 'Major' }}
  config:
    channel:
      kind: MessageChannel
      name: deploy-alerts
    message: "Major version bump detected for ${{ ctx.stage }}. Manual review recommended."
```
{% endraw %}

When a step's `if` condition evaluates to false, the step is marked as skipped. Skipped steps are not counted as failures and do not affect the `success()` or `failure()` checks for subsequent steps.

{% raw %}
Combined with `continueOnError`, this gives you fine-grained control over promotion flow. A step with `continueOnError: true` runs and may fail, but its failure does not cascade. A step with `if: ${{ failure() }}` only runs when something upstream has already failed. Together, they let you build resilient pipelines that handle errors gracefully.
{% endraw %}

## PromotionTasks: Reusable Step Sequences

Once you have more than two or three Stages, you will notice that your promotion templates start looking identical. Each Stage clones the same repo, updates values, commits, pushes, and tells Argo CD to sync. The only differences are the branch name, the values file path, and the Argo CD Application name. PromotionTasks extract that shared logic into a reusable resource.

### Defining a PromotionTask

A PromotionTask is a namespaced Kubernetes resource that defines a sequence of steps with configurable variables:

{% raw %}
```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: PromotionTask
metadata:
  name: standard-promotion
  namespace: my-project
spec:
  vars:
    - name: repoURL
    - name: branch
      value: main
    - name: valuesFile
    - name: appName
    - name: imageRepo
  steps:
    - uses: git-clone
      as: clone
      config:
        repoURL: ${{ vars.repoURL }}
        checkout:
          - branch: ${{ vars.branch }}
            path: ./src
    - uses: yaml-update
      config:
        path: ./src/${{ vars.valuesFile }}
        updates:
          - key: image.tag
            value: ${{ imageFrom(vars.imageRepo).Tag }}
    - uses: git-commit
      as: commit
      config:
        path: ./src
        message: "promote ${{ ctx.stage }}: update ${{ vars.imageRepo }} to ${{ imageFrom(vars.imageRepo).Tag }}"
    - uses: git-push
      as: push
      config:
        path: ./src
    - uses: argocd-update
      config:
        apps:
          - name: ${{ vars.appName }}
            sources:
              - repoURL: ${{ vars.repoURL }}
                desiredRevision: ${{ task.outputs.push.commit }}
```
{% endraw %}

Notice two things. First, variables declared without a `value` field are required. Variables with a `value` have a default. Second, within a PromotionTask, step outputs are accessed through `task.outputs` rather than just `outputs`. This scoping prevents collisions when a Stage references multiple tasks.

There is also a `ClusterPromotionTask` resource, which has the same spec but is cluster-scoped rather than namespaced. Use it when you need the same task available across multiple Projects.

### Using Tasks in Stages

A Stage references a PromotionTask through the `task` field in its promotion template:

```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: Stage
metadata:
  name: staging
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
    steps:
      - task:
          name: standard-promotion
          kind: PromotionTask
        variables:
          - name: repoURL
            value: https://github.com/my-org/my-app-config.git
          - name: valuesFile
            value: envs/staging/values.yaml
          - name: appName
            value: my-app-staging
          - name: imageRepo
            value: my-registry.io/my-app
```

The Stage provides the environment-specific values and the PromotionTask handles all the mechanics. When you need to change how promotions work across all Stages, updating the single PromotionTask propagates the change everywhere.

### Exposing Task Outputs

A PromotionTask's internal step outputs are not directly visible to the parent Stage. To make them available, you use a `compose-output` step at the end of the task to explicitly expose the values you want the Stage to access. Inside the task, this step uses `task.outputs` to reference internal step outputs:

{% raw %}
```yaml
# Inside a PromotionTask definition
steps:
  # ...git-clone, yaml-update, git-commit, etc.
  - uses: git-push
    as: push
    config:
      path: ./src
  - uses: compose-output
    as: result
    config:
      commit: ${{ task.outputs.push.commit }}
```
{% endraw %}

At the Stage level, the composed outputs become available under the task step's alias. If the Stage references the task with `as: promotion`, the commit is accessible as {% raw %}`${{ outputs.promotion.commit }}`{% endraw %}:

{% raw %}
```yaml
# In a Stage's promotionTemplate
steps:
  - task:
      name: standard-promotion
      kind: PromotionTask
    as: promotion
    variables:
      - name: repoURL
        value: https://github.com/my-org/my-app-config.git
  - uses: http
    config:
      method: POST
      url: https://api.my-org.com/deploy-hooks
      body: |
        { "commit": "${{ outputs.promotion.commit }}" }
```
{% endraw %}

This scoping is what makes it possible to chain multiple tasks together in a single Stage. Each task exposes its own outputs under its own alias, and downstream steps or tasks reference them through {% raw %}`${{ outputs.<task-alias>.<output-name> }}`{% endraw %}.

## Practical Patterns

### PR-Based Promotion with Review Gate

For environments that require human approval, combine Git PR steps with the wait step:

{% raw %}
```yaml
steps:
  - uses: git-clone
    as: clone
    config:
      repoURL: https://github.com/my-org/my-app-config.git
      checkout:
        - branch: main
          path: ./src
  - uses: yaml-update
    config:
      path: ./src/envs/production/values.yaml
      updates:
        - key: image.tag
          value: ${{ imageFrom('my-registry.io/my-app').Tag }}
  - uses: git-commit
    config:
      path: ./src
      message: "promote production: ${{ imageFrom('my-registry.io/my-app').Tag }}"
  - uses: git-push
    as: push
    config:
      path: ./src
      targetBranch: promote/production/${{ ctx.promotion }}
  - uses: git-open-pr
    as: open-pr
    config:
      repoURL: https://github.com/my-org/my-app-config.git
      sourceBranch: ${{ outputs.push.branch }}
      targetBranch: main
      title: "[Production] Promote ${{ imageFrom('my-registry.io/my-app').Tag }}"
  - uses: git-wait-for-pr
    config:
      repoURL: https://github.com/my-org/my-app-config.git
      prNumber: ${{ outputs['open-pr'].pr.id }}
    retry:
      timeout: 48h
  - uses: argocd-update
    config:
      apps:
        - name: my-app-production
```
{% endraw %}

This pipeline pushes to a feature branch, opens a PR, and then halts until someone merges it. Only after the merge does Argo CD sync the production cluster.

### Issue Tracking Integration

For teams that gate production deploys on ticket approval, the `jira` step can create a deploy ticket, wait for it to be approved, and update it with the result. This pattern uses the `jira` step, which is **Akuity Platform only**:

{% raw %}
```yaml
steps:
  - uses: jira
    as: ticket
    config:
      credentials:
        secretName: jira-creds
      createIssue:
        projectKey: DEPLOY
        summary: "Deploy ${{ imageFrom('my-registry.io/my-app').Tag }} to ${{ ctx.stage }}"
        description: "Automated promotion triggered by Kargo. Freight: ${{ ctx.targetFreight.name }}"
        issueType: Task
        labels:
          - kargo
          - production
  - uses: jira
    config:
      credentials:
        secretName: jira-creds
      waitForStatus:
        issueKey: ${{ outputs.ticket.key }}
        expectedStatus: Approved
    retry:
      timeout: 72h
  - uses: git-clone
    as: clone
    config:
      repoURL: https://github.com/my-org/my-app-config.git
      checkout:
        - branch: main
          path: ./src
  - uses: yaml-update
    config:
      path: ./src/envs/production/values.yaml
      updates:
        - key: image.tag
          value: ${{ imageFrom('my-registry.io/my-app').Tag }}
  - uses: git-commit
    config:
      path: ./src
      message: "promote production: ${{ imageFrom('my-registry.io/my-app').Tag }} (${{ outputs.ticket.key }})"
  - uses: git-push
    as: push
    config:
      path: ./src
  - uses: argocd-update
    config:
      apps:
        - name: my-app-production
          sources:
            - repoURL: https://github.com/my-org/my-app-config.git
              desiredRevision: ${{ outputs.push.commit }}
  - uses: jira
    config:
      credentials:
        secretName: jira-creds
      updateIssue:
        issueKey: ${{ outputs.ticket.key }}
        status: Done
      commentOnIssue:
        issueKey: ${{ outputs.ticket.key }}
        body: "Deployed successfully. Commit: ${{ outputs.push.commit }}"
```
{% endraw %}

The pipeline creates a Jira issue in the DEPLOY project, then blocks until someone moves it to `Approved`. After the deploy completes, it transitions the ticket to `Done` and adds a comment with the commit SHA. The ServiceNow steps (`snow-create`, `snow-update`, `snow-wait-for-condition`) support a similar pattern for organizations that use ServiceNow for change management.

### Error Handling with Notifications

Use conditional steps to notify on failure while still completing cleanup. This example uses `send-message` (Akuity Platform only) for the notifications, but the conditional execution pattern with `if`, `success()`, `failure()`, and `always()` works with any step in open-source Kargo:

{% raw %}
```yaml
steps:
  - uses: git-clone
    as: clone
    config:
      repoURL: https://github.com/my-org/my-app-config.git
      checkout:
        - branch: main
          path: ./src
  - uses: yaml-update
    config:
      path: ./src/envs/staging/values.yaml
      updates:
        - key: image.tag
          value: ${{ imageFrom('my-registry.io/my-app').Tag }}
  - uses: git-commit
    config:
      path: ./src
      message: "promote staging: ${{ imageFrom('my-registry.io/my-app').Tag }}"
  - uses: git-push
    as: push
    config:
      path: ./src
  - uses: argocd-update
    config:
      apps:
        - name: my-app-staging
          sources:
            - repoURL: https://github.com/my-org/my-app-config.git
              desiredRevision: ${{ outputs.push.commit }}
  - uses: send-message
    if: ${{ failure() }}
    config:
      channel:
        kind: MessageChannel
        name: deploy-alerts
      message: "Promotion to ${{ ctx.stage }} FAILED. Check the Kargo dashboard."
  - uses: send-message
    if: ${{ success() }}
    config:
      channel:
        kind: MessageChannel
        name: deploy-notifications
      message: "Promoted ${{ imageFrom('my-registry.io/my-app').Tag }} to ${{ ctx.stage }}."
  - uses: git-clear
    if: ${{ always() }}
    config:
      path: ./src
```
{% endraw %}

## Tips for Working with Promotion Steps

**Alias every step that produces outputs.** If you forget the `as` field, you cannot reference that step's outputs later. It costs nothing and saves debugging time.

**Use `quote()` around image tags.** Tags that look like numbers (such as `20260331` or `1234`) will be coerced to integers by the expression engine. Wrapping them in `quote()` keeps them as strings and avoids subtle bugs in YAML updates.

**Set retry timeouts on external calls.** Steps like `gha-wait-for-workflow`, `git-wait-for-pr`, and `snow-wait-for-condition` can block a promotion indefinitely if the external system never responds. Always set a `timeout` that matches your SLA.

**Use PromotionTasks early.** Even if you only have two Stages today, extracting the promotion logic into a task pays off quickly. When you add a third Stage or need to change how promotions work, you only update one resource.

**Keep steps focused.** If you find yourself doing complex logic inside a single step's configuration, consider whether it should be split into two steps. The expression language is powerful but not a full programming language. Let each step do one thing and let expressions wire them together.

**Test with manual promotions first.** Kargo lets you manually promote specific Freight to a Stage through the CLI or UI. Use this to verify your promotion template before enabling auto-promotion. Manual promotions generate the same Promotion resource and execute the same steps, so the behavior is identical.

## What's Next

Kargo's step library continues to expand with each release. The OpenTofu steps (`tf-plan`, `tf-apply`, `tf-output`) open the door to infrastructure promotions that go beyond Kubernetes manifests, though these are currently Akuity Platform only. The JFrog Artifactory evidence step (`jfrog-evidence`, also Platform only) brings supply chain attestation into the promotion workflow. Akuity has also [announced](https://akuity.io/blog/kargo-custom-steps-gitops-promotion) OCI-based custom steps that would let teams package entirely custom logic as container images and register them as native Kargo steps, though this feature has not yet shipped in a released version of Kargo at the time of writing.

If you want to explore the full list of built-in steps and their configuration options, the [Kargo promotion steps reference](https://docs.kargo.io/user-guide/reference-docs/promotion-steps/) is the definitive resource. For help designing promotion pipelines for your organization, [get in touch](/contact).
