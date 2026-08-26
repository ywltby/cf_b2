# Shortlink / Mapper Worker Split Implementation Plan

> **Status:** Implemented, then simplified on 2026-08-26. The mapper now only handles `GET|HEAD /<key>` with `B_BUCKET_ID`; `/` returns `404`, all non-empty paths are ordinary object keys, and the speed page, dedicated business-path branches, extra bucket vars, and reserved namespaces were removed. The detailed steps below are retained as implementation history and must not be replayed as the current specification.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the current combined Worker into a stateful shortlink Worker and a stateless mapper Worker while preserving every public route and keeping the real B2 object key hidden behind `/s/<id>`.

**Architecture:** Keep one repository and two explicit module entrypoints instead of a runtime role flag. `src/shortlink.js` owns D1, admin APIs, `/s/<id>`, and Cron; `src/mapper.js` owns the speed page and all public path-to-B2 routes. Both import the existing SigV4, streaming, Range, cache, validation, and error-sanitization code from `src/b2.js`.

**Tech Stack:** Cloudflare Workers ES modules, Wrangler 4.54.0, D1, Cache API, `aws4fetch`, Vitest, `@cloudflare/vitest-pool-workers`.

> **2026-08-26 amendment:** The legacy `/b/<key> → image/<key>` alias was removed after the split. Mapper fallback paths now map exactly to the same B2 object key.

---

## Confirmed decisions

- Keep `/s/<id>` behavior unchanged: resolve D1 and stream B2 from the shortlink Worker. Do not redirect, expose the object key, or introduce an encrypted handoff token in this change.
- Horizontally replicate only the stateless mapper Worker across Cloudflare accounts.
- Keep `wrangler.toml` as the default shortlink configuration so existing `npm run dev` and `npm run deploy` remain valid.
- Add `wrangler.mapper.toml` for the mapper Worker; use `-c wrangler.mapper.toml` for mapper commands.
- Do not duplicate the SigV4 implementation or create two repositories.
- Preserve the current route behavior for `/chapter-content/`, `/book-export/`, `/`, and the fallback `/<key>` mapping.
- Reserve `/s`, `/api`, and `/admin` namespaces in the mapper and fail closed with `404`, including percent-encoded spellings.
- Use only the read-only credentials embedded in `BUCKETS` for B2 access. Each configured key has no file-prefix restriction; do not keep separate direct-read or book-export Secrets.
- Keep the existing compatibility date during this refactor. Updating runtime compatibility or migrating TOML to JSONC is a separate change.
- Preserve and integrate the user's current uncommitted edits to `.dev.vars.template` and `README.md`; never overwrite them wholesale.
- Do not commit, deploy, change EdgeOne, or mutate remote Secrets unless the user explicitly authorizes that phase.

## Target layout

```text
src/
  b2.js              shared S3/B2 signing and delivery code
  mapper.js          stateless mapper entrypoint
  shortlink.js       stateful shortlink entrypoint
  speed-test.js      existing speed-test page

wrangler.toml        shortlink Worker; existing default deployment
wrangler.mapper.toml mapper Worker; no D1 or Cron
```

No `src/shortlink/` or `src/mapper/` subdirectories are needed while each role has only one entrypoint.

## Runtime routing

```text
s.o7n.cn/api/*        -> s.514996.xyz          -> shortlink Worker
s.o7n.cn/admin        -> s.514996.xyz          -> shortlink Worker
s.o7n.cn/s/*          -> s.514996.xyz          -> shortlink Worker -> D1 -> B2
s.o7n.cn/*            -> mapper origin group   -> mapper Worker    -> B2
```

The mapper source group can contain `m.514996.xyz` and additional mapper origins from other Cloudflare accounts. Each origin must receive its own Host header.

---

### Task 1: Record the baseline and protect the dirty worktree

**Files:**

- Inspect: `.dev.vars.template`
- Inspect: `README.md`
- Inspect: `index.js`
- Inspect: `wrangler.toml`
- Inspect: `test/*.test.js`

**Step 1: Record existing changes**

Run:

```powershell
git status --short
git diff -- .dev.vars.template README.md
```

Expected: only the already-known template and README edits appear before implementation begins.

**Step 2: Run the current baseline**

Run:

```powershell
npm test
npx wrangler deploy --dry-run -c wrangler.toml
```

Expected: all 66 current tests pass and the combined Worker bundles successfully.

**Step 3: Stop on unrelated failures**

If either command fails before source changes, diagnose that failure first. Do not hide it inside the split refactor.

---

### Task 2: Extract the shared B2 delivery module without changing behavior

**Files:**

- Create: `src/b2.js`
- Create: `src/speed-test.js`
- Modify: `index.js`
- Delete later: `speed-test.js`
- Test: all existing tests

**Step 1: Move the speed-test module**

Move the existing implementation unchanged from `speed-test.js` to `src/speed-test.js`, then update the temporary combined entrypoint import:

```js
import { speedTestPage } from './src/speed-test.js'
```

Run:

```powershell
npx vitest run test/direct.test.js
```

Expected: the root speed-page test passes.

**Step 2: Extract the shared origin code**

Move, without semantic changes, the following code from `index.js` into `src/b2.js`:

- `AwsClient` import and origin/header constants.
- `noStore`.
- RFC3986 key encoding and origin URL construction.
- S3 client construction.
- response-header whitelist and `Content-Disposition` generation.
- `requestedDownloadFilename`.
- upstream error mapping.
- strict Range retry logic.
- `deliverOriginObject`.
- integer variable parsing and endpoint validation.
- memoized `BUCKETS` registry parsing.
- object-key decoding and normalization.
- prefix normalization and `handlePublicBucket`.

Export only the symbols used by an entrypoint:

```js
export {
  NO_PREFIX,
  decodePathKey,
  deliverOriginObject,
  getBuckets,
  handlePublicBucket,
  intVar,
  normalizeKey,
  noStore,
  parseEndpoint,
  requestedDownloadFilename,
}
```

Keep module-level memoization only for parsed immutable `BUCKETS` configuration; do not introduce request-scoped global state.

**Step 3: Rewire the temporary combined entrypoint**

Import the extracted functions into `index.js`. Keep its public routing unchanged at this checkpoint.

**Step 4: Verify the behavior-preserving extraction**

Run:

```powershell
npm test
```

Expected: all existing tests still pass with no expected-output changes.

**Checkpoint:** If the user has authorized commits, commit only this behavior-preserving extraction; otherwise leave it uncommitted.

---

### Task 3: Add the stateless mapper entrypoint

**Files:**

- Create: `src/mapper.js`
- Create: `test/worker-boundaries.test.js`
- Modify: `test/chapter-content.test.js`
- Modify: `test/book-export.test.js`
- Modify: `test/direct.test.js`

**Step 1: Write the failing mapper-boundary tests**

Create `test/worker-boundaries.test.js` with direct module tests:

```js
import { env, createExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import mapper from '../src/mapper.js'

const statefulPaths = [
  '/s/example',
  '/api/sign',
  '/api/revoke',
  '/admin',
  '/%73/example',
  '/%61pi/sign',
  '/ad%6din',
]

for (const path of statefulPaths) {
  test(`mapper rejects stateful namespace ${path}`, async () => {
    const response = await mapper.fetch(
      new Request(`https://mapper.example.com${path}`),
      env,
      createExecutionContext(),
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
  })
}
```

Run:

```powershell
npx vitest run test/worker-boundaries.test.js
```

Expected: FAIL because `src/mapper.js` does not exist.

**Step 2: Implement the mapper router**

Create `src/mapper.js` using the existing routing order:

1. Reject stateful namespaces before any B2 fallback.
2. Handle `/chapter-content/<key>`.
3. Handle `/book-export/<key>` with its configured `BUCKETS` entry.
4. Reject methods other than GET and HEAD.
5. Return the speed page for `/`.
6. Decode fallback paths once, reject decoded reserved routes, and map the remaining key to `B_BUCKET_ID` with its `BUCKETS` credentials.

Use a strict namespace guard:

```js
const STATEFUL_NAMESPACE = /^\/(?:s(?:\/|$)|api(?:\/|$)|admin(?:\/|$))/

function isReservedPath(path) {
  return (
    STATEFUL_NAMESPACE.test(path) ||
    CHAPTER_CONTENT_ROUTE.test(path) ||
    BOOK_EXPORT_ROUTE.test(path)
  )
}
```

Apply `isReservedPath()` to both the raw pathname and `/${decodedKey}` so percent encoding cannot bypass fixed route prefixes or reach the B2 fallback.

**Step 3: Point stateless tests at the mapper**

Change imports from `../index.js` to `../src/mapper.js` in:

- `test/chapter-content.test.js`
- `test/direct.test.js`

In `test/book-export.test.js`, use the mapper for direct `/book-export/` cases but leave the `/s/bookexport01` case on the temporary combined entrypoint until Task 4.

**Step 4: Run mapper tests**

Run:

```powershell
npx vitest run test/worker-boundaries.test.js test/direct.test.js test/chapter-content.test.js test/book-export.test.js
```

Expected: all mapper and public-route tests pass; the existing shortlink book-export case also remains green.

---

### Task 4: Add the stateful shortlink entrypoint

**Files:**

- Create: `src/shortlink.js`
- Modify: `test/worker-boundaries.test.js`
- Modify: `test/admin.test.js`
- Modify: `test/book-export.test.js`
- Modify: `test/deliver.test.js`
- Modify: `test/errors.test.js`
- Modify: `test/head.test.js`
- Modify: `test/range.test.js`
- Modify: `test/revoke.test.js`
- Modify: `test/routing.test.js`
- Modify: `test/scheduled.test.js`
- Modify: `test/sign.test.js`
- Modify: `vitest.config.js`
- Modify: `wrangler.toml`

**Step 1: Extend the boundary tests and verify failure**

Add a `shortlink` import and verify it refuses mapper-only paths:

```js
import shortlink from '../src/shortlink.js'

for (const path of ['/', '/object.bin', '/b/x', '/chapter-content/x']) {
  test(`shortlink rejects mapper path ${path}`, async () => {
    const response = await shortlink.fetch(
      new Request(`https://shortlink.example.com${path}`),
      env,
      createExecutionContext(),
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
}
```

Run:

```powershell
npx vitest run test/worker-boundaries.test.js
```

Expected: FAIL because `src/shortlink.js` does not exist.

**Step 2: Implement the shortlink router**

Move the following responsibilities from `index.js` into `src/shortlink.js`:

- `/api/sign` and admin authentication.
- `/api/revoke`.
- `/admin` HTML.
- `/s/<id>` D1 resolution, expiry handling, lazy deletion, filename handling, and direct streaming through `deliverOriginObject`.
- ID generation.
- exported `cleanupExpired` and the scheduled handler.

Unknown paths must return `404` with `cache-control: no-store`; they must never fall through to a B2 object lookup.

Do not change the D1 schema, short ID format, expiration semantics, cache identity, Range behavior, response headers, or `Content-Disposition` behavior.

**Step 3: Point stateful tests at the shortlink entrypoint**

Update direct module imports to `../src/shortlink.js`. Change `vitest.config.js` and `wrangler.toml` so their `main` value is `src/shortlink.js`; this keeps `SELF` tests exercising the actual shortlink production entrypoint.

In `test/book-export.test.js`, import both entrypoints explicitly:

```js
import mapper from '../src/mapper.js'
import shortlink from '../src/shortlink.js'
```

Use `shortlink` only for `/s/bookexport01` and `mapper` for direct `/book-export/` tests.

**Step 4: Run the stateful tests**

Run:

```powershell
npx vitest run test/admin.test.js test/deliver.test.js test/errors.test.js test/head.test.js test/range.test.js test/revoke.test.js test/routing.test.js test/scheduled.test.js test/sign.test.js test/book-export.test.js test/worker-boundaries.test.js
```

Expected: all tests pass and `/s/<id>` still returns the object body rather than a redirect.

---

### Task 5: Split deployment configuration and Secrets by responsibility

**Files:**

- Modify: `wrangler.toml`
- Create: `wrangler.mapper.toml`
- Modify: `.dev.vars.template`
- Create: `.dev.vars.mapper.template`
- Modify: `.gitignore`

**Step 1: Reduce the shortlink configuration**

Keep these shortlink vars in `wrangler.toml`:

```toml
[vars]
CACHE_TTL_SECONDS = "86400"
TOKEN_TTL_SECONDS = "3600"
TOKEN_ID_LENGTH = "16"
PUBLIC_BASE_URL = "https://s.o7n.cn"
```

Keep the existing `DB` binding, migrations directory, Cron trigger, route `s.514996.xyz`, and observability settings.

Document only these shortlink Secrets:

- `BUCKETS`
- `ADMIN_PASSWORD`

Remove mapper-only vars and secret comments from this configuration.

**Step 2: Add the primary mapper configuration**

Create `wrangler.mapper.toml`:

```toml
name = "cf-b2-mapper"
main = "src/mapper.js"
compatibility_date = "2024-09-01"
workers_dev = false
routes = [{ pattern = "m.514996.xyz", custom_domain = true }]

[vars]
CACHE_TTL_SECONDS = "86400"
B_BUCKET_ID = "1145141919810"
CHAPTER_CONTENT_BUCKET_ID = "1145141919810"
BOOK_EXPORT_BUCKET_ID = "1145141919810"

[observability.logs]
enabled = true
invocation_logs = true
```

It must not contain a D1 binding, migrations, Cron, `PUBLIC_BASE_URL`, token settings, or admin settings.

Document only these mapper Secrets:

- `BUCKETS`

Every `BUCKETS` item uses a read-only key without a file-prefix restriction so all routes targeting that bucket id can share it.

`m.514996.xyz` is the proposed primary mapper origin; confirm that hostname immediately before the deployment phase.

**Step 3: Split local secret templates**

Retain the current placeholder values and comments, but make `.dev.vars.template` shortlink-only. Add `.dev.vars.mapper.template` containing only mapper Secrets. Never place a real key in either file.

Add `.dev.vars.mapper` to `.gitignore` for local filled values.

**Step 4: Validate both configurations without deployment**

Run:

```powershell
npx wrangler deploy --dry-run -c wrangler.toml
npx wrangler deploy --dry-run -c wrangler.mapper.toml
```

Expected: both bundles succeed; the mapper bundle reports no D1 or Cron binding.

---

### Task 6: Remove the combined entrypoint and update developer commands

**Files:**

- Delete: `index.js`
- Delete: `speed-test.js`
- Modify: `scripts/check-no-buffering.mjs`
- Modify: `scripts/check-download-filename.mjs`
- Modify: `package.json`

**Step 1: Update the streaming guard**

Make `scripts/check-no-buffering.mjs` inspect these files with Node's standard library:

```js
const files = [
  new URL('../src/b2.js', import.meta.url),
  new URL('../src/shortlink.js', import.meta.url),
  new URL('../src/mapper.js', import.meta.url),
]
const raw = files.map((file) => readFileSync(file, 'utf8')).join('\n')
```

Retain the existing forbidden upstream-body checks and require the streaming pattern in `src/b2.js`.

**Step 2: Update the filename guard**

Change its import to:

```js
import { requestedDownloadFilename } from '../src/b2.js'
```

**Step 3: Add explicit mapper scripts**

Update `package.json`:

```json
{
  "main": "src/shortlink.js",
  "scripts": {
    "deploy": "wrangler deploy",
    "deploy:mapper": "wrangler deploy -c wrangler.mapper.toml",
    "dev": "wrangler dev",
    "dev:mapper": "wrangler dev -c wrangler.mapper.toml"
  }
}
```

Keep the existing test, formatting, and pretest scripts.

**Step 4: Remove compatibility files**

Run:

```powershell
rg -n "index\.js|speed-test\.js" package.json wrangler.toml wrangler.mapper.toml vitest.config.js test scripts src
```

Update any remaining stale imports, then delete the root `index.js` and `speed-test.js`. Do not leave a role-flag compatibility wrapper.

**Step 5: Run all local checks**

Run:

```powershell
npm test
```

Expected: static guards and the complete Vitest suite pass.

---

### Task 7: Update documentation for the two deployment roles

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `docs/plans/2026-05-25-d1-shortlink-cdn-gateway.md`

**Step 1: Document role and route ownership**

Add a compact table covering:

| Role      | Routes                                                | Stateful resources |
| --------- | ----------------------------------------------------- | ------------------ |
| shortlink | `/api/sign`, `/api/revoke`, `/admin`, `/s/<id>`       | D1, Cron           |
| mapper    | `/`, `/<key>`, `/chapter-content/*`, `/book-export/*` | none               |

State explicitly that `/s/<id>` never redirects to or exposes a B2 key.

**Step 2: Document commands and secret files**

Include exact local and deployment commands:

```powershell
npm run dev
npm run dev:mapper
npx wrangler secret bulk .dev.vars -c wrangler.toml
npx wrangler secret bulk .dev.vars.mapper -c wrangler.mapper.toml
npm run deploy
npm run deploy:mapper
```

Explain that additional mapper accounts deploy the same `src/mapper.js` with account-specific Wrangler configuration and origin hostname, but do not create or copy D1.

**Step 3: Document EdgeOne routing and failure behavior**

Document stateful path rules before the default mapper rule. Require origin Host to follow each origin domain. Note that direct mapper origins intentionally expose exact B2 paths, while the shortlink origin does not.

**Step 4: Record the change**

Add an Unreleased changelog entry for the deployment split without claiming it is deployed.

---

### Task 8: Perform final local verification

**Files:** all changed files

**Step 1: Format and inspect**

Run:

```powershell
npm run format
npx prettier --check '**/*.{js,css,json,md}'
git diff --check
git status --short
```

Expected: formatting passes, no whitespace errors, and unrelated files remain untouched.

**Step 2: Run the full tests**

Run:

```powershell
npm test
```

Expected: every test passes, including both role-boundary tests.

**Step 3: Dry-run both deployments**

Run:

```powershell
npx wrangler deploy --dry-run -c wrangler.toml
npx wrangler deploy --dry-run -c wrangler.mapper.toml
```

Expected: both Workers bundle successfully.

**Step 4: Audit binding separation**

Run:

```powershell
rg -n "DB|d1_databases|crons|ADMIN_PASSWORD|TOKEN_TTL_SECONDS|TOKEN_ID_LENGTH" wrangler.mapper.toml src/mapper.js
rg -n "B_BUCKET_ID|CHAPTER_CONTENT_BUCKET_ID|BOOK_EXPORT_BUCKET_ID" wrangler.toml src/shortlink.js
```

Expected: both commands return no matches.

**Step 5: Request review before remote changes**

Present the diff and verification results. Do not deploy until the user approves the implementation and provides or confirms the mapper origin hostname.

---

### Task 9: Deploy and cut over without interrupting existing shortlinks

This task requires explicit user authorization because it changes Cloudflare and EdgeOne production state.

**Step 1: Deploy the primary mapper first**

Prepare a local, ignored `.dev.vars.mapper`, then run:

```powershell
npx wrangler deploy -c wrangler.mapper.toml
npx wrangler secret bulk .dev.vars.mapper -c wrangler.mapper.toml
```

The repository currently pins Wrangler 4.54.0, whose local `deploy` command does not expose the newer `--secrets-file` option. Therefore the first deploy creates the Worker and custom domain before `secret bulk` activates its required values. Do this before adding the origin to EdgeOne; until Secrets are present, mapper requests must fail closed.

Verify:

```powershell
curl.exe -I https://m.514996.xyz/
curl.exe -I https://m.514996.xyz/s/test
curl.exe -sS -D - -o NUL -H "Range: bytes=0-0" https://m.514996.xyz/BLM-008.mp4
```

Expected: root `200`, reserved shortlink path `404`, and test object `206` with one byte.

**Step 2: Configure EdgeOne path routing**

Before changing the existing Worker, configure:

- `/api/*` -> `s.514996.xyz`
- exact `/admin` -> `s.514996.xyz`
- `/s/*` -> `s.514996.xyz`
- default `/*` -> mapper source group

Initially place only the verified primary mapper in the source group. Keep Host Header set to follow the selected origin domain.

**Step 3: Verify public behavior while the old combined Worker still exists**

Verify the speed page, direct object, one-byte Range, existing shortlink, admin page, and sign/revoke APIs through `https://s.o7n.cn`. At this point rollback is only an EdgeOne origin-rule change.

**Step 4: Deploy the shortlink-only entrypoint**

Prepare `.dev.vars` with shortlink-only Secrets, then run:

```powershell
npx wrangler secret bulk .dev.vars -c wrangler.toml
npx wrangler deploy -c wrangler.toml
```

Re-run the public checks. Confirm `https://s.514996.xyz/<ordinary-key>` now returns `404`, while `https://s.o7n.cn/<ordinary-key>` still succeeds through mapper routing.

**Step 5: Add the second-account mapper**

Create an account-specific copy of the mapper Wrangler configuration with:

- the same `main = "src/mapper.js"`;
- the second account ID supplied through `CLOUDFLARE_ACCOUNT_ID` or local config;
- a custom origin hostname owned by the second account;
- no D1 binding or migration.

Deploy it once to create the Worker, upload the same mapper-only Secrets, verify it directly, and only then add it to the EdgeOne mapper source group. Start with conservative weights, confirm equivalent Range/status/header behavior, then move to the desired distribution.

**Step 6: Observe before removing rollback material**

Keep the original combined Worker's four legacy B2 Secrets through the agreed rollback window. After both mapper origins and EdgeOne routing are stable, delete them from the shortlink Worker:

```powershell
npx wrangler secret delete DIRECT_B2_KEY_ID -c wrangler.toml
npx wrangler secret delete DIRECT_B2_APPLICATION_KEY -c wrangler.toml
npx wrangler secret delete BOOK_EXPORT_KEY_ID -c wrangler.toml
npx wrangler secret delete BOOK_EXPORT_APPLICATION_KEY -c wrangler.toml
```

Do not delete `BUCKETS`; `/s/<id>` still streams B2 directly with the credentials stored there.

**Step 7: Rollback procedure**

If mapper delivery fails:

1. Before the shortlink-only deployment, pointing EdgeOne's default route back to `s.514996.xyz` is sufficient.
2. After the shortlink-only deployment, first use Wrangler rollback to restore the combined Worker version, then point EdgeOne's default route back to `s.514996.xyz`.
3. If the four legacy Secrets were already removed, restore them before rolling back to the old combined Worker and sending direct traffic back.
4. Remove the failing mapper origin from the source group.
5. Do not modify D1; the split introduces no D1 migration.

---

## Acceptance criteria

- Existing `/s/<id>` URLs, expiration, revocation, filename, Range, HEAD, and streaming behavior are unchanged.
- A client using `/s/<id>` never receives the B2 endpoint, bucket name, or object key in a redirect, response body, or error.
- The shortlink Worker has no public path-to-B2 fallback.
- The mapper Worker has no D1, Cron, admin secret, or token configuration.
- Mapper stateful namespaces fail closed before direct path mapping, including encoded variants.
- All stateless public routes preserve their existing bucket selection, fixed prefixes, and priority.
- Both Wrangler configurations pass dry-run independently.
- Additional Cloudflare accounts can deploy the mapper without creating or synchronizing D1.
- EdgeOne can distribute mapper traffic while keeping stateful routes pinned to the shortlink Worker.

## Deferred work

- Offloading `/s/<id>` response bodies to mapper replicas.
- AES-GCM opaque handoff tokens.
- Cross-account shortlink/D1 active-active replication.
- Wrangler TOML-to-JSONC migration or compatibility-date upgrade.
- Automated EdgeOne configuration.

Add any deferred feature only after traffic measurements show that the shortlink Worker, rather than direct mapper traffic, is the actual bottleneck.
