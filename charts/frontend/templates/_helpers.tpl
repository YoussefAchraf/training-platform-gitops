{{/*
Pod template shared by the Deployment (default) and the Argo Rollout
(rollout.enabled). One definition, so the two workload kinds can never drift.
Rendered output for the Deployment must stay byte-identical to what it was
before this helper existed; charts are diff-tested against a saved baseline.
*/}}
{{- define "frontend.podTemplate" -}}
metadata:
  labels:
    app.kubernetes.io/name: frontend
    app.kubernetes.io/part-of: training-platform
spec:
  securityContext:
    {{- toYaml .Values.securityContext | nindent 4 }}
  containers:
    - name: frontend
      image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      securityContext:
        {{- toYaml .Values.containerSecurityContext | nindent 8 }}
      ports:
        - name: http
          containerPort: 8080
      env:
        {{- range $key, $value := .Values.env }}
        - name: {{ $key }}
          value: {{ $value | quote }}
        {{- end }}
      livenessProbe:
        httpGet:
          path: /
          port: http
        initialDelaySeconds: 5
        periodSeconds: 15
      readinessProbe:
        httpGet:
          path: /
          port: http
        initialDelaySeconds: 3
        periodSeconds: 10
      {{- if gt (int .Values.gracefulShutdown.preStopSleepSeconds) 0 }}
      lifecycle:
        preStop:
          exec:
            command: ["sleep", {{ .Values.gracefulShutdown.preStopSleepSeconds | quote }}]
      {{- end }}
      resources:
        {{- toYaml .Values.resources | nindent 8 }}
{{- end }}
