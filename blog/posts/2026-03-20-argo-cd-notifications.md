---
title: "Stop Watching the Argo CD Dashboard: Set Up Slack and PagerDuty Notifications"
date: 2026-03-20
modified: 2026-04-04
description: "Get Slack alerts when apps go OutOfSync and PagerDuty pages when they degrade. Set up triggers, templates, and service integrations in minutes with Argo CD's built-in notification engine."
image: /blog/images/notifications-hero.webp
ogBackground: dark
tags:
  - kubernetes
  - argo-cd
  - gitops
  - notifications
  - observability
---

<div class="blog-hero">
  <img src="/blog/images/notifications-hero.webp" alt="Slack notification" width="200" style="display: inline-block;">
</div>

A GitOps pipeline that nobody is watching is a pipeline that can fail silently. You can have [Argo CD](/blog/argo-cd/) reconciling your clusters, [ApplicationSets](/blog/argo-cd-applicationsets/) generating applications across environments, and [Argo Rollouts](/blog/argo-rollouts/) handling progressive delivery, but if a sync fails at 2 AM and nobody finds out until users start filing tickets, the automation is only doing half its job.

Argo CD Notifications solves this. It is a built-in notification engine that continuously monitors your Argo CD applications and sends alerts through Slack, email, webhooks, PagerDuty, Microsoft Teams, and a dozen other services when something changes. Syncs succeed, syncs fail, health degrades, an operation takes too long. You define the conditions, the message content, and where the alerts go. Everything is configured declaratively through ConfigMaps and annotations, which means your notification rules live alongside your applications in Git.

## How the Notification System Works

Argo CD Notifications is built into the Argo CD controller. It watches Application resources for state changes and evaluates those changes against a set of triggers you define. When a trigger condition matches, the system renders a notification template and sends it through the configured service.

The three core concepts are **services**, **triggers**, and **templates**. Services define where notifications go (Slack, email, webhook). Triggers define when notifications fire (sync succeeded, health degraded, operation running too long). Templates define what the notification says, including service-specific formatting like Slack blocks or webhook JSON bodies.

All configuration lives in two resources: the `argocd-notifications-cm` ConfigMap for service definitions, triggers, and templates, and the `argocd-notifications-secret` Secret for credentials like API tokens. You subscribe individual applications to specific triggers by adding annotations.

## Configuring a Notification Service

Let's start with the most common setup: sending notifications to Slack. First, create a Slack app at [api.slack.com](https://api.slack.com/apps?new_app=1) and give the bot token the `chat:write` scope. Optionally add `chat:write.customize` if you want the bot to use a custom username and icon. Install the app to your workspace and copy the OAuth token.

Store the token in the notifications secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-notifications-secret
  namespace: argocd
stringData:
  slack-token: xoxb-your-token-here
```

Then register Slack as a service in the ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  service.slack: |
    token: $slack-token
```

The `$slack-token` syntax references the key from the Secret, keeping credentials out of the ConfigMap. Make sure to invite the bot to any channels you plan to send to, or message delivery will fail silently.

## Writing Triggers

Triggers define the conditions under which a notification fires. Each trigger has a name, a `when` condition, and one or more templates to send. The condition is an expression evaluated against the Application object using the [expr](https://github.com/antonmedv/expr) expression language.

Here is a trigger that fires when a sync operation succeeds:

```yaml
data:
  trigger.on-sync-succeeded: |
    - when: app.status.operationState.phase in ['Succeeded']
      send: [app-sync-succeeded]
```

The `app` object in the expression is the full Argo CD Application resource, so you have access to everything in `metadata`, `spec`, and `status`. The optional chaining operator `?.` is available for safely accessing fields that might not exist. For example, `app.status?.operationState.phase` will not throw an error if `operationState` is nil because no operation has been initiated yet.

You can bundle multiple conditions into a single trigger with different templates for each outcome:

```yaml
data:
  trigger.on-sync-status: |
    - when: app.status.operationState.phase in ['Succeeded']
      send: [app-sync-succeeded]
    - when: app.status.operationState.phase in ['Error', 'Failed']
      send: [app-sync-failed]
```

### Preventing Notification Floods

Without rate limiting, a flapping application can generate dozens of notifications per hour. The `oncePer` field solves this by deduplicating notifications based on a key you define. The trigger only fires again when the key value changes:

```yaml
data:
  trigger.on-deployed: |
    - when: app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'
      oncePer: app.status.sync.revision
      send: [app-deployed]
```

This fires once per Git revision. Even if the application reconciles multiple times at the same revision, you only get one notification. For monorepo setups, use `app.status?.operationState.syncResult.revision` instead, which tracks the revision at the per-application level.

### Time-Based Conditions

Triggers support time functions, which lets you alert on operations that are running longer than expected:

```yaml
data:
  trigger.on-sync-running-long: |
    - when: app.status.operationState.phase == 'Running' and time.Now().Sub(time.Parse(app.status.operationState.startedAt)).Minutes() >= 10
      send: [sync-running-long]
```

This fires when a sync operation has been running for more than ten minutes, which is a strong signal that something is stuck.

## Writing Templates

Templates define the content of each notification. They use Go's `text/template` syntax and have access to the Application object, a user-defined context map, secrets, and a set of built-in functions.

A basic template looks like this:

{% raw %}
```yaml
data:
  template.app-sync-succeeded: |
    message: |
      Application {{.app.metadata.name}} has been successfully synced.
      Sync status: {{.app.status.sync.status}}
      Health: {{.app.status.health.status}}
      Revision: {{.app.status.sync.revision}}
```
{% endraw %}

The `message` field is the default notification body and works across all services. But most services support additional formatting. For Slack, you can add rich attachments with color-coded status indicators:

{% raw %}
```yaml
data:
  template.app-sync-succeeded: |
    message: |
      Application {{.app.metadata.name}} synced successfully.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#18be52",
          "fields": [
            {"title": "Sync Status", "value": "{{.app.status.sync.status}}", "short": true},
            {"title": "Health", "value": "{{.app.status.health.status}}", "short": true},
            {"title": "Revision", "value": "{{.app.status.sync.revision}}", "short": true}
          ]
        }]
```
{% endraw %}

The `context` map lets you define shared variables that all templates can reference. Setting the Argo CD URL once in context means you do not have to hardcode it in every template:

```yaml
data:
  context: |
    argocdUrl: https://argocd.example.com
```

### Slack-Specific Features

Slack templates support several features beyond basic attachments. The `groupingKey` field threads related notifications together, so multiple updates for the same deployment appear in a single thread rather than flooding the channel:

{% raw %}
```yaml
data:
  template.app-sync-status: |
    message: |
      Sync {{.app.status.operationState.phase}}: {{.app.metadata.name}}
    slack:
      groupingKey: "{{.app.metadata.name}}-{{.app.status.sync.revision}}"
      notifyBroadcast: true
```
{% endraw %}

Setting `notifyBroadcast: true` posts a notification to the channel even though the message goes into a thread, so people who are not watching the thread still see the alert. The `deliveryPolicy` field controls whether the notification creates a new message, updates an existing one, or does both. `PostAndUpdate` is useful when you want a single message that reflects the current state rather than a stream of individual updates.

## Subscribing Applications

With services, triggers, and templates configured, the last step is subscribing applications to specific triggers. This is done through annotations on the Application resource:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  annotations:
    notifications.argoproj.io/subscribe.on-sync-succeeded.slack: deployments
    notifications.argoproj.io/subscribe.on-sync-failed.slack: deployments
    notifications.argoproj.io/subscribe.on-health-degraded.slack: alerts
```

Each annotation follows the pattern `notifications.argoproj.io/subscribe.<trigger>.<service>: <recipient>`. The recipient is service-specific. For Slack it is a channel name, for email it is an address, and for webhooks it is left empty since the destination is defined in the service configuration.

If you want to subscribe an application to multiple triggers and destinations in a more compact format:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscriptions: |
      - trigger: [on-sync-succeeded, on-sync-failed, on-health-degraded]
        destinations:
          - service: slack
            recipients: [deployments, alerts]
          - service: slack
            recipients: [on-call]
```

### Default Subscriptions

Annotating every application individually does not scale well. Argo CD Notifications supports default subscriptions in the ConfigMap that apply to all applications automatically, so you do not need to add annotations one at a time.

The `subscriptions` field in `argocd-notifications-cm` defines global subscriptions with recipients, triggers, and an optional label selector:

```yaml
data:
  subscriptions: |
    - recipients:
        - slack:deployments
        - slack:alerts
      triggers:
        - on-sync-failed
        - on-health-degraded
    - recipients:
        - slack:production-alerts
      selector: env=production
      triggers:
        - on-sync-failed
        - on-health-degraded
        - on-sync-succeeded
```

The first subscription applies to every application and sends sync failures and health degradation alerts to two Slack channels. The second uses a `selector` to match only applications with the label `env=production`, adding success notifications and routing to a dedicated production channel. The selector uses the same label matching syntax as Kubernetes, so you can target subscriptions based on team, environment, criticality, or any other label your applications carry.

Recipients follow the `<service>:<recipient>` format. For webhooks where there is no meaningful recipient, use the webhook name directly, like `my-webhook`.

There is also a simpler `defaultTriggers` field if you just want to set which triggers fire by default and let individual applications choose their own recipients through annotations:

```yaml
data:
  defaultTriggers: |
    - on-sync-failed
    - on-health-degraded
```

With `defaultTriggers` set, applications opt in with a shorter annotation that omits the trigger name:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.slack: deployments
```

The two approaches work well together. Use `subscriptions` for organization-wide baselines that should apply everywhere, and `defaultTriggers` combined with per-application annotations for teams that want to choose their own channels while inheriting a standard set of triggers.

## Webhook Notifications

Webhooks are the escape hatch for anything that Argo CD does not have a native integration for. You define a URL, optional headers and authentication, and a template that generates the request body.

A practical example is updating GitHub commit status so your repository reflects the deployment state:

{% raw %}
```yaml
data:
  service.webhook.github: |
    url: https://api.github.com
    headers:
      - name: Authorization
        value: token $github-token
      - name: Content-Type
        value: application/json

  template.github-commit-status: |
    webhook:
      github:
        method: POST
        path: /repos/{{call .repo.FullNameByRepoURL .app.spec.source.repoURL}}/statuses/{{.app.status.operationState.operation.sync.revision}}
        body: |
          {
            "state": "{{if eq .app.status.operationState.phase "Succeeded"}}success{{else}}failure{{end}}",
            "target_url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
            "description": "Argo CD sync {{.app.status.operationState.phase}}",
            "context": "argocd/{{.app.metadata.name}}"
          }

  trigger.on-sync-complete: |
    - when: app.status.operationState.phase in ['Succeeded']
      send: [github-commit-status]
    - when: app.status.operationState.phase in ['Error', 'Failed']
      send: [github-commit-status]
```
{% endraw %}

The `path` field supports templates, which is how you construct the GitHub API URL dynamically using the repository and commit from the Application. The built-in `repo.FullNameByRepoURL` function converts a Git URL into the `owner/repo` format that GitHub expects.

Webhook services also support retry configuration with `retryMax`, `retryWaitMin`, and `retryWaitMax` fields, and you can skip TLS verification with `insecureSkipVerify` for internal services running self-signed certificates.

## PagerDuty Integration

For production alerting, PagerDuty integration routes critical notifications directly into your incident management workflow:

{% raw %}
```yaml
data:
  service.pagerduty: |
    token: $pagerduty-token
    from: argocd@example.com

  template.pagerduty-alert: |
    message: |
      Application {{.app.metadata.name}} has degraded health.
    pagerduty:
      routingKey: $pagerduty-routing-key
      severity: critical
      summary: "{{.app.metadata.name}} health is {{.app.status.health.status}}"
      source: "argocd"
      component: "{{.app.metadata.name}}"
```
{% endraw %}

Wire this to a health degradation trigger and your on-call team gets paged automatically when an application's health drops, with a link back to the Argo CD dashboard for investigation.

## Multi-Namespace Configuration

In larger organizations, a single centralized notification configuration does not always make sense. Different teams own different applications and want to manage their own notification rules. Argo CD supports namespace-scoped notification configuration, where teams deploy their own `argocd-notifications-cm` and `argocd-notifications-secret` in the namespace where their Argo CD applications live.

This is particularly useful alongside [ApplicationSets](/blog/argo-cd-applicationsets/). When an ApplicationSet generates applications across multiple namespaces, each team can configure their own Slack channels, webhook endpoints, and trigger thresholds without needing access to the central Argo CD configuration.

## A Complete Working Configuration

Here is a full ConfigMap that ties together everything we have covered. It configures Slack as the primary service with three triggers for the most common scenarios, and includes a webhook for GitHub commit status updates:

{% raw %}
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  context: |
    argocdUrl: https://argocd.example.com

  service.slack: |
    token: $slack-token

  service.webhook.github: |
    url: https://api.github.com
    headers:
      - name: Authorization
        value: token $github-token

  trigger.on-sync-succeeded: |
    - when: app.status.operationState.phase in ['Succeeded']
      oncePer: app.status.sync.revision
      send: [sync-succeeded, github-status-success]

  trigger.on-sync-failed: |
    - when: app.status.operationState.phase in ['Error', 'Failed']
      send: [sync-failed, github-status-failure]

  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      send: [health-degraded]

  template.sync-succeeded: |
    message: |
      {{.app.metadata.name}} synced successfully.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#18be52",
          "fields": [
            {"title": "Health", "value": "{{.app.status.health.status}}", "short": true},
            {"title": "Revision", "value": "{{.app.status.sync.revision | truncate 7 }}", "short": true}
          ]
        }]

  template.sync-failed: |
    message: |
      {{.app.metadata.name}} sync failed.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#e53935",
          "fields": [
            {"title": "Phase", "value": "{{.app.status.operationState.phase}}", "short": true},
            {"title": "Message", "value": "{{.app.status.operationState.message}}", "short": false}
          ]
        }]

  template.health-degraded: |
    message: |
      {{.app.metadata.name}} health has degraded to {{.app.status.health.status}}.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#ff9800",
          "fields": [
            {"title": "Health", "value": "{{.app.status.health.status}}", "short": true},
            {"title": "Sync", "value": "{{.app.status.sync.status}}", "short": true}
          ]
        }]

  template.github-status-success: |
    webhook:
      github:
        method: POST
        path: /repos/{{call .repo.FullNameByRepoURL .app.spec.source.repoURL}}/statuses/{{.app.status.operationState.operation.sync.revision}}
        body: |
          {"state": "success", "target_url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}", "context": "argocd/{{.app.metadata.name}}"}

  template.github-status-failure: |
    webhook:
      github:
        method: POST
        path: /repos/{{call .repo.FullNameByRepoURL .app.spec.source.repoURL}}/statuses/{{.app.status.operationState.operation.sync.revision}}
        body: |
          {"state": "failure", "target_url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}", "context": "argocd/{{.app.metadata.name}}"}

  defaultTriggers: |
    - on-sync-succeeded
    - on-sync-failed
    - on-health-degraded
```
{% endraw %}

With this in place, subscribing an application is a single annotation:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.slack: deployments
    notifications.argoproj.io/subscribe.github: ""
```

## Practical Tips

A few things worth knowing before you roll this out.

**Test with `argocd-notifications` CLI.** The `argocd admin notifications` command lets you test triggers and templates locally against live application data without actually sending notifications. Run `argocd admin notifications template notify <template> <app>` to see what a rendered notification looks like before you commit the configuration.

**Start with failures, not successes.** It is tempting to set up notifications for every state change, but in practice the high-value alerts are sync failures and health degradation. Success notifications are useful for visibility but can create noise if you are deploying frequently. Use `oncePer` aggressively on success triggers.

**Use `groupingKey` for Slack.** Without grouping, a busy cluster generates a wall of messages in your Slack channel. Group by application name or revision to keep threads organized and your channels readable.

**Watch for missing fields.** Use the `?.` operator liberally in trigger conditions. Not every Application has an `operationState` (no operation has been initiated yet) or a `health.status` (resources have not been evaluated yet). A trigger that accesses a nil field will log an error and stop evaluating.

**Set the timezone.** Timestamps in notifications default to UTC. If your team works in a specific timezone, set the `TZ` environment variable on the notifications controller:

```yaml
env:
  - name: TZ
    value: America/New_York
```

## Wrapping Up

Argo CD Notifications turns your GitOps pipeline from a silent automation into an observable system that keeps your team informed. Sync failures, health changes, and stuck operations all surface in the channels where your team already works, whether that is Slack, PagerDuty, email, or a custom webhook. The entire configuration is declarative, lives in Git, and follows the same annotation-based pattern that the rest of Argo CD uses.

Combined with [Argo CD](/blog/argo-cd/) for delivery, [Kargo](/blog/kargo/) for promotion, [Argo Rollouts](/blog/argo-rollouts/) for progressive delivery, and [External Secrets Operator](/blog/external-secrets-operator/) for credential management, notifications complete the observability layer of your GitOps stack. Your pipeline deploys, your pipeline reports, and you only step in when something actually needs attention.

If you need help configuring Argo CD Notifications, designing alert strategies, or integrating deployment alerts into your incident management workflow, [get in touch](/contact).
