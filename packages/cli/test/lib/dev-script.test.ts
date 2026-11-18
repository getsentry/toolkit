/**
 * Unit tests for detectDevCommand.
 *
 * Note: Core invariants (script priority detection for arbitrary script names)
 * are tested via property-based tests in dev-script.property.test.ts. These
 * tests focus on filesystem integration, fallback chains, and priority ordering.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type DetectOptions,
  detectDevCommand as detectWithEnv,
} from "../../src/lib/dev-script.js";
import { whichSync } from "../../src/lib/which.js";
import { TEST_TMP_DIR } from "../constants.js";

vi.mock("../../src/lib/which.js", () => ({ whichSync: vi.fn() }));

/** Make only these commands resolvable on the mocked PATH. */
function onPath(...commands: string[]): void {
  vi.mocked(whichSync).mockImplementation((cmd) =>
    commands.includes(cmd) ? `/usr/bin/${cmd}` : null,
  );
}

/**
 * Detect as on Linux with an empty env, so the runner's OS, VIRTUAL_ENV, or
 * FLASK_APP never leaks in. Windows cases pass `platform: "win32"`.
 */
function detectDevCommand(cwd: string, options: DetectOptions = {}) {
  return detectWithEnv(cwd, { env: {}, platform: "linux", ...options });
}

/** Create an empty executable stand-in inside the temp project. */
async function touch(...segments: string[]): Promise<string> {
  const path = join(tmpDir, ...segments);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
  return path;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "dev-script-test-"));
  onPath("python", "python3");
});

afterEach(async () => {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("detectDevCommand", () => {
  test("detects package.json scripts.dev", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } }),
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["next", "dev"]);
    expect(result!.source).toBe("package.json scripts.dev");
  });

  test("detects package.json scripts.start when dev is absent", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } }),
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["node", "server.js"]);
    expect(result!.source).toBe("package.json scripts.start");
  });

  test("falls through package.json with no scripts", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" }),
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toBeNull();
  });

  test("detects manage.py (Django)", async () => {
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["python", "manage.py", "runserver"]);
    expect(result!.source).toBe("manage.py");
  });

  test("detects app.py", async () => {
    await writeFile(join(tmpDir, "app.py"), "from flask import Flask");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["python", "app.py"]);
    expect(result!.source).toBe("app.py");
  });

  test("detects main.py", async () => {
    await writeFile(join(tmpDir, "main.py"), "print('hello')");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["python", "main.py"]);
    expect(result!.source).toBe("main.py");
  });

  test.each([
    ["python3 only", ["python3"], "python3"],
    ["python only", ["python"], "python"],
    ["neither", [], "python"],
  ])(
    "uses the Python on PATH for manage.py (%s)",
    async (_label, commands, expected) => {
      // Ubuntu and Debian ship only python3 (CLI-3NK).
      onPath(...commands);
      await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
      const result = await detectDevCommand(tmpDir);
      expect(result!.args).toEqual([expected, "manage.py", "runserver"]);
    },
  );

  test("detects go.mod", async () => {
    await writeFile(join(tmpDir, "go.mod"), "module example.com/myapp");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["go", "run", "."]);
    expect(result!.source).toBe("go.mod");
  });

  test("detects docker-compose.yml", async () => {
    await writeFile(join(tmpDir, "docker-compose.yml"), "version: '3'");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["docker", "compose", "up"]);
    expect(result!.source).toBe("docker-compose.yml");
  });

  test("detects compose.yml", async () => {
    await writeFile(join(tmpDir, "compose.yml"), "version: '3'");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["docker", "compose", "up"]);
    expect(result!.source).toBe("compose.yml");
  });

  test("returns null for empty directory", async () => {
    const result = await detectDevCommand(tmpDir);
    expect(result).toBeNull();
  });

  test("package.json takes priority over manage.py", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("package.json scripts.dev");
  });

  test("prefers dev over start in package.json", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js", dev: "vite" } }),
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("package.json scripts.dev");
    expect(result!.args).toEqual(["vite"]);
  });

  test("prefers develop over serve", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { serve: "serve dist", develop: "gatsby develop" },
      }),
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("package.json scripts.develop");
  });

  test("falls back to python file for a script that runs itself", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      'from fastapi import FastAPI\napp = FastAPI()\nif __name__ == "__main__":\n    import uvicorn\n    uvicorn.run(app)\n',
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({ args: ["python", "main.py"], source: "main.py" });
  });
});

describe("detectDevCommand: Python virtualenv", () => {
  test("uses .venv/bin/python when the venv is not activated", async () => {
    const python = await touch(".venv", "bin", "python");
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([python, "manage.py", "runserver"]);
  });

  test("falls back to venv/ when there is no .venv/", async () => {
    const python = await touch("venv", "bin", "python");
    await writeFile(join(tmpDir, "main.py"), "print('hello')");
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([python, "main.py"]);
  });

  test("prefers .venv/ over venv/", async () => {
    const python = await touch(".venv", "bin", "python");
    await touch("venv", "bin", "python");
    await writeFile(join(tmpDir, "main.py"), "print('hello')");
    const result = await detectDevCommand(tmpDir);
    expect(result!.args[0]).toBe(python);
  });

  test("prefers the activated VIRTUAL_ENV", async () => {
    const python = await touch("elsewhere", "bin", "python");
    await touch(".venv", "bin", "python");
    await writeFile(join(tmpDir, "main.py"), "print('hello')");
    const result = await detectDevCommand(tmpDir, {
      env: { VIRTUAL_ENV: join(tmpDir, "elsewhere") },
    });
    expect(result!.args[0]).toBe(python);
  });

  test("uses Scripts\\python.exe on Windows", async () => {
    const python = await touch(".venv", "Scripts", "python.exe");
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    const result = await detectDevCommand(tmpDir, { platform: "win32" });
    expect(result!.args).toEqual([python, "manage.py", "runserver"]);
  });

  test("ignores a venv directory with no interpreter", async () => {
    await mkdir(join(tmpDir, ".venv"));
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual(["python", "manage.py", "runserver"]);
  });
});

/** A top-level app whose framework only the declared dependencies name. */
const APP_FACTORY = "from myapp import create_app\n\napp = create_app()\n";

describe("detectDevCommand: FastAPI", () => {
  const FASTAPI_APP = "from fastapi import FastAPI\n\napp = FastAPI()\n";

  test("runs main.py through uvicorn", async () => {
    await writeFile(join(tmpDir, "main.py"), FASTAPI_APP);
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({
      args: ["python", "-m", "uvicorn", "main:app", "--reload"],
      source: "main.py (FastAPI)",
    });
  });

  test("uses the venv interpreter for uvicorn", async () => {
    const python = await touch(".venv", "bin", "python");
    await writeFile(join(tmpDir, "app.py"), FASTAPI_APP);
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([
      python,
      "-m",
      "uvicorn",
      "app:app",
      "--reload",
    ]);
  });

  test("uses the name the app is assigned to", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      "import fastapi\napi: fastapi.FastAPI = fastapi.FastAPI()\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toContain("main:api");
  });

  test("uses uvicorn even when the venv has a fastapi script", async () => {
    // Plain `fastapi` installs a `fastapi` script that fails without
    // `fastapi[standard]`, so its presence does not mean `fastapi dev` works.
    const python = await touch(".venv", "bin", "python");
    await touch(".venv", "bin", "fastapi");
    await writeFile(join(tmpDir, "main.py"), FASTAPI_APP);
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([
      python,
      "-m",
      "uvicorn",
      "main:app",
      "--reload",
    ]);
  });

  test("uses the Windows venv interpreter for uvicorn", async () => {
    const python = await touch(".venv", "Scripts", "python.exe");
    await writeFile(join(tmpDir, "main.py"), FASTAPI_APP);
    const result = await detectDevCommand(tmpDir, { platform: "win32" });
    expect(result!.args[0]).toBe(python);
  });

  test.each([
    [
      "pyproject.toml",
      '[project]\ndependencies = ["fastapi[standard]>=0.110"]\n',
    ],
    ["requirements.txt", "fastapi==0.115.0\nuvicorn\n"],
  ])("detects FastAPI declared in %s", async (manifest, contents) => {
    await writeFile(join(tmpDir, manifest), contents);
    await writeFile(join(tmpDir, "main.py"), APP_FACTORY);
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([
      "python",
      "-m",
      "uvicorn",
      "main:app",
      "--reload",
    ]);
  });

  test("detects FastAPI declared as a Poetry dependency", async () => {
    await writeFile(
      join(tmpDir, "pyproject.toml"),
      '[tool.poetry.dependencies]\nfastapi = "^0.115"\n',
    );
    await writeFile(join(tmpDir, "main.py"), APP_FACTORY);
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("main.py (FastAPI)");
  });

  test("ignores a framework named only in prose or comments", async () => {
    await writeFile(
      join(tmpDir, "pyproject.toml"),
      '[project]\ndescription = "A flask demo"\n# fastapi later\n',
    );
    await writeFile(join(tmpDir, "main.py"), "print('hello')");
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("main.py");
  });

  test("does not mistake fastapi-users for FastAPI", async () => {
    await writeFile(join(tmpDir, "requirements.txt"), "fastapi-users\n");
    await writeFile(join(tmpDir, "main.py"), APP_FACTORY);
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("main.py");
  });

  test("reads multi-line PEP 621 and optional dependency arrays", async () => {
    await writeFile(
      join(tmpDir, "pyproject.toml"),
      [
        "[project]",
        "dependencies = [",
        '  "sentry-sdk[fastapi]>=2",',
        "]",
        "",
        "[project.optional-dependencies]",
        "web = [",
        '  "fastapi[standard]>=0.110",',
        "]",
      ].join("\n"),
    );
    await writeFile(join(tmpDir, "main.py"), APP_FACTORY);
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("main.py (FastAPI)");
  });

  test("ignores a framework in pyproject keys that are not dependencies", async () => {
    await writeFile(
      join(tmpDir, "pyproject.toml"),
      '[project]\nkeywords = ["flask", "fastapi"]\ndependencies = []\n',
    );
    await writeFile(join(tmpDir, "main.py"), APP_FACTORY);
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("main.py");
  });

  test("runs a file that imports FastAPI only for typing as a script", async () => {
    await writeFile(join(tmpDir, "requirements.txt"), "fastapi\n");
    await writeFile(
      join(tmpDir, "main.py"),
      "from fastapi import FastAPI\n\ndef describe(api: FastAPI) -> str:\n    return api.title\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toMatchObject({
      args: ["python", "main.py"],
      source: "main.py",
    });
  });
});

describe("detectDevCommand: Flask", () => {
  const FLASK_APP = "from flask import Flask\n\napp = Flask(__name__)\n";

  test("runs app.py through flask run", async () => {
    await writeFile(join(tmpDir, "app.py"), FLASK_APP);
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({
      args: ["python", "-m", "flask", "--app", "app:app", "run"],
      source: "app.py (Flask)",
    });
  });

  test("runs wsgi.py through flask run", async () => {
    const python = await touch(".venv", "bin", "python");
    await writeFile(join(tmpDir, "wsgi.py"), FLASK_APP);
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({
      args: [python, "-m", "flask", "--app", "wsgi:app", "run"],
      source: "wsgi.py (Flask)",
    });
  });

  test("detects an app factory from the declared dependency", async () => {
    await writeFile(join(tmpDir, "requirements.txt"), "Flask>=3\n");
    await writeFile(join(tmpDir, "app.py"), APP_FACTORY);
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({
      args: ["python", "-m", "flask", "--app", "app:app", "run"],
      source: "app.py (Flask)",
    });
  });

  test("serves a create_app factory with no top-level app", async () => {
    await writeFile(
      join(tmpDir, "app.py"),
      "from flask import Flask\n\ndef create_app():\n    app = Flask(__name__)\n    return app\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({
      args: ["python", "-m", "flask", "--app", "app:create_app", "run"],
      source: "app.py (Flask)",
    });
  });

  test("passes the Flask app variable to --app", async () => {
    await writeFile(
      join(tmpDir, "app.py"),
      "import flask\n\nserver = flask.Flask(__name__)\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([
      "python",
      "-m",
      "flask",
      "--app",
      "app:server",
      "run",
    ]);
  });

  test.each([
    ["a comment", "# app = Flask(__name__)\nprint('hi')\n"],
    ["a string", 'doc = "app = Flask(__name__)"\nprint(doc)\n'],
    ["a subclass", "app = MyFlask(__name__)\n"],
  ])("does not take Flask( in %s for a Flask app", async (_label, source) => {
    await writeFile(join(tmpDir, "app.py"), source);
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("app.py");
  });

  test("lets FLASK_APP pick the app in a Python project", async () => {
    await writeFile(join(tmpDir, "requirements.txt"), "flask\n");
    const result = await detectDevCommand(tmpDir, {
      env: { FLASK_APP: "myapp:create_app()" },
    });
    expect(result).toEqual({
      args: ["python", "-m", "flask", "run"],
      source: "FLASK_APP (Flask)",
    });
  });

  test("ignores FLASK_APP outside a Python project", async () => {
    await writeFile(join(tmpDir, "go.mod"), "module example.com/myapp");
    const result = await detectDevCommand(tmpDir, {
      env: { FLASK_APP: "app" },
    });
    expect(result).toEqual({ args: ["go", "run", "."], source: "go.mod" });
  });

  test("an app in app.py wins over FLASK_APP", async () => {
    await writeFile(
      join(tmpDir, "app.py"),
      "from fastapi import FastAPI\n\napp = FastAPI()\n",
    );
    const result = await detectDevCommand(tmpDir, {
      env: { FLASK_APP: "other" },
    });
    expect(result!.source).toBe("app.py (FastAPI)");
  });

  test("prefers the app in the file over declared dependencies", async () => {
    await writeFile(join(tmpDir, "requirements.txt"), "fastapi\nflask\n");
    await writeFile(join(tmpDir, "app.py"), FLASK_APP);
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("app.py (Flask)");
  });

  test("runs a wsgi.py with a __main__ block as a script", async () => {
    await writeFile(
      join(tmpDir, "wsgi.py"),
      `${FLASK_APP}\nif __name__ == "__main__":\n    app.run()\n`,
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({ args: ["python", "wsgi.py"], source: "wsgi.py" });
  });

  test("ignores a wsgi.py that is not Flask", async () => {
    await writeFile(join(tmpDir, "wsgi.py"), "application = make_app()\n");
    const result = await detectDevCommand(tmpDir);
    expect(result).toBeNull();
  });

  test("manage.py still wins over Flask markers", async () => {
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    await writeFile(join(tmpDir, "app.py"), FLASK_APP);
    const result = await detectDevCommand(tmpDir, {
      env: { FLASK_APP: "app" },
    });
    expect(result!.source).toBe("manage.py");
  });
});

describe("detectDevCommand: Python app scanning", () => {
  const PYPROJECT_FASTAPI = '[project]\ndependencies = ["fastapi"]\n';

  beforeEach(async () => {
    await writeFile(join(tmpDir, "pyproject.toml"), PYPROJECT_FASTAPI);
  });

  test.each([
    [
      "an annotated app that is not built",
      "from fastapi import FastAPI\n\napp: FastAPI | None = None\nprint(app)\n",
    ],
    ["an app that is a dict", 'app = {"name": "cli"}\nprint(app)\n'],
    [
      "an app in a docstring",
      '"""Usage:\n\napp = FastAPI()\n"""\nprint("hi")\n',
    ],
    [
      "an app in a single-quoted docstring",
      "'''\napp = FastAPI()\n'''\nprint('hi')\n",
    ],
    ["an app in a comment", "# app = FastAPI()\nprint('hi')\n"],
    [
      "an app compared, not assigned",
      "app = None\nif app == FastAPI():\n    pass\n",
    ],
  ])("runs %s as a script", async (_name, source) => {
    await writeFile(join(tmpDir, "main.py"), source);
    const result = await detectDevCommand(tmpDir);
    expect(result?.args).toEqual(["python", "main.py"]);
  });

  test("finds an app after a docstring that mentions one", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      '"""Run app = Flask() elsewhere."""\nfrom fastapi import FastAPI\n\napi = FastAPI(title="x")\n',
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([
      "python",
      "-m",
      "uvicorn",
      "main:api",
      "--reload",
    ]);
  });

  test("serves a FastAPI create_app factory with --factory", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      "from fastapi import FastAPI\n\ndef create_app():\n    api = FastAPI()\n    return api\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({
      args: [
        "python",
        "-m",
        "uvicorn",
        "main:create_app",
        "--factory",
        "--reload",
      ],
      source: "main.py (FastAPI)",
    });
  });

  test.each([
    ["a one-line factory", "def create_app(): return Flask(__name__)\n"],
    [
      "a factory with a multi-line signature",
      "def create_app(\n    config=None,\n):\n    return Flask(__name__)\n",
    ],
  ])("finds the framework in %s", async (_name, source) => {
    await writeFile(join(tmpDir, "pyproject.toml"), "[project]\n");
    await writeFile(
      join(tmpDir, "app.py"),
      `from flask import Flask\n\n${source}`,
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([
      "python",
      "-m",
      "flask",
      "--app",
      "app:create_app",
      "run",
    ]);
  });

  test("infers the framework of a local factory assigned to app", async () => {
    await rm(join(tmpDir, "pyproject.toml"));
    await writeFile(
      join(tmpDir, "app.py"),
      "from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n\napp = create_app()\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({
      args: ["python", "-m", "flask", "--app", "app:app", "run"],
      source: "app.py (Flask)",
    });
  });

  test("uses the declared framework for an imported factory", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      "from flask import Flask\nfrom myapp import create_app\n\ndef make_app():\n    return Flask(__name__)\n\napp = create_app()\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.source).toBe("main.py (FastAPI)");
  });

  test("serves a make_app factory from the declared dependency", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      "from myapp.api import build\n\ndef make_app():\n    return build()\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual([
      "python",
      "-m",
      "uvicorn",
      "main:make_app",
      "--factory",
      "--reload",
    ]);
  });

  test("prefers a top-level app over a factory", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      "from fastapi import FastAPI\n\ndef create_app():\n    return FastAPI()\n\napp = create_app()\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toContain("main:app");
    expect(result!.args).not.toContain("--factory");
  });

  test("ignores a factory nested in a class", async () => {
    await writeFile(join(tmpDir, "pyproject.toml"), "[project]\n");
    await writeFile(
      join(tmpDir, "main.py"),
      "class Builder:\n    def create_app(self):\n        return 1\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toEqual({ args: ["python", "main.py"], source: "main.py" });
  });

  test("hints when a file imports a framework but no app is found", async () => {
    await writeFile(
      join(tmpDir, "main.py"),
      "from fastapi import FastAPI\n\napp: FastAPI | None = None\n",
    );
    const result = await detectDevCommand(tmpDir);
    expect(result!.args).toEqual(["python", "main.py"]);
    expect(result!.hint).toContain("local run -- python -m uvicorn main:app");
  });

  test("gives no hint for a plain script", async () => {
    await writeFile(join(tmpDir, "main.py"), "print('hi')\n");
    const result = await detectDevCommand(tmpDir);
    expect(result!.hint).toBeUndefined();
  });
});
