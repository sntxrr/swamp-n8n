/**
 * n8n instance — read a running {@link https://n8n.io | n8n} deployment and
 * report how far its pinned version has drifted behind upstream.
 *
 * Three read-only methods. `sync` records what the instance discloses about
 * itself before login — liveness and the auth surface. `drift` compares a
 * supplied running version against the channel n8n itself calls stable and
 * reports how far behind it is. `audit_error_workflows` lists the active
 * workflows and flags any that would fail silently because no usable error
 * workflow is attached.
 *
 * Nothing here writes to n8n, edits a workflow, touches a credential, or
 * restarts a container. It tells you an update exists and stops.
 *
 * ## Why the audit needs an API key when `drift` does not
 *
 * n8n has no instance-wide default error workflow. Each workflow names its own
 * in `settings.errorWorkflow`, so one activated without it fails without
 * telling anyone, and the only way to see that setting is the authenticated
 * public API. The key is optional and used by `audit_error_workflows` alone;
 * `sync` and `drift` never send it.
 *
 * The audit reports and never repairs. Attaching a handler is a write to a
 * production workflow, and a watcher that also writes has to be trusted with
 * production on every scheduled run.
 *
 * ## Why `drift` takes the running version as an argument
 *
 * Every sibling of this model (`@sntxrr/openwebui`, `@sntxrr/swamp-version`)
 * reads the running version out of the service. n8n will not tell you.
 *
 * Its `/rest/settings` endpoint answers 200 unauthenticated, but with
 * `settingsMode: "public"` — a reduced payload carrying `userManagement`,
 * `sso` and `enterprise`, and no version field of any kind. `versionCli` is
 * disclosed only to an authenticated caller. Measured against n8n 2.25.7 on
 * 2026-09-05: the public payload's complete key set is `authCookie`,
 * `communityNodesEnabled`, `defaultLocale`, `enterprise`, `previewMode`,
 * `settingsMode`, `sso`, `userManagement`.
 *
 * The alternative is an n8n API key, which means a credential to issue, store
 * and rotate for a check that only ever reads a version number. The caller
 * instead supplies the version from the thing that actually determines it —
 * the pinned image tag, read off the host with `docker inspect`. That is also
 * the more truthful source: it is what the deployment *is*, not what a process
 * that may predate the current pin believes itself to be.
 *
 * ## Why the target version comes from npm and not from the tag list
 *
 * n8n ships its in-progress minor into the same GitHub release namespace as
 * its stable one, flagged `prerelease: true` while it bakes, and promotes that
 * line to stable later. Sorting tags, or taking the newest release, pins a
 * pre-release build.
 *
 * Measured 2026-09-05: the newest published release was `n8n@2.38.3`, while
 * the version n8n called stable was `2.37.10` — and the 2.37 line itself had
 * been prerelease through 2.37.6 before being promoted at 2.37.7. npm's
 * dist-tags said so unambiguously:
 *
 * ```
 * next=2.38.3  beta=2.38.3  stable=2.37.10  latest=2.37.10  rc=2.37.10
 * ```
 *
 * So the dist-tag is the target. It is one unauthenticated request against a
 * registry with no meaningful rate limit, and it encodes upstream's own
 * judgement about what should be run rather than this model's guess.
 *
 * GitHub releases are still read, but only to *enumerate* what was missed and
 * to link the notes — the `prerelease` flag there is the historical record of
 * which line was stable when, which dist-tags do not retain.
 *
 * ## Why the image is verified somewhere other than where it is pulled from
 *
 * A published release and a pushed image are separate events. Offering a bump
 * whose image does not exist yet produces a deploy that fails at
 * `compose pull`, *after* it has stopped the running container.
 *
 * The pin points at `docker.n8n.io/n8nio/n8n`, but that host cannot answer the
 * question. It is a pull-through mirror: its own `/token/` endpoint 404s, and
 * its `WWW-Authenticate` delegates to `auth.docker.io`. Given a valid Docker
 * Hub token it then answers **429 to every manifest HEAD** — measured
 * 2026-09-05, for a tag that exists and a tag that does not, indistinguishably.
 * An existence check against the mirror is therefore not merely unreliable, it
 * cannot return a usable answer at all.
 *
 * `registry-1.docker.io/n8nio/n8n` serves the identical images and answers
 * cleanly: 200 for `2.37.10`, 404 for a tag that does not exist. That is where
 * existence is checked, while `image` in the output still names the mirror the
 * deployment actually pulls from.
 *
 * ## Failure is never folded into "up to date"
 *
 * An exhausted rate limit, an unreachable registry, and an unparseable running
 * version are all raised. Reporting `current` because the comparison could not
 * be made is the single failure mode this model exists to prevent: a broken
 * check and a current instance would otherwise be indistinguishable, and the
 * broken one stays broken because nothing ever alerts.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().url().describe(
    "Base URL of the n8n instance, e.g. http://192.0.2.10:5678. Used only " +
      "by `sync`; `drift` needs no instance access at all.",
  ),
  npmPackage: z.string().default("n8n").describe(
    "npm package whose dist-tags define the release channels. Override only " +
      "to track a fork that publishes its own channels.",
  ),
  channel: z.string().default("stable").describe(
    "Which npm dist-tag is authoritative for what should be running. " +
      "`stable` is what n8n recommends self-hosters run; `latest` currently " +
      "tracks it. `next` and `beta` are the in-progress minor and are not a " +
      "sane target for a deployment that cannot roll its database back.",
  ),
  githubRepo: z.string().default("n8n-io/n8n").describe(
    "GitHub `owner/repo` used to enumerate missed releases and link notes. " +
      "Not used to choose the target version — see the module docs.",
  ),
  // `.meta({ sensitive: true })` sits on this line rather than after the
  // `.describe(...)` it chains from: the push-time safety analyzer reads the
  // field's declaration LINE, so a marker placed after a multi-line describe()
  // is invisible to it and the field still reports as an unvaulted secret.
  githubToken: z.string().meta({ sensitive: true }).optional().describe(
    "Optional GitHub token, purely to raise the API rate limit. Needs no " +
      "scopes for a public repo. Unauthenticated GitHub allows 60 requests/" +
      "hour per IP, shared with everything else on that address.",
  ),
  imageRepository: z.string().default("docker.n8n.io/n8nio/n8n").describe(
    "Fully qualified image the deployment actually pulls. Reported in " +
      "`image` so a bump can be applied verbatim. NOT where existence is " +
      "checked — that mirror 429s every manifest request.",
  ),
  verifyRegistry: z.string().default("registry-1.docker.io").describe(
    "Registry host that existence is actually checked against. Must answer " +
      "the Docker Registry HTTP API V2 manifest endpoint.",
  ),
  verifyRepository: z.string().default("n8nio/n8n").describe(
    "Repository path within `verifyRegistry`, serving the same images as " +
      "`imageRepository`.",
  ),
  timeoutMs: z.number().int().positive().default(10_000).describe(
    "Abort each HTTP call after this long. A drift check must never hang a " +
      "workflow.",
  ),
  // `.meta({ sensitive: true })` on the declaration line, for the same reason
  // as githubToken above.
  apiKey: z.string().meta({ sensitive: true }).optional().describe(
    "n8n public API key, sent as X-N8N-API-KEY. Used ONLY by " +
      "`audit_error_workflows`, which reads workflow settings; `sync` and " +
      "`drift` never send it. Supply it from a vault.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstanceSchema = z.object({
  url: z.string().describe("Base URL this reading came from."),
  healthy: z.boolean().describe("True when /healthz answered 2xx."),
  status: z.number().describe(
    "HTTP status from /healthz, 0 on a transport error.",
  ),
  latencyMs: z.number().describe("Round-trip time of the health probe."),
  settingsMode: z.string().nullable().describe(
    "What /rest/settings disclosed. `public` means the reduced pre-login " +
      "payload, which is all an unauthenticated caller ever sees.",
  ),
  versionDisclosed: z.boolean().describe(
    "Whether the instance told us its version. Read from the payload rather " +
      "than hardcoded, so it is evidence rather than an assertion: it is " +
      "false for every n8n measured so far, and the day a release starts " +
      "disclosing a version unauthenticated this turns true on its own and " +
      "`drift` no longer needs its runningVersion argument.",
  ),
  authenticationMethod: z.string().nullable().describe(
    "How users log in, e.g. `email`. Null when not disclosed.",
  ),
  ssoEnabled: z.boolean().nullable().describe(
    "Whether any SSO login (SAML or LDAP) is enabled. Null when not disclosed.",
  ),
  detail: z.string().describe(
    "Transport error text, or a truncated response body.",
  ),
  checkedAt: z.iso.datetime().describe("When the probe ran."),
});

const DriftSchema = z.object({
  runningVersion: z.string().describe(
    "The version compared against, as supplied by the caller.",
  ),
  channel: z.string().describe(
    "npm dist-tag treated as authoritative for this check.",
  ),
  latestVersion: z.string().describe(
    "Version on `channel`. This is the upgrade target.",
  ),
  status: z.enum(["current", "behind", "ahead"]).describe(
    "`ahead` means the instance runs something newer than the channel -- " +
      "normal when someone has deliberately pinned a `next` build.",
  ),
  behind: z.boolean().describe(
    "True when the channel carries something newer. The single field to " +
      "alert on.",
  ),
  releasesBehind: z.number().int().describe(
    "How many stable releases sit between the running version and the " +
      "target. A lower bound when `truncated` is true.",
  ),
  missedReleases: z.array(z.string()).describe(
    "Stable releases newer than the running version, newest first. This is " +
      "the changelog nobody has read. Prereleases are excluded.",
  ),
  nextChannelVersion: z.string().nullable().describe(
    "What the `next` dist-tag points at, when it is newer than the target. " +
      "Surfaced so a pending minor is visible without ever being offered as " +
      "the thing to deploy.",
  ),
  imageAvailable: z.boolean().describe(
    "Whether the target tag resolves in the registry. False means the " +
      "release is published but the image is not pushed yet, and a deploy " +
      "would fail at `compose pull` after stopping the container.",
  ),
  image: z.string().describe(
    "Fully qualified image reference for the target, naming the repository " +
      "the deployment actually pulls from.",
  ),
  releaseUrl: z.string().describe(
    "HTML URL of the target's release notes, or the releases index when the " +
      "specific release was not on the page examined.",
  ),
  truncated: z.boolean().describe(
    "True when the release page filled up before reaching the running " +
      "version, so `releasesBehind` and `missedReleases` are incomplete. " +
      "Cannot cause a too-new target to be offered -- the target comes from " +
      "the dist-tag, not from this list.",
  ),
  checkedAt: z.iso.datetime().describe("When the check ran."),
});

const ErrorWorkflowFindingSchema = z.object({
  id: z.string().describe("Workflow id."),
  name: z.string().describe("Workflow name."),
  reason: z.enum(["missing", "wrong-handler", "handler-unusable"]).describe(
    "`missing`: no settings.errorWorkflow at all. `wrong-handler`: it names a " +
      "workflow other than the expected handler. `handler-unusable`: it names " +
      "the handler, but the handler is inactive, archived or gone.",
  ),
  errorWorkflow: z.string().nullable().describe(
    "What settings.errorWorkflow actually holds, null when unset.",
  ),
});

const ErrorWorkflowAuditSchema = z.object({
  url: z.string().describe("Base URL the audit read from."),
  handlerWorkflowId: z.string().describe(
    "The error workflow every active workflow is expected to name.",
  ),
  handlerFound: z.boolean().describe("Whether the handler workflow exists."),
  handlerActive: z.boolean().describe("Whether the handler is active."),
  handlerArchived: z.boolean().describe("Whether the handler is archived."),
  workflowsChecked: z.number().int().describe(
    "Active, non-archived workflows examined, the handler excluded.",
  ),
  hasFindings: z.boolean().describe("The single field to alert on."),
  findingCount: z.number().int().describe("Number of entries in `findings`."),
  findings: z.array(ErrorWorkflowFindingSchema).describe(
    "Each workflow that would fail silently, in id order.",
  ),
  summary: z.string().describe(
    'One line per finding, `<id> "<name>": <reason>`, ready for a ' +
      "notification body. Empty when there are no findings.",
  ),
  checkedAt: z.iso.datetime().describe("When the audit ran."),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type Context = {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/* ------------------------------------------------------------------ *
 * Version handling
 *
 * n8n versions break lexical ordering the same way every other
 * multi-digit version does: "2.9.0" > "2.37.10" is true as a string and
 * wrong. Compared numerically throughout.
 * ------------------------------------------------------------------ */

/** A parsed semantic version. `prerelease` is null for a final release. */
export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

/**
 * Parse a version string into comparable parts.
 *
 * Tolerates a leading `v`, an `n8n@` release-tag prefix, missing minor/patch
 * components, build metadata after `+`, and surrounding whitespace.
 *
 * @param raw Version or tag, e.g. `n8n@2.37.10`, `v2.37.10`, `2.37.10-rc.1`.
 * @returns The parsed version, or null if it is not a recognisable version.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  // n8n tags its GitHub releases `n8n@2.37.10` -- the package name is part of
  // the tag, not decoration, because the monorepo publishes several packages.
  const cleaned = raw.trim()
    .replace(/^n8n@/i, "")
    .replace(/^v/i, "");
  if (cleaned === "") return null;

  // Build metadata never participates in precedence, so it goes first.
  const withoutBuild = cleaned.split("+")[0];
  const dashAt = withoutBuild.indexOf("-");
  const core = dashAt === -1 ? withoutBuild : withoutBuild.slice(0, dashAt);
  const prerelease = dashAt === -1 ? null : withoutBuild.slice(dashAt + 1);

  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3) return null;

  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }

  return {
    major: nums[0],
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    prerelease: prerelease === "" ? null : prerelease,
  };
}

/**
 * Compare two parsed versions by semver precedence.
 *
 * A prerelease sorts *below* the final release it precedes, so
 * `2.38.0-rc.1 < 2.38.0`.
 *
 * @returns Negative if a < b, positive if a > b, zero if equal.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

/** Strip an `n8n@`/`v` prefix for display, without parsing. */
export function normaliseTag(tag: string): string {
  return tag.trim().replace(/^n8n@/i, "").replace(/^v/i, "");
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}

/**
 * Combine the caller's cancellation signal with a per-call timeout.
 *
 * `AbortSignal.any` rather than a bare timeout so a cancelled workflow stops
 * these requests too, instead of leaving them to run out their own clock.
 */
function callSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/* ------------------------------------------------------------------ *
 * npm dist-tags — the authoritative channel
 * ------------------------------------------------------------------ */

/** The release channels npm publishes for a package. */
export type DistTags = Record<string, string>;

/**
 * Read a package's dist-tags from the npm registry.
 *
 * Uses the abbreviated packument media type: the full document for `n8n`
 * carries every version's complete metadata and is tens of megabytes, which is
 * a great deal of transfer for two strings.
 */
export async function readDistTags(
  npmPackage: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DistTags> {
  const res = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(npmPackage)}`,
    {
      signal: callSignal(timeoutMs, signal),
      headers: {
        // Abbreviated packument. Still includes dist-tags.
        Accept: "application/vnd.npm.install-v1+json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `npm registry returned HTTP ${res.status} for ${npmPackage}: ` +
        `${await readErrorBody(res)}`,
    );
  }
  const body = await res.json() as { "dist-tags"?: DistTags };
  const tags = body["dist-tags"];
  if (!tags || typeof tags !== "object") {
    throw new Error(
      `npm registry returned no dist-tags for ${npmPackage}; cannot determine ` +
        `which version is current`,
    );
  }
  return tags;
}

/* ------------------------------------------------------------------ *
 * Registry existence check
 * ------------------------------------------------------------------ */

/**
 * Parse the auth realm out of a `WWW-Authenticate: Bearer ...` header.
 *
 * Discovered rather than assumed. The obvious shortcut — build the token URL
 * as `https://<registry>/token/` — is what the sibling openobserve model does,
 * and it is wrong for anything that fronts another registry: `docker.n8n.io`
 * 404s its own `/token/` while its 401 correctly names `auth.docker.io`.
 */
export function parseAuthChallenge(
  header: string,
): { realm: string; service: string | null } | null {
  if (!/^\s*Bearer\s/i.test(header)) return null;
  const realm = header.match(/realm="([^"]+)"/i)?.[1];
  if (!realm) return null;
  const service = header.match(/service="([^"]+)"/i)?.[1] ?? null;
  return { realm, service };
}

/**
 * Whether a tag resolves to a manifest in the registry.
 *
 * A manifest HEAD, not a tag listing: `/v2/<name>/tags/list` is paginated with
 * no ordering guarantee, so a tag can be genuinely present and absent from the
 * first page.
 *
 * Anything that is neither 200 nor 404 throws. A 429 in particular must never
 * read as "absent" — that is exactly what the pull-through mirror returns for
 * every tag, and treating it as absent would suppress every update forever
 * while looking like a healthy check.
 */
export async function imageTagExists(
  registry: string,
  repository: string,
  tag: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${
    encodeURIComponent(tag)
  }`;
  // Without these an OCI-index-serving registry answers 404 for an image that
  // exists.
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");

  const probe = await fetch(manifestUrl, {
    method: "HEAD",
    signal: callSignal(timeoutMs, signal),
    headers: { Accept: accept },
  });
  await probe.body?.cancel();

  if (probe.status === 200) return true;
  if (probe.status === 404) return false;

  if (probe.status !== 401) {
    throw new Error(
      `registry ${registry} answered HTTP ${probe.status} for ` +
        `${repository}:${tag}; treating as indeterminate rather than absent`,
    );
  }

  const challenge = parseAuthChallenge(
    probe.headers.get("www-authenticate") ?? "",
  );
  if (!challenge) {
    throw new Error(
      `registry ${registry} demanded authentication for ${repository} but ` +
        `sent no parseable Bearer challenge`,
    );
  }

  const tokenUrl = new URL(challenge.realm);
  tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);
  if (challenge.service) {
    tokenUrl.searchParams.set("service", challenge.service);
  }

  const tokenRes = await fetch(tokenUrl, {
    signal: callSignal(timeoutMs, signal),
  });
  if (!tokenRes.ok) {
    throw new Error(
      `${challenge.realm} refused an anonymous pull token for ${repository}: ` +
        `HTTP ${tokenRes.status}: ${await readErrorBody(tokenRes)}`,
    );
  }
  const tokenBody = await tokenRes.json() as {
    token?: string;
    access_token?: string;
  };
  const token = tokenBody.token ?? tokenBody.access_token;
  if (!token) {
    throw new Error(
      `${challenge.realm} returned no token for ${repository}`,
    );
  }

  const res = await fetch(manifestUrl, {
    method: "HEAD",
    signal: callSignal(timeoutMs, signal),
    headers: { Accept: accept, Authorization: `Bearer ${token}` },
  });
  await res.body?.cancel();

  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new Error(
    `registry ${registry} answered HTTP ${res.status} for ${repository}:${tag} ` +
      `after authenticating; treating as indeterminate rather than absent. ` +
      `A persistent 429 here means this host is a rate-limited pull-through ` +
      `mirror -- point verifyRegistry at the registry that backs it.`,
  );
}

/* ------------------------------------------------------------------ *
 * Drift computation
 * ------------------------------------------------------------------ */

/** One upstream release, as far as this model cares. */
export type ReleaseInfo = {
  tag: string;
  prerelease: boolean;
  htmlUrl: string;
};

export type DriftResult = {
  status: "current" | "behind" | "ahead";
  behind: boolean;
  releasesBehind: number;
  missedReleases: string[];
  truncated: boolean;
};

/**
 * Compare a running version against a target, using the release list only to
 * enumerate what sits between them.
 *
 * The target is passed in rather than derived from `releases`: it comes from
 * the dist-tag, which is upstream's own statement about what should be run.
 * The release list can therefore be incomplete, or contain newer prereleases,
 * without affecting which version is offered.
 *
 * @param runningVersion Version currently deployed.
 * @param targetVersion Version on the authoritative channel.
 * @param releases Recent releases, newest first, as GitHub returns them.
 * @param pageWasFull Whether the release query returned a full page, so older
 *   releases exist that were not examined.
 */
export function computeDrift(
  runningVersion: string,
  targetVersion: string,
  releases: ReleaseInfo[],
  pageWasFull: boolean,
): DriftResult {
  const running = parseVersion(runningVersion);
  if (!running) {
    throw new Error(
      `runningVersion ${
        JSON.stringify(runningVersion)
      } is not a recognisable ` +
        `version; refusing to report drift rather than guess`,
    );
  }
  const target = parseVersion(targetVersion);
  if (!target) {
    throw new Error(
      `target version ${JSON.stringify(targetVersion)} from the channel is ` +
        `not a recognisable version`,
    );
  }

  const cmp = compareVersions(target, running);
  const status = cmp > 0 ? "behind" : cmp < 0 ? "ahead" : "current";

  // Stable releases strictly newer than what is running, and no newer than the
  // target. The upper bound matters: without it a pending `next` minor would
  // be counted among the releases this deployment is "behind", which would
  // both inflate the count and name versions that are deliberately not on
  // offer.
  const missed = releases
    .filter((r) => !r.prerelease)
    .map((r) => ({ raw: normaliseTag(r.tag), parsed: parseVersion(r.tag) }))
    .filter((r): r is { raw: string; parsed: ParsedVersion } =>
      r.parsed !== null
    )
    .filter((r) =>
      compareVersions(r.parsed, running) > 0 &&
      compareVersions(r.parsed, target) <= 0
    )
    .sort((a, b) => compareVersions(b.parsed, a.parsed))
    .map((r) => r.raw);

  // A full page whose oldest entry is still newer than what is running means
  // the gap continues past what was examined.
  const oldestExamined = releases.length > 0
    ? parseVersion(releases[releases.length - 1].tag)
    : null;
  const truncated = pageWasFull && oldestExamined !== null &&
    compareVersions(oldestExamined, running) > 0;

  return {
    status,
    behind: status === "behind",
    releasesBehind: missed.length,
    missedReleases: missed,
    truncated,
  };
}

/* ------------------------------------------------------------------ *
 * Error-workflow audit
 * ------------------------------------------------------------------ */

/** A workflow as the public API returns it, reduced to what the audit reads. */
export type WorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  errorWorkflow: string | null;
};

/** The handler's own state, which decides whether naming it is enough. */
export type HandlerState = {
  found: boolean;
  active: boolean;
  archived: boolean;
};

export type ErrorWorkflowFinding = {
  id: string;
  name: string;
  reason: "missing" | "wrong-handler" | "handler-unusable";
  errorWorkflow: string | null;
};

/**
 * Flag every active, non-archived workflow that would fail silently.
 *
 * The handler itself is exempt: it is what errors are sent TO, and pointing it
 * at itself would loop.
 *
 * `handler-unusable` exists so a broken handler is reported per workflow
 * rather than as one easily-missed flag: if the handler is archived, every
 * workflow that names it is silently uncovered, and the alert should list them.
 *
 * Pure, so the rules are tested without a server.
 */
export function auditErrorWorkflows(
  workflows: WorkflowSummary[],
  handlerWorkflowId: string,
  handler: HandlerState,
): ErrorWorkflowFinding[] {
  const handlerUsable = handler.found && handler.active && !handler.archived;
  const findings: ErrorWorkflowFinding[] = [];
  for (const wf of workflows) {
    if (!wf.active || wf.isArchived) continue;
    if (wf.id === handlerWorkflowId) continue;
    let reason: ErrorWorkflowFinding["reason"] | null = null;
    if (!wf.errorWorkflow) reason = "missing";
    else if (wf.errorWorkflow !== handlerWorkflowId) reason = "wrong-handler";
    else if (!handlerUsable) reason = "handler-unusable";
    if (reason) {
      findings.push({
        id: wf.id,
        name: wf.name,
        reason,
        errorWorkflow: wf.errorWorkflow || null,
      });
    }
  }
  return findings.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** One line per finding, for a notification body. */
export function summariseFindings(findings: ErrorWorkflowFinding[]): string {
  return findings
    .map((f) => `${f.id} ${JSON.stringify(f.name)}: ${f.reason}`)
    .join("\n");
}

type RawWorkflow = {
  id?: unknown;
  name?: unknown;
  active?: unknown;
  isArchived?: unknown;
  settings?: { errorWorkflow?: unknown } | null;
};

function toSummary(raw: RawWorkflow): WorkflowSummary | null {
  if (typeof raw.id !== "string") return null;
  const ew = raw.settings?.errorWorkflow;
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    active: raw.active === true,
    isArchived: raw.isArchived === true,
    errorWorkflow: typeof ew === "string" && ew !== "" ? ew : null,
  };
}

/** Throw a message that names the auth problem rather than a bare status. */
async function publicApiError(res: Response, what: string): Promise<Error> {
  const hint = res.status === 401 || res.status === 403
    ? " (the API key is missing, revoked or lacks workflow:list/workflow:read)"
    : "";
  return new Error(
    `n8n public API returned HTTP ${res.status} for ${what}${hint}: ` +
      `${await readErrorBody(res)}`,
  );
}

/**
 * Every active workflow, following `nextCursor` to the end.
 *
 * A page cap guards against a cursor that never terminates; hitting it throws
 * rather than auditing a partial list, because a workflow on an unread page
 * is exactly the one nobody would hear about.
 */
export async function listActiveWorkflows(
  baseUrl: string,
  apiKey: string,
  pageSize: number,
  timeoutMs: number,
  signal?: AbortSignal,
  maxPages = 50,
): Promise<WorkflowSummary[]> {
  const out: WorkflowSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${baseUrl}/api/v1/workflows`);
    url.searchParams.set("active", "true");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("excludePinnedData", "true");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
      signal: callSignal(timeoutMs, signal),
    });
    if (!res.ok) throw await publicApiError(res, "the workflow list");
    const body = await res.json() as {
      data?: RawWorkflow[];
      nextCursor?: string | null;
    };
    if (!Array.isArray(body.data)) {
      throw new Error(
        "n8n public API returned no `data` array for the workflow list; " +
          "refusing to report an empty, clean audit",
      );
    }
    for (const raw of body.data) {
      const s = toSummary(raw);
      if (s) out.push(s);
    }
    cursor = body.nextCursor ?? null;
    if (!cursor) return out;
  }
  throw new Error(
    `n8n workflow list was still paging after ${maxPages} pages; refusing ` +
      `to audit a partial list`,
  );
}

/** The handler's state. A 404 is a result (`found: false`), not an error. */
export async function readHandlerState(
  baseUrl: string,
  apiKey: string,
  handlerWorkflowId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HandlerState> {
  const res = await fetch(
    `${baseUrl}/api/v1/workflows/${encodeURIComponent(handlerWorkflowId)}`,
    {
      headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
      signal: callSignal(timeoutMs, signal),
    },
  );
  if (res.status === 404) {
    await res.body?.cancel();
    return { found: false, active: false, archived: false };
  }
  if (!res.ok) throw await publicApiError(res, "the handler workflow");
  const raw = await res.json() as RawWorkflow;
  return {
    found: true,
    active: raw.active === true,
    archived: raw.isArchived === true,
  };
}

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

/**
 * Model type `@sntxrr/n8n/instance`.
 *
 * @example
 * ```bash
 * swamp model create @sntxrr/n8n/instance n8n \
 *   --global-arg baseUrl=http://192.0.2.10:5678
 * swamp model @sntxrr/n8n/instance method run sync n8n
 * swamp model @sntxrr/n8n/instance method run drift n8n \
 *   --arg runningVersion=2.25.7
 * ```
 */
export const model = {
  type: "@sntxrr/n8n/instance",
  description:
    "Read a running n8n deployment and report how far its pinned version has drifted behind the channel n8n calls stable. Strictly read-only.",
  version: "2026.10.05.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.05.1",
      description:
        "Adds optional apiKey and the audit_error_workflows method; existing arguments are unchanged, so nothing to migrate",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    instance: {
      description:
        "What the instance discloses before login: liveness and the auth surface. Deliberately not the version -- n8n does not disclose one unauthenticated.",
      schema: InstanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    drift: {
      description:
        "Comparison of the running version against the authoritative npm channel.",
      schema: DriftSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    errorWorkflowAudit: {
      description:
        "Active workflows that would fail silently because no usable error workflow is attached.",
      schema: ErrorWorkflowAuditSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },

  methods: {
    sync: {
      description:
        "Probe the instance's /healthz and its pre-login /rest/settings, recording liveness and the auth surface. Unauthenticated and read-only.",
      arguments: z.object({}),
      execute: async (_args: Record<never, never>, context: Context) => {
        const { globalArgs, logger } = context;
        const base = globalArgs.baseUrl.replace(/\/+$/, "");

        let status = 0;
        let detail = "";
        const started = performance.now();
        try {
          const res = await fetch(`${base}/healthz`, {
            signal: callSignal(globalArgs.timeoutMs, context.signal),
          });
          status = res.status;
          detail = (await res.text()).slice(0, 300);
        } catch (err) {
          // A refused connection is a health *result*, not a model error --
          // otherwise a down instance and a broken check look identical.
          detail = err instanceof Error ? err.message : String(err);
        }
        const latencyMs = Math.round(performance.now() - started);
        const healthy = status >= 200 && status < 300;

        // The settings probe is best-effort: it describes the instance, and
        // failing to read it must not mask a successful health result.
        let settingsMode: string | null = null;
        let authenticationMethod: string | null = null;
        let ssoEnabled: boolean | null = null;
        // DERIVED, deliberately not hardcoded. It is false for every n8n
        // measured so far, and writing `false` directly would be simpler and a
        // lie waiting to happen: if n8n ever discloses a version to
        // unauthenticated callers, a constant would keep reporting that it does
        // not, and `drift` would go on requiring its argument for a reason that
        // had stopped being true. Read from the payload, the day that changes
        // the data says so.
        let versionDisclosed = false;
        if (healthy) {
          try {
            const res = await fetch(`${base}/rest/settings`, {
              signal: callSignal(globalArgs.timeoutMs, context.signal),
            });
            if (res.ok) {
              const body = await res.json() as {
                data?: Record<string, unknown>;
              };
              const data = body.data ?? {};
              settingsMode = typeof data.settingsMode === "string"
                ? data.settingsMode
                : null;
              const um = data.userManagement as
                | Record<string, unknown>
                | undefined;
              authenticationMethod =
                typeof um?.authenticationMethod === "string"
                  ? um.authenticationMethod
                  : null;
              const sso = data.sso as
                | Record<string, Record<string, unknown>>
                | undefined;
              if (sso) {
                ssoEnabled = Boolean(sso.saml?.loginEnabled) ||
                  Boolean(sso.ldap?.loginEnabled);
              }
              // Both spellings: `versionCli` is what n8n calls it in the
              // authenticated payload, `version` is the shape a reverse proxy
              // or a future release might use. Either one means `drift` could
              // stop needing its argument.
              versionDisclosed = typeof data.versionCli === "string" ||
                typeof data.version === "string";
            } else {
              await res.body?.cancel();
            }
          } catch {
            // Leave the settings fields null; health already recorded.
          }
        }

        if (healthy) {
          logger.info(
            "n8n at {url} is healthy (HTTP {status}, {latencyMs}ms, settings={mode})",
            { url: base, status, latencyMs, mode: settingsMode ?? "unread" },
          );
        } else {
          logger.warn("n8n at {url} is not healthy: status={status} {detail}", {
            url: base,
            status,
            detail,
          });
        }

        const handle = await context.writeResource(
          "instance",
          "instance-current",
          {
            url: base,
            healthy,
            status,
            latencyMs,
            settingsMode,
            // Recorded as data, not merely documented: `drift` requires an
            // explicit runningVersion, and this is the field that explains why.
            versionDisclosed,
            authenticationMethod,
            ssoEnabled,
            detail,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    drift: {
      description:
        "Compare a running n8n version against the npm channel n8n treats as stable, enumerate the stable releases in between, and confirm the target image is actually pullable.",
      arguments: z.object({
        runningVersion: z.string().describe(
          "Version currently deployed, e.g. 2.25.7. Read this from the pinned " +
            "image tag on the host -- n8n does not disclose its version to an " +
            "unauthenticated caller, so there is nothing to read it from.",
        ),
        pageSize: z.number().int().min(1).max(100).default(100).describe(
          "How many recent releases to examine when enumerating what was " +
            "missed. n8n publishes several releases a week across two " +
            "channels, so a small page covers very little calendar time.",
        ),
        verifyImage: z.boolean().default(true).describe(
          "Confirm the target tag resolves in the registry before reporting " +
            "it as available. A release and its image are separate events.",
        ),
      }),
      execute: async (
        args: {
          runningVersion: string;
          pageSize: number;
          verifyImage: boolean;
        },
        context: Context,
      ) => {
        const { globalArgs, logger } = context;
        const {
          npmPackage,
          channel,
          githubRepo,
          githubToken,
          imageRepository,
          verifyRegistry,
          verifyRepository,
          timeoutMs,
        } = globalArgs;

        const running = normaliseTag(args.runningVersion);
        if (!parseVersion(running)) {
          throw new Error(
            `runningVersion ${JSON.stringify(args.runningVersion)} is not a ` +
              `recognisable version; refusing to report drift rather than ` +
              `report a reassuring "current" that was never computed`,
          );
        }

        logger.info(
          "Checking {pkg} dist-tag {channel} against running {running}",
          { pkg: npmPackage, channel, running },
        );

        const distTags = await readDistTags(
          npmPackage,
          timeoutMs,
          context.signal,
        );
        const target = distTags[channel];
        if (!target) {
          throw new Error(
            `npm package ${npmPackage} has no dist-tag ${
              JSON.stringify(channel)
            }; ` +
              `available: ${Object.keys(distTags).sort().join(", ")}`,
          );
        }

        // The pending minor, surfaced but never offered. `next` is n8n's
        // in-progress line; a deployment whose rollback is a database restore
        // has no business tracking it automatically.
        const nextRaw = distTags.next ?? null;
        let nextChannelVersion: string | null = null;
        if (nextRaw) {
          const nextParsed = parseVersion(nextRaw);
          const targetParsed = parseVersion(target);
          if (
            nextParsed && targetParsed &&
            compareVersions(nextParsed, targetParsed) > 0
          ) {
            nextChannelVersion = normaliseTag(nextRaw);
          }
        }

        // Releases are read only to enumerate and link. A failure here is
        // still fatal: reporting a drift count that silently omits the list
        // would be worse than reporting nothing.
        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

        const relRes = await fetch(
          `https://api.github.com/repos/${githubRepo}/releases?per_page=${args.pageSize}`,
          { headers, signal: callSignal(timeoutMs, context.signal) },
        );
        if (!relRes.ok) {
          // 403 without a token is nearly always the 60/hour anonymous limit.
          // Say so: the bare status sends people hunting a permissions problem
          // that does not exist.
          const hint = relRes.status === 403 && !githubToken
            ? " (unauthenticated GitHub allows 60 requests/hour per IP; set " +
              "globalArgs.githubToken)"
            : "";
          throw new Error(
            `GitHub releases for ${githubRepo} returned HTTP ${relRes.status}` +
              `${hint}: ${await readErrorBody(relRes)}`,
          );
        }
        const rawReleases = await relRes.json() as Array<
          { tag_name?: string; prerelease?: boolean; html_url?: string }
        >;
        const releases: ReleaseInfo[] = rawReleases
          .filter((r) => typeof r.tag_name === "string")
          .map((r) => ({
            tag: r.tag_name as string,
            prerelease: Boolean(r.prerelease),
            htmlUrl: r.html_url ?? "",
          }));

        const drift = computeDrift(
          running,
          target,
          releases,
          rawReleases.length >= args.pageSize,
        );

        const targetNorm = normaliseTag(target);
        const image = `${imageRepository}:${targetNorm}`;

        // Only worth a registry round-trip when there is something to offer.
        let imageAvailable = true;
        if (drift.behind && args.verifyImage) {
          imageAvailable = await imageTagExists(
            verifyRegistry,
            verifyRepository,
            targetNorm,
            timeoutMs,
            context.signal,
          );
          if (!imageAvailable) {
            logger.warn(
              "{target} is published on npm but {image} is not in the registry yet; a deploy would fail at `compose pull` after stopping the container",
              { target: targetNorm, image },
            );
          }
        }

        const releaseUrl =
          releases.find((r) => normaliseTag(r.tag) === targetNorm)?.htmlUrl ??
            `https://github.com/${githubRepo}/releases`;

        if (nextChannelVersion) {
          logger.info(
            "`next` carries {next}, newer than {target}; not offered",
            { next: nextChannelVersion, target: targetNorm },
          );
        }
        if (drift.truncated) {
          logger.warn(
            "the release page filled up before reaching {running}; releasesBehind={n} is a lower bound",
            { running, n: drift.releasesBehind },
          );
        }
        logger.info(
          "n8n: running={running} {channel}={target} status={status} behind={n} imageAvailable={img}",
          {
            running,
            channel,
            target: targetNorm,
            status: drift.status,
            n: drift.releasesBehind,
            img: imageAvailable,
          },
        );

        const handle = await context.writeResource("drift", "drift-current", {
          runningVersion: running,
          channel,
          latestVersion: targetNorm,
          status: drift.status,
          behind: drift.behind,
          releasesBehind: drift.releasesBehind,
          missedReleases: drift.missedReleases,
          nextChannelVersion,
          imageAvailable,
          image,
          releaseUrl,
          truncated: drift.truncated,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    audit_error_workflows: {
      description:
        "List active, non-archived workflows through the public API and flag any whose settings.errorWorkflow is missing, names a workflow other than the expected handler, or names a handler that is inactive, archived or gone. Read-only: it never attaches a handler.",
      arguments: z.object({
        handlerWorkflowId: z.string().min(1).describe(
          "Id of the error workflow every active workflow should name. It is " +
            "exempt from the audit itself.",
        ),
        pageSize: z.number().int().min(1).max(250).default(100).describe(
          "Workflows per page of the public API list.",
        ),
      }),
      execute: async (
        args: { handlerWorkflowId: string; pageSize: number },
        context: Context,
      ) => {
        const { globalArgs, logger } = context;
        if (!globalArgs.apiKey) {
          // Throw rather than write an empty audit: "no findings" from a check
          // that could not look is the failure this model exists to prevent.
          throw new Error(
            "audit_error_workflows needs globalArgs.apiKey (an n8n public API " +
              "key); without it n8n will not disclose workflow settings",
          );
        }
        const base = globalArgs.baseUrl.replace(/\/+$/, "");

        const handler = await readHandlerState(
          base,
          globalArgs.apiKey,
          args.handlerWorkflowId,
          globalArgs.timeoutMs,
          context.signal,
        );
        const workflows = await listActiveWorkflows(
          base,
          globalArgs.apiKey,
          args.pageSize,
          globalArgs.timeoutMs,
          context.signal,
        );
        const findings = auditErrorWorkflows(
          workflows,
          args.handlerWorkflowId,
          handler,
        );
        const workflowsChecked =
          workflows.filter((w) =>
            w.active && !w.isArchived && w.id !== args.handlerWorkflowId
          ).length;

        if (findings.length > 0) {
          logger.warn(
            "{n} of {checked} active n8n workflows have no usable error workflow",
            { n: findings.length, checked: workflowsChecked },
          );
        } else {
          logger.info(
            "all {checked} active n8n workflows name a usable error workflow",
            { checked: workflowsChecked },
          );
        }

        const handle = await context.writeResource(
          "errorWorkflowAudit",
          "error-workflow-audit-current",
          {
            url: base,
            handlerWorkflowId: args.handlerWorkflowId,
            handlerFound: handler.found,
            handlerActive: handler.active,
            handlerArchived: handler.archived,
            workflowsChecked,
            hasFindings: findings.length > 0,
            findingCount: findings.length,
            findings,
            summary: summariseFindings(findings),
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
