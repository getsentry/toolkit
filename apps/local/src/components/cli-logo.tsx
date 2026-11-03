import logo from "../../../cli-docs/src/assets/logo.svg";

/** The CLI brand asset shared with its documentation site. */
export function CliLogo() {
  return (
    <img
      src={logo}
      alt="Sentry CLI"
      width="117"
      height="20"
      className="h-5 w-auto brightness-0 dark:invert"
    />
  );
}
