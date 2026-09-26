{{/*
"HH:MM" + cron day-of-week  ->  five-field cron expression ("MM HH * * days").
*/}}
{{- define "keda-schedules.cron" -}}
{{- $parts := splitList ":" .time -}}
{{- printf "%d %d * * %s" (atoi (index $parts 1)) (atoi (index $parts 0)) .days -}}
{{- end }}
