import { buildRouteMap } from "../../lib/route-map.js";
import { authDefaultCommand } from "./default.js";
import { listCommand } from "./list.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { refreshCommand } from "./refresh.js";
import { statusCommand } from "./status.js";
import { switchCommand } from "./switch.js";
import { tokenCommand } from "./token.js";
import { whoamiCommand } from "./whoami.js";

export const authRoute = buildRouteMap({
  routes: {
    // Hidden smart default: login when logged out, status when logged in.
    default: authDefaultCommand,
    list: listCommand,
    login: loginCommand,
    logout: logoutCommand,
    refresh: refreshCommand,
    status: statusCommand,
    switch: switchCommand,
    token: tokenCommand,
    whoami: whoamiCommand,
  },
  defaultCommand: "default",
  docs: {
    brief: "Authenticate with Sentry",
    fullDescription:
      "Manage authentication with Sentry. Use 'sentry auth' to log in when logged out " +
      "or show status when logged in. Explicit subcommands: 'sentry auth login', " +
      "'sentry auth logout', 'sentry auth list', 'sentry auth switch', " +
      "'sentry auth refresh', 'sentry auth status', 'sentry auth whoami', " +
      "and 'sentry auth token'.\n\n" +
      "Several accounts (including on different servers) can be stored at once: " +
      "each 'sentry auth login' adds one, 'sentry auth list' shows them, and " +
      "'sentry auth switch' changes which one commands use.",
    hideRoute: {
      default: true,
    },
  },
});
