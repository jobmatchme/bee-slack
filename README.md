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

It does not own protocol orchestration itself. That responsibility stays in
`@jobmatchme/bee-gate`, which keeps the Slack adapter replaceable and easier to
compare against other frontends.

## Local development

For local manual testing, copy `local.config.example.json` to
`local.config.json`, fill in your Slack tokens, and run:

```bash
npm run start:local
```

This starts a local NATS broker via Docker, starts the local fake backend, and
then launches `bee-slack` against that local stack.

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
  --set image.tag=0.1.4
```

The mounted config file must contain the same structure as
`local.config.example.json`.

## License

MIT
