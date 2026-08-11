package main

import rego.v1

# Enforces, in CI, the OKD-specific rules ARCHITECTURE-PLAN.md §4 already
# documents in prose — so a future template change that violates them fails
# a PR instead of only being caught by a human re-reading that doc. Scoped
# to this repo's own first-party charts (postgres, backend, frontend,
# chatbot) — the vault/monitoring charts just wrap upstream community
# charts whose internals aren't this repo's to enforce policy on.

is_workload if input.kind == "Deployment"

is_workload if input.kind == "StatefulSet"

containers contains c if {
	is_workload
	some c in input.spec.template.spec.containers
}

# --- No fixed non-arbitrary UID: OKD's restricted-v2 SCC assigns a random
# UID per namespace and rejects a pod that insists on a specific one. ---
deny contains msg if {
	is_workload
	sc := input.spec.template.spec.securityContext
	sc.runAsUser
	msg := sprintf("%s/%s: pod securityContext sets a fixed runAsUser (%v) — breaks OKD's restricted-v2 arbitrary-UID SCC, see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name, sc.runAsUser])
}

# --- Same story for fsGroup: restricted-v2 validates it against the
# namespace's allocated supplemental-groups range (e.g.
# 1000650000-1000659999) and rejects any hardcoded value outright — this
# is NOT hypothetical, it broke postgres/chatbot-redis/n8n on a real OKD
# deploy (2026-08-11) even though runAsUser was already correctly left
# unset. Leaving fsGroup unset too lets OKD auto-assign a valid one. ---
deny contains msg if {
	is_workload
	sc := input.spec.template.spec.securityContext
	sc.fsGroup
	msg := sprintf("%s/%s: pod securityContext sets a fixed fsGroup (%v) — breaks OKD's restricted-v2 SCC exactly like a fixed runAsUser does, see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name, sc.fsGroup])
}

# --- Every container must set resources.requests and resources.limits ---
deny contains msg if {
	some c in containers
	not c.resources.requests
	msg := sprintf("%s/%s: container %q has no resources.requests", [input.kind, input.metadata.name, c.name])
}

deny contains msg if {
	some c in containers
	not c.resources.limits
	msg := sprintf("%s/%s: container %q has no resources.limits", [input.kind, input.metadata.name, c.name])
}

# --- No privilege escalation ---
deny contains msg if {
	some c in containers
	c.securityContext.allowPrivilegeEscalation != false
	msg := sprintf("%s/%s: container %q does not set securityContext.allowPrivilegeEscalation: false", [input.kind, input.metadata.name, c.name])
}

# --- No emptyDir — ARCHITECTURE-PLAN.md §4 replaced the old chart's
# emptyDir usage with PVCs specifically so `oc delete pod` doesn't lose
# data; a future template regressing back to emptyDir should fail CI.
# Narrow exception: a volume named "*-cache" is allowed — real finding
# from an actual OKD deploy (n8n's /home/node/.cache is baked into the
# image owned by uid 1000, not group-0 writable, so it EACCES under
# OKD's arbitrary runtime UID; an emptyDir there is the standard fix,
# same trick Vault Agent Injector uses for its own sidecar's $HOME).
# It's build-cache data, not app data — safe to lose on pod restart,
# unlike anything this rule actually exists to protect. ---
deny contains msg if {
	is_workload
	some vol in input.spec.template.spec.volumes
	vol.emptyDir
	not endswith(vol.name, "-cache")
	msg := sprintf("%s/%s: volume %q uses emptyDir — this repo uses PVCs for anything stateful, see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name, vol.name])
}

# --- Routes, not Ingress/LoadBalancer — ARCHITECTURE-PLAN.md §4 ---
deny contains msg if {
	input.kind == "Ingress"
	msg := sprintf("%s/%s: this repo uses OpenShift Route objects, not Ingress — see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name])
}

deny contains msg if {
	input.kind == "Service"
	input.spec.type == "LoadBalancer"
	msg := sprintf("Service/%s: type LoadBalancer bypasses OKD's Route layer — see ARCHITECTURE-PLAN.md §4", [input.metadata.name])
}

# --- Routes must terminate TLS, not serve plaintext ---
deny contains msg if {
	input.kind == "Route"
	not input.spec.tls
	msg := sprintf("Route/%s: no tls block — every externally-reached Route in this repo terminates TLS (edge), see ARCHITECTURE-PLAN.md §4", [input.metadata.name])
}
