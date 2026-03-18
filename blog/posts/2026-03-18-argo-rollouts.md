---
title: "Argo Rollouts: Progressive Delivery for Kubernetes"
date: 2026-03-18
description: "A deep dive into Argo Rollouts, the Kubernetes-native progressive delivery controller. Learn how to implement canary deployments, blue-green releases, and automated analysis to safely roll out changes with minimal risk."
image: /blog/images/argo-rollouts-hero.svg
tags:
  - kubernetes
  - argo-cd
  - argo-rollouts
  - gitops
  - progressive-delivery
---

<div class="blog-hero">
  <img src="/blog/images/argo-rollouts-hero.svg" alt="Argo Rollouts progressive delivery" width="249" style="display: inline-block;">
</div>

If you have been following my previous posts on [Argo CD](/blog/argo-cd/) and [Kargo](/blog/kargo/), you have a solid foundation for GitOps on Kubernetes. Argo CD ensures your clusters match what is defined in Git, and Kargo orchestrates how changes move between environments. But there is a gap neither of them fills: what happens during a deployment inside a single environment? When a new version of your application is ready, do you flip all traffic at once and hope for the best?

This is the problem Argo Rollouts solves. It is a Kubernetes controller that replaces the standard Deployment resource with a Rollout resource, giving you canary deployments, blue-green releases, and automated analysis driven by real-time metrics. Instead of deploying a new version to 100% of traffic immediately, you can gradually shift traffic, run automated checks against your monitoring stack, and let the system decide whether to promote or roll back.

## Why Standard Deployments Fall Short

The built-in Kubernetes Deployment controller supports rolling updates, and for many workloads that is sufficient. It creates new pods, waits for them to pass readiness checks, and terminates old pods. The problem is that a rolling update treats readiness as a binary signal. A pod is either ready or it is not. There is no concept of gradually increasing traffic, no integration with your metrics platform, and no automated rollback based on error rates or latency.

In practice, this means a bad release can propagate across your entire replica set before anyone notices the impact. By the time your alerting fires, every pod is running the broken version. You are now debugging under pressure, racing to roll back manually or push a fix.

Progressive delivery flips this model. Instead of deploying first and monitoring second, you deploy incrementally and let metrics guide the process. If the new version degrades your success rate or increases latency beyond acceptable thresholds, the rollout is aborted automatically before it reaches the majority of your traffic.

## Installing Argo Rollouts

Argo Rollouts runs alongside your existing Kubernetes setup. It does not replace Argo CD or any other component in your stack. Install it with a single manifest:

```bash
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
```

You will also want the kubectl plugin for managing rollouts from the command line:

```bash
# Using curl (replace with your OS/arch)
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64

chmod +x kubectl-argo-rollouts-linux-amd64
sudo mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts
```

The plugin adds commands like `kubectl argo rollouts get rollout`, `promote`, and `abort` that you will use regularly. There is also a built-in dashboard you can launch with `kubectl argo rollouts dashboard` that provides a visual view of your rollouts in progress.

## The Rollout Resource

The Rollout resource is the core of Argo Rollouts. It is intentionally similar to a Kubernetes Deployment so that migration is straightforward. In most cases, you can take an existing Deployment, change the `apiVersion` and `kind`, and add a `strategy` section.

Here is the Rollout from the [official getting started guide](https://github.com/argoproj/argo-rollouts/tree/master/docs/getting-started/basic), which you can apply directly to a cluster with Argo Rollouts installed:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: rollouts-demo
spec:
  replicas: 5
  strategy:
    canary:
      steps:
      - setWeight: 20
      - pause: {}
      - setWeight: 40
      - pause: {duration: 10}
      - setWeight: 60
      - pause: {duration: 10}
      - setWeight: 80
      - pause: {duration: 10}
  revisionHistoryLimit: 2
  selector:
    matchLabels:
      app: rollouts-demo
  template:
    metadata:
      labels:
        app: rollouts-demo
    spec:
      containers:
      - name: rollouts-demo
        image: argoproj/rollouts-demo:blue
        ports:
        - name: http
          containerPort: 8080
          protocol: TCP
        resources:
          requests:
            memory: 32Mi
            cpu: 5m
```

You will also need a Service to front the pods:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: rollouts-demo
spec:
  ports:
  - port: 80
    targetPort: http
    protocol: TCP
    name: http
  selector:
    app: rollouts-demo
```

Apply both manifests, then trigger a rollout by updating the image tag to a different color variant (the demo app ships `blue`, `green`, `orange`, `purple`, and `yellow`):

```bash
kubectl argo rollouts set image rollouts-demo rollouts-demo=argoproj/rollouts-demo:green
```

The controller creates a new ReplicaSet and begins stepping through the canary process. It sends 20% of traffic to the new version and then pauses indefinitely, waiting for you to promote. Run `kubectl argo rollouts promote rollouts-demo` to advance to the next steps, which ramp through 40%, 60%, and 80% with ten-second pauses between each. At any point you can abort the rollout with `kubectl argo rollouts abort rollouts-demo`, and the controller scales down the canary ReplicaSet and routes all traffic back to the stable version.

## Canary Deployments in Detail

The canary strategy gives you fine-grained control over how traffic shifts from the stable version to the canary. The `steps` field accepts several step types that you can combine in any order.

**setWeight** controls the percentage of traffic routed to the canary. Without a traffic management integration (more on that below), Argo Rollouts approximates traffic splitting by adjusting the ratio of canary to stable pods. With a traffic management integration like Istio or NGINX, the weight maps directly to the traffic routing configuration, which gives you precise control independent of replica count.

**pause** halts the rollout for a specified duration, or indefinitely if no duration is set. An indefinite pause requires manual promotion using `kubectl argo rollouts promote my-app`, which is useful when you want a human to verify the canary before continuing.

**setCanaryScale** lets you decouple replica count from traffic weight. This is helpful when you want to scale up canary pods for load testing without actually routing production traffic to them, or when you want to run the canary at full replica count while still only sending a small percentage of traffic.

A more realistic canary configuration might look like this:

```yaml
strategy:
  canary:
    canaryService: my-app-canary
    stableService: my-app-stable
    trafficRouting:
      nginx:
        stableIngress: my-app-ingress
    steps:
      - setWeight: 5
      - pause: { duration: 2m }
      - setWeight: 20
      - pause: { duration: 5m }
      - setWeight: 50
      - pause: { duration: 5m }
      - setWeight: 80
      - pause: { duration: 5m }
```

This configuration uses NGINX for traffic routing, which means the weight percentages are enforced at the ingress level rather than through pod ratios. The `canaryService` and `stableService` fields reference Kubernetes Services that the controller manages, routing traffic to the appropriate ReplicaSet.

## Blue-Green Deployments

If you prefer a full cutover approach with a preview period, the blue-green strategy is the right choice. Instead of gradually shifting traffic, blue-green maintains two complete environments. The new version is deployed and exposed through a preview Service for testing, and when you are satisfied, the controller switches the active Service to point at the new version.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app
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
        - name: my-app
          image: my-org/my-app:1.0.0
          ports:
            - containerPort: 8080
  strategy:
    blueGreen:
      activeService: my-app-active
      previewService: my-app-preview
      autoPromotionEnabled: false
      scaleDownDelaySeconds: 30
```

When you update the image, the controller creates a new ReplicaSet and points the preview Service at it. You (or your QA team) can test the new version through the preview Service while production traffic continues flowing to the active Service. When you promote the rollout, the controller switches the active Service to the new ReplicaSet and scales down the old one after the configured delay.

Setting `autoPromotionEnabled: false` requires manual promotion, which is a good default for production. For lower environments, you can set it to `true` or use `autoPromotionSeconds` to automatically promote after a delay.

## Automated Analysis

The feature that makes Argo Rollouts truly powerful is its analysis framework. Instead of relying on a human to watch dashboards during a rollout, you define success and failure criteria as code, and the controller evaluates them automatically.

Analysis is built around three resources: **AnalysisTemplate**, **ClusterAnalysisTemplate**, and **AnalysisRun**. Templates define the metrics to query and the conditions for success or failure. An AnalysisRun is an instantiation of a template that the controller creates during a rollout. ClusterAnalysisTemplates work the same way as AnalysisTemplates but are cluster-scoped, so you can reuse them across namespaces.

Here is an AnalysisTemplate that checks error rate using Prometheus:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate
spec:
  args:
    - name: service-name
  metrics:
    - name: error-rate
      interval: 2m
      count: 5
      successCondition: result[0] < 0.05
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}", status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{service="{{args.service-name}}"}[5m]))
```

This template queries Prometheus every two minutes for the 5xx error rate of a given service. It requires the error rate to be below 5% and tolerates up to two failures before aborting the rollout. The `count: 5` field means it takes five measurements total before declaring the analysis successful.

You wire analysis into your canary strategy in two ways. **Background analysis** runs continuously alongside the rollout steps:

```yaml
strategy:
  canary:
    analysis:
      templates:
        - templateName: error-rate
      args:
        - name: service-name
          value: my-app
    steps:
      - setWeight: 20
      - pause: { duration: 5m }
      - setWeight: 50
      - pause: { duration: 5m }
      - setWeight: 80
      - pause: { duration: 5m }
```

The analysis starts when the rollout begins and runs in the background as the canary progresses through its steps. If the error rate exceeds the threshold at any point, the rollout aborts immediately and traffic shifts back to the stable version.

**Inline analysis** runs at a specific step in the rollout, blocking progression until it completes:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: guestbook
spec:
...
  strategy:
    canary:
      steps:
      - setWeight: 20
      - pause: {duration: 5m}
      - analysis:
          templates:
          - templateName: success-rate
          args:
          - name: service-name
            value: guestbook-svc.default.svc.cluster.local
      - setWeight: 80
      - pause: { duration: 5m }
```

This variant runs the analysis after the canary has been at 20% for five minutes. The rollout will not advance to 80% until the analysis completes successfully. This is useful when you want to gate a major traffic increase on metric validation.

For blue-green deployments, you can use `prePromotionAnalysis` and `postPromotionAnalysis`. Pre-promotion analysis runs while the preview Service is active but before traffic switches. Post-promotion analysis runs after the switch, and if it fails, the controller automatically rolls back by switching the active Service to the previous ReplicaSet.

## Supported Metric Providers

Argo Rollouts integrates with the monitoring tools you are likely already running. Prometheus is the most common, but the controller also supports Datadog, New Relic, CloudWatch, Wavefront, Graphite, InfluxDB, Apache SkyWalking, and generic web-based providers. The web provider is particularly flexible because it lets you query any HTTP endpoint and evaluate the response with success and failure conditions.

You can also use Kubernetes Jobs as analysis providers. This is useful when your validation logic is more complex than a metric query. For example, you might run a Job that executes an integration test suite against the canary endpoint and reports the result.

Multiple metrics can be combined in a single AnalysisTemplate, and all of them must pass for the analysis to succeed. This lets you check error rates, latency percentiles, and resource utilization simultaneously.

## Traffic Management Integrations

By default, Argo Rollouts uses replica scaling to approximate traffic splitting. If your canary weight is set to 20% and you have five replicas, the controller runs one canary pod and four stable pods. This is a reasonable approximation, but it lacks precision and does not work well at low traffic percentages.

For precise traffic control, Argo Rollouts integrates with several ingress controllers and service meshes:

**NGINX Ingress Controller** - The controller creates a shadow Ingress resource with canary annotations that NGINX uses to split traffic. This is the simplest integration if you are already using NGINX.

**Istio** - Argo Rollouts manages VirtualService resources to control traffic splitting. This gives you percentage-based traffic routing, header-based routing for testing specific versions, and the full flexibility of Istio's traffic management capabilities.

**AWS ALB Ingress Controller** - For teams on AWS, the controller manages ALB target group weights to split traffic between stable and canary pods.

**Traefik** - Integration through TraefikService resources for teams using Traefik as their ingress.

**Ambassador/Emissary** - Traffic splitting through Mapping resources.

These integrations mean you get real traffic splitting at the network level, not just pod ratio approximations. A 5% canary weight means exactly 5% of requests go to the canary, regardless of how many replicas are running.

## Integration with Argo CD

Argo Rollouts works seamlessly alongside Argo CD. Since the Rollout resource lives in your Git repository just like any other Kubernetes manifest, Argo CD manages it the same way it manages Deployments, Services, or ConfigMaps. When you push an image tag update to Git, Argo CD syncs the change to the cluster, and Argo Rollouts takes over from there to execute the canary or blue-green strategy.

Argo CD also understands the health status of Rollout resources. A Rollout that is mid-canary shows as "Progressing" in the Argo CD UI, and a Rollout that has been aborted shows as "Degraded." This integration means your GitOps dashboard gives you visibility into progressive delivery status without needing a separate tool.

If you are using [Kargo for promotion pipelines](/blog/kargo/), the integration is equally smooth. Kargo's promotion steps update the image tag in Git, Argo CD syncs the change, and Argo Rollouts handles the progressive delivery within the target environment. Kargo's verification feature can also use Argo Rollouts AnalysisTemplates, tying promotion verification directly to the same metrics you use for rollout analysis.

## Migrating from Deployments

Converting an existing Deployment to a Rollout is straightforward. The spec is nearly identical. Change the `apiVersion` from `apps/v1` to `argoproj.io/v1alpha1`, change the `kind` from `Deployment` to `Rollout`, and add the `strategy` section. The pod template, selector, and replica count all stay the same.

One thing to plan for: the initial migration creates a new ReplicaSet even though the pod spec has not changed. Argo Rollouts provides a workload reference feature that lets a Rollout manage an existing Deployment's ReplicaSets instead, which can make the migration zero-downtime if you need to avoid any pod churn.

For teams that want to start simple, you can create a Rollout with a basic canary strategy that has a single step (`setWeight: 100`) and no analysis. This behaves like a standard rolling update but uses the Rollout controller, giving you the option to add progressive delivery steps later without another migration.

## Getting Started

If you have Argo CD running and want to add progressive delivery, here is the path I recommend:

1. Install Argo Rollouts in your cluster and the kubectl plugin on your workstation.
2. Pick one non-critical service and convert its Deployment to a Rollout with a simple canary strategy (two or three weight steps with pauses).
3. Trigger a rollout by updating the image tag and watch it progress through the steps.
4. Once you are comfortable with the mechanics, add an AnalysisTemplate that queries your monitoring system for error rates or latency.
5. Integrate traffic management with your ingress controller for precise traffic splitting.
6. Expand to more services and refine your analysis criteria based on what you learn.

The [Argo Rollouts documentation](https://argo-rollouts.readthedocs.io/en/stable/) has a getting started guide with a sample application that walks through the basics. The kubectl plugin's dashboard (`kubectl argo rollouts dashboard`) is an excellent way to visualize what is happening during a rollout while you are learning.

## Wrapping Up

Argo Rollouts fills a critical gap in the Kubernetes deployment story. Standard rolling updates give you zero control over traffic distribution and no automated safety net. Argo Rollouts gives you both. Canary deployments let you gradually shift traffic while monitoring real-time metrics. Blue-green deployments give you a full preview environment before cutover. And the analysis framework ties it all together by automating the promote-or-rollback decision based on the data your monitoring stack already collects.

Combined with Argo CD for GitOps delivery and Kargo for environment promotion, Argo Rollouts completes the pipeline from code commit to safe production deployment. If your team is deploying to Kubernetes and not yet using progressive delivery, this is the missing piece.

If you need help implementing Argo Rollouts, designing analysis strategies, or integrating progressive delivery into your existing GitOps workflow, [get in touch](/contact).
