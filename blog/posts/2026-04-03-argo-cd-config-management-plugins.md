---
title: "Argo CD Config Management Plugins: Extending GitOps Beyond Helm and Kustomize"
date: 2026-04-03
description: "A deep dive into Argo CD Config Management Plugins. Covers the sidecar architecture, writing plugin configurations, discovery rules, parameterization, building custom plugins for tools like CUE and Tanka, deployment patterns, and debugging strategies for production CMPs."
image: /blog/images/tanka.svg
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - config-management
---

<div class="blog-hero">
  <img src="/blog/images/tanka.svg" alt="Argo CD Config Management Plugin sidecar architecture" width="300" style="display: inline-block;">
</div>

Argo CD ships with native support for Helm, Kustomize, and Jsonnet. For many teams, that covers everything. But the Kubernetes configuration management ecosystem is broader than those three tools. Maybe your team standardized on [CUE](https://cuelang.org/) for its type safety and validation. Maybe you inherited a stack built on [Grafana Tanka](https://tanka.dev/) and Jsonnet libraries that go beyond what Argo CD's native Jsonnet support handles. Maybe you have a proprietary templating pipeline that stitches together manifests from an internal API. Or maybe you just need to run a script that calls `envsubst` on plain YAML before Argo CD applies it.

Config Management Plugins (CMPs) exist for exactly these situations. They let you teach Argo CD how to turn any source format into valid Kubernetes manifests. The mechanism is straightforward: you provide a container that knows how to render manifests, Argo CD hands it the repository contents, and your container writes the resulting YAML to stdout. Everything else, diffing, syncing, health checks, pruning, works exactly the same as it does with native tools.

If you are new to Argo CD, my [getting started guide](/blog/argo-cd/) covers installation and core concepts. This post assumes you have a running Argo CD instance and want to extend it with a custom plugin.

## The Sidecar Architecture

The original CMP implementation, which was configured through the `argocd-cm` ConfigMap, was deprecated in Argo CD v2.4 and fully removed in v2.8. The current approach runs plugins as sidecar containers alongside the `argocd-repo-server` pod. Each sidecar runs a lightweight gRPC server called `argocd-cmp-server` that receives requests from the repo server, executes your plugin's commands against the repository contents, and returns the generated manifests.

This architecture has several advantages. Each plugin runs in its own container with its own filesystem, dependencies, and resource limits. A misbehaving plugin cannot crash the repo server or interfere with other plugins. You can update a plugin's container image independently of the Argo CD version. And because each sidecar gets its own `/tmp` directory, there is no risk of path traversal attacks between plugins or between a plugin and the repo server.

The repo server communicates with each sidecar over a Unix domain socket mounted from a shared volume. When Argo CD needs to render manifests for an Application, it streams the repository contents to the appropriate sidecar as a tar archive. The sidecar extracts the archive, runs your plugin's commands, and streams back the generated YAML.

## Writing a Plugin Configuration

Every CMP sidecar needs a plugin configuration file at `/home/argocd/cmp-server/config/plugin.yaml`. This file tells Argo CD what your plugin is called, how to detect when it should be used, and what commands to run. You can bake this file into a custom image, or if you are using a stock image and would rather maintain the configuration outside the image, nest the plugin config in a ConfigMap under the `plugin.yaml` key and mount it into the sidecar at the expected path. The deployment example later in this post uses the ConfigMap approach.

Here is a minimal plugin wrapped in a ConfigMap that runs `envsubst` on all YAML files in a repository:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: envsubst-plugin-config
  namespace: argocd
data:
  plugin.yaml: |
    apiVersion: argoproj.io/v1alpha1
    kind: ConfigManagementPlugin
    metadata:
      name: envsubst
    spec:
      version: v1.0
      generate:
        command: [sh, -c]
        args:
          - |
            set -o pipefail
            for f in *.yaml; do
              envsubst < "$f"
              echo "---"
            done
      discover:
        fileName: ".envsubst-marker"
```

The `generate` block is the only required section. Its `command` must write valid Kubernetes YAML or JSON to stdout. Anything written to stderr is captured and displayed in the Argo CD UI as informational messages. If the command exits with a non-zero status, the manifest generation fails and Argo CD reports the error.

The `discover` block tells Argo CD when to automatically use this plugin. In this example, any repository that contains a file called `.envsubst-marker` at its root will be matched to this plugin. Discovery is optional. If you omit it, you must explicitly name the plugin in each Application spec.

### The Init Command

If your plugin needs to download dependencies or set up state before generating manifests, use the `init` block:

```yaml
spec:
  init:
    command: [sh, -c]
    args:
      - |
        npm install
  generate:
    command: [sh, -c]
    args:
      - |
        npx my-renderer --output yaml
```

The init command runs before every generate invocation. Its stdout is discarded, but a non-zero exit code will fail the entire manifest generation. Keep init commands fast because they add to every sync and diff operation.

### Discovery Rules

Discovery determines which plugin handles a given Application. Argo CD supports three discovery mechanisms, and you should only use one per plugin:

`fileName` matches against exact filenames or glob patterns:

```yaml
discover:
  fileName: "./kustomization.yaml"
```

`find.glob` searches the repository tree for matching files:

```yaml
discover:
  find:
    glob: "**/*.cue"
```

`find.command` runs an arbitrary command that exits 0 if the plugin should handle the repository:

```yaml
discover:
  find:
    command: [sh, -c]
    args:
      - |
        test -f jsonnetfile.json && test -d environments/
```

When multiple plugins have discovery rules that match the same repository, the behavior is undefined. Only one plugin can handle a given Application, so make sure your discovery rules are specific enough to avoid collisions.

## Deploying a CMP Sidecar

To deploy a CMP, you need to patch the `argocd-repo-server` Deployment to add your sidecar container and mount the necessary volumes. Here is a complete example that adds a `yq`-based plugin. The plugin merges an environment-specific overlay file on top of base YAML manifests, a pattern that is useful when you want structured YAML merging without the overhead of Kustomize or Helm.

First, create a ConfigMap with the plugin configuration:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: yq-plugin-config
  namespace: argocd
data:
  plugin.yaml: |
    apiVersion: argoproj.io/v1alpha1
    kind: ConfigManagementPlugin
    metadata:
      name: yq-overlay
    spec:
      version: v1.0
      generate:
        command: [sh, -c]
        args:
          - |
            set -o pipefail
            if [ -f "overlay.yaml" ]; then
              for f in base/*.yaml; do
                yq eval-all 'select(fileIndex == 0) * select(fileIndex == 1)' "$f" overlay.yaml
                echo "---"
              done
            else
              cat base/*.yaml
            fi
      discover:
        fileName: ".yq-overlay-marker"
```

Then patch the repo-server Deployment to add the sidecar. The `mikefarah/yq` image is Alpine-based, so it includes a shell and works as a CMP sidecar without any custom image builds:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-repo-server
  namespace: argocd
spec:
  template:
    spec:
      containers:
        - name: yq-plugin
          command: [/var/run/argocd/argocd-cmp-server]
          image: docker.io/mikefarah/yq:4.52.5
          securityContext:
            runAsNonRoot: true
            runAsUser: 999
          volumeMounts:
            - mountPath: /var/run/argocd
              name: var-files
            - mountPath: /home/argocd/cmp-server/plugins
              name: plugins
            - mountPath: /home/argocd/cmp-server/config/plugin.yaml
              subPath: plugin.yaml
              name: yq-plugin-config
            - mountPath: /tmp
              name: yq-tmp
      volumes:
        - name: yq-plugin-config
          configMap:
            name: yq-plugin-config
        - name: yq-tmp
          emptyDir: {}
```

A few things to note about this configuration. The `command` must be `/var/run/argocd/argocd-cmp-server`, which is the gRPC server binary that the repo server uses to communicate with the sidecar. The `var-files` and `plugins` volumes are already defined by the default Argo CD installation and are shared between the repo server and all sidecars. The `/tmp` volume must be a separate `emptyDir` for each sidecar. Do not share the repo server's `/tmp` volume with your plugin because that opens a path traversal attack surface.

The `runAsUser: 999` setting matches the non-root user that `argocd-cmp-server` expects. If your plugin's base image does not have a user with UID 999, the container will still run, but file ownership may behave unexpectedly. When choosing a sidecar image, prefer Alpine-based images or other lightweight images that include a shell, since the generate command needs `sh` to run. Minimal or distroless images that ship only a single binary will fail because `argocd-cmp-server` cannot execute shell commands against them.

## A Practical Example: Tanka Plugin

Grafana Tanka is a Jsonnet-based configuration tool that adds environment management, resource formatting, and a CLI on top of raw Jsonnet. Argo CD's native Jsonnet support cannot handle Tanka's environment structure, so a CMP is the way to integrate the two.

Here is a Tanka plugin configuration:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ConfigManagementPlugin
metadata:
  name: tanka
spec:
  version: v1.0
  init:
    command: [sh, -c]
    args:
      - |
        jb install
  generate:
    command: [sh, -c]
    args:
      - |
        set -o pipefail
        tk show environments/$ARGOCD_ENV_TANKA_ENV --dangerous-allow-redirect
  discover:
    fileName: "jsonnetfile.json"
```

The init step runs `jb install` (jsonnet-bundler) to download Jsonnet library dependencies declared in `jsonnetfile.json`. The generate step calls `tk show` against a specific Tanka environment. The environment name is passed through the `ARGOCD_ENV_TANKA_ENV` variable, which you set on the Application spec.

The Application that uses this plugin looks like this:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: monitoring
  namespace: argocd
spec:
  project: default
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  source:
    repoURL: https://github.com/mycompany/tanka-configs.git
    targetRevision: main
    path: .
    plugin:
      env:
        - name: TANKA_ENV
          value: production/monitoring
```

Notice that the `plugin` section does not specify a `name`. Because the Tanka plugin has a discovery rule matching `jsonnetfile.json`, Argo CD automatically selects it. The `env` block sets the `TANKA_ENV` variable, which the plugin accesses as `$ARGOCD_ENV_TANKA_ENV`. Argo CD automatically prefixes all application-defined environment variables with `ARGOCD_ENV_` before passing them to the plugin.

## Environment Variables and Parameters

Plugins receive context about the current Application through environment variables. The standard set includes:

- `ARGOCD_APP_NAME` - the Application's name
- `ARGOCD_APP_NAMESPACE` - the Application's namespace in the cluster
- `ARGOCD_APP_REVISION` - the Git revision being rendered
- `KUBE_VERSION` - the target cluster's Kubernetes version
- `KUBE_API_VERSIONS` - the API versions available on the target cluster

Any variables defined in the Application's `source.plugin.env` block are available with the `ARGOCD_ENV_` prefix. This is the primary mechanism for passing configuration from an Application to a plugin without hardcoding values in the plugin itself.

For more structured input, CMPs support parameters. Parameters are declared in the plugin configuration and surfaced in the Argo CD UI so users can fill them in without editing YAML:

```yaml
spec:
  parameters:
    static:
      - name: environment
        title: Target Environment
        required: true
        collectionType: string
        string: dev
      - name: features
        title: Feature Flags
        collectionType: array
    dynamic:
      command: [sh, -c]
      args:
        - |
          echo '[{"name": "cluster", "string": "'"$ARGOCD_APP_NAME"'"}]'
```

Static parameters have fixed definitions. Dynamic parameters are resolved at runtime by executing a command, which lets the plugin inspect the repository or call an external service to determine available options.

All parameter values are passed to the generate command through the `ARGOCD_APP_PARAMETERS` environment variable as a JSON string. They are also available as individual environment variables with names derived from the parameter name: hyphens become underscores, and array elements get numeric suffixes. For example, a parameter named `feature-flags` with value `["canary", "debug"]` produces `PARAM_FEATURE_FLAGS_0=canary` and `PARAM_FEATURE_FLAGS_1=debug`.

One important caveat: parameter defaults declared in the plugin configuration do not automatically populate `ARGOCD_APP_PARAMETERS`. The defaults are only used to populate the UI. Your generate command must implement its own defaulting logic if the parameter is not present.

## Performance and Timeouts

Every time Argo CD diffs an Application or runs a sync, it calls the CMP's generate command. For large repositories or slow rendering tools, this can become a bottleneck. There are several timeout settings that control how long Argo CD waits for a CMP to respond.

The repo server has `server.repo.server.timeout.seconds` (default 60 seconds) and the Application controller has `controller.repo.server.timeout.seconds` (also 60 seconds by default). On the sidecar side, the `ARGOCD_EXEC_TIMEOUT` environment variable controls how long the CMP server waits for your generate command to finish (default 90 seconds). There is also `ARGOCD_EXEC_FATAL_TIMEOUT` which, when exceeded, terminates the sidecar process entirely.

If your plugin regularly takes more than a few seconds, you should increase these timeouts proportionally. The sidecar timeout should always be higher than the repo server timeout to ensure the sidecar has time to finish even when the repo server is willing to wait. Set the sidecar timeout to at least 30 seconds more than the repo server timeout.

A subtle but common issue is that the timeout budget is shared across the entire render cycle, not allocated per phase. Argo CD first streams the repository contents to the sidecar as a tar archive (`MatchRepository`), then runs your generate command (`GenerateManifest`), all within the same deadline. For large repositories, the tar streaming alone can consume most of the timeout window. You may see `MatchRepository` succeed after 50 seconds, only for `GenerateManifest` to be immediately canceled because there are only a few seconds left on the clock. The error will say `DeadlineExceeded` or `context canceled`, which looks like a generate problem but is actually a streaming problem. If you hit this, the first thing to do is exclude unnecessary files from the tar stream using `--plugin-tar-exclude` on the repo server (covered in the monorepo section below). That often matters more than increasing timeouts, though you may need to do both.

Beyond timeouts, consider what your generate command actually does. If it downloads dependencies in the init step on every invocation, that latency adds up. Pre-baking dependencies into your container image where possible is the single biggest performance optimization for CMPs. For Tanka and Jsonnet plugins, this means bundling the vendor directory or common libraries directly into the image rather than running `jb install` every time.

## Monorepo Support with Manifest Generate Paths

If you use a monorepo, Argo CD normally sends the entire repository to the CMP for rendering. For large repositories this is wasteful. The `manifest-generate-paths` annotation tells Argo CD to only trigger a refresh when files in specific paths change, and to only send those paths to the plugin:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: billing
  annotations:
    argocd.argoproj.io/manifest-generate-paths: /services/billing
```

For this to work with CMPs, you must also enable it on the repo server by setting the `--plugin-use-manifest-generate-paths` argument or the `ARGOCD_REPO_SERVER_PLUGIN_USE_MANIFEST_GENERATE_PATHS` environment variable to `true`. Without this flag, the annotation is ignored for CMP-rendered Applications.

You can also control which files are streamed to the sidecar using tar exclusions. The `--plugin-tar-exclude` flag on the repo server accepts Go filepath patterns:

```yaml
- --plugin-tar-exclude=.git/*
- --plugin-tar-exclude=docs/*
- --plugin-tar-exclude=**/*.md
```

This reduces the size of the tar stream sent to the sidecar, which speeds up rendering for repositories with large non-manifest directories.

## Providing Git Credentials to a Plugin

Some plugins need to clone additional repositories or access private Git submodules during generation. By default, CMPs do not have access to the credentials that the repo server uses to clone the primary repository. You can grant access by setting `provideGitCreds: true` in the plugin configuration:

```yaml
spec:
  provideGitCreds: true
  generate:
    command: [sh, -c]
    args:
      - |
        git submodule update --init --recursive
        my-renderer generate ./
```

When enabled, the sidecar shares the repo server's Git ASKPASS mechanism through a Unix socket. This requires an additional volume mount for the ASKPASS socket and the `ARGOCD_ASK_PASS_SOCK` environment variable on both the repo server and the sidecar.

Use this feature carefully. Granting Git credentials to a plugin means the plugin's code, and anything in the repository it processes, has access to your Git authentication. Only enable it for plugins you trust completely.

## Debugging CMPs in Production

CMP debugging follows a predictable set of steps. Start by verifying both containers are running in the repo server pod:

```bash
kubectl get pod -n argocd -l app.kubernetes.io/component=repo-server \
  -o jsonpath='{.items[0].spec.containers[*].name}'
```

You should see your sidecar container name alongside `argocd-repo-server`. If the sidecar is in `CrashLoopBackOff`, check that the plugin configuration file is mounted correctly at `/home/argocd/cmp-server/config/plugin.yaml` and that the entrypoint is `/var/run/argocd/argocd-cmp-server`.

Next, check the sidecar logs for errors:

```bash
kubectl logs -n argocd deployment/argocd-repo-server -c yq-plugin
```

If you see timeout errors but the plugin works manually, increase `ARGOCD_EXEC_TIMEOUT` on the sidecar container. If the generate command fails, replicate the issue by exec'ing into the sidecar and running the command manually:

```bash
kubectl exec -n argocd deployment/argocd-repo-server -c yq-plugin -- \
  sh -c "cd /tmp && yq --version"
```

One subtle issue: Argo CD caches generated manifests in Redis. During development, you may change the plugin configuration or image and see stale results. Use the "Hard Refresh" button in the Argo CD UI, or call `argocd app get <name> --hard-refresh`, to force Argo CD to bypass the cache and re-render from scratch.

If you are using a ConfigMap-mounted plugin configuration, remember that changes to the ConfigMap require a repo server pod restart. Kubernetes updates the mounted file in the pod, but the CMP server reads the configuration at startup and does not watch for changes. A rollout restart of the repo server Deployment is the cleanest way to pick up configuration changes:

```bash
kubectl rollout restart deployment/argocd-repo-server -n argocd
```

## Safety Considerations

CMPs execute arbitrary commands inside your cluster. The sidecar runs as a non-root user (UID 999) and has no access to the Kubernetes API by default, but it does have network access and can reach external services. A malicious or buggy plugin could exfiltrate repository contents, mine cryptocurrency in the background, or produce manifests that deploy resources you did not intend.

Treat CMP container images with the same rigor you apply to any workload running in your cluster. Pin image tags to specific digests rather than mutable tags. Scan images for vulnerabilities. Set CPU and memory limits on the sidecar container to prevent resource exhaustion. And audit the generate command logic, especially if it processes untrusted input from Application parameters.

The `preserveFileMode` option in the plugin spec controls whether the sidecar preserves file permissions from the Git repository. The default is `false`, which strips executable permissions. Setting it to `true` allows repository files to be executable inside the sidecar, which is necessary for some workflows but increases the attack surface. Only enable it if your plugin specifically requires it.

## When to Use a CMP vs. Other Approaches

CMPs are the right tool when you have a config management tool that Argo CD does not natively support and you want full integration with Argo CD's diff, sync, and health check pipeline. They are not the only option, though.

For simple preprocessing like variable substitution or manifest patching, Argo CD's built-in [Kustomize](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/) integration with inline patches might be enough. If you are doing post-render modification of Helm output, Helm's [post-renderer](https://helm.sh/docs/topics/advanced/#post-rendering) feature works with Argo CD's native Helm support and does not require a CMP.

If you are considering a CMP to inject secrets into manifests, look at [External Secrets Operator](/blog/external-secrets-operator/) instead. ESO runs as a separate controller, integrates natively with Argo CD's sync and health checks, and keeps secrets management out of the manifest generation pipeline entirely. The popular argocd-vault-plugin was historically deployed as a CMP, but the community has largely moved toward ESO for new deployments.

For teams using Kargo for promotion pipelines, CMPs and Kargo operate at different layers. Kargo handles the promotion of artifacts across stages, updating Git repositories and triggering syncs. CMPs handle the translation of whatever is in those repositories into Kubernetes manifests. The two complement each other without overlapping. A Kargo promotion might update a CUE value file in Git, and your CUE CMP would render the updated manifests when Argo CD syncs.

## Putting It Together

Here is a checklist for deploying a production CMP:

Build or select a container image that contains your rendering tool and has `/var/run/argocd/argocd-cmp-server` available (it is present in the repo server image and can be copied with a multi-stage build or an init container). Write a plugin configuration with explicit discovery rules that do not overlap with other plugins or Argo CD's native detection. Create a ConfigMap with the configuration and patch the repo-server Deployment to add your sidecar with the correct volume mounts. Set appropriate resource limits and timeout values. Test with a simple Application first, then expand to production workloads.

CMPs are one of those features where the initial setup takes some effort, but the payoff is substantial. Once deployed, your custom tooling becomes a first-class citizen in Argo CD. Diffs show exactly what changed, syncs apply your manifests atomically, and your team does not have to learn a new workflow just because the rendering tool is different.
