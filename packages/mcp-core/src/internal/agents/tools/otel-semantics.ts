import { z } from "zod";
import type { SentryApiService } from "../../../api-client";
import {
  type EventsDataset,
  PUBLIC_EVENTS_DATASETS,
} from "../../../utils/events-datasets";
import { agentTool, recordAgentToolResultCount } from "./utils";

// Import all JSON files directly
import android from "./data/android.json";
import app from "./data/app.json";
import artifact from "./data/artifact.json";
import aspnetcore from "./data/aspnetcore.json";
import aws from "./data/aws.json";
import azure from "./data/azure.json";
import browser from "./data/browser.json";
import cassandra from "./data/cassandra.json";
import cicd from "./data/cicd.json";
import client from "./data/client.json";
import cloud from "./data/cloud.json";
import cloudevents from "./data/cloudevents.json";
import cloudfoundry from "./data/cloudfoundry.json";
import code from "./data/code.json";
import container from "./data/container.json";
import cpu from "./data/cpu.json";
import cpython from "./data/cpython.json";
import database from "./data/database.json";
import db from "./data/db.json";
import deployment from "./data/deployment.json";
import destination from "./data/destination.json";
import device from "./data/device.json";
import disk from "./data/disk.json";
import dns from "./data/dns.json";
import dotnet from "./data/dotnet.json";
import elasticsearch from "./data/elasticsearch.json";
import enduser from "./data/enduser.json";
import error from "./data/error.json";
import faas from "./data/faas.json";
import feature_flags from "./data/feature_flags.json";
import file from "./data/file.json";
import gcp from "./data/gcp.json";
import gen_ai from "./data/gen_ai.json";
import geo from "./data/geo.json";
import go from "./data/go.json";
import graphql from "./data/graphql.json";
import hardware from "./data/hardware.json";
import heroku from "./data/heroku.json";
import host from "./data/host.json";
import http from "./data/http.json";
import ios from "./data/ios.json";
import jvm from "./data/jvm.json";
import k8s from "./data/k8s.json";
import linux from "./data/linux.json";
import log from "./data/log.json";
import mcp from "./data/mcp.json";
import messaging from "./data/messaging.json";
import network from "./data/network.json";
import nodejs from "./data/nodejs.json";
import oci from "./data/oci.json";
import opentracing from "./data/opentracing.json";
import os from "./data/os.json";
import otel from "./data/otel.json";
import peer from "./data/peer.json";
import process from "./data/process.json";
import profile from "./data/profile.json";
import rpc from "./data/rpc.json";
import server from "./data/server.json";
import service from "./data/service.json";
import session from "./data/session.json";
import signalr from "./data/signalr.json";
import source from "./data/source.json";
import system from "./data/system.json";
import telemetry from "./data/telemetry.json";
import test from "./data/test.json";
import thread from "./data/thread.json";
import tls from "./data/tls.json";
import url from "./data/url.json";
import user from "./data/user.json";
import v8js from "./data/v8js.json";
import vcs from "./data/vcs.json";
import webengine from "./data/webengine.json";
import zos from "./data/zos.json";

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
export async function lookupOtelSemantics(
  namespace: string,
  dataset: EventsDataset,
  apiService: SentryApiService,
  organizationSlug: string,
  projectId?: string,
): Promise<string> {
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
 * The tool is pre-bound with the API service and organization configured for the appropriate region
 */
export function createOtelLookupTool(options: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectId?: string;
}) {
  const { apiService, organizationSlug, projectId } = options;
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
    execute: async ({ namespace, dataset }) => {
      return await lookupOtelSemantics(
        namespace,
        dataset,
        apiService,
        organizationSlug,
        projectId,
      );
    },
  });
}
