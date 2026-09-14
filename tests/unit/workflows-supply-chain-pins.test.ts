/**
 * Fase 7 supply-chain lock (audit/03 §2.5 SC-2/4/5/6/7/8): every mutable reference that
 * decides what code runs in CI, in the release pipeline or in the shipped container must be
 * immutable — commit SHAs for actions, versions (+ checksums where published) for scanners,
 * `version@sha256` digests for images, exact versions for pip/npm globals, and no `@latest`
 * on the deploy path. This test is the cheap check that review is not.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const workflowDir = path.join(repoRoot, ".github/workflows");
const workflows = fs
  .readdirSync(workflowDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => [f, fs.readFileSync(path.join(workflowDir, f), "utf8")] as const);

test("every third-party action is pinned to a 40-hex commit SHA", () => {
  const offenders: string[] = [];
  for (const [file, text] of workflows) {
    for (const m of text.matchAll(/uses:\s*([^\s#]+)/g)) {
      const ref = m[1];
      if (ref.startsWith("./")) continue; // local composite actions / reusable workflows
      const at = ref.lastIndexOf("@");
      if (at === -1 || !/^[0-9a-f]{40}$/.test(ref.slice(at + 1))) offenders.push(`${file}: ${ref}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("scanner installs are version-pinned and checksum-verified; no curl|bash from a branch", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.doesNotMatch(ci, /download-actionlint\.bash\) latest/);
  assert.doesNotMatch(ci, /raw\.githubusercontent\.com\/rhysd\/actionlint\/main\//);
  assert.doesNotMatch(ci, /gh release download --repo/); // an unversioned (latest) download
  for (const tool of ["gitleaks", "osv-scanner", "actionlint", "oasdiff"]) {
    assert.match(
      ci,
      new RegExp(`${tool}[^\\n]*(checksums|SHA256SUMS)`),
      `${tool} needs a checksum file`
    );
  }
  assert.match(ci, /sha256sum --check --ignore-missing/);
  assert.doesNotMatch(ci, /npm install -g bun\s*$/m);
  assert.doesNotMatch(ci, /iwr bun\.sh\/install\.ps1/);
  const action = read(".github/actions/secret-scan/action.yml");
  assert.match(action, /sha256sum --check --ignore-missing/);
  assert.match(action, /--ratchet --strict/);
});

test("pip installs in workflows pin an exact version", () => {
  const offenders: string[] = [];
  for (const [file, text] of workflows) {
    // `pip install [--user] <pkg>==<version>` — the version may be a literal or a pinned
    // shell variable (`zizmor==$ZIZMOR_VERSION`); a bare package name is the offence.
    for (const m of text.matchAll(/pip install\s+([^#\n]+)/g)) {
      const spec = m[1].trim();
      if (!/==(\d|\$)/.test(spec)) offenders.push(`${file}: pip install ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

/** Every `Dockerfile` under docker/ — discovered, so a new sidecar image cannot escape the pin check. */
function sidecarDockerfiles(dir = "docker"): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sidecarDockerfiles(rel));
    else if (entry.name === "Dockerfile") found.push(rel);
  }
  return found;
}

test("container images used by CI and compose are pinned by version and digest", () => {
  assert.match(
    read(".github/workflows/semgrep.yml"),
    /image: semgrep\/semgrep:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/
  );
  const sidecars = sidecarDockerfiles();
  assert.ok(sidecars.length >= 3, `expected docker/**/Dockerfile sidecars, found ${sidecars}`);
  for (const file of ["Dockerfile", "Dockerfile.bun", ...sidecars]) {
    // comments explain history ("why not npm@latest") — only instructions are judged
    const text = read(file)
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const m of text.matchAll(/^FROM\s+(\S+)/gm)) {
      const image = m[1];
      if (!image.includes("/") && !image.includes(":")) continue; // FROM <stage>
      if (/^(base|builder|runner-base)$/.test(image)) continue;
      assert.match(image, /@sha256:[0-9a-f]{64}$/, `${file}: ${image}`);
    }
    assert.doesNotMatch(text, /@latest/, `${file} must not install anything @latest`);
  }
  for (const file of [
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "contrib/vps/compose.yaml",
    "docker/devin-bridge/compose.yml",
  ]) {
    const text = read(file);
    for (const m of text.matchAll(/^\s*image:\s*(\S+)/gm)) {
      const image = m[1];
      // locally built (omniroute:<tag>, omniroute-devin-bridge:local) / operator-supplied
      if (/^omniroute(-[a-z-]+)?:/.test(image) || image.startsWith("${")) continue;
      assert.match(image, /@sha256:[0-9a-f]{64}$/, `${file}: ${image}`);
    }
  }
});

test("the VPS deploy never installs @latest and verifies the npm package is this repository's", () => {
  const deploy = read(".github/workflows/deploy-vps.yml");
  assert.doesNotMatch(deploy, /omniroute@latest/);
  assert.match(deploy, /npm view "omniroute@\$\{VERSION\}" repository\.url/);
  assert.match(deploy, /lmprado-dz23\/omniroute/);
  assert.match(deploy, /NOT_DEPLOYED/);
  assert.match(deploy, /envs: DEPLOY_VERSION/);
});

test("checkouts in jobs that hold contents: write do not persist the token", () => {
  for (const file of ["wiki-sync.yml", "nightly-release-green.yml"]) {
    const text = read(`.github/workflows/${file}`);
    const checkouts = [
      ...text.matchAll(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n((?:[ \t]+[^\n]*\n)*)/g),
    ];
    assert.ok(checkouts.length > 0, `${file} has a checkout`);
    for (const c of checkouts) {
      assert.match(c[1], /persist-credentials:\s*false/, `${file}: a checkout keeps credentials`);
    }
  }
});
