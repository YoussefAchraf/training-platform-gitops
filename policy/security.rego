package main

import rego.v1

is_workload if input.kind == "Deployment"

is_workload if input.kind == "StatefulSet"

containers contains c if {
	is_workload
	some c in input.spec.template.spec.containers
}

deny contains msg if {
	is_workload
	sc := input.spec.template.spec.securityContext
	sc.runAsUser
	msg := sprintf("%s/%s: pod securityContext sets a fixed runAsUser (%v) — breaks OKD's restricted-v2 arbitrary-UID SCC, see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name, sc.runAsUser])
}

deny contains msg if {
	is_workload
	sc := input.spec.template.spec.securityContext
	sc.fsGroup
	msg := sprintf("%s/%s: pod securityContext sets a fixed fsGroup (%v) — breaks OKD's restricted-v2 SCC exactly like a fixed runAsUser does, see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name, sc.fsGroup])
}

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

deny contains msg if {
	some c in containers
	c.securityContext.allowPrivilegeEscalation != false
	msg := sprintf("%s/%s: container %q does not set securityContext.allowPrivilegeEscalation: false", [input.kind, input.metadata.name, c.name])
}

deny contains msg if {
	is_workload
	some vol in input.spec.template.spec.volumes
	vol.emptyDir
	not endswith(vol.name, "-cache")
	msg := sprintf("%s/%s: volume %q uses emptyDir — this repo uses PVCs for anything stateful, see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name, vol.name])
}

deny contains msg if {
	input.kind == "Ingress"
	msg := sprintf("%s/%s: this repo uses OpenShift Route objects, not Ingress — see ARCHITECTURE-PLAN.md §4", [input.kind, input.metadata.name])
}

deny contains msg if {
	input.kind == "Service"
	input.spec.type == "LoadBalancer"
	msg := sprintf("Service/%s: type LoadBalancer bypasses OKD's Route layer — see ARCHITECTURE-PLAN.md §4", [input.metadata.name])
}

deny contains msg if {
	input.kind == "Route"
	not input.spec.tls
	msg := sprintf("Route/%s: no tls block — every externally-reached Route in this repo terminates TLS (edge), see ARCHITECTURE-PLAN.md §4", [input.metadata.name])
}
