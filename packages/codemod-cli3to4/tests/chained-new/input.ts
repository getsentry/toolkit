import SentryCli from "@sentry/cli";
await new SentryCli(null, { authToken: t }).releases.finalize("1.0.0");
await new SentryCli().execute(["releases", "list"], false);
