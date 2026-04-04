---
title: "Replace Polling with Push: Kargo Webhook Receivers for Faster Promotions"
date: 2026-03-25
modified: 2026-04-04
description: "Kargo polls your registries by default, but webhooks are faster and lighter. Set up push-based triggers from GitHub, GitLab, or Docker Hub to kick off promotions instantly."
image: /blog/images/webhook.svg
ogBackground: dark
tags:
  - kubernetes
  - kargo
  - gitops
  - webhooks
  - automation
---

<div class="blog-hero">
  <img src="/blog/images/webhook.svg" alt="Kargo webhook receivers for event-driven artifact discovery" width="200" style="display: inline-block;">
</div>

In my previous posts on [Kargo](/blog/kargo/) and [Kargo verification](/blog/kargo-verification/), I covered how Warehouses discover new artifacts and how verification gates protect your promotion pipelines. One thing I glossed over was how Warehouses actually detect that a new artifact exists. By default, they poll. And polling, while simple, introduces a trade-off between resource consumption and discovery latency that gets worse as your deployment infrastructure grows.

Kargo v1.6 introduced webhook receivers that flip this model, and v1.7 refined them with smarter payload filtering and additional platform support. Instead of Warehouses periodically asking registries and Git hosts whether anything has changed, those platforms push notifications to Kargo the moment a new artifact lands. The result is near-instant discovery with less load on your registries and fewer wasted API calls.

## The Polling Problem

A Warehouse configured with default settings runs its discovery process on an interval. The controller also enforces a system-wide minimum interval to prevent any single Warehouse from overwhelming external registries. This means you are always making a trade-off. Set the interval too high and your pipelines react slowly to new artifacts. Set it too low and you burn through API rate limits, especially with container registries like Docker Hub that impose strict quotas.

The problem compounds with scale. If you have 50 Warehouses across 10 projects, all polling their respective registries, that is a steady stream of API calls regardless of whether anything has actually changed. Most of the time, the answer is "no, nothing new," and those calls are wasted. Worse, tuning the global interval to be kinder to your registries increases the average time between an artifact being published and Kargo noticing it. For teams that care about deployment velocity, that delay adds up.

Webhooks address this by adding a push-based notification layer. The registry or Git host tells Kargo when something has changed, triggering immediate discovery instead of waiting for the next polling cycle.

## How Webhook Receivers Work

The architecture is straightforward. You configure a webhook receiver in Kargo, which generates a unique URL. You register that URL with your Git hosting platform or container registry as a webhook endpoint. When an event occurs (a push to a branch, a new image tag), the platform sends an HTTP POST to Kargo's webhook endpoint. Kargo's receiver extracts the repository URL from the payload, finds every Warehouse in the relevant scope that subscribes to that repository, and triggers each one to run its discovery process immediately.

The receiver does not create Freight directly. It simply tells the appropriate Warehouses to check for new artifacts right now instead of waiting for their next polling cycle. The Warehouse's existing subscription filters, including semantic version constraints and commit selectors, still apply.

In the initial v1.6 release, any webhook event for a repository would trigger discovery on every subscribing Warehouse, even if the tag or reference in the payload would ultimately be ignored. Version 1.7 improved this significantly: receivers now inspect the tag, version, or reference extracted from the payload and skip triggering a Warehouse if that artifact would not match the Warehouse's subscription criteria. This means a push of a `latest` tag will not cause unnecessary discovery on a Warehouse that only subscribes to semantic version tags, which cuts down on wasted work in busy repositories.

Kargo supports webhook receivers for GitHub, GitLab, Bitbucket, Docker Hub, Quay, Harbor, GHCR, Azure, Gitea, Artifactory, and a generic receiver that handles any inbound POST request.

## Configuring Webhook Receivers

Webhook receivers can be configured at two levels: per-project using a `ProjectConfig` resource, or cluster-wide using a `ClusterConfig` resource. Both approaches follow the same pattern: create a Secret containing a shared secret for request validation, then reference it from the receiver configuration.

### Project-Level Receivers with ProjectConfig

For a project-scoped receiver, you create a Kubernetes Secret in the project's namespace and a `ProjectConfig` that references it. Here is a complete example for a GitHub webhook receiver:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: github-webhook-secret
  namespace: my-project
  labels:
    kargo.akuity.io/cred-type: generic
data:
  secret: <base64-encoded-secret>
---
apiVersion: kargo.akuity.io/v1alpha1
kind: ProjectConfig
metadata:
  name: my-project
  namespace: my-project
spec:
  webhookReceivers:
    - name: github-receiver
      github:
        secretRef:
          name: github-webhook-secret
```

Generate the shared secret with a command like this:

```bash
secret=$(openssl rand -base64 48 | tr -d '=+/' | head -c 32)
echo "Secret: $secret"
echo "Encoded: $(echo -n $secret | base64)"
```

After applying these resources, Kargo generates a unique webhook URL and writes it to the `ProjectConfig` status. Retrieve it with:

```bash
kubectl get projectconfigs my-project \
  -n my-project \
  -o=jsonpath='{.status.webhookReceivers}'
```

A project-level receiver only triggers Warehouses within that project. If a Warehouse in `my-project` subscribes to `https://github.com/my-org/deploy-config.git` and a push event arrives for that repository, only that Warehouse runs discovery. Warehouses in other projects are unaffected.

### Cluster-Level Receivers with ClusterConfig

When you have many projects subscribing to repositories from the same Git hosting provider, configuring a receiver in every project is tedious. A `ClusterConfig` receiver handles webhook requests across all projects from a single configuration:

```yaml
apiVersion: kargo.akuity.io/v1alpha1
kind: ClusterConfig
metadata:
  name: cluster
spec:
  webhookReceivers:
    - name: org-github-receiver
      github:
        secretRef:
          name: github-org-secret
---
apiVersion: v1
kind: Secret
type: Opaque
metadata:
  name: github-org-secret
  namespace: kargo-system-resources
  labels:
    kargo.akuity.io/cred-type: generic
data:
  secret: <base64-encoded-secret>
```

Note that the Secret for a `ClusterConfig` lives in the cluster secrets namespace, which defaults to `kargo-system-resources`. When a webhook arrives, Kargo scans all projects for Warehouses subscribing to the repository in the payload and triggers discovery for each match.

This is the approach I would recommend for platform teams managing a GitHub or GitLab organization. Configure one `ClusterConfig` receiver, register it as an organization-level webhook, and every project benefits automatically without any per-project configuration.

## Platform-Specific Setup

Each platform has its own quirks for webhook registration. Here are the ones I use most frequently.

### GitHub

GitHub supports webhook registration at the repository level, organization level, or through a GitHub App. For most teams, the organization-level webhook is the sweet spot. Navigate to `https://github.com/organizations/<your-org>/settings/hooks` and create a new webhook with the URL from your `ProjectConfig` or `ClusterConfig` status. Set the content type to `application/json`, paste the shared secret you generated, and select the events you want to trigger on.

For Git repositories, select "Just the push event." If you also use GHCR for container images within the same organization, select "Pushes" and "Packages" individually instead. The receiver handles `ping`, `push`, and `package` event types.

One thing to be aware of with GHCR: package events are only delivered for container images that are explicitly associated with a Git repository. Check GitHub's documentation on connecting a repository to a package if your images are not triggering webhooks.

### Docker Hub

Docker Hub's webhook system is simpler but also more limited. Navigate to your repository on Docker Hub, open the Webhooks tab, and add the URL from Kargo. Docker Hub does not sign webhook payloads the way GitHub does. Instead, the shared secret is incorporated into the generated URL itself, making the URL effectively a bearer token. Keep it confidential.

Docker Hub webhooks fire whenever an image is pushed to the repository. There is no event filtering on the Docker Hub side, so every push sends a notification to Kargo. With v1.7's payload filtering, the receiver will skip triggering a Warehouse if the pushed tag would not match that Warehouse's subscription criteria.

### GitLab

GitLab webhooks are configured under your project's Settings > Webhooks page, or at the group level for broader coverage. Add the URL from Kargo, paste the shared secret as the "Secret token," and enable the "Push events" trigger. For container registry events, you may also want to enable "Tag push events" depending on your workflow.

GitLab webhooks support SSL verification, which you should leave enabled if your Kargo installation uses a valid TLS certificate. If you are running Kargo behind a self-signed certificate in a development environment, you may need to disable this temporarily for testing.

## Combining Webhooks with Existing Pipelines

Webhooks do not change how the rest of your Kargo pipeline works. They only change the trigger mechanism for Warehouse discovery. Your Stages, verification, soak times, and PromotionTasks all function exactly as before. The difference is that the pipeline reacts faster because the Warehouse detects new artifacts within seconds of them being published rather than waiting for the next polling cycle.

Here is how a typical end-to-end flow looks with webhooks enabled:

1. A CI pipeline builds a new container image and pushes it to GHCR.
2. GitHub sends a `package` event to the Kargo webhook receiver.
3. The receiver identifies the repository URL and queries for matching Warehouses.
4. The matching Warehouse runs discovery, finds the new image tag, and creates Freight.
5. If the first Stage in the pipeline has automatic promotion enabled, the Freight is promoted immediately.
6. Verification and soak times proceed as configured.

The entire path from image push to initial promotion can happen in under a minute, compared to several minutes or longer with polling depending on your interval configuration.

## A Note on Polling Intervals

Webhooks do not replace polling entirely. If a webhook delivery fails or the receiver is temporarily unavailable, you will not learn about new artifacts until the next polling cycle. Kargo's polling continues to run on its configured interval as a fallback. Think of webhooks as an optimization that provides faster notification under normal conditions, not as a replacement for the underlying discovery mechanism. That said, once you have reliable webhook delivery in place, you can safely increase the polling interval on your Warehouses (via `spec.interval`) or raise the system-wide minimum interval. This reduces the load on both external registries and the Kargo controller while still maintaining a safety net for missed webhook deliveries.

## Practical Recommendations

**Start with a ClusterConfig.** A single `ClusterConfig` can define multiple receivers covering your Git hosts and container registries in one resource. Organization-level webhooks on the sender side mean every project benefits automatically without per-project setup. Use `ProjectConfig` receivers when individual teams need control over their own webhook configuration without cluster admin access.

**Generate strong shared secrets.** The `openssl rand` command shown earlier produces a 32-character random string. Do not reuse secrets across receivers, and store them in your secrets management system alongside your other credentials.

**Monitor webhook deliveries on the sender side.** GitHub, GitLab, and Docker Hub all provide webhook delivery logs. If your pipeline stops reacting to new artifacts, check these logs first. A failed delivery usually points to a network issue or a misconfigured secret rather than a Kargo bug.

**Do not set excessively long polling intervals.** Polling always runs as a fallback regardless of webhook configuration. It is tempting to push the interval as high as possible once webhooks are working, but webhooks are best-effort delivery. A reasonable polling interval is your guarantee that artifacts are eventually discovered even if a webhook is lost.

## What's Next

The Kargo team has been shipping features at an aggressive pace. If you are not already using [verification and soak times](/blog/kargo-verification/), those are the natural next step for hardening your promotion pipelines. For broader context on how Kargo fits into a GitOps workflow alongside Argo CD, check out [my introduction to Kargo](/blog/kargo/) and the [Argo CD deep dive](/blog/argo-cd/).

The [Kargo documentation](https://docs.kargo.io/) covers every supported webhook receiver platform including Artifactory, Azure, Harbor, and the generic receiver for platforms that are not directly supported. For help designing promotion pipelines for your team, [get in touch](/contact).
