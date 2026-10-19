---
name: creating-plugins
description: Build, test, and publish this sandboxed EmDash plugin. Use for changes to emdash-plugin.jsonc, src/plugin.ts, hooks, routes, capabilities, storage, Block Kit admin UI, bundling, or releases.
---

# Creating EmDash plugins

Read `emdash-plugin.jsonc` and `src/plugin.ts` before editing. The manifest is the identity and trust contract; the source contains runtime hooks and routes.

## Runtime rules

- Assign the runtime definition to a `SandboxedPlugin`-typed constant and export it as default from `src/plugin.ts`.
- Use Web APIs. Do not import Node.js built-ins into plugin runtime code.
- Declare every runtime API in `capabilities` and every network destination in `allowedHosts`.
- Keep media authority narrow: `media:read` exposes safe ready-media metadata and an authenticated ID-based asset URL, `media:bytes:read` exposes bounded bytes and content hashes through `ctx.media.readBytes()`, and `media:metadata:write` changes only alt text, captions, and focal points through `ctx.media.updateMetadata()`. These declarations do not imply one another. Byte reads default to 10 MiB, cannot request more than 16 MiB, and are checked while the host consumes the storage stream.
- Treat `comments:read` as personal-data access. It exposes author email, body, pseudonymous IP hash, user agent, and moderation metadata. Use `comments:moderate` for expected-status moderation; it implies read.
- Use `redirects:read` for paginated redirect inspection. Add `redirects:write` only when the plugin must change visitor destinations, and pass redirect `_rev` values back unchanged for updates and deletes.
- Use `schema:read` for `ctx.schema.listCollections()` and `getCollection()`.
- Use `bylines:read` for public byline profiles and entry credits. `ctx.bylines.getEntriesBylines()` resolves up to 100 entries of one collection per call.
- Use `content:read` for content identity fields, translations, and published public URLs. Public URL resolution never returns previews. Revision history requires the separate `content:revisions:read` capability and excludes revision author identity.
- Create a translation with `ctx.content.create(collection, data, { locale, translationOf })`. The source must be an active row in the same collection. EmDash preserves its non-translatable fields, byline credits, taxonomy assignments, validation, and save hooks, and permits one active row per locale in the group.
- With `taxonomies:write`, pass a taxonomy name and term fields to `createTerm()`. The method rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. Pass term IDs to `addEntryTerms()` and `removeEntryTerms()`; assignment methods apply deltas and do not replace existing terms.
- Use `hooks.content-policy:register` for `content:beforePublish`, `content:beforeSchedule`, or `content:beforeUnpublish`. Return `{ cancel: true, reason }` to reject the action; this capability does not grant content reads, writes, or publication actions.
- Use `content:publish` for revision-fenced publish, unpublish, schedule, and unschedule actions. Use `content:restore` separately for trashed reads and restore. Pass the latest `_rev` to every mutation.
- Use `ctx.storage` for queryable records, `ctx.settings` for user configuration, and `ctx.kv` for internal key-value state.
- Declare credentials as `secret` fields in `admin.settingsSchema`. The host encrypts them with `EMDASH_ENCRYPTION_KEY`; keep that key with operational backups.
- Use Block Kit for sandboxed admin UI. Do not ship browser React components.
- Use structured Block Kit links for navigation. Read `routeCtx.ui` for the host-attested admin locale and direction; external images require HTTPS plus a hostname in `allowedHosts` or `network:request:unrestricted`.
- Declare saved-entry panels and actions under `admin.editorPanels` and `admin.editorActions`. Point each declaration at a private route. The host reloads and authorizes the saved entry before attaching identity to `routeCtx.ui`. Ordinary panel load never includes draft data. Use `admin.editor-draft:read` or `admin.editor-draft:patch` with extension-level collection and field selectors for explicit draft interactions; patch does not imply read, accepted patches are previewed, and the host never saves them automatically. Read saved field data through capability-gated `ctx.content`.
- Treat public routes as internet-facing and validate their inputs.
- Routes without declarations use the legacy method-agnostic JSON/query envelope. Declare `methods` for host-enforced 405 responses.
- Declare `request.body` as `none`, `json`, `text`, `bytes`, or `form-data` for bounded buffered parsing. The default is 1 MiB and the author maximum is 8 MiB. Use `pluginRoute()` for input inference.
- Only safe names declared in `request.headers` cross the sandbox boundary. Credentials, cookies, Cloudflare Access, and CSRF headers never do.
- A route with `response: "raw"` must return `pluginResponse()` from `emdash/plugin` with text or bytes. Raw responses are buffered to 8 MiB; the host keeps only documented representation/download/redirect headers, applies route caching and browser security policy, and rejects active browser content types. Raw routes cannot back MCP tools.
- Treat `ctx.http.fetch()` responses as buffered. Request and response bodies are each limited to 8 MiB of decoded bytes, with binary bytes preserved across both sandbox runners.

## Validation

Use the package scripts in this repository. The default test script builds the plugin and runs it through Worker Loader, EmDash's production sandbox wrapper, and the host bridge.

Use `createPluginTestHost()` for direct transport tests of hooks, routes, capability enforcement, KV, and declared storage. Use `createPluginRuntimeTestHost()` when a test must trigger real content, plugin activation, media, comment, scheduler, restart, authorization, CSRF, cache behavior, or Block Kit response validation. Its `admin` helpers cover pages, widgets, saved-entry panels, confirmed editor actions, forms, host-attested locale context, and editor draft capture and patch validation. Runtime fixtures do not fire hooks; runtime actions call production boundaries; inspectors read observable state.

For generated secret settings, call `actions.plugin.updateSettings()` and verify `inspect.settings.raw()` contains an envelope without the plaintext.

For redirect capability tests, use `host.fixtures.redirect()` to establish redirect state and `host.inspect.redirects()` to assert persisted rules. Invoke the plugin through `host.actions.routes.request()` when the test must cover the authorized host route and sandbox bridge.

For declared route-body tests, pass text, bytes, URL-encoded data, or `FormData` as `rawBody` to `host.actions.routes.request()`. Use `body` for the legacy JSON path.

For outbound HTTP tests, queue one response per call with `await host.http.respond(url, response)` and inspect the decoded request through `host.http.requests()`. The plugin call still crosses Worker Loader and the production bridge.

Dispose either host after each test so its bindings reset. Keep Node/workerd parity opt-in unless the plugin depends on runner-sensitive behavior.

Read generated settings with `ctx.settings.get("<key>")`. Existing `ctx.kv.get("settings:<key>")` reads remain compatible throughout EmDash 1.x, but new code should use `ctx.settings`.

Before handing off a change, run validation, typecheck, tests, and build. A release also requires a version bump in `package.json` when runtime behavior or the trust contract changes.

## Publishing

Use the local publish script for a release started from this computer. CLI output identifies registry packages as `@<publisher-handle>/<slug>` and prints an `emdash-plugin info <handle> <slug> --version <version> --watch` command for listing checks. Use the release-setup script for GitHub Actions. Setup detects a root Changesets configuration and offers to follow packages released by Changesets; otherwise it uses package tags. Connect the generated reusable workflow to the existing Changesets publish job by passing its published-package output. Changesets Action v1 names the step output `publishedPackages`; v2 names it `published-packages`. Expose it as a `published-packages` job output and pass it to the generated workflow from a dependent job when Changesets reports `published == 'true'`. The first automated release connects the repository workflow; later packages reuse it only when their signed profiles name the same repository.

For complete EmDash patterns and API details, use https://docs.emdashcms.com/plugins/creating-plugins/.
