# `@jobmatchme/bee-slack`

`bee-slack` is the Slack-facing adapter for the Bee Dance stack.

It accepts inbound Slack events, normalizes them into gateway turns, forwards
them through `@jobmatchme/bee-gate`, and renders the resulting Bee Dance event
stream back into Slack messages and thread updates.

## What this package does

- connects to Slack via Socket Mode
- resolves inbound DMs and app mentions against a route configuration
- downloads Slack file attachments into the gateway blob store
- maps inbound Slack messages into the Bee Gate input model
- renders streamed Bee Dance output back into Slack messages and artifacts

## Design intent

The package is intentionally thin. It owns Slack-specific concerns:

- Slack tokens and Socket Mode lifecycle
- user and channel lookups
- route matching
- posting and updating Slack messages
- uploading artifacts to Slack
- public handoffs from trusted internal frontends into allowlisted Slack threads

It does not own protocol orchestration itself. That responsibility stays in
`@jobmatchme/bee-gate`, which keeps the Slack adapter replaceable and easier to
compare against other frontends.

## Grafana and other authenticated handoffs

The optional handoff HTTP server lets a trusted internal frontend create a
public Slack thread, dispatch the same question to an allowlisted Bee worker,
return the Slack permalink immediately, and read the thread replies. When the
Slack app has no channel-history scope, the endpoint falls back to the
outbound Bee replies observed by this gateway; the permalink remains the
complete shared conversation. The
handoff route fixes both channel and worker server-side. Keep the Service
cluster-internal and restrict ingress to the trusted frontend namespace. POST
requests require Grafana's authenticated `X-Grafana-User` data-proxy header;
the server replaces any browser-supplied actor identity with that value.

```text
GET  /health
GET  /api/handoffs/routes
POST /api/handoffs
GET  /api/handoffs/:routeId/:threadTs/replies
```

## Route-opt-in native streaming

A normal channel mention route can opt into Slack native streaming. The stream
starts in the mention's thread with the header
`Ich bearbeite jetzt deine Anfrage...`, renders transport-neutral Bee action
updates as Slack task cards, and stops with the complete assistant markdown.
Routes without `streaming.enabled: true` retain the existing
`chat.postMessage`/`chat.update` delivery.

```json
{
  "id": "mention-pilot",
  "match": { "channelIds": ["C0123456789"] },
  "streaming": {
    "enabled": true,
    "taskDisplayMode": "timeline"
  },
  "worker": { "subject": "fabee.agent.pi.default" },
  "session": { "strategy": "thread", "prefix": "bee-pilot" }
}
```

`taskDisplayMode` accepts `timeline`, `plan`, or `dense` and defaults to
`timeline`. Streaming is deliberately limited to interactive app mentions;
DMs, scheduled runs, and authenticated handoffs remain on legacy delivery even
if their selected route contains this option. Final markdown is passed through
unchanged up to Slack's 12,000-character limit and visibly truncated above it.
Task titles and details are capped conservatively for Slack chunk limits.

Open stream state is process-local and is not recovered after a pod restart.
Slack API failures are surfaced to Bee Gate, which owns the per-run fallback
from streaming to legacy/degraded delivery. Generated artifacts remain separate
`files.uploadV2` uploads after the final response.

## Local development

For local manual testing, copy `local.config.example.json` to
`local.config.json`, fill in your Slack tokens, and run:

```bash
npm run start:local
```

This starts a local NATS broker via Docker, starts the local fake backend, and
then launches `bee-slack` against that local stack. The local broker defaults to
`max_payload: 8MB` for inline artifact testing; override with
`BEE_LOCAL_NATS_MAX_PAYLOAD` if needed.

## Publishing

The package is intended for public npm publication from GitHub Actions using npm
Trusted Publishing via GitHub OIDC.

Container images are published to GHCR from GitHub Actions on version tags. The
image entrypoint expects a mounted JSON config file and runs:

```bash
bee-slack /config/config.json
```

## Container image

Build the container locally with:

```bash
docker build -t bee-slack:local .
```

Run it with a mounted config file:

```bash
docker run --rm \
  -v "$(pwd)/local.config.json:/config/config.json:ro" \
  bee-slack:local
```

## Kubernetes

A reusable Helm chart is included under
[`charts/bee-slack`](./charts/bee-slack). The chart supports either:

- mounting an existing Secret that contains `config.json`
- creating the config Secret from values at install time

The chart mounts `/workspace` as an ephemeral `emptyDir`. That is enough for
the local blob store used for Slack attachments and generated artifacts, but
those files are intentionally not persisted across pod restarts or recreations.

Example values files for both secret-handling modes are included under:

- [`charts/bee-slack/values-existing-secret.example.yaml`](./charts/bee-slack/values-existing-secret.example.yaml)
- [`charts/bee-slack/values-inline-config.example.yaml`](./charts/bee-slack/values-inline-config.example.yaml)

Example install using an existing Secret:

```bash
helm upgrade --install bee-slack ./charts/bee-slack \
  --namespace ai-agents \
  --create-namespace \
  --set config.existingSecretName=bee-slack-config \
  --set image.repository=ghcr.io/jobmatchme/bee-slack \
  --set image.tag=0.1.7
```

The mounted config file must contain the same structure as
`local.config.example.json`.

### Scheduled Slack turns

The same container can also run a one-shot scheduled turn. This is intended for
Kubernetes `CronJob`s that should survive `bee-slack` or `fabee-pi-agent` pod
restarts while triggering a Bee worker and publishing the result to Slack:

```bash
bee-slack run-scheduled /config/config.json /scheduled/job.json
```

Example `/scheduled/job.json`:

```json
{
  "id": "daily-dbt-report",
  "routeId": "dm-test",
  "target": { "slackUserId": "U1234567890" },
  "text": "Erstelle den täglichen dbt Report und schreibe die Ergebnisse kompakt auf Deutsch."
}
```

`routeId` selects one of the configured Slack routes and therefore the Bee
worker subject, for example `fabee.agent.pi.default`. For DM targets the command
opens the Slack DM, streams the worker run, updates the Slack status message,
and uploads inline artifacts when available.

The Helm chart supports persistent cluster schedules via `scheduledRuns` values;
each entry creates a Kubernetes `CronJob` plus a ConfigMap containing its
one-shot job config.

Release order matters for changes in the shared gateway runtime: publish the
referenced `@jobmatchme/bee-gate` version first, then tag and publish
`bee-slack` so the npm package, GHCR image, and OCI Helm chart resolve the same
runtime.

## License

MIT
