import { describe, it, expect } from "vitest";
import { _enableTracingAndInstrumentationInConfig } from "../../../../../src/lib/wizard/sveltekit/sdk-setup/svelte-config.js";

describe("_enableTracingAndInstrumentationInConfig", () => {
  it("leaves already correct config unchanged", () => {
    const originalConfig = `export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    experimental: {
      tracing: {
        server: true,
      },
      instrumentation: {
        server: true,
      },
    },
  },
};`;

    const modifiedConfig = _enableTracingAndInstrumentationInConfig(
      originalConfig,
      true,
    );

    expect(modifiedConfig.result).toBe(originalConfig);
  });

  describe("successfully handles", () => {
    it("default config as variable declaration", () => {
      const originalConfig = `/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
  },
};

export default config;
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "/** @type {import('@sveltejs/kit').Config} */
      const config = {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),

          experimental: {
            tracing: {
              server: true,
            },

            instrumentation: {
              server: true,
            },
          },
        },
      };

      export default config;"
    `);
    });

    it("default config named declaration object", () => {
      const originalConfig = `
export default config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default config = {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),

          experimental: {
            tracing: {
              server: true,
            },

            instrumentation: {
              server: true,
            },
          },
        },
      };"
    `);
    });

    it("default config as in-place object", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),

          experimental: {
            tracing: {
              server: true,
            },

            instrumentation: {
              server: true,
            },
          },
        },
      };"
    `);
    });

    it("config with tracing disabled", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        false,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),

          experimental: {
            tracing: {
              server: false,
            },

            instrumentation: {
              server: true,
            },
          },
        },
      };"
    `);
    });

    it("config with pre-existing `kit.experimental` property", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    experimental: {
      remoteFunctions: true,
    }
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            remoteFunctions: true,

            tracing: {
              server: true,
            },

            instrumentation: {
              server: true,
            },
          }
        },
      };"
    `);
    });

    it("config with pre-existing and empty `kit.experimental.tracing` property", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    experimental: {
      remoteFunctions: true,
      tracing: {
      },
    }
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            remoteFunctions: true,

            tracing: {
              server: true,
            },

            instrumentation: {
              server: true,
            },
          }
        },
      };"
    `);
    });

    it("config with pre-existing and empty `kit.experimental.instrumentation` property", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    experimental: {
      remoteFunctions: true,
      tracing: {
      },
      instrumentation: {
      },
    }
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            remoteFunctions: true,
            tracing: {
              server: true,
            },
            instrumentation: {
              server: true,
            },
          }
        },
      };"
    `);
    });

    it("config with pre-existing and filled `kit.experimental.(instrumentation|tracing).server` properties", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    experimental: {
      remoteFunctions: true,
      tracing: {
        server: false,
      },
      instrumentation: {
        server: false,
      },
    }
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            remoteFunctions: true,
            tracing: {
              server: true,
            },
            instrumentation: {
              server: true,
            },
          }
        },
      };"
    `);
    });

    it("config with pre-existing and filled `kit.experimental.(instrumentation|tracing).server` properties with instrumentation disabled", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    experimental: {
      remoteFunctions: true,
      tracing: {
        server: true,
      },
      instrumentation: {
        server: false,
      },
    }
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            remoteFunctions: true,
            tracing: {
              server: true,
            },
            instrumentation: {
              server: true,
            },
          }
        },
      };"
    `);
    });

    it("config with pre-existing and filled `kit.experimental.(instrumentation|tracing).server` properties with tracing disabled", () => {
      const originalConfig = `
export default {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    experimental: {
      remoteFunctions: true,
      tracing: {
        server: false,
      },
      instrumentation: {
        server: true,
      },
    }
  },
};
`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.result).toMatchInlineSnapshot(`
      "export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            remoteFunctions: true,
            tracing: {
              server: true,
            },
            instrumentation: {
              server: true,
            },
          }
        },
      };"
    `);
    });
  });

  describe("gracefully errors if", () => {
    it("config object not found", () => {
      const originalConfig = `console.log('hello')`;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe("Couldn't find the config object");
    });

    it("config is not an object", () => {
      const originalConfig = `
      export default getSvelteConfig();
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe("Couldn't find the config object");
    });

    it("`kit` property is missing", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe("Couldn't find the `kit` property");
    });

    it("`kit` property has unexpected type", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),
      
        kit: getKitConfig(),
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe(
        "`kit` property has unexpected type: CallExpression",
      );
    });

    it("`kit.experimental` property has unexpected type", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: 'hello',
        },
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe(
        "Property `kit.experimental` has unexpected type: StringLiteral",
      );
    });

    it("`kit.experimental.tracing` property has unexpected type", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            tracing: true,
          },
        },
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe(
        "Property `kit.experimental.tracing` has unexpected type: BooleanLiteral",
      );
    });

    it("`kit.experimental.instrumentation` property has unexpected type", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            tracing: {
              server: true,
            },
            instrumentation: 'server',
          },
        },
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe(
        "Property `kit.experimental.instrumentation` has unexpected type: StringLiteral",
      );
    });

    it("`kit.experimental.tracing.server` property has unexpected type", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            tracing: {
              server: !!process.env['ENABLE_TRACING'],
            },
            instrumentation: {
              server: true,
            },
          },
        },
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe(
        "Property `kit.experimental.tracing.server` has unexpected type: UnaryExpression",
      );
    });

    it("`kit.experimental.instrumentation.server` property has unexpected type", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            tracing: {
              server: true,
            },
            instrumentation: {
              server: 'hello',
            },
          },
        },
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe(
        "Property `kit.experimental.instrumentation.server` has unexpected type: StringLiteral",
      );
    });

    it("config parsing fails", () => {
      const originalConfig = `
      export default {
        preprocess: vitePreprocess(),

        kit: {
          adapter: adapter(),
          experimental: {
            tracing: {
              server: true,
            }
            instrumentation: {
              server: 'hello',
            },
          },
        },
      };
      `;

      const modifiedConfig = _enableTracingAndInstrumentationInConfig(
        originalConfig,
        true,
      );

      expect(modifiedConfig.error).toBe("Failed to parse Svelte config");
    });
  });
});
