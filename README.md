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

## License

MIT
