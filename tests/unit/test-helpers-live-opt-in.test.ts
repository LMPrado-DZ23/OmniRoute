/**
 * tests/helpers/liveOptIn.ts decides whether a live test (real upstream traffic, real credentials)
 * may run. Having the credentials in the environment is not enough: the opt-in flag must also be
 * exactly "1", so exporting OMNIROUTE_API_KEY in a shell never turns `npm run test:integration` into
 * a paid run by accident.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LIVE_TESTS_FLAG, liveSkipReason } from "../helpers/liveOptIn.ts";

test("the default opt-in flag is RUN_LIVE_TESTS", () => {
  assert.equal(LIVE_TESTS_FLAG, "RUN_LIVE_TESTS");
});

test("credentials alone do not enable a live test", () => {
  const reason = liveSkipReason({
    requiredEnv: ["OMNIROUTE_API_KEY"],
    env: { OMNIROUTE_API_KEY: "sk-test" },
  });
  assert.equal(typeof reason, "string");
  assert.match(reason as string, /RUN_LIVE_TESTS/);
});

test("the flag must be exactly 1", () => {
  for (const value of ["true", "yes", "0", ""]) {
    const reason = liveSkipReason({
      requiredEnv: ["OMNIROUTE_API_KEY"],
      env: { RUN_LIVE_TESTS: value, OMNIROUTE_API_KEY: "sk-test" },
    });
    assert.equal(typeof reason, "string", `flag value ${JSON.stringify(value)} must not enable`);
  }
});

test("the flag without credentials still skips and names every missing variable", () => {
  const reason = liveSkipReason({
    requiredEnv: ["OMNIROUTE_API_KEY", "OMNIROUTE_URL"],
    env: { RUN_LIVE_TESTS: "1" },
  });
  assert.equal(typeof reason, "string");
  assert.match(reason as string, /OMNIROUTE_API_KEY/);
  assert.match(reason as string, /OMNIROUTE_URL/);
});

test("the flag plus every required variable enables the test", () => {
  assert.equal(
    liveSkipReason({
      requiredEnv: ["OMNIROUTE_API_KEY", "OMNIROUTE_URL"],
      env: { RUN_LIVE_TESTS: "1", OMNIROUTE_API_KEY: "sk-test", OMNIROUTE_URL: "http://x" },
    }),
    undefined
  );
});

test("a suite-specific flag replaces the default flag", () => {
  const env = { RUN_BOUNDARY_LIVE: "1", OMNIROUTE_API_KEY: "sk-test", OMNIROUTE_URL: "http://x" };
  assert.equal(
    liveSkipReason({
      flag: "RUN_BOUNDARY_LIVE",
      requiredEnv: ["OMNIROUTE_API_KEY", "OMNIROUTE_URL"],
      env,
    }),
    undefined
  );
  assert.match(
    liveSkipReason({
      flag: "RUN_BOUNDARY_LIVE",
      requiredEnv: ["OMNIROUTE_API_KEY"],
      env: { RUN_LIVE_TESTS: "1", OMNIROUTE_API_KEY: "sk-test" },
    }) as string,
    /RUN_BOUNDARY_LIVE/
  );
});

test("an empty required variable counts as missing", () => {
  const reason = liveSkipReason({
    requiredEnv: ["OMNIROUTE_API_KEY"],
    env: { RUN_LIVE_TESTS: "1", OMNIROUTE_API_KEY: "" },
  });
  assert.match(reason as string, /OMNIROUTE_API_KEY/);
});

test("reads process.env when no env is passed", () => {
  const saved = { flag: process.env.RUN_LIVE_TESTS, key: process.env.OMNIROUTE_API_KEY };
  try {
    delete process.env.RUN_LIVE_TESTS;
    process.env.OMNIROUTE_API_KEY = "sk-test";
    assert.equal(typeof liveSkipReason({ requiredEnv: ["OMNIROUTE_API_KEY"] }), "string");
  } finally {
    if (saved.flag === undefined) delete process.env.RUN_LIVE_TESTS;
    else process.env.RUN_LIVE_TESTS = saved.flag;
    if (saved.key === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = saved.key;
  }
});
