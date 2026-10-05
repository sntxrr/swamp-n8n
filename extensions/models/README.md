# @sntxrr/n8n

Read a running [n8n](https://n8n.io) deployment and report how far its pinned
version has drifted behind the channel n8n itself calls stable, and which
active workflows would fail silently because no error workflow is attached.

One model type, `@sntxrr/n8n/instance`, with three methods. **All are read-only**
— nothing here upgrades n8n, edits a workflow, touches a credential, or
restarts a container. It tells you an update exists; applying it is yours to do.

## What it does not do

Stated plainly, because the name invites the assumption: it does not upgrade
the instance, run migrations, manage workflows or credentials, or touch the
container. It reads a version number and compares it to another one, and it
reads workflow settings and reports which ones lack an error workflow. It never
attaches one.

## Why `audit_error_workflows` needs an API key

n8n has no instance-wide default error workflow. Each workflow names its own in
`settings.errorWorkflow`, so a workflow activated without one fails and nobody
hears about it. Fixing today's workflows does not cover tomorrow's.

Only the authenticated public API discloses that setting, so this method takes
an optional `apiKey` global argument. `sync` and `drift` never send it. On
editions without scoped API keys the key carries its owner's full rights, even
though this method only reads. Store it in a vault and treat it accordingly.

A workflow is flagged when it is active, not archived, not the handler itself,
and its `errorWorkflow` is:

- `missing` — unset;
- `wrong-handler` — set to something other than `handlerWorkflowId`;
- `handler-unusable` — set to the handler, but the handler is inactive,
  archived or gone. Every workflow naming it is listed, not one flag.

A 401/403, a malformed list, or a cursor that never ends is raised as an error.
An audit that could not look never reports "no findings".

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

`baseUrl` is used by `sync` and `audit_error_workflows`. `drift` needs no
access to the instance at all, so a check can run while n8n is down. For the
audit, set `apiKey` from a vault expression in the model definition rather than
on the command line.

## Run it

```bash
swamp model @sntxrr/n8n/instance method run sync n8n

swamp model @sntxrr/n8n/instance method run drift n8n \
  --arg runningVersion=2.25.7

swamp data get drift-current --json | jq '{status, latestVersion, releasesBehind}'

swamp model @sntxrr/n8n/instance method run audit_error_workflows n8n \
  --arg handlerWorkflowId=<your error workflow id>
```

## Resources

| Resource | Lifetime | Description |
| --- | --- | --- |
| `instance` | infinite | Liveness and the pre-login auth surface. Records `versionDisclosed`, read from the payload rather than hardcoded — it is the reason `drift` needs an argument, and if a future n8n starts disclosing a version it turns true on its own. |
| `drift` | infinite | `status` (`current`/`behind`/`ahead`), `behind`, `releasesBehind`, `missedReleases`, `nextChannelVersion`, `imageAvailable`, `image`. |
| `errorWorkflowAudit` | infinite | `hasFindings`, `findingCount`, `findings[]` (`id`, `name`, `reason`, `errorWorkflow`), `summary` (one line per finding), handler state, `workflowsChecked`. |

Alert on `behind`, and separately on `hasFindings`.

## Failure is never folded into "up to date"

An exhausted GitHub rate limit, an unreachable registry, and an unparseable
running version are all raised as errors.

Reporting `current` because the comparison could not be made is the single
failure mode this model exists to prevent: a broken check and a current
instance would otherwise be indistinguishable, and the broken one stays broken
because nothing ever alerts.

## License

MIT — see [LICENSE.md](./LICENSE.md).
