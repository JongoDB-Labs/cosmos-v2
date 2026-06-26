{{/*
Common helpers for the cosmos chart. _helpers.tpl is not rendered to manifests;
its {{ define }} blocks are reusable templates included elsewhere with {{ include }}.
*/}}

{{- define "cosmos.fullname" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Full label set — put on metadata.labels of every object. */}}
{{- define "cosmos.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels — the stable subset used in selectors (never include version). */}}
{{- define "cosmos.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
