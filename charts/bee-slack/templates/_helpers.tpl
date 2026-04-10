{{- define "bee-slack.name" -}}
{{- required "agent.name is required" .Values.agent.name -}}
{{- end -}}

{{- define "bee-slack.containerName" -}}
{{- default (include "bee-slack.name" .) .Values.container.name -}}
{{- end -}}

{{- define "bee-slack.configSecretName" -}}
{{- if .Values.config.existingSecretName -}}
{{- .Values.config.existingSecretName -}}
{{- else if .Values.config.create -}}
{{- default (printf "%s-config" (include "bee-slack.name" .)) .Values.config.secretName -}}
{{- else -}}
{{- required "Either config.existingSecretName must be set or config.create must be true" "" -}}
{{- end -}}
{{- end -}}

{{- define "bee-slack.configFilePath" -}}
{{- printf "%s/%s" .Values.config.mountPath .Values.config.fileName -}}
{{- end -}}
