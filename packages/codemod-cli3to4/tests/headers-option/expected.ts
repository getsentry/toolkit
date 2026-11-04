import SentryCli from "sentry";
const cli = SentryCli({ token: t, headers: { "X-Proxy": "1" } });
