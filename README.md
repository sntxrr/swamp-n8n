# swamp-n8n

A [swamp](https://swamp-club.com) extension for [n8n](https://n8n.io).

| Extension | Type | What it does |
| --- | --- | --- |
| [`@sntxrr/n8n`](extensions/models/README.md) | model | `sync` records an instance's liveness and pre-login auth surface; `drift` reports how far its pinned version has fallen behind the channel n8n calls stable |

Read-only and credential-free. See
[the extension README](extensions/models/README.md) for methods, configuration,
and the three behaviours worth knowing before relying on it.

## Why this exists

n8n tells you in the UI that you are behind — that is how the deployment this
was built against was found sitting on 2.25.7 with 2.37.10 current. But it only
tells you once you have logged in and looked, which is not a monitoring
strategy, and it tells you nothing at all when the instance is down.

Nothing else surfaces it either. A container healthcheck goes green either way:
`/healthz` reports on the web process, not on how old it is.

`drift` is the thing that says it out loud, on a schedule:

```
runningVersion    2.25.7
channel           stable
latestVersion     2.37.10
status            behind
releasesBehind    41            (lower bound; truncated)
nextChannelVersion 2.38.3       (pending, never offered)
imageAvailable    true
```

## What makes n8n a different problem from the usual update check

Three things, each of which breaks the obvious implementation:

1. **n8n will not tell you its version.** `/rest/settings` answers 200
   unauthenticated, but with `settingsMode: "public"` — no version field.
   `versionCli` is for authenticated callers. So `drift` takes the running
   version as an argument, read from the pinned image tag on the host.

2. **The newest release is not the one to run.** n8n publishes its in-progress
   minor into the same release namespace, flagged `prerelease: true`, and
   promotes it later. On 2026-09-05 the newest release was `2.38.3` while
   stable was `2.37.10`. The target comes from npm's `stable` dist-tag;
   sorting tags pins a pre-release build.

3. **The registry in the pin cannot confirm the image exists.**
   `docker.n8n.io` is a pull-through mirror that 404s its own token endpoint
   and then answers 429 to every manifest request — for tags that exist and
   tags that do not, indistinguishably. Existence is checked against
   `registry-1.docker.io`, which serves the same images and answers cleanly.

Why any of that matters more for n8n than for a stateless app: n8n runs schema
migrations on first boot of a new version and does not reverse them. Re-pinning
the old tag against a migrated database does not start it. The rollback is a
restore, so the version that gets deployed had better be one upstream meant for
production.

## Development

```bash
deno test --allow-net extensions/models/n8n_instance_test.ts
swamp extension fmt extensions/models/manifest.yaml
swamp extension quality extensions/models/manifest.yaml
```

## License

MIT — see [LICENSE.md](extensions/models/LICENSE.md).
