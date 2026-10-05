# Alerts and Metric Monitors

`find_alert_rules` and `get_alert_rule` inspect Alerts through the searchable
catalog (`search_sentry_tools` and `execute_sentry_tool`). `get_alert_options`
discovers configuration choices. `create_alert_rule`, `update_alert_rule`, and
`delete_alert_rule` manage the Alert lifecycle.
These operations add no direct tools. Reads require `org:read` and `project:read`;
writes also require `alerts:write`.

The `issue` selector reads Sentry Alerts: notification workflows that can be
shared across projects and monitors, cover all projects, or have no connected
sources. Omit `projectSlug` to search the organization, including unattached
Alerts. A project filter selects associated Alerts; it does not make a shared
Alert exclusive to that project.

Lists contain compact summaries and independent pagination for each family.
Use `get_alert_rule(kind='issue', ruleIdOrName='<id>', ...)` for the full detail.
Name lookups reject ambiguous or incomplete searches; numeric IDs with an
explicit kind avoid ambiguity between workflow and legacy metric IDs.

## Detail contract

Issue Alert detail returns structured `alertRule` content:

- Name, enabled state, notification frequency, environment, owner and timestamps.
- Complete trigger and action groups, with all conditions, notification actions
  and component IDs. Provider-native action `config` and `data` are retained;
  unrelated backend metadata is excluded.
- `scope.projectIds` and `scope.includesAllProjects`, identifying the real
  association rather than just the requested project.
- `sources`: connected monitors, their type, project, enabled state,
  configuration, conditions and data sources. Metric query windows are explicitly
  `timeWindowSeconds`. Cron schedules and Uptime checks preserve their own units.

Source IDs support correlating connections. Source 403/404 responses appear as
`unavailable`; authentication failures and server errors propagate normally.
Unknown, missing, or invalid source configuration is explicitly marked unavailable
without discarding other data sources or the Alert detail.
Uptime request headers and bodies are omitted and identified as omitted fields,
consistent with keeping credentials out of inspection responses.

In a project-constrained session, shared Alerts remain readable when associated
with that project. Other projects' source configuration is not exposed:
sources are marked `outside_project_constraint`, and scope includes
`limitedToProject` and, for a concrete project list, `outsideProjectCount`.
The real all-projects flag remains visible without guessing a project count.
Detached or unrelated Alerts are rejected for constrained sessions.

## Options and editing

`get_alert_options` returns one paginated section per call:

- `actions`: action types, installed integrations and services, native config/data
  schemas, and Sentry App settings. `inputGuide` maps internal config field names
  and target enums to the update format.
- `conditions`: available condition types and comparison schemas for the required
  `workflow_trigger` or `action_filter` group.
- `sources`: accessible detectors, including each project's system `issue_stream`.
  Filter by project, type, or monitor query. Each source includes its ID, project,
  enabled state, and connected workflow IDs.

Reuse cursors with the same section and filters. Discovery does not enumerate
every channel, member, or dynamic Sentry App choice; destinations and dynamic
settings may require explicit values. It never invents IDs.

`update_alert_rule` accepts a workflow ID or exact name. Digit-only references
are IDs, with no name fallback. Omitted fields retain their values; explicit null
clears owner or environment. The current enabled state is always sent because
Sentry otherwise defaults it to true during updates.

Triggers replace the trigger group and `actionFilters` replaces all action groups.
Read the complete configuration first, retain component IDs, and edit only the
intended values. All notification providers retain their native config/data.
Slack and Teams accept channel names in `config.targetDisplay` and an integration
ID. A copied old Slack target ID is cleared when its channel or workspace changes;
an explicit new ID is preserved. Other providers use their service, channel,
recipient, or app-specific fields. A saved Slack action with an unresolved channel
returns an explicit error explaining that the Alert was already saved.

Connection changes are additive/subtractive: `addProjectSlugs` and
`removeProjectSlugs` resolve existing `issue_stream` detectors, while
`addDetectorIds` and `removeDetectorIds` address individual monitors. Unmentioned
connections remain intact. Removing a project's issue stream does not disconnect
its other monitors. Already connected detector IDs can be removed even when their
details are unavailable; Sentry still checks removal permissions on the PUT.
Missing or ambiguous issue streams fail before the PUT;
MCP does not create a detector or substitute another type.

Project-constrained writes require the Alert to belong exclusively to that
project before and after the edit. Shared, all-project, and detached Alerts cannot
be edited through such a session. Unrestricted sessions can edit these Alerts
subject to backend permissions. All-project connections additionally require the
Sentry feature and `org:write`; OAuth does not request that scope automatically.
Existing OAuth tokens without `alerts:write` require reconnection.

Successful updates return the saved Alert's configuration and detector IDs.
Use `get_alert_rule` for enriched source details and scope. The backend PUT is
transactional, but the preceding read has no compare-and-swap protection against
concurrent edits. This operation does not create/delete Alerts or edit monitor
detection queries and thresholds.

## Creating and deleting Alerts

`create_alert_rule` creates a notification workflow. Its default status is active
and its notification interval defaults explicitly to 30 minutes; use
`status='disabled'` to prepare configuration before enabling it. `actionFilters`
is required, including an explicit empty array when no actions are wanted.
Notification providers use the same native config/data as editing and discovery.

Supply `projectSlugs` for existing project issue streams, `detectorIds` for
individual monitors, or both. At least one source array must be explicit.
`detectorIds=[]` creates a detached Alert in an organization-wide session; its
response states that it cannot send notifications until connected. No sources
are implicitly added from session constraints. Project sessions only allow
sources within their project, with at least one connection.

To copy an Alert, read its configuration and pass the desired fields to create.
Copied IDs on trigger/action groups, conditions, and actions are stripped;
integration IDs and provider-specific destination/configuration IDs are retained.
The original Alert is not modified. New trigger conditions require
`logicType='any-short'`; legacy trigger logic is not silently converted.
Use `update_alert_rule` to reuse an existing Alert instead of creating a copy.

Creation returns the saved configuration and IDs; use `get_alert_rule` to inspect
its scope and sources. POST requests are not automatically retried. An error or
timeout can occur after persistence: search/read before attempting creation again.

`delete_alert_rule` takes an explicit numeric workflow `ruleId`. A shared Alert's
notifications are removed for all connected sources, while its monitors remain.
Project sessions require the same exclusive project scope as editing. Successful
deletion returns `{success: true, ruleId}` after Sentry's 204 response: normal
reads no longer find the Alert, although internal cleanup runs asynchronously.
API errors, including missing workflows, remain errors.

## Metric Monitors

`find_metric_monitors` and `get_metric_monitor_details` are read-only catalog
tools with the same `org:read` and `project:read` scopes. They use native monitor
IDs from the Detectors API. Lists support organization/project scope, monitor
search and cursor pagination. The metric type filter is separate from the search
query; other monitor types cannot enter the results. Detail reads verify both
the monitor type and any requested or session-constrained project.

Details include name, description, enabled state, owner, project ID, timestamps,
connected Alert IDs (`workflowIds`), detection configuration and all conditions.
Read connected notification actions with `get_alert_rule(kind='issue')`.
Metric queries expose dataset, event types, query, aggregate, environment,
extrapolation mode and `timeWindowSeconds`. Subscription IDs and backend metadata
are excluded; unavailable source configuration is marked explicitly.

Static, Percent and Dynamic detection preserve their native conditions, including
resolution. `comparisonDeltaSeconds` identifies the Percent comparison window.
Percent thresholds use absolute percentages: 110 means 10% higher, 80 means 20%
lower. Dynamic comparisons retain sensitivity, seasonality and threshold type.
Condition results are native priorities: 75 critical, 50 warning and 0 resolved.

### Creating Metric Monitors

`create_metric_monitor` creates a native Metric Monitor in a required project.
It is a catalog-only `project-management` operation with `org:read`,
`project:read` and `alerts:write` scopes. Supply a name, complete query,
detection config and condition group using the same units and threshold meanings
as detail reads. Static, Percent and Dynamic detection are supported; Percent
requires a comparison window and Dynamic requires sufficient historical data.

Monitors are created active: creation does not accept `status` or `enabled`.
Use `update_metric_monitor` to disable a saved monitor. Optional `workflowIds`
connect existing Alerts; omitting them leaves the monitor without notification
routing. The response contains the saved `monitor` and guidance when no Alerts
are connected. Use `create_alert_rule` or `update_alert_rule` to configure
notification actions. POST is not automatically retried; after an uncertain
creation result, search for the monitor before retrying.

### Editing and deleting Metric Monitors

`update_metric_monitor` and `delete_metric_monitor` are catalog-only
`project-management` operations requiring `alerts:write` alongside the read
scopes. Both accept an explicit native `monitorId`; read the monitor first with
`get_metric_monitor_details`. They verify the monitor type and project scope
before writing.

Updates support name, active/disabled status, owner, description, query,
detection configuration, conditions and connected Alerts. Omitted fields remain
unchanged; null clears owner or description. `query` and `config` accept partial
changes using the same units as detail reads. `conditionGroup` replaces the
complete group, and `workflowIds` replaces all connections; an empty array
disconnects every Alert. Read and preserve the conditions and connections that
should remain. Updating connections does not edit notification destinations;
use `update_alert_rule` for those changes.

Changing detection mode requires compatible conditions. Dynamic uses exactly one
anomaly condition; Static and Percent include numeric thresholds and resolution.
Selecting Static or Dynamic clears the percentage comparison delta so the
backend stops percentage evaluation. Query edits preserve extrapolation mode;
Sentry may require an explicit supported mode when editing a legacy query.

Updates return the saved `monitor` detail. Deletion returns
`{success: true, monitorId}` after Sentry's successful response. Deleting a
monitor removes its detection configuration and connections; connected Alerts
remain available for other sources. For migrated monitors, deletion also removes
the legacy metric alert and its incident history. Normal reads stop returning
the monitor while Sentry completes cleanup asynchronously. API failures remain
errors.

## Legacy metric references and interpretation

`find_alert_rules(kind='metric'|'all')` now searches Detectors instead of the
retired metric alert APIs. Each metric result includes the native `monitorId`
and `projectId`, enabled state and a native monitor URL. `status` is
`enabled`/`disabled`; project identity uses `projectId` rather than legacy slugs.
`timeWindowMinutes` retains its existing unit for compatibility. The existing
`id` remains the legacy alert-rule ID when Sentry supplies one, or an explicit
`detector:<monitorId>` reference for a monitor without a legacy mapping.

`get_alert_rule(kind='metric')` accepts these references and returns structured
`metricMonitor` details. A bare numeric ID always means a legacy metric alert:
the compatibility endpoint resolves it before reading the actual monitor.
This also handles legacy synthetic IDs through Sentry's mapping, without
calculating an offset in MCP. A missing mapping never falls back to the same
number as a native monitor ID. Use `find_metric_monitors` followed by
`get_metric_monitor_details` when a legacy mapping is unavailable.

Exact-name lookups search native monitors and reject ambiguous or incomplete
results. With `kind='all'`, digit-only input still means a name. The canonical
tools and list/name adapters do not depend on the experimental mapping endpoint
or retired alert-rule APIs. API failures propagate rather than appearing as an
empty, complete search.

Current configuration helps explain which Alerts could match an issue. It does
not prove a notification was delivered historically. In particular, last-triggered
timestamps are not evidence of successful delivery.

The implementation uses workflow detail/list, workflow project scope, detector
detail/list and legacy alert-rule mapping endpoints, verified against Sentry's
endpoint and serializer source. Project scope is a private endpoint; missing
access fails explicitly.
