// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The checks of the `release` profile (.github/workflows/release.yml), applied by checkWorkflow of
// tests/public-ci-workflow-checks.ts on top of every rule the profiles share. The release workflow
// differs from the public one in exactly these places: its own runner allowlist, one write job, a
// higher timeout for the build jobs only, tag triggers only, GitHub's own actions only (named
// exceptions in the build jobs), docker only with the digest-pinned Alpine and manylinux_2_28
// images, no self-hosted runner, the checks of the native programs and of the bundles (static
// Linux programs, macOS link and deployment-target checks, the glibc floor of the Linux bundles),
// exact-key caches only, the run's token named only for the gh CLI of the write job, which runs no
// repository code, runs for tag pushes only and publishes on an existing tag, a tag job that checks
// the tag is on main or on its release branch, the macOS bundle as the one build job a release may go without, manual runs
// as dry runs without inputs, no signature file, one tag pattern.
import {blockOf, commandAt, jobBlocks, type Line, MAX_TIMEOUT_MINUTES, permissionValues, stepOf, timeoutProblems, usesOf}
  from './public-ci-workflow-lib.ts';

// The static Linux programs are built on the runner of each architecture (ubuntu-24.04 and
// ubuntu-24.04-arm, in an Alpine container), the macOS programs and bundle on macos-15, the Linux
// bundles on Ubuntu 22.04 runners (inside the manylinux_2_28 image); the jobs that only assemble or
// publish files run on ubuntu-24.04. No self-hosted runner (checkReleaseNoSelfHosted).
export const RELEASE_RUNNERS = ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'ubuntu-22.04', 'ubuntu-22.04-arm'];
export const RELEASE_BUILD_JOBS = ['linux', 'macos', 'linux-bundle', 'macos-bundle'];
// The one build job a release may be published without (its bundle is then left out).
export const RELEASE_OPTIONAL_JOB = 'macos-bundle';
export const RELEASE_PACKAGE_JOB = 'package';
export const RELEASE_WRITE_JOB = 'publish';
export const RELEASE_TAG_JOB = 'tag';
export const MAX_BUILD_TIMEOUT_MINUTES = 90;
const ALPINE_DIGEST = /^alpine@sha256:[0-9a-f]{64}$/;
// The Linux bundles' build image of each architecture, pinned by digest.
export const MANYLINUX_IMAGES: Record<string, RegExp> = {
  'linux-x86_64': /^quay\.io\/pypa\/manylinux_2_28_x86_64@sha256:[0-9a-f]{64}$/,
  'linux-arm64': /^quay\.io\/pypa\/manylinux_2_28_aarch64@sha256:[0-9a-f]{64}$/,
};

// The value of `runs-on` of a job, with `${{ matrix.key }}` resolved against the job's matrix: every
// value the key takes in the matrix (none found is reported, never assumed).
function resolveRunners(job: Line[], line: Line): string[] {
  const value = line.value;
  const reference = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value);
  if (!reference) return [value];
  const matrixIndex = job.findIndex((item) => item.key === 'matrix');
  const matrix = matrixIndex < 0 ? [] : blockOf(job, matrixIndex);
  return matrix.filter((item) => item.key === reference[1]).map((item) => item.value);
}

export function checkReleaseRunners(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const {name, block} of jobBlocks(lines)) {
    const runsOn = block.find((line) => line.key === 'runs-on');
    if (!runsOn) continue;
    const runners = resolveRunners(block, runsOn);
    if (runners.length === 0) problems.push(`job ${name}: runs-on ${runsOn.value || '(empty)'} resolves to no runner`);
    for (const runner of runners) {
      if (!RELEASE_RUNNERS.includes(runner)) problems.push(`line ${runsOn.number}: runner ${runner || '(empty)'} is not one of ${RELEASE_RUNNERS.join(', ')}`);
    }
  }
  return problems;
}

// Only the publish job may write, and only these scopes: `contents` (it creates the release),
// `id-token` and `attestations` (it signs the build provenance); nothing else is writable anywhere.
export const RELEASE_WRITE_SCOPES = ['attestations', 'contents', 'id-token'];

export function checkReleasePermissions(lines: Line[]): string[] {
  const writeJob = jobBlocks(lines).find((job) => job.name === RELEASE_WRITE_JOB)?.block ?? [];
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.key !== 'permissions') return;
    for (const {scope, value, number} of permissionValues(lines, index)) {
      const inWriteJob = writeJob.includes(line);
      const allowed = value === 'read' || value === 'none' || (RELEASE_WRITE_SCOPES.includes(scope) && value === 'write' && inWriteJob);
      if (!allowed) problems.push(`line ${number}: permission ${scope}: ${value || '(empty)'} is not allowed here`);
    }
  });
  return problems;
}

export function checkReleaseTimeouts(lines: Line[]): string[] {
  return timeoutProblems(lines, (name) => RELEASE_BUILD_JOBS.includes(name) ? MAX_BUILD_TIMEOUT_MINUTES : MAX_TIMEOUT_MINUTES);
}

// Triggers: a push of `v*` tags and a manual run without inputs (a dry run: nothing selects a tag
// or a release), nothing else (no pull_request, no branch push).
function checkReleaseTriggers(lines: Line[]): string[] {
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  if (onIndex < 0) return ['no on: block'];
  const problems: string[] = [];
  const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2);
  const names = triggers.map((line) => line.key).sort().join(', ');
  if (names !== 'push, workflow_dispatch') problems.push(`triggers are ${names || '(none)'}, expected push, workflow_dispatch`);
  const push = triggers.find((line) => line.key === 'push');
  const pushKeys = push ? blockOf(lines, lines.indexOf(push)).filter((line) => line.indent === 4) : [];
  const tags = pushKeys.find((line) => line.key === 'tags');
  if (pushKeys.length !== 1 || !tags || !/^\[\s*(['"]?)v\*\1\s*\]$/.test(tags.value)) {
    problems.push('push must be limited to tags: ["v*"] (no branches, no other filter)');
  }
  const dispatch = triggers.find((line) => line.key === 'workflow_dispatch');
  if (dispatch && (dispatch.value !== '' || blockOf(lines, lines.indexOf(dispatch)).some((line) => line.indent > 2))) {
    problems.push('workflow_dispatch must take no inputs (a manual run is a dry run)');
  }
  if (lines.some((line) => /\binputs\./.test(line.text))) problems.push('the workflow reads inputs: a manual run must be a dry run');
  return problems;
}

// The one place the release workflow names the run's token: `GH_TOKEN: ${{ github.token }}` in the
// env of a step of the publish job that runs a script (the gh CLI), never in a `with:` of an
// action. Any other mention stays an explicit-token problem.
export const RELEASE_TOKEN_LINE = /^\s+GH_TOKEN: \$\{\{ github\.token \}\}\s*$/;

export function releaseTokenLines(lines: Line[]): Set<Line> {
  const writeJob = jobBlocks(lines).find((job) => job.name === RELEASE_WRITE_JOB)?.block ?? [];
  const allowed = new Set<Line>();
  for (const env of writeJob.filter((line) => line.key === 'env' && !line.inBlock)) {
    const step = stepOf(lines, lines.indexOf(env));
    const runsScript = step.some((item) => item.key === 'run') && !step.some((item) => usesOf(item).length > 0);
    if (!runsScript) continue;
    for (const line of blockOf(lines, lines.indexOf(env))) if (RELEASE_TOKEN_LINE.test(line.raw)) allowed.add(line);
  }
  return allowed;
}

// Actions of the release workflow: GitHub's own (`actions/*`) anywhere; any other only where this
// list names it (the read-only macOS build jobs), and never in the publish job, which holds the
// write token. The Linux bundles take their tools from their pinned build image and pinned files.
export const RELEASE_OTHER_ACTIONS: Record<string, string[]> = {
  'astral-sh/setup-uv': ['macos-bundle'], 'ocaml/setup-ocaml': ['macos', 'macos-bundle']};

function checkReleaseActions(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const {name, block} of jobBlocks(lines)) {
    for (const line of block) {
      if (line.inBlock) continue;
      for (const action of usesOf(line)) {
        const owner = action.split('@')[0];
        if (owner.startsWith('actions/')) continue;
        if (!(RELEASE_OTHER_ACTIONS[owner] ?? []).includes(name)) problems.push(`line ${line.number}: action ${owner} is not allowed in job ${name}`);
      }
    }
  }
  return problems;
}

// A release is built from an opam cache whose key matches exactly, or cold: no prefix fallback.
function checkReleaseCaches(lines: Line[]): string[] {
  return lines.filter((line) => !line.inBlock && /(?:^|[\s{,])restore-keys\s*:/.test(line.text))
    .map((line) => `line ${line.number}: restore-keys (a cache fallback) is not allowed in a release`);
}

// The release tag form, the same in the workflow, scripts/release-*.sh and the installer contract.
export const RELEASE_TAG_PATTERN = String.raw`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`;

// Every tag pattern written in the workflow (a `=~ ^v...` test) is the release tag form.
function checkReleaseTagPatterns(lines: Line[]): string[] {
  return lines.flatMap((line) => [...line.raw.matchAll(/=~\s+(\^v\S*)/g)]
    .filter((match) => match[1] !== RELEASE_TAG_PATTERN)
    .map(() => `line ${line.number}: tag pattern other than ${RELEASE_TAG_PATTERN}`));
}

// The write job runs no code of the repository (no checkout, no script of it) and creates no tag
// (no git/refs call); every release is created there, published (no --draft) on an existing tag
// (--verify-tag), and the job runs for a `v` tag push only, after the tag and package jobs passed.
// The package job runs when every required build job passed, whatever the optional one did, so the
// write job names the results it needs and !cancelled() (a job condition without a status function
// would also require every job upstream of the package job, the optional one included).
export const RELEASE_WRITE_CONDITION = "needs.tag.result == 'success' && needs.package.result == 'success' && " +
  "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && !cancelled()";

function checkReleaseWriteJob(lines: Line[]): string[] {
  const writeJob = jobBlocks(lines).find((job) => job.name === RELEASE_WRITE_JOB)?.block ?? [];
  const problems: string[] = [];
  for (const line of writeJob) {
    if (usesOf(line).some((action) => action.startsWith('actions/checkout@'))) problems.push(`line ${line.number}: checkout in the write job`);
    if (/(?:^|[\s;&|(])(?:bash\s+|\.\/)scripts\//.test(line.raw)) problems.push(`line ${line.number}: repository script run in the write job`);
    if (/git\/refs\b/.test(line.text)) problems.push(`line ${line.number}: the write job creates a git ref`);
  }
  for (const line of lines.filter((item) => /\bgh release create\b/.test(item.raw))) {
    if (!writeJob.includes(line)) problems.push(`line ${line.number}: gh release create outside the write job`);
    else if (/--draft\b/.test(line.raw) || !/--verify-tag\b/.test(line.raw)) problems.push(`line ${line.number}: gh release create must publish (no --draft) with --verify-tag`);
  }
  const condition = writeJob.find((line) => line.key === 'if' && line.indent === 4)?.value ?? '';
  if (condition !== RELEASE_WRITE_CONDITION) problems.push(`job ${RELEASE_WRITE_JOB}: if: must be exactly ${RELEASE_WRITE_CONDITION}`);
  const needs = writeJob.find((line) => line.key === 'needs' && line.indent === 4)?.value ?? '';
  if (needs !== `[${RELEASE_TAG_JOB}, ${RELEASE_PACKAGE_JOB}]`) problems.push(`job ${RELEASE_WRITE_JOB}: needs must be exactly [${RELEASE_TAG_JOB}, ${RELEASE_PACKAGE_JOB}]`);
  return problems;
}

// The package job waits for the tag job and every build job, and runs only when the tag job and
// every build job but the optional one passed: a release can go without the macOS bundle, and
// without nothing else.
export const RELEASE_PACKAGE_CONDITION = [RELEASE_TAG_JOB, ...RELEASE_BUILD_JOBS.filter((job) => job !== RELEASE_OPTIONAL_JOB)]
  .map((job) => `needs.${job}.result == 'success'`).join(' && ') + ' && !cancelled()';

function checkReleasePackageJob(lines: Line[]): string[] {
  const block = jobBlocks(lines).find((job) => job.name === RELEASE_PACKAGE_JOB)?.block ?? [];
  const problems: string[] = [];
  const needs = block.find((line) => line.key === 'needs' && line.indent === 4)?.value ?? '';
  if (needs !== `[${[RELEASE_TAG_JOB, ...RELEASE_BUILD_JOBS].join(', ')}]`) {
    problems.push(`job ${RELEASE_PACKAGE_JOB}: needs must be exactly [${[RELEASE_TAG_JOB, ...RELEASE_BUILD_JOBS].join(', ')}]`);
  }
  const condition = block.find((line) => line.key === 'if' && line.indent === 4)?.value ?? '';
  if (condition !== RELEASE_PACKAGE_CONDITION) problems.push(`job ${RELEASE_PACKAGE_JOB}: if: must be exactly ${RELEASE_PACKAGE_CONDITION}`);
  // No other job decides with a status function: only these two may run after a failed job.
  for (const {name, block: job} of jobBlocks(lines)) {
    if (name === RELEASE_PACKAGE_JOB || name === RELEASE_WRITE_JOB) continue;
    const jobIf = job.find((line) => line.key === 'if' && line.indent === 4);
    if (jobIf && /\b(?:always|cancelled|failure|success)\s*\(/.test(jobIf.value)) problems.push(`job ${name}: a status function in its if:`);
  }
  return problems;
}

// The tag job, which every other job waits for, checks that the pushed tag names a commit of main,
// or of the maintenance branch of its series: it fetches main and runs
// `git merge-base --is-ancestor <commit> refs/remotes/origin/main`, and, failing that, fetches
// release/<series> (the series is the tag's <major>.<minor>) and runs the same test against it.
function checkReleaseMainAncestry(lines: Line[]): string[] {
  const tagJob = jobBlocks(lines).find((job) => job.name === RELEASE_TAG_JOB)?.block ?? [];
  const has = (pattern: RegExp): boolean => tagJob.some((line) => pattern.test(line.text));
  const problems: string[] = [];
  if (!has(/\bgit fetch\b.*\brefs\/heads\/main:refs\/remotes\/origin\/main\b/) || !has(/\bgit merge-base --is-ancestor\b.*\brefs\/remotes\/origin\/main\b/)) {
    problems.push(`job ${RELEASE_TAG_JOB}: no check that the tag names a commit of main (git fetch of main, then merge-base --is-ancestor)`);
  }
  if (!has(/\bgit fetch\b.*\brefs\/heads\/release\/\$series:refs\/remotes\/origin\/release\/\$series\b/) ||
      !has(/\bgit merge-base --is-ancestor\b.*\brefs\/remotes\/origin\/release\/\$series\b/)) {
    problems.push(`job ${RELEASE_TAG_JOB}: no check that the tag names a commit of its release branch (git fetch of release/$series, then merge-base --is-ancestor)`);
  }
  return problems;
}

// Releases are not signed by hand: no signature file and no SSH signing in the workflow.
function checkReleaseNoSignature(lines: Line[]): string[] {
  return lines.filter((line) => /SHA256SUMS\.sig|\bssh-keygen\b/.test(line.raw))
    .map((line) => `line ${line.number}: signature file or SSH signing in the release workflow`);
}

// The pairs (target, image) of the matrix of the linux-bundle job, in order.
function manylinuxPairs(lines: Line[]): {target: string; image: string; number: number}[] {
  const block = jobBlocks(lines).find((job) => job.name === 'linux-bundle')?.block ?? [];
  const pairs: {target: string; image: string; number: number}[] = [];
  let target = '';
  for (const line of block) {
    if (line.key === 'target') target = line.value;
    if (line.key === 'image') pairs.push({target, image: line.value, number: line.number});
  }
  return pairs;
}

// The build images: the static build's Alpine image is declared once (ALPINE_IMAGE), the Linux
// bundles' manylinux_2_28 images in the matrix of their job, one per architecture, each pinned by
// digest and reaching the job only as MANYLINUX_IMAGE: ${{ matrix.image }}. A docker command uses
// one of the two variables, each in its own job, and no image is named anywhere else.
const IMAGE_VARIABLE_JOB: Record<string, string> = {ALPINE_IMAGE: 'linux', MANYLINUX_IMAGE: 'linux-bundle'};
function checkReleaseImages(lines: Line[]): string[] {
  const problems: string[] = [];
  const alpine = lines.filter((line) => line.key === 'ALPINE_IMAGE');
  if (alpine.length !== 1 || !ALPINE_DIGEST.test(alpine[0].value)) problems.push('ALPINE_IMAGE must be declared once, as alpine@sha256:<digest>');
  const manylinux = lines.filter((line) => line.key === 'MANYLINUX_IMAGE');
  const bundleJob = jobBlocks(lines).find((job) => job.name === 'linux-bundle')?.block ?? [];
  if (manylinux.length !== 1 || manylinux[0].value !== '${{ matrix.image }}' || !bundleJob.includes(manylinux[0])) {
    problems.push('MANYLINUX_IMAGE must be declared once, in the env of the linux-bundle job, as ${{ matrix.image }}');
  }
  const pairs = manylinuxPairs(lines);
  const images = lines.filter((line) => line.key === 'image');
  if (pairs.length !== Object.keys(MANYLINUX_IMAGES).length || images.length !== pairs.length) problems.push('the linux-bundle matrix must give exactly one image to each of its targets');
  for (const {target, image, number} of pairs) {
    if (!MANYLINUX_IMAGES[target]?.test(image)) problems.push(`line ${number}: image of ${target || '(no target)'} is not its manylinux_2_28 image pinned by digest`);
  }
  for (const {name, block} of jobBlocks(lines)) {
    block.forEach((line) => {
      if (/^\s*#/.test(line.raw) || line.key === 'ALPINE_IMAGE' || line.key === 'image') return;
      if (/\balpine[:@]|pypa\/manylinux/i.test(line.raw)) problems.push(`line ${line.number}: build image named outside ALPINE_IMAGE and the linux-bundle matrix`);
      if (!/\bdocker\s+(?:run|pull|create|build)\b/.test(line.raw)) return;
      const command = commandAt(lines, lines.indexOf(line));
      const used = Object.keys(IMAGE_VARIABLE_JOB).filter((variable) => new RegExp(`\\$\\{?${variable}\\b`).test(command));
      if (used.length !== 1 || IMAGE_VARIABLE_JOB[used[0]] !== name) {
        problems.push(`line ${line.number}: docker command that does not use the image variable of its job ($ALPINE_IMAGE in linux, $MANYLINUX_IMAGE in linux-bundle)`);
      }
    });
  }
  return problems;
}

// The release is built on GitHub's runners only: no self-hosted runner and no label of one, wherever
// it is written (runs-on, a matrix, an expression). The qualification runners have their own
// workflow (qualify-selfhosted.yml) and never build what is published.
export const QUALIFICATION_LABEL = 'session-mesh-qual';
function checkReleaseNoSelfHosted(lines: Line[]): string[] {
  return lines.filter((line) => !/^\s*#/.test(line.raw) && (/self-hosted/i.test(line.raw) || line.raw.includes(QUALIFICATION_LABEL)))
    .map((line) => `line ${line.number}: self-hosted runner or qualification label in the release workflow`);
}

// The published files stay qualified in the workflow: the linux job checks that every program is
// statically linked, the macos job builds for a pinned deployment target equal to the floor of
// install.sh and runs the three checks of scripts/release-check-macos.sh, both smoke-test what they
// built; the Linux bundle job checks the glibc floor, smoke-tests its bundle in its build image and
// on the runner and tests its demo compiler; the macOS bundle job checks the bundle against the
// floor of install.sh and smoke-tests it.
export const RELEASE_NATIVE_CHECKS: Record<string, RegExp[]> = {
  linux: [/\[\[ "\$info" == \*"statically linked"\* \]\]/, /ldd .*not a dynamic executable/, /bash scripts\/release-smoke\.sh/],
  macos: [/^\s+MACOSX_DEPLOYMENT_TARGET: "\d+\.\d+"$/m, /test "\$MACOSX_DEPLOYMENT_TARGET" = "\$\(bash scripts\/release-floor\.sh macos-programs\)"/,
    /release-check-macos\.sh links\b/, /release-check-macos\.sh linker-log\b/,
    /release-check-macos\.sh runtime-minos "\$MACOSX_DEPLOYMENT_TARGET"/, /bash scripts\/release-smoke\.sh/],
  'linux-bundle': [/bash \/src\/scripts\/release-build-bundle-linux\.sh \/src \/out\b/,
    /bash scripts\/release-check-glibc\.sh "\$RUNNER_TEMP\/out\/mesh-\$TARGET\.tar\.gz"/,
    /exec bash \/src\/scripts\/smoke-bundle\.sh "\$0"' "\/out\/mesh-\$TARGET\.tar\.gz"/,
    /run: bash scripts\/smoke-bundle\.sh "\$RUNNER_TEMP\/out\/mesh-\$TARGET\.tar\.gz"/, /app\/demo-compiler\/test-compiler\.mjs"/],
  'macos-bundle': [/release-check-macos\.sh bundle "\$RUNNER_TEMP\/out\/mesh-\$TARGET\.tar\.gz" "\$\(bash scripts\/release-floor\.sh macos-bundle\)"/,
    /bash scripts\/smoke-bundle\.sh/],
};
function checkReleaseNativeChecks(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const [name, checks] of Object.entries(RELEASE_NATIVE_CHECKS)) {
    const block = jobBlocks(lines).find((job) => job.name === name)?.block ?? [];
    const text = block.filter((line) => !/^\s*#/.test(line.raw)).map((line) => line.raw).join('\n');
    for (const check of checks) if (!check.test(text)) problems.push(`job ${name}: lacks the check ${check}`);
  }
  return problems;
}

export const RELEASE_CHECKS: ((lines: Line[]) => string[])[] = [checkReleaseTriggers, checkReleaseImages, checkReleaseNoSelfHosted,
  checkReleaseNativeChecks, checkReleaseActions, checkReleaseCaches, checkReleaseWriteJob, checkReleasePackageJob,
  checkReleaseMainAncestry, checkReleaseNoSignature, checkReleaseTagPatterns];
