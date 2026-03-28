---
title: "Argo CD Image Updater: Automating Container Image Deployments in GitOps"
date: 2026-03-21
description: "A deep dive into Argo CD Image Updater, the tool that automatically detects new container image versions and updates your Argo CD applications. Learn how to configure update strategies, write changes back to Git, authenticate with private registries, and close the gap between CI and CD in your GitOps pipeline."
image: /blog/images/argo-cd-logo.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - containers
  - automation
---

<div class="blog-hero">
  <img src="/blog/images/argo-cd-logo.svg" alt="Container image update cycle" width="200" style="display: inline-block;">
</div>

There is a gap in most GitOps pipelines that nobody likes to talk about. Your CI system builds a new container image, pushes it to a registry, and then... someone has to update a manifest. Maybe it is a developer opening a pull request to bump an image tag in a Helm values file. Maybe it is a CI job that commits the new tag back to a config repo. Either way, you have built an automated delivery pipeline with a manual step wedged right in the middle of it.

Argo CD Image Updater closes that gap. It watches your container registries for new image versions, evaluates them against constraints you define, and updates your [Argo CD](/blog/argo-cd/) applications automatically. The update can happen through the Argo CD API directly or, more commonly in mature setups, by committing the change back to your Git repository so the full GitOps reconciliation loop stays intact.

## How It Works

Argo CD Image Updater runs as a separate controller in your cluster alongside Argo CD. On a configurable interval, it queries container registries for new tags on images your applications use. When it finds a tag that matches your update constraints, it takes action.

The update flow has three stages. First, the controller discovers which images each application uses and what update rules apply. Second, it queries the relevant container registries for available tags. Third, if a newer qualifying image exists, it updates the application either by calling the Argo CD API to set parameter overrides or by committing the change to Git.

Starting with v1.0, Argo CD Image Updater uses a dedicated `ImageUpdater` custom resource to define what to watch and how to update it. Earlier versions relied on annotations placed directly on the Argo CD Application resource. The CRD approach is cleaner, easier to manage at scale, and keeps your Application manifests focused on deployment rather than image update policy.

## Installation

Argo CD Image Updater installs into the same namespace as Argo CD. The quickest path is applying the installation manifests directly:

```bash
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj-labs/argocd-image-updater/stable/config/install.yaml
```

If you prefer Helm, the project provides a chart:

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm install argocd-image-updater argo/argocd-image-updater -n argocd
```

Verify the controller is running:

```bash
kubectl get pods -n argocd -l app.kubernetes.io/name=argocd-image-updater
```

The controller needs access to the Argo CD API and to whatever container registries your applications pull from. By default, it uses the Argo CD service account for API access and anonymous access for public registries like Docker Hub. Private registries need additional configuration, which we will cover later.

## The ImageUpdater Resource

The core of the v1.0 configuration model is the `ImageUpdater` CRD. Here is an example that watches an application called `my-app`, updates its `nginx` image using semantic versioning, and writes changes back to Git:

```yaml
apiVersion: argocd-image-updater.argoproj.io/v1alpha1
kind: ImageUpdater
metadata:
  name: my-app-updater
  namespace: argocd
spec:
  writeBackConfig:
    method: git
    gitConfig:
      repository: "git@github.com:myorg/my-app-config.git"
      branch: main
      writeBackTarget: "helmvalues:/values.yaml"
  applicationRefs:
    - namePattern: "my-app"
      images:
        - alias: "nginx"
          imageName: "nginx:1.27.x"
          commonUpdateSettings:
            updateStrategy: semver
          manifestTargets:
            helm:
              name: image.repository
              tag: image.tag
```

The `applicationRefs` field defines which Argo CD applications to target. The `namePattern` supports glob-style wildcards, so you can match multiple applications with a single resource. You can also use `labelSelectors` with `matchLabels` and `matchExpressions` for more fine-grained application selection. Each matched application gets its images checked against the rules defined in the `images` list. The version constraint is part of the `imageName` value itself (`nginx:1.27.x`), which tells the Image Updater to only consider tags within the `1.27` patch range. The `manifestTargets` block maps the discovered image to the correct Helm values, and the `writeBackConfig` at the top tells the Image Updater to commit changes to Git rather than using API overrides.

A few things to note about the namespace. The `ImageUpdater` resource must live in the same namespace as the Argo CD applications it targets. The v1.0 release deprecated the `spec.namespace` field in favor of using `metadata.namespace` for application discovery. If your applications and your Image Updater resources are in different namespaces, you will need to move the resources to align them.

## Update Strategies

The update strategy is configured through the `commonUpdateSettings` block, which can be set at three levels: globally in the `ImageUpdater` spec, per application reference, or per image. Image-level settings override application-level, which override global. There are four strategies, and choosing the right one depends on how your CI system tags images.

### Semantic Versioning

The `semver` strategy is the default. It treats tags as semantic versions in `X.Y.Z` format and selects the highest version that satisfies a version constraint. Tags that do not conform to semver are silently ignored, so stray tags like `latest` or `debug-build` will never be matched:

```yaml
images:
  - alias: "api"
    imageName: "ghcr.io/myorg/api:3.x"
    commonUpdateSettings:
      updateStrategy: semver
```

The version constraint is specified as part of the `imageName` field, not as a separate property. For example, `some/image:1.2.x` constrains updates to the `1.2` patch branch. `some/image:1.x` allows any minor and patch version within major version 1. Appending `-0` to the constraint (like `2.x-0`) enables matching pre-release tags such as `v2.0-rc1`. If no constraint is specified, the Image Updater simply selects the highest semver tag in the registry.

The `v` prefix on tags is handled transparently, so `v3.2.1` and `3.2.1` are treated the same. The image you are currently running does not need to follow semver either; only the candidate tags in the registry are evaluated.

### Newest Build

The `newest-build` strategy selects the image with the most recent build date. An important distinction is that it uses the image's actual build timestamp from the registry metadata, not the date the tag was created or pushed. This is useful when your tags are not semver-compliant, for example when using Git commit SHAs or build timestamps:

```yaml
images:
  - alias: "worker"
    imageName: "myregistry.io/worker"
    commonUpdateSettings:
      updateStrategy: newest-build
      allowTags: "regexp:^main-[a-f0-9]{7}$"
```

The `allowTags` field is a regex filter (prefixed with `regexp:`) that restricts which tags are considered. In this example, only tags matching the pattern `main-<short-sha>` are evaluated. You can also use `ignoreTags` to exclude specific tags by name, which is useful for filtering out tags like `latest` or `master` that you do not want the updater to consider.

One thing to be aware of is that this strategy performs manifest pulls against the registry to read build dates, and those pulls count toward Docker Hub's rate limits. If you are running against Docker Hub on a free account, keep an eye on your pull budget or use tag filters to limit how many tags get checked.

### Alphabetical

The `alphabetical` strategy sorts all tags in lexical (alphabetical) order and picks the highest one. This is particularly well suited for calendar versioning schemes that use lexically sortable strings like `YYYY-MM-DD` or `YYYYMMDD`:

```yaml
images:
  - alias: "reports"
    imageName: "myregistry.io/reports"
    commonUpdateSettings:
      updateStrategy: alphabetical
      allowTags: "regexp:^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
```

Combined with a tag filter that only matches date strings, this reliably selects the most recent build. The older strategy name `name` still works but is deprecated in favor of `alphabetical`.

### Digest

The `digest` strategy is different from the others. Instead of switching between tags, it tracks the digest of a specific mutable tag. When the registry content behind that tag changes (because someone pushed a new image with the same tag), the updater detects it and triggers an update:

```yaml
images:
  - alias: "frontend"
    imageName: "myregistry.io/frontend:latest"
    commonUpdateSettings:
      updateStrategy: digest
```

The tag to track is specified as part of the `imageName` (in this case `latest`). This is the only strategy designed for mutable tags; the other three all assume tags are immutable. Use this when your team pushes to a fixed tag like `latest`, `stable`, or an environment name like `dev`, and you want downstream deployments to pick up the change automatically. The application manifest stays pinned to the tag name, but the actual deployed digest gets updated.

## Write-Back Methods

How Argo CD Image Updater applies the update is just as important as how it detects one. The write-back method is configured through the `writeBackConfig` block on the `ImageUpdater` resource, and like `commonUpdateSettings` it can be set at the global spec level or per application reference. There are two methods, and they represent fundamentally different operational models.

### Argo CD API (Parameter Overrides)

The default method is `argocd`, which updates the application imperatively through the Argo CD API by setting parameter overrides. This is equivalent to running something like `argocd app set my-app --helm-set image.tag=v3.2.1` manually. The override lives in the Argo CD Application resource, not in Git.

```yaml
spec:
  writeBackConfig:
    method: argocd
```

This is fast and simple, but it breaks a core GitOps principle: Git is no longer the single source of truth for what is running in your cluster. The actual deployed image tag exists only as an Argo CD parameter override, which is not tracked in your config repository. If someone deletes and recreates the Application, the override is lost.

For development environments and quick iteration, this trade-off is often acceptable. For production, you probably want Git write-back.

### Git Write-Back

The `git` method commits the image update back to your repository declaratively. When the Image Updater detects a new image version, it clones your repository, writes the updated parameters, commits the change, and pushes it. The commit message includes details about what was updated, making the change fully auditable through Git history. If you manage your Application resources in Git (for example in an app-of-apps setup), this is almost certainly the method you want.

The `gitConfig` section within `writeBackConfig` controls the repository, branch, and where the updated values are written:

```yaml
spec:
  writeBackConfig:
    method: git
    gitConfig:
      repository: "git@github.com:myorg/frontend-config.git"
      branch: main
      writeBackTarget: "helmvalues:/values.yaml"
```

The `writeBackTarget` field tells the Image Updater where to write the updated image parameters. For Helm applications, `helmvalues:/values.yaml` writes the new tag directly into your values file. For Kustomize applications, use `kustomization` (optionally with a relative or absolute path like `kustomization:../../base`). If you omit `writeBackTarget` entirely, the Image Updater writes to a `.argocd-source-<appName>.yaml` file by default.

The `repository` field is only required when your Application's `spec.source.repoURL` points to a Helm chart repository rather than a Git repo. If your Application already references a Git repository, the Image Updater uses that by default. The `branch` field defaults to whatever `spec.source.targetRevision` is set to on the Application. You can also use a `base:target` format to check out from one branch and push to another, which is useful for creating pull requests instead of pushing directly.

### Git Authentication

By default, the Image Updater reuses the Git credentials already configured in Argo CD. If that does not work for your setup, or if you need a dedicated set of credentials for the Image Updater to push with, you reference a Kubernetes Secret in the `method` field using the format `git:secret:<namespace>/<secret-name>`.

For SSH access, create a secret containing an `sshPrivateKey` field:

```bash
kubectl -n argocd create secret generic git-creds \
  --from-file=sshPrivateKey=~/.ssh/id_rsa
```

For HTTPS access, create a secret with `username` and `password` fields (the password is typically a personal access token rather than an actual password):

```bash
kubectl -n argocd create secret generic git-creds \
  --from-literal=username=someuser \
  --from-literal=password=ghp_yourpersonalaccesstoken
```

For GitHub App authentication, provide the app ID, installation ID, and private key:

```bash
kubectl -n argocd create secret generic git-creds \
  --from-literal=githubAppID=12345 \
  --from-literal=githubAppInstallationID=67890 \
  --from-literal=githubAppPrivateKey="$(cat private-key.pem)"
```

Then reference the secret in your `writeBackConfig`:

```yaml
spec:
  writeBackConfig:
    method: "git:secret:argocd/git-creds"
    gitConfig:
      branch: main
      writeBackTarget: "helmvalues:/values.yaml"
```

The Image Updater detects which authentication method to use based on which fields are present in the secret. If the secret contains `sshPrivateKey`, it uses SSH. If it contains `username` and `password`, it uses HTTPS. If it contains `githubAppID`, it uses GitHub App authentication.

### Choosing a Write-Back Method

The decision usually comes down to environment maturity. Use the `argocd` method for development and staging environments where speed matters more than audit trails. Use `git` for production environments where you need full traceability, the ability to roll back through Git history, and confidence that your Git repository reflects reality.

## Registry Authentication

Public registries like Docker Hub work out of the box for public images, but most real workloads pull from private registries. Argo CD Image Updater supports several authentication methods, configured either at the registry level or per image.

### Registry-Level Credentials

The most common approach is to define credentials in the `registries.conf` configuration, which maps a credential source to a specific registry. The credential reference uses a `type:path` format that supports four sources:

```yaml
registries:
  - name: GitHub Container Registry
    prefix: ghcr.io
    api_url: https://ghcr.io
    credentials: secret:argocd/ghcr-creds#creds
  - name: Docker Hub
    prefix: docker.io
    api_url: https://registry-1.docker.io
    credentials: pullsecret:argocd/dockerhub-secret
    default: true
  - name: ECR
    prefix: 123456789.dkr.ecr.us-east-1.amazonaws.com
    api_url: https://123456789.dkr.ecr.us-east-1.amazonaws.com
    credentials: ext:/app/auth/ecr-login.sh
    credsexpire: 10h
```

The `secret:namespace/name#key` format reads a `username:password` string from a specific key in a generic Kubernetes Secret. The `pullsecret:namespace/name` format reads from a standard Kubernetes `docker-registry` secret, the same kind your cluster already uses for `imagePullSecrets`. If you already have pull secrets for your registries, this is the easiest path since you can reuse them directly without creating a separate credential. You create one the usual way:

```bash
kubectl create -n argocd secret docker-registry dockerhub-secret \
  --docker-username someuser \
  --docker-password s0m3p4ssw0rd \
  --docker-server "https://registry-1.docker.io"
```

The `env:VARIABLE_NAME` format reads from an environment variable (value must be `username:password`). The `ext:/path/to/script` format runs an external script that returns credentials on stdout, which is particularly useful for cloud provider integrations where tokens need to be refreshed. The `credsexpire` field tells the Image Updater how long to cache credentials before refreshing them, which is essential for short-lived tokens like those from ECR or Azure.

### Per-Image Credentials

For cases where different images in the same registry need different credentials, you can set a `pullSecret` in the image's `commonUpdateSettings`. Per-image credentials are re-read on every update cycle, so they always reflect the current secret value. Registry-level credentials, by contrast, are cached at startup and only refreshed when they expire.

### Cloud Provider Integration

For AWS ECR, the recommended approach is an external credential script combined with `credsexpire` so tokens are refreshed before they expire. Azure Container Registry supports Workload Identity through a similar pattern, using an external script to retrieve refresh tokens. These integrations mean you do not need to manage static credentials at all if your cluster is configured for cloud-native authentication.

## Practical Configuration Patterns

### Helm Applications

For Helm-based applications, you need to tell the Image Updater which Helm values correspond to which container images. This mapping is configured through the `manifestTargets.helm` block on each image. The `name` and `tag` fields specify which Helm value paths to set when an update is applied:

```yaml
images:
  - alias: "dex"
    imageName: "quay.io/dexidp/dex:2.x"
    manifestTargets:
      helm:
        name: dex.image.name
        tag: dex.image.tag
```

If your chart uses a combined format like `image: repo:tag` in a single value, you can use `spec` instead of separate `name` and `tag` fields. For charts that store images in a YAML list, you can target a specific index with bracket notation like `images[0].name` and `images[0].tag`.

### Kustomize Applications

For Kustomize applications, the Image Updater uses Kustomize's native image transformer. The `manifestTargets.kustomize` block maps the updated image to the original image reference used in your manifests:

```yaml
images:
  - alias: "argocd"
    imageName: "ghcr.io/argoproj/argocd:2.x"
    manifestTargets:
      kustomize:
        name: quay.io/argoproj/argocd
```

The `name` field tells the Image Updater which image reference in the Kustomize manifests to override. This is necessary when the image name in the `ImageUpdater` resource differs from the one in your base manifests.

### Multi-Container Applications

Applications with multiple containers are handled by listing multiple images in the same application reference. Each image gets its own alias, update strategy, and manifest target:

```yaml
applicationRefs:
  - namePattern: "my-app"
    images:
      - alias: "frontend"
        imageName: "myregistry.io/frontend:1.x"
        commonUpdateSettings:
          updateStrategy: semver
        manifestTargets:
          helm:
            name: frontend.image.repository
            tag: frontend.image.tag
      - alias: "backend"
        imageName: "myregistry.io/backend:2.x"
        commonUpdateSettings:
          updateStrategy: semver
        manifestTargets:
          helm:
            name: backend.image.repository
            tag: backend.image.tag
      - alias: "worker"
        imageName: "myregistry.io/worker"
        commonUpdateSettings:
          updateStrategy: newest-build
          allowTags: "regexp:^main-[a-f0-9]{7}$"
        manifestTargets:
          helm:
            name: worker.image.repository
            tag: worker.image.tag
```

Different images can use different update strategies, version constraints, and tag filters, all within a single `ImageUpdater` resource.

## Webhook Support

By default, Argo CD Image Updater polls registries on a fixed interval. Webhooks flip that model: registries push notifications when new images are available, reducing the delay between a push and an update from minutes to seconds. Support covers Docker Hub, GitHub Container Registry, Quay.io, and Harbor natively. AWS ECR is supported through EventBridge by transforming ECR push events into the CloudEvents v1.0 format and forwarding them to the webhook endpoint.

The webhook server is a built-in component that you enable through the `argocd-image-updater-config` ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-image-updater-config
  namespace: argocd
data:
  webhook.enable: "true"
  webhook.port: "8082"
```

Once enabled, the server exposes two endpoints: `/webhook` for receiving registry notifications and `/healthz` for health checks. Registries send notifications to `/webhook` with a `type` query parameter identifying the registry:

```
https://image-updater.example.com/webhook?type=ghcr.io
```

The valid type values are `docker.io`, `ghcr.io`, `harbor`, `quay.io`, and `cloudevents` (for ECR). You will need to expose the webhook endpoint through an Ingress or Service so your registries can reach it. The project includes ready-made Service and Ingress manifests in `manifests/base/networking` to help with this.

To secure the endpoint, configure a shared secret for each registry in the `argocd-image-updater-secret` Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-image-updater-secret
  namespace: argocd
stringData:
  webhook.docker-secret: <YOUR_SECRET>
  webhook.ghcr-secret: <YOUR_SECRET>
  webhook.harbor-secret: <YOUR_SECRET>
  webhook.quay-secret: <YOUR_SECRET>
  webhook.cloudevents-secret: <YOUR_SECRET>
```

GitHub Container Registry and Harbor validate the secret using their built-in webhook signature mechanisms. Docker Hub, Quay, and CloudEvents pass the secret as a query parameter (`?secret=your-shared-secret`), which is less secure but the only option those platforms support. If you are worried about brute-force attempts, you can set a rate limit with `webhook.ratelimit-allowed` in the ConfigMap to cap the number of requests accepted per second.

## Fitting It into Your GitOps Stack

Argo CD Image Updater fills a specific role in the GitOps pipeline. Your CI system builds and pushes images. The Image Updater detects the new image and updates your configuration (either through the API or Git). [Argo CD](/blog/argo-cd/) reconciles the change to your cluster.

For [Argo Rollouts](/blog/argo-rollouts/) users, the Image Updater works seamlessly because the rollout starts as soon as Argo CD syncs the updated manifest. The Image Updater triggers the change, Argo CD syncs it, and Argo Rollouts manages the progressive delivery.

The combination of Image Updater with Git write-back and [Argo CD Notifications](/blog/argo-cd-notifications/) gives you a fully automated pipeline with complete visibility. New images get detected, changes get committed to Git, Argo CD syncs the deployment, and your team gets notified through Slack or PagerDuty without anyone having to manually update a manifest or watch a dashboard.

## If You Are Already Using Kargo, You Do Not Need This

It is worth being direct about this: if you have already adopted [Kargo](/blog/kargo/), you do not need the Argo CD Image Updater. Kargo's Warehouses already perform container image discovery natively. A Warehouse watches your registries for new tags, evaluates them against semver constraints, and produces Freight that gets promoted through your Stages. That is the same core job the Image Updater does, but Kargo wraps it into a much broader promotion lifecycle that includes multi-environment orchestration, approval gates, and verification steps.

Kargo also handles the write-back side, and it is considerably more versatile than the Image Updater's approach. Through PromotionTasks, Kargo can update Helm values files, patch Kustomize overlays, run `kustomize edit set image`, modify arbitrary YAML or JSON files, and commit those changes back to Git as part of a structured promotion pipeline. Kargo's promotion steps can orchestrate complex multi-file updates across different repositories, render Helm charts, run verification steps after the commit, and gate promotions on manual approvals or automated checks. The write-back is just one step in a larger, composable workflow.

Running both tools side by side is not just unnecessary, it can actively interfere with Kargo. Two controllers polling the same registries and writing changes to the same repositories creates a race condition. The Image Updater could commit an image update to Git at the same time Kargo is promoting Freight through a Stage, leading to conflicting commits, unexpected syncs, or Kargo's verification steps running against changes it did not initiate. Kargo was designed to own the entire flow from artifact discovery through production deployment, so once you adopt it, the Image Updater should be removed entirely rather than left running alongside it.

Where Argo CD Image Updater still makes sense is in teams that use Argo CD without Kargo. If your deployment model is straightforward, you deploy to one or two environments, and you do not need Kargo's promotion pipelines, the Image Updater is a lightweight way to automate image updates without taking on the additional complexity of a full orchestration layer. It does one thing well and stays out of your way.

The decision comes down to scope. If you need automated image detection and nothing more, the Image Updater is the right fit. If you need to manage how those images flow through dev, staging, and production with controls at each step, Kargo is the better tool, and it already covers both the image discovery and the Git write-back with far more flexibility.

## Tips for Running in Production

**Use tag filters aggressively.** Without `allowTags` or `ignoreTags`, the Image Updater considers every tag in your repository. This slows down the update check and can lead to unexpected matches. Always filter to the tag pattern your CI system produces.

**Set appropriate check intervals.** The default reconciliation interval is two minutes. For development environments the default is fine, but for production you might want to increase it to reduce registry API calls, especially if you are running against rate-limited registries like Docker Hub. You can change it through the `argocd-image-updater-config` ConfigMap using the `interval` key and a value such as `10m`.

**Monitor the controller logs.** The Image Updater logs every check it performs and every update it applies. Watching these logs during initial rollout helps catch misconfigured constraints or authentication issues before they cause problems.

**Pin your constraint ranges.** A broad constraint like `imageName: "myimage"` with no version constraint means the Image Updater will jump to any new version the moment it appears, including major version bumps. Use constraints like `1.2.x` to limit updates to patch versions within a specific minor release, or `1.x` to allow minor updates within a major version. Update the constraint explicitly when you are ready for a larger version jump.

**Combine with Argo CD sync windows.** If you are using Git write-back, Argo CD will sync the change as soon as it detects the commit. Use [sync windows](https://argo-cd.readthedocs.io/en/stable/user-guide/sync_windows/) to prevent automatic image updates from deploying during maintenance periods or outside business hours.

## Wrapping Up

Argo CD Image Updater removes the last manual step from many GitOps pipelines. Instead of relying on developers or CI jobs to update image tags in manifests, the controller watches your registries and handles it automatically. The CRD-based configuration in v1.0 and later makes it straightforward to manage at scale, and the Git write-back method ensures your repository stays the single source of truth.

Combined with [Argo CD](/blog/argo-cd/) for delivery, [Argo Rollouts](/blog/argo-rollouts/) for progressive delivery, and [Argo CD Notifications](/blog/argo-cd-notifications/) for alerting, you have a fully automated pipeline from image build to production deployment, with every step tracked in Git and visible to your team.

If you need help setting up automated image updates, designing version constraints, or integrating the Image Updater into your existing GitOps workflow, [get in touch](/contact).
