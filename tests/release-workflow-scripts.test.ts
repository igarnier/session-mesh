// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The scripts of the release workflow (.github/workflows/release.yml), run as the runner would run
// them: the release name of the tag job, its check that the tag names a commit of main (against
// scratch git repositories) and the publish step (git and gh replaced by recorders). The static
// invariants of the workflow are in tests/release-workflow.test.ts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {parseLines} from './public-ci-workflow-lib.ts';
import {scriptOf} from './public-ci-workflow-lib.ts';

const RELEASE = path.join(path.resolve(import.meta.dirname, '..'), '.github', 'workflows', 'release.yml');

// The script of a `run: |` step as the runner sees it: the block with its indentation removed.
function stepScript(lines: ReturnType<typeof parseLines>, pattern: RegExp): string {
  const index = lines.findIndex((line) => line.inBlock && pattern.test(line.raw));
  assert.ok(index >= 0, `no step script matches ${pattern}`);
  const block = scriptOf(lines, index).split('\n');
  const indent = Math.min(...block.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length));
  return block.map((line) => line.slice(indent)).join('\n') + '\n';
}

describe('the scripts of release.yml, run', () => {
  const lines = parseLines(fs.readFileSync(RELEASE, 'utf8'));
  const SHA = 'c'.repeat(40);
  let scratch = '';
  before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflow-')); });
  after(() => fs.rmSync(scratch, {recursive: true, force: true}));

  // GitHub runs a step as bash -eo pipefail.
  function run(script: string, env: Record<string, string>, cwd = scratch) {
    const file = path.join(scratch, 'step.sh');
    fs.writeFileSync(file, script);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file],
      {cwd, env: {PATH: process.env.PATH ?? '', ...env}, encoding: 'utf8'});
    return {status: result.status, output: result.stdout + result.stderr};
  }

  describe('the tag job: the release name', () => {
    const script = stepScript(lines, /tag="v0\.0\.0-dryrun/);
    function name(env: Record<string, string>): {status: number | null; output: string; tag: string} {
      const output = path.join(scratch, 'output');
      fs.writeFileSync(output, '');
      const result = run(script, {GITHUB_SHA: SHA, GITHUB_OUTPUT: output, ...env});
      return {...result, tag: /^tag=(.*)$/m.exec(fs.readFileSync(output, 'utf8'))?.[1] ?? ''};
    }

    test('names a tag push after its tag', () => {
      const result = name({GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3-rc.1', GITHUB_REF_NAME: 'v1.2.3-rc.1'});
      assert.equal(result.status, 0, result.output);
      assert.equal(result.tag, 'v1.2.3-rc.1');
    });

    test('names a manual run as a dry run, on any branch', () => {
      for (const ref of ['refs/heads/main', 'refs/heads/topic']) {
        const result = name({GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: ref, GITHUB_REF_NAME: 'v9.9.9'});
        assert.equal(result.tag, `v0.0.0-dryrun.${'c'.repeat(12)}`, ref);
      }
    });

    test('refuses a pushed tag outside the tag pattern', () => {
      for (const tag of ['v1', 'v1.2', 'v1.2.3.4', 'vX.2.3', 'v1.2.3-', 'v1.2.3-a/b', "v1.2.3'x", 'v1.2.3\nx']) {
        const result = name({GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: tag});
        assert.equal(result.status, 1, tag);
        assert.match(result.output, /not a release tag name/);
        assert.equal(result.tag, '');
      }
    });
  });

  describe('the tag job: the tag names a commit of main or of its release branch', () => {
    const script = stepScript(lines, /git merge-base --is-ancestor/);
    const gitEnv = () => ({HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid'});
    let clone = '';
    const commits: Record<string, string> = {};

    function git(cwd: string, ...args: string[]): string {
      const result = spawnSync('git', args, {cwd, env: {PATH: process.env.PATH ?? '', ...gitEnv()}, encoding: 'utf8'});
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    }

    // origin: main holds `first` and `merged`; `topic` (pushed as a branch only) and `local` (never
    // pushed) are not on main. The clone, as the checkout leaves it, holds every commit and tag;
    // its origin/main is removed so that only the step's own fetch can provide it.
    before(() => {
      const origin = path.join(scratch, 'origin.git');
      clone = path.join(scratch, 'clone');
      git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
      git(scratch, 'clone', '-q', origin, clone);
      for (const label of ['first', 'merged']) {
        git(clone, 'commit', '-q', '--allow-empty', '-m', label);
        commits[label] = git(clone, 'rev-parse', 'HEAD');
      }
      git(clone, 'push', '-q', 'origin', 'main');
      // The maintenance branch of the 0.1 series: cut from an older commit of main, with a fix of its own.
      git(clone, 'checkout', '-q', '-b', 'release/0.1', commits.first);
      git(clone, 'commit', '-q', '--allow-empty', '-m', 'patch');
      commits.patch = git(clone, 'rev-parse', 'HEAD');
      git(clone, 'push', '-q', 'origin', 'release/0.1');
      git(clone, 'checkout', '-q', 'main');
      git(clone, 'checkout', '-q', '-b', 'topic');
      git(clone, 'commit', '-q', '--allow-empty', '-m', 'topic');
      commits.topic = git(clone, 'rev-parse', 'HEAD');
      git(clone, 'push', '-q', 'origin', 'topic');
      git(clone, 'commit', '-q', '--allow-empty', '-m', 'local');
      commits.local = git(clone, 'rev-parse', 'HEAD');
      git(clone, 'tag', 'v1.0.0', commits.first);
      git(clone, 'tag', '-a', '-m', 'release', 'v1.1.0', commits.merged);
      git(clone, 'tag', 'v1.2.0-rc.1', commits.topic);
      git(clone, 'tag', 'v1.3.0', commits.local);
      git(clone, 'tag', 'v0.1.9', commits.local);
      for (const tag of ['v0.1.1', 'v0.1.2-rc.1', 'v0.2.0', 'v3.0.0']) git(clone, 'tag', tag, commits.patch);
      git(clone, 'update-ref', '-d', 'refs/remotes/origin/main');
      git(clone, 'update-ref', '-d', 'refs/remotes/origin/release/0.1');
    });

    const check = (tag: string, sha: string) => run(script, {...gitEnv(), RELEASE_TAG: tag, GITHUB_SHA: sha}, clone);

    test('accepts a tag on main, lightweight or annotated, older than its head or at it', () => {
      for (const [tag, label] of [['v1.0.0', 'first'], ['v1.1.0', 'merged']]) {
        const result = check(tag, commits[label]);
        assert.equal(result.status, 0, `${tag}: ${result.output}`);
        assert.match(result.output, /, on main/);
      }
    });

    test('refuses a tag on a commit that is not on main, pushed on a branch or not', () => {
      for (const [tag, label] of [['v1.2.0-rc.1', 'topic'], ['v1.3.0', 'local']]) {
        const result = check(tag, commits[label]);
        assert.equal(result.status, 1, tag);
        assert.match(result.output, /which is not on main/);
      }
    });

    // v0.1.1 is cut on release/0.1, a branch that main does not hold: the series of the tag, 0.1,
    // names the branch.
    test('accepts a tag on the release branch of its series, final or pre-release, and says so', () => {
      for (const tag of ['v0.1.1', 'v0.1.2-rc.1']) {
        const result = check(tag, commits.patch);
        assert.equal(result.status, 0, `${tag}: ${result.output}`);
        assert.match(result.output, /, on release\/0\.1$/m);
      }
    });

    test('refuses a commit of release/0.1 under a tag of another series, or of a series with no branch', () => {
      for (const tag of ['v0.2.0', 'v3.0.0']) {
        const result = check(tag, commits.patch);
        assert.equal(result.status, 1, tag);
        assert.match(result.output, new RegExp(`which is not on main or on release/${tag.slice(1).replace(/\.\d+$/, '').replace(/\./g, '\\.')}: tag a commit of one of them`), tag);
      }
    });

    test('a tag on main still needs no release branch', () => {
      const result = check('v1.0.0', commits.first);
      assert.equal(result.status, 0, result.output);
      assert.doesNotMatch(result.output, /release\//);
    });

    test('refuses a commit of a 0.1 tag that is on neither main nor release/0.1', () => {
      const result = check('v0.1.9', commits.local);
      assert.equal(result.status, 1);
      assert.match(result.output, /which is not on main or on release\/0\.1/);
    });

    test('refuses a tag that does not name the built commit, and an absent tag', () => {
      const moved = check('v1.0.0', commits.merged);
      assert.equal(moved.status, 1);
      assert.match(moved.output, /not the built commit/);
      assert.notEqual(check('v9.9.9', commits.first).status, 0);
    });
  });

  describe('the publish step', () => {
    const script = stepScript(lines, /gh release create/);
    // git ls-remote prints $FAKE_REFS; gh records its arguments, lists $FAKE_RELEASES and names
    // $FAKE_LATEST as the latest release (none: HTTP 404; `error`: another HTTP error).
    function publish(name: string, refs: string, releases = '', tag = 'v1.2.3', latest = ''): {status: number | null; output: string; calls: string[]} {
      const bin = path.join(scratch, name, 'bin');
      fs.mkdirSync(bin, {recursive: true});
      fs.mkdirSync(path.join(scratch, name, 'dist'), {recursive: true});
      fs.writeFileSync(path.join(scratch, name, 'dist', 'SHA256SUMS'), '');
      const calls = path.join(scratch, name, 'calls');
      fs.writeFileSync(calls, '');
      fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "git $*" >> "$CALLS"\nprintf "%s" "$FAKE_REFS"\n', {mode: 0o700});
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "gh $*" >> "$CALLS"
case "$*" in
  *--paginate*) printf '%s\\n' "$FAKE_RELEASES" ;;
  *releases/latest*)
    case "$FAKE_LATEST" in
      '') echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
      error) echo 'gh: Server Error (HTTP 502)' >&2; exit 1 ;;
      *) printf '%s\\n' "$FAKE_LATEST" ;;
    esac ;;
esac
`, {mode: 0o700});
      const runnerTemp = path.join(scratch, name);
      const result = run(script, {PATH: `${bin}:${process.env.PATH}`, CALLS: calls, FAKE_REFS: refs, FAKE_RELEASES: releases,
        FAKE_LATEST: latest, RELEASE_TAG: tag, GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'owner/repo', RUNNER_TEMP: runnerTemp}, runnerTemp);
      return {...result, calls: fs.readFileSync(calls, 'utf8').trim().split('\n')};
    }
    const created = (calls: string[]) => calls.filter((call) => call.startsWith('gh release create'));

    test('publishes on a tag that names the built commit, lightweight or annotated, without a draft or a new tag', () => {
      for (const [label, refs] of [['lightweight', `${SHA}\trefs/tags/v1.2.3\n`],
        ['annotated', `${'a'.repeat(40)}\trefs/tags/v1.2.3\n${SHA}\trefs/tags/v1.2.3^{}\n`]]) {
        const result = publish(`present-${label}`, refs);
        assert.equal(result.status, 0, result.output);
        const notes = path.join(scratch, `present-${label}`, 'notes.md');
        assert.deepEqual(created(result.calls), [`gh release create v1.2.3 --verify-tag --title v1.2.3 --notes-file ${notes} -- dist/SHA256SUMS`], label);
        assert.ok(!result.calls.some((call) => /git\/refs|--draft/.test(call)), label);
      }
    });

    test('publishes a tag with a suffix as a pre-release', () => {
      const result = publish('prerelease', `${SHA}\trefs/tags/v1.2.3-rc.1\n`, '', 'v1.2.3-rc.1');
      assert.equal(result.status, 0, result.output);
      assert.match(created(result.calls)[0] ?? '', /^gh release create v1\.2\.3-rc\.1 --verify-tag --prerelease --title v1\.2\.3-rc\.1 /);
    });

    test('refuses a tag that names another commit, or that no longer exists', () => {
      const cases: [string, string, RegExp][] = [['elsewhere', `${'e'.repeat(40)}\trefs/tags/v1.2.3\n`, /points at e{40}, not at the built commit/],
        ['gone', '', /points at nothing, not at the built commit/]];
      for (const [label, refs, message] of cases) {
        const result = publish(label, refs);
        assert.equal(result.status, 1, label);
        assert.match(result.output, message);
        assert.deepEqual(created(result.calls), [], label);
      }
    });

    test('refuses an existing release before reading the tag', () => {
      const result = publish('existing', `${SHA}\trefs/tags/v1.2.3\n`, 'v1.2.2\nv1.2.3');
      assert.equal(result.status, 1);
      assert.match(result.output, /a release for v1\.2\.3 already exists/);
      assert.deepEqual(result.calls.filter((call) => !call.includes('--paginate')), []);
    });

    // [tag, current latest release, published with --latest=false]
    const latestCases: [string, string, boolean][] = [
      ['v1.2.4', 'v1.3.0', true],
      ['v1.2.10', 'v1.2.9', false],
      ['v1.10.0', 'v1.9.5', false],
      ['v2.0.0', 'v10.0.0', true],
      ['v1.3.0', 'v1.3.0-rc.1', false],
      ['v1.2.9', 'v1.3.0-rc.1', true],
      ['v1.4.0', 'v1.3.0', false],
      ['v1.3.0', '', false],
      // A fix of the 0.1 line, cut on release/0.1 after v0.2.0 (or after a pre-release of it) is never the latest.
      ['v0.1.1', 'v0.2.0', true],
      ['v0.1.10', 'v0.2.0', true],
      ['v0.1.2', 'v0.2.0-rc.1', true],
      ['v0.1.1', 'v0.1.0', false],
      ['v0.2.1', 'v0.2.0', false],
    ];
    for (const [tag, current, older] of latestCases) {
      test(`publishes ${tag} after the latest ${current || '(none)'} ${older ? 'with --latest=false' : 'as the latest'}`, () => {
        const result = publish(`latest-${tag}-${current}`, `${SHA}\trefs/tags/${tag}\n`, '', tag, current);
        assert.equal(result.status, 0, result.output);
        const create = created(result.calls)[0] ?? '';
        assert.match(create, new RegExp(`^gh release create ${tag.replace(/\./g, '\\.')} --verify-tag ${older ? '--latest=false ' : ''}--title `));
      });
    }

    test('a pre-release never asks for the latest release, and is never marked --latest=false', () => {
      const result = publish('latest-prerelease', `${SHA}\trefs/tags/v1.2.0-rc.1\n`, '', 'v1.2.0-rc.1', 'v1.3.0');
      assert.equal(result.status, 0, result.output);
      assert.ok(!result.calls.some((call) => call.includes('releases/latest')));
      assert.doesNotMatch(created(result.calls)[0] ?? '', /--latest/);
    });

    test('refuses to publish when the latest release is not named like a release tag', () => {
      for (const current of ['nightly', 'v1.2', 'v1.2.3+build']) {
        const result = publish(`latest-odd-${current}`, `${SHA}\trefs/tags/v1.2.3\n`, '', 'v1.2.3', current);
        assert.equal(result.status, 1, current);
        assert.match(result.output, new RegExp(`::error::the latest release ${current.replace(/[.+]/g, '\\$&')} is not a release tag name`), current);
        assert.deepEqual(created(result.calls), [], current);
      }
    });

    test('refuses to publish when the latest release cannot be read for another reason than none', () => {
      const result = publish('latest-error', `${SHA}\trefs/tags/v1.2.3\n`, '', 'v1.2.3', 'error');
      assert.equal(result.status, 1);
      assert.match(result.output, /HTTP 502/);
      assert.match(result.output, /cannot read the latest release of owner\/repo/);
      assert.deepEqual(created(result.calls), []);
    });
  });

  // The semver comparison of the publish step, on its own: [older, newer] pairs, each also checked
  // in reverse and against itself.
  test('the publish step compares versions as semver, pre-release identifiers included', () => {
    const script = stepScript(lines, /gh release create/);
    const functions = script.slice(script.indexOf('prerelease_older() {'), script.indexOf('latest=()'));
    const pairs = [['v1.2.3', 'v1.2.4'], ['v1.9.0', 'v1.10.0'], ['v1.2.3-rc.9', 'v1.2.3-rc.10'], ['v1.2.3-rc.1', 'v1.2.3'],
      ['v1.2.3-alpha', 'v1.2.3-alpha.1'], ['v1.2.3-alpha.1', 'v1.2.3-alpha.beta'], ['v1.2.3-1', 'v1.2.3-alpha'],
      ['v1.2.3-beta.11', 'v1.2.3-rc.1'], ['v1.2.3-Z', 'v1.2.3-a'], ['v1.2.3-RC.1', 'v1.2.3-beta.1']];
    const probe = pairs.map(([a, b]) => `version_older ${a} ${b} && echo yes || echo no
version_older ${b} ${a} && echo yes || echo no
version_older ${a} ${a} && echo yes || echo no`).join('\n');
    // Under a collating locale, bash >= 4.1 would order a before Z: the comparison must stay ASCII.
    const result = run(`${functions}\n${probe}\n`, {LC_ALL: 'en_US.UTF-8'});
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.output.trim().split('\n'), pairs.flatMap(() => ['yes', 'no', 'no']));
  });
});
