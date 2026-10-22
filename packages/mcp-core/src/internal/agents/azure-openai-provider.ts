import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { ConfigurationError } from "../../errors";
import { USER_AGENT } from "../../version";

const DEFAULT_OPENAI_MODEL = "gpt-5";

let configuredBaseUrl: string | undefined;

export type AzureOpenAIApiSurface = "responses" | "chat-completions";

export function setAzureOpenAIBaseUrl(baseUrl: string | undefined): void {
  configuredBaseUrl = baseUrl;
}

function hasAzureDeploymentPath(baseUrl: string): boolean {
  const pathname = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return /\/openai\/deployments\/[^/]+$/i.test(pathname);
}

function hasAzureV1Path(baseUrl: string): boolean {
  const pathname = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return /\/openai\/v1$/i.test(pathname);
}

export function getAzureOpenAIApiSurface(): AzureOpenAIApiSurface {
  if (!configuredBaseUrl) {
    throw new ConfigurationError(
      'Provider "azure-openai" requires --openai-base-url to target an Azure OpenAI endpoint.',
    );
  }

  if (hasAzureV1Path(configuredBaseUrl)) {
    return "responses";
  }

  if (hasAzureDeploymentPath(configuredBaseUrl)) {
    return "chat-completions";
  }

  throw new ConfigurationError(
    'Provider "azure-openai" requires an Azure v1 base URL ending in /openai/v1 or a deployment URL ending in /openai/deployments/<deployment>.',
  );
}

function getAzureOpenAIApiVersion(): string | undefined {
  const apiVersion = process.env.OPENAI_API_VERSION?.trim();
  return apiVersion && apiVersion.length > 0 ? apiVersion : undefined;
}

function createAzureOpenAIFetch(baseUrl: string): typeof fetch {
  const apiVersion = getAzureOpenAIApiVersion();
  const shouldAppendApiVersion =
    apiVersion !== undefined && hasAzureDeploymentPath(baseUrl);

  return async (input, init) => {
    const requestUrl =
      input instanceof Request
        ? new URL(input.url)
        : new URL(input instanceof URL ? input.href : input.toString());

    if (shouldAppendApiVersion) {
      requestUrl.searchParams.set("api-version", apiVersion);
    }

    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      for (const [key, value] of new Headers(init.headers).entries()) {
        headers.set(key, value);
      }
    }

    if (process.env.OPENAI_API_KEY) {
      // Azure API-key auth uses the `api-key` header. Keep the existing
      // Authorization header as well for proxy compatibility.
      headers.set("api-key", process.env.OPENAI_API_KEY);
    }

    if (input instanceof Request) {
      return await fetch(new Request(requestUrl.toString(), input), {
        ...init,
        headers,
      });
    }

    return await fetch(requestUrl.toString(), {
      ...init,
      headers,
    });
  };
}

export function getAzureOpenAIModel(model?: string): LanguageModel {
  if (!configuredBaseUrl) {
    throw new ConfigurationError(
      'Provider "azure-openai" requires --openai-base-url to target an Azure OpenAI endpoint.',
    );
  }

  const apiSurface = getAzureOpenAIApiSurface();
  const modelId = model ?? (process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);

  const factory = createOpenAI({
    baseURL: configuredBaseUrl,
    headers: {
      "User-Agent": USER_AGENT,
    },
    name: "azure-openai",
    fetch: createAzureOpenAIFetch(configuredBaseUrl),
  });

  if (apiSurface === "chat-completions") {
    return factory.chat(modelId);
  }

  return factory(modelId);
}
