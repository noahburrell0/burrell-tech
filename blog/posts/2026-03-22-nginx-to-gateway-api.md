---
title: "Migrating from NGINX Ingress to Envoy Gateway: A Practical Guide"
date: 2026-03-22
description: "A detailed walkthrough of migrating 16+ services from NGINX Ingress Controller to Envoy Gateway using the Kubernetes Gateway API. Covers HTTPRoute patterns, SecurityPolicy, BackendTrafficPolicy, TLS backends, custom error pages, and the real-world problems you will hit along the way."
image: /blog/images/gateway-api-migration-hero.svg
ogBackground: dark
tags:
  - kubernetes
  - gateway-api
  - envoy
  - gitops
  - networking
---

<div class="blog-hero">
  <img src="/blog/images/gateway-api-migration-hero.svg" alt="NGINX Ingress to Gateway API migration" width="500" style="display: inline-block;">
</div>

The Kubernetes Gateway API has been GA since 2023, and the ecosystem around it has matured enough that running it in production is no longer an early-adopter move. I recently migrated my homelab cluster from NGINX Ingress Controller to Envoy Gateway, covering 16+ services across four ArgoCD projects. This post walks through what the migration actually looked like with topics spanning the resource patterns that replace NGINX annotations, the problems I hit, and what I would do differently in a production environment.

The cluster runs Talos Linux managed via Omni, with ArgoCD handling GitOps reconciliation, Longhorn for distributed storage, MetalLB for load balancing, cert-manager for TLS, and external-dns for Cloudflare DNS management. The entire cluster configuration is public in [my GitOps repository](https://github.com/noahburrell0/k8s/tree/4a388132e508527326479bd18f4146c5c1347142/), so every resource referenced in this post has a full working example you can browse. If your stack looks anything like this, most of what follows should loosely translate.

## Why Move Off NGINX Ingress

The most pressing reason is that the project is being retired. In November 2025, Kubernetes SIG Network and the Security Response Committee [announced the retirement of ingress-nginx](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/). Maintenance halts completely in March 2026, after which there will be no further releases, no bugfixes, and no security patches. Existing deployments will keep running, but you are on your own when the next CVE drops. The recommended migration path is the Gateway API.

Beyond the retirement, the operational reasons to move were already stacking up. Every behavior you want to control with NGINX Ingress is an annotation on the Ingress resource. SSL redirects, IP whitelisting, CORS, timeouts, proxy body size, backend protocols, custom headers. A complex service might have ten or more annotations, all unvalidated strings in the `nginx.ingress.kubernetes.io/*` namespace. There is no schema telling you that you typo'd `whitelist-source-rnage` until the traffic policy silently does not apply. Security policy, traffic management, and routing are all co-mingled on a single resource, which makes it hard to manage them independently or reuse policies across services.

The Gateway API fixes this by separating concerns into distinct resource types. Routing lives in HTTPRoute. Security lives in SecurityPolicy. Traffic management lives in BackendTrafficPolicy and ClientTrafficPolicy. TLS termination lives on the Gateway itself. Each resource has a typed CRD with schema validation, and policies attach to routes by reference rather than being embedded in annotations. It is more verbose, but it is explicit and composable in ways that annotations never were.

## The Foundation: A Shared Gateway

The core of the new architecture is a single shared Gateway resource with two listeners (HTTP and HTTPS), backed by an EnvoyProxy configuration that merges multiple Gateways into a single Envoy deployment:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: envoy-proxy-config
spec:
  mergeGateways: true
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        annotations:
          metallb.io/loadBalancerIPs: "172.19.0.254"

---

apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: envoy-proxy-config
    namespace: envoy-gateway-system

---

apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: envoy
spec:
  gatewayClassName: envoy
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: All
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: envoy-wildcard-tls
      allowedRoutes:
        namespaces:
          from: All
```

A few design decisions here worth calling out. A single wildcard certificate from cert-manager covers `burrell.tech`, `*.burrell.tech`, `*.home.burrell.tech`, `*.k8s.burrell.tech`, and `*.hass.burrell.tech`. This eliminated per-service TLS configuration entirely. And `allowedRoutes.namespaces.from: All` lets HTTPRoutes in any namespace attach to this Gateway, so each application can live in its own namespace while sharing the gateway infrastructure.

The `mergeGateways: true` setting is an Envoy Gateway-specific feature that lets multiple Gateway resources across namespaces share a single underlying Envoy deployment and LoadBalancer IP. Without it, each Gateway provisions its own LoadBalancer, which eats MetalLB IPs and adds operational overhead. This is useful to have because I have multiple Gateways living across the cluster, but my home internet package only has 1 IP address. As a result, I can only forward ports 80 and 443 to one Gateway IP address. Sure, I could have put a reverse proxy in front of the Gateways, but who needs that extra overhead?

## Mapping NGINX Annotations to Gateway API Resources

Before diving into the patterns, here is the translation table. Every NGINX annotation I was using maps to a specific Gateway API resource type:

| NGINX Function | Gateway API Equivalent | Example |
|---|---|---|
| `force-ssl-redirect` / `ssl-redirect` (Annotation) | Separate HTTPRoute on `sectionName: http` with `RequestRedirect` filter | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/internal/bazarr/configs/gateway.yaml#L23-L39) |
| `whitelist-source-range` (Annotation) | `SecurityPolicy` with `authorization.rules[].principal.clientCIDRs` | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/internal/bazarr/configs/gateway.yaml#L43-L60) |
| `enable-cors` / `cors-allow-*` (Annotation) | `SecurityPolicy` with `cors` block | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/external/contact-api/deploy.yaml#L99-L116) |
| `proxy-read-timeout` / `proxy-send-timeout` (Annotation) | `BackendTrafficPolicy` with `timeout.http` | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/external/seafile/configs/gateway.yaml#L54-L68) |
| `proxy-body-size` (Annotation) | Not needed (Envoy has no default body size limit) | N/A |
| `custom-http-errors` (Annotation) | `BackendTrafficPolicy` with `responseOverride` | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/external/main-site/manifests/gateway.yaml#L48-L279) |
| `backend-protocol: "HTTPS"` (Annotation) | `Backend` CRD with TLS configuration | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/setup/argocd/overlay/argocd-gateway.yaml#L1-L61) |
| `permanent-redirect` (Annotation) | HTTPRoute `rules[].filters` with `RequestRedirect` | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/external/seafile/configs/gateway.yaml#L1-L30) |
| `X-Real-IP` (Default NGINX Header) | `ClientTrafficPolicy` with `headers.earlyRequestHeaders` | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/setup/envoy-gateway/gateway.yaml#L42-L55) |
| Path-Based Routing Rules | HTTPRoute `rules[].matches[].path` | [Link](https://github.com/noahburrell0/k8s/blob/4a388132e508527326479bd18f4146c5c1347142/configs/external/harbor/configs/gateway.yaml#L1-L38) |

## HTTPRoute Patterns

### Basic Routing with HTTP-to-HTTPS Redirect

Every service needs two HTTPRoutes: one for the actual HTTPS routing and one for the HTTP-to-HTTPS redirect. With NGINX this was a single annotation. With Gateway API it is explicit:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: bazarr
spec:
  parentRefs:
    - name: envoy
      namespace: envoy-gateway-system
      sectionName: https
  hostnames:
    - bazarr.home.burrell.tech
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: bazarr
          port: 6767

---

apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: bazarr-redirect
spec:
  parentRefs:
    - name: envoy
      namespace: envoy-gateway-system
      sectionName: http
  hostnames:
    - bazarr.home.burrell.tech
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

The `sectionName` field is critical and I will come back to this in the gotchas section. The main route binds to `sectionName: https` so it only handles TLS traffic. The redirect route binds to `sectionName: http` and issues a 301 to the HTTPS scheme. This pattern was replicated for every service.

### Path-Based Multi-Backend Routing

Harbor required routing different URL paths to different backend services. A single HTTPRoute handles this with multiple rules, and Gateway API evaluates them in specificity order:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: harbor
spec:
  parentRefs:
    - name: envoy
      namespace: envoy-gateway-system
      sectionName: https
  hostnames:
    - registry.burrell.tech
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/
        - path:
            type: PathPrefix
            value: /service/
        - path:
            type: PathPrefix
            value: /v2/
        - path:
            type: PathPrefix
            value: /chartrepo/
        - path:
            type: PathPrefix
            value: /c/
      backendRefs:
        - name: harbor-core
          port: 80
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: harbor-portal
          port: 80
```

The API, registry, and chart paths all route to `harbor-core`, while the catch-all `/` routes to `harbor-portal` for the web UI.

### Path Rewriting and Redirects

Seafile needed a login path redirect to SSO. This is expressed as a route rule with a `RequestRedirect` filter, where the more specific path takes precedence:

```yaml
rules:
  - matches:
      - path:
          type: PathPrefix
          value: /accounts/login/
    filters:
      - type: RequestRedirect
        requestRedirect:
          path:
            type: ReplaceFullPath
            replaceFullPath: /sso/?next=/
          statusCode: 301
  - matches:
      - path:
          type: PathPrefix
          value: /
    backendRefs:
      - name: seafile
        port: 80
```

## Security and Traffic Policies

### IP Whitelisting with SecurityPolicy

The `whitelist-source-range` annotation is replaced with a SecurityPolicy that targets the HTTPRoute by reference:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: bazarr-whitelist
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: bazarr
  authorization:
    defaultAction: Deny
    rules:
      - name: allow-private
        action: Allow
        principal:
          clientCIDRs:
            - 192.168.0.0/16
            - 172.16.0.0/12
```

This was applied to all internal services. A SecurityPolicy can also target multiple HTTPRoutes simultaneously, which I used for MinIO where a single policy covered both the API and console routes:

```yaml
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: minio-api
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: minio-console
```

The key behavioral difference from NGINX is that a SecurityPolicy is its own resource with its own lifecycle. You can manage, version, and reuse policies independently of the routes they protect.

### CORS with SecurityPolicy

The Contact API needed CORS headers to accept POST requests from the main website. With NGINX, this required three annotations: `nginx.ingress.kubernetes.io/enable-cors: "true"` to turn on CORS handling, `nginx.ingress.kubernetes.io/cors-allow-origin` to specify which origins are permitted, and `nginx.ingress.kubernetes.io/cors-allow-methods` to control which HTTP methods are accepted. With Envoy Gateway, all three collapse into a single typed `cors` block on a SecurityPolicy.

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: contact-api-cors
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: contact-api
  cors:
    allowOrigins:
      - "https://burrell.tech"
      - "https://www.burrell.tech"
      - "http://localhost:8080"
    allowMethods:
      - POST
```

### Timeout Configuration with BackendTrafficPolicy

Seafile's large file transfers were hitting Envoy's default timeouts after the migration. A BackendTrafficPolicy resolved this:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: seafile-timeout
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: seafile
  timeout:
    http:
      connectionIdleTimeout: 1800s
      maxConnectionDuration: 1800s
    tcp:
      connectTimeout: 60s
```

The 30-minute timeout was tuned upward from an initial 600 seconds based on real-world sync patterns with the Seafile desktop client.

### Client Header Injection with ClientTrafficPolicy

Several applications, notably Paperless-ngx, required the real client IP. With NGINX this happened implicitly. With Envoy Gateway, a ClientTrafficPolicy applied at the Gateway level injects the header for all routes:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: envoy-client-headers
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: envoy
  headers:
    earlyRequestHeaders:
      set:
        - name: X-Real-IP
          value: "%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT%"
```

## TLS Backend Routing

ArgoCD's server runs with TLS enabled internally, which previously required the `backend-protocol: "HTTPS"` annotation. The Gateway API solution uses the Envoy Gateway Backend CRD:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: argocd-server
spec:
  endpoints:
    - fqdn:
        hostname: argocd-server.argocd.svc.cluster.local
        port: 443
  tls:
    insecureSkipVerify: true
```

The HTTPRoute then references this Backend instead of a Kubernetes Service:

```yaml
backendRefs:
  - group: gateway.envoyproxy.io
    kind: Backend
    name: argocd-server
```

This requires enabling the Backend extension API in the Envoy Gateway Helm values:

```yaml
config:
  envoyGateway:
    extensionApis:
      enableBackend: true
```

## Custom Error Pages

This was the most complex piece of the migration. This website uses `tarampampam/error-pages` for styled error pages. Under NGINX, the `custom-http-errors` annotation intercepted error responses and served the custom page. With Envoy Gateway, the equivalent is `responseOverride` on a BackendTrafficPolicy:

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: main-site-error-pages
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: main-site
  responseOverride:
    - match:
        statusCodes:
          - type: Value
            value: 404
      redirect:
        hostname: errors.k8s.burrell.tech
        path:
          type: ReplaceFullPath
          replaceFullPath: /404.html
        statusCode: 302
```

A dedicated HTTPRoute exposes the error-pages service at `errors.k8s.burrell.tech`, and the `responseOverride` performs an internal redirect when the main backend returns a matching status code. This covers all 20 codes the error-pages service supports.

A couple of things to be aware of. The `responseOverride` with `redirect` type had a critical bug fix in Envoy Gateway v1.7.0, so make sure you are on at least that version. And there is a behavioral difference from NGINX where the internal redirect returns the error page with HTTP 200 (the status from the error-pages service), not the original error code. NGINX preserved the original status code. This is a known limitation of the redirect-based approach in Envoy Gateway's current implementation.

## The Gotchas

Every migration has them. Here are the ones that cost me time.

### sectionName Is Not Optional

This was the most impactful issue. After the initial deployment, HTTP-to-HTTPS redirects failed for most services. Accessing `http://service.example.com` served the application directly over HTTP instead of redirecting.

The root cause: the main HTTPRoutes did not specify a `sectionName` in their `parentRefs`. Without `sectionName`, an HTTPRoute attaches to all listeners on the Gateway, both HTTP and HTTPS. The main route matched on port 80 and port 443, taking precedence over the redirect route on the HTTP listener.

One service appeared to work because its main route used an `Exact` path match. Requests to other paths on port 80 fell through to the redirect route, masking the issue during early testing.

The fix was adding `sectionName: https` to every main HTTPRoute. This had to be applied across all routes. The lesson: when your Gateway has multiple listeners, `sectionName` is not optional. Its omission silently causes routes to bind to all listeners, producing subtle bugs that are hard to diagnose.

### Helm Charts That Derive Config from Ingress

After disabling the NGINX Ingress for Paperless-ngx and deploying the Gateway API HTTPRoute, the application returned HTTP 403 with "CSRF verification failed" on all form submissions. The Paperless Helm chart automatically derived its `PAPERLESS_URL` environment variable from the Ingress host configuration. When the Ingress was removed, the variable was unset, and Paperless could not validate CSRF tokens.

The fix was explicitly setting the environment variable in the Helm values:

```yaml
env:
  PAPERLESS_URL: https://paperless.burrell.tech
```

Check your Helm chart templates for variables derived from Ingress resources before you remove those Ingress resources. The failure mode is not always obviously related to the migration.

### Cloudflare Flexible SSL Creates Redirect Loops

One service was accessible internally but produced `ERR_TOO_MANY_REDIRECTS` from the public internet. The redirect loop came from an interaction between Cloudflare's "Flexible" SSL mode and the HTTP-to-HTTPS redirect. Cloudflare connects to the origin over HTTP, the origin redirects to HTTPS, Cloudflare follows the redirect but connects over HTTP again. Infinite loop.

The fix was ensuring the domain's SSL/TLS mode in Cloudflare was set to "Full (strict)" so Cloudflare connects to the origin over HTTPS.

### Harbor TLS Namespace Mismatch

Harbor's Helm chart generates its own internal NGINX deployment and expects to handle TLS termination. The chart's Gateway API support referenced the wildcard TLS secret, but that secret lived in `envoy-gateway-system` while Harbor was in its own namespace. The solution was disabling TLS in Harbor's Helm values entirely (`expose.tls.enabled: false`) and letting TLS terminate at the Envoy Gateway level, then creating a custom HTTPRoute outside the chart.

### Seafile Timeout Tuning

After migration, the Seafile desktop client reported 504 Gateway Timeout errors on large file operations. Envoy's default connection timeout is far shorter than what Seafile's sync operations require. The BackendTrafficPolicy needed 1800-second timeouts for both HTTP idle and max connection duration. My initial 600-second timeout was not enough, and this took a round of real-world testing to get right.

## What I Would Do Differently in Production

This migration was performed on a homelab with a single operator and no SLA. A production environment would need a different approach.

Run both the ingress and gateway controllers simultaneously. Both can coexist because they watch different resource types. Create HTTPRoutes for each service while keeping the Ingress resources in place, then shift traffic incrementally using DNS weighted routing or load balancer traffic splitting. Start with 5%, monitor, increase. Do not remove Ingress resources until 100% of traffic has been on the Gateway API path with stable metrics for days to weeks.

Lower DNS TTLs before the migration to enable fast rollback. Keep Ingress resources in version control even after HTTPRoutes are deployed. Consider a feature flag in your Helm values that controls whether Ingress or HTTPRoute resources are rendered, allowing instant rollback without deleting anything.

Deploy synthetic monitoring that continuously verifies each endpoint through both the NGINX and Envoy paths during the parallel running period. Envoy exposes rich Prometheus metrics natively, so compare request rates, error rates, and latency distributions between the two paths.

Audit every SecurityPolicy against current security requirements, not just the NGINX annotations. The migration is an opportunity to tighten access controls rather than just replicating what existed before.

## Final State

After the migration, the cluster has zero Ingress resources and no NGINX Ingress Controller. The resource inventory includes multiple Gateways (merged into a single Envoy deployment), roughly 20 main HTTPRoutes with an equal number of redirect HTTPRoutes, 11 SecurityPolicies, 2 BackendTrafficPolicies, 1 ClientTrafficPolicy, and 1 Backend custom resource. Everything is managed through ArgoCD and versioned in Git. You can browse the complete post-migration state in [my GitOps repository](https://github.com/noahburrell0/k8s/tree/4a388132e508527326479bd18f4146c5c1347142/) if you want to see how all of these resources fit together in a real cluster.

For brevity, this post focused on the routing and policy migration. There were also changes to the supporting infrastructure that I did not cover here. cert-manager needed updated Certificate resources to provide TLS secrets in the right namespace and format for the Gateway. external-dns was reconfigured to use the DNSEndpoint CRD source instead of reading from Ingress resources. MetalLB required coordination to assign the correct LoadBalancer IP to the new Envoy service. And k8s-gateway, which handles split-horizon DNS for internal resolution, needed adjustments to work with the new Gateway setup. All of the configuration for these components is in [the repository](https://github.com/noahburrell0/k8s/tree/4a388132e508527326479bd18f4146c5c1347142/) if you want to see how they were adapted.

The separation of concerns is the biggest win. Routing, security, traffic management, and TLS are all independent resources that can be managed by different teams or at different cadences. Schema validation catches configuration errors at apply time rather than silently ignoring them at runtime. And because Gateway API is a vendor-neutral standard, moving to a different implementation in the future (Istio, Cilium, Kong) would mean swapping the GatewayClass and implementation-specific policies, not rewriting every route.

If you are running NGINX Ingress and have been watching the Gateway API from the sidelines, now is a reasonable time to make the move. The spec is stable, the implementations are mature, and the operational model is a meaningful improvement over annotation-driven configuration.

If you are planning a migration like this for your organization, [get in touch](/contact). I work with teams to design and implement all kinds of changes just like this on Kubernetes.
