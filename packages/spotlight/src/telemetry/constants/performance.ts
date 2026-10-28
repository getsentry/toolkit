export const PERFORMANCE_SCORE_PROFILES = {
  profiles: [
    {
      name: "Chrome",
      scoreComponents: [
        {
          measurement: "fcp",
          weight: 0.15,
          p10: 900.0,
          p50: 1600.0,
          optional: false,
        },
        {
          measurement: "lcp",
          weight: 0.3,
          p10: 1200.0,
          p50: 2400.0,
          optional: false,
        },
        {
          measurement: "fid",
          weight: 0.3,
          p10: 100.0,
          p50: 300.0,
          optional: true,
        },
        {
          measurement: "cls",
          weight: 0.15,
          p10: 0.1,
          p50: 0.25,
          optional: false,
        },
        {
          measurement: "ttfb",
          weight: 0.1,
          p10: 200.0,
          p50: 400.0,
          optional: false,
        },
      ],
      condition: {
        op: "eq",
        name: "event.contexts.browser.name",
        value: "Chrome",
      },
    },
    // TODO: Currently not getting browser data in events, so made these comments and sticked to chrome always.
    // {
    //   "name": "Firefox",
    //   "scoreComponents": [
    //     {"measurement": "fcp", "weight": 0.15, "p10": 900.0, "p50": 1600.0, "optional": false},
    //     {"measurement": "lcp", "weight": 0.0, "p10": 1200.0, "p50": 2400.0, "optional": false},
    //     {"measurement": "fid", "weight": 0.30, "p10": 100.0, "p50": 300.0, "optional": true},
    //     {"measurement": "cls", "weight": 0.0, "p10": 0.1, "p50": 0.25, "optional": false},
    //     {"measurement": "ttfb", "weight": 0.10, "p10": 200.0, "p50": 400.0, "optional": false}
    //   ],
    //   "condition": {"op": "eq", "name": "event.contexts.browser.name", "value": "Firefox"}
    // },
    // {
    //   "name": "Safari",
    //   "scoreComponents": [
    //     {"measurement": "fcp", "weight": 0.15, "p10": 900.0, "p50": 1600.0, "optional": false},
    //     {"measurement": "lcp", "weight": 0.0, "p10": 1200.0, "p50": 2400.0, "optional": false},
    //     {"measurement": "fid", "weight": 0.0, "p10": 100.0, "p50": 300.0, "optional": true},
    //     {"measurement": "cls", "weight": 0.0, "p10": 0.1, "p50": 0.25, "optional": false},
    //     {"measurement": "ttfb", "weight": 0.10, "p10": 200.0, "p50": 400.0, "optional": false}
    //   ],
    //   "condition": {"op": "eq", "name": "event.contexts.browser.name", "value": "Safari"}
    // },
    // {
    //   "name": "Edge",
    //   "scoreComponents": [
    //     {"measurement": "fcp", "weight": 0.15, "p10": 900.0, "p50": 1600.0, "optional": false},
    //     {"measurement": "lcp", "weight": 0.30, "p10": 1200.0, "p50": 2400.0, "optional": false},
    //     {"measurement": "fid", "weight": 0.30, "p10": 100.0, "p50": 300.0, "optional": true},
    //     {"measurement": "cls", "weight": 0.15, "p10": 0.1, "p50": 0.25, "optional": false},
    //     {"measurement": "ttfb", "weight": 0.10, "p10": 200.0, "p50": 400.0, "optional": false}
    //   ],
    //   "condition": {"op": "eq", "name": "event.contexts.browser.name", "value": "Edge"}
    // },
    // {
    //   "name": "Opera",
    //   "scoreComponents": [
    //     {"measurement": "fcp", "weight": 0.15, "p10": 900.0, "p50": 1600.0, "optional": false},
    //     {"measurement": "lcp", "weight": 0.30, "p10": 1200.0, "p50": 2400.0, "optional": false},
    //     {"measurement": "fid", "weight": 0.30, "p10": 100.0, "p50": 300.0, "optional": true},
    //     {"measurement": "cls", "weight": 0.15, "p10": 0.1, "p50": 0.25, "optional": false},
    //     {"measurement": "ttfb", "weight": 0.10, "p10": 200.0, "p50": 400.0, "optional": false}
    //   ],
    //   "condition": {"op": "eq", "name": "event.contexts.browser.name", "value": "Opera"}
    // }
  ],
};
