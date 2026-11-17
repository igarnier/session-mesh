// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Invariants of the public CI (.github/workflows/): GitHub-hosted runners only, no secret, a
// read-only token, third-party actions pinned by full commit SHA, `pull_request` and never
// `pull_request_target`, no ignored failure, container images pinned by digest, bounded jobs,
// and the leak check with the public rules only. The release workflow has its own profile and
// tests (tests/release-workflow.test.ts); the checks are in tests/public-ci-workflow-checks.ts.
// No YAML parser is available without a new dependency: the checker reads the text line by line,
// refuses every construct it does not resolve (see UNPARSED), and is shown to reject faults below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, test} from 'node:test';
import {blockOf, jobBlocks, parseLines, stepOf, usesOf} from './public-ci-workflow-lib.ts';
import {checkWorkflow, type Profile} from './public-ci-workflow-checks.ts';
import {gitleaksAvailable} from '../tools/leak-guard/gitleaks.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const PUBLIC_WORKFLOW = 'public-ci.yml';
const DESCRIPTION_WORKFLOW = 'pr-description.yml';
// The site deployment: the `site` profile here, its own rules in tests/site-workflow.test.ts.
const SITE_WORKFLOW = 'site.yml';
// The backport workflow (the one `pull_request_target` workflow: the `backport` profile, tests/backport-workflow.test.ts)
// and the branch policy checks (the `policy` profile, tests/branch-policy.test.ts).
const BACKPORT_WORKFLOW = 'backport.yml';
const POLICY_WORKFLOW = 'branch-policy.yml';
// Checked by tests/release-workflow.test.ts, with its own profile.
const RELEASE_WORKFLOW = 'release.yml';

function workflowFiles(): string[] {
  if (!fs.existsSync(WORKFLOWS)) return [];
  return fs.readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name)).sort();
}

const FAULTY = `name: faulty
on:
  pull_request_target:
  push:
permissions:
  contents: write
jobs:
  build:
    runs-on: [self-hosted, linux]
    permissions: write-all
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4.2.0 # a tag, not a SHA
      - run: echo "\${{ secrets.DEPLOY_KEY }}" "\${{ github.event.pull_request.title }}"
        env:
          MESH_LEAK_PRIVATE_RULES: /etc/rules.private.json
  other:
    runs-on: \${{ matrix.os }}
    timeout-minutes: 90
    permissions: {contents: read, pull-requests: write}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
`;

describe('public CI workflow checker', () => {
  test('rejects each faulty construct of a bad workflow', () => {
    const problems = checkWorkflow(FAULTY);
    const expected: [string, RegExp][] = [
      ['self-hosted runner', /line 9: self-hosted runner/],
      ['runner outside ubuntu-24.04', /runner \$\{\{ matrix\.os \}\} is not ubuntu-24\.04/],
      ['pull_request_target', /line 3: privileged trigger pull_request_target/],
      ['top-level write permission', /line 6: permission contents: write is not read-only/],
      ['write-all on a job', /permission \*: write-all is not read-only/],
      ['inline write permission', /permission pull-requests: write is not read-only/],
      ['action pinned by major tag', /actions\/checkout@v4 not pinned/],
      ['action pinned by full tag', /actions\/setup-node@v4\.2\.0 not pinned/],
      ['secret reference', /line 14: secret reference/],
      ['event text in an expression', /line 14: untrusted event data/],
      ['private leak rules', /private leak rules/],
      ['checkout keeping credentials', /checkout without persist-credentials: false/],
      ['missing timeout', /job build: no timeout-minutes/],
      ['excessive timeout', /job other: timeout-minutes 90/],
    ];
    for (const [label, pattern] of expected) {
      assert.ok(problems.some((problem) => pattern.test(problem)), `${label} not reported:\n${problems.join('\n')}`);
    }
  });

  const GOOD_HEAD = 'on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-24.04\n' +
    '    timeout-minutes: 5\n    steps:\n';
  // Constructs that a comment-stripping, dot-only reading let through, and constructs a YAML
  // parser would resolve (quotes, escapes, anchors), refused since no parser is available.
  const JOB_HEAD = GOOD_HEAD.slice(0, GOOD_HEAD.indexOf('    steps:\n'));
  const JOB_TAIL = '    steps:\n      - run: echo hi\n';
  const PINNED = `actions/checkout@${'a'.repeat(40)}`;
  const BACKSLASH = /line 10: unparsed YAML construct \(backslash outside a block scalar\)/;
  const bypasses: [string, string, RegExp][] = [
    ['event text after a # inside a run block (GitHub substitutes before bash)',
      GOOD_HEAD + '      - run: |\n          echo hello # ${{ github.event.pull_request.title }}\n', /line 11: untrusted event data/],
    ['event text read with brackets',
      GOOD_HEAD + '      - run: echo "${{ github.event[\'pull_request\'][\'title\'] }}"\n', /line 10: untrusted event data/],
    ['the whole secrets context serialised',
      GOOD_HEAD + '      - run: echo "${{ toJSON(secrets) }}"\n', /line 10: secret reference/],
    ['secrets in a condition',
      GOOD_HEAD + '      - run: echo hi\n        if: secrets != null\n', /line 11: secret reference/],
    ['an action in an inline mapping',
      GOOD_HEAD + '      - {uses: actions/setup-node@v4}\n', /line 10: action actions\/setup-node@v4 not pinned/],
    ['the whole github context serialised', GOOD_HEAD + '      - run: echo "${{ toJSON(github) }}"\n',
      /line 10: github context read whole or by a computed index/],
    ['the github context read by a computed index', GOOD_HEAD + '      - run: echo "${{ github[matrix.k] }}"\n',
      /line 10: github context read whole or by a computed index/],
    ['event text with an upper-case context name', GOOD_HEAD + '      - run: echo "${{ GITHUB.EVENT.pull_request.title }}"\n',
      /line 10: untrusted event data/],
    ['secrets with an upper-case context name', GOOD_HEAD + '      - run: echo "${{ Secrets.KEY }}"\n',
      /line 10: secret reference/],
    ['${{ written \\x24{{ in a double-quoted string',
      GOOD_HEAD + '      - name: "\\x24{{ github.event.pull_request.title }}"\n        run: echo hi\n',
      BACKSLASH],
    ['${{ written \\u0024{{ in a double-quoted string',
      GOOD_HEAD + '      - name: "\\u0024{{ github.event.pull_request.title }}"\n        run: echo hi\n',
      BACKSLASH],
    ['${{ split by an escaped line break in a double-quoted string',
      GOOD_HEAD + '      - name: "$\\\n          {{ github.event.pull_request.title }}"\n        run: echo hi\n',
      BACKSLASH],
    ['a quoted uses key', GOOD_HEAD + '      - "uses": actions/checkout@v4\n',
      /line 10: unparsed YAML construct \(quoted key\)/],
    ['a quoted permissions key', JOB_HEAD + '    "permissions": write-all\n' + JOB_TAIL,
      /line 9: unparsed YAML construct \(quoted key\)/],
    ['an escaped pull_request_target key',
      'on:\n  "pull_request\\x5Ftarget":\n' + GOOD_HEAD.slice('on:\n  pull_request:\n'.length) + '      - run: echo hi\n',
      /line 2: unparsed YAML construct/],
    ['an anchor and an alias', GOOD_HEAD + `      - &step {uses: ${PINNED}}\n      - *step\n`,
      /line 10: unparsed YAML construct \(anchor or alias\)/],
    ['persist-credentials outside with:', GOOD_HEAD + `      - uses: ${PINNED}\n        env:\n          persist-credentials: false\n`,
      /line 10: checkout without persist-credentials: false/],
    ['continue-on-error on a step', GOOD_HEAD + '      - run: echo hi\n        continue-on-error: true\n',
      /line 11: continue-on-error/],
    ['continue-on-error on a job', JOB_HEAD + '    continue-on-error: true\n' + JOB_TAIL, /line 9: continue-on-error/],
    ['a container image by tag', JOB_HEAD + '    container: node:24\n' + JOB_TAIL,
      /line 9: image node:24 not pinned by @sha256 digest/],
    ['a container image block by tag', JOB_HEAD + '    container:\n      image: node:24\n' + JOB_TAIL,
      /line 10: image node:24 not pinned by @sha256 digest/],
    ['a service image by tag', JOB_HEAD + '    services:\n      db:\n        image: postgres:17\n' + JOB_TAIL,
      /line 11: image postgres:17 not pinned by @sha256 digest/],
    ['a docker:// action by tag', GOOD_HEAD + '      - uses: docker://alpine:3.20\n',
      /line 10: image docker:\/\/alpine:3\.20 not pinned by @sha256 digest/],
    ['secrets in a folded condition', GOOD_HEAD + '      - run: echo hi\n        if: >-\n          secrets != null\n',
      /line 11: secret reference/],
    ['the token read with brackets', GOOD_HEAD + '      - run: echo "${{ github[\'token\'] }}"\n',
      /line 10: explicit token/],
    ['a docker run of an image by tag', GOOD_HEAD + '      - run: docker run --rm bash:3.2 bash -n install.sh\n',
      /line 10: docker command whose image is not a digest-pinned \*_IMAGE variable/],
    ['a docker pull by tag in a run block', GOOD_HEAD + '      - run: |\n          docker pull -q bash:3.2\n',
      /line 11: docker command whose image is not a digest-pinned \*_IMAGE variable/],
    ['an image variable by tag', GOOD_HEAD + '      - run: docker pull "$TOOL_IMAGE"\n        env:\n          TOOL_IMAGE: bash:3.2\n',
      /line 12: TOOL_IMAGE not pinned by @sha256 digest/],
  ];
  for (const [label, text, pattern] of bypasses) {
    test(`rejects ${label}`, () => {
      const problems = checkWorkflow(text);
      assert.ok(problems.some((problem) => pattern.test(problem)), `not reported:\n${problems.join('\n')}`);
    });
  }

  test('accepts event_name, a pinned inline action, digest-pinned images, continue-on-error: false', () => {
    const digest = `@sha256:${'c'.repeat(64)}`;
    const text = JOB_HEAD + `    container: node${digest}\n    services:\n      db:\n        image: postgres${digest}\n` +
      `    continue-on-error: false\n    steps:\n      - uses: docker://alpine${digest}\n` +
      `      - uses: ${PINNED}\n        with: {persist-credentials: false}\n` +
      `      - {uses: actions/setup-node@${'b'.repeat(40)}}\n      - run: echo "\${{ github.event_name }}"\n`;
    assert.deepEqual(checkWorkflow(text), []);
  });

  test('accepts docker commands through a digest-pinned image variable', () => {
    const text = GOOD_HEAD + `      - run: |\n          docker pull -q "$TOOL_IMAGE"\n          docker run --rm \\\n` +
      `            "\${TOOL_IMAGE}" true\n        env:\n          TOOL_IMAGE: bash:3.2@sha256:${'d'.repeat(64)}\n`;
    assert.deepEqual(checkWorkflow(text), []);
  });

  test('accepts a minimal conforming workflow', () => {
    const good = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-24.04\n` +
      `    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)} # v1\n` +
      `        with:\n          persist-credentials: false\n`;
    assert.deepEqual(checkWorkflow(good), []);
  });
});

describe('the public CI as committed', () => {
  test('only the public workflows exist (no private workflow left)', () => {
    assert.deepEqual(workflowFiles(), [BACKPORT_WORKFLOW, POLICY_WORKFLOW, DESCRIPTION_WORKFLOW, PUBLIC_WORKFLOW, RELEASE_WORKFLOW, SITE_WORKFLOW]);
  });

  for (const name of workflowFiles().filter((file) => file !== RELEASE_WORKFLOW)) {
    const profiles: Record<string, Profile> = {[DESCRIPTION_WORKFLOW]: 'description', [SITE_WORKFLOW]: 'site', [BACKPORT_WORKFLOW]: 'backport',
      [POLICY_WORKFLOW]: 'policy'};
    const profile: Profile = profiles[name] ?? 'public';
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');

    test(`${name} satisfies every invariant`, () => {
      assert.deepEqual(checkWorkflow(text, profile), []);
    });

    if (name !== PUBLIC_WORKFLOW) continue;

    test(`${name} runs on push and pull_request, with a read-only token`, () => {
      const lines = parseLines(text);
      const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
      assert.ok(onIndex >= 0, 'no on: block');
      const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2).map((line) => line.key);
      assert.ok(triggers.includes('push') && triggers.includes('pull_request'), `triggers: ${triggers.join(', ')}`);
      assert.match(text, /^permissions:\n {2}contents: read\n/m);
    });

    // main and the maintenance branches are tested after every push (CONTRIBUTING.md, "Branches and versions").
    test(`${name} also runs on every push to a release/** branch`, () => {
      assert.match(text, /^ {2}push:\n(?: {4}#.*\n)* {4}branches: \[main, "release\/\*\*"\]\n/m);
    });

    test(`${name} gives the Node tests a bash 3.2 (MESH_BASH32), so the installer parse test runs`, () => {
      const frontend = jobBlocks(parseLines(text)).find((job) => job.name === 'frontend');
      assert.ok(frontend, 'no frontend job');
      const raw = frontend.block.map((line) => line.raw);
      const exported = raw.findIndex((line) => line.includes('echo "MESH_BASH32=$wrapper" >> "$GITHUB_ENV"'));
      const nodeTests = raw.findIndex((line) => line.includes('- name: Node tests'));
      assert.ok(exported >= 0 && exported < nodeTests, `MESH_BASH32 at ${exported}, Node tests at ${nodeTests}`);
      assert.ok(raw.some((line) => line.includes('docker run --rm -v "$PWD:$PWD:ro" -w "$PWD" "$BASH32_IMAGE" bash "$@"')));
      assert.match(text, /^ {2}BASH32_IMAGE: bash:3\.2@sha256:[0-9a-f]{64}$/m);
    });

    test(`${name} saves the opam state from main only, before the project build`, () => {
      const guard = "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || " +
        "github.event_name == 'workflow_dispatch') && steps.opam-cache.outputs.cache-hit != 'true'";
      const lines = parseLines(text);
      const save = lines.findIndex((line) => usesOf(line).some((action) => action.startsWith('actions/cache/save@')));
      const trim = lines.findIndex((line) => line.text.includes('opam clean'));
      const deps = lines.findIndex((line) => line.text.includes('--deps-only'));
      const build = lines.findIndex((line) => line.text.includes('bash scripts/bootstrap.sh') && !line.text.includes('--deps-only'));
      assert.ok(deps >= 0 && deps < trim && trim < save && save < build, `order: deps ${deps}, trim ${trim}, save ${save}, build ${build}`);
      for (const step of [trim, save]) {
        const conditions = stepOf(lines, step).filter((line) => line.key === 'if').map((line) => line.text.trim());
        assert.deepEqual(conditions, [guard]);
      }
    });

    // The Node tests that start server.py (MESH_PYTHON) and the demo compiler test (bubblewrap)
    // find what they need in the job that runs them, set up before they run.
    test(`${name} gives the Node tests their Python and a working bubblewrap`, () => {
      const runner = 'node --experimental-strip-types --test --test-concurrency=4 "${files[@]}"';
      const job = jobBlocks(parseLines(text)).find((item) => item.block.some((line) => line.raw.includes(runner)));
      assert.ok(job, 'no job runs the Node test files');
      const body = job.block.map((line) => line.raw).join('\n');
      const at = (needle: string): number => body.indexOf(needle);
      const before = (needle: string, limit: string): void =>
        assert.ok(at(needle) >= 0 && at(needle) < at(limit), `${needle} missing before ${limit} in job ${job.name}`);
      for (const needle of ['actions/setup-python@', 'pip install -r requirements-dev.txt', "python -c 'import aiohttp, cryptography'",
        'MESH_PYTHON=$(command -v python)" >> "$GITHUB_ENV"']) before(needle, runner);
      for (const needle of ['apt-get install -y -q --no-install-recommends bubblewrap apparmor-profiles',
        'apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict', '/usr/bin/bwrap --unshare-all']) {
        before(needle, 'npm test --prefix demo-compiler');
      }
    });

    test(`${name} runs the local suite and the leak check with public rules`, () => {
      for (const needle of ['scripts/bootstrap.sh', 'scripts/test-ptyhost-t41.sh', 'npm run check', 'pytest -q',
        'ruff check', 'node --experimental-strip-types --test', 'tools/leak-guard/cli.ts worktree']) {
        assert.ok(text.includes(needle), `${needle} missing`);
      }
      assert.match(text, /^ {2}MESH_LEAK_PRIVATE_RULES: ""$/m);
    });

    // The Node tests that drive a Chromium skip themselves wherever there is none (the frontend
    // job). Every shard of the browser job has one: it runs its part of them, discovered by the
    // same grep this test applies, and fails rather than skips.
    test(`${name} runs every Node browser test in each Chromium shard, failing rather than skipping`, () => {
      const lines = parseLines(text);
      const at = lines.findIndex((line) => line.key === 'name' && line.value.startsWith('Node browser tests'));
      assert.ok(at >= 0, 'no Node browser tests step');
      const step = stepOf(lines, at);
      assert.deepEqual(step.filter((line) => line.key === 'if'), [], 'the step must run on every shard');
      const body = step.map((line) => line.raw).join('\n');
      for (const needle of ['MESH_REQUIRE_BROWSER=1', 'MESH_PYTHON="$(command -v python)"',
        "grep -lZE 'MESH_CHROMIUM|terminal-browser-lib' -- tests/*.test.ts", 'xargs -0 -r grep -LZ MESH_NATIVE_PTYHOST --',
        'LC_ALL=C sort -z', "mapfile -d '' -t candidates", 'set -o pipefail',
        "grep -qx '# skipped 0'", "grep -Eqx '# pass [1-9][0-9]*'"]) {
        assert.ok(body.includes(needle), `${needle} missing from the step`);
      }
      const tests = fs.readdirSync(path.join(ROOT, 'tests')).filter((file) => file.endsWith('.test.ts'));
      const source = (file: string): string => fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8');
      const needsChromium = tests.filter((file) => /MESH_CHROMIUM|terminal-browser-lib/.test(source(file)));
      assert.ok(needsChromium.length >= 16, `only ${needsChromium.length} Chromium tests found: the discovery grep is broken`);
    });

    test(`${name} runs the native catalog ratchet in the job that builds the native host`, () => {
      const job = jobBlocks(parseLines(text)).find((item) => item.block.some((line) => line.raw.includes('scripts/test-ptyhost-t41.sh')));
      assert.ok(job, 'no job builds the native host');
      const body = job.block.map((line) => line.raw).join('\n');
      for (const needle of ['tests/project-native-catalog-ratchet.test.ts', 'MESH_REQUIRE_NATIVE_PROJECTS=1',
        'MESH_NATIVE_PTYHOST="$(opam var bin)/mesh-ptyhost"', "grep -qx '# skipped 0'"]) {
        assert.ok(body.includes(needle), `${needle} missing from job ${job.name}`);
      }
    });

    // mesh-history is built by the same bootstrap.sh: its protocol test must run against that build,
    // failing rather than skipping, after the build and in the same job.
    test(`${name} runs the History index protocol test against the built mesh-history, failing rather than skipping`, () => {
      const lines = parseLines(text);
      const job = jobBlocks(lines).find((item) => item.block.some((line) => line.raw.includes('scripts/test-ptyhost-t41.sh')));
      assert.ok(job, 'no job builds the native host');
      const body = job.block.map((line) => line.raw).join('\n');
      for (const needle of ['name: History index protocol', 'MESH_HISTORY_CMD="$(opam var bin)/mesh-history"', 'MESH_REQUIRE_NATIVE_HISTORY=1',
        'tests/history-db-protocol.test.ts', "grep -qx '# skipped 0'", "grep -Eqx '# pass [1-9][0-9]*'"]) {
        assert.ok(body.includes(needle), `${needle} missing from job ${job.name}`);
      }
      assert.ok(body.indexOf('bash scripts/bootstrap.sh') < body.indexOf('name: History index protocol'), 'the step runs after the build');
    });
  }
});

describe('the PR description workflow', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, DESCRIPTION_WORKFLOW), 'utf8');
  const jobs = jobBlocks(parseLines(text)).map((item) => item.block.map((line) => line.raw).join('\n'));

  test('the body expression is allowed on the BODY line of this workflow only', () => {
    assert.ok(checkWorkflow(text).some((problem) => /untrusted event data/.test(problem)), 'strict mode refuses it');
    const elsewhere = text + '      - run: echo "${{ github.event.pull_request.body }}"\n';
    assert.ok(checkWorkflow(elsewhere, 'description').some((problem) => /untrusted event data/.test(problem)));
    const title = text.replace('github.event.pull_request.body', 'github.event.pull_request.title');
    assert.ok(checkWorkflow(title, 'description').some((problem) => /untrusted event data/.test(problem)));
  });

  test('triggers on pull_request only, with the four types and a read-only token', () => {
    assert.match(text, /^on:\n {2}pull_request:\n {4}types: \[opened, edited, reopened, synchronize\]\n/m);
    assert.match(text, /^permissions:\n {2}contents: read\n/m);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /pull_request_target|workflow_run|pull-requests|issues:/);
  });

  test('has one job with the exact check name', () => {
    assert.equal(jobs.length, 1);
    assert.match(jobs[0], /^ {4}name: PR description \(no personal details\)$/m);
  });

  test('hands the body over in the environment and writes it with printf, never in script text', () => {
    const body = jobs[0];
    assert.match(body, /^ {10}BODY: \$\{\{ github\.event\.pull_request\.body \}\}$/m);
    assert.ok(body.includes('printf \'%s\' "$BODY" > "$RUNNER_TEMP/pr-body.md"'));
    assert.doesNotMatch(body.split(/^ {8}run: \|\n/m).slice(-1)[0], /\$\{\{/);
    assert.ok(body.includes('cli.ts pr-body "$RUNNER_TEMP/pr-body.md"'));
    assert.doesNotMatch(body, /--private/);
  });

  // Warning mode is explicit: the step captures the tool status, exits 0 on findings (status 1) and
  // fails on a tool error (status 2 or more, secrets not checked, status 1 without a finding line),
  // instead of hiding a failure with continue-on-error.
  test('warning mode is explicit: status captured, findings exit 0, tool errors fail, no continue-on-error', () => {
    const body = jobs[0];
    assert.doesNotMatch(body, /continue-on-error/);
    for (const needle of ['warn_only=true', '|| status=$?', 'cat "$RUNNER_TEMP/report.txt"',
      'if [[ "$status" -ne 0 && "$status" -ne 1 ]]; then', 'exit "$status"', "grep -q 'secrets were NOT checked'",
      "if ! grep -q '^<pr-body>'",
      '::warning title=PR description::', '>> "$GITHUB_STEP_SUMMARY"', '.github/pull_request_template.md',
      'if [[ "$warn_only" == true ]]; then']) assert.ok(body.includes(needle), `${needle} missing`);
  });

  // Runs the step script with `node` replaced by `node` (default: this Node) and extra environment.
  function withStep(check: (run: (bodyText: string, node?: string, env?: NodeJS.ProcessEnv) =>
    {status: number | null; out: string; summary: string}, dir: string) => void): void {
    const body = jobs[0];
    const script = body.slice(body.indexOf('          warn_only=true')).replace(/^ {10}/gm, '');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-desc-'));
    try {
      check((bodyText, node = process.execPath, env = {}) => {
        const summary = path.join(dir, 'summary.md');
        fs.writeFileSync(summary, '');
        const bin = path.join(dir, 'fakebin');
        fs.rmSync(bin, {recursive: true, force: true});
        fs.mkdirSync(bin);
        fs.symlinkSync(node, path.join(bin, 'node'));
        const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {cwd: ROOT, encoding: 'utf8',
          env: {...process.env, PATH: `${bin}:${process.env.PATH}`, BODY: bodyText, RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: summary, MESH_LEAK_PRIVATE_RULES: '', ...env}});
        return {status: result.status, out: result.stdout, summary: fs.readFileSync(summary, 'utf8')};
      }, dir);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }

  test('the step script behaves: clean and empty pass, a finding warns with exit 0, a tool failure fails',
    {skip: gitleaksAvailable() ? false : 'gitleaks is not installed'}, () => {
      withStep((run, dir) => {
        assert.equal(run('').status, 0);
        const clean = run('## What\n\nA clean description.');
        assert.equal(clean.status, 0, clean.out);
        assert.match(clean.out, /^leak-guard pr-body: 0 finding\(s\)$/m, 'the report is printed');
        const leaky = run('## What\n\nSee /ho' + 'me/zed/projects');
        assert.equal(leaky.status, 0, leaky.out);
        assert.match(leaky.out, /^leak-guard pr-body: 1 finding\(s\)$/m, 'the report is printed');
        assert.match(leaky.out, /^::warning title=PR description::<pr-body>:3 /m);
        assert.match(leaky.summary, /pull_request_template\.md/);
        const broken = path.join(dir, 'broken-node');
        fs.writeFileSync(broken, '#!/bin/sh\nexit 2\n', {mode: 0o755});
        assert.equal(run('text', broken).status, 2);
      });
    });

  test('the step script fails when secrets were not checked, or on exit 1 without a finding line', () => {
    withStep((run, dir) => {
      for (const bodyText of ['## What\n\nA clean description.', '## What\n\nSee /ho' + 'me/zed/projects']) {
        const unchecked = run(bodyText, process.execPath, {MESH_LEAK_GITLEAKS: path.join(dir, 'no-gitleaks')});
        assert.equal(unchecked.status, 2, unchecked.out);
        assert.match(unchecked.out, /^warning: gitleaks not found .*: secrets were NOT checked$/m, 'the report is printed');
        assert.match(unchecked.out, /could not check secrets: tool failure/);
      }
      const silent = path.join(dir, 'silent-node');
      fs.writeFileSync(silent, '#!/bin/sh\necho "leak-guard pr-body: 1 finding(s)"\nexit 1\n', {mode: 0o755});
      const noFinding = run('text', silent);
      assert.equal(noFinding.status, 2, noFinding.out);
      assert.match(noFinding.out, /exited 1 without any finding line: tool failure/);
      assert.doesNotMatch(noFinding.out, /::warning/);
    });
  });
});
