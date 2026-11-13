import { z } from "zod";
import { PUBLIC_EVENTS_DATASETS } from "../../../utils/events-datasets";
import { agentTool, recordAgentToolResultCount } from "./utils";

// Import all JSON files directly
import android from "./data/android.json" with { type: "json" };
import app from "./data/app.json" with { type: "json" };
import artifact from "./data/artifact.json" with { type: "json" };
import aspnetcore from "./data/aspnetcore.json" with { type: "json" };
import aws from "./data/aws.json" with { type: "json" };
import azure from "./data/azure.json" with { type: "json" };
import browser from "./data/browser.json" with { type: "json" };
import cassandra from "./data/cassandra.json" with { type: "json" };
import cicd from "./data/cicd.json" with { type: "json" };
import client from "./data/client.json" with { type: "json" };
import cloud from "./data/cloud.json" with { type: "json" };
import cloudevents from "./data/cloudevents.json" with { type: "json" };
import cloudfoundry from "./data/cloudfoundry.json" with { type: "json" };
import code from "./data/code.json" with { type: "json" };
import container from "./data/container.json" with { type: "json" };
import cpu from "./data/cpu.json" with { type: "json" };
import cpython from "./data/cpython.json" with { type: "json" };
import database from "./data/database.json" with { type: "json" };
import db from "./data/db.json" with { type: "json" };
import deployment from "./data/deployment.json" with { type: "json" };
import destination from "./data/destination.json" with { type: "json" };
import device from "./data/device.json" with { type: "json" };
import disk from "./data/disk.json" with { type: "json" };
import dns from "./data/dns.json" with { type: "json" };
import dotnet from "./data/dotnet.json" with { type: "json" };
import elasticsearch from "./data/elasticsearch.json" with { type: "json" };
import enduser from "./data/enduser.json" with { type: "json" };
import error from "./data/error.json" with { type: "json" };
import faas from "./data/faas.json" with { type: "json" };
import feature_flags from "./data/feature_flags.json" with { type: "json" };
import file from "./data/file.json" with { type: "json" };
import gcp from "./data/gcp.json" with { type: "json" };
import gen_ai from "./data/gen_ai.json" with { type: "json" };
import geo from "./data/geo.json" with { type: "json" };
import go from "./data/go.json" with { type: "json" };
import graphql from "./data/graphql.json" with { type: "json" };
import hardware from "./data/hardware.json" with { type: "json" };
import heroku from "./data/heroku.json" with { type: "json" };
import host from "./data/host.json" with { type: "json" };
import http from "./data/http.json" with { type: "json" };
import ios from "./data/ios.json" with { type: "json" };
import jvm from "./data/jvm.json" with { type: "json" };
import k8s from "./data/k8s.json" with { type: "json" };
import linux from "./data/linux.json" with { type: "json" };
import log from "./data/log.json" with { type: "json" };
import mcp from "./data/mcp.json" with { type: "json" };
import messaging from "./data/messaging.json" with { type: "json" };
import network from "./data/network.json" with { type: "json" };
import nodejs from "./data/nodejs.json" with { type: "json" };
import oci from "./data/oci.json" with { type: "json" };
import opentracing from "./data/opentracing.json" with { type: "json" };
import os from "./data/os.json" with { type: "json" };
import otel from "./data/otel.json" with { type: "json" };
import peer from "./data/peer.json" with { type: "json" };
import process from "./data/process.json" with { type: "json" };
import profile from "./data/profile.json" with { type: "json" };
import rpc from "./data/rpc.json" with { type: "json" };
import server from "./data/server.json" with { type: "json" };
import service from "./data/service.json" with { type: "json" };
import session from "./data/session.json" with { type: "json" };
import signalr from "./data/signalr.json" with { type: "json" };
import source from "./data/source.json" with { type: "json" };
import system from "./data/system.json" with { type: "json" };
import telemetry from "./data/telemetry.json" with { type: "json" };
import test from "./data/test.json" with { type: "json" };
import thread from "./data/thread.json" with { type: "json" };
import tls from "./data/tls.json" with { type: "json" };
import url from "./data/url.json" with { type: "json" };
import user from "./data/user.json" with { type: "json" };
import v8js from "./data/v8js.json" with { type: "json" };
import vcs from "./data/vcs.json" with { type: "json" };
import webengine from "./data/webengine.json" with { type: "json" };
import zos from "./data/zos.json" with { type: "json" };

// Create the namespaceData object
const namespaceData: Partial<Record<string, NamespaceData>> = {
  android,
  app,
  artifact,
  aspnetcore,
  aws,
  azure,
  browser,
  cassandra,
  cicd,
  client,
  cloud,
  cloudevents,
  cloudfoundry,
  code,
  container,
  cpu,
  cpython,
  database,
  db,
  deployment,
  destination,
  device,
  disk,
  dns,
  dotnet,
  elasticsearch,
  enduser,
  error,
  faas,
  feature_flags,
  file,
  gcp,
  gen_ai,
  geo,
  go,
  graphql,
  hardware,
  heroku,
  host,
  http,
  ios,
  jvm,
  k8s,
  linux,
  log,
  mcp,
  messaging,
  network,
  nodejs,
  oci,
  opentracing,
  os,
  otel,
  peer,
  process,
  profile,
  rpc,
  server,
  service,
  session,
  signalr,
  source,
  system,
  telemetry,
  test,
  thread,
  tls,
  url,
  user,
  v8js,
  vcs,
  webengine,
  zos,
};

// TypeScript types
interface NamespaceData {
  namespace: string;
  description: string;
  attributes: Record<
    string,
    {
      description: string;
      type: string;
      examples?: Array<any>;
      note?: string;
      stability?: string;
    }
  >;
  custom?: boolean;
}

/**
 * Lookup OpenTelemetry semantic convention attributes for a given namespace
 */
export async function lookupOtelSemantics(namespace: string): Promise<string> {
  // Normalize namespace (replace - with _)
  const normalizedNamespace = namespace.replace(/-/g, "_");

  // Check if namespace exists
  const data = namespaceData[normalizedNamespace];
  if (!data) {
    // Try to find similar namespaces
    const allNamespaces = Object.keys(namespaceData);
    const suggestions = allNamespaces
      .filter((ns) => ns.includes(namespace) || namespace.includes(ns))
      .slice(0, 3);

    return suggestions.length > 0
      ? `Namespace '${namespace}' not found. Did you mean: ${suggestions.join(", ")}?`
      : `Namespace '${namespace}' not found. Use 'list' to see all available namespaces.`;
  }

  // Format the response
  let response = `# OpenTelemetry Semantic Conventions: ${data.namespace}\n\n`;
  response += `${data.description}\n\n`;

  if (data.custom) {
    response +=
      "**Note:** This is a custom namespace, not part of standard OpenTelemetry conventions.\n\n";
  }

  // Get all attributes
  const attributes = Object.entries(data.attributes);
  recordAgentToolResultCount(attributes.length);

  response += `## Attributes (${attributes.length} total)\n\n`;

  // Sort attributes by key
  const sortedAttributes = attributes.sort(([a], [b]) => a.localeCompare(b));

  for (const [key, attr] of sortedAttributes) {
    response += `### \`${key}\`\n`;
    response += `- **Type:** ${attr.type}\n`;
    response += `- **Description:** ${attr.description}\n`;

    if (attr.stability) {
      response += `- **Stability:** ${attr.stability}\n`;
    }

    if (attr.examples && attr.examples.length > 0) {
      response += `- **Examples:** ${attr.examples
        .map(
          (ex) =>
            `\`${typeof ex === "object" ? JSON.stringify(ex) : String(ex)}\``,
        )
        .join(", ")}\n`;
    }

    if (attr.note) {
      response += `- **Note:** ${attr.note}\n`;
    }

    response += "\n";
  }

  return response;
}

/**
 * Create the otel-semantics-lookup tool for AI agents
 */
/**
 * Create a tool for looking up OpenTelemetry semantic convention attributes
 */
export function createOtelLookupTool() {
  return agentTool({
    description:
      "Look up OpenTelemetry semantic convention attributes for a specific namespace. OpenTelemetry attributes are universal standards that work across all datasets.",
    parameters: z.object({
      namespace: z
        .string()
        .describe(
          "The OpenTelemetry namespace to look up (e.g., 'gen_ai', 'db', 'http', 'mcp')",
        ),
      dataset: z
        .enum(PUBLIC_EVENTS_DATASETS)
        .describe(
          "REQUIRED: Dataset to check attribute availability in. The agent MUST specify this based on their chosen dataset.",
        ),
    }),
    execute: async ({ namespace }) => {
      return await lookupOtelSemantics(namespace);
    },
  });
}
