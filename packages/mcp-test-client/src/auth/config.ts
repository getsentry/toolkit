import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Loose so fields written by other versions survive a save.
const OAuthClientConfigSchema = z.looseObject({
  clientId: z.string(),
  mcpHost: z.string(),
  /** Redirect URI this client was registered with. */
  redirectUri: z.string().optional(),
  registeredAt: z.string(),
  accessToken: z.string().optional(),
  tokenExpiresAt: z.string().optional(),
});

export type OAuthClientConfig = z.infer<typeof OAuthClientConfigSchema>;

const ConfigFileSchema = z.object({
  oauthClients: z.record(z.string(), z.unknown()),
});

/** Reads a config file, dropping client entries that do not parse. */
function parseConfigFile(value: unknown): ClientConfigFile {
  const parsed = ConfigFileSchema.safeParse(value);
  if (!parsed.success) {
    return { oauthClients: {} };
  }
  const oauthClients: Record<string, OAuthClientConfig> = {};
  for (const [key, entry] of Object.entries(parsed.data.oauthClients)) {
    const client = OAuthClientConfigSchema.safeParse(entry);
    if (client.success) {
      oauthClients[key] = client.data;
    }
  }
  return { oauthClients };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

/** The client config with its cached access token and expiry removed. */
function withoutAccessToken(client: OAuthClientConfig): OAuthClientConfig {
  const {
    accessToken: _accessToken,
    tokenExpiresAt: _tokenExpiresAt,
    ...rest
  } = client;
  return rest;
}

export interface ClientConfigFile {
  oauthClients: Record<string, OAuthClientConfig>;
}

export class ConfigManager {
  private configDir: string;
  private configFile: string;

  constructor() {
    this.configDir = join(homedir(), ".config", "sentry-mcp");
    this.configFile = join(this.configDir, "config.json");
  }

  /**
   * Ensure config directory exists
   */
  private async ensureConfigDir(): Promise<void> {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, ignore EEXIST errors
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }

  /**
   * Load config file
   */
  private async loadConfig(): Promise<ClientConfigFile> {
    try {
      const content = await fs.readFile(this.configFile, "utf-8");
      return parseConfigFile(JSON.parse(content));
    } catch (error) {
      // Config file doesn't exist or is invalid, return empty config
      return { oauthClients: {} };
    }
  }

  /**
   * Save config file
   */
  private async saveConfig(config: ClientConfigFile): Promise<void> {
    await this.ensureConfigDir();
    await fs.writeFile(
      this.configFile,
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  /**
   * Get OAuth client ID for a specific MCP host
   */
  async getOAuthClientId(mcpHost: string): Promise<string | null> {
    const clientConfig = await this.getOAuthClient(mcpHost);
    return clientConfig?.clientId || null;
  }

  /**
   * Get the full OAuth client config for a specific MCP host
   */
  async getOAuthClient(mcpHost: string): Promise<OAuthClientConfig | null> {
    const config = await this.loadConfig();
    return config.oauthClients[mcpHost] || null;
  }

  /**
   * Store OAuth client ID for a specific MCP host
   */
  async setOAuthClientId(
    mcpHost: string,
    clientId: string,
    redirectUri?: string,
  ): Promise<void> {
    const config = await this.loadConfig();

    // Preserve existing access token if present
    const existing = config.oauthClients[mcpHost];
    config.oauthClients[mcpHost] = {
      clientId,
      mcpHost,
      ...(redirectUri !== undefined && { redirectUri }),
      registeredAt: new Date().toISOString(),
      ...(existing?.accessToken !== undefined && {
        accessToken: existing.accessToken,
      }),
      ...(existing?.tokenExpiresAt !== undefined && {
        tokenExpiresAt: existing.tokenExpiresAt,
      }),
    };

    await this.saveConfig(config);
  }

  /**
   * Remove OAuth client configuration for a specific MCP host
   */
  async removeOAuthClientId(mcpHost: string): Promise<void> {
    const config = await this.loadConfig();
    delete config.oauthClients[mcpHost];
    await this.saveConfig(config);
  }

  /**
   * Get cached access token for a specific MCP host
   */
  async getAccessToken(mcpHost: string): Promise<string | null> {
    const config = await this.loadConfig();
    const clientConfig = config.oauthClients[mcpHost];

    if (!clientConfig?.accessToken) {
      return null;
    }

    // Check if token is expired
    if (clientConfig.tokenExpiresAt) {
      const expiresAt = new Date(clientConfig.tokenExpiresAt);
      const now = new Date();
      // Add 5 minute buffer before expiration
      const bufferTime = 5 * 60 * 1000;

      if (now.getTime() + bufferTime >= expiresAt.getTime()) {
        // Token is expired or will expire soon
        await this.removeAccessToken(mcpHost);
        return null;
      }
    }

    return clientConfig.accessToken;
  }

  /**
   * Store access token for a specific MCP host
   */
  async setAccessToken(
    mcpHost: string,
    accessToken: string,
    expiresIn?: number,
  ): Promise<void> {
    const config = await this.loadConfig();

    const existing = config.oauthClients[mcpHost];
    if (!existing) {
      throw new Error(`No OAuth client configuration found for ${mcpHost}`);
    }

    let tokenExpiresAt: string | undefined;
    if (expiresIn) {
      // expiresIn is in seconds, convert to milliseconds
      const expiresAtMs = Date.now() + expiresIn * 1000;
      tokenExpiresAt = new Date(expiresAtMs).toISOString();
    }

    config.oauthClients[mcpHost] = {
      ...withoutAccessToken(existing),
      accessToken,
      ...(tokenExpiresAt !== undefined && { tokenExpiresAt }),
    };

    await this.saveConfig(config);
  }

  /**
   * Remove cached access token for a specific MCP host
   */
  async removeAccessToken(mcpHost: string): Promise<void> {
    const config = await this.loadConfig();
    const existing = config.oauthClients[mcpHost];

    if (existing) {
      config.oauthClients[mcpHost] = withoutAccessToken(existing);
      await this.saveConfig(config);
    }
  }

  /**
   * Clear all cached tokens (useful for logout)
   */
  async clearAllTokens(): Promise<void> {
    const config = await this.loadConfig();

    for (const [host, clientConfig] of Object.entries(config.oauthClients)) {
      config.oauthClients[host] = withoutAccessToken(clientConfig);
    }

    await this.saveConfig(config);
  }

  /**
   * List all registered OAuth clients
   */
  async listOAuthClients(): Promise<OAuthClientConfig[]> {
    const config = await this.loadConfig();
    return Object.values(config.oauthClients);
  }
}
