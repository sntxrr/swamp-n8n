import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  auditErrorWorkflows,
  compareVersions,
  computeDrift,
  type HandlerState,
  imageTagExists,
  listActiveWorkflows,
  model,
  normaliseTag,
  parseAuthChallenge,
  parseVersion,
  readDistTags,
  readHandlerState,
  type ReleaseInfo,
  summariseFindings,
  type WorkflowSummary,
} from "./n8n_instance.ts";

/* ------------------------------------------------------------------ *
 * Version parsing
 * ------------------------------------------------------------------ */

Deno.test("parseVersion strips the n8n@ prefix GitHub release tags carry", () => {
  // n8n is a monorepo publishing several packages, so the package name is part
  // of the tag rather than decoration. All three spellings of one version must
  // land on the same parse or every comparison crosses a mismatch.
  const expected = { major: 2, minor: 37, patch: 10, prerelease: null };
  assertEquals(parseVersion("n8n@2.37.10"), expected);
  assertEquals(parseVersion("v2.37.10"), expected);
  assertEquals(parseVersion("2.37.10"), expected);
});

Deno.test("parseVersion fills in missing minor and patch", () => {
  assertEquals(parseVersion("2"), {
    major: 2,
    minor: 0,
    patch: 0,
    prerelease: null,
  });
  assertEquals(parseVersion("2.37"), {
    major: 2,
    minor: 37,
    patch: 0,
    prerelease: null,
  });
});

Deno.test("parseVersion separates prerelease from build metadata", () => {
  assertEquals(parseVersion("2.38.0-rc.1+abc123"), {
    major: 2,
    minor: 38,
    patch: 0,
    prerelease: "rc.1",
  });
  // Build metadata alone is not a prerelease.
  assertEquals(parseVersion("2.38.0+abc123")?.prerelease, null);
});

Deno.test("parseVersion rejects what is not a version", () => {
  for (const bad of ["", "   ", "latest", "next", "2.x", "2.37.10.4", "v"]) {
    assertEquals(parseVersion(bad), null, `expected null for ${bad}`);
  }
});

Deno.test("normaliseTag strips prefixes without parsing", () => {
  assertEquals(normaliseTag("n8n@2.37.10"), "2.37.10");
  assertEquals(normaliseTag("  v2.37.10 "), "2.37.10");
  assertEquals(normaliseTag("2.37.10"), "2.37.10");
});

/* ------------------------------------------------------------------ *
 * Version comparison
 * ------------------------------------------------------------------ */

Deno.test("compareVersions orders numerically, not lexically", () => {
  const lt = (a: string, b: string) =>
    compareVersions(parseVersion(a)!, parseVersion(b)!) < 0;

  // The whole reason this is not a string compare. As strings "2.9.0" sorts
  // ABOVE "2.37.10", which would report an instance 28 minors behind as ahead.
  assertEquals(lt("2.9.0", "2.37.10"), true);
  assertEquals(lt("2.25.7", "2.37.10"), true);
  // And within a minor: "2.37.9" > "2.37.10" as strings.
  assertEquals(lt("2.37.9", "2.37.10"), true);
});

Deno.test("compareVersions sorts a prerelease below its own release", () => {
  const cmp = (a: string, b: string) =>
    compareVersions(parseVersion(a)!, parseVersion(b)!);
  assertEquals(cmp("2.38.0-rc.1", "2.38.0") < 0, true);
  assertEquals(cmp("2.38.0-rc.1", "2.38.0-rc.2") < 0, true);
  assertEquals(cmp("2.37.10", "2.37.10"), 0);
});

/* ------------------------------------------------------------------ *
 * Auth challenge parsing
 * ------------------------------------------------------------------ */

Deno.test("parseAuthChallenge reads the realm a mirror delegates to", () => {
  // Measured from docker.n8n.io on 2026-09-05. Its own /token/ endpoint 404s,
  // so assuming `https://<registry>/token/` -- which the sibling openobserve
  // model does -- cannot authenticate against it at all.
  const header =
    'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",' +
    'scope="repository:n8nio/n8n:pull"';
  assertEquals(parseAuthChallenge(header), {
    realm: "https://auth.docker.io/token",
    service: "registry.docker.io",
  });
});

Deno.test("parseAuthChallenge tolerates a missing service", () => {
  assertEquals(
    parseAuthChallenge('Bearer realm="https://example.test/token"'),
    {
      realm: "https://example.test/token",
      service: null,
    },
  );
});

Deno.test("parseAuthChallenge rejects non-Bearer and realm-less challenges", () => {
  assertEquals(parseAuthChallenge('Basic realm="registry"'), null);
  assertEquals(parseAuthChallenge('Bearer service="registry.docker.io"'), null);
  assertEquals(parseAuthChallenge(""), null);
});

/* ------------------------------------------------------------------ *
 * Drift computation
 * ------------------------------------------------------------------ */

/** Build a release list newest-first, as GitHub returns it. */
function releases(
  ...specs: Array<[version: string, prerelease: boolean]>
): ReleaseInfo[] {
  return specs.map(([v, pre]) => ({
    tag: `n8n@${v}`,
    prerelease: pre,
    htmlUrl: `https://github.com/n8n-io/n8n/releases/tag/n8n%40${v}`,
  }));
}

Deno.test("computeDrift reports behind and names the missed stable releases", () => {
  const d = computeDrift(
    "2.36.7",
    "2.37.10",
    releases(
      ["2.38.3", true],
      ["2.37.10", false],
      ["2.37.9", false],
      ["2.37.6", true],
      ["2.36.9", false],
      ["2.36.8", false],
      ["2.36.7", false],
    ),
    false,
  );
  assertEquals(d.status, "behind");
  assertEquals(d.behind, true);
  // 2.38.3 excluded as a prerelease AND as newer than the target; 2.37.6
  // excluded as a prerelease; 2.36.7 excluded as not newer than running.
  assertEquals(d.missedReleases, ["2.37.10", "2.37.9", "2.36.9", "2.36.8"]);
  assertEquals(d.releasesBehind, 4);
});

Deno.test("computeDrift never counts the pending next-channel minor", () => {
  // The measured 2026-09-05 shape: 2.38.x is published and newer than the
  // stable target. Counting it would both inflate the number and name versions
  // that are deliberately not on offer.
  const d = computeDrift(
    "2.37.9",
    "2.37.10",
    releases(["2.38.3", true], ["2.38.2", true], ["2.37.10", false]),
    false,
  );
  assertEquals(d.releasesBehind, 1);
  assertEquals(d.missedReleases, ["2.37.10"]);
});

Deno.test("computeDrift reports current when running the target", () => {
  const d = computeDrift(
    "2.37.10",
    "2.37.10",
    releases(["2.38.3", true], ["2.37.10", false]),
    false,
  );
  assertEquals(d.status, "current");
  assertEquals(d.behind, false);
  assertEquals(d.releasesBehind, 0);
  assertEquals(d.missedReleases, []);
});

Deno.test("computeDrift reports ahead without claiming a negative gap", () => {
  // Someone pinned a `next` build deliberately. That is not drift, and it must
  // not surface as an alert.
  const d = computeDrift(
    "2.38.3",
    "2.37.10",
    releases(["2.38.3", true], ["2.37.10", false]),
    false,
  );
  assertEquals(d.status, "ahead");
  assertEquals(d.behind, false);
  assertEquals(d.releasesBehind, 0);
});

Deno.test("computeDrift flags truncation when the page never reached running", () => {
  // A full page whose oldest entry is still newer than what is running means
  // the gap continues past what was examined, so the count is a lower bound.
  const d = computeDrift(
    "2.25.7",
    "2.37.10",
    releases(["2.37.10", false], ["2.37.9", false], ["2.36.9", false]),
    true,
  );
  assertEquals(d.truncated, true);
  assertEquals(d.releasesBehind, 3);
});

Deno.test("computeDrift does not flag truncation once running is on the page", () => {
  const d = computeDrift(
    "2.36.9",
    "2.37.10",
    releases(["2.37.10", false], ["2.36.9", false]),
    true,
  );
  assertEquals(d.truncated, false);
});

Deno.test("computeDrift throws rather than reporting a comparison it could not make", () => {
  // The failure this model exists to prevent: an unparseable version must
  // never come back as a reassuring "current".
  assertThrows(
    () => computeDrift("not-a-version", "2.37.10", releases(), false),
    Error,
    "not a recognisable version",
  );
  assertThrows(
    () => computeDrift("2.25.7", "garbage", releases(), false),
    Error,
    "not a recognisable version",
  );
});

/* ------------------------------------------------------------------ *
 * npm dist-tags
 * ------------------------------------------------------------------ */

/** Swap in a stub fetch for one test, restoring the real one after. */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
      ? input.href
      : input;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("readDistTags returns the channels npm publishes", async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          "dist-tags": { latest: "2.37.10", stable: "2.37.10", next: "2.38.3" },
        }),
        { status: 200 },
      ),
    async () => {
      const tags = await readDistTags("n8n", 5000);
      assertEquals(tags.stable, "2.37.10");
      assertEquals(tags.next, "2.38.3");
    },
  );
});

Deno.test("readDistTags throws on a registry error rather than returning empty", async () => {
  await withFetch(
    () => new Response("upstream exploded", { status: 503 }),
    async () => {
      let threw = false;
      try {
        await readDistTags("n8n", 5000);
      } catch (err) {
        threw = true;
        assertEquals((err as Error).message.includes("503"), true);
      }
      assertEquals(threw, true);
    },
  );
});

/* ------------------------------------------------------------------ *
 * Registry existence
 * ------------------------------------------------------------------ */

Deno.test("imageTagExists follows the challenge to the delegated realm", async () => {
  const seen: string[] = [];
  await withFetch((url) => {
    seen.push(url);
    if (url.includes("/manifests/") && !seen.some((u) => u.includes("token"))) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
        },
      });
    }
    if (url.startsWith("https://auth.docker.io/token")) {
      return new Response(JSON.stringify({ token: "t" }), { status: 200 });
    }
    return new Response(null, { status: 200 });
  }, async () => {
    assertEquals(
      await imageTagExists(
        "registry-1.docker.io",
        "n8nio/n8n",
        "2.37.10",
        5000,
      ),
      true,
    );
    // The token was fetched from the realm the challenge named, not from
    // https://registry-1.docker.io/token/.
    assertEquals(
      seen.some((u) => u.startsWith("https://auth.docker.io/token")),
      true,
    );
    assertEquals(
      seen.some((u) => u.includes("registry-1.docker.io/token")),
      false,
    );
  });
});

Deno.test("imageTagExists reports a 404 tag as absent", async () => {
  await withFetch(
    () => new Response(null, { status: 404 }),
    async () => {
      assertEquals(
        await imageTagExists(
          "registry-1.docker.io",
          "n8nio/n8n",
          "9.9.9",
          5000,
        ),
        false,
      );
    },
  );
});

Deno.test("imageTagExists throws on 429 instead of calling the tag absent", async () => {
  // This is the measured behaviour of docker.n8n.io: 429 for every tag,
  // present or not. Folding that into `absent` would suppress every update
  // forever while the check looked healthy.
  await withFetch(
    () => new Response(null, { status: 429 }),
    async () => {
      let threw = false;
      try {
        await imageTagExists("docker.n8n.io", "n8nio/n8n", "2.37.10", 5000);
      } catch (err) {
        threw = true;
        const msg = (err as Error).message;
        assertEquals(msg.includes("429"), true);
        assertEquals(msg.includes("indeterminate"), true);
      }
      assertEquals(threw, true);
    },
  );
});

/* ------------------------------------------------------------------ *
 * Model shape
 * ------------------------------------------------------------------ */

Deno.test("model declares both resources and both methods", () => {
  assertEquals(model.type, "@sntxrr/n8n/instance");
  assertEquals(Object.keys(model.resources).sort(), [
    "drift",
    "errorWorkflowAudit",
    "instance",
  ]);
  assertEquals(Object.keys(model.methods).sort(), [
    "audit_error_workflows",
    "drift",
    "sync",
  ]);
});

Deno.test("instance schema records that n8n disclosed no version", () => {
  // Not cosmetic: `drift` requires an explicit runningVersion, and this field
  // is where the data itself says why.
  const parsed = model.resources.instance.schema.parse({
    url: "http://n8n.test:5678",
    healthy: true,
    status: 200,
    latencyMs: 4,
    settingsMode: "public",
    versionDisclosed: false,
    authenticationMethod: "email",
    ssoEnabled: false,
    detail: '{"status":"ok"}',
    checkedAt: new Date().toISOString(),
  });
  assertEquals(
    (parsed as { versionDisclosed: boolean }).versionDisclosed,
    false,
  );
});

/* ------------------------------------------------------------------ *
 * sync — versionDisclosed is derived, not asserted
 * ------------------------------------------------------------------ */

/** Minimal stand-in for the swamp method context, capturing the write. */
function captureContext(written: Record<string, unknown>[]) {
  return {
    globalArgs: {
      baseUrl: "http://n8n.test:5678",
      npmPackage: "n8n",
      channel: "stable",
      githubRepo: "n8n-io/n8n",
      imageRepository: "docker.n8n.io/n8nio/n8n",
      verifyRegistry: "registry-1.docker.io",
      verifyRepository: "n8nio/n8n",
      timeoutMs: 5000,
    },
    logger: { info: () => {}, warn: () => {} },
    writeResource: (
      spec: string,
      _name: string,
      data: Record<string, unknown>,
    ) => {
      // Parse through the declared schema, so a write that does not conform
      // fails the test rather than the operator.
      (model.resources as Record<
        string,
        { schema: { parse: (d: unknown) => unknown } }
      >)[spec]
        .schema.parse(data);
      written.push(data);
      return Promise.resolve({ name: _name });
    },
  };
}

/** Serve /healthz and a /rest/settings payload of the caller's choosing. */
function settingsResponder(settings: Record<string, unknown>) {
  return (url: string) => {
    if (url.endsWith("/healthz")) {
      return new Response('{"status":"ok"}', { status: 200 });
    }
    if (url.endsWith("/rest/settings")) {
      return new Response(JSON.stringify({ data: settings }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
}

Deno.test("sync reports versionDisclosed false for n8n's real public payload", async () => {
  // The exact key set measured against n8n 2.25.7 on 2026-09-05.
  const written: Record<string, unknown>[] = [];
  await withFetch(
    settingsResponder({
      settingsMode: "public",
      userManagement: { authenticationMethod: "email" },
      sso: { saml: { loginEnabled: false }, ldap: { loginEnabled: false } },
      enterprise: {},
      communityNodesEnabled: true,
    }),
    async () => {
      // deno-lint-ignore no-explicit-any
      await (model.methods.sync.execute as any)({}, captureContext(written));
    },
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].versionDisclosed, false);
  assertEquals(written[0].settingsMode, "public");
  assertEquals(written[0].authenticationMethod, "email");
  assertEquals(written[0].ssoEnabled, false);
});

Deno.test("sync reports versionDisclosed true if n8n ever starts disclosing one", async () => {
  // The whole reason this field is derived rather than hardcoded false. If a
  // release starts answering with a version, this must notice -- otherwise the
  // data keeps insisting `drift` needs its argument long after it stopped
  // being true.
  const written: Record<string, unknown>[] = [];
  await withFetch(
    settingsResponder({ settingsMode: "public", versionCli: "2.37.10" }),
    async () => {
      // deno-lint-ignore no-explicit-any
      await (model.methods.sync.execute as any)({}, captureContext(written));
    },
  );
  assertEquals(written[0].versionDisclosed, true);
});

Deno.test("sync records a down instance as a health result, not an error", async () => {
  // A refused connection must not throw: a down instance and a broken check
  // have to stay distinguishable.
  const written: Record<string, unknown>[] = [];
  await withFetch(
    () => {
      throw new TypeError("connection refused");
    },
    async () => {
      // deno-lint-ignore no-explicit-any
      await (model.methods.sync.execute as any)({}, captureContext(written));
    },
  );
  assertEquals(written[0].healthy, false);
  assertEquals(written[0].status, 0);
  assertEquals(written[0].versionDisclosed, false);
});

Deno.test("drift schema accepts a full behind result", () => {
  const parsed = model.resources.drift.schema.parse({
    runningVersion: "2.25.7",
    channel: "stable",
    latestVersion: "2.37.10",
    status: "behind",
    behind: true,
    releasesBehind: 12,
    missedReleases: ["2.37.10", "2.37.9"],
    nextChannelVersion: "2.38.3",
    imageAvailable: true,
    image: "docker.n8n.io/n8nio/n8n:2.37.10",
    releaseUrl: "https://github.com/n8n-io/n8n/releases",
    truncated: true,
    checkedAt: new Date().toISOString(),
  });
  assertEquals((parsed as { behind: boolean }).behind, true);
});

/* ------------------------------------------------------------------ *
 * audit_error_workflows
 * ------------------------------------------------------------------ */

const HANDLER = "handlerWf0000001";
const USABLE: HandlerState = { found: true, active: true, archived: false };

function wf(
  id: string,
  errorWorkflow: string | null,
  extra: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    id,
    name: `wf ${id}`,
    active: true,
    isArchived: false,
    errorWorkflow,
    ...extra,
  };
}

Deno.test("auditErrorWorkflows passes a workflow that names a usable handler", () => {
  // The positive control: the handler plus one correctly attached workflow.
  assertEquals(
    auditErrorWorkflows(
      [wf(HANDLER, null), wf("bridge", HANDLER)],
      HANDLER,
      USABLE,
    ),
    [],
  );
});

Deno.test("auditErrorWorkflows exempts the handler itself", () => {
  // The handler has no errorWorkflow of its own and must not be flagged.
  assertEquals(auditErrorWorkflows([wf(HANDLER, null)], HANDLER, USABLE), []);
});

Deno.test("auditErrorWorkflows flags missing and wrong handlers", () => {
  const findings = auditErrorWorkflows(
    [wf("b", "someOtherWf"), wf("a", null), wf("c", HANDLER)],
    HANDLER,
    USABLE,
  );
  assertEquals(findings, [
    { id: "a", name: "wf a", reason: "missing", errorWorkflow: null },
    {
      id: "b",
      name: "wf b",
      reason: "wrong-handler",
      errorWorkflow: "someOtherWf",
    },
  ]);
});

Deno.test("auditErrorWorkflows ignores inactive and archived workflows", () => {
  assertEquals(
    auditErrorWorkflows(
      [
        wf("off", null, { active: false }),
        wf("gone", null, { isArchived: true }),
      ],
      HANDLER,
      USABLE,
    ),
    [],
  );
});

Deno.test("auditErrorWorkflows flags every workflow when the handler is unusable", () => {
  // An archived or deactivated handler silently uncovers everything that
  // names it, so each one is listed rather than one easily-missed flag.
  for (
    const state of [
      { found: true, active: false, archived: false },
      { found: true, active: false, archived: true },
      { found: false, active: false, archived: false },
    ]
  ) {
    const findings = auditErrorWorkflows([wf("x", HANDLER)], HANDLER, state);
    assertEquals(findings.map((f) => f.reason), ["handler-unusable"]);
  }
});

Deno.test("summariseFindings writes one line per finding", () => {
  assertEquals(
    summariseFindings([
      { id: "a", name: "Alpha", reason: "missing", errorWorkflow: null },
      { id: "b", name: "Beta", reason: "wrong-handler", errorWorkflow: "z" },
    ]),
    'a "Alpha": missing\nb "Beta": wrong-handler',
  );
  assertEquals(summariseFindings([]), "");
});

Deno.test("listActiveWorkflows follows nextCursor and sends the key", async () => {
  const seen: { url: string; key: string | null }[] = [];
  await withFetch((url, init) => {
    const key = new Headers(init?.headers).get("X-N8N-API-KEY");
    seen.push({ url, key });
    const cursor = new URL(url).searchParams.get("cursor");
    const body = cursor === null
      ? {
        data: [{ id: "a", name: "A", active: true, settings: {} }],
        nextCursor: "p2",
      }
      : {
        data: [{
          id: "b",
          name: "B",
          active: true,
          settings: { errorWorkflow: HANDLER },
        }],
        nextCursor: null,
      };
    return new Response(JSON.stringify(body), { status: 200 });
  }, async () => {
    const list = await listActiveWorkflows(
      "http://n8n.test:5678",
      "k",
      1,
      5000,
    );
    assertEquals(list.map((w) => [w.id, w.errorWorkflow]), [["a", null], [
      "b",
      HANDLER,
    ]]);
  });
  assertEquals(seen.length, 2);
  assertEquals(seen.every((s) => s.key === "k"), true);
  assertEquals(new URL(seen[0].url).searchParams.get("active"), "true");
});

Deno.test("listActiveWorkflows throws on 401 instead of reporting a clean audit", async () => {
  await withFetch(
    () => new Response('{"message":"unauthorized"}', { status: 401 }),
    async () => {
      let threw = false;
      try {
        await listActiveWorkflows("http://n8n.test:5678", "bad", 100, 5000);
      } catch (err) {
        threw = true;
        assertEquals((err as Error).message.includes("401"), true);
      }
      assertEquals(threw, true);
    },
  );
});

Deno.test("listActiveWorkflows refuses a cursor that never ends", async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ data: [], nextCursor: "again" }), {
        status: 200,
      }),
    async () => {
      let threw = false;
      try {
        await listActiveWorkflows(
          "http://n8n.test:5678",
          "k",
          100,
          5000,
          undefined,
          3,
        );
      } catch (err) {
        threw = true;
        assertEquals((err as Error).message.includes("partial"), true);
      }
      assertEquals(threw, true);
    },
  );
});

Deno.test("readHandlerState treats a 404 as a missing handler, not an error", async () => {
  await withFetch(
    () => new Response(null, { status: 404 }),
    async () => {
      assertEquals(
        await readHandlerState("http://n8n.test:5678", "k", HANDLER, 5000),
        { found: false, active: false, archived: false },
      );
    },
  );
});

/** Serve the handler and a workflow list for the method-level tests. */
function apiResponder(list: Record<string, unknown>[]) {
  return (url: string) => {
    const path = new URL(url).pathname;
    if (path === `/api/v1/workflows/${HANDLER}`) {
      return new Response(
        JSON.stringify({
          id: HANDLER,
          name: "handler",
          active: true,
          isArchived: false,
        }),
        { status: 200 },
      );
    }
    if (path === "/api/v1/workflows") {
      return new Response(JSON.stringify({ data: list, nextCursor: null }), {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  };
}

Deno.test("audit_error_workflows writes a schema-valid finding", async () => {
  const written: Record<string, unknown>[] = [];
  const ctx = captureContext(written);
  (ctx.globalArgs as Record<string, unknown>).apiKey = "k";
  await withFetch(
    apiResponder([
      { id: HANDLER, name: "handler", active: true, settings: {} },
      {
        id: "bridge",
        name: "Bridge",
        active: true,
        settings: { errorWorkflow: HANDLER },
      },
      { id: "throwaway", name: "Throwaway", active: true, settings: {} },
    ]),
    async () => {
      // deno-lint-ignore no-explicit-any
      await (model.methods.audit_error_workflows.execute as any)(
        { handlerWorkflowId: HANDLER, pageSize: 100 },
        ctx,
      );
    },
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].hasFindings, true);
  assertEquals(written[0].workflowsChecked, 2);
  assertEquals(written[0].summary, 'throwaway "Throwaway": missing');
});

Deno.test("audit_error_workflows throws without an apiKey", async () => {
  const written: Record<string, unknown>[] = [];
  let threw = false;
  try {
    // deno-lint-ignore no-explicit-any
    await (model.methods.audit_error_workflows.execute as any)(
      { handlerWorkflowId: HANDLER, pageSize: 100 },
      captureContext(written),
    );
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message.includes("apiKey"), true);
  }
  assertEquals(threw, true);
  assertEquals(written.length, 0);
});
