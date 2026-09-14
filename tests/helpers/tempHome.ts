/**
 * Point the home directory at a temporary folder for the duration of a test.
 *
 * os.homedir() reads HOME on POSIX but USERPROFILE on Windows, so a test that redirects only HOME
 * still reads and writes the real home when it runs on Windows (finding F-9). This sets both,
 * checks that os.homedir() now resolves to `dir`, and returns a function that restores both
 * variables, deleting any that was unset before. If the check fails, the variables are restored
 * before the error is thrown, so a failing setup never leaves the process pointed elsewhere.
 */
import assert from "node:assert/strict";
import os from "node:os";

const HOME_VARIABLES = ["HOME", "USERPROFILE"] as const;

export function redirectHome(dir: string): () => void {
  const saved = HOME_VARIABLES.map((name) => [name, process.env[name]] as const);
  const restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  for (const name of HOME_VARIABLES) process.env[name] = dir;
  const resolved = os.homedir();
  if (resolved !== dir) {
    restore();
    assert.fail(`os.homedir() resolved to ${resolved} instead of the temporary home ${dir}`);
  }
  return restore;
}
