import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as path from "node:path";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as childProcess from "node:child_process";
import { offerProjectScopedMcpConfig } from "../../../../../src/lib/wizard/utils/clack/mcp-config.js";

// Mock types for better type safety
type ConfigContent = {
  mcpServers?: Record<string, { url: string }>;
  servers?: Record<string, { url: string; type?: string }>;
  mcp?: Record<string, { type: string; url: string; oauth?: object }>;
  $schema?: string;
  otherProperty?: string;
};

// Mock the clack utils which wrap the prompts
vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", () => ({
  abortIfCancelled: vi.fn((value: unknown) => Promise.resolve(value)),
  showCopyPasteInstructions: vi.fn(),
}));

// Mock the external dependencies
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  log: {
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("node:fs");
vi.mock("node:child_process");

describe("mcp-config", () => {
  // Helper to get mocked modules with proper typing
  type ClackMocks = {
    select: ReturnType<typeof vi.fn>;
    multiselect: ReturnType<typeof vi.fn>;
    log: {
      success: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    };
  };

  type ClackUtilsMocks = {
    abortIfCancelled: Mock<(value: unknown) => Promise<unknown>>;
    showCopyPasteInstructions: ReturnType<typeof vi.fn>;
  };

  const getMocks = async () => {
    const clack = await vi.importMock<ClackMocks>("@clack/prompts");
    const clackUtils = await vi.importMock<ClackUtilsMocks>(
      "../../../../../src/lib/wizard/utils/clack/index.js",
    );
    return { clack, clackUtils };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("offerProjectScopedMcpConfig", () => {
    it("should return early if user declines MCP config", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValue("no");
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      await offerProjectScopedMcpConfig();

      expect(clack.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "Optionally add a project-scoped MCP server configuration",
          ) as string,
          options: expect.arrayContaining([
            expect.objectContaining({ value: "yes" }),
            expect.objectContaining({ value: "no" }),
            expect.objectContaining({ value: "explain" }),
          ]) as unknown[],
          initialValue: "yes",
        }),
      );
    });

    it("should configure for Cursor when selected", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["cursor"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      expect(clack.multiselect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Which editor(s) do you want to configure?",
          options: expect.arrayContaining([
            expect.objectContaining({ value: "cursor" }),
            expect.objectContaining({ value: "vscode" }),
            expect.objectContaining({ value: "claudeCode" }),
          ]) as unknown[],
        }),
      );

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".cursor/mcp.json"),
        expect.stringContaining('"mcpServers"'),
        "utf8",
      );

      expect(clack.log.success).toHaveBeenCalledWith(
        expect.stringContaining(".cursor/mcp.json"),
      );
      expect(clack.log.success).toHaveBeenCalledWith(
        "Added project-scoped Sentry MCP configuration for Cursor.",
      );
      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("reload your editor"),
      );
    });

    it("should configure for VS Code when selected", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["vscode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".vscode/mcp.json"),
        expect.stringContaining('"servers"'),
        "utf8",
      );

      expect(clack.log.success).toHaveBeenCalledWith(
        expect.stringContaining(".vscode/mcp.json"),
      );
    });

    it("should configure for Claude Code when selected", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["claudeCode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".mcp.json"),
        expect.stringContaining('"mcpServers"'),
        "utf8",
      );

      expect(clack.log.success).toHaveBeenCalledWith(
        expect.stringContaining(".mcp.json"),
      );
    });

    it("should update existing Cursor config file", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["cursor"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const existingConfig = JSON.stringify({
        mcpServers: {
          OtherServer: {
            url: "https://other.example.com",
          },
        },
      });

      const mockReadFile = vi.fn().mockResolvedValue(existingConfig);
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      expect(mockReadFile).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".cursor/mcp.json"),
        expect.stringContaining("Sentry"),
        "utf8",
      );

      const writtenContent = JSON.parse(
        mockWriteFile.mock.calls[0]?.[1] as string,
      ) as ConfigContent;
      expect(writtenContent.mcpServers).toHaveProperty("OtherServer");
      expect(writtenContent.mcpServers).toHaveProperty("Sentry");

      expect(clack.log.success).toHaveBeenCalledWith(
        "Updated .cursor/mcp.json",
      );
    });

    it("should update existing VS Code config file", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["vscode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const existingConfig = JSON.stringify({
        servers: {
          OtherServer: {
            url: "https://other.example.com",
            type: "http",
          },
        },
      });

      const mockReadFile = vi.fn().mockResolvedValue(existingConfig);
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      const writtenContent = JSON.parse(
        mockWriteFile.mock.calls[0]?.[1] as string,
      ) as ConfigContent;
      expect(writtenContent.servers).toHaveProperty("OtherServer");
      expect(writtenContent.servers).toHaveProperty("Sentry");
      expect(writtenContent.servers?.["Sentry"]).toHaveProperty("type", "http");

      expect(clack.log.success).toHaveBeenCalledWith(
        "Updated .vscode/mcp.json",
      );
    });

    it("should update existing Claude Code config file", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["claudeCode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const existingConfig = JSON.stringify({
        mcpServers: {
          OtherServer: {
            url: "https://other.example.com",
          },
        },
      });

      const mockReadFile = vi.fn().mockResolvedValue(existingConfig);
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      const writtenContent = JSON.parse(
        mockWriteFile.mock.calls[0]?.[1] as string,
      ) as ConfigContent;
      expect(writtenContent.mcpServers).toHaveProperty("OtherServer");
      expect(writtenContent.mcpServers).toHaveProperty("Sentry");

      expect(clack.log.success).toHaveBeenCalledWith("Updated .mcp.json");
    });

    it("should configure for OpenCode when selected", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["openCode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("opencode.json"),
        expect.stringContaining('"mcp"'),
        "utf8",
      );

      // Verify the written content has the correct structure for OpenCode
      const writtenContent = JSON.parse(
        mockWriteFile.mock.calls[0]?.[1] as string,
      ) as ConfigContent;
      expect(writtenContent.$schema).toBe("https://opencode.ai/config.json");
      expect(writtenContent.mcp).toHaveProperty("Sentry");
      expect(writtenContent.mcp?.["Sentry"]).toHaveProperty("type", "remote");
      expect(writtenContent.mcp?.["Sentry"]).toHaveProperty("url");
      expect(writtenContent.mcp?.["Sentry"]?.oauth).toEqual({});

      expect(clack.log.success).toHaveBeenCalledWith(
        expect.stringContaining("opencode.json"),
      );
      expect(clack.log.success).toHaveBeenCalledWith(
        "Added project-scoped Sentry MCP configuration for OpenCode.",
      );
      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("restart OpenCode"),
      );
    });

    it("should update existing OpenCode config file", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["openCode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const existingConfig = JSON.stringify({
        mcp: {
          OtherServer: {
            type: "remote",
            url: "https://other.example.com",
          },
        },
      });

      const mockReadFile = vi.fn().mockResolvedValue(existingConfig);
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      const writtenContent = JSON.parse(
        mockWriteFile.mock.calls[0]?.[1] as string,
      ) as ConfigContent;
      expect(writtenContent.mcp).toHaveProperty("OtherServer");
      expect(writtenContent.mcp).toHaveProperty("Sentry");
      expect(writtenContent.mcp?.["Sentry"]).toHaveProperty("type", "remote");

      expect(clack.log.success).toHaveBeenCalledWith("Updated opencode.json");
    });

    it("should handle file write errors gracefully for OpenCode", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["openCode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await expect(offerProjectScopedMcpConfig()).resolves.toBeUndefined();

      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write MCP config for openCode"),
      );

      expect(clackUtils.showCopyPasteInstructions).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "opencode.json",
          codeSnippet: expect.stringContaining('"mcp"') as string,
          hint: "create the file if it does not exist",
        }),
      );
    });

    it("should handle file write errors gracefully for Cursor", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["cursor"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await expect(offerProjectScopedMcpConfig()).resolves.toBeUndefined();

      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write MCP config"),
      );

      expect(clackUtils.showCopyPasteInstructions).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: path.join(".cursor", "mcp.json"),
          codeSnippet: expect.stringContaining("mcpServers") as string,
          hint: "create the file if it does not exist",
        }),
      );
    });

    it("should handle file write errors gracefully for VS Code", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["vscode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await expect(offerProjectScopedMcpConfig()).resolves.toBeUndefined();

      expect(clackUtils.showCopyPasteInstructions).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: path.join(".vscode", "mcp.json"),
          codeSnippet: expect.stringContaining("servers") as string,
          hint: "create the file if it does not exist",
        }),
      );
    });

    it("should handle file write errors gracefully for Claude Code", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["claudeCode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await expect(offerProjectScopedMcpConfig()).resolves.toBeUndefined();

      expect(clackUtils.showCopyPasteInstructions).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: ".mcp.json",
          codeSnippet: expect.stringContaining("mcpServers") as string,
          hint: "create the file if it does not exist",
        }),
      );
    });

    it("should handle update errors and show copy-paste instructions", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["cursor"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      // Mock existing file and simulate write error during update
      const existingConfig = JSON.stringify({
        mcpServers: {
          OtherServer: {
            url: "https://other.example.com",
          },
        },
      });

      const mockReadFile = vi.fn().mockResolvedValue(existingConfig);
      const mockWriteFile = vi
        .fn()
        .mockRejectedValue(new Error("Write failed during update"));
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await expect(offerProjectScopedMcpConfig()).resolves.toBeUndefined();

      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write MCP config"),
      );

      expect(clackUtils.showCopyPasteInstructions).toHaveBeenCalled();
    });

    it("should handle mkdirSync errors", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["cursor"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn().mockImplementation(() => {
        throw new Error("Permission denied");
      });

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await expect(offerProjectScopedMcpConfig()).resolves.toBeUndefined();

      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write MCP config"),
      );

      expect(clackUtils.showCopyPasteInstructions).toHaveBeenCalled();
    });

    it("should create config with empty servers/mcpServers when existing config lacks them", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["vscode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const existingConfig = JSON.stringify({
        otherProperty: "value",
      });

      const mockReadFile = vi.fn().mockResolvedValue(existingConfig);
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      const writtenContent = JSON.parse(
        mockWriteFile.mock.calls[0]?.[1] as string,
      ) as ConfigContent;
      expect(writtenContent).toHaveProperty("otherProperty", "value");
      expect(writtenContent).toHaveProperty("servers");
      expect(writtenContent.servers).toHaveProperty("Sentry");

      expect(clack.log.success).toHaveBeenCalledWith(
        "Updated .vscode/mcp.json",
      );
    });

    it("should show config for JetBrains IDEs with clipboard copy", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select)
        .mockResolvedValueOnce("yes")
        .mockResolvedValueOnce(true); // For the clipboard copy prompt
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["jetbrains"]);

      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      // Mock clipboard copy
      const mockSpawn = vi.fn().mockReturnValue({
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
        on: vi.fn((event, callback: (code?: number) => void) => {
          if (event === "close") callback(0);
        }),
      });
      vi.spyOn(childProcess, "spawn").mockImplementation(mockSpawn);

      // Mock console.log to capture output
      const consoleSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await offerProjectScopedMcpConfig();

      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("JetBrains IDEs"),
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("mcpServers"),
      );

      // Should ask to copy to clipboard
      expect(clack.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Copy configuration to clipboard?",
        }),
      );

      expect(clack.log.success).toHaveBeenCalledWith(
        "Configuration copied to clipboard!",
      );

      consoleSpy.mockRestore();
    });

    it("should show generic config for unsupported IDEs with clipboard copy", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select)
        .mockResolvedValueOnce("yes")
        .mockResolvedValueOnce(true); // For the clipboard copy prompt
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["other"]);

      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      // Mock clipboard copy failure to test fallback
      const mockSpawn = vi.fn().mockReturnValue({
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
        on: vi.fn((event, callback: () => void) => {
          if (event === "error") callback();
        }),
      });
      vi.spyOn(childProcess, "spawn").mockImplementation(mockSpawn);

      // Mock console.log to capture output
      const consoleSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await offerProjectScopedMcpConfig();

      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("Generic MCP configuration"),
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("mcpServers"),
      );

      // Should ask to copy to clipboard
      expect(clack.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Copy configuration to clipboard?",
        }),
      );

      // Since clipboard copy failed, should show warning
      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to copy to clipboard"),
      );

      consoleSpy.mockRestore();
    });

    it("should handle clipboard copy failure gracefully for JetBrains", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select)
        .mockResolvedValueOnce("yes")
        .mockResolvedValueOnce(true); // For clipboard copy prompt
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["jetbrains"]);

      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      // Mock clipboard copy to throw error
      const mockSpawn = vi.fn().mockImplementation(() => {
        throw new Error("Clipboard not available");
      });
      vi.spyOn(childProcess, "spawn").mockImplementation(mockSpawn);

      // Mock console.log to capture output
      const consoleSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await offerProjectScopedMcpConfig();

      // Should ask to copy to clipboard
      expect(clack.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Copy configuration to clipboard?",
        }),
      );

      // Should show warning when clipboard fails
      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to copy to clipboard"),
      );

      consoleSpy.mockRestore();
    });

    it('should show MCP explanation when user selects "What is MCP?"', async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select)
        .mockResolvedValueOnce("explain") // User selects "What is MCP?"
        .mockResolvedValueOnce(true); // User selects "Yes" after explanation
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["cursor"]); // User selects Cursor

      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      // Should show MCP explanation
      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("What is MCP"),
      );

      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("AI assistants"),
      );

      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("https://docs.sentry.io/product/sentry-mcp/"),
      );

      // Should ask again after explanation
      expect(clack.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Would you like to configure MCP for your IDE now?",
        }),
      );

      // Should proceed with normal flow
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("should respect user choice not to copy to clipboard", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select)
        .mockResolvedValueOnce("yes")
        .mockResolvedValueOnce(false); // User declines to copy to clipboard
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["jetbrains"]);

      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockSpawn = vi.fn();
      vi.spyOn(childProcess, "spawn").mockImplementation(mockSpawn);

      // Mock console.log to capture output
      const consoleSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await offerProjectScopedMcpConfig();

      // Should ask to copy to clipboard
      expect(clack.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Copy configuration to clipboard?",
        }),
      );

      // Should NOT attempt to copy when user declines
      expect(mockSpawn).not.toHaveBeenCalled();

      // Should NOT show success or warning messages
      expect(clack.log.success).not.toHaveBeenCalledWith(
        "Configuration copied to clipboard!",
      );
      expect(clack.log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to copy to clipboard"),
      );

      consoleSpy.mockRestore();
    });

    it("should exit if user declines after MCP explanation", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select)
        .mockResolvedValueOnce("explain") // User selects "What is MCP?"
        .mockResolvedValueOnce(false); // User selects "No" after explanation

      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      await offerProjectScopedMcpConfig();

      // Should show MCP explanation
      expect(clack.log.info).toHaveBeenCalledWith(
        expect.stringContaining("What is MCP"),
      );

      // Should ask again after explanation
      expect(clack.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Would you like to configure MCP for your IDE now?",
        }),
      );

      // Should NOT proceed with editor selection
      expect(clack.multiselect).not.toHaveBeenCalled();
    });

    it("should configure multiple editors when selected", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce([
        "cursor",
        "vscode",
        "claudeCode",
      ]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      // Should write config for all three editors
      expect(mockWriteFile).toHaveBeenCalledTimes(3);
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".cursor/mcp.json"),
        expect.stringContaining('"mcpServers"'),
        "utf8",
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".vscode/mcp.json"),
        expect.stringContaining('"servers"'),
        "utf8",
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".mcp.json"),
        expect.stringContaining('"mcpServers"'),
        "utf8",
      );

      // Should show success messages for each (twice per editor: filename + editor-specific message)
      expect(clack.log.success).toHaveBeenCalledWith(
        "Added project-scoped Sentry MCP configuration for Cursor.",
      );
      expect(clack.log.success).toHaveBeenCalledWith(
        "Added project-scoped Sentry MCP configuration for VS Code.",
      );
      expect(clack.log.success).toHaveBeenCalledWith(
        "Added project-scoped Sentry MCP configuration for Claude Code.",
      );
    });

    it("should return early when no editors are selected", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce([]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockWriteFile = vi.fn();
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);

      await offerProjectScopedMcpConfig();

      expect(clack.log.info).toHaveBeenCalledWith(
        "No editors selected. You can add MCP configuration later.",
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("should handle mixed success and failure for multiple editors", async () => {
      const { clack, clackUtils } = await getMocks();

      vi.mocked(clack.select).mockResolvedValueOnce("yes");
      vi.mocked(clack.multiselect).mockResolvedValueOnce(["cursor", "vscode"]);
      vi.mocked(clackUtils.abortIfCancelled).mockImplementation(
        (value: unknown) => Promise.resolve(value),
      );

      const mockReadFile = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));
      const mockWriteFile = vi
        .fn()
        .mockResolvedValueOnce(undefined) // Cursor succeeds
        .mockRejectedValueOnce(new Error("Permission denied")); // VS Code fails
      const mockMkdirSync = vi.fn();

      vi.spyOn(fs.promises, "readFile").mockImplementation(mockReadFile);
      vi.spyOn(fs.promises, "writeFile").mockImplementation(mockWriteFile);
      vi.spyOn(fs, "mkdirSync").mockImplementation(mockMkdirSync);

      await offerProjectScopedMcpConfig();

      // Cursor should succeed
      expect(clack.log.success).toHaveBeenCalledWith(
        expect.stringContaining(".cursor/mcp.json"),
      );

      // VS Code should fail and show fallback
      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write MCP config for vscode"),
      );
      expect(clackUtils.showCopyPasteInstructions).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: path.join(".vscode", "mcp.json"),
        }),
      );
    });
  });
});
