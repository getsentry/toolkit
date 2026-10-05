import { buildRouteMap } from "../../lib/route-map.js";
import { authDefaultCommand } from "./default.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { refreshCommand } from "./refresh.js";
import { statusCommand } from "./status.js";
import { tokenCommand } from "./token.js";
import { whoamiCommand } from "./whoami.js";

export const authRoute = buildRouteMap({
  routes: {
    // Hidden smart default: login when logged out, status when logged in.
    default: authDefaultCommand,
    login: loginCommand,
    logout: logoutCommand,
    refresh: refreshCommand,
    status: statusCommand,
    token: tokenCommand,
    whoami: whoamiCommand,
  },
  defaultCommand: "default",
  docs: {
    brief: "Authenticate with Sentry",
    fullDescription:
      "Manage authentication with Sentry. Use 'sentry auth' to log in when logged out " +
      "or show status when logged in. Explicit subcommands: 'sentry auth login', " +
      "'sentry auth logout', 'sentry auth refresh', 'sentry auth status', " +
      "'sentry auth whoami', and 'sentry auth token'.",
    hideRoute: {
      default: true,
    },
  },
});
