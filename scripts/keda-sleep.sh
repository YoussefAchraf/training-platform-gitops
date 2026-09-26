#!/usr/bin/env bash
# Control the KEDA sleep schedule of the local-OKD training-platform namespace.
#
#   keda-sleep.sh status      each workload: replicas now, and whether the schedule is overridden
#   keda-sleep.sh awake       keep everything awake now (overrides the schedule)
#   keda-sleep.sh schedule    remove the override; the schedule takes over again
#
# The schedule lives in Git (environments/local-okd/keda-schedules-values.yaml);
# this only sets or clears KEDA's autoscaling.keda.sh/paused-replicas annotation
# on the live ScaledObjects. ArgoCD does not revert it, and it does not change Git.
set -euo pipefail

NAMESPACE="${NAMESPACE:-training-platform}"
ANNOTATION="autoscaling.keda.sh/paused-replicas"
CMD="${1:-status}"

if ! command -v oc >/dev/null 2>&1; then echo "oc not found on PATH" >&2; exit 1; fi

names=$(oc get scaledobject -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
if [ -z "$names" ]; then
  echo "No ScaledObjects in namespace '$NAMESPACE'. Is this the local OKD cluster (oc whoami --show-server)?" >&2
  exit 1
fi

case "$CMD" in
  status)
    printf '%-18s %-12s %-9s %s\n' WORKLOAD KIND REPLICAS OVERRIDE
    for n in $names; do
      kind=$(oc get scaledobject "$n" -n "$NAMESPACE" -o jsonpath='{.spec.scaleTargetRef.kind}')
      case "$kind" in
        Deployment) cur=$(oc get deployment "$n" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo '?') ;;
        StatefulSet) cur=$(oc get statefulset "$n" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo '?') ;;
        Rollout) cur=$(oc get rollout "$n" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo '?') ;;
        *) cur='?' ;;
      esac
      ov=$(oc get scaledobject "$n" -n "$NAMESPACE" -o go-template="{{index .metadata.annotations \"$ANNOTATION\"}}" 2>/dev/null || true)
      case "$ov" in ''|'<no value>') ov='none (schedule)' ;; *) ov="awake at $ov" ;; esac
      printf '%-18s %-12s %-9s %s\n' "$n" "$kind" "${cur:-0}" "$ov"
    done
    ;;
  awake)
    for n in $names; do
      r=$(oc get scaledobject "$n" -n "$NAMESPACE" -o jsonpath='{.spec.maxReplicaCount}')
      oc annotate scaledobject "$n" -n "$NAMESPACE" "$ANNOTATION=$r" --overwrite >/dev/null
      echo "$n: kept awake at $r replica(s)"
    done
    echo "Everything stays awake until you run: $0 schedule"
    ;;
  schedule)
    for n in $names; do
      oc annotate scaledobject "$n" -n "$NAMESPACE" "$ANNOTATION-" >/dev/null
      echo "$n: back on the schedule"
    done
    echo "Outside the awake window the workloads scale to zero after the cooldown (5 min)."
    ;;
  *)
    echo "usage: $0 status|awake|schedule" >&2
    exit 2
    ;;
esac
