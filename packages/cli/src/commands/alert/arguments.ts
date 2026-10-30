/**
 * Alert rule positionals, parsed before `func` runs.
 *
 * {@link alertRuleParameter} takes a rule ID or name and where to find it:
 * `<org>/<project>/<rule>` for issue alerts, `<org>/<rule>` for metric
 * alerts. Rule names may hold spaces, so these keep their own syntax
 * (`parseIssueRuleArg()`, `parseMetricRuleArg()`) rather than the ID
 * grammar of `id-arguments.ts`.
 *
 * The parse has no side effects; the server of a pasted Sentry URL is
 * applied when the value resolves, after the auth guard.
 */

import {
  type ParsedOrgProject,
  parseOrgProjectInput,
} from "../../lib/arg-parsing.js";
import {
  type BoundPositional,
  boundPositional,
} from "../../lib/positional-parse.js";
import { applySentryUrlContext } from "../../lib/sentry-url-parser.js";

/** A rule ID or name and the target to find it in. */
export type AlertRuleRef = {
  /** The rule's numeric ID or name, as typed */
  readonly ref: string;
  /** Where to look the rule up */
  readonly target: ParsedOrgProject;
};

/**
 * An alert rule positional. `await rule.resolved` applies a pasted URL's
 * server and yields the rule reference; the command then looks the rule up
 * in the target's projects or org.
 */
export type AlertRuleArgument = BoundPositional<AlertRuleRef, AlertRuleRef>;

/** Splits a rule argument into the rule reference and the target argument. */
type RuleArgSplitter = (
  arg: string,
  usageHint: string,
) => { ref: string; targetArg: string | undefined };

/**
 * The rule parameter of an alert command's tuple positional.
 *
 * @param options.split - The rule syntax: `parseIssueRuleArg` or
 *   `parseMetricRuleArg`; throws a `ValidationError` for an invalid rule
 * @param options.kind - Shell completion for the target part
 */
export function alertRuleParameter(options: {
  readonly placeholder: string;
  readonly brief: string;
  readonly kind: "org" | "org/project";
  readonly split: RuleArgSplitter;
  readonly usageHint: string;
}) {
  const { placeholder, brief, kind, split, usageHint } = options;
  const parse = (raw: string | undefined) => {
    const { ref, targetArg } = split(raw ?? "", usageHint);
    return { ref, ...parseOrgProjectInput(targetArg) };
  };
  return {
    placeholder,
    brief,
    parse: boundPositional(
      kind,
      (raw): AlertRuleRef => {
        const { ref, parsed } = parse(raw);
        return { ref, target: parsed };
      },
      async (rule: AlertRuleRef, _context: unknown, raw) => {
        // Parsing again is cheap and pure; it recovers the URL's server
        const { baseUrl } = parse(raw);
        if (baseUrl) {
          applySentryUrlContext(baseUrl);
        }
        return rule;
      },
    ),
  } as const;
}
