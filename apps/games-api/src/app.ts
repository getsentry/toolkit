import { Hono } from "hono";
import leaderboard, { type Env } from "./leaderboard";

const app = new Hono<{ Bindings: Env }>();

app.route("/v1", leaderboard);
app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
