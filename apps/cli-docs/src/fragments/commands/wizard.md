

## Setting up Sentry interactively

`sentry wizard` sets up the Sentry SDK in the project in the current
directory. It asks a few questions, installs the SDK for your framework,
writes its configuration, and sets up source map or debug file uploads.
Pass `-i` with an integration, such as `nextjs`, to skip the integration
picker.

It logs in with your `sentry auth login` account, or starts a login when you
have none, and lets you pick or create the Sentry project to send data to.
Pass `--org` and `--project` to skip those questions.

`sentry wizard` changes your project's files. To have a coding agent set up
Sentry instead, run `sentry init`, which prints the agent's setup guide and
changes nothing.

## Coming from `@sentry/wizard`

`sentry wizard` takes the same integrations and flags as
`npx @sentry/wizard`, so `npx @sentry/wizard -i nextjs` and
`sentry wizard -i nextjs` do the same thing. The Cordova and Electron wizards
were removed; follow their setup guides in the Sentry docs instead.
