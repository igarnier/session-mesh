// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The `cla` job of the public CI (.github/workflows/public-ci.yml): it sees the whole pull request,
// takes base, head and merge result from GitHub's test merge commit (never from the event payload or the branch
// names) and runs the base branch's checker, failing when the base has none. Its check name is
// `cla`, the name CONTRIBUTING.md cites and the branch rule of `main` requires.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {describe, test} from 'node:test';
import {jobBlocks, parseLines} from './public-ci-workflow-lib.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'public-ci.yml'), 'utf8');

function claJob(): string {
  const job = jobBlocks(parseLines(text)).find((item) => item.name === 'cla');
  assert.ok(job, 'no cla job');
  return job.block.map((line) => line.raw).join('\n');
}

describe('the cla job of the public CI', () => {
  test('checks pull requests with the whole history, under the check name `cla`', () => {
    const body = claJob();
    assert.match(body, /^ {4}name: cla$/m);
    assert.match(body, /^ {8}if: github\.event_name == 'pull_request'$/m);
    assert.match(body, /^ {10}fetch-depth: 0$/m);
  });

  // A skipped job satisfies a required check: a workflow_dispatch on the branch of a pull request
  // would attach a skipped `cla` to its head commit. So the job is never skipped, and it fails
  // outside a pull request unless the ref is main.
  test('is never skipped as a whole, and fails outside a pull request unless the ref is main', () => {
    const body = claJob();
    assert.doesNotMatch(body, /^ {4}if:/m, 'a job-level condition would skip the job');
    assert.match(body, /^ {8}if: github\.event_name != 'pull_request'$/m);
    assert.ok(body.includes('if [[ "$GITHUB_REF" == refs/heads/main || "$GITHUB_REF" == refs/heads/release/* ]]; then'));
    assert.ok(body.includes('the cla check only runs on pull requests'));
    assert.match(body, /exit 1/);
  });

  test('every step after the guard is conditional on a pull request', () => {
    const steps = claJob().split(/^ {6}- /m).slice(1);
    assert.equal(steps.length, 4);
    for (const step of steps.slice(1)) assert.match(step, /^ {8}if: github\.event_name == 'pull_request'$|^if: github\.event_name == 'pull_request'$/m);
  });

  test('the guard passes on refs/heads/main and release/**, and fails on any other ref, saying why', () => {
    const body = claJob();
    const start = body.indexOf('if [[');
    const script = body.slice(start, body.indexOf('\n      - if:')).replace(/^ {10}/gm, '');
    const run = (ref: string) => spawnSync('bash', ['-eo', 'pipefail', '-c', script], {env: {...process.env, GITHUB_REF: ref}, encoding: 'utf8'});
    const onMain = run('refs/heads/main');
    assert.equal(onMain.status, 0);
    assert.match(onMain.stdout, /nothing verified/);
    assert.match(onMain.stdout, /on main already/);
    const onRelease = run('refs/heads/release/0.1');
    assert.equal(onRelease.status, 0);
    assert.match(onRelease.stdout, /nothing verified.*on release\/0\.1 already/);
    // The check of record stays on pull requests: a branch that is not main or under release/ fails.
    for (const ref of ['refs/heads/feature', 'refs/heads/release', 'refs/heads/releases/0.1', 'refs/heads/main-x', 'refs/heads/x/release/0.1',
      'refs/tags/release/0.1', 'refs/tags/v0.1.0', 'refs/pull/1/merge', '']) {
      const elsewhere = run(ref);
      assert.equal(elsewhere.status, 1, ref);
      assert.match(elsewhere.stdout, /the cla check only runs on pull requests/, ref);
    }
  });

  test('takes base, head and merge from the test merge commit and runs the base branch\'s checker', () => {
    const body = claJob();
    for (const needle of ["base=$(git rev-parse --verify 'HEAD^1^{commit}')", "head=$(git rev-parse --verify 'HEAD^2^{commit}')",
      "merge=$(git rev-parse --verify 'HEAD^{commit}')",
      'git cat-file blob "$base:tools/cla-check/cla-check.ts" > "$checker"',
      'node --experimental-strip-types "$checker" --repo . --base "$base" --head "$head" --merge "$merge"']) {
      assert.ok(body.includes(needle), `${needle} missing`);
    }
    assert.doesNotMatch(body, /GITHUB_EVENT_PATH|GITHUB_HEAD_REF|GITHUB_BASE_REF/);
  });

  test('never runs the pull request\'s own copy of the checker', () => {
    const body = claJob();
    assert.doesNotMatch(body, /\bcp\b[^\n]*tools\/cla-check/);
    assert.doesNotMatch(body, /cat-file -e/, 'no fallback when the base has no checker: the job must fail');
    assert.doesNotMatch(body, /--experimental-strip-types\s+tools\/cla-check/);
  });

  // A pull request whose base branch is changed gets an `edited` event, not a `synchronize` one.
  // No job may skip it: a skipped job satisfies a required check.
  test('runs again when a pull request is edited, its base branch included, with no job left out', () => {
    assert.match(text, /^ {2}pull_request:\n(?: {4}#.*\n)* {4}types: \[opened, synchronize, reopened, edited\]$/m);
    assert.doesNotMatch(text, /github\.event\.action|event\.changes/);
  });

  test('CONTRIBUTING.md cites the check by its name', () => {
    const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
    assert.match(contributing, /check `cla`/);
  });
});
