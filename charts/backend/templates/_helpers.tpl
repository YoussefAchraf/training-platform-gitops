{{/*
Pod template shared by the Deployment (default) and the Argo Rollout (rollout.enabled).
One definition, so the two workload kinds can never drift. The Deployment output must stay
identical to what it was before this helper existed (diff-tested against a saved baseline).
*/}}
{{- define "backend.podTemplate" -}}
metadata:
  labels:
    app.kubernetes.io/name: backend
    app.kubernetes.io/part-of: training-platform
  {{- if .Values.vault.enabled }}
  annotations:
    vault.hashicorp.com/agent-inject: "true"
    vault.hashicorp.com/agent-set-security-context: "false"
    vault.hashicorp.com/role: {{ .Values.vault.role | quote }}
    vault.hashicorp.com/agent-inject-secret-env: {{ .Values.vault.secretPath | quote }}
    vault.hashicorp.com/agent-inject-template-env: |
      {{`{{- with secret "`}}{{ .Values.vault.secretPath }}{{`" -}}`}}
      DATABASE_URL='postgresql://postgres:{{`{{ .Data.data.postgres_password }}`}}@postgres:5432/{{ .Values.postgresDb | default "training_platform" }}'
      REDIS_URL='redis://:{{`{{ .Data.data.redis_password }}`}}@backend-redis:6379'
      JWT_SECRET='{{`{{ .Data.data.jwt_secret }}`}}'
      SMTP_USER='{{`{{ .Data.data.smtp_user }}`}}'
      SMTP_PASS='{{`{{ .Data.data.smtp_password }}`}}'
      VAPID_PRIVATE_KEY='{{`{{ .Data.data.vapid_private_key }}`}}'
      GEMINI_API_KEY='{{`{{ .Data.data.gemini_api_key }}`}}'
      {{`{{- end -}}`}}
  {{- end }}
spec:
  serviceAccountName: backend
  securityContext:
    {{- toYaml .Values.securityContext | nindent 4 }}
  containers:
    - name: backend
      image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      securityContext:
        {{- toYaml .Values.containerSecurityContext | nindent 8 }}
      {{- if .Values.vault.enabled }}
      command:
        - sh
        - -c
        - set -a && source /vault/secrets/env && set +a && exec node_modules/.bin/pm2-runtime ecosystem.config.js
      {{- end }}
      ports:
        - name: http
          containerPort: 4000
      env:
        {{- range $key, $value := .Values.env }}
        - name: {{ $key }}
          value: {{ $value | quote }}
        {{- end }}
        {{- if not .Values.vault.enabled }}
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: {{ .Values.secrets.existingSecretName }}
              key: DATABASE_URL
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: {{ .Values.secrets.existingSecretName }}
              key: REDIS_URL
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: {{ .Values.secrets.existingSecretName }}
              key: JWT_SECRET
        - name: SMTP_USER
          valueFrom:
            secretKeyRef:
              name: {{ .Values.secrets.existingSecretName }}
              key: SMTP_USER
        - name: SMTP_PASS
          valueFrom:
            secretKeyRef:
              name: {{ .Values.secrets.existingSecretName }}
              key: SMTP_PASS
        - name: VAPID_PRIVATE_KEY
          valueFrom:
            secretKeyRef:
              name: {{ .Values.secrets.existingSecretName }}
              key: VAPID_PRIVATE_KEY
        - name: GEMINI_API_KEY
          valueFrom:
            secretKeyRef:
              name: {{ .Values.secrets.existingSecretName }}
              key: GEMINI_API_KEY
              optional: true
        {{- end }}
      volumeMounts:
        - name: attachments
          mountPath: /app/storage
      livenessProbe:
        httpGet:
          path: /health
          port: http
        initialDelaySeconds: 10
        periodSeconds: 15
      readinessProbe:
        httpGet:
          path: /health
          port: http
        initialDelaySeconds: 5
        periodSeconds: 10
      resources:
        {{- toYaml .Values.resources | nindent 8 }}
  volumes:
    - name: attachments
      persistentVolumeClaim:
        claimName: backend-attachments
{{- end }}
