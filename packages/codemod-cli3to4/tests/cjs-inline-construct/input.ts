const cli = new (require("@sentry/cli"))(null, { authToken: t });
await cli.releases.finalize("1.0.0");
