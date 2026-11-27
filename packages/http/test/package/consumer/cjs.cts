// Requires the packed package as CommonJS, as an npm consumer would.
import { strictEqual } from "node:assert";
import http = require("@sentry/http");
import codec = require("@sentry/http/codec");

strictEqual(http.isIdempotentRequest("get"), true);
strictEqual(http.parseRetryAfterMs(new Headers({ "retry-after": "2" })), 2000);
strictEqual(typeof codec.createBodyCodec().encode, "function");
