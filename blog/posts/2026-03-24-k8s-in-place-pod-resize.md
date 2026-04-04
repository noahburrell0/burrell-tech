---
title: "Resize Running Pods Without Restarting Them (Kubernetes v1.35 GA)"
date: 2026-03-24
modified: 2026-04-04
description: "No more restarts just to change CPU or memory limits. In-Place Pod Resize is now GA in Kubernetes v1.35. Here's how it works, including resize policies, VPA integration, and real-world patterns."
image: /blog/images/vpa.svg
ogBackground: dark
tags:
  - kubernetes
  - scaling
  - resource-management
---

<div class="blog-hero">
  <img src="/blog/images/vpa.svg" alt="Kubernetes in-place pod resize" width="300" style="display: inline-block;">
</div>

Since Kubernetes 1.0, CPU and memory requests and limits on a pod have been immutable. If your application needed more memory, the only option was to delete the pod and create a new one with higher resource values. For stateless web servers behind a Deployment, that is fine. For stateful workloads, long-running batch jobs, or latency-sensitive services that cannot tolerate restarts, it has always been a painful limitation.

In-Place Pod Resize changes this. The feature makes CPU and memory requests and limits mutable on running pods, allowing Kubernetes to adjust the underlying cgroup allocations without killing the container. It shipped as alpha in v1.27, graduated to beta in v1.33, and reached General Availability in v1.35 (December 2025). If you are running Kubernetes 1.33 or later, you can start using it today.

## How It Works

The core idea is straightforward: Kubernetes now distinguishes between what you want a pod to have (desired resources) and what it actually has right now (actual resources). Before this feature, those two values were always identical because resources were set at pod creation and never changed. Now they can diverge temporarily while a resize is in progress.

When you update a pod's `spec.containers[*].resources` fields, the kubelet detects the change and attempts to apply the new resource values to the running container's cgroup. If the resize succeeds, the container keeps running with its new resource allocation. If the node does not have enough capacity, the resize is deferred until resources become available.

Three resource states are tracked:

**Desired** is what you specify in the pod spec, the target state you want the container to reach. **Allocated** is what the kubelet has committed to the pod on the node. This may differ from desired if the node is temporarily out of capacity. **Actuated** is what the container runtime has actually applied to the running container. Once a resize completes successfully, all three values converge.

## Resizing a Running Pod

The resize operation uses the pod's `resize` subresource. With kubectl v1.32 or later, you edit the pod with the `--subresource resize` flag:

```bash
kubectl edit pod my-app --subresource resize
```

This opens the pod spec for editing, but only the resource fields are mutable. Change the CPU or memory values, save, and the kubelet will attempt the resize.

You can also patch the pod directly:

```bash
kubectl patch pod my-app --subresource resize --patch '
{
  "spec": {
    "containers": [{
      "name": "app",
      "resources": {
        "requests": {
          "memory": "512Mi",
          "cpu": "500m"
        },
        "limits": {
          "memory": "1Gi",
          "cpu": "1000m"
        }
      }
    }]
  }
}'
```

After submitting the patch, the kubelet picks up the change during its next sync loop. For CPU changes, the cgroup CPU shares and quota are updated immediately and the container continues running without interruption. Memory behaves similarly for increases, with the cgroup memory limit being raised in place.

## Resize Policies

Not every resource change can happen without a container restart. Kubernetes lets you declare resize policies per container that control this behavior:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  containers:
  - name: app
    image: my-org/app:v2.1
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    resizePolicy:
    - resourceName: cpu
      restartPolicy: NotRequired
    - resourceName: memory
      restartPolicy: RestartContainer
```

The `NotRequired` policy tells Kubernetes to apply the change in place without restarting the container. This works well for CPU, where cgroup limits can be adjusted transparently. The `RestartContainer` policy tells Kubernetes to restart the container after applying the new resources. Some applications need this for memory changes because they allocate memory pools at startup and will not use additional memory without reinitializing.

If you do not specify a resize policy, the default is `NotRequired` for both CPU and memory. For most applications, CPU resizes work seamlessly without restarts. Memory resizes without restarts also work for applications that allocate memory dynamically, but applications with fixed memory pools (like JVMs with a fixed heap) may need `RestartContainer` for memory.

## Tracking Resize Status

Two pod conditions tell you what is happening with a resize:

**PodResizePending** means the kubelet has accepted the resize request but cannot apply it yet. The reason field tells you why. `Deferred` means the node is temporarily short on resources and the kubelet will retry when capacity frees up. `Infeasible` means the resize cannot happen on this node at all, perhaps because the requested resources exceed what the node can ever provide.

**PodResizeInProgress** means the kubelet is actively applying the resize. If something goes wrong during the operation, the reason is set to `Error` with details in the condition message.

You can watch these conditions with:

```bash
kubectl get pod my-app -o jsonpath='{.status.conditions}' | jq '.[] | select(.type | startswith("PodResize"))'
```

Once the resize completes, both conditions are removed from the pod's status and `status.containerStatuses[*].resources` reflects the new values.

## Memory Limit Decreases

One of the significant improvements in the GA release is that memory limit decreases are now allowed. During the beta phase, you could only increase memory limits. Decreasing them was blocked because lowering the cgroup memory limit below the container's current memory usage would trigger an OOM kill.

The GA implementation adds a safety check: the kubelet compares the container's current memory usage against the new desired limit before applying the change. If usage is below the new limit, the resize proceeds. If usage is too high, the resize is deferred until usage drops. This check is best-effort, not a guarantee, since memory usage can spike between the check and the cgroup update. In practice, this works well for applications whose memory usage varies over time, but you should be cautious about aggressive memory reductions on workloads with unpredictable allocation patterns.

## Deferred Resize Prioritization

When multiple pods on a node have pending resizes and the node cannot satisfy them all, the kubelet prioritizes based on three criteria in order:

First, **PriorityClass**: pods with higher priority classes get their resizes applied first. Second, **QoS class**: Guaranteed pods take precedence over Burstable, which take precedence over BestEffort. Third, **duration deferred**: among pods with equal priority and QoS, those that have been waiting the longest go first.

This prioritization matters in clusters where nodes are running close to capacity. A resize request for a critical production pod will not be blocked behind resize requests from lower-priority workloads.

## Vertical Pod Autoscaler Integration

The real power of in-place pod resize comes when you combine it with the Vertical Pod Autoscaler (VPA). VPA has historically been limited by the fact that applying its recommendations required restarting pods. With in-place resize, VPA can now adjust resources on running pods transparently.

VPA's `InPlaceOrRecreate` update mode graduated to beta alongside the in-place resize feature. When configured with this mode, VPA first attempts to resize pods in place. If the in-place resize fails (because the node lacks capacity or the resize is infeasible), VPA falls back to the traditional evict-and-recreate approach.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: "InPlaceOrRecreate"
  resourcePolicy:
    containerPolicies:
    - containerName: app
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 2
        memory: 4Gi
      controlledResources:
      - cpu
      - memory
```

With this configuration, VPA monitors your pod's resource usage, calculates optimal resource values, and applies them via in-place resize. The pod keeps running throughout. If you have ever avoided VPA because you could not tolerate the restarts, this is the configuration you have been waiting for.

### CPU Startup Boost

A related VPA enhancement worth knowing about is the CPU Startup Boost pattern. Many applications, particularly JVM-based services, need significantly more CPU during startup for class loading and JIT compilation than they need during steady-state operation. Traditionally, you would either over-provision CPU (wasting resources during steady state) or under-provision it (accepting slow startups).

With in-place resize, VPA can implement a startup boost: request extra CPU when the pod starts, then automatically scale it back down once the application reaches steady state. The pod starts fast without permanently reserving extra CPU capacity on the node.

## Practical Patterns

### Stateful Workloads

Databases and stateful services benefit the most from in-place resize. A PostgreSQL pod that needs more memory during a period of heavy query load can have its limits increased without losing active connections or triggering a failover. The resize happens at the cgroup level while the database process continues serving queries.

### Batch Processing

Long-running batch jobs that encounter unexpectedly large data sets no longer need to be killed and restarted with higher resource limits. You can resize the pod mid-job, let it finish with the additional resources, and then let VPA scale it back down for the next run.

### Game Servers and Session-Based Workloads

Game servers and other session-based applications that cannot tolerate disconnections are a natural fit. As player counts shift, the pod's resources can be adjusted in place. Players stay connected, and the server gets the resources it needs.

### Development and Debugging

When you are debugging a memory issue in a running pod, you can temporarily increase its memory limit to prevent OOM kills while you investigate. Once the issue is resolved, resize back down. No more losing the reproduction state because the pod was killed and restarted.

## Limitations to Keep in Mind

The feature has a few constraints worth knowing about. First, only CPU and memory are resizable. Ephemeral storage, GPU, and other resource types remain immutable. Second, the memory decrease safety check is best-effort. The kubelet checks current usage before applying a decrease, but there is a small window where a concurrent allocation spike could still trigger an OOM kill. Third, pod-level resources (as opposed to container-level) only have alpha support for in-place resize in v1.35, so if you are using the pod-level resource feature gate, resize support is still experimental.

Additionally, resizes are not atomic across containers within a pod. If you resize multiple containers simultaneously, each container's resize is applied independently. One container might succeed while another is deferred due to node capacity. For most workloads this is not an issue, but it is worth being aware of if you have tightly coupled containers that need to be resized in lockstep.

## Getting Started

If you are running Kubernetes 1.35 or later, in-place pod resize is available out of the box with no feature gates to enable. For clusters on 1.33 or 1.34, the feature is beta and enabled by default, but check your cluster configuration to confirm.

Start by identifying workloads where pod restarts are currently painful. Stateful services, long-running batch jobs, and anything with slow startup times are good candidates. Add resize policies to your pod specs, deploy VPA with `InPlaceOrRecreate` mode, and let the system handle resource adjustments automatically.

The combination of in-place resize with VPA closes a gap that has existed since Kubernetes launched. Horizontal scaling with HPA handles load-based scaling by adding or removing pod replicas. Vertical scaling with VPA and in-place resize now handles resource-based scaling by adjusting individual pod allocations without downtime. Together, they give you a complete autoscaling story where pods get the right amount of resources at the right time, without sacrificing availability.

For help designing your cluster's autoscaling strategy or migrating workloads to take advantage of in-place resize, [get in touch](/contact).