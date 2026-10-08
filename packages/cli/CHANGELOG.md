# Changelog

Entries through 0.45.0 come from the [original CLI changelog at its 0.45.0 tag](https://github.com/getsentry/cli/blob/0.45.0/CHANGELOG.md).

<!-- Craft generates notes for each CLI release. -->
## 0.47.0

### New Features ✨

#### Cli

- Add replay download command by @gggritso in [#1392](https://github.com/getsentry/toolkit/pull/1392)
- Add dsn list command by @betegon in [#1365](https://github.com/getsentry/toolkit/pull/1365)
- Add feedback spam command by @betegon in [#1372](https://github.com/getsentry/toolkit/pull/1372)
- Add feedback unresolve command by @betegon in [#1369](https://github.com/getsentry/toolkit/pull/1369)
- Add feedback resolve command by @betegon in [#1366](https://github.com/getsentry/toolkit/pull/1366)

#### Other

- (search) Split search_events into dataset-specific tools by @sentry-junior in [#1374](https://github.com/getsentry/toolkit/pull/1374)

### Bug Fixes 🐛

#### Cli

- Validate repository list responses by @betegon in [#1364](https://github.com/getsentry/toolkit/pull/1364)
- Preserve a 401 on the final request attempt by @betegon in [#1370](https://github.com/getsentry/toolkit/pull/1370)

#### Other

- (api) Accept null legacy event context by @betegon in [#1353](https://github.com/getsentry/toolkit/pull/1353)
- (cloudflare) Upload built Worker and SPA assets by @BYK in [#1400](https://github.com/getsentry/toolkit/pull/1400)

### Internal Changes 🔧

- Update SDK to v11.1.0 and migrate tags to attributes by @JPeer264 in [#1347](https://github.com/getsentry/toolkit/pull/1347)

### Other

- Install CLI nightlies from Toolkit GHCR by @BYK in [#1403](https://github.com/getsentry/toolkit/pull/1403)
- Test the exact production Worker version before promotion by @BYK in [#1399](https://github.com/getsentry/toolkit/pull/1399)
- Move Cloudflare token to protected production environment by @BYK in [#1394](https://github.com/getsentry/toolkit/pull/1394)
- Publish Toolkit CLI nightlies to GHCR by @BYK in [#1393](https://github.com/getsentry/toolkit/pull/1393)
- Restore CLI changelog with automatic workspace notes by @BYK in [#1362](https://github.com/getsentry/toolkit/pull/1362)
- Restore guarded MCP production deployment by @BYK in [#1359](https://github.com/getsentry/toolkit/pull/1359)
- Regenerate CLI skill files for 0.47.0 by @BYK in [#1360](https://github.com/getsentry/toolkit/pull/1360)

## 0.46.0

### New Features ✨

- Move the CLI and its documentation to [getsentry/toolkit](https://github.com/getsentry/toolkit), preserving their Git history. Stable installers now fetch exact `cli@` releases from Toolkit, with a legacy fallback only when Toolkit returns 404, in [#1354](https://github.com/getsentry/toolkit/pull/1354).
- Configure Toolkit to publish the CLI binaries, npm package, Homebrew formula, and website in [#1354](https://github.com/getsentry/toolkit/pull/1354).

### Bug Fixes 🐛

- Keep CLI typechecking offline and support the ignored API schema in fresh checkouts in [#1320](https://github.com/getsentry/toolkit/pull/1320).
- Parse compact GitHub release responses, skip prerelease tags for stable installations, and preserve setup and upgrade compatibility in [#1320](https://github.com/getsentry/toolkit/pull/1320).
- Silence Seer errors on self-hosted instances without suppressing SaaS telemetry in [getsentry/cli#1651](https://github.com/getsentry/cli/pull/1651).
- Keep the v3 migration shim working for a release named `new` in [#1320](https://github.com/getsentry/toolkit/pull/1320).

### Documentation 📚

- Point the CLI website's GitHub link to Toolkit in [#1358](https://github.com/getsentry/toolkit/pull/1358).

## 0.45.0

### New Features ✨

#### Dashboard

- Render graphics with Spleen by @MathurAditya724 in [#1521](https://github.com/getsentry/cli/pull/1521)
- Add heatmap display type by @jared-outpost in [#1395](https://github.com/getsentry/cli/pull/1395)

#### Local

- Add Vercel Analytics by @MathurAditya724 in [#1563](https://github.com/getsentry/cli/pull/1563)
- Add browser viewer for local telemetry by @MathurAditya724 in [#1560](https://github.com/getsentry/cli/pull/1560)
- Add agent debugging stream by @MathurAditya724 in [#1538](https://github.com/getsentry/cli/pull/1538)

#### Status

- Probe Statuspage summary directly instead of host heuristic by @jared-outpost in [#1510](https://github.com/getsentry/cli/pull/1510)
- Add `sentry status` command group by @jared-outpost in [#1494](https://github.com/getsentry/cli/pull/1494)

#### Other

- (cli) Add toolkit upgrade bridge by @BYK in [#1569](https://github.com/getsentry/cli/pull/1569)
- (config) Follow XDG Base Directory spec for config location by @jared-outpost in [#1503](https://github.com/getsentry/cli/pull/1503)
- (errors) Wire up no-silent-catch lint rule, drop ratchet baseline by @jared-outpost in [#1532](https://github.com/getsentry/cli/pull/1532)
- (init) Track completion-screen actions in run telemetry by @betegon in [#1534](https://github.com/getsentry/cli/pull/1534)
- (telemetry) Refresh coding agent detection by @betegon in [#1571](https://github.com/getsentry/cli/pull/1571)

### Bug Fixes 🐛

#### Cli

- Log UID resolution failures in sentry cli fix by @cursor in [#1541](https://github.com/getsentry/cli/pull/1541)
- Handle empty regionUrl from self-hosted Sentry by @sentry in [#1522](https://github.com/getsentry/cli/pull/1522)

#### Dashboard

- Use revision restore endpoint by @skaasten in [#1529](https://github.com/getsentry/cli/pull/1529)
- Cap high-DPI graphics canvases by @MathurAditya724 in [#1527](https://github.com/getsentry/cli/pull/1527)
- Log graphics renderer selection by @MathurAditya724 in [#1508](https://github.com/getsentry/cli/pull/1508)
- Render graphics on kitty terminals without cell geometry by @jared-outpost in [#1507](https://github.com/getsentry/cli/pull/1507)

#### Init

- Stop recording skipped verification as an error by @betegon in [#1544](https://github.com/getsentry/cli/pull/1544)
- Gate unsupported --features and tag dry-run runs by @betegon in [#1535](https://github.com/getsentry/cli/pull/1535)

#### Telemetry

- Log process-tree walk failures in agent detection by @cursor in [#1542](https://github.com/getsentry/cli/pull/1542)
- Silence CliError for process exit code 1 by @sentry in [#1449](https://github.com/getsentry/cli/pull/1449)

#### Other

- (alerts) Remove deprecated transactions dataset by @mjq in [#1516](https://github.com/getsentry/cli/pull/1516)
- (arg-parsing) Handle space-separated event IDs from agents by @sentry in [#1530](https://github.com/getsentry/cli/pull/1530)
- (dashboards) Remove references to removed datasets by @mjq in [#1515](https://github.com/getsentry/cli/pull/1515)
- (dif) Log errors in tryProguard and tryObject catch blocks by @cursor in [#1513](https://github.com/getsentry/cli/pull/1513)
- (docs) Explain regional model unavailability by @MathurAditya724 in [#1537](https://github.com/getsentry/cli/pull/1537)
- (event) Prevent immediate retry of rate-limited org in event view fallback by @sentry in [#1566](https://github.com/getsentry/cli/pull/1566)
- (explore) Send a stable sort on errors/discover so cursor pagination is deterministic by @jared-outpost in [#1520](https://github.com/getsentry/cli/pull/1520)
- (lint) Force-ignore output.ts from Biome type analysis (200k limit) by @betegon in [#1536](https://github.com/getsentry/cli/pull/1536)
- (org) Log region URL parse failures in org list by @cursor in [#1539](https://github.com/getsentry/cli/pull/1539)
- (scope-recovery) Log error in hasActiveOAuthGrant catch block by @cursor in [#1511](https://github.com/getsentry/cli/pull/1511)
- (sdk) Derive the published SentryOptions type from its source by @JPeer264 in [#1500](https://github.com/getsentry/cli/pull/1500)
- (sourcemap) Let `inject` run without authentication by @Gyeonghun-Park in [#1526](https://github.com/getsentry/cli/pull/1526)
- (version-check) Log errors in maybePrefetchPatches catch blocks by @cursor in [#1512](https://github.com/getsentry/cli/pull/1512)

### Documentation 📚

- Weekly documentation audit — add sentry docs/status coverage, install flags, plugin syntax by @cursor in [#1514](https://github.com/getsentry/cli/pull/1514)

### Internal Changes 🔧

- (build) Stream normalization + ZIP emission for uploads by @jared-outpost in [#1498](https://github.com/getsentry/cli/pull/1498)
- Remove PR risk experiment workflow by @betegon in [#1570](https://github.com/getsentry/cli/pull/1570)
- Reference renamed coverage action by @MathurAditya724 in [#1533](https://github.com/getsentry/cli/pull/1533)
- Regenerate docs by @github-actions[bot] in [398ae52a](https://github.com/getsentry/cli/commit/398ae52a740cedc89add2567eb6e36821ee6ca40)
- Regenerate docs by @github-actions[bot] in [d2894a18](https://github.com/getsentry/cli/commit/d2894a187c484f995ff07903f65c54628e7fc1ae)

### Other

- explore: document sortable-dataset contract, drop dead discover entry by @jared-outpost in [#1524](https://github.com/getsentry/cli/pull/1524)

## 0.44.1

### Bug Fixes 🐛

- (sourcemap) Adopt a debug ID already present on the sourcemap by @msonnb in [#1496](https://github.com/getsentry/cli/pull/1496)

### Documentation 📚

- (cli) Drop hijacked consoledonottrack.com link by @sentry-junior in [#1504](https://github.com/getsentry/cli/pull/1504)

### Internal Changes 🔧

- Regenerate docs by @github-actions[bot] in [4892858f](https://github.com/getsentry/cli/commit/4892858f3be6abcfd5eb161e54af714c296e1d4e)

## 0.44.0

### New Features ✨

#### Docs

- Add query loading feedback by @MathurAditya724 in [#1475](https://github.com/getsentry/cli/pull/1475)
- Add docs command suite by @MathurAditya724 in [#1457](https://github.com/getsentry/cli/pull/1457)

#### Errors

- Replace silent-catch ratchet with a biome lint rule by @jared-outpost in [#1487](https://github.com/getsentry/cli/pull/1487)
- Enforce silent-catch check with a ratchet baseline by @jared-outpost in [#1471](https://github.com/getsentry/cli/pull/1471)

#### Other

- (api) Add shared paginate() helper for list endpoints by @jared-outpost in [#1486](https://github.com/getsentry/cli/pull/1486)
- (dashboard) Render complete dashboards as sixel by @jared-outpost in [#1410](https://github.com/getsentry/cli/pull/1410)
- (init) Support project-aware feature selection by @betegon in [#1455](https://github.com/getsentry/cli/pull/1455)
- (sdk) Add headers option to createSentrySDK by @JPeer264 in [#1465](https://github.com/getsentry/cli/pull/1465)
- (skill) Steer agents away from manual org/project discovery by @jared-outpost in [#1479](https://github.com/getsentry/cli/pull/1479)
- (ui) Add kitty graphics protocol support for inline images by @jared-outpost in [#1484](https://github.com/getsentry/cli/pull/1484)

### Bug Fixes 🐛

#### Cli

- Remediate vulnerable dependencies by @BYK in [#1495](https://github.com/getsentry/cli/pull/1495)
- Close undici global dispatcher on exit by @jared-outpost in [#1488](https://github.com/getsentry/cli/pull/1488)
- Force-exit safety net for all commands, not just init by @jared-outpost in [#1396](https://github.com/getsentry/cli/pull/1396)
- Rename AI conversations to agent conversations by @ArthurKnaus in [#1485](https://github.com/getsentry/cli/pull/1485)

#### Other

- (api) Report empty error responses by @BYK in [#1452](https://github.com/getsentry/cli/pull/1452)
- (conversations) Cap per_page at API_MAX_PER_PAGE and add auto-pagination by @cursor in [#1458](https://github.com/getsentry/cli/pull/1458)
- (dashboard) Scale Cozette sixel text by @BYK in [#1454](https://github.com/getsentry/cli/pull/1454)
- (db) Fix TDZ ReferenceError in getConfigDir by @sentry in [#1456](https://github.com/getsentry/cli/pull/1456)
- (lint) Flag three-arg autoPaginate in prefer-paginate-helper by @jared-outpost in [#1489](https://github.com/getsentry/cli/pull/1489)
- (release) Make missing git remote for set-commits --auto actionable by @jared-outpost in [#1474](https://github.com/getsentry/cli/pull/1474)
- (resolve) Skip org/project discovery when the DSN already identifies the target by @jared-outpost in [#1476](https://github.com/getsentry/cli/pull/1476)
- (schema) Report no-match searches instead of dumping the full list by @jared-outpost in [#1466](https://github.com/getsentry/cli/pull/1466)
- (sdk) Honor explicit token precedence by @MathurAditya724 in [#1464](https://github.com/getsentry/cli/pull/1464)
- (seer) Add debug logging to silent catch blocks in seer-trial by @cursor in [#1460](https://github.com/getsentry/cli/pull/1460)
- (telemetry) Add debug logging to silent catch blocks in completion-telemetry by @cursor in [#1459](https://github.com/getsentry/cli/pull/1459)

### Documentation 📚

- (agentic-usage) Add dotagents install path by @jared-outpost in [#1492](https://github.com/getsentry/cli/pull/1492)
- Weekly documentation audit — fix DSN table, Zod→Valibot drift, missing env vars, new commands by @cursor in [#1461](https://github.com/getsentry/cli/pull/1461)

### Internal Changes 🔧

- Add darwin-arm64 support to PR builds by @BYK in [#1490](https://github.com/getsentry/cli/pull/1490)
- Fix another syntax error by @BYK in [b3a4edfa](https://github.com/getsentry/cli/commit/b3a4edfa314b6cd89a52ef92a36338f75374b0c3)
- Fix syntax error by @BYK in [92853b30](https://github.com/getsentry/cli/commit/92853b30d3258631e905628e7b77507b5016a1d3)
- Fix eval-skill runs by @BYK in [#1483](https://github.com/getsentry/cli/pull/1483)
- Remove leftover Bun polyfills from the npm bundle by @jared-outpost in [#1468](https://github.com/getsentry/cli/pull/1468)
- Regenerate docs by @github-actions[bot] in [9850495c](https://github.com/getsentry/cli/commit/9850495cb1cddb5303df22e0602cdd4523a986a5)

## 0.43.0

### New Features ✨

#### Cli

- Add completion command by @MunifTanjim in [#1427](https://github.com/getsentry/cli/pull/1427)
- Persist agent-skills preference and improve skill docs by @jared-outpost in [#1408](https://github.com/getsentry/cli/pull/1408)

#### Init

- Redesign the completion screen around the first error by @betegon in [#1444](https://github.com/getsentry/cli/pull/1444)
- Add bounded stateless file reads by @betegon in [#1437](https://github.com/getsentry/cli/pull/1437)
- Echo workflow request IDs when resuming by @betegon in [#1436](https://github.com/getsentry/cli/pull/1436)
- Add feature setup review by @betegon in [#1413](https://github.com/getsentry/cli/pull/1413)

#### Other

- (docs) Add Vercel analytics and speed insights by @betegon in [#1399](https://github.com/getsentry/cli/pull/1399)
- (upgrade) Add --no-agent-skills flag by @jared-outpost in [#1407](https://github.com/getsentry/cli/pull/1407)

### Bug Fixes 🐛

#### Init

- Require explicit zero workflow exit by @betegon in [#1451](https://github.com/getsentry/cli/pull/1451)
- Start the plugin-installer handoff at the top of the screen by @betegon in [#1448](https://github.com/getsentry/cli/pull/1448)
- Align local file read policy by @betegon in [#1447](https://github.com/getsentry/cli/pull/1447)
- Stop duplicating step checks in the activity log by @betegon in [#1439](https://github.com/getsentry/cli/pull/1439)
- Keep protocol metadata out of local tools by @betegon in [#1438](https://github.com/getsentry/cli/pull/1438)
- Apply file changes safely by @betegon in [#1435](https://github.com/getsentry/cli/pull/1435)

#### Other

- (auth) Request team admin OAuth scope by @betegon in [#1373](https://github.com/getsentry/cli/pull/1373)
- (bundle) Stop writing a Bun polyfill onto globalThis by @JPeer264 in [#1421](https://github.com/getsentry/cli/pull/1421)
- (cli) Guard markdown rendering against undefined input by @sentry in [#1422](https://github.com/getsentry/cli/pull/1422)
- (dsn) Ignore docs placeholder DSNs by @sentry-junior in [#1416](https://github.com/getsentry/cli/pull/1416)
- (event) Handle issue short ID as second positional arg by @sentry in [#1420](https://github.com/getsentry/cli/pull/1420)
- (explore) Translate --environment to query for non-replays by @sentry in [#1442](https://github.com/getsentry/cli/pull/1442)
- (issue) Handle object headers in buildRequestMarkdown by @sentry in [#1441](https://github.com/getsentry/cli/pull/1441)
- (log) Handle org/log-id shorthand to prevent ContextError by @sentry in [#1445](https://github.com/getsentry/cli/pull/1445)
- (proguard) Restore leading slash in DIF assemble name by @gabriellanata in [#1372](https://github.com/getsentry/cli/pull/1372)
- (sdk) Pass each positional argument as its own argv token by @JPeer264 in [#1415](https://github.com/getsentry/cli/pull/1415)
- (snapshots) Create all-unchanged selective uploads by @betegon in [#1398](https://github.com/getsentry/cli/pull/1398)
- (span) Handle invalid trace ID in tryAutoSplitSpanArg by @sentry in [#1443](https://github.com/getsentry/cli/pull/1443)
- (trace) Scope trace/span list by numeric project ID by @MathurAditya724 in [#1364](https://github.com/getsentry/cli/pull/1364)

### Documentation 📚

- Weekly documentation audit — fix Zod→Valibot drift, stale versions, dataset list by @cursor in [#1400](https://github.com/getsentry/cli/pull/1400)

### Internal Changes 🔧

#### Init

- Simplify V2 file reads by @betegon in [#1450](https://github.com/getsentry/cli/pull/1450)
- Make list_dir bounded and metadata-only by @betegon in [#1446](https://github.com/getsentry/cli/pull/1446)

#### Other

- (deps) Upgrade Mastra client to 1.38 by @betegon in [#1411](https://github.com/getsentry/cli/pull/1411)
- Regenerate docs by @github-actions[bot] in [90768e40](https://github.com/getsentry/cli/commit/90768e40d7e0033aae5c126cd5b3309de271a236)

### Other

- upgrade eval agent models to sonnet-5 and gpt-5.6-luna by @jared-outpost in [#1393](https://github.com/getsentry/cli/pull/1393)

## 0.42.2

### Internal Changes 🔧

- Regenerate docs by @github-actions[bot] in [0f9320ae](https://github.com/getsentry/cli/commit/0f9320ae2dda2eea0c60543438de886f38188c81)

## 0.42.1

### Internal Changes 🔧

- (cli) Remove remaining zod usage, migrate to valibot by @jared-outpost in [#1389](https://github.com/getsentry/cli/pull/1389)
- Deploy docs through Vercel by @BYK in [#1391](https://github.com/getsentry/cli/pull/1391)
- Regenerate docs by @github-actions[bot] in [f805991b](https://github.com/getsentry/cli/commit/f805991b68b95800fb1a53da4ab838f12aba3e78)

## 0.42.0

### New Features ✨

- (auth) Make bare sentry auth run login by @sentry-junior in [#1380](https://github.com/getsentry/cli/pull/1380)
- (platform) Add `sentry platform list` command by @betegon in [#1366](https://github.com/getsentry/cli/pull/1366)

### Bug Fixes 🐛

#### Init

- Sort and align selector options by @betegon in [#1387](https://github.com/getsentry/cli/pull/1387)
- Improve task panel readability by @betegon in [#1386](https://github.com/getsentry/cli/pull/1386)
- Keep select prompts within terminal by @betegon in [#1385](https://github.com/getsentry/cli/pull/1385)
- Refresh auth before wizard startup by @betegon in [#1384](https://github.com/getsentry/cli/pull/1384)

#### Other

- (conversation) Parse details envelope instead of bare span array by @MathurAditya724 in [#1365](https://github.com/getsentry/cli/pull/1365)
- (explore) Remove deprecated `discover` and `transactions` datasets by @mjq in [#1368](https://github.com/getsentry/cli/pull/1368)
- (skill) Update Explore (`/events/`) datasets by @mjq in [#1369](https://github.com/getsentry/cli/pull/1369)
- Cap API per_page, guard null alert names, fix log hasMore logic by @cursor in [#1158](https://github.com/getsentry/cli/pull/1158)

### Documentation 📚

- Documentation audit — fix version claims, license, agent coverage, and auth examples by @cursor in [#1350](https://github.com/getsentry/cli/pull/1350)

### Internal Changes 🔧

#### Cli

- Migrate replay SDK validator from zod to valibot by @jared-outpost in [#1388](https://github.com/getsentry/cli/pull/1388)
- Migrate self-contained runtime validation from zod to valibot by @jared-outpost in [#1370](https://github.com/getsentry/cli/pull/1370)

#### Other

- (deps-dev) Bump hono from 4.12.33 to 4.12.34 in the npm_and_yarn group across 1 directory by @dependabot in [#1358](https://github.com/getsentry/cli/pull/1358)
- Remove disabled changelog-preview workflow by @oioki in [#1360](https://github.com/getsentry/cli/pull/1360)
- Remove accidental command-metadata.json by @jared-outpost in [#1359](https://github.com/getsentry/cli/pull/1359)
- Regenerate docs by @github-actions[bot] in [aa7f660d](https://github.com/getsentry/cli/commit/aa7f660d8e3d0b2236f067976447cbc683112121)

## 0.41.0

### New Features ✨

- (docs) Deploy CLI docs to Cloudflare with Craft by @jared-outpost in [#1354](https://github.com/getsentry/cli/pull/1354)
- (help) Support JSON output for --help flags by @jared-outpost in [#1337](https://github.com/getsentry/cli/pull/1337)
- (local) Inject Spotlight as a Wrangler Worker binding by @MathurAditya724 in [#1351](https://github.com/getsentry/cli/pull/1351)
- (project) Create multiple projects in one command by @betegon in [#1191](https://github.com/getsentry/cli/pull/1191)
- Add `sentry agent-conversation` command group for inspecting AI agent transcripts by @sergical in [#1020](https://github.com/getsentry/cli/pull/1020)

### Bug Fixes 🐛

#### Alert

- Normalize dataset aliases in metric alert commands by @sentry in [#1356](https://github.com/getsentry/cli/pull/1356)
- Handle missing conditions/actions in issue alert view by @sentry in [#1331](https://github.com/getsentry/cli/pull/1331)

#### Alerts

- Seed logicType/conditions when issue alert edit adds first action filter by @jared-outpost in [#1336](https://github.com/getsentry/cli/pull/1336)
- Migrate metric alert mutations to detectors API by @jared-outpost in [#1338](https://github.com/getsentry/cli/pull/1338)
- Create and edit issue alert rules via org-scoped /workflows/ by @betegon in [#1223](https://github.com/getsentry/cli/pull/1223)

#### Issue

- Case-insensitive short-ID detection for issue list recovery by @betegon in [#1210](https://github.com/getsentry/cli/pull/1210)
- Reject issue-1-style command-token args by @betegon in [#1209](https://github.com/getsentry/cli/pull/1209)

#### Local

- Don't abort when the port is held by an unhealthy sidecar by @MathurAditya724 in [#1344](https://github.com/getsentry/cli/pull/1344)
- Warn when the event stream cannot be attached by @MathurAditya724 in [#1343](https://github.com/getsentry/cli/pull/1343)
- Tail events in `run` when a server already owns the port by @MathurAditya724 in [#1342](https://github.com/getsentry/cli/pull/1342)
- Print one timestamp per event line and identify as a Spot… by @MathurAditya724 in [#1341](https://github.com/getsentry/cli/pull/1341)

#### Upgrade

- Delta apply progress bar shows percentage only (no GB scare) by @BYK in [#1355](https://github.com/getsentry/cli/pull/1355)
- Restrict delta patch from-version to same major.minor series by @BYK in [#1329](https://github.com/getsentry/cli/pull/1329)
- Use generated-patch from-version + close output fd synchronously by @BYK in [#1327](https://github.com/getsentry/cli/pull/1327)

#### Other

- (auth) Name .sentryclirc as token source in ignored-token hint by @jared-outpost in [#1346](https://github.com/getsentry/cli/pull/1346)
- (dashboard) Correctly validate span and tracemetrics aggregates by @sentry in [#1295](https://github.com/getsentry/cli/pull/1295)
- (docs) Remove footer GitHub icon covered by install banner by @sentry-junior in [#1324](https://github.com/getsentry/cli/pull/1324)
- (fs) Ignore ETIMEDOUT in scandir on network mounts by @sentry in [#1217](https://github.com/getsentry/cli/pull/1217)
- (logs) Correct severity query examples by @jamieQ in [#1328](https://github.com/getsentry/cli/pull/1328)
- (npm) Route bare "zlib" imports through the ESM namespace shim by @JPeer264 in [#1357](https://github.com/getsentry/cli/pull/1357)

### Documentation 📚

- (lore) Persist the project-create colon-syntax decision by @betegon in [#1352](https://github.com/getsentry/cli/pull/1352)

### Internal Changes 🔧

#### Cli

- Move --version/--help into the Stricli scanner, delete argv-glue by @jared-outpost in [#1348](https://github.com/getsentry/cli/pull/1348)
- Replace argv-hoist preprocessor with a Stricli top-level-flags patch by @jared-outpost in [#1340](https://github.com/getsentry/cli/pull/1340)

#### Deps

- Bump binpatch ^0.3.1 → ^0.4.0 by @BYK in [#1326](https://github.com/getsentry/cli/pull/1326)
- Bump the npm_and_yarn group across 2 directories with 3 updates by @dependabot in [#1322](https://github.com/getsentry/cli/pull/1322)

#### Other

- (api) Adopt SDK types for the projects domain by @betegon in [#1213](https://github.com/getsentry/cli/pull/1213)
- (upgrade) Adopt BYK/binpatch action for delta patch generation/publish by @BYK in [#1330](https://github.com/getsentry/cli/pull/1330)
- Fix 13 dependabot alerts via pnpm overrides + remove stale docs lockfile by @BYK in [#1332](https://github.com/getsentry/cli/pull/1332)
- Pre-shape repo into pnpm-workspace monorepo layout by @BYK in [#1254](https://github.com/getsentry/cli/pull/1254)
- Regenerate docs by @github-actions[bot] in [0b43edad](https://github.com/getsentry/cli/commit/0b43edad47386844ece1f9f288310e2683afce49)

## 0.40.0

### New Features ✨

- (api) Render image attachments inline via sixel on capable terminals by @jared-outpost in [#1310](https://github.com/getsentry/cli/pull/1310)
- (feedback) Add list and view commands by @betegon in [#1266](https://github.com/getsentry/cli/pull/1266)

### Bug Fixes 🐛

- (alert) Guard against undefined conditions/actions in list command by @sentry in [#1313](https://github.com/getsentry/cli/pull/1313)
- (auth) Clarify access token expiry wording by @betegon in [#1315](https://github.com/getsentry/cli/pull/1315)
- (fs) Ignore ELOOP errors during file scanning by @sentry in [#1320](https://github.com/getsentry/cli/pull/1320)
- (local) Point `trace view --web` at the trace detail route by @sergical in [#1314](https://github.com/getsentry/cli/pull/1314)
- (log) Scope log queries by numeric project ID by @jared-outpost in [#1318](https://github.com/getsentry/cli/pull/1318)
- (logger) Render log timestamps in local time instead of UTC by @MathurAditya724 in [#1311](https://github.com/getsentry/cli/pull/1311)
- (replays) Use `events` data source for issue replay count by @mjq in [#1316](https://github.com/getsentry/cli/pull/1316)

### Internal Changes 🔧

- (lint) Prevent generic isRecord guards by @betegon in [#1272](https://github.com/getsentry/cli/pull/1272)
- Regenerate docs by @github-actions[bot] in [3e292ee4](https://github.com/getsentry/cli/commit/3e292ee4beb5c8254e0f020d2bfaf64fa16a7132)

## 0.39.0

### New Features ✨

#### Build

- Support iOS XCArchive and IPA upload by @BYK in [#1185](https://github.com/getsentry/cli/pull/1185)
- Collect git/VCS metadata for build upload by @BYK in [#1174](https://github.com/getsentry/cli/pull/1174)
- Add `build upload` for Android APK/AAB by @BYK in [#1172](https://github.com/getsentry/cli/pull/1172)
- Add `build download` command for preprod artifacts by @BYK in [#1170](https://github.com/getsentry/cli/pull/1170)

#### Debug Files

- Add find command by @BYK in [#1189](https://github.com/getsentry/cli/pull/1189)
- Add --il2cpp-mapping for Unity IL2CPP line mappings by @BYK in [#1165](https://github.com/getsentry/cli/pull/1165)
- Extract embedded Portable PDBs from managed PEs by @BYK in [#1163](https://github.com/getsentry/cli/pull/1163)
- Scan inside .zip archives on upload by @BYK in [#1141](https://github.com/getsentry/cli/pull/1141)
- Honor server upload limits and add --derived-data by @BYK in [#1140](https://github.com/getsentry/cli/pull/1140)
- Add upload command (core) by @BYK in [#1139](https://github.com/getsentry/cli/pull/1139)
- Add print-sources command by @BYK in [#1138](https://github.com/getsentry/cli/pull/1138)

#### React Native

- Close remaining legacy parity gaps by @BYK in [#1198](https://github.com/getsentry/cli/pull/1198)
- Add xcode command by @BYK in [#1193](https://github.com/getsentry/cli/pull/1193)
- Add gradle command by @BYK in [#1192](https://github.com/getsentry/cli/pull/1192)

#### Release

- Add --from to scope set-commits to a local range by @betegon in [#1197](https://github.com/getsentry/cli/pull/1197)
- Filter set-commits by path for monorepos (CLI-339) by @betegon in [#1159](https://github.com/getsentry/cli/pull/1159)

#### Snapshots

- Add upload command by @BYK in [#1186](https://github.com/getsentry/cli/pull/1186)
- Add `snapshots diff` by @BYK in [#1179](https://github.com/getsentry/cli/pull/1179)
- Add `snapshots download` by @BYK in [#1176](https://github.com/getsentry/cli/pull/1176)

#### Other

- (banner) Sixel image banner on capable terminals by @BYK in [#1187](https://github.com/getsentry/cli/pull/1187)
- (ci) Add PR risk experiment workflow by @betegon in [#1129](https://github.com/getsentry/cli/pull/1129)
- (db) Support Node.js 18+ for the npm package via WASM SQLite fallback by @BYK in [#1260](https://github.com/getsentry/cli/pull/1260)
- (info) Add info command by @BYK in [#1190](https://github.com/getsentry/cli/pull/1190)
- (init) Measure interactive prompt wait time by @betegon in [#1257](https://github.com/getsentry/cli/pull/1257)
- (local) Surface trace IDs, attribute table, and fix AI filter by @jared-outpost in [#1133](https://github.com/getsentry/cli/pull/1133)
- (upgrade) Progress bars for delta-patch apply and full download by @BYK in [#1281](https://github.com/getsentry/cli/pull/1281)
- Add ESM export by @JPeer264 in [#1288](https://github.com/getsentry/cli/pull/1288)
- Replace CLI banner with block-art SENTRY wordmark by @BYK in [#1169](https://github.com/getsentry/cli/pull/1169)

### Bug Fixes 🐛

#### Alerts

- Read metric alert rules from org-scoped /detectors/ by @jared-outpost in [#1275](https://github.com/getsentry/cli/pull/1275)
- Delete issue alert rules via org-scoped /workflows/ by @betegon in [#1216](https://github.com/getsentry/cli/pull/1216)
- Read issue alert rules from org-scoped /workflows/ by @betegon in [#1215](https://github.com/getsentry/cli/pull/1215)

#### Auth

- Only treat 401/403 as an invalid token on login (CLI-19) by @BYK in [#1153](https://github.com/getsentry/cli/pull/1153)
- Add alerts:read and alerts:write to default OAuth scopes by @sergical in [#1137](https://github.com/getsentry/cli/pull/1137)

#### Ci

- Use temp config dir in npm smoke test to prevent WASM SQLite crash by @MathurAditya724 in [#1282](https://github.com/getsentry/cli/pull/1282)
- Clear auth tokens in npm smoke test to prevent WASM SQLite crash by @MathurAditya724 in [#1278](https://github.com/getsentry/cli/pull/1278)
- Grant PR risk write permission by @betegon in [#1136](https://github.com/getsentry/cli/pull/1136)
- Allow PR risk labels by @betegon in [#1135](https://github.com/getsentry/cli/pull/1135)

#### Debug Files

- Accurate upload count and preserve --require-all hint by @BYK in [#1167](https://github.com/getsentry/cli/pull/1167)
- Exit non-zero when files are dropped for size by @BYK in [#1146](https://github.com/getsentry/cli/pull/1146)
- Map targeted object for --il2cpp-mapping + free WASM handles by @BYK in [#1166](https://github.com/getsentry/cli/pull/1166)

#### Error Reporting

- Stop reporting network fetch failures as crashes (CLI-16W) by @BYK in [#1152](https://github.com/getsentry/cli/pull/1152)
- Silence search-query parse 400s (CLI-FA) by @BYK in [#1151](https://github.com/getsentry/cli/pull/1151)
- Silence ContextError to stop crash reports (CLI-3B) by @BYK in [#1149](https://github.com/getsentry/cli/pull/1149)

#### Event

- Recognize numeric issue IDs and bare 'latest' in 'event view' by @sentry in [#1297](https://github.com/getsentry/cli/pull/1297)
- Correctly parse project/event-id in view command by @sentry in [#1263](https://github.com/getsentry/cli/pull/1263)

#### Init

- Allow org admins to create projects when member creation is disabled by @MathurAditya724 in [#1284](https://github.com/getsentry/cli/pull/1284)
- Retry transient auth validation once by @betegon in [#1271](https://github.com/getsentry/cli/pull/1271)
- Keep Ink task progress in sync by @betegon in [#1259](https://github.com/getsentry/cli/pull/1259)
- Terminate verification process trees by @betegon in [#1258](https://github.com/getsentry/cli/pull/1258)
- Preserve welcome banner alignment by @betegon in [#1255](https://github.com/getsentry/cli/pull/1255)
- Extend API timeout to 210 seconds by @betegon in [#1252](https://github.com/getsentry/cli/pull/1252)

#### Issue

- Ensure --into flag is resolved with multiple positional args by @sentry in [#1256](https://github.com/getsentry/cli/pull/1256)
- Stop collapsing stats on piped output and JSON defaults by @betegon in [#1221](https://github.com/getsentry/cli/pull/1221)
- Report issue not found instead of project not found by @betegon in [#1207](https://github.com/getsentry/cli/pull/1207)
- Accept multi-line issue identifiers by keeping first line (CLI-1G1) by @BYK in [#1148](https://github.com/getsentry/cli/pull/1148)

#### Release

- Polish --from ref errors and dashed-value parsing by @betegon in [#1203](https://github.com/getsentry/cli/pull/1203)
- Make set-commits --clear actually clear commits by @betegon in [#1196](https://github.com/getsentry/cli/pull/1196)

#### Resolution

- Correct hint for bare suffix in org/suffix issue ID by @sentry in [#1296](https://github.com/getsentry/cli/pull/1296)
- Prevent duplicate org in trace ID resolution by @sentry in [#1289](https://github.com/getsentry/cli/pull/1289)

#### Upgrade

- Nightly discovery hits wrong GHCR package (silent 404 → full-download fallback) by @BYK in [#1304](https://github.com/getsentry/cli/pull/1304)
- Bound untrusted patch newSize to prevent pre-verification OOM by @BYK in [#1279](https://github.com/getsentry/cli/pull/1279)

#### Other

- (agent-skills) Write skill files atomically to prevent partial reads by @BYK in [#1144](https://github.com/getsentry/cli/pull/1144)
- (api) Stream binary responses without UTF-8 decoding by @sentry-junior in [#1305](https://github.com/getsentry/cli/pull/1305)
- (arg-parsing) Allow project display names with spaces in org/project argument by @sentry in [#1116](https://github.com/getsentry/cli/pull/1116)
- (cli) Allow '=' as key-value separator for tags and extra flags by @sentry in [#1285](https://github.com/getsentry/cli/pull/1285)
- (db) Recover WASM SQLite locks via PID sentinel, not a 60s age window by @BYK in [#1261](https://github.com/getsentry/cli/pull/1261)
- (dsn) Ignore EINVAL from readdirSync on special files by @sentry in [#1286](https://github.com/getsentry/cli/pull/1286)
- (errors) Surface user search-query 400s as ValidationError, keep CLI-built 400s reported (CLI-FA) by @BYK in [#1154](https://github.com/getsentry/cli/pull/1154)
- (local) Handle standalone span items, Cloudflare SDK source, and warn level by @MathurAditya724 in [#1276](https://github.com/getsentry/cli/pull/1276)
- (metrics) Prevent duplicate metric suggestions in error by @sentry in [#1299](https://github.com/getsentry/cli/pull/1299)
- (resolve) Guide users to org/project instead of silencing the auto-detect error (CLI-3B) by @BYK in [#1155](https://github.com/getsentry/cli/pull/1155)
- (resolve-target) Hint numeric project IDs in 404 suggestions by @betegon in [#1208](https://github.com/getsentry/cli/pull/1208)
- (seer) Read sentry_run_id instead of the deprecated run_id by @trevor-e in [#1224](https://github.com/getsentry/cli/pull/1224)
- (sourcemap) Derive debug ID from JS + map so distinct chunks don't collide (#3350) by @BYK in [#1162](https://github.com/getsentry/cli/pull/1162)
- (span) Correctly parse multi-segment trace targets in single-arg view by @sentry in [#1283](https://github.com/getsentry/cli/pull/1283)
- (trace) Allow 'trace view' to work with org-scoped targets by @sentry in [#1291](https://github.com/getsentry/cli/pull/1291)
- Guard response.json() and validate external API response shapes by @cursor in [#1301](https://github.com/getsentry/cli/pull/1301)

### Documentation 📚

#### Site

- Update og images by @betegon in [#1188](https://github.com/getsentry/cli/pull/1188)
- Use brand fonts (Dammit Sans headings, Rubik body) by @BYK in [#1183](https://github.com/getsentry/cli/pull/1183)
- Adopt new Sentry CLI brand lockup + app-icon favicon by @BYK in [#1181](https://github.com/getsentry/cli/pull/1181)

#### Other

- (debug-files) Drop planned --symbol-maps (BCSymbolMap) support by @BYK in [#1168](https://github.com/getsentry/cli/pull/1168)
- (getting-started) Remove redundant Installation heading, fix platform support table by @sergical in [#1195](https://github.com/getsentry/cli/pull/1195)
- (lore) Mark multi-region fan-out entry as superseded by @betegon in [#1214](https://github.com/getsentry/cli/pull/1214)
- Add v3→v4 migration guide (sentry-cli → sentry) by @BYK in [#1201](https://github.com/getsentry/cli/pull/1201)
- Note `sentry cli setup` for package manager installs by @sergical in [#1204](https://github.com/getsentry/cli/pull/1204)
- Refresh README banner with new brand art + gradient by @BYK in [#1178](https://github.com/getsentry/cli/pull/1178)
- Note ambiguous-width limitation of block-art banner by @BYK in [#1177](https://github.com/getsentry/cli/pull/1177)

### Internal Changes 🔧

#### Deps

- Bump js-yaml to 3.15.0 via pnpm override by @betegon in [#1206](https://github.com/getsentry/cli/pull/1206)
- Bump @sentry/api to 0.253.0 and adopt token operationIds by @betegon in [#1194](https://github.com/getsentry/cli/pull/1194)
- Add content assertions for Sentry tree-shaking patches by @BYK in [#1175](https://github.com/getsentry/cli/pull/1175)
- Bump patched deps to latest and regenerate patches by @BYK in [#1173](https://github.com/getsentry/cli/pull/1173)
- Pin patched dependency keys to exact versions by @BYK in [#1171](https://github.com/getsentry/cli/pull/1171)

#### Docs

- Bump starlight theme to 0.8.0 by @sentry-junior in [#1287](https://github.com/getsentry/cli/pull/1287)
- Clean up PR previews on close + scheduled safety-net sweep by @BYK in [#1202](https://github.com/getsentry/cli/pull/1202)

#### Upgrade

- Adopt binpatch@0.3.0 for delta self-update by @BYK in [#1298](https://github.com/getsentry/cli/pull/1298)
- Vectorize bspatch diff-add with SWAR (4x faster apply) by @BYK in [#1280](https://github.com/getsentry/cli/pull/1280)

#### Other

- (debug-files) Scan paths via shared walkFiles walker by @BYK in [#1150](https://github.com/getsentry/cli/pull/1150)
- (eval) Support OpenRouter for skill-eval and init-eval judges by @MathurAditya724 in [#1306](https://github.com/getsentry/cli/pull/1306)
- (organizations) List orgs from control silo in a single call by @betegon in [#1212](https://github.com/getsentry/cli/pull/1212)
- (snapshots) Stream-extract downloaded archives by @BYK in [#1184](https://github.com/getsentry/cli/pull/1184)
- Bump binpatch ^0.3.0 → ^0.3.1 by @BYK in [#1309](https://github.com/getsentry/cli/pull/1309)
- Load .env.local in tsx and cli dev scripts by @MathurAditya724 in [#1227](https://github.com/getsentry/cli/pull/1227)
- Pin Node to exact patched versions via central env vars by @BYK in [#1145](https://github.com/getsentry/cli/pull/1145)
- Regenerate docs by @github-actions[bot] in [def1a782](https://github.com/getsentry/cli/commit/def1a782ffdb52a1e97fcf6571ca24a61e9c7a99)

## 0.38.0

### New Features ✨

#### Debug Files

- Add bundle-sources command by @BYK in [#1126](https://github.com/getsentry/cli/pull/1126)
- Migrate DIF parser to the Archive/ObjectFile API by @BYK in [#1124](https://github.com/getsentry/cli/pull/1124)

#### Other

- (issue) Default to recommended sort on Sentry SaaS by @BYK in [#1123](https://github.com/getsentry/cli/pull/1123)
- `debug-files check` — parse DIFs via @sentry/symbolic (WASM) by @BYK in [#1109](https://github.com/getsentry/cli/pull/1109)
- Implement `debug-files bundle-jvm` command by @BYK in [#1089](https://github.com/getsentry/cli/pull/1089)

### Bug Fixes 🐛

- (alias) Only strip common word prefix from slugs that start with it by @BYK in [#1131](https://github.com/getsentry/cli/pull/1131)
- (auth) Apply host-trust gate to auto-login by @betegon in [#1122](https://github.com/getsentry/cli/pull/1122)
- (cli) Make `sentry cli --version` print the version by @BYK in [#1128](https://github.com/getsentry/cli/pull/1128)
- (init) Rotate spinner messages during long plan-codemods wait by @jared-outpost in [#1108](https://github.com/getsentry/cli/pull/1108)
- (local) Surface trace events inline in `sentry local run` by @jared-outpost in [#1105](https://github.com/getsentry/cli/pull/1105)
- (logs) Replace .parse() with .safeParse() to prevent ZodError crash on self-hosted by @jared-outpost in [#1096](https://github.com/getsentry/cli/pull/1096)
- (upgrade) Create missing install dir and skip stale stored path by @BYK in [#1125](https://github.com/getsentry/cli/pull/1125)

### Internal Changes 🔧

#### Deps

- Bump astro from 6.3.7 to 6.4.6 in /docs in the npm_and_yarn group across 1 directory by @dependabot in [#1113](https://github.com/getsentry/cli/pull/1113)
- Bump vulnerable transitive deps to patch GHSA advisories by @BYK in [#1106](https://github.com/getsentry/cli/pull/1106)

#### Other

- (deps-dev) Bump esbuild from 0.25.12 to 0.28.1 in the npm_and_yarn group across 1 directory by @dependabot in [#1101](https://github.com/getsentry/cli/pull/1101)
- (upgrade) Apply delta patch chains in memory with cached base reads by @BYK in [#1127](https://github.com/getsentry/cli/pull/1127)
- Fix 5 dependabot alerts via pnpm overrides by @BYK in [#1130](https://github.com/getsentry/cli/pull/1130)
- Regenerate docs by @github-actions[bot] in [f1f60303](https://github.com/getsentry/cli/commit/f1f603036aecac16048498e32f60d27dffd5a227)

## 0.37.0

### New Features ✨

- Remove 25 response-type `as unknown as` casts from API layer by @jared-outpost in [#1090](https://github.com/getsentry/cli/pull/1090)
- Implement `code-mappings upload` command by @BYK in [#1086](https://github.com/getsentry/cli/pull/1086)
- Implement `dart-symbol-map upload` command by @BYK in [#1085](https://github.com/getsentry/cli/pull/1085)
- Implement `cli uninstall` command by @BYK in [#1084](https://github.com/getsentry/cli/pull/1084)
- Implement `bash-hook` command for shell error reporting by @BYK in [#1083](https://github.com/getsentry/cli/pull/1083)

### Bug Fixes 🐛

- (build) Ignore NODE_OPTIONS in the SEA binary to keep the V8 code cache valid by @BYK in [#1092](https://github.com/getsentry/cli/pull/1092)
- (dashboard) Guard against undefined titles in list and resolve by @jared-outpost in [#1097](https://github.com/getsentry/cli/pull/1097)
- (init) Show actionable error when org is over its member limit by @betegon in [#1091](https://github.com/getsentry/cli/pull/1091)
- Handle slashes in default branch names for code-mappings by @BYK in [#1088](https://github.com/getsentry/cli/pull/1088)
- Use shared git helpers for code-mappings repo inference by @BYK in [#1087](https://github.com/getsentry/cli/pull/1087)
- Resolve silent error swallowing and unsafe type coercion by @BYK in [#1082](https://github.com/getsentry/cli/pull/1082)

### Documentation 📚

- Reset .lore.md with latest state by @BYK in [9d3d21e9](https://github.com/getsentry/cli/commit/9d3d21e95ef78e40c1fbb823e09b218314bdb5a4)
- Enable Starlight agent markdown by @dcramer in [#1093](https://github.com/getsentry/cli/pull/1093)

### Internal Changes 🔧

- Regenerate docs by @github-actions[bot] in [04b84fb8](https://github.com/getsentry/cli/commit/04b84fb8fbf61becbbd54e8f164f61c092ae5ee8)

## 0.36.0

### New Features ✨

#### Local

- Add --verify, --timeout, auto-detect dev script, post-init verification by @MathurAditya724 in [#998](https://github.com/getsentry/cli/pull/998)
- Inject all framework spotlight prefixes; document DSN-less capture and -f ai filter by @sergical in [#1034](https://github.com/getsentry/cli/pull/1034)

#### Other

- (alert) Add alert CRUD commands by @betegon in [#579](https://github.com/getsentry/cli/pull/579)
- (auth) Add --scope/-s and --read-only flags to login and refresh by @RaeesBhatti in [#1032](https://github.com/getsentry/cli/pull/1032)
- (monitor) Add cron monitor check-ins (monitor run / list) by @BYK in [#1069](https://github.com/getsentry/cli/pull/1069)
- (proguard) Add 'proguard upload' command (chunk-upload of R8/ProGuard mappings) by @BYK in [#1074](https://github.com/getsentry/cli/pull/1074)
- (sourcemap) Handle inline base64 sourcemaps in inject/upload by @BYK in [#1065](https://github.com/getsentry/cli/pull/1065)
- Add release archive/restore, sourcemap resolve, proguard uuid by @BYK in [#1058](https://github.com/getsentry/cli/pull/1058)
- Add send-event and send-envelope commands with DSN auth by @BYK in [#921](https://github.com/getsentry/cli/pull/921)

### Bug Fixes 🐛

#### Init

- Skip artifact dirs in project listing by @betegon in [#1081](https://github.com/getsentry/cli/pull/1081)
- Mirror onboarding project creation by @betegon in [#1077](https://github.com/getsentry/cli/pull/1077)
- Harden install command execution by @betegon in [#1045](https://github.com/getsentry/cli/pull/1045)
- Handle setup service auth failures by @betegon in [#1076](https://github.com/getsentry/cli/pull/1076)
- Stop reporting cancelled wizard prompts by @betegon in [#1075](https://github.com/getsentry/cli/pull/1075)
- Avoid stale resume replays by @betegon in [#1064](https://github.com/getsentry/cli/pull/1064)
- Validate apply-patchset paths generically by @betegon in [#1042](https://github.com/getsentry/cli/pull/1042)

#### Issue

- Validate org/project prefix in parseWithHash slash path by @BYK in [#1049](https://github.com/getsentry/cli/pull/1049)
- Handle GitHub-style #SHORTID in issue identifiers by @BYK in [#1048](https://github.com/getsentry/cli/pull/1048)

#### Other

- (cache) Atomic writes to prevent torn-read deletion of valid cache entries by @BYK in [#1056](https://github.com/getsentry/cli/pull/1056)
- (deps) Bump @sentry/api to 0.180.0 and fix downstream type errors by @betegon in [#1066](https://github.com/getsentry/cli/pull/1066)
- (local) Re-emit SIGINT/SIGTERM after cleanup in verify mode by @MathurAditya724 in [#1073](https://github.com/getsentry/cli/pull/1073)
- (stricli) Stop advertising -H as the --help-all alias by @BYK in [#1057](https://github.com/getsentry/cli/pull/1057)
- (upgrade) Resolve symlinks before self-copy guard in installBinary by @sergical in [#1046](https://github.com/getsentry/cli/pull/1046)
- Break circular import causing KNOWN_CURL_DIRS TDZ crash by @BYK in [#1072](https://github.com/getsentry/cli/pull/1072)
- Address unresolved review comments from #1058 by @BYK in [#1067](https://github.com/getsentry/cli/pull/1067)
- Address self-review findings from #1058 by @BYK in [#1063](https://github.com/getsentry/cli/pull/1063)
- Consolidate Cursor BugBot PRs (#908, #947, #973, #1023, #1044) by @BYK in [#1051](https://github.com/getsentry/cli/pull/1051)
- Preserve TTY in dev mode by inlining tsx invocation by @BYK in [#1026](https://github.com/getsentry/cli/pull/1026)

### Documentation 📚

- (proguard) Note SHA-1 is required for v5 UUID, not security by @BYK in [#1059](https://github.com/getsentry/cli/pull/1059)
- Unify BugBot audit fixes and stop AGENTS.md tree drift by @BYK in [#1050](https://github.com/getsentry/cli/pull/1050)

### Internal Changes 🔧

- (auto-paginate) Fix over-strict cursor contract at exact page boundary by @BYK in [#1060](https://github.com/getsentry/cli/pull/1060)
- (docs) Bump @sentry/starlight-theme to 0.7.0 by @sentry-junior in [#1016](https://github.com/getsentry/cli/pull/1016)
- Remove scratch migration doc, stale lore, and harden patch check by @BYK in [#1062](https://github.com/getsentry/cli/pull/1062)
- Regenerate docs by @github-actions[bot] in [297934ee](https://github.com/getsentry/cli/commit/297934ee592daf409d5a84e5b71846df3c024f4e)

## 0.35.0

### New Features ✨

#### Local

- Render OTel semantic attributes in transaction output by @BYK in [#1015](https://github.com/getsentry/cli/pull/1015)
- Add local dev server for capturing SDK events by @MathurAditya724 in [#888](https://github.com/getsentry/cli/pull/888)

#### Other

- (cli) Add `sentry cli import` for .sentryclirc migration by @BYK in [#987](https://github.com/getsentry/cli/pull/987)
- (init) Show AI-generated feature blurbs in setup summary by @betegon in [#982](https://github.com/getsentry/cli/pull/982)
- (project) Fall back to org-scoped endpoint for member project creation by @betegon in [#1030](https://github.com/getsentry/cli/pull/1030)
- Build macOS binaries natively for V8 code cache by @BYK in [#1014](https://github.com/getsentry/cli/pull/1014)

### Bug Fixes 🐛

#### Ci

- Replace deprecated macos-13 runner with ubuntu-latest for darwin-x64 by @BYK in [#1039](https://github.com/getsentry/cli/pull/1039)
- Use correct Apple signing secret names by @BYK in [#1006](https://github.com/getsentry/cli/pull/1006)

#### Dashboard

- Escape author field in revision table by @MathurAditya724 in [#1001](https://github.com/getsentry/cli/pull/1001)
- Align revision schema with actual API response by @sentry-junior in [#1000](https://github.com/getsentry/cli/pull/1000)

#### Init

- Fall back to no-platform on 400 invalid platform from registry by @betegon in [#1036](https://github.com/getsentry/cli/pull/1036)
- Recover run-level stale resume errors by @betegon in [#1025](https://github.com/getsentry/cli/pull/1025)
- Tag wizard.outcome on all early-exit paths by @betegon in [#1005](https://github.com/getsentry/cli/pull/1005)
- Match formatError priority order for WizardError message by @betegon in [#981](https://github.com/getsentry/cli/pull/981)
- Surface wizard exit code and command stderr in Sentry events (CLI-1JA) by @betegon in [#980](https://github.com/getsentry/cli/pull/980)
- Replace confusing classifyArgs errors with specific ValidationError messages by @betegon in [#979](https://github.com/getsentry/cli/pull/979)
- Add --app flag and actionable errors for non-interactive monorepo runs by @betegon in [#977](https://github.com/getsentry/cli/pull/977)
- Improve multi-org error message for agentic use by @betegon in [#974](https://github.com/getsentry/cli/pull/974)
- Enrich 401 Unauthorized errors with actionable guidance by @betegon in [#971](https://github.com/getsentry/cli/pull/971)

#### Issue

- Add JSON fields schema to issue view command by @BYK in [#1029](https://github.com/getsentry/cli/pull/1029)
- Conditionally collapse lifetime to preserve count/userCount/firstSeen/lastSeen by @BYK in [#985](https://github.com/getsentry/cli/pull/985)

#### Other

- (auth) Surface .sentryclirc source in self-hosted login errors by @betegon in [#976](https://github.com/getsentry/cli/pull/976)
- (build) Run hole-punch before signing to preserve code signature by @BYK in [#1037](https://github.com/getsentry/cli/pull/1037)
- (explore) Use tracemetrics dataset instead of metricsEnhanced by @MathurAditya724 in [#995](https://github.com/getsentry/cli/pull/995)
- (sdk) Apply Stricli flag defaults in SDK invoke path by @BYK in [#1027](https://github.com/getsentry/cli/pull/1027)
- Improve Sentry issue grouping to eliminate duplicate issues by @BYK in [#1028](https://github.com/getsentry/cli/pull/1028)
- Use file-local createRequire for relative lazy requires in src/ by @betegon in [#1008](https://github.com/getsentry/cli/pull/1008)
- Address low-priority review items from Bun→Node migration by @BYK in [#991](https://github.com/getsentry/cli/pull/991)
- Address review comments from Bun→Node migration PRs by @BYK in [#989](https://github.com/getsentry/cli/pull/989)

### Documentation 📚

- Fix stale Bun references and add systemic doc drift checks by @BYK in [#1024](https://github.com/getsentry/cli/pull/1024)
- Add esbuild bundling rules for require() in AGENTS.md by @BYK in [#1011](https://github.com/getsentry/cli/pull/1011)
- Migrate to @sentry/starlight-theme by @sentry-junior in [#996](https://github.com/getsentry/cli/pull/996)

### Internal Changes 🔧

- (init) Regression test for only-Tracing blurb bug by @betegon in [#983](https://github.com/getsentry/cli/pull/983)
- Update fossilize to 0.8.1 (fix cross-compile strip crash) by @BYK in [#1038](https://github.com/getsentry/cli/pull/1038)
- Update fossilize to 0.7.0 (built-in strip) by @BYK in [#1021](https://github.com/getsentry/cli/pull/1021)
- Strip debug symbols from Node binaries (-17 MiB) by @BYK in [#1019](https://github.com/getsentry/cli/pull/1019)
- Use Node 24 LTS for binary builds + explicit tree shaking by @BYK in [#1018](https://github.com/getsentry/cli/pull/1018)
- Defer heavy imports for ~6x faster shell completions by @BYK in [#1017](https://github.com/getsentry/cli/pull/1017)
- Add deeper smoke tests for binary and npm bundle by @BYK in [#1013](https://github.com/getsentry/cli/pull/1013)
- Update fossilize to 0.6.0 (V8 code cache support) by @BYK in [#1012](https://github.com/getsentry/cli/pull/1012)
- Replace Bun.build with fossilize for Node SEA binaries by @BYK in [#1003](https://github.com/getsentry/cli/pull/1003)
- Remove Bun artifacts and convert remaining Bun APIs by @BYK in [#1002](https://github.com/getsentry/cli/pull/1002)
- Replace bun run with tsx/pnpm across scripts and CI by @BYK in [#999](https://github.com/getsentry/cli/pull/999)
- Migrate test runner from bun:test to vitest by @BYK in [#997](https://github.com/getsentry/cli/pull/997)
- Replace remaining Bun APIs (zstd, mmap, CryptoHasher, file writer) by @BYK in [#986](https://github.com/getsentry/cli/pull/986)
- Replace Bun APIs with Node.js equivalents by @BYK in [#984](https://github.com/getsentry/cli/pull/984)
- Add SQLite adapter to decouple from bun:sqlite by @BYK in [#970](https://github.com/getsentry/cli/pull/970)
- Switch package manager from bun to pnpm by @BYK in [#967](https://github.com/getsentry/cli/pull/967)
- Regenerate docs by @github-actions[bot] in [419373cf](https://github.com/getsentry/cli/commit/419373cf0f8bbe1d3eaac7ee3306d6d0ff639bcf)

## 0.34.0

### New Features ✨

#### Init

- Tag wizard.outcome:context_error for non-interactive failures by @betegon in [#959](https://github.com/getsentry/cli/pull/959)
- Tag wizard.outcome on cli.command span by @betegon in [#948](https://github.com/getsentry/cli/pull/948)

#### Other

- (docs) Add Plausible analytics by @sergical in [#964](https://github.com/getsentry/cli/pull/964)
- (explore) Add --metric flag for auto-resolving tracemetrics format by @MathurAditya724 in [#927](https://github.com/getsentry/cli/pull/927)
- (seer) Send referrer 'api.cli' on autofix API calls by @sentry-junior in [#965](https://github.com/getsentry/cli/pull/965)
- Migrate autofix to agent-based (explorer) endpoint by @MathurAditya724 in [#962](https://github.com/getsentry/cli/pull/962)
- Show upgrade nudge when command fails and newer version exists by @MathurAditya724 in [#957](https://github.com/getsentry/cli/pull/957)

### Bug Fixes 🐛

#### Init

- Recover gracefully when org listing returns 403 by @betegon in [#963](https://github.com/getsentry/cli/pull/963)
- Recover from stale-step resume when workflow already advanced by @betegon in [#949](https://github.com/getsentry/cli/pull/949)
- Recover from member project-creation restriction by @betegon in [#960](https://github.com/getsentry/cli/pull/960)
- Thread existing project platform as detect-platform hint by @betegon in [#945](https://github.com/getsentry/cli/pull/945)
- Correct step display order in progress checklist by @betegon in [#944](https://github.com/getsentry/cli/pull/944)

#### Plan

- Surface context when Seer produces no solution by @MathurAditya724 in [#953](https://github.com/getsentry/cli/pull/953)
- Only show progress from current step by @MathurAditya724 in [#954](https://github.com/getsentry/cli/pull/954)

#### Other

- (telemetry) Use startSpan instead of startSpanManual for root span by @MathurAditya724 in [#955](https://github.com/getsentry/cli/pull/955)
- (tls) Apply custom CA certificates to all fetch call sites (CLI-1KW) by @BYK in [#966](https://github.com/getsentry/cli/pull/966)

### Internal Changes 🔧

- Regenerate docs by @github-actions[bot] in [e9f3a7aa](https://github.com/getsentry/cli/commit/e9f3a7aa1ea0ee270eeda044c45360688b70afd7)

## 0.33.0

### New Features ✨

- (dashboard) Add revision history and restore commands by @MathurAditya724 in [#936](https://github.com/getsentry/cli/pull/936)

### Bug Fixes 🐛

#### Init

- Simplify LoggingUI output for non-TTY consumers by @MathurAditya724 in [#941](https://github.com/getsentry/cli/pull/941)
- Enable interactive Ink UI for npx/Node via ESM sidecar by @MathurAditya724 in [#938](https://github.com/getsentry/cli/pull/938)

### Internal Changes 🔧

- Remove dead isBunRuntime() export by @MathurAditya724 in [#943](https://github.com/getsentry/cli/pull/943)
- Regenerate docs by @github-actions[bot] in [a4da8bd1](https://github.com/getsentry/cli/commit/a4da8bd1daa609aa520088c9fcaaa9036e285657)

## 0.32.0

### New Features ✨

#### Replay

- Paginate replay segment downloads by @dcramer in [#910](https://github.com/getsentry/cli/pull/910)
- Add first-class replay querying and inspection by @dcramer in [#904](https://github.com/getsentry/cli/pull/904)

#### Other

- (event) Support multi-event view with newline-separated IDs (CLI-1HT) by @BYK in [#903](https://github.com/getsentry/cli/pull/903)
- (init) Replace OpenTUI with Ink for the wizard UI by @MathurAditya724 in [#885](https://github.com/getsentry/cli/pull/885)
- (log) Show custom attributes in log view by @betegon in [#914](https://github.com/getsentry/cli/pull/914)
- Update @sentry/api to 0.133.0 and adopt pagination improvements by @MathurAditya724 in [#915](https://github.com/getsentry/cli/pull/915)
- Show org identity for sntrys_ tokens in whoami (CLI-1KG) by @BYK in [#905](https://github.com/getsentry/cli/pull/905)

### Bug Fixes 🐛

#### Init

- Restore ?bridge=1 cache-bust for dev mode by @MathurAditya724 in [#934](https://github.com/getsentry/cli/pull/934)
- Tighten feedback banner copy by @betegon in [#933](https://github.com/getsentry/cli/pull/933)
- Extend workflow API timeout by @betegon in [#932](https://github.com/getsentry/cli/pull/932)
- Pre-bundle Ink sidecar so it loads from $bunfs by @MathurAditya724 in [#929](https://github.com/getsentry/cli/pull/929)
- Suppress ASCII banner for agent-driven invocations by @MathurAditya724 in [#894](https://github.com/getsentry/cli/pull/894)

#### Other

- (archive) Accept 'forever' as a valid --until value by @BYK in [#918](https://github.com/getsentry/cli/pull/918)
- (auth) Bake public OAuth client ID as fallback in getClientId() by @BYK in [#916](https://github.com/getsentry/cli/pull/916)
- (dsn) Detect framework-prefixed DSN env vars in .env files and process.env by @cursor in [#852](https://github.com/getsentry/cli/pull/852)
- (feedback) Prompt interactively when message is missing in TTY by @MathurAditya724 in [#923](https://github.com/getsentry/cli/pull/923)
- (install) Pass through no-agent-skills flag by @elucid in [#919](https://github.com/getsentry/cli/pull/919)
- (issue) Accept 1 positional + --into as valid merge (CLI-1AE) by @BYK in [#920](https://github.com/getsentry/cli/pull/920)

### Internal Changes 🔧

- Update @sentry/api to ^0.141.0 by @MathurAditya724 in [#924](https://github.com/getsentry/cli/pull/924)
- Add warden.toml to enable Warden analysis on PRs by @MathurAditya724 in [#926](https://github.com/getsentry/cli/pull/926)
- Add stderr.write lint rule and document repo standards gaps by @BYK in [#906](https://github.com/getsentry/cli/pull/906)
- Regenerate docs by @github-actions[bot] in [c450b3e3](https://github.com/getsentry/cli/commit/c450b3e30481f50b08ba32fc76395b831ed7dac9)

## 0.31.0

### New Features ✨

#### Issue

- Replace individual archive flags with unified --until by @BYK in [#898](https://github.com/getsentry/cli/pull/898)
- Add archive command for ignoring/archiving issues by @BYK in [#891](https://github.com/getsentry/cli/pull/891)

#### Other

- (sourcemap) Add parity flags and sourceMappingURL following by @BYK in [#890](https://github.com/getsentry/cli/pull/890)
- (telemetry) Normalize agent tag into structured agent/version/role fields by @BYK in [#896](https://github.com/getsentry/cli/pull/896)

### Bug Fixes 🐛

#### Api

- Centralize 403 Forbidden enrichment with actionable hints (CLI-1JG) by @BYK in [#892](https://github.com/getsentry/cli/pull/892)
- Cap per_page at 100 and fill open-ended date ranges by @BYK in [#884](https://github.com/getsentry/cli/pull/884)

#### Dashboard

- Add URL auto-recovery and 404 suggestions (CLI-1K0) by @BYK in [#895](https://github.com/getsentry/cli/pull/895)
- Enrich 400 errors on create to surface plan-limit messages (CLI-1J8) by @BYK in [#893](https://github.com/getsentry/cli/pull/893)

#### Other

- (db) Handle null row in getInstanceId re-fetch (CLI-1J0) by @BYK in [#900](https://github.com/getsentry/cli/pull/900)
- (init) Preserve scope/path separators in project slugs by @MathurAditya724 in [#886](https://github.com/getsentry/cli/pull/886)
- (telemetry) Strip small IDs and org/project paths in ResolutionError grouping by @BYK in [#902](https://github.com/getsentry/cli/pull/902)
- (test) Prevent detect-agent property test flake by @BYK in [#899](https://github.com/getsentry/cli/pull/899)
- (time-range) Use UTC date methods for 90-day backfill calculation by @BYK in [#897](https://github.com/getsentry/cli/pull/897)
- (tls) Support custom CA certificates for corporate proxies (CLI-1K6) by @BYK in [#901](https://github.com/getsentry/cli/pull/901)

### Internal Changes 🔧

- Regenerate docs by @github-actions[bot] in [43045b86](https://github.com/getsentry/cli/commit/43045b86dd5f1c48d20e463781fef348eed38ad1)
- Regenerate docs by @github-actions[bot] in [19646a19](https://github.com/getsentry/cli/commit/19646a19271720da42184eaba059f235c67c8a8c)

## 0.30.0

### Security 🔒

- Scope tokens to hosts to prevent credential exfiltration by @BYK in [#844](https://github.com/getsentry/cli/pull/844)

### New Features ✨

- (docs) Auto-generate driftable doc sections (supersedes #851) by @BYK in [#873](https://github.com/getsentry/cli/pull/873)
- (explore) Auto-paginate queryEvents to support --limit > 100 by @BYK in [#874](https://github.com/getsentry/cli/pull/874)
- (help) Add common flags section and cache-age hints (#785) by @BYK in [#859](https://github.com/getsentry/cli/pull/859)
- (telemetry) Compress outgoing Sentry envelopes with zstd by @BYK in [#843](https://github.com/getsentry/cli/pull/843)
- Standardize exit codes across all CLI commands by @BYK in [#882](https://github.com/getsentry/cli/pull/882)
- Add `sentry explore` command for aggregate event queries by @BYK in [#857](https://github.com/getsentry/cli/pull/857)
- Add hidden --org/--project global flags for LLM compatibility by @BYK in [#856](https://github.com/getsentry/cli/pull/856)

### Bug Fixes 🐛

#### Api

- Throw ValidationError for user-input failures in api command (CLI-1GC) by @BYK in [#855](https://github.com/getsentry/cli/pull/855)
- Guard listOrganizations against non-array SDK responses (CLI-1CQ) by @BYK in [#854](https://github.com/getsentry/cli/pull/854)

#### Other

- (arg-parsing) Handle colon-separated issue identifiers (CLI-PH) by @BYK in [#868](https://github.com/getsentry/cli/pull/868)
- (auth) Short-circuit whoami for org auth tokens (CLI-1AZ) by @BYK in [#841](https://github.com/getsentry/cli/pull/841)
- (completions) Handle permission errors gracefully in installCompletions (CLI-1A5) by @BYK in [#867](https://github.com/getsentry/cli/pull/867)
- (init) Suppress raw ANSI escape sequences when output is piped by @BYK in [#879](https://github.com/getsentry/cli/pull/879)
- (log) Add ID column, --fields in human mode, and swapped-arg recovery by @BYK in [#871](https://github.com/getsentry/cli/pull/871)
- (search-query) Make normalizeQuery quote-aware to prevent corrupting quoted values by @BYK in [#881](https://github.com/getsentry/cli/pull/881)
- (sourcemap) Error on zero pairs + restore docs sourcemap emission by @BYK in [#846](https://github.com/getsentry/cli/pull/846)
- (span-list) Query all projects in trace mode for cross-project traces by @BYK in [#878](https://github.com/getsentry/cli/pull/878)
- (telemetry) Skip os.cpus() in NodeContext to prevent crash on restricted systems (CLI-1ED) by @BYK in [#876](https://github.com/getsentry/cli/pull/876)
- (test) Isolate repositories test to prevent response cache bleed by @BYK in [#864](https://github.com/getsentry/cli/pull/864)
- Auto-repair malformed search queries and fix telemetry object serialization (CLI-FA) by @BYK in [#872](https://github.com/getsentry/cli/pull/872)
- Use human-readable byte sizes in upgrade verbose output by @BYK in [#866](https://github.com/getsentry/cli/pull/866)
- Replace dead-end @latest selector error hint with actionable alternative (CLI-1ET) by @BYK in [#865](https://github.com/getsentry/cli/pull/865)

### Internal Changes 🔧

- (api) Migrate dashboards.ts CRUD to SDK functions by @MathurAditya724 in [#863](https://github.com/getsentry/cli/pull/863)
- (auth) Memoize hasStoredAuthCredentials to avoid per-request SQL read by @BYK in [#869](https://github.com/getsentry/cli/pull/869)
- (search-query) Generic normalizeQuery pipeline for pre-parse query repair (CLI-FA) by @BYK in [#880](https://github.com/getsentry/cli/pull/880)
- (sourcemap-upload) Skip ZIP-level DEFLATE when wire codec compresses (62% CPU, 5.9% wire) by @BYK in [#849](https://github.com/getsentry/cli/pull/849)
- Cache resolved project info after create and init by @BYK in [#877](https://github.com/getsentry/cli/pull/877)
- Generalize resolveOrgProjectTarget to support org-all mode by @BYK in [#875](https://github.com/getsentry/cli/pull/875)
- Collapse test/isolated/ into test/lib and test/commands by @BYK in [#840](https://github.com/getsentry/cli/pull/840)
- Adopt bun test --isolate --parallel for ~2.9x CI speedup by @BYK in [#839](https://github.com/getsentry/cli/pull/839)
- Regenerate docs by @github-actions[bot] in [c0693387](https://github.com/getsentry/cli/commit/c069338731d79c8780dbf6f1af27c0a012469c94)

## 0.29.1

### Bug Fixes 🐛

- (polyfill) Add missing Bun.file().stat() shim for npm distribution by @BYK in [#838](https://github.com/getsentry/cli/pull/838)

### Internal Changes 🔧

- (deps) Bump Bun from 1.3.11 to 1.3.13 by @BYK in [#837](https://github.com/getsentry/cli/pull/837)
- Regenerate docs by @github-actions[bot] in [ff574c98](https://github.com/getsentry/cli/commit/ff574c983076aab38f1e657d9623bdee0c85ec65)

## 0.29.0

### Security 🔒

- (deps) Upgrade docs to Astro 6 / Starlight 0.38 by @BYK in [#816](https://github.com/getsentry/cli/pull/816)

### New Features ✨

- (auth) Hint when env token is shadowed by stored OAuth (#785) by @BYK in [#790](https://github.com/getsentry/cli/pull/790)
- (cache) Scope response cache per active identity (#785) by @BYK in [#788](https://github.com/getsentry/cli/pull/788)
- (help) Add Environment Variables section to branded help (#785) by @BYK in [#786](https://github.com/getsentry/cli/pull/786)
- (issue) Add resolve, unresolve (reopen), and merge commands by @BYK in [#778](https://github.com/getsentry/cli/pull/778)
- (scan) Pure-TS ripgrep-compatible scanner + DSN migration + perf overhaul by @BYK in [#791](https://github.com/getsentry/cli/pull/791)
- (sourcemap-upload) Add zstd compression support by @BYK in [#823](https://github.com/getsentry/cli/pull/823)

### Bug Fixes 🐛

#### Dashboard

- Auto-default --limit for grouped widgets (CLI-WW) by @BYK in [#799](https://github.com/getsentry/cli/pull/799)
- Accept dataset aliases (errors, transactions, metrics) (CLI-JG) by @BYK in [#800](https://github.com/getsentry/cli/pull/800)

#### Init

- Restore /dev/tty workaround on macOS only by @BYK in [#836](https://github.com/getsentry/cli/pull/836)
- Add force-exit safety net for Bun fresh+readline hang by @BYK in [#833](https://github.com/getsentry/cli/pull/833)
- Release stdin handle to unblock event loop on wizard exit by @BYK in [#831](https://github.com/getsentry/cli/pull/831)
- Cancel in-flight Mastra requests on teardown by @BYK in [#825](https://github.com/getsentry/cli/pull/825)
- Harden /dev/tty teardown and adopt Symbol.dispose by @BYK in [#824](https://github.com/getsentry/cli/pull/824)
- Release /dev/tty handle on all exit paths by @betegon in [#802](https://github.com/getsentry/cli/pull/802)
- Send dirListing/fileCache/existingSentry via initialState by @betegon in [#796](https://github.com/getsentry/cli/pull/796)
- Force process exit after wizard completes by @betegon in [#782](https://github.com/getsentry/cli/pull/782)

#### Other

- (api) Clone request body per retry + classify timeouts (CLI-1D6) by @BYK in [#829](https://github.com/getsentry/cli/pull/829)
- (arg-parsing) Throw ValidationError (not raw Error) for format errors by @BYK in [#793](https://github.com/getsentry/cli/pull/793)
- (dsn) Skip non-regular env files during detection by @elucid in [#806](https://github.com/getsentry/cli/pull/806)
- (error-reporting) Fall back to message prefix for ValidationError without field by @BYK in [#776](https://github.com/getsentry/cli/pull/776)
- (errors) Surface real API errors and granular scopes in 403s (#785) by @BYK in [#789](https://github.com/getsentry/cli/pull/789)
- (hex-id) Auto-recover malformed hex IDs in view commands (CLI-16G) by @BYK in [#777](https://github.com/getsentry/cli/pull/777)
- (upgrade) Verify downloaded binary exists before spawn (CLI-1D3) by @BYK in [#827](https://github.com/getsentry/cli/pull/827)
- (ux) Rate-limit update banner and silence /api/0/ auto-fix (#785) by @BYK in [#787](https://github.com/getsentry/cli/pull/787)

### Documentation 📚

- Fix auth token precedence, update stale architecture tree, and documentation audit report by @cursor in [#783](https://github.com/getsentry/cli/pull/783)

### Internal Changes 🔧

#### Deps

- Bump @sentry/node-core to 10.50.0 by @BYK in [#834](https://github.com/getsentry/cli/pull/834)
- Drop Node 20 support, pin CI Node 24 for docs build by @BYK in [#817](https://github.com/getsentry/cli/pull/817)
- Upgrade @sentry/api 0.94.0 -> 0.113.0 + type cleanup by @BYK in [#803](https://github.com/getsentry/cli/pull/803)

#### Init

- Remove /dev/tty forwarding workaround and force-exit safety net by @BYK in [#835](https://github.com/getsentry/cli/pull/835)
- Tighten list-dir hot loop + emit POSIX paths by @BYK in [#815](https://github.com/getsentry/cli/pull/815)
- Migrate grep/glob tools to src/lib/scan/ by @BYK in [#797](https://github.com/getsentry/cli/pull/797)
- Trim deprecated --features help entries by @MathurAditya724 in [#781](https://github.com/getsentry/cli/pull/781)

#### Scan

- Transport grep worker line pool as bytes by @BYK in [#826](https://github.com/getsentry/cli/pull/826)
- Fast-path known-binary extensions in classifyByExtension by @BYK in [#822](https://github.com/getsentry/cli/pull/822)
- Dual-path walker — parallel bulk, serial early-exit by @BYK in [#821](https://github.com/getsentry/cli/pull/821)
- Parallel grep via worker pool with binary-transferable matches by @BYK in [#807](https://github.com/getsentry/cli/pull/807)
- Rewrite walker hot path with sync I/O + manual string ops by @BYK in [#805](https://github.com/getsentry/cli/pull/805)
- Literal prefilter + lazy line counting in readAndGrep by @BYK in [#804](https://github.com/getsentry/cli/pull/804)

#### Other

- (api) Pass ?collapse=organization on project detail fetches by @BYK in [#818](https://github.com/getsentry/cli/pull/818)
- (auth) Memoize getAuthToken and refreshToken row read (CLI-13V) by @BYK in [#828](https://github.com/getsentry/cli/pull/828)
- (cache) Centralize mutation invalidation at the HTTP layer (#792) by @BYK in [#801](https://github.com/getsentry/cli/pull/801)
- (fs) Add safeReadFile helper for FIFO-safe config reads by @BYK in [#819](https://github.com/getsentry/cli/pull/819)
- (issue) Skip redundant API lookups via project+issue-org caches by @BYK in [#794](https://github.com/getsentry/cli/pull/794)
- (scan,dsn) Trim session cruft from comment-heavy files by @BYK in [#810](https://github.com/getsentry/cli/pull/810)
- (sentry-client) Scope fetch mocks to a per-test URL marker by @BYK in [#832](https://github.com/getsentry/cli/pull/832)
- (sourcemap) Migrate discoverFilePairs to walkFiles by @BYK in [#811](https://github.com/getsentry/cli/pull/811)
- Skip docs preview deploy on fork PRs by @BYK in [#814](https://github.com/getsentry/cli/pull/814)
- Unblock fork PRs (SENTRY_CLIENT_ID fallback + fork-safe checkout) by @BYK in [#813](https://github.com/getsentry/cli/pull/813)
- Disable Bun autoload of .env and bunfig.toml in compiled CLI by @BYK in [#808](https://github.com/getsentry/cli/pull/808)
- Regenerate docs by @github-actions[bot] in [58a84035](https://github.com/getsentry/cli/commit/58a8403504e1cf30e6bd8e302f5e042f1a83393e)

## 0.28.1

### Bug Fixes 🐛

#### Init

- Use isatty(0) for TTY detection and add diagnostic probe by @BYK in [#767](https://github.com/getsentry/cli/pull/767)
- Reuse detected existing project data by @betegon in [#766](https://github.com/getsentry/cli/pull/766)
- Ensure project reuse and spinner states by @MathurAditya724 in [#763](https://github.com/getsentry/cli/pull/763)

#### Other

- (arg-parsing) Accept underscores in Sentry slugs (#770) by @BYK in [#771](https://github.com/getsentry/cli/pull/771)
- (ci) Scope build-binary and build-docs to production environment by @BYK in [#773](https://github.com/getsentry/cli/pull/773)
- (dsn) Limit concurrent stat() calls in project root detection (CLI-19A) by @BYK in [#768](https://github.com/getsentry/cli/pull/768)
- (project-create) Preserve ApiError type so 4xx errors are silenced by @BYK in [#775](https://github.com/getsentry/cli/pull/775)
- (resolve-target) Reference original input in fuzzy-recovery warnings (#772) by @BYK in [#774](https://github.com/getsentry/cli/pull/774)
- (telemetry) Reduce Sentry issue fragmentation with stable fingerprinting by @BYK in [#769](https://github.com/getsentry/cli/pull/769)

### Internal Changes 🔧

- Regenerate docs by @github-actions[bot] in [e02799c1](https://github.com/getsentry/cli/commit/e02799c1cb4a4c35ec981e1973a9b0dee78f2ae7)

## 0.28.0

### New Features ✨

- (build) Add musl binaries for Alpine Linux support by @BYK in [#762](https://github.com/getsentry/cli/pull/762)
- (custom-headers) Add SENTRY_CUSTOM_HEADERS for self-hosted proxy auth by @BYK in [#761](https://github.com/getsentry/cli/pull/761)
- (init) Pre-supply existingSentry to eliminate roundtrip by @betegon in [#755](https://github.com/getsentry/cli/pull/755)

### Bug Fixes 🐛

- (arg-parsing) Normalize spaces in slugs and trim whitespace in issue IDs (CLI-14M, CLI-16M) by @BYK in [#757](https://github.com/getsentry/cli/pull/757)
- (ci) Install libstdc++/libgcc for Alpine smoke test and add musl to PR matrix by @BYK in [#765](https://github.com/getsentry/cli/pull/765)
- (search) Rewrite OR queries to in-list syntax across all --query commands (CLI-16J) by @BYK in [#758](https://github.com/getsentry/cli/pull/758)
- (upgrade) Retry spawn on EBUSY for Windows Defender file locking (CLI-16E) by @BYK in [#756](https://github.com/getsentry/cli/pull/756)

### Internal Changes 🔧

- (init) Split tools and preflight by @betegon in [#764](https://github.com/getsentry/cli/pull/764)
- (time-range) Parse --period at flag level via parsePeriod by @BYK in [#760](https://github.com/getsentry/cli/pull/760)
- Regenerate docs by @github-actions[bot] in [34bf056d](https://github.com/getsentry/cli/commit/34bf056d0bca3cc90f0287dbda44bc1c140d64b2)

## 0.27.0

### New Features ✨

- (cli) Add `sentry cli defaults` command for persistent settings by @BYK in [#721](https://github.com/getsentry/cli/pull/721)
- (docs) Auto-generate driftable documentation sections by @BYK in [#739](https://github.com/getsentry/cli/pull/739)
- (issue-list) Add search syntax docs, case-insensitive AND/OR, and JSON syntax reference by @BYK in [#738](https://github.com/getsentry/cli/pull/738)
- (setup) Install agent skills for detected roots by @betegon in [#747](https://github.com/getsentry/cli/pull/747)
- (trace) Consistent project filtering across trace commands (#737) by @BYK in [#743](https://github.com/getsentry/cli/pull/743)
- (trace-view) Expose span attributes in trace and span views by @BYK in [#742](https://github.com/getsentry/cli/pull/742)

### Bug Fixes 🐛

#### Event View

- Validate event ID format before API call (CLI-156) by @BYK in [#751](https://github.com/getsentry/cli/pull/751)
- Add cross-org fallback when event not found by @BYK in [#744](https://github.com/getsentry/cli/pull/744)

#### Init

- Treat no-op edits as passthrough instead of throwing by @betegon in [#731](https://github.com/getsentry/cli/pull/731)
- Remove JSON minification that breaks edit-based codemods by @betegon in [#719](https://github.com/getsentry/cli/pull/719)

#### Issue List

- Auto-recover when user passes issue short ID instead of project slug by @BYK in [#750](https://github.com/getsentry/cli/pull/750)
- Auto-correct AND and reject OR in --query to prevent 400 by @BYK in [#727](https://github.com/getsentry/cli/pull/727)

#### Resolve

- Address review comments and add tests for fuzzy project recovery by @BYK in [#732](https://github.com/getsentry/cli/pull/732)
- Fuzzy auto-recovery for project slug resolution by @BYK in [#728](https://github.com/getsentry/cli/pull/728)

#### Upgrade

- Contextual error messages for offline cache miss (CLI-13Z) by @BYK in [#752](https://github.com/getsentry/cli/pull/752)
- Detect npm install method from node_modules path by @BYK in [#723](https://github.com/getsentry/cli/pull/723)
- Add shell option on Windows for .cmd package managers by @BYK in [#722](https://github.com/getsentry/cli/pull/722)

#### Other

- (ci) Add retry logic to ORAS/bsdiff downloads and upgrade ORAS by @BYK in [#741](https://github.com/getsentry/cli/pull/741)
- (dashboard) Remove overly restrictive dataset-display cross-validation by @BYK in [#720](https://github.com/getsentry/cli/pull/720)
- (delta-upgrade) Filter non-versioned nightly tags from GHCR patch generation by @BYK in [#753](https://github.com/getsentry/cli/pull/753)
- (errors) Improve ContextError wording for auto-detect failures by @BYK in [#726](https://github.com/getsentry/cli/pull/726)
- (issue) Support share issue URLs by @BYK in [#718](https://github.com/getsentry/cli/pull/718)
- (release-delete) Enrich error for releases with health data (CLI-14K) by @BYK in [#749](https://github.com/getsentry/cli/pull/749)
- (telemetry) Rename isClientApiError to isUserApiError and exclude 400 by @BYK in [#729](https://github.com/getsentry/cli/pull/729)
- Bug fixes from Sentry error monitoring (CLI-FR, CLI-RN) + auth default by @BYK in [#740](https://github.com/getsentry/cli/pull/740)

### Internal Changes 🔧

- Regenerate skill files by @github-actions[bot] in [ca16b2ff](https://github.com/getsentry/cli/commit/ca16b2ff3501fa65fc57f208e29e01d38b474eb8)

## 0.26.1

### Bug Fixes 🐛

- (build) Normalize Windows backslash paths for sourcemap resolution by @BYK in [#714](https://github.com/getsentry/cli/pull/714)
- (dashboard) Guard sort param by dataset in widget table queries by @BYK in [#715](https://github.com/getsentry/cli/pull/715)
- (test) Silence "unexpected fetch call to" warnings in unit tests by @BYK in [#716](https://github.com/getsentry/cli/pull/716)

## 0.26.0

### New Features ✨

#### Docs

- Deploy main branch preview alongside PR previews by @BYK in [#707](https://github.com/getsentry/cli/pull/707)
- Enable sourcemap upload, releases, and environment tracking by @BYK in [#705](https://github.com/getsentry/cli/pull/705)

#### Init

- Pre-read common config files to reduce round-trips by @betegon in [#704](https://github.com/getsentry/cli/pull/704)
- Add grep and glob local-op handlers by @betegon in [#703](https://github.com/getsentry/cli/pull/703)
- Add fuzzy edit replacers and edits-based apply-patchset by @betegon in [#698](https://github.com/getsentry/cli/pull/698)

#### Other

- (cli) Hoist global flags from any argv position and add -v alias by @BYK in [#709](https://github.com/getsentry/cli/pull/709)
- (commands) Add buildRouteMap wrapper with standard subcommand aliases by @BYK in [#690](https://github.com/getsentry/cli/pull/690)
- (config) Support .sentryclirc config file for per-directory defaults by @BYK in [#693](https://github.com/getsentry/cli/pull/693)
- (install) Add SENTRY_INIT env var to run wizard after install by @betegon in [#685](https://github.com/getsentry/cli/pull/685)
- (release) Surface adoption and health metrics in list and view (#463) by @BYK in [#680](https://github.com/getsentry/cli/pull/680)
- (telemetry) Add agent detection tag for AI coding tools by @betegon in [#687](https://github.com/getsentry/cli/pull/687)

### Bug Fixes 🐛

#### Dashboard

- Add --layout flag to widget add for predictable placement by @BYK in [#700](https://github.com/getsentry/cli/pull/700)
- Render tracemetrics widgets in dashboard view by @BYK in [#695](https://github.com/getsentry/cli/pull/695)

#### Init

- Add size guard and deduplicate JSON minification in preReadCommonFiles by @betegon in [#713](https://github.com/getsentry/cli/pull/713)
- Narrow command validation to actual shell injection vectors by @betegon in [#697](https://github.com/getsentry/cli/pull/697)

#### Other

- (build) Enable sourcemap resolution for compiled binaries by @BYK in [#701](https://github.com/getsentry/cli/pull/701)
- (cache) --fresh flag now updates cache with fresh response by @BYK in [#708](https://github.com/getsentry/cli/pull/708)
- (eval) Ground LLM judge with command reference to prevent false negatives by @BYK in [#712](https://github.com/getsentry/cli/pull/712)
- (init,feedback) Default to tracing only in feature select and attach user email to feedback by @MathurAditya724 in [#688](https://github.com/getsentry/cli/pull/688)
- (setup) Handle read-only .claude directory in sandboxed environments by @BYK in [#702](https://github.com/getsentry/cli/pull/702)
- Inject auth token into generated .env.sentry-build-plugin files by @MathurAditya724 in [#706](https://github.com/getsentry/cli/pull/706)

### Internal Changes 🔧

- (docs) Gitignore generated command docs, extract fragments by @BYK in [#696](https://github.com/getsentry/cli/pull/696)
- (eval) Replace OpenAI with Anthropic SDK in init-eval judge by @betegon in [#683](https://github.com/getsentry/cli/pull/683)
- (init) Use markdown pipeline for spinner messages by @betegon in [#686](https://github.com/getsentry/cli/pull/686)
- Regenerate skill files and command docs by @github-actions[bot] in [584ec0e0](https://github.com/getsentry/cli/commit/584ec0e001611873197c52a01156bef1c4fe9431)

## 0.25.0

### New Features ✨

- (event) Add 'sentry event list' command for issue-scoped event listing by @BYK in [#671](https://github.com/getsentry/cli/pull/671)
- (init) Add detect-sentry local-op for cross-language Sentry detection by @betegon in [#657](https://github.com/getsentry/cli/pull/657)
- (issue) Add `sentry issue events` command (#632) by @BYK in [#654](https://github.com/getsentry/cli/pull/654)
- (period) Support absolute date ranges in --period flag by @BYK in [#674](https://github.com/getsentry/cli/pull/674)

### Bug Fixes 🐛

#### Init

- Run commands without shell to eliminate injection surface by @betegon in [#665](https://github.com/getsentry/cli/pull/665)
- Use opendir for listDir and validate symlinks during traversal by @betegon in [#663](https://github.com/getsentry/cli/pull/663)
- Rename 'Custom Metrics' feature label to 'Metrics' by @MathurAditya724 in [#659](https://github.com/getsentry/cli/pull/659)
- Add reactFeatures to feature display info by @MathurAditya724 in [#658](https://github.com/getsentry/cli/pull/658)
- Generate spinner messages from payload params instead of server detail by @MathurAditya724 in [#655](https://github.com/getsentry/cli/pull/655)

#### Other

- (auth) Fall back to OAuth when env token lacks endpoint permissions by @BYK in [#673](https://github.com/getsentry/cli/pull/673)
- (errors) Separate informational notes from actionable alternatives in ContextError by @BYK in [#651](https://github.com/getsentry/cli/pull/651)
- (skill-gen) Eliminate manual maps to prevent undocumented commands by @BYK in [#670](https://github.com/getsentry/cli/pull/670)
- Three bug fixes from Sentry telemetry (CLI-SC, CLI-QZ, CLI-WD) by @cursor in [#664](https://github.com/getsentry/cli/pull/664)
- Fix set-commits --auto, document release workflow pitfalls by @BYK in [#650](https://github.com/getsentry/cli/pull/650)

### Internal Changes 🔧

#### Init

- Use shared YES_FLAG and add -y alias constant by @betegon in [#681](https://github.com/getsentry/cli/pull/681)
- Reuse resolveOrCreateTeam for wizard team resolution by @betegon in [#679](https://github.com/getsentry/cli/pull/679)
- Route wizard errors through framework error pipeline by @betegon in [#678](https://github.com/getsentry/cli/pull/678)
- Use guardNonInteractive for TTY check by @betegon in [#677](https://github.com/getsentry/cli/pull/677)
- Use shared DRY_RUN_FLAG and add -n alias by @betegon in [#676](https://github.com/getsentry/cli/pull/676)
- Reuse resolveOrg for offline-first org detection by @betegon in [#666](https://github.com/getsentry/cli/pull/666)
- Use mdKvTable and renderMarkdown for wizard summary by @betegon in [#661](https://github.com/getsentry/cli/pull/661)

#### Other

- Extract createProjectWithDsn to deduplicate project creation by @betegon in [#667](https://github.com/getsentry/cli/pull/667)
- Regenerate skill files and command docs by @github-actions[bot] in [eb1b19e7](https://github.com/getsentry/cli/commit/eb1b19e70a31e44695e0b84b7ce76a7928f7c828)

### Other

- Update custom.css by @stevenplewis in [#653](https://github.com/getsentry/cli/pull/653)

## 0.24.1

### Bug Fixes 🐛

- (ci) Fix set-commits --auto and add checkout/URL to sentry-release workflow by @BYK in [#649](https://github.com/getsentry/cli/pull/649)
- (upgrade) Add blank lines around changelog in upgrade output by @BYK in [#642](https://github.com/getsentry/cli/pull/642)

### Internal Changes 🔧

- Restore sentry/ org prefix in sentry-release workflow by @BYK in [#648](https://github.com/getsentry/cli/pull/648)
- Use production environment for sentry-release auth token by @BYK in [#645](https://github.com/getsentry/cli/pull/645)
- Fix sentry-release workflow Node.js version and add manual trigger by @BYK in [#643](https://github.com/getsentry/cli/pull/643)
- Regenerate skill files and command docs by @github-actions[bot] in [59c820e4](https://github.com/getsentry/cli/commit/59c820e430d04f4816b35cc463f4d08102512fa4)

## 0.24.0

### New Features ✨

#### Telemetry

- Add cache hit rate metric across all cache systems by @BYK in [#638](https://github.com/getsentry/cli/pull/638)
- Add performance instrumentation and CLI Performance dashboard by @BYK in [#625](https://github.com/getsentry/cli/pull/625)
- Upgrade Sentry SDK to 10.47.0 and enable runtime metrics by @BYK in [#622](https://github.com/getsentry/cli/pull/622)

#### Other

- (auth) Show token expiry in days/weeks instead of raw hours by @BYK in [#620](https://github.com/getsentry/cli/pull/620)
- (ci) Add delta patch generation for stable releases by @BYK in [#618](https://github.com/getsentry/cli/pull/618)
- (commands) Add shared helpers and buildDeleteCommand for mutation commands by @BYK in [#639](https://github.com/getsentry/cli/pull/639)
- (dashboard) Render text widget markdown content in dashboard view by @BYK in [#624](https://github.com/getsentry/cli/pull/624)
- (release) Add release command group and CI finalization by @BYK in [#628](https://github.com/getsentry/cli/pull/628)
- (traces) Expose custom span attributes and improve agent guidance by @BYK in [#623](https://github.com/getsentry/cli/pull/623)
- Improve unknown command UX with aliases, default routing, and suggestions by @BYK in [#635](https://github.com/getsentry/cli/pull/635)

### Bug Fixes 🐛

#### Telemetry

- Exclude OutputError from Sentry exception capture (CLI-PK) by @BYK in [#629](https://github.com/getsentry/cli/pull/629)
- Derive environment from CLI_VERSION instead of NODE_ENV by @BYK in [#627](https://github.com/getsentry/cli/pull/627)

#### Other

- (build) Use esbuild for binary bundling to fix minifier collision bug by @BYK in [#619](https://github.com/getsentry/cli/pull/619)
- (ci) Restore GH_TOKEN for gh CLI steps in generate-patches by @BYK in [#634](https://github.com/getsentry/cli/pull/634)
- (commands) Add regression test for Stricli numberParser defaults (#640) by @BYK in [#641](https://github.com/getsentry/cli/pull/641)
- (init) Prompt for team selection when user belongs to multiple teams by @betegon in [#621](https://github.com/getsentry/cli/pull/621)
- (polyfill) Add missing Bun API polyfills for npm distribution by @BYK in [#637](https://github.com/getsentry/cli/pull/637)
- (upgrade) Remove "What's new" header from changelog output by @BYK in [#626](https://github.com/getsentry/cli/pull/626)

### Documentation 📚

- Add tracemetrics dataset guidance and validate aggregate format by @BYK in [#636](https://github.com/getsentry/cli/pull/636)

### Internal Changes 🔧

- (deps) Upgrade @sentry/api from 0.54.0 to 0.94.0 by @BYK in [#630](https://github.com/getsentry/cli/pull/630)
- Remove stale debug-level stderr assertions and fix logger state leak by @BYK in [#631](https://github.com/getsentry/cli/pull/631)
- Regenerate skill files and command docs by @github-actions[bot] in [e01b2520](https://github.com/getsentry/cli/commit/e01b2520ff6c858e032d2714e4e16168bdeef926)

## 0.23.0

### New Features ✨

- (auth) Enforce auth by default in buildCommand by @betegon in [#611](https://github.com/getsentry/cli/pull/611)
- (skill) Add eval framework to measure SKILL.md effectiveness by @BYK in [#602](https://github.com/getsentry/cli/pull/602)
- (telemetry) Add seer.outcome span tag for Seer command metrics by @BYK in [#609](https://github.com/getsentry/cli/pull/609)
- (upgrade) Show changelog summary during CLI upgrade by @BYK in [#594](https://github.com/getsentry/cli/pull/594)

### Bug Fixes 🐛

#### Upgrade

- Prevent spinner freeze during delta patch application by @BYK in [#608](https://github.com/getsentry/cli/pull/608)
- Indent changelog, add emoji to heading, hide empty sections by @BYK in [#604](https://github.com/getsentry/cli/pull/604)

#### Other

- (build) Disable identifier minification to fix marked crash by @betegon in [#617](https://github.com/getsentry/cli/pull/617)
- (dashboard) Reject MRI queries with actionable tracemetrics guidance by @BYK in [#601](https://github.com/getsentry/cli/pull/601)
- (init) Prompt/spinner ordering by @betegon in [#610](https://github.com/getsentry/cli/pull/610)
- (skill) Avoid unnecessary auth, reinforce auto-detection, fix field examples by @BYK in [#599](https://github.com/getsentry/cli/pull/599)
- (test) Fix CI hang, auth guard tests, and PR #610 test rewrite by @betegon in [#616](https://github.com/getsentry/cli/pull/616)
- 2 bug fixes — subcommand crash, negative span depth, pagination JSON parse by @cursor in [#607](https://github.com/getsentry/cli/pull/607)

### Documentation 📚

- (skill) Document dashboard widget constraints and deprecated datasets by @BYK in [#605](https://github.com/getsentry/cli/pull/605)
- Fix documentation gaps and embed skill files at build time by @cursor in [#606](https://github.com/getsentry/cli/pull/606)

### Internal Changes 🔧

- Regenerate skill files and command docs by @github-actions[bot] in [664362ca](https://github.com/getsentry/cli/commit/664362cab8a999b0f96bb62b9cfd648db846b0b5)

## 0.22.0

### New Features ✨

- (dashboard) Add layout/position flags to widget edit and add commands by @BYK in [#591](https://github.com/getsentry/cli/pull/591)
- (init) Surface server-provided detail in spinner messages by @MathurAditya724 in [#588](https://github.com/getsentry/cli/pull/588)
- AsyncIterable streaming support for library SDK by @BYK in [#586](https://github.com/getsentry/cli/pull/586)

### Bug Fixes 🐛

#### Dashboard

- Normalize numeric org IDs from DSN auto-detection by @BYK in [#593](https://github.com/getsentry/cli/pull/593)
- Show actionable error messages instead of raw API errors by @BYK in [#592](https://github.com/getsentry/cli/pull/592)

#### Other

- (auth) Skip stale cached user info for env var tokens in `auth status` by @BYK in [#589](https://github.com/getsentry/cli/pull/589)
- (upgrade) Move delta patch log.info outside spinner callback by @BYK in [#590](https://github.com/getsentry/cli/pull/590)

### Internal Changes 🔧

- Remove upstream issue templates for Sentry SDK light exports by @MathurAditya724 in [#596](https://github.com/getsentry/cli/pull/596)
- Regenerate skill files and command docs by @github-actions[bot] in [0276f760](https://github.com/getsentry/cli/commit/0276f760f0d5b9596b8208a1066156eb935c04cb)

## 0.21.0

### New Features ✨

#### Dashboard

- Add pagination and glob filtering to dashboard list by @BYK in [#560](https://github.com/getsentry/cli/pull/560)
- Add a full chart rendering engine for `sentry dashboard view` that transforms widget data into rich terminal visualizations. by @BYK in [#555](https://github.com/getsentry/cli/pull/555)

#### Init

- Propagate sentry-trace headers to wizard API calls by @betegon in [#567](https://github.com/getsentry/cli/pull/567)
- Treat bare slug as new project name when not found by @BYK in [#554](https://github.com/getsentry/cli/pull/554)

#### Other

- (formatters) Colorize SQL in DB span descriptions by @BYK in [#546](https://github.com/getsentry/cli/pull/546)
- (output) Add Zod schema registration to OutputConfig for self-documenting JSON fields by @BYK in [#582](https://github.com/getsentry/cli/pull/582)
- (telemetry) Report unknown commands to Sentry by @BYK in [#563](https://github.com/getsentry/cli/pull/563)
- Expose CLI as a programmatic library by @BYK in [#565](https://github.com/getsentry/cli/pull/565)
- Bidirectional cursor pagination (-c next / -c prev) by @BYK in [#564](https://github.com/getsentry/cli/pull/564)
- Add `sentry sourcemap inject` and `sentry sourcemap upload` commands by @BYK in [#547](https://github.com/getsentry/cli/pull/547)
- Native debug ID injection and sourcemap upload by @BYK in [#543](https://github.com/getsentry/cli/pull/543)

### Bug Fixes 🐛

#### Dashboard

- Fix table widget rendering and timeseries bar chart width by @BYK in [#584](https://github.com/getsentry/cli/pull/584)
- Validate display types against all datasets by @betegon in [#577](https://github.com/getsentry/cli/pull/577)
- Auto-clamp widget limit instead of erroring by @BYK in [#573](https://github.com/getsentry/cli/pull/573)
- Default issue dataset table columns to ["issue"] by @betegon in [#570](https://github.com/getsentry/cli/pull/570)
- Scale timeseries bar width to fill chart area by @BYK in [#562](https://github.com/getsentry/cli/pull/562)
- Resolve dashboard by ID/slug in addition to title by @BYK in [#559](https://github.com/getsentry/cli/pull/559)

#### Event

- Detect SHORT-ID/EVENT-ID format in event view by @BYK in [#574](https://github.com/getsentry/cli/pull/574)
- Auto-fallback to org-wide search when event 404s in project by @BYK in [#575](https://github.com/getsentry/cli/pull/575)

#### Other

- (api) Show meaningful message for network errors instead of '0 Unknown' by @BYK in [#572](https://github.com/getsentry/cli/pull/572)
- (event-view) Auto-redirect issue short IDs in two-arg form (CLI-MP) by @BYK in [#558](https://github.com/getsentry/cli/pull/558)
- (help) Show help when user passes `help` as positional arg by @BYK in [#561](https://github.com/getsentry/cli/pull/561)
- (issue) Auto-redirect bare org slug to org-all mode in issue list by @BYK in [#576](https://github.com/getsentry/cli/pull/576)
- (log) Use 30d default period and show newest logs first by @sergical in [#568](https://github.com/getsentry/cli/pull/568)
- Reject @-selectors in parseOrgProjectArg with helpful redirect by @BYK in [#557](https://github.com/getsentry/cli/pull/557)

### Documentation 📚

- Add missing command pages for trace, span, sourcemap, repo, trial, schema by @sergical in [#569](https://github.com/getsentry/cli/pull/569)

### Internal Changes 🔧

#### Coverage

- Use informational-patch input instead of sed hack by @BYK in [#544](https://github.com/getsentry/cli/pull/544)
- Make checks informational on release branches by @BYK in [#541](https://github.com/getsentry/cli/pull/541)

#### Event

- Replace "latest" magic string with @latest sentinel constant by @BYK in [#583](https://github.com/getsentry/cli/pull/583)
- Deduplicate span tree building into shared helper by @BYK in [#581](https://github.com/getsentry/cli/pull/581)

#### Other

- (api) Collapse stats on issue detail endpoints to save 100-300ms by @BYK in [#551](https://github.com/getsentry/cli/pull/551)
- (ci) Upgrade GitHub Actions to Node 24 runtime by @BYK in [#542](https://github.com/getsentry/cli/pull/542)
- (db) DRY up database layer with shared helpers and lint enforcement by @BYK in [#550](https://github.com/getsentry/cli/pull/550)
- (docs) Polish sidebar, header, focus, and code block UX by @sergical in [#580](https://github.com/getsentry/cli/pull/580)
- (issue-list) Use collapse parameter to skip unused Snuba queries by @BYK in [#545](https://github.com/getsentry/cli/pull/545)
- Bump Bun from 1.3.9 to 1.3.11 by @BYK in [#552](https://github.com/getsentry/cli/pull/552)
- Regenerate skill files by @github-actions[bot] in [ec1ffe28](https://github.com/getsentry/cli/commit/ec1ffe2810eb5054ac7aa81ba9dac7bfccedb1fd)

## 0.20.0

### New Features ✨

- (install) Support SENTRY_VERSION env var for version pinning by @BYK in [#537](https://github.com/getsentry/cli/pull/537)

### Bug Fixes 🐛

#### Event

- Detect org/ISSUE-SHORT-ID in event view single-arg path (CLI-9K) by @BYK in [#529](https://github.com/getsentry/cli/pull/529)
- Auto-redirect issue short IDs in event view (CLI-JR) by @BYK in [#524](https://github.com/getsentry/cli/pull/524)

#### Other

- (api) Strip api/0/ prefix and exclude NodeSystemError integration (CLI-K1) by @BYK in [#523](https://github.com/getsentry/cli/pull/523)
- (dashboard) Add missing datasets to agent guidance by @betegon in [#522](https://github.com/getsentry/cli/pull/522)
- (docs) Overscroll popup — curl command + click-to-copy by @betegon in [#531](https://github.com/getsentry/cli/pull/531)
- (init) Resolve numeric org ID from DSN and prompt when Sentry already configured by @betegon in [#532](https://github.com/getsentry/cli/pull/532)
- (polling) Move spinner from stderr to stdout to prevent consola collision by @BYK in [#533](https://github.com/getsentry/cli/pull/533)
- (telemetry) Set sentry.org tag in issue explain and plan commands by @BYK in [#534](https://github.com/getsentry/cli/pull/534)
- Handle invalid URLs gracefully in response cache (CLI-GC) by @BYK in [#528](https://github.com/getsentry/cli/pull/528)
- Avoid double-prefixing in buildCommandHint for slashed args (CLI-8C) by @BYK in [#527](https://github.com/getsentry/cli/pull/527)
- Handle full short IDs and numeric IDs in multi-slash issue args (CLI-KC, CLI-B6) by @BYK in [#526](https://github.com/getsentry/cli/pull/526)
- Auto-recovery for wrong entity types across commands (CLI-G6, CLI-K6, CLI-JR) by @BYK in [#525](https://github.com/getsentry/cli/pull/525)

### Documentation 📚

- (init) Add documentation and experimental notice for sentry init by @betegon in [#530](https://github.com/getsentry/cli/pull/530)

### Internal Changes 🔧

- (telemetry) Centralize sentry.org/project tags in resolution functions by @BYK in [#538](https://github.com/getsentry/cli/pull/538)
- Regenerate skill files by @github-actions[bot] in [22b5281d](https://github.com/getsentry/cli/commit/22b5281de8f7833b2a2a5d0f3b771aff0daab2ec)

## 0.19.0

### New Features ✨

#### Dashboard

- Add layout guidance and widget type reference for agents by @betegon in [#521](https://github.com/getsentry/cli/pull/521)
- Add widget add, edit, and delete commands by @betegon in [#407](https://github.com/getsentry/cli/pull/407)

#### Telemetry

- Include user email in Sentry telemetry context by @BYK in [#513](https://github.com/getsentry/cli/pull/513)
- Track TTY vs non-TTY invocations via metric by @betegon in [#482](https://github.com/getsentry/cli/pull/482)

#### Other

- (help) Fuzzy "Did you mean?" suggestions for command typos by @BYK in [#516](https://github.com/getsentry/cli/pull/516)
- (upgrade) Add progress spinners for version check and download phases by @BYK in [#515](https://github.com/getsentry/cli/pull/515)
- External sourcemap upload for compiled binaries by @BYK in [#518](https://github.com/getsentry/cli/pull/518)
- Dynamic cache-backed shell completions with fuzzy matching by @BYK in [#465](https://github.com/getsentry/cli/pull/465)

### Bug Fixes 🐛

- (completions) Populate project cache from listProjects by @betegon in [#517](https://github.com/getsentry/cli/pull/517)
- (help) Hide ASCII banner when stdout is not a TTY by @betegon in [#501](https://github.com/getsentry/cli/pull/501)
- (json) Flatten view command JSON output for --fields filtering by @BYK in [#495](https://github.com/getsentry/cli/pull/495)
- (polling) Throw TimeoutError instead of bare Error on timeout by @BYK in [#503](https://github.com/getsentry/cli/pull/503)
- (project) Fallback to org listing when bare slug matches an organization by @betegon in [#475](https://github.com/getsentry/cli/pull/475)
- (setup) Auto-configure zsh fpath for shell completions by @betegon in [#509](https://github.com/getsentry/cli/pull/509)
- (skill) Include widget subcommands in generated skill files by @betegon in [#519](https://github.com/getsentry/cli/pull/519)
- Isolate multiregion 403 tests from env-var auth tokens by @BYK in [#514](https://github.com/getsentry/cli/pull/514)
- Only mention token scopes in 403 errors for env-var tokens by @BYK in [#512](https://github.com/getsentry/cli/pull/512)
- Suggest similar projects on project-search miss (CLI-A4) by @BYK in [#511](https://github.com/getsentry/cli/pull/511)
- Preserve ApiError type in Seer handler + suggest trial start command (CLI-N, CLI-1D/BW/98) by @BYK in [#510](https://github.com/getsentry/cli/pull/510)
- Add 403 scope guidance to issue list error handling (CLI-97) by @BYK in [#508](https://github.com/getsentry/cli/pull/508)
- Propagate 403 from multi-region fan-out instead of returning empty list (CLI-89) by @BYK in [#507](https://github.com/getsentry/cli/pull/507)
- Lowercase project slug in URL-parsed issue short IDs (CLI-C8 follow-up) by @BYK in [#506](https://github.com/getsentry/cli/pull/506)
- Handle EIO stream errors gracefully in bin.ts by @BYK in [#505](https://github.com/getsentry/cli/pull/505)
- Use fuzzyMatch for similar project suggestions and add tests (CLI-C0) by @BYK in [#504](https://github.com/getsentry/cli/pull/504)
- Use resolved org in numeric issue ID 404 hint (CLI-BT) by @BYK in [#502](https://github.com/getsentry/cli/pull/502)
- Include API endpoint in error messages for better diagnostics (CLI-BS) by @BYK in [#500](https://github.com/getsentry/cli/pull/500)
- Enrich 403 on org listing with token scope guidance (CLI-89) by @BYK in [#498](https://github.com/getsentry/cli/pull/498)
- Add 400 suggestions to org-all issue list path (CLI-BY) by @BYK in [#497](https://github.com/getsentry/cli/pull/497)
- Lowercase project slug in issue arg parsing (CLI-C8) by @BYK in [#496](https://github.com/getsentry/cli/pull/496)
- Enrich short ID 404 with org context and suggestions (CLI-A1) by @BYK in [#494](https://github.com/getsentry/cli/pull/494)
- Suggest similar projects when project not found in org (CLI-C0) by @BYK in [#493](https://github.com/getsentry/cli/pull/493)
- Event 404 hint should suggest different project, not repeat failing command by @BYK in [#492](https://github.com/getsentry/cli/pull/492)
- Enrich event 404 errors with retention and format suggestions (CLI-6F) by @BYK in [#491](https://github.com/getsentry/cli/pull/491)
- Add actionable suggestions for 400 Bad Request on issue list (CLI-BM, CLI-7B) by @BYK in [#489](https://github.com/getsentry/cli/pull/489)
- Detect issue short IDs passed to issue list (CLI-C3) by @BYK in [#488](https://github.com/getsentry/cli/pull/488)
- Add Glob.match() polyfill + improve auto-detect diagnostics (CLI-7T) by @BYK in [#487](https://github.com/getsentry/cli/pull/487)
- Add org-slug pre-check to dispatchOrgScopedList (CLI-9A) by @BYK in [#485](https://github.com/getsentry/cli/pull/485)

### Documentation 📚

- (dashboard) Add documentation for dashboard and widget commands by @betegon in [#520](https://github.com/getsentry/cli/pull/520)

### Internal Changes 🔧

- (init) Run org detection in background during preamble by @MathurAditya724 in [#443](https://github.com/getsentry/cli/pull/443)
- (issue) Skip getProject round-trip in project-search resolution by @betegon in [#473](https://github.com/getsentry/cli/pull/473)
- (resolve) Carry project data through resolution to eliminate redundant getProject calls by @BYK in [#486](https://github.com/getsentry/cli/pull/486)
- (telemetry) Convert is_tty metric to span tag by @betegon in [#499](https://github.com/getsentry/cli/pull/499)
- HTTP latency optimizations — diagnostics, cache warming, concurrency limits by @BYK in [#490](https://github.com/getsentry/cli/pull/490)
- Switch from @sentry/bun to @sentry/node-core/light (~170ms startup savings) by @BYK in [#474](https://github.com/getsentry/cli/pull/474)
- Regenerate skill files by @github-actions[bot] in [b7b240ec](https://github.com/getsentry/cli/commit/b7b240ece3c2b1617b00f4be2cac3fcba6248143)

## 0.18.1

### Bug Fixes 🐛

- (init) Sync wizard feature metadata with supported flags by @MathurAditya724 in [#471](https://github.com/getsentry/cli/pull/471)
- Accept nullable user fields in OAuth token response by @BYK in [#470](https://github.com/getsentry/cli/pull/470)

### Internal Changes 🔧

- Regenerate skill files by @github-actions[bot] in [77603fc3](https://github.com/getsentry/cli/commit/77603fc3fc4464a5507d3db55720bc760c524c48)

## 0.18.0

### New Features ✨

- (span) Make span list dual-mode and add --period flag by @BYK in [#461](https://github.com/getsentry/cli/pull/461)
- Refactor SKILL.md into modular reference files by @BYK in [#458](https://github.com/getsentry/cli/pull/458)

### Bug Fixes 🐛

- (constants) Normalize bare hostnames in SENTRY_HOST/SENTRY_URL by @BYK in [#467](https://github.com/getsentry/cli/pull/467)
- (dsn) Treat EISDIR and ENOTDIR as ignorable file errors by @BYK in [#464](https://github.com/getsentry/cli/pull/464)
- (test) Use os.tmpdir() for test temp directories by @BYK in [#457](https://github.com/getsentry/cli/pull/457)
- Make piped output human-readable instead of raw CommonMark by @BYK in [#462](https://github.com/getsentry/cli/pull/462)
- Clean up upgrade output and hide empty table headers by @BYK in [#459](https://github.com/getsentry/cli/pull/459)
- Improve error messages — fix ContextError/ResolutionError misuse by @BYK in [#456](https://github.com/getsentry/cli/pull/456)

### Documentation 📚

- Add key principles and API schema workflow to agent guidance by @BYK in [#466](https://github.com/getsentry/cli/pull/466)

### Internal Changes 🔧

- (list) Align all list commands to issue list standards by @BYK in [#453](https://github.com/getsentry/cli/pull/453)

## 0.17.0

### New Features ✨

- (dashboard) Add dashboard list, view, and create commands by @betegon in [#406](https://github.com/getsentry/cli/pull/406)
- (upgrade) Add --offline flag and automatic offline fallback by @BYK in [#450](https://github.com/getsentry/cli/pull/450)
- Add distributed tracing for Sentry backend by @BYK in [#455](https://github.com/getsentry/cli/pull/455)
- Add project delete command by @MathurAditya724 in [#397](https://github.com/getsentry/cli/pull/397)
- Add `sentry schema` command for API introspection by @BYK in [#437](https://github.com/getsentry/cli/pull/437)

### Bug Fixes 🐛

- (dsn) Prevent hang during DSN auto-detection in repos with test fixtures by @BYK in [#445](https://github.com/getsentry/cli/pull/445)
- (formatters) Pad priority labels for consistent TRIAGE column alignment by @MathurAditya724 in [#449](https://github.com/getsentry/cli/pull/449)
- (upgrade) Remove hard chain depth cap for nightly delta upgrades by @BYK in [#444](https://github.com/getsentry/cli/pull/444)
- Improve CLI output for auth login and upgrade flows by @BYK in [#454](https://github.com/getsentry/cli/pull/454)

### Internal Changes 🔧

- Cache org listing in listOrganizations + DSN shortcut for issue view by @betegon in [#446](https://github.com/getsentry/cli/pull/446)

## 0.16.0

### New Features ✨

#### Init

- Support org/project positional to pin org and project name by @MathurAditya724 in [#428](https://github.com/getsentry/cli/pull/428)
- Show feedback hint after successful setup by @betegon in [#430](https://github.com/getsentry/cli/pull/430)
- Add --team flag to relay team selection to project creation by @MathurAditya724 in [#403](https://github.com/getsentry/cli/pull/403)
- Enforce canonical feature display order by @betegon in [#388](https://github.com/getsentry/cli/pull/388)
- Accept multiple delimiter formats for --features flag by @betegon in [#386](https://github.com/getsentry/cli/pull/386)
- Add git safety checks before wizard modifies files by @betegon in [#379](https://github.com/getsentry/cli/pull/379)
- Add experimental warning before wizard runs by @betegon in [#378](https://github.com/getsentry/cli/pull/378)
- Add init command for guided Sentry project setup by @betegon in [#283](https://github.com/getsentry/cli/pull/283)

#### Issue List

- Auto-compact when table exceeds terminal height by @BYK in [#395](https://github.com/getsentry/cli/pull/395)
- Redesign table to match Sentry web UI by @BYK in [#372](https://github.com/getsentry/cli/pull/372)

#### Other

- (auth) Allow re-authentication without manual logout by @BYK in [#417](https://github.com/getsentry/cli/pull/417)
- (trial) Auto-prompt for Seer trial + sentry trial list/start commands by @BYK in [#399](https://github.com/getsentry/cli/pull/399)
- Add --json flag to help command for agent introspection by @BYK in [#432](https://github.com/getsentry/cli/pull/432)
- Add `sentry span list` and `sentry span view` commands by @betegon in [#393](https://github.com/getsentry/cli/pull/393)
- Support SENTRY_HOST as alias for SENTRY_URL by @betegon in [#409](https://github.com/getsentry/cli/pull/409)
- Add --dry-run flag to mutating commands by @BYK in [#387](https://github.com/getsentry/cli/pull/387)
- Return-based output with OutputConfig on buildCommand by @BYK in [#380](https://github.com/getsentry/cli/pull/380)
- Add --fields flag for context-window-friendly JSON output by @BYK in [#373](https://github.com/getsentry/cli/pull/373)
- Magic `@` selectors (`@latest`, `@most_frequent`) for issue commands by @BYK in [#371](https://github.com/getsentry/cli/pull/371)
- Input hardening against agent hallucinations by @BYK in [#370](https://github.com/getsentry/cli/pull/370)
- Add response caching for read-only API calls by @BYK in [#330](https://github.com/getsentry/cli/pull/330)

### Bug Fixes 🐛

#### Dsn

- Make code scanner monorepo-aware and extend --fresh to bypass DSN cache by @betegon in [#420](https://github.com/getsentry/cli/pull/420)
- Prevent silent exit during uncached DSN auto-detection (#411) by @BYK in [#414](https://github.com/getsentry/cli/pull/414)

#### Init

- Align multiselect hint lines with clack's visual frame by @MathurAditya724 in [#435](https://github.com/getsentry/cli/pull/435)
- Make URLs clickable with OSC 8 terminal hyperlinks by @MathurAditya724 in [#423](https://github.com/getsentry/cli/pull/423)
- Remove implementation detail from help text by @betegon in [#385](https://github.com/getsentry/cli/pull/385)
- Truncate uncommitted file list to first 5 entries by @MathurAditya724 in [#381](https://github.com/getsentry/cli/pull/381)

#### Other

- (api) Convert --data to query params for GET requests by @BYK in [#383](https://github.com/getsentry/cli/pull/383)
- (docs) Remove double borders and fix column alignment on landing page tables by @betegon in [#369](https://github.com/getsentry/cli/pull/369)
- (help) Hide plural aliases from help output by @betegon in [#441](https://github.com/getsentry/cli/pull/441)
- (trace) Show span IDs in trace view and fix event_id mapping by @betegon in [#400](https://github.com/getsentry/cli/pull/400)
- Show human-friendly names in trial list and surface plan trials by @BYK in [#412](https://github.com/getsentry/cli/pull/412)
- Add trace ID validation to trace view + UUID dash-stripping by @BYK in [#375](https://github.com/getsentry/cli/pull/375)

### Documentation 📚

- (commands) Add alias info to subcommand help output by @betegon in [#442](https://github.com/getsentry/cli/pull/442)
- Update AGENTS.md with patterns from span commands work by @BYK in [#433](https://github.com/getsentry/cli/pull/433)
- Update credential storage docs and remove stale config.json references by @betegon in [#408](https://github.com/getsentry/cli/pull/408)

### Internal Changes 🔧

#### Init

- Remove --force flag by @betegon in [#377](https://github.com/getsentry/cli/pull/377)
- Remove dead determine-pm step label by @betegon in [#374](https://github.com/getsentry/cli/pull/374)

#### Tests

- Consolidate unit tests subsumed by property tests by @BYK in [#422](https://github.com/getsentry/cli/pull/422)
- Remove redundant and low-value tests by @BYK in [#418](https://github.com/getsentry/cli/pull/418)

#### Other

- (lint) Enforce command output conventions via Biome plugins by @BYK in [#439](https://github.com/getsentry/cli/pull/439)
- (log/list) Convert non-follow paths to return CommandOutput by @BYK in [#410](https://github.com/getsentry/cli/pull/410)
- Unified trace-target parsing and resolution by @BYK in [#438](https://github.com/getsentry/cli/pull/438)
- Centralize slug normalization warning in parseOrgProjectArg by @BYK in [#436](https://github.com/getsentry/cli/pull/436)
- Unify commands as generators with HumanRenderer factory, remove stdout plumbing by @BYK in [#416](https://github.com/getsentry/cli/pull/416)
- Convert list command handlers to return data instead of writing stdout by @BYK in [#404](https://github.com/getsentry/cli/pull/404)
- Split api-client.ts into focused domain modules by @BYK in [#405](https://github.com/getsentry/cli/pull/405)
- Migrate non-streaming commands to CommandOutput with markdown rendering by @BYK in [#398](https://github.com/getsentry/cli/pull/398)
- Convert Tier 2-3 commands to return-based output and consola by @BYK in [#394](https://github.com/getsentry/cli/pull/394)
- Convert remaining Tier 1 commands to return-based output by @BYK in [#382](https://github.com/getsentry/cli/pull/382)
- Converge Tier 1 commands to writeOutput helper by @BYK in [#376](https://github.com/getsentry/cli/pull/376)

### Other

- Minify JSON on read and pretty-print on write in init local ops by @MathurAditya724 in [#396](https://github.com/getsentry/cli/pull/396)

## 0.15.0

### New Features ✨

- (project) Display platform suggestions in multi-column tables by @betegon in [#365](https://github.com/getsentry/cli/pull/365)

### Bug Fixes 🐛

- (log-view) Support multiple log IDs and validate hex format by @BYK in [#362](https://github.com/getsentry/cli/pull/362)
- (logs) Harden log schemas against API response format variations by @BYK in [#361](https://github.com/getsentry/cli/pull/361)
- Improve argument parsing for common user mistakes by @BYK in [#363](https://github.com/getsentry/cli/pull/363)

### Internal Changes 🔧

- (delta-upgrade) Lazy chain walk, GHCR retry, parallel I/O, offline cache by @BYK in [#360](https://github.com/getsentry/cli/pull/360)
- Use --timeout CLI flag for model-based test timeouts by @BYK in [#367](https://github.com/getsentry/cli/pull/367)

## 0.14.0

### New Features ✨

#### Trace

- Add cursor pagination to `trace list` by @BYK in [#324](https://github.com/getsentry/cli/pull/324)
- Add `sentry trace logs` subcommand (#247) by @BYK in [#311](https://github.com/getsentry/cli/pull/311)

#### Other

- (api) Add --data/-d flag and auto-detect JSON body in fields by @BYK in [#320](https://github.com/getsentry/cli/pull/320)
- (formatters) Render all terminal output as markdown by @BYK in [#297](https://github.com/getsentry/cli/pull/297)
- (install) Add Sentry error telemetry to install script by @BYK in [#334](https://github.com/getsentry/cli/pull/334)
- (issue-list) Global limit with fair distribution, compound cursor, and richer progress by @BYK in [#306](https://github.com/getsentry/cli/pull/306)
- (log-list) Add --trace flag to filter logs by trace ID by @BYK in [#329](https://github.com/getsentry/cli/pull/329)
- (logger) Add consola-based structured logging with Sentry integration by @BYK in [#338](https://github.com/getsentry/cli/pull/338)
- (project) Add `project create` command by @betegon in [#237](https://github.com/getsentry/cli/pull/237)
- (upgrade) Add binary delta patching via TRDIFF10/bsdiff by @BYK in [#327](https://github.com/getsentry/cli/pull/327)
- Support SENTRY_AUTH_TOKEN and SENTRY_TOKEN env vars for headless auth by @BYK in [#356](https://github.com/getsentry/cli/pull/356)
- Improve markdown rendering styles by @BYK in [#342](https://github.com/getsentry/cli/pull/342)

### Bug Fixes 🐛

#### Api

- Use numeric project ID to avoid "not actively selected" error by @betegon in [#312](https://github.com/getsentry/cli/pull/312)
- Use limit param for issues endpoint page size by @BYK in [#309](https://github.com/getsentry/cli/pull/309)
- Auto-correct ':' to '=' in --field values with a warning by @BYK in [#302](https://github.com/getsentry/cli/pull/302)

#### Formatters

- Expand streaming table to fill terminal width by @betegon in [#314](https://github.com/getsentry/cli/pull/314)
- Fix HTML entities and escaped underscores in table output by @betegon in [#313](https://github.com/getsentry/cli/pull/313)

#### Setup

- Suppress agent skills and welcome messages on upgrade by @BYK in [#328](https://github.com/getsentry/cli/pull/328)
- Suppress shell completion messages on upgrade by @BYK in [#326](https://github.com/getsentry/cli/pull/326)

#### Upgrade

- Detect downgrades and skip delta attempt by @BYK in [#358](https://github.com/getsentry/cli/pull/358)
- Check GHCR for nightly version existence instead of GitHub Releases by @BYK in [#352](https://github.com/getsentry/cli/pull/352)
- Replace Bun.mmap with arrayBuffer on all platforms by @BYK in [#343](https://github.com/getsentry/cli/pull/343)
- Replace Bun.mmap with arrayBuffer on macOS to prevent SIGKILL by @BYK in [#340](https://github.com/getsentry/cli/pull/340)
- Use MAP_PRIVATE mmap to prevent macOS SIGKILL during delta upgrade by @BYK in [#339](https://github.com/getsentry/cli/pull/339)

#### Other

- (ci) Generate JUnit XML to silence codecov-action warnings by @BYK in [#300](https://github.com/getsentry/cli/pull/300)
- (install) Fix nightly digest extraction on macOS by @BYK in [#331](https://github.com/getsentry/cli/pull/331)
- (logger) Inject --verbose and --log-level as proper Stricli flags by @BYK in [#353](https://github.com/getsentry/cli/pull/353)
- (nightly) Push to GHCR from artifacts dir so layer titles are bare filenames by @BYK in [#301](https://github.com/getsentry/cli/pull/301)
- (project create) Auto-correct dot-separated platform to hyphens by @BYK in [#336](https://github.com/getsentry/cli/pull/336)
- (region) Resolve DSN org prefix at resolution layer by @BYK in [#316](https://github.com/getsentry/cli/pull/316)
- (test) Handle 0/-0 in getComparator anti-symmetry property test by @BYK in [#308](https://github.com/getsentry/cli/pull/308)
- (trace-logs) Timestamp_precise is a number, not a string by @BYK in [#323](https://github.com/getsentry/cli/pull/323)

### Documentation 📚

- Document SENTRY_URL and self-hosted setup by @BYK in [#337](https://github.com/getsentry/cli/pull/337)

### Internal Changes 🔧

#### Api

- Upgrade @sentry/api to 0.21.0, remove raw HTTP pagination workarounds by @BYK in [#321](https://github.com/getsentry/cli/pull/321)
- Wire listIssuesPaginated through @sentry/api SDK for type safety by @BYK in [#310](https://github.com/getsentry/cli/pull/310)

#### Other

- (craft) Add sentry-release-registry target by @BYK in [#325](https://github.com/getsentry/cli/pull/325)
- (errors) Return Result type from withAuthGuard, expand auto-login to expired tokens by @BYK in [#359](https://github.com/getsentry/cli/pull/359)
- (project create) Migrate human output to markdown rendering system by @BYK in [#341](https://github.com/getsentry/cli/pull/341)
- (telemetry) Add child spans to delta upgrade for bottleneck identification by @BYK in [#355](https://github.com/getsentry/cli/pull/355)
- (upgrade) Use copy-then-mmap for zero JS heap during delta patching by @BYK in [#344](https://github.com/getsentry/cli/pull/344)

## 0.13.0

### New Features ✨

- (issue-list) Add --period flag, pagination progress, and count abbreviation by @BYK in [#289](https://github.com/getsentry/cli/pull/289)
- (nightly) Distribute via GHCR instead of GitHub Releases by @BYK in [#298](https://github.com/getsentry/cli/pull/298)
- (upgrade) Add nightly release channel by @BYK in [#292](https://github.com/getsentry/cli/pull/292)

### Bug Fixes 🐛

- (brew) Handle root-owned config dir from sudo installs by @BYK in [#288](https://github.com/getsentry/cli/pull/288)
- (ci) Use github context for compressed artifact upload condition by @BYK in [#299](https://github.com/getsentry/cli/pull/299)
- (errors) Add ResolutionError for not-found/ambiguous resolution failures by @BYK in [#293](https://github.com/getsentry/cli/pull/293)
- (issue) Improve numeric issue ID resolution with org context and region routing by @BYK in [#294](https://github.com/getsentry/cli/pull/294)
- (setup) Show actual shell name instead of "unknown" for unsupported shells by @BYK in [#287](https://github.com/getsentry/cli/pull/287)
- Optimized the docs images by @MathurAditya724 in [#291](https://github.com/getsentry/cli/pull/291)

### Internal Changes 🔧

- Correct nightly artifact path in publish-nightly job by @BYK in [#295](https://github.com/getsentry/cli/pull/295)
- Only showing status about changed files in codecov by @MathurAditya724 in [#286](https://github.com/getsentry/cli/pull/286)

## 0.12.0

### New Features ✨

- (event) Resolve ID across all orgs when no project context is available by @BYK in [#285](https://github.com/getsentry/cli/pull/285)
- (release) Add Homebrew install support by @BYK in [#277](https://github.com/getsentry/cli/pull/277)
- (setup) Install bash completions as fallback for unsupported shells by @BYK in [#282](https://github.com/getsentry/cli/pull/282)
- Support SENTRY_ORG and SENTRY_PROJECT environment variables by @BYK in [#280](https://github.com/getsentry/cli/pull/280)

### Bug Fixes 🐛

- (fetch) Preserve Content-Type header for SDK requests on Node.js by @BYK in [#276](https://github.com/getsentry/cli/pull/276)
- (help) Document target patterns and trailing-slash significance by @BYK in [#272](https://github.com/getsentry/cli/pull/272)
- (issue-list) Auto-paginate --limit beyond 100 by @BYK in [#274](https://github.com/getsentry/cli/pull/274)
- (npm) Add Node.js >= 22 version guard to npm bundle by @BYK in [#269](https://github.com/getsentry/cli/pull/269)
- (telemetry) Fix commands importing buildCommand directly from @stricli/core by @BYK in [#275](https://github.com/getsentry/cli/pull/275)
- Support numeric project IDs in project slug resolution by @BYK in [#284](https://github.com/getsentry/cli/pull/284)
- Detect subcommand names passed as positional target patterns by @BYK in [#281](https://github.com/getsentry/cli/pull/281)
- Improve error quality and prevent token leak in telemetry by @BYK in [#279](https://github.com/getsentry/cli/pull/279)

### Internal Changes 🔧

- (org) Use shared list-command constants in org list by @BYK in [#273](https://github.com/getsentry/cli/pull/273)

## 0.11.0

### New Features ✨

#### Build

- Add hole-punch tool to reduce compressed binary size by @BYK in [#245](https://github.com/getsentry/cli/pull/245)
- Add gzip-compressed binary downloads by @BYK in [#244](https://github.com/getsentry/cli/pull/244)

#### Other

- (args) Parse Sentry web URLs as CLI arguments by @BYK in [#252](https://github.com/getsentry/cli/pull/252)
- (auth) Switch to /auth/ endpoint and add whoami command by @BYK in [#266](https://github.com/getsentry/cli/pull/266)
- (list) Add pagination and consistent target parsing to all list commands by @BYK in [#262](https://github.com/getsentry/cli/pull/262)

### Bug Fixes 🐛

#### Telemetry

- Reduce noise from version-check JSON parse errors by @BYK in [#253](https://github.com/getsentry/cli/pull/253)
- Skip Sentry reporting for 4xx API errors by @BYK in [#251](https://github.com/getsentry/cli/pull/251)
- Handle EPIPE errors from piped stdout gracefully by @BYK in [#250](https://github.com/getsentry/cli/pull/250)
- Upgrade Sentry SDK to 10.39.0 and remove custom patches by @BYK in [#249](https://github.com/getsentry/cli/pull/249)

#### Other

- (commands) Support org/project/id as single positional arg by @BYK in [#261](https://github.com/getsentry/cli/pull/261)
- (db) Handle readonly database gracefully instead of crashing by @betegon in [#235](https://github.com/getsentry/cli/pull/235)
- (errors) Show meaningful detail instead of [object Object] in API errors by @BYK in [#259](https://github.com/getsentry/cli/pull/259)
- (issue-list) Propagate original errors instead of wrapping in plain Error by @BYK in [#254](https://github.com/getsentry/cli/pull/254)
- (polyfill) Add exited promise and stdin to Bun.spawn Node.js polyfill by @BYK in [#248](https://github.com/getsentry/cli/pull/248)
- (project-list) Add pagination and flexible target parsing by @BYK in [#221](https://github.com/getsentry/cli/pull/221)
- (test) Prevent mock.module() leak from breaking test:isolated by @BYK in [#260](https://github.com/getsentry/cli/pull/260)
- (upgrade) Remove v prefix from release URLs and work around Bun.write streaming bug by @BYK in [#243](https://github.com/getsentry/cli/pull/243)
- Repair pagination_cursors composite PK and isolate test suites by @BYK in [#265](https://github.com/getsentry/cli/pull/265)

### Internal Changes 🔧

- (build) Replace local hole-punch script with binpunch package by @BYK in [#246](https://github.com/getsentry/cli/pull/246)
- Use @sentry/api client for requests by @MathurAditya724 in [#226](https://github.com/getsentry/cli/pull/226)

## 0.10.0

### New Features ✨

- (formatters) Add Seer fixability score to issue list and detail views by @betegon in [#234](https://github.com/getsentry/cli/pull/234)
- (team) Add `team list` command by @betegon in [#238](https://github.com/getsentry/cli/pull/238)

### Bug Fixes 🐛

#### Telemetry

- Use SDK session integration instead of manual management by @BYK in [#232](https://github.com/getsentry/cli/pull/232)
- Correct runtime context for Bun binary by @BYK in [#231](https://github.com/getsentry/cli/pull/231)

#### Other

- (setup) Use correct auth command in install welcome message by @betegon in [#241](https://github.com/getsentry/cli/pull/241)
- (tests) Centralize test config dir lifecycle to prevent env var pollution by @BYK in [#242](https://github.com/getsentry/cli/pull/242)

## 0.9.1

### New Features ✨

#### Cli

- Add setup command for shell integration by @BYK in [#213](https://github.com/getsentry/cli/pull/213)
- Add plural command aliases for list commands by @betegon in [#209](https://github.com/getsentry/cli/pull/209)

#### Other

- (formatters) Display span duration in span tree by @betegon in [#219](https://github.com/getsentry/cli/pull/219)
- (log) Add view command to display log entry details by @betegon in [#212](https://github.com/getsentry/cli/pull/212)
- (repo) Add repo list command by @betegon in [#222](https://github.com/getsentry/cli/pull/222)
- (setup) Auto-install Claude Code agent skill during setup by @BYK in [#216](https://github.com/getsentry/cli/pull/216)
- (trace) Add trace list and view commands by @betegon in [#218](https://github.com/getsentry/cli/pull/218)

### Bug Fixes 🐛

#### Upgrade

- Handle EPERM in isProcessRunning for cross-user locks by @BYK in [#211](https://github.com/getsentry/cli/pull/211)
- Replace curl pipe with direct binary download by @BYK in [#208](https://github.com/getsentry/cli/pull/208)

#### Other

- (craft) Use regex pattern for binary artifact matching by @BYK in [#230](https://github.com/getsentry/cli/pull/230)
- (deps) Move runtime dependencies to devDependencies by @BYK in [#225](https://github.com/getsentry/cli/pull/225)

### Documentation 📚

- (log) Add documentation for sentry log view command by @betegon in [#214](https://github.com/getsentry/cli/pull/214)
- Add documentation for log command by @betegon in [#210](https://github.com/getsentry/cli/pull/210)

### Internal Changes 🔧

#### Ci

- Auto-commit SKILL.md when stale by @betegon in [#224](https://github.com/getsentry/cli/pull/224)
- Remove merge-artifacts job with Craft 2.21.1 by @BYK in [#215](https://github.com/getsentry/cli/pull/215)

#### Other

- (project) Replace --org flag with org/project positional by @betegon in [#223](https://github.com/getsentry/cli/pull/223)
- (setup) Unify binary placement via setup --install by @BYK in [#217](https://github.com/getsentry/cli/pull/217)
- Rename CI workflow to Build and fix artifact filter by @BYK in [#229](https://github.com/getsentry/cli/pull/229)
- Handle fork PRs in SKILL.md auto-commit by @BYK in [#227](https://github.com/getsentry/cli/pull/227)
- Enable minify for standalone binaries by @BYK in [#220](https://github.com/getsentry/cli/pull/220)

### Other

- release: 0.9.0 by @BYK in [1452e02c](https://github.com/getsentry/cli/commit/1452e02ca3e359388a4e84578e8dad81f63f3f2d)

## 0.9.0

### New Features ✨

#### Cli

- Add setup command for shell integration by @BYK in [#213](https://github.com/getsentry/cli/pull/213)
- Add plural command aliases for list commands by @betegon in [#209](https://github.com/getsentry/cli/pull/209)

#### Other

- (formatters) Display span duration in span tree by @betegon in [#219](https://github.com/getsentry/cli/pull/219)
- (log) Add view command to display log entry details by @betegon in [#212](https://github.com/getsentry/cli/pull/212)
- (repo) Add repo list command by @betegon in [#222](https://github.com/getsentry/cli/pull/222)
- (setup) Auto-install Claude Code agent skill during setup by @BYK in [#216](https://github.com/getsentry/cli/pull/216)
- (trace) Add trace list and view commands by @betegon in [#218](https://github.com/getsentry/cli/pull/218)

### Bug Fixes 🐛

#### Upgrade

- Handle EPERM in isProcessRunning for cross-user locks by @BYK in [#211](https://github.com/getsentry/cli/pull/211)
- Replace curl pipe with direct binary download by @BYK in [#208](https://github.com/getsentry/cli/pull/208)

#### Other

- (deps) Move runtime dependencies to devDependencies by @BYK in [#225](https://github.com/getsentry/cli/pull/225)

### Documentation 📚

- (log) Add documentation for sentry log view command by @betegon in [#214](https://github.com/getsentry/cli/pull/214)
- Add documentation for log command by @betegon in [#210](https://github.com/getsentry/cli/pull/210)

### Internal Changes 🔧

#### Ci

- Auto-commit SKILL.md when stale by @betegon in [#224](https://github.com/getsentry/cli/pull/224)
- Remove merge-artifacts job with Craft 2.21.1 by @BYK in [#215](https://github.com/getsentry/cli/pull/215)

#### Other

- (project) Replace --org flag with org/project positional by @betegon in [#223](https://github.com/getsentry/cli/pull/223)
- (setup) Unify binary placement via setup --install by @BYK in [#217](https://github.com/getsentry/cli/pull/217)
- Rename CI workflow to Build and fix artifact filter by @BYK in [#229](https://github.com/getsentry/cli/pull/229)
- Handle fork PRs in SKILL.md auto-commit by @BYK in [#227](https://github.com/getsentry/cli/pull/227)
- Enable minify for standalone binaries by @BYK in [#220](https://github.com/getsentry/cli/pull/220)

## 0.8.0

### New Features ✨

- (auth) Add token command and remove /users/me/ dependency by @BYK in [#207](https://github.com/getsentry/cli/pull/207)

### Bug Fixes 🐛

- (alias) Fix alias generation and highlighting for prefix-related slugs by @BYK in [#203](https://github.com/getsentry/cli/pull/203)

### Internal Changes 🔧

- (commands) Replace --org/--project flags with positional args for event view by @BYK in [#205](https://github.com/getsentry/cli/pull/205)

### Other

- test: add tests for resolveFromProjectSearch to increase coverage by @BYK in [#206](https://github.com/getsentry/cli/pull/206)
- test: add tests for project-cache and env-file modules by @BYK in [#200](https://github.com/getsentry/cli/pull/200)

## 0.7.0

### New Features ✨

#### Dsn

- Infer project from directory name when DSN detection fails by @BYK in [#178](https://github.com/getsentry/cli/pull/178)
- Add project root detection for automatic DSN discovery by @BYK in [#159](https://github.com/getsentry/cli/pull/159)

#### Other

- (auth) Auto-trigger login flow when authentication required by @betegon in [#170](https://github.com/getsentry/cli/pull/170)
- (commands) Add sentry log command by @betegon in [#160](https://github.com/getsentry/cli/pull/160)
- (db) Add schema repair and `sentry cli fix` command by @BYK in [#197](https://github.com/getsentry/cli/pull/197)
- (issue) Replace --org/--project flags with <org>/ID syntax by @BYK in [#161](https://github.com/getsentry/cli/pull/161)
- (lib) Add anyTrue helper for parallel-with-early-exit pattern by @BYK in [#174](https://github.com/getsentry/cli/pull/174)
- (telemetry) Add withTracing helper to reduce Sentry span boilerplate by @BYK in [#172](https://github.com/getsentry/cli/pull/172)

### Bug Fixes 🐛

- (types) Align schema types with Sentry API by @betegon in [#169](https://github.com/getsentry/cli/pull/169)
- Corrected the codecov action script by @MathurAditya724 in [#201](https://github.com/getsentry/cli/pull/201)
- Improved the plan command by @MathurAditya724 in [#185](https://github.com/getsentry/cli/pull/185)
- Use ASCII arrow for consistent terminal rendering by @BYK in [#192](https://github.com/getsentry/cli/pull/192)
- Corrected the rendering and props for the span tree by @MathurAditya724 in [#184](https://github.com/getsentry/cli/pull/184)
- ParseIssueArg now checks slashes before dashes by @BYK in [#177](https://github.com/getsentry/cli/pull/177)
- Address bugbot review comments on dsn-cache model-based tests by @BYK in [#176](https://github.com/getsentry/cli/pull/176)
- Added nullable in substatus's zod validation by @MathurAditya724 in [#157](https://github.com/getsentry/cli/pull/157)

### Documentation 📚

- Update AGENTS.md with testing guidelines and architecture by @BYK in [#190](https://github.com/getsentry/cli/pull/190)

### Internal Changes 🔧

- (upgrade) Use centralized user-agent for GitHub API requests by @BYK in [#173](https://github.com/getsentry/cli/pull/173)

### Other

- test: add comprehensive tests for resolve-target module by @BYK in [#199](https://github.com/getsentry/cli/pull/199)
- test: add tests for executeUpgrade with unknown method by @BYK in [#198](https://github.com/getsentry/cli/pull/198)
- test: expand version check test coverage by @BYK in [#196](https://github.com/getsentry/cli/pull/196)
- test: add comprehensive tests for DSN errors and resolver by @BYK in [#195](https://github.com/getsentry/cli/pull/195)
- test: add comprehensive tests for human formatter detail functions by @BYK in [#194](https://github.com/getsentry/cli/pull/194)
- test: add comprehensive tests for human formatter utilities by @BYK in [#191](https://github.com/getsentry/cli/pull/191)
- test: add coverage for fetchLatestVersion and versionExists by @BYK in [#189](https://github.com/getsentry/cli/pull/189)
- test: add coverage for UpgradeError and SeerError classes by @BYK in [#188](https://github.com/getsentry/cli/pull/188)
- test: add property tests for sentry-urls.ts (Phase 3) by @BYK in [#186](https://github.com/getsentry/cli/pull/186)
- test: simplify issue-id tests covered by property tests by @BYK in [#183](https://github.com/getsentry/cli/pull/183)
- test: simplify alias and arg-parsing tests covered by property tests by @BYK in [#182](https://github.com/getsentry/cli/pull/182)
- test: add property tests for API command and human formatters by @BYK in [#181](https://github.com/getsentry/cli/pull/181)
- test: remove redundant DB tests covered by model-based tests by @BYK in [#180](https://github.com/getsentry/cli/pull/180)
- test: add property tests for async utilities (Phase 4) by @BYK in [#179](https://github.com/getsentry/cli/pull/179)
- test: add model-based tests for DSN and project cache by @BYK in [#171](https://github.com/getsentry/cli/pull/171)
- test: add model-based and property-based testing with fast-check by @BYK in [#166](https://github.com/getsentry/cli/pull/166)

## 0.6.0

### New Features ✨

- (commands) Use positional args for org/project selection by @BYK in [#155](https://github.com/getsentry/cli/pull/155)
- (feedback) Add command to submit CLI feedback by @betegon in [#150](https://github.com/getsentry/cli/pull/150)
- (telemetry) Add is_self_hosted tag by @BYK in [#153](https://github.com/getsentry/cli/pull/153)
- (upgrade) Add self-update command by @betegon in [#132](https://github.com/getsentry/cli/pull/132)
- Add update available notification by @BYK in [#151](https://github.com/getsentry/cli/pull/151)

### Bug Fixes 🐛

- (telemetry) Capture command errors to Sentry by @betegon in [#145](https://github.com/getsentry/cli/pull/145)
- Update docs URL in help output by @betegon in [#149](https://github.com/getsentry/cli/pull/149)

### Documentation 📚

- (upgrade) Add documentation for upgrade command by @betegon in [#152](https://github.com/getsentry/cli/pull/152)
- Update README and AGENTS.md by @betegon in [#148](https://github.com/getsentry/cli/pull/148)

### Internal Changes 🔧

- Move feedback and upgrade under `sentry cli` command by @BYK in [#154](https://github.com/getsentry/cli/pull/154)

## 0.5.3

### Bug Fixes 🐛

- (telemetry) Enable sourcemap resolution in Sentry by @BYK in [#144](https://github.com/getsentry/cli/pull/144)

## 0.5.2

### Bug Fixes 🐛

- (auth) Display user info on login and status commands by @BYK in [#143](https://github.com/getsentry/cli/pull/143)

### Documentation 📚

- Add agentic usage documentation by @sergical in [#142](https://github.com/getsentry/cli/pull/142)

## 0.5.1

### Bug Fixes 🐛

- (cli) Show clean error messages without stack traces for user-facing errors by @BYK in [#141](https://github.com/getsentry/cli/pull/141)
- (db) Add transaction method to Node SQLite polyfill by @BYK in [#140](https://github.com/getsentry/cli/pull/140)

## 0.5.0

### New Features ✨

#### Api

- Add multi-region support for Sentry SaaS by @BYK in [#134](https://github.com/getsentry/cli/pull/134)
- Add custom User-Agent header to API requests by @BYK in [#125](https://github.com/getsentry/cli/pull/125)

#### Other

- (docs) Add Sentry SDK for error tracking, replay, and metrics by @betegon in [#122](https://github.com/getsentry/cli/pull/122)
- (project) Improve project list and view output by @betegon in [#129](https://github.com/getsentry/cli/pull/129)
- (seer) Add actionable error messages for Seer API errors by @betegon in [#130](https://github.com/getsentry/cli/pull/130)
- (telemetry) Improve Sentry instrumentation by @BYK in [#127](https://github.com/getsentry/cli/pull/127)

### Bug Fixes 🐛

- (issue) Support numeric short suffixes like "15" in issue view by @BYK in [#138](https://github.com/getsentry/cli/pull/138)
- (npx) Suppress Node.js warnings in npm package by @BYK in [#115](https://github.com/getsentry/cli/pull/115)

### Documentation 📚

- (issue) Add command reference for explain and plan by @betegon in [#137](https://github.com/getsentry/cli/pull/137)
- (skill) Add well-known skills discovery endpoint by @sergical in [#135](https://github.com/getsentry/cli/pull/135)

### Internal Changes 🔧

- (db) Add upsert() helper to reduce SQL boilerplate by @BYK in [#139](https://github.com/getsentry/cli/pull/139)
- Allow PRs to merge when CI jobs are skipped by @BYK in [#123](https://github.com/getsentry/cli/pull/123)

### Other

- fix links to commands from /getting-started by @souredoutlook in [#133](https://github.com/getsentry/cli/pull/133)

## 0.4.2

### Bug Fixes 🐛

- (docs) For the mobile screen by @MathurAditya724 in [#116](https://github.com/getsentry/cli/pull/116)

## 0.4.1

### Bug Fixes 🐛

#### Release

- Add Node.js 22 setup for type stripping support by @BYK in [#114](https://github.com/getsentry/cli/pull/114)
- Use Node.js instead of Bun for release scripts by @BYK in [#113](https://github.com/getsentry/cli/pull/113)

#### Other

- Updated the skills plugin details by @MathurAditya724 in [#111](https://github.com/getsentry/cli/pull/111)

### Documentation 📚

- Fix some broken stuff by @MathurAditya724 in [#112](https://github.com/getsentry/cli/pull/112)

## 0.4.0

### New Features ✨

- (docs) Add Open Graph images for social sharing by @betegon in [#109](https://github.com/getsentry/cli/pull/109)
- (install) Auto-add sentry to PATH on install by @betegon in [#108](https://github.com/getsentry/cli/pull/108)
- Auto-generate SKILL.md and extract version bump script by @BYK in [#105](https://github.com/getsentry/cli/pull/105)
- Updated the install button by @MathurAditya724 in [#103](https://github.com/getsentry/cli/pull/103)
- Add global help command using Stricli's defaultCommand by @BYK in [#104](https://github.com/getsentry/cli/pull/104)

### Bug Fixes 🐛

- (ci) Install bun in release workflow by @betegon in [#110](https://github.com/getsentry/cli/pull/110)
- (docs) Mobile styling improvements for landing page by @betegon in [#106](https://github.com/getsentry/cli/pull/106)

## 0.3.3

### Bug Fixes 🐛

- Add shebang to npm bundle for global installs by @BYK in [#101](https://github.com/getsentry/cli/pull/101)

### Documentation 📚

- Add CNAME file for custom domain in build artifact by @BYK in [#102](https://github.com/getsentry/cli/pull/102)

## 0.3.2

### Documentation 📚

- Update base path for cli.sentry.dev domain by @BYK in [#100](https://github.com/getsentry/cli/pull/100)

## 0.3.1

### Bug Fixes 🐛

- (ci) Correct gh-pages.zip structure for Craft publishing by @BYK in [#99](https://github.com/getsentry/cli/pull/99)

## 0.3.0

### New Features ✨

#### Issue

- Add workspace-scoped alias cache by @BYK in [#52](https://github.com/getsentry/cli/pull/52)
- Add short ID aliases for multi-project support by @BYK in [#31](https://github.com/getsentry/cli/pull/31)

#### Other

- (api) Align with gh api and curl conventions by @BYK in [#60](https://github.com/getsentry/cli/pull/60)
- (auth) Add press 'c' to copy URL during login flow by @betegon in [#58](https://github.com/getsentry/cli/pull/58)
- (commands) Rename get commands to view and add -w browser flag by @BYK in [#53](https://github.com/getsentry/cli/pull/53)
- (install) Add install script served from docs site by @betegon in [#95](https://github.com/getsentry/cli/pull/95)
- Add install script for easy CLI installation by @betegon in [#97](https://github.com/getsentry/cli/pull/97)
- Added CLI Skill by @MathurAditya724 in [#69](https://github.com/getsentry/cli/pull/69)
- Added span tree by @MathurAditya724 in [#86](https://github.com/getsentry/cli/pull/86)
- New intro in CLI by @MathurAditya724 in [#84](https://github.com/getsentry/cli/pull/84)
- Added footer formatting function by @MathurAditya724 in [#71](https://github.com/getsentry/cli/pull/71)
- Add explain and plan commands (Seer AI) by @MathurAditya724 in [#39](https://github.com/getsentry/cli/pull/39)
- Add Sentry SDK for error tracking and usage telemetry by @BYK in [#63](https://github.com/getsentry/cli/pull/63)

### Bug Fixes 🐛

#### Issue

- Support short ID aliases in explain and plan commands by @BYK in [#74](https://github.com/getsentry/cli/pull/74)
- Use correct fallback for unrecognized alias-suffix inputs by @BYK in [#72](https://github.com/getsentry/cli/pull/72)
- Handle cross-org project slug collisions in alias generation by @BYK in [#62](https://github.com/getsentry/cli/pull/62)
- Use org-scoped endpoint for latest event + enhanced display by @betegon in [#40](https://github.com/getsentry/cli/pull/40)

#### Other

- (api) Use query params for --field with GET requests by @BYK in [#59](https://github.com/getsentry/cli/pull/59)
- (install) Use correct download URL without 'v' prefix by @betegon in [#94](https://github.com/getsentry/cli/pull/94)
- (telemetry) Patch Sentry SDK to prevent 3-second exit delay by @BYK in [#85](https://github.com/getsentry/cli/pull/85)

### Documentation 📚

- (agents) Update AGENTS.md to reflect current codebase by @betegon in [#93](https://github.com/getsentry/cli/pull/93)
- (issue) Update list command tips to reference view instead of get by @BYK in [#73](https://github.com/getsentry/cli/pull/73)
- (readme) Add installation section by @betegon in [#65](https://github.com/getsentry/cli/pull/65)
- Add install script section to getting started guide by @betegon in [#98](https://github.com/getsentry/cli/pull/98)
- Add documentation website by @betegon in [#77](https://github.com/getsentry/cli/pull/77)
- Update command references from 'get' to 'view' and document -w flag by @BYK in [#54](https://github.com/getsentry/cli/pull/54)

### Internal Changes 🔧

- (config) Migrate storage from JSON to SQLite by @BYK in [#89](https://github.com/getsentry/cli/pull/89)
- (issue) Extract shared parameters for issue commands by @BYK in [#79](https://github.com/getsentry/cli/pull/79)
- (release) Fix changelog-preview permissions by @BYK in [#41](https://github.com/getsentry/cli/pull/41)
- Rename config folder from .sentry-cli-next to .sentry by @BYK in [#50](https://github.com/getsentry/cli/pull/50)

### Other

- test(e2e): use mock HTTP server instead of live API by @BYK in [#78](https://github.com/getsentry/cli/pull/78)

## 0.2.0

- No documented changes.
