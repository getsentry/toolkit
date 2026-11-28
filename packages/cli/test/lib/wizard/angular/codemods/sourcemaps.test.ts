import { describe, it, vi, expect, beforeEach } from "vitest";
import {
  addSourcemapEntryToAngularJSON,
  addSourceMapsSetting,
} from "../../../../../src/lib/wizard/angular/codemods/sourcemaps.js";

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as AngularSourceMapsWizard from "../../../../../src/lib/wizard/sourcemaps/tools/angular.js";

const { readFileSyncMock, writeFileSyncMock } = vi.hoisted(() => {
  return {
    readFileSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  return {
    ...(await vi.importActual("node:fs")),
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
  };
});

describe("addSourcemapEntryToAngularJSON", () => {
  const configureAngularSourcemapGenerationFlowSpy = vi
    .spyOn(AngularSourceMapsWizard, "configureAngularSourcemapGenerationFlow")
    .mockImplementation(() => Promise.resolve());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads and writes the `angular.json` file correctly", async () => {
    const angularJsonPath = "angular.json";
    const angularJsonContent = JSON.stringify({
      projects: {
        project1: {
          architect: {
            build: {
              configurations: {
                production: {
                  someKey: "someValue",
                },
              },
            },
          },
        },
      },
    });

    readFileSyncMock.mockReturnValue(angularJsonContent);

    await addSourcemapEntryToAngularJSON();

    expect(readFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(angularJsonPath),
      "utf-8",
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(angularJsonPath),
      JSON.stringify(
        {
          projects: {
            project1: {
              architect: {
                build: {
                  configurations: {
                    production: {
                      someKey: "someValue",
                      sourceMap: true,
                    },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
  });

  it("falls back to printing copy/paste instructions when reading fails", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("File not found");
    });

    await addSourcemapEntryToAngularJSON();

    expect(configureAngularSourcemapGenerationFlowSpy).toHaveBeenCalledOnce();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("falls back to printing copy/paste instructions when writing fails", async () => {
    const angularJsonContent = JSON.stringify({
      projects: {
        project1: {},
      },
    });

    readFileSyncMock.mockReturnValue(angularJsonContent);
    writeFileSyncMock.mockImplementation(() => {
      throw new Error("Write failed");
    });

    await addSourcemapEntryToAngularJSON();

    expect(configureAngularSourcemapGenerationFlowSpy).toHaveBeenCalledOnce();
    expect(writeFileSyncMock).toHaveBeenCalled();
  });

  it("falls back to printing copy/paste instructions when angular.json` has no projects", async () => {
    const angularJsonContent = JSON.stringify({
      projects: {},
    });

    readFileSyncMock.mockReturnValue(angularJsonContent);

    await addSourcemapEntryToAngularJSON();

    expect(configureAngularSourcemapGenerationFlowSpy).toHaveBeenCalledOnce();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("addSourceMapsSetting", () => {
  it("adds sourceMap setting to angular.json", () => {
    const angularJson = {
      projects: {
        project1: {
          architect: {
            build: {
              configurations: {
                production: {},
              },
            },
          },
        },
        project2: {
          architect: {},
        },
      },
    };

    const updatedAngularJson = addSourceMapsSetting(angularJson);

    expect(updatedAngularJson).toEqual({
      projects: {
        project1: {
          architect: {
            build: {
              configurations: {
                production: { sourceMap: true },
              },
            },
          },
        },
        project2: {
          architect: {
            build: {
              configurations: {
                production: {
                  sourceMap: true,
                },
              },
            },
          },
        },
      },
    });
  });

  it("returns `undefined` if no projects are found", () => {
    const angularJson = {};

    const updatedAngularJson = addSourceMapsSetting(angularJson);

    expect(updatedAngularJson).toBeUndefined();
  });

  it("returns `undefined` if projects have no architect", () => {
    const angularJson = {
      projects: {},
    };

    const updatedAngularJson = addSourceMapsSetting(angularJson);

    expect(updatedAngularJson).toBeUndefined();
  });

  it.each([
    {
      projects: {
        project1: {
          architect: {
            build: {
              configurations: {
                production: {},
              },
            },
          },
        },
      },
    },
    {
      projects: {
        project1: {
          architect: {
            build: {
              configurations: {},
            },
          },
        },
      },
    },
    {
      projects: {
        project1: {
          architect: {
            build: {},
          },
        },
      },
    },
    {
      projects: {
        project1: {
          architect: {},
        },
      },
    },
    {
      projects: {
        project1: {},
      },
    },
  ])("handles incomplete project declarations (%s)", (angularJson) => {
    const updatedAngularJson = addSourceMapsSetting(angularJson);

    expect(updatedAngularJson).toEqual({
      projects: {
        project1: {
          architect: {
            build: {
              configurations: {
                production: { sourceMap: true },
              },
            },
          },
        },
      },
    });
  });
});
