// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Invariants of the release workflow (.github/workflows/release.yml): every rule of the public CI
// (pinned actions, no secret, no event text in expressions, no ignored failure, ...) plus its own:
// triggers limited to `v*` tag pushes and manual runs without inputs (dry runs), runners from an
// allowlist (the matrix resolved) and never a self-hosted one, write permissions (`contents`,
// `id-token`, `attestations`: release and attestation) in the publish job only, a 90-minute cap for
// the build jobs only, docker only with the Alpine and manylinux_2_28 builders pinned by digest, the
// static check of the Linux programs, the link and deployment-target checks of the macOS ones and the
// floor checks of the bundles (one definition of the floors, install.sh), GitHub's own actions
// only (named exceptions in the build jobs, never in the write job), the run's token named once,
// for the gh CLI, a write job that runs for tag pushes only, runs no repository code, creates no tag
// and publishes (not a draft) on the pushed tag, a tag job that refuses a tag outside main, no
// signature file, one tag pattern. The checks are in tests/release-workflow-checks.ts; the scripts
// of the workflow are run in tests/release-workflow-scripts.test.ts. A release publishes the native
// programs (static on Linux), the code archive and the bundles, every one built and qualified by a
// job of the same run; every job is required but the macOS bundle's, without which a release is
// published with its other files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {blockOf, jobBlocks, parseLines, scriptOf, usesOf} from './public-ci-workflow-lib.ts';
import {checkWorkflow} from './public-ci-workflow-checks.ts';
import {MAX_BUILD_TIMEOUT_MINUTES, RELEASE_BUILD_JOBS, RELEASE_OTHER_ACTIONS, RELEASE_PACKAGE_CONDITION, RELEASE_RUNNERS,
  RELEASE_WRITE_CONDITION, RELEASE_WRITE_JOB, RELEASE_WRITE_SCOPES} from './release-workflow-checks.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE = path.join(ROOT, '.github', 'workflows', 'release.yml');
const DIGEST = `alpine@sha256:${'d'.repeat(64)}`;
const MANYLINUX_X86 = `quay.io/pypa/manylinux_2_28_x86_64@sha256:${'e'.repeat(64)}`;
const MANYLINUX_ARM = `quay.io/pypa/manylinux_2_28_aarch64@sha256:${'f'.repeat(64)}`;
const CHECKOUT = `actions/checkout@${'a'.repeat(40)}`;

// A minimal workflow that satisfies the release profile; the faults below are edits of it.
const GOOD = `name: release
on:
  push:
    tags: ["v*"]
  workflow_dispatch:
permissions:
  contents: read
env:
  ALPINE_IMAGE: ${DIGEST}
jobs:
  tag:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - run: |
          git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
          git merge-base --is-ancestor "$commit" refs/remotes/origin/main
          git fetch --no-tags origin "+refs/heads/release/$series:refs/remotes/origin/release/$series"
          git merge-base --is-ancestor "$commit" "refs/remotes/origin/release/$series"
  linux:
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 90
    strategy:
      matrix:
        include:
          - target: linux-x86_64
            runner: ubuntu-24.04
          - target: linux-aarch64
            runner: ubuntu-24.04-arm
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - run: docker run --rm "$ALPINE_IMAGE" true
      - run: |
          [[ "$info" == *"statically linked"* ]]
          [[ "$(LC_ALL=C ldd "$RUNNER_TEMP/out/$program" 2>&1 || true)" == *"not a dynamic executable"* ]]
      - run: bash scripts/release-smoke.sh "$RUNNER_TEMP/out"
  macos:
    runs-on: macos-15
    timeout-minutes: 90
    env:
      MACOSX_DEPLOYMENT_TARGET: "13.0"
    steps:
      - run: test "$MACOSX_DEPLOYMENT_TARGET" = "$(bash scripts/release-floor.sh macos-programs)"
      - run: bash scripts/release-check-macos.sh links "$RUNNER_TEMP/out/mesh-ptyhost"
      - run: bash scripts/release-check-macos.sh linker-log "$RUNNER_TEMP/build.log"
      - run: opam exec -- bash scripts/release-check-macos.sh runtime-minos "$MACOSX_DEPLOYMENT_TARGET"
      - run: bash scripts/release-smoke.sh "$RUNNER_TEMP/out"
  linux-bundle:
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 90
    strategy:
      matrix:
        include:
          - target: linux-x86_64
            runner: ubuntu-22.04
            image: ${MANYLINUX_X86}
          - target: linux-arm64
            runner: ubuntu-22.04-arm
            image: ${MANYLINUX_ARM}
    env:
      MANYLINUX_IMAGE: \${{ matrix.image }}
    steps:
      - run: |
          docker run --rm \\
            "$MANYLINUX_IMAGE" \\
            bash /src/scripts/release-build-bundle-linux.sh /src /out /src/.bundle-roster
      - run: bash scripts/release-check-glibc.sh "$RUNNER_TEMP/out/mesh-$TARGET.tar.gz"
      - run: |
          docker run --rm "$MANYLINUX_IMAGE" \\
            bash -c 'dnf install -y -q git-core >/dev/null && exec bash /src/scripts/smoke-bundle.sh "$0"' "/out/mesh-$TARGET.tar.gz"
      - run: bash scripts/smoke-bundle.sh "$RUNNER_TEMP/out/mesh-$TARGET.tar.gz"
      - run: node "$work/mesh-$TARGET/app/demo-compiler/test-compiler.mjs"
  macos-bundle:
    runs-on: macos-15
    timeout-minutes: 90
    steps:
      - run: bash scripts/release-check-macos.sh bundle "$RUNNER_TEMP/out/mesh-$TARGET.tar.gz" "$(bash scripts/release-floor.sh macos-bundle)"
      - run: bash scripts/smoke-bundle.sh "$RUNNER_TEMP/out/mesh-$TARGET.tar.gz"
      - run: echo hi
  package:
    needs: [tag, linux, macos, linux-bundle, macos-bundle]
    if: ${RELEASE_PACKAGE_CONDITION}
    runs-on: ubuntu-24.04
    timeout-minutes: 9
    steps:
      - run: echo package
  publish:
    needs: [tag, package]
    if: ${RELEASE_WRITE_CONDITION}
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      contents: write
    steps:
      - run: |
          [[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]
      - name: Publish the release
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release create "$RELEASE_TAG" --verify-tag -- dist/*
`;

function problemsOf(text: string): string {
  return checkWorkflow(text, 'release').join('\n');
}

const FETCH_MAIN = '          git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main\n';
const MERGE_BASE = '          git merge-base --is-ancestor "$commit" refs/remotes/origin/main\n';
const FETCH_RELEASE = '          git fetch --no-tags origin "+refs/heads/release/$series:refs/remotes/origin/release/$series"\n';
const MERGE_BASE_RELEASE = '          git merge-base --is-ancestor "$commit" "refs/remotes/origin/release/$series"\n';
const MACOS_BUNDLE = '  macos-bundle:\n    runs-on: macos-15\n    timeout-minutes: 90\n    steps';
const LINUX_SMOKE = '      - run: bash scripts/release-smoke.sh "$RUNNER_TEMP/out"\n  macos:';

describe('the release workflow checker', () => {
  test('accepts a conforming workflow', () => {
    assert.deepEqual(checkWorkflow(GOOD, 'release'), []);
  });

  const faults: [string, string, string, RegExp][] = [
    ['a pull_request trigger', 'on:\n  push:', 'on:\n  pull_request:\n  push:', /triggers are pull_request, push, workflow_dispatch/],
    ['a branch push', '    tags: ["v*"]', '    branches: [main]', /push must be limited to tags/],
    ['a tag filter other than v*', '    tags: ["v*"]', '    tags: ["*"]', /push must be limited to tags/],
    ['a tag filter next to a branch filter', '    tags: ["v*"]', '    tags: ["v*"]\n    branches: [main]', /push must be limited to tags/],
    ['a schedule', '  workflow_dispatch:', '  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"', /triggers are push, schedule, workflow_dispatch/],
    ['a privileged trigger', '  workflow_dispatch:', '  workflow_dispatch:\n  workflow_run:', /privileged trigger workflow_run/],
    ['a manual run with inputs', '  workflow_dispatch:\n', '  workflow_dispatch:\n    inputs:\n      tag:\n        type: string\n',
      /workflow_dispatch must take no inputs/],
    ['a step reading an input', '      - run: echo hi\n  package', '      - run: echo "$TAG"\n        env:\n          TAG: ${{ inputs.tag }}\n  package',
      /the workflow reads inputs/],
    ['a write permission in a build job', MACOS_BUNDLE, MACOS_BUNDLE.replace('    steps', '    permissions:\n      contents: write\n    steps'),
      /permission contents: write is not allowed here/],
    ['a write permission at the top level', 'permissions:\n  contents: read', 'permissions:\n  contents: write',
      /permission contents: write is not allowed here/],
    ['a second write scope in the publish job', '      contents: write', '      contents: write\n      packages: write',
      /permission packages: write is not allowed here/],
    ['id-token: write outside the publish job', MACOS_BUNDLE, MACOS_BUNDLE.replace('    steps', '    permissions:\n      id-token: write\n    steps'),
      /permission id-token: write is not allowed here/],
    ['attestations: write at the top level', 'permissions:\n  contents: read', 'permissions:\n  contents: read\n  attestations: write',
      /permission attestations: write is not allowed here/],
    ['write-all', '    permissions:\n      contents: write', '    permissions: write-all', /permission \*: write-all is not allowed here/],
    ['a runner outside the allowlist', MACOS_BUNDLE, MACOS_BUNDLE.replace('macos-15', 'macos-13'), /runner macos-13 is not one of/],
    ['a Linux bundle on a newer glibc than the baseline', 'runner: ubuntu-22.04-arm', 'runner: ubuntu-26.04-arm', /runner ubuntu-26\.04-arm is not one of/],
    ['a self-hosted runner', MACOS_BUNDLE, MACOS_BUNDLE.replace('macos-15', '[self-hosted, macos]'), /self-hosted/],
    ['a qualification label in an expression', '      - run: echo hi\n  package', '      - run: echo "${{ matrix.x || \'session-mesh-qual\' }}"\n  package',
      /self-hosted runner or qualification label in the release workflow/],
    ['a matrix runner outside the allowlist', 'runner: ubuntu-22.04-arm', 'runner: windows-latest', /runner windows-latest is not one of/],
    ['a matrix reference that resolves to no value', 'runs-on: ${{ matrix.runner }}', 'runs-on: ${{ matrix.missing }}',
      /runs-on \$\{\{ matrix\.missing \}\} resolves to no runner/],
    ['no timeout on a job', '    timeout-minutes: 10\n', '', /job publish: no timeout-minutes/],
    ['a build timeout above the build cap', '    timeout-minutes: 90\n    strategy', `    timeout-minutes: ${MAX_BUILD_TIMEOUT_MINUTES + 1}\n    strategy`,
      /job linux: timeout-minutes 91 outside/],
    ['the build cap on the publish job', '    timeout-minutes: 10', '    timeout-minutes: 90', /job publish: timeout-minutes 90 outside 1\.\.45/],
    ['an Alpine tag instead of a digest', `ALPINE_IMAGE: ${DIGEST}`, 'ALPINE_IMAGE: alpine:3.20', /ALPINE_IMAGE must be declared once, as alpine@sha256/],
    ['an Alpine image named in a step', 'docker run --rm "$ALPINE_IMAGE" true', 'docker run --rm alpine:3.20 true',
      /build image named outside ALPINE_IMAGE|docker command that does not use the image variable of its job/],
    ['a docker command that skips ALPINE_IMAGE', 'docker run --rm "$ALPINE_IMAGE" true', 'docker run --rm ubuntu true',
      /docker command that does not use the image variable of its job/],
    ['a docker build in a bundle job', 'run: bash scripts/smoke-bundle.sh "$RUNNER_TEMP/out/mesh-$TARGET.tar.gz"\n      - run: echo hi',
      'run: docker build -t x .\n      - run: echo hi', /docker command that does not use the image variable of its job/],
    ['the manylinux image in the static job', 'docker run --rm "$ALPINE_IMAGE" true', 'docker run --rm "$MANYLINUX_IMAGE" true',
      /docker command that does not use the image variable of its job/],
    ['a manylinux image by tag', `image: ${MANYLINUX_X86}`, 'image: quay.io/pypa/manylinux_2_28_x86_64:latest',
      /image of linux-x86_64 is not its manylinux_2_28 image pinned by digest/],
    ['a newer manylinux than 2_28', `image: ${MANYLINUX_ARM}`, `image: quay.io/pypa/manylinux_2_34_aarch64@sha256:${'f'.repeat(64)}`,
      /image of linux-arm64 is not its manylinux_2_28 image pinned by digest/],
    ['the images of the two architectures swapped', `image: ${MANYLINUX_X86}`, `image: ${MANYLINUX_ARM}`,
      /image of linux-x86_64 is not its manylinux_2_28 image pinned by digest/],
    ['MANYLINUX_IMAGE declared outside the matrix', 'MANYLINUX_IMAGE: ${{ matrix.image }}', `MANYLINUX_IMAGE: ${MANYLINUX_X86}`,
      /MANYLINUX_IMAGE must be declared once, in the env of the linux-bundle job/],
    ['a manylinux image named in a step', 'docker run --rm "$MANYLINUX_IMAGE" \\\n            bash -c', `docker run --rm ${MANYLINUX_X86} \\\n            bash -c`,
      /build image named outside ALPINE_IMAGE and the linux-bundle matrix/],
    ['no glibc check of the Linux bundles', 'bash scripts/release-check-glibc.sh', 'true', /job linux-bundle: lacks the check .*release-check-glibc/],
    ['no smoke test in the build image', 'exec bash /src/scripts/smoke-bundle.sh "$0"', 'true', /job linux-bundle: lacks the check .*smoke-bundle/],
    ['no demo compiler test of the Linux bundles', 'app/demo-compiler/test-compiler.mjs"', 'x"', /job linux-bundle: lacks the check .*test-compiler/],
    ['the macOS bundle checked against a written target', '"$(bash scripts/release-floor.sh macos-bundle)"', '"13.5"',
      /job macos-bundle: lacks the check .*release-floor/],
    ['a deployment target not compared with the floor', '      - run: test "$MACOSX_DEPLOYMENT_TARGET" = "$(bash scripts/release-floor.sh macos-programs)"\n', '',
      /job macos: lacks the check .*release-floor/],
    ['a package job that requires the macOS bundle', `    if: ${RELEASE_PACKAGE_CONDITION}`,
      `    if: ${RELEASE_PACKAGE_CONDITION.replace(' && !cancelled()', " && needs.macos-bundle.result == 'success' && !cancelled()")}`,
      /job package: if: must be exactly/],
    ['a package job that goes without a Linux bundle', `    if: ${RELEASE_PACKAGE_CONDITION}`,
      `    if: ${RELEASE_PACKAGE_CONDITION.replace("needs.linux-bundle.result == 'success' && ", '')}`, /job package: if: must be exactly/],
    ['a package job that does not wait for every build', '    needs: [tag, linux, macos, linux-bundle, macos-bundle]', '    needs: [tag, linux, macos, linux-bundle]',
      /job package: needs must be exactly/],
    ['a build job that runs after a failure', '  macos-bundle:\n    runs-on: macos-15', '  macos-bundle:\n    if: always()\n    runs-on: macos-15',
      /job macos-bundle: a status function in its if:/],
    ['a write job that ignores the package result', `    if: ${RELEASE_WRITE_CONDITION}`,
      "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')", /job publish: if: must be exactly/],
    ['no static check of the Linux programs', '          [[ "$info" == *"statically linked"* ]]\n', '', /job linux: lacks the check .*statically linked/],
    ['no ldd check of the Linux programs', '          [[ "$(LC_ALL=C ldd', '          [[ "$(LC_ALL=C file', /job linux: lacks the check .*not a dynamic executable/],
    ['no smoke check of the Linux programs', LINUX_SMOKE, '  macos:', /job linux: lacks the check .*release-smoke/],
    ['no link check of the macOS programs', 'release-check-macos.sh links', 'release-check-macos.sh list', /job macos: lacks the check .*links/],
    ['no linker-log check of the macOS programs', 'bash scripts/release-check-macos.sh linker-log', 'true', /job macos: lacks the check .*linker-log/],
    ['no runtime check of the macOS programs', 'runtime-minos "$MACOSX_DEPLOYMENT_TARGET"', 'runtime-minos 99', /job macos: lacks the check .*runtime-minos/],
    ['no deployment target for the macOS programs', '      MACOSX_DEPLOYMENT_TARGET: "13.0"\n', '      OTHER: "13.0"\n', /job macos: lacks the check .*MACOSX_DEPLOYMENT_TARGET/],
    ['an unpinned action', `uses: ${CHECKOUT}`, 'uses: actions/checkout@v4', /actions\/checkout@v4 not pinned/],
    ['a secret', '      - run: echo hi\n  package', '      - run: echo "${{ secrets.TOKEN }}"\n  publish', /secret reference/],
    ['a third-party action in the write job', '      - name: Publish', `      - uses: softprops/action-gh-release@${'b'.repeat(40)}\n      - name: Publish`,
      /action softprops\/action-gh-release is not allowed in job publish/],
    ['an allowed exception in the write job', '      - name: Publish', `      - uses: ocaml/setup-ocaml@${'b'.repeat(40)}\n      - name: Publish`,
      /action ocaml\/setup-ocaml is not allowed in job publish/],
    ['an allowed exception outside its build jobs', '    timeout-minutes: 5\n    steps:\n', `    timeout-minutes: 5\n    steps:\n      - uses: astral-sh/setup-uv@${'b'.repeat(40)}\n`,
      /action astral-sh\/setup-uv is not allowed in job tag/],
    ['setup-uv in a native programs job', LINUX_SMOKE, `${LINUX_SMOKE.replace('  macos:', '')}      - uses: astral-sh/setup-uv@${'b'.repeat(40)}\n  macos:`,
      /action astral-sh\/setup-uv is not allowed in job linux/],
    ['a third-party action in a build job', '      - run: echo hi\n  package', `      - uses: someone/tool@${'b'.repeat(40)}\n  publish`,
      /action someone\/tool is not allowed in job macos-bundle/],
    ['the token given to an action', '        run: gh release create', `        uses: actions/github-script@${'b'.repeat(40)}\n        with:\n          x: 1\n        run: gh release create`,
      /explicit token/],
    ['the token in a build job', '      - run: echo hi\n  package', '      - env:\n          GH_TOKEN: ${{ github.token }}\n        run: echo hi\n  package',
      /explicit token/],
    ['the token in a script', '--verify-tag --', '--verify-tag "${{ github.token }}" --', /explicit token/],
    ['a restore-keys fallback', '      - run: docker run', `      - uses: actions/cache/restore@${'b'.repeat(40)}\n        with:\n          key: k\n          restore-keys: |\n            k-\n      - run: docker run`,
      /restore-keys/],
    ['a checkout in the write job', '    steps:\n      - run: |\n          [[ "$RELEASE', `    steps:\n      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n      - run: |\n          [[ "$RELEASE`,
      /checkout in the write job/],
    ['a repository script in the write job', '    steps:\n      - run: |\n          [[ "$RELEASE', '    steps:\n      - run: bash scripts/release-assets.sh bundle\n      - run: |\n          [[ "$RELEASE',
      /repository script run in the write job/],
    ['a tag created by the write job', '      - name: Publish', '      - run: gh api "repos/$GH_REPO/git/refs" -f ref=x\n      - name: Publish',
      /the write job creates a git ref/],
    ['a draft release', '--verify-tag --', '--draft --verify-tag --', /must publish \(no --draft\) with --verify-tag/],
    ['a release without --verify-tag', '--verify-tag --', '--target "$GITHUB_SHA" --', /must publish \(no --draft\) with --verify-tag/],
    ['a release created outside the write job', '      - run: echo hi\n  package', '      - run: gh release create v1 --verify-tag\n  package',
      /gh release create outside the write job/],
    ['a write job that also runs on a manual run', `    if: ${RELEASE_WRITE_CONDITION}`,
      `    if: (${RELEASE_WRITE_CONDITION}) || github.event_name == 'workflow_dispatch'`, /job publish: if: must be exactly/],
    ['a write job without a condition', `    if: ${RELEASE_WRITE_CONDITION}\n`, '', /job publish: if: must be exactly/],
    ['a write job that does not wait for the tag job', '    needs: [tag, package]', '    needs: [package]', /job publish: needs must be exactly \[tag, package\]/],
    ['no main check in the tag job', MERGE_BASE, '', /job tag: no check that the tag names a commit of main/],
    ['a main check without fetching main', FETCH_MAIN, '', /job tag: no check that the tag names a commit of main/],
    ['no release branch check in the tag job', MERGE_BASE_RELEASE, '', /job tag: no check that the tag names a commit of its release branch/],
    ['a release branch check without fetching it', FETCH_RELEASE, '', /job tag: no check that the tag names a commit of its release branch/],
    ['a signature file', '-- dist/*', '-- dist/* dist/SHA256SUMS.sig', /signature file or SSH signing/],
    ['SSH signing', '      - run: echo hi\n  package', '      - run: ssh-keygen -Y sign -n x SHA256SUMS\n  publish', /signature file or SSH signing/],
    ['a looser tag pattern', '=~ ^v[0-9]+', '=~ ^v[0-9]', /tag pattern other than/],
  ];
  for (const [label, from, to, pattern] of faults) {
    test(`rejects ${label}`, () => {
      assert.ok(GOOD.includes(from), `fixture lacks ${JSON.stringify(from)}`);
      const problems = problemsOf(GOOD.replace(from, to));
      assert.match(problems, pattern);
    });
  }

  test('rejects a missing push trigger and an absent on: block', () => {
    assert.match(problemsOf(GOOD.replace(/on:\n {2}push:\n {4}tags: \["v\*"\]\n/, 'on:\n')), /triggers are workflow_dispatch/);
    assert.match(problemsOf(GOOD.replace(/on:\n[\s\S]*?permissions:/, 'permissions:')), /no on: block/);
  });
});

describe('release.yml as committed', () => {
  const text = fs.readFileSync(RELEASE, 'utf8');
  const lines = parseLines(text);
  const jobs = jobBlocks(lines);
  const job = (name: string) => jobs.find((item) => item.name === name)?.block ?? [];
  const raw = (name: string) => job(name).map((line) => line.raw).join('\n');
  const at = (name: string, pattern: RegExp) => lines.findIndex((line) => job(name).includes(line) && pattern.test(line.raw));
  const inOrder = (indexes: number[]) => {
    assert.ok(indexes.every((index) => index >= 0), `missing step: ${indexes}`);
    assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, 'the steps run in this order');
  };

  test('satisfies every invariant of the release profile', () => {
    assert.deepEqual(checkWorkflow(text, 'release'), []);
  });

  test('the public profile would refuse it (the profile is what admits it)', () => {
    assert.ok(checkWorkflow(text, 'public').length > 0);
  });

  test('has the expected jobs, and only publish holds write permissions, exactly three', () => {
    assert.deepEqual(jobs.map((item) => item.name).sort(), ['linux', 'linux-bundle', 'macos', 'macos-bundle', 'package', 'publish', 'tag']);
    const writes = (block: typeof lines) => block.filter((line) => line.indent === 6 && line.value === 'write').map((line) => line.key).sort();
    for (const {name, block} of jobs) {
      assert.deepEqual(writes(block), name === RELEASE_WRITE_JOB ? ['attestations', 'contents', 'id-token'] : [], `job ${name}`);
    }
    assert.deepEqual([...RELEASE_WRITE_SCOPES], ['attestations', 'contents', 'id-token']);
  });

  const publishStep = () => lines.findIndex((line) => line.raw.includes('gh release create'));

  test('attests every released file from a pinned action, in the publish job, before the release exists', () => {
    const attest = lines.findIndex((line) => line.text.includes('actions/attest-build-provenance@'));
    const release = publishStep();
    assert.ok(attest >= 0 && attest < release, `attest at ${attest}, release at ${release}`);
    assert.ok(job(RELEASE_WRITE_JOB).includes(lines[attest]));
    const step = lines.slice(attest - 1, attest + 4).map((line) => line.raw).join('\n');
    assert.match(step, /subject-path: dist\/\*/);
    assert.doesNotMatch(step, /^\s+if:/m, 'the job condition is the only one: every published release is attested');
    assert.match(lines[attest].text, /@[0-9a-f]{40}\b/);
  });

  test('the jobs run on the allowlisted runners, all of them used, never a self-hosted one', () => {
    const matrixRunners = jobs.flatMap(({block}) => block.filter((line) => line.key === 'runner').map((line) => line.value));
    const direct = jobs.map(({block}) => block.find((line) => line.key === 'runs-on')?.value).filter((value) => !value?.includes('matrix'));
    assert.deepEqual([...new Set([...matrixRunners, ...direct])].sort(), [...RELEASE_RUNNERS].sort());
    assert.doesNotMatch(text, /self-hosted|session-mesh-qual/);
  });

  test('only the build jobs have the long timeout', () => {
    for (const {name, block} of jobs) {
      const minutes = Number(block.find((line) => line.key === 'timeout-minutes')?.value);
      assert.equal(minutes > 15, RELEASE_BUILD_JOBS.includes(name), `job ${name}: ${minutes} minutes`);
    }
  });

  test('runs on v* tag pushes and on manual runs without inputs only', () => {
    const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
    const keys = blockOf(lines, onIndex).filter((line) => line.indent === 2).map((line) => line.key);
    assert.deepEqual(keys, ['push', 'workflow_dispatch']);
    assert.match(text, /^ {2}push:\n {4}tags: \["v\*"\]\n {2}workflow_dispatch:\n\n/m);
    assert.doesNotMatch(text, /inputs\./);
  });

  test('the Linux programs: static, in the pinned Alpine image on each architecture, checked and smoke-tested before they are named', () => {
    assert.deepEqual(job('linux').filter((line) => line.key === 'target').map((line) => line.value), ['linux-x86_64', 'linux-aarch64']);
    assert.deepEqual(job('linux').filter((line) => line.key === 'runner').map((line) => line.value), ['ubuntu-24.04', 'ubuntu-24.04-arm']);
    assert.match(lines.find((line) => line.key === 'ALPINE_IMAGE')?.value ?? '', /^alpine@sha256:[0-9a-f]{64}$/);
    inOrder([at('linux', /"\$ALPINE_IMAGE"/), at('linux', /exec bash \/src\/scripts\/release-build-static\.sh \/src \/out/),
      at('linux', /"statically linked"/), at('linux', /not a dynamic executable/), at('linux', /bash scripts\/release-smoke\.sh "\$RUNNER_TEMP\/out"/),
      at('linux', /release-assets\.sh name "\$RUNNER_TEMP\/out" "\$\{\{ matrix\.target \}\}"/), at('linux', /actions\/upload-artifact@/)]);
    assert.match(raw('linux'), /for program in mesh-ptyhost mesh-board-mcp mesh-read mesh-platform mesh-history; do/);
    assert.match(raw('linux'), /name: programs-\$\{\{ matrix\.target \}\}\n/);
  });

  // The macOS job: the build output is kept, then the link and deployment-target checks of
  // scripts/release-check-macos.sh run on what was built, before the smoke check and the upload.
  test('the macOS programs: link and deployment-target checks after the build, before the smoke check and the upload', () => {
    const links = at('macos', /release-check-macos\.sh links\b/);
    inOrder([at('macos', /dune build -p session_mesh @install 2>&1\) \| tee "\$RUNNER_TEMP\/build\.log"/), links,
      at('macos', /release-check-macos\.sh linker-log "\$RUNNER_TEMP\/build\.log"/),
      at('macos', /opam exec -- bash scripts\/release-check-macos\.sh runtime-minos "\$MACOSX_DEPLOYMENT_TARGET"/),
      at('macos', /release-smoke\.sh/), at('macos', /actions\/upload-artifact@/)]);
    const linked = scriptOf(lines, links);
    for (const program of ['mesh-ptyhost', 'mesh-board-mcp', 'mesh-read', 'mesh-platform', 'mesh-history']) {
      assert.match(linked, new RegExp(`"\\$RUNNER_TEMP/out/${program}"`), `links check misses ${program}`);
    }
    assert.equal(job('macos').find((line) => line.key === 'MACOSX_DEPLOYMENT_TARGET')?.value, '13.0');
    assert.match(raw('macos'), /run: test "\$MACOSX_DEPLOYMENT_TARGET" = "\$\(bash scripts\/release-floor\.sh macos-programs\)"/);
    assert.match(job('macos').find((line) => line.key === 'key')?.value ?? '', /^release-opam-macos-arm64-.*\$\{\{ env\.MACOSX_DEPLOYMENT_TARGET \}\}/);
    assert.equal(job('macos').find((line) => line.key === 'runs-on')?.value, 'macos-15');
  });

  // mesh-history carries the pinned SQLite (scripts/build-sqlite.sh): every job that builds it names the
  // prefix, inside the cached state, and its cache key follows the script and its pin.
  test('the jobs that build mesh-history link the pinned SQLite, and their cache keys follow it', () => {
    for (const name of ['macos', 'macos-bundle']) {
      assert.match(job(name).find((line) => line.key === 'MESH_SQLITE_PREFIX')?.value ?? '', /^\$\{\{ github\.workspace \}\}\/_opam\//, name);
    }
    for (const name of ['linux', 'linux-bundle', 'macos', 'macos-bundle']) {
      const key = job(name).find((line) => line.key === 'key' && line.value.includes('release-opam'))?.value ?? '';
      assert.match(key, /'scripts\/build-sqlite\.sh', 'scripts\/bundle\/sqlite\.sha256'/, name);
    }
  });

  // The floors, written once in install.sh, read by scripts/release-floor.sh.
  const floor = (name: string) => {
    const result = spawnSync('bash', [path.join(ROOT, 'scripts', 'release-floor.sh'), name], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  test('the Linux bundles: built in the pinned manylinux_2_28 image, glibc floor checked, smoke-tested on glibc 2.28 and on the runner, then uploaded', () => {
    assert.deepEqual(job('linux-bundle').filter((line) => line.key === 'target').map((line) => line.value), ['linux-x86_64', 'linux-arm64']);
    assert.deepEqual(job('linux-bundle').filter((line) => line.key === 'runner').map((line) => line.value), ['ubuntu-22.04', 'ubuntu-22.04-arm']);
    const images = job('linux-bundle').filter((line) => line.key === 'image').map((line) => line.value);
    assert.match(images[0], /^quay\.io\/pypa\/manylinux_2_28_x86_64@sha256:[0-9a-f]{64}$/);
    assert.match(images[1], /^quay\.io\/pypa\/manylinux_2_28_aarch64@sha256:[0-9a-f]{64}$/);
    assert.equal(floor('glibc'), '2.28', 'the image\'s glibc is the floor of install.sh');
    inOrder([at('linux-bundle', /bash \/src\/scripts\/release-build-bundle-linux\.sh \/src \/out \/src\/\.bundle-roster/),
      at('linux-bundle', /bash scripts\/release-check-glibc\.sh "\$RUNNER_TEMP\/out\/mesh-\$TARGET\.tar\.gz"/),
      at('linux-bundle', /exec bash \/src\/scripts\/smoke-bundle\.sh "\$0"/),
      at('linux-bundle', /run: bash scripts\/smoke-bundle\.sh "\$RUNNER_TEMP\/out\/mesh-\$TARGET\.tar\.gz"/),
      at('linux-bundle', /demo-compiler\/test-compiler\.mjs/), at('linux-bundle', /actions\/upload-artifact@/)]);
    assert.match(raw('linux-bundle'), /-e PYTHON_VERSION -e OCAML_COMPILER -e GITHUB_SERVER_URL -e GITHUB_REPOSITORY/);
    assert.doesNotMatch(raw('linux-bundle'), /setup-ocaml|setup-uv|setup-node/, 'the tools come from the image and pinned files');
    assert.match(raw('linux-bundle'), /name: bundle-\$\{\{ matrix\.target \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/out\/mesh-\$\{\{ matrix\.target \}\}\.tar\.gz\n\s+if-no-files-found: error\n/);
  });

  test('the macOS bundle: built on every run, with the native checks, the bundle check against the floor and the smoke test before its upload', () => {
    assert.ok(!job('macos-bundle').some((line) => line.key === 'if' && line.indent === 4), 'built and qualified on tag runs too');
    assert.equal(job('macos-bundle').find((line) => line.key === 'MACOSX_DEPLOYMENT_TARGET')?.value, floor('macos-programs'));
    assert.ok(!job('macos-bundle').some((line) => line.key === 'MACOS_BUNDLE_TARGET'), 'the bundle floor is read from install.sh');
    assert.equal(floor('macos-bundle'), '13.5', 'the bundled Node 24 needs macOS 13.5');
    inOrder([at('macos-bundle', /bash scripts\/bootstrap\.sh --install-only 2>&1 \| tee "\$RUNNER_TEMP\/build\.log"/),
      at('macos-bundle', /release-check-macos\.sh links\b/), at('macos-bundle', /release-check-macos\.sh linker-log "\$RUNNER_TEMP\/build\.log"/),
      at('macos-bundle', /release-check-macos\.sh runtime-minos "\$MACOSX_DEPLOYMENT_TARGET"/), at('macos-bundle', /bash scripts\/build-bundle\.sh/),
      at('macos-bundle', /release-check-macos\.sh bundle "\$RUNNER_TEMP\/out\/mesh-\$TARGET\.tar\.gz" "\$\(bash scripts\/release-floor\.sh macos-bundle\)"/),
      at('macos-bundle', /bash scripts\/smoke-bundle\.sh/), at('macos-bundle', /actions\/upload-artifact@/)]);
    assert.match(job('macos-bundle').find((line) => line.key === 'key')?.value ?? '', /\$\{\{ env\.MACOSX_DEPLOYMENT_TARGET \}\}/);
    assert.match(raw('macos-bundle'), /name: bundle-macos-arm64\n\s+path: \$\{\{ runner\.temp \}\}\/out\/mesh-macos-arm64\.tar\.gz\n/);
  });

  // A release is built from opam state made with its exact pins, or cold: no prefix fallback.
  test('restores the opam caches by exact key only (no restore-keys), one distinct key per build', () => {
    assert.deepEqual(lines.filter((line) => /restore-keys/.test(line.text)).map((line) => line.number), []);
    const restores = lines.filter((line) => usesOf(line).some((action) => action.startsWith('actions/cache/restore@')));
    assert.equal(restores.length, 4);
    const prefixes = lines.filter((line) => line.key === 'key' && line.value.startsWith('release-opam-')).map((line) => line.value.split('-${{')[0]);
    assert.deepEqual(prefixes.sort(), ['release-opam-bundle', 'release-opam-bundle-macos-arm64', 'release-opam-macos-arm64', 'release-opam-static']);
  });

  test('uses GitHub actions only, plus the named exceptions outside the write job', () => {
    const owners = new Set(lines.flatMap((line) => usesOf(line)).map((action) => action.split('@')[0]));
    const others = [...owners].filter((owner) => !owner.startsWith('actions/'));
    assert.deepEqual(others.sort(), Object.keys(RELEASE_OTHER_ACTIONS).sort());
    assert.deepEqual(job(RELEASE_WRITE_JOB).flatMap((line) => usesOf(line)).map((action) => action.split('@')[0]).sort(),
      ['actions/attest-build-provenance', 'actions/download-artifact']);
  });

  test('publishes in one gh CLI step, refusing an existing release or a moved tag, the tag only through env', () => {
    const index = publishStep();
    assert.ok(job(RELEASE_WRITE_JOB).includes(lines[index]));
    const script = scriptOf(lines, index);
    assert.doesNotMatch(script, /\$\{\{/);
    assert.doesNotMatch(script, /git\/refs|--draft/);
    const where = (pattern: RegExp) => script.search(pattern);
    const order = [
      where(/gh api --paginate "repos\/\$GH_REPO\/releases" --jq '\.\[\]\.tag_name'/),
      where(/grep -Fxq -- "\$RELEASE_TAG"; then\n[^\n]*::error::[^\n]*\n\s+exit 1/),
      where(/git ls-remote "https:\/\/github\.com\/\$GH_REPO\.git" "refs\/tags\/\$RELEASE_TAG" "refs\/tags\/\$RELEASE_TAG\^\{\}"/),
      where(/"\$tagged" != "\$GITHUB_SHA" \]; then\n[^\n]*::error::[^\n]*\n\s+exit 1/),
      where(/gh api "repos\/\$GH_REPO\/releases\/latest" --jq \.tag_name/),
      where(/gh release create "\$RELEASE_TAG" --verify-tag "\$\{kind\[@\]\}" "\$\{latest\[@\]\}" --title "\$RELEASE_TAG"/),
    ];
    assert.ok(order.every((position) => position >= 0), `missing part: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'the parts run in this order');
    assert.match(script, /--notes-file "\$RUNNER_TEMP\/notes\.md" -- dist\/\*/);
    const tokens = lines.filter((line) => /github\.token/.test(line.raw));
    assert.equal(tokens.length, 1);
    assert.match(tokens[0].raw, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/);
    assert.equal(job(RELEASE_WRITE_JOB).find((line) => line.key === 'RELEASE_TAG')?.value, '${{ needs.tag.outputs.tag }}');
  });

  test('the publish job runs for a v tag push only, after the tag and package jobs passed', () => {
    const condition = job(RELEASE_WRITE_JOB).find((line) => line.key === 'if' && line.indent === 4)?.value;
    assert.equal(condition, "needs.tag.result == 'success' && needs.package.result == 'success' && github.event_name == 'push' && " +
      "startsWith(github.ref, 'refs/tags/v') && !cancelled()");
    assert.equal(job(RELEASE_WRITE_JOB).find((line) => line.key === 'needs')?.value, '[tag, package]');
  });

  test('the tag job checks out the full history and checks main or its release branch, for tag pushes only, read-only', () => {
    assert.match(raw('tag'), /actions\/checkout@[0-9a-f]{40} # [^\n]*\n\s+if: github\.event_name == 'push'\n\s+with:\n\s+persist-credentials: false\n\s+fetch-depth: 0\n/);
    assert.match(raw('tag'), /- name: Check that the tag names a commit of main or of its release branch\n\s+if: github\.event_name == 'push'\n/);
    assert.ok(!job('tag').some((line) => line.key === 'permissions'), 'the tag job keeps the read-only default');
  });

  test('every build waits for the tag job; the package job needs them all and assembles every file, read-only', () => {
    for (const name of RELEASE_BUILD_JOBS) assert.equal(job(name).find((line) => line.key === 'needs')?.value, 'tag', `job ${name}`);
    const pack = raw('package');
    assert.equal(job('package').find((line) => line.key === 'needs')?.value, '[tag, linux, macos, linux-bundle, macos-bundle]');
    assert.equal(job('package').find((line) => line.key === 'if' && line.indent === 4)?.value,
      "needs.tag.result == 'success' && needs.linux.result == 'success' && needs.macos.result == 'success' && " +
      "needs.linux-bundle.result == 'success' && !cancelled()", 'every build job but the macOS bundle is required');
    assert.ok(!job('package').some((line) => line.key === 'permissions'), 'the package job keeps the read-only default');
    assert.doesNotMatch(pack, /pattern:|merge-multiple/);
    const download = (artifact: string, dir: string) =>
      new RegExp(`download-artifact@[0-9a-f]{40} # [^\\n]*\\n\\s+with:\\n\\s+name: ${artifact}\\n\\s+path: \\$\\{\\{ runner\\.temp \\}\\}/${dir}\\n`);
    for (const target of ['linux-x86_64', 'linux-aarch64', 'macos-arm64']) assert.match(pack, download(`programs-${target}`, `programs/${target}`), target);
    for (const platform of ['linux-x86_64', 'linux-arm64']) assert.match(pack, download(`bundle-${platform}`, `bundles/${platform}`), platform);
    assert.match(pack, /download-artifact@[0-9a-f]{40} # [^\n]*\n\s+if: needs\.macos-bundle\.result == 'success'\n\s+with:\n\s+name: bundle-macos-arm64\n/);
    assert.equal(job('package').find((line) => line.key === 'MACOS_BUNDLE_RESULT')?.value, '${{ needs.macos-bundle.result }}');
    assert.match(pack, /for target in linux-x86_64 linux-aarch64 macos-arm64; do\n\s+bash scripts\/release-assets\.sh collect "\$target" "\$RUNNER_TEMP\/programs\/\$target" "\$RUNNER_TEMP\/dist"\n/);
    assert.match(pack, /platforms="linux-x86_64 linux-arm64"\n\s+if \[ "\$MACOS_BUNDLE_RESULT" = success \]; then\n\s+platforms="\$platforms macos-arm64"\n/);
    assert.match(pack, /for platform in \$platforms; do\n\s+bash scripts\/release-assets\.sh collect-bundle "\$platform" "\$RUNNER_TEMP\/bundles\/\$platform" "\$RUNNER_TEMP\/dist"\n/);
    assert.match(pack, /for floor in glibc macos-bundle macos-programs; do\n\s+echo "\$floor=\$\(bash scripts\/release-floor\.sh "\$floor"\)" >> "\$GITHUB_OUTPUT"/);
    assert.ok(pack.indexOf('release-assets.sh collect') < pack.indexOf('release-assets.sh bundle'), 'collect runs before bundle');
    assert.match(pack, /run: bash scripts\/release-assets\.sh bundle "\$RELEASE_TAG" "\$GITHUB_SHA" "\$RUNNER_TEMP\/dist"/);
    const publish = raw(RELEASE_WRITE_JOB);
    assert.match(publish, /download-artifact@[0-9a-f]{40} # [^\n]*\n\s+with:\n\s+name: release-files\n\s+path: dist\n/);
    assert.match(publish, /sha256sum --check --strict SHA256SUMS/);
    assert.match(publish, /test "\$\{#present\[@\]\}" -eq 20 \|\| test "\$\{#present\[@\]\}" -eq 21/);
    assert.match(publish, /expected=\(install\.sh SHA256SUMS "session-mesh-\$RELEASE_TAG\.tar\.gz" mesh-linux-x86_64\.tar\.gz mesh-linux-arm64\.tar\.gz\)/);
    assert.match(publish, /if \[ -e mesh-macos-arm64\.tar\.gz \]; then expected\+=\(mesh-macos-arm64\.tar\.gz\); fi\n\s+test "\$\(printf '%s\\n' "\$\{present\[@\]\}"\)" = "\$\(printf '%s\\n' "\$\{expected\[@\]\}" \| LC_ALL=C sort\)"/);
  });

});
