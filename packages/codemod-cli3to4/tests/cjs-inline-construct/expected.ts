const cli = (require("sentry").default)({ token: t });
await cli.release.finalize({ orgVersion: "1.0.0" });
