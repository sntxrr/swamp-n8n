# @sntxrr/n8n

Read a running [n8n](https://n8n.io) deployment and report how far its pinned
version has drifted behind the channel n8n itself calls stable.

One model type, `@sntxrr/n8n/instance`, with two methods. **Both are read-only**
— nothing here upgrades n8n, edits a workflow, touches a credential, or
restarts a container. It tells you an update exists; applying it is yours to do.

## What it does not do

Stated plainly, because the name invites the assumption: it does not upgrade
the instance, run migrations, manage workflows or credentials, or touch the
container. It reads a version number and compares it to another one.

## Why `drift` makes you pass the running version in

Its siblings (`@sntxrr/openwebui`, `@sntxrr/swamp-version`) read the running
version out of the service. n8n will not tell you.

`/rest/settings` answers 200 without authentication, but with
`settingsMode: "public"` — a reduced payload with no version field of any kind.
`versionCli` reaches authenticated callers only. Measured against n8n 2.25.7 on
2026-09-05, the complete public key set is:

```
authCookie, communityNodesEnabled, defaultLocale, enterprise,
previewMode, settingsMode, sso, userManagement
```

The alternative is an n8n API key — a credential to issue, store and rotate for
a check that only ever reads a version number. So the caller supplies it from
the thing that actually determines the version, the pinned image tag:

```bash
docker inspect n8n --format '{{.Config.Image}}' | sed 's/.*://'
```

That is also the more truthful source. It is what the deployment *is*, rather
than what a long-running process that may predate the current pin believes
itself to be.

## Why the target comes from npm, not from the newest release

n8n ships its in-progress minor into the same GitHub release namespace as its
stable one, flagged `prerelease: true` while it bakes, and promotes that line to
stable later. **Sorting tags, or taking the newest release, pins a pre-release
build.**

Measured 2026-09-05 — the newest published release was `n8n@2.38.3`, while the
version n8n called stable was `2.37.10`. The 2.37 line had itself been
prerelease through 2.37.6 before being promoted at 2.37.7. npm said so
unambiguously:

```
next=2.38.3  beta=2.38.3  stable=2.37.10  latest=2.37.10  rc=2.37.10
```

So the dist-tag is the target: one unauthenticated request, no meaningful rate
limit, and it encodes upstream's own judgement rather than this model's guess.

GitHub releases are still read, but only to *enumerate* what was missed and to
link the notes. The `prerelease` flag there is the historical record of which
line was stable when, which dist-tags do not retain.

A pending `next` minor is reported in `nextChannelVersion` and never offered as
the thing to deploy.

## Why the image is verified somewhere other than where it is pulled from

A published release and a pushed image are separate events. Offering a bump
whose image does not exist yet produces a deploy that fails at `compose pull`,
*after* it has stopped the running container.

The pin points at `docker.n8n.io/n8nio/n8n`, but that host cannot answer the
question. It is a pull-through mirror: its own `/token/` endpoint 404s, and its
`WWW-Authenticate` delegates to `auth.docker.io`. Given a valid Docker Hub
token it then answers **429 to every manifest HEAD** — measured 2026-09-05 for
a tag that exists and a tag that does not, indistinguishably.

`registry-1.docker.io/n8nio/n8n` serves the identical images and answers
cleanly: 200 for `2.37.10`, 404 for a tag that does not exist. That is where
existence is checked, while `image` in the output still names the mirror the
deployment actually pulls from.

A 429 is raised as *indeterminate*, never folded into "absent" — that would
suppress every update forever while the check looked perfectly healthy.

## Install

```bash
swamp extension pull @sntxrr/n8n
```

## Create an instance

```bash
swamp model create @sntxrr/n8n/instance n8n \
  --global-arg baseUrl=http://192.0.2.10:5678
```

`baseUrl` is used only by `sync`. `drift` needs no access to the instance at
all, so a check can run while n8n is down.

## Run it

```bash
swamp model @sntxrr/n8n/instance method run sync n8n

swamp model @sntxrr/n8n/instance method run drift n8n \
  --arg runningVersion=2.25.7

swamp data get drift-current --json | jq '{status, latestVersion, releasesBehind}'
```

## Resources

| Resource | Lifetime | Description |
| --- | --- | --- |
| `instance` | infinite | Liveness and the pre-login auth surface. Records `versionDisclosed: false` — the reason `drift` needs an argument, in the data rather than only in the docs. |
| `drift` | infinite | `status` (`current`/`behind`/`ahead`), `behind`, `releasesBehind`, `missedReleases`, `nextChannelVersion`, `imageAvailable`, `image`. |

Alert on `behind`.

## Failure is never folded into "up to date"

An exhausted GitHub rate limit, an unreachable registry, and an unparseable
running version are all raised as errors.

Reporting `current` because the comparison could not be made is the single
failure mode this model exists to prevent: a broken check and a current
instance would otherwise be indistinguishable, and the broken one stays broken
because nothing ever alerts.

## License

MIT — see [LICENSE.md](./LICENSE.md).
