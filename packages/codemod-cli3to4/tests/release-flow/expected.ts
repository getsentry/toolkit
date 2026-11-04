import SentryCli from "sentry";
const cli = SentryCli({ token: t });
await cli.release.create({ orgVersion: "1.0.0" });
await cli.release.finalize({ orgVersion: "1.0.0" });
const v = await cli.release["propose-version"]();
