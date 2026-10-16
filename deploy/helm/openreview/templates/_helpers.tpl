{{- define "openreview.name" -}}{{ .Release.Name }}-openreview{{- end -}}
{{- define "openreview.labels" -}}
app.kubernetes.io/name: openreview
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}
{{- define "openreview.secretName" -}}{{ default (printf "%s-secrets" (include "openreview.name" .)) .Values.secrets.existingSecret }}{{- end -}}
