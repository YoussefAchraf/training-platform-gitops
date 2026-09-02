#!/usr/bin/env bash
set -e

NAMESPACE=achrafyoussef-ay-dev

SERVER=$(oc whoami --show-server 2>/dev/null || echo "not logged in")
echo "Current oc context: $SERVER"
read -p "Confirm this is the OpenShift Sandbox cluster, not local CRC [y/N]: " CONFIRM
case "$CONFIRM" in
  y|Y) ;;
  *) echo "Aborted."; exit 1 ;;
esac

for s in postgres-credentials backend-credentials chatbot-credentials; do
  if ! oc get secret "$s" -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "Missing secret: $s"
    echo "Create it first - see environments/openshift-sandbox/${s%-credentials}-secrets.example.yaml"
    exit 1
  fi
done

for c in postgres backend frontend chatbot; do
  echo "=== $c ==="
  helm upgrade --install "$c" "charts/$c" \
    -f "environments/openshift-sandbox/$c-values.yaml" \
    --namespace "$NAMESPACE" \
    --wait --timeout 5m
done

echo "Done. Check: oc get pods -n $NAMESPACE"
