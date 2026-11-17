// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The backport workflow (.github/workflows/backport.yml), the one workflow that runs on
// `pull_request_target` and holds a write token. Its profile (tests/backport-workflow-checks.ts)
// keeps it from running code of a pull request: each fault below is an edit of the committed file
// that the profile must report, so a weakened rule fails here even if the file still looks fine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {checkWorkflow} from './public-ci-workflow-checks.ts';
import {BACKPORT_LABEL, BACKPORT_TARGET} from './backport-workflow-checks.ts';

const FILE = path.join(import.meta.dirname, '..', '.github', 'workflows', 'backport.yml');
const text = fs.readFileSync(FILE, 'utf8');
const problems = (workflow: string): string => checkWorkflow(workflow, 'backport').join('\n');

// The committed file with `from` replaced by `to`; `from` must exist, so that a renamed line
// breaks this test instead of silently turning a fault into a no-op.
function edit(from: string, to: string): string {
  assert.ok(text.includes(from), `the workflow no longer contains: ${from}`);
  return text.replace(from, to);
}

const CHECKOUT = '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n';
const ACTION = 'korthout/backport-action@ad272ff24e4a8593bf18a951a154ae6af93b26b8';
const TOKEN = '${{ steps.app-token.outputs.token || github.token }}';

describe('the backport workflow as committed', () => {
  test('satisfies the backport profile', () => {
    assert.deepEqual(checkWorkflow(text, 'backport'), []);
  });

  test('backports to release/0.1, with the label semver: patch, from a merged pull request to main', () => {
    assert.match(text, /^ {10}target_branches: release\/0\.1$/m);
    assert.match(text, /^ {10}add_labels: "semver: patch"$/m);
    assert.match(text, /^ {10}pull_title: "\[0\.1\] \$\{pull_title\}"$/m);
    assert.equal(BACKPORT_TARGET, 'release/0.1');
    assert.equal(BACKPORT_LABEL, 'semver: patch');
    assert.match(text, /^ {4}types: \[closed, labeled\]$/m);
    assert.match(text, /^ {4}branches: \[main\]$/m);
  });

  test('uses the GitHub App secrets when set and the run\'s token otherwise, and says when CI will not run', () => {
    assert.match(text, /^ {6}HAS_APP_TOKEN: \$\{\{ secrets\.BACKPORT_APP_ID != '' && secrets\.BACKPORT_APP_PRIVATE_KEY != '' \}\}$/m);
    assert.equal(text.split(TOKEN).length - 1, 2, 'the checkout and the backport action take the same token');
    assert.match(text, /^ {8}if: env\.HAS_APP_TOKEN != 'true' && steps\.backport\.outputs\.created_pull_numbers != ''$/m);
    assert.match(text, /A maintainer starts it by closing and reopening this pull request/);
  });

  test('pins its two actions by full commit SHA, the exact versions this test names', () => {
    assert.match(text, new RegExp(`uses: ${ACTION} # v5\\.0\\.0$`, 'm'));
    assert.match(text, /uses: actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3\.3\.0$/m);
  });

  test('commits as GitHub, the committer the cla job accepts', () => {
    assert.match(text, /^ {10}git_committer_name: GitHub$/m);
    assert.match(text, /^ {10}git_committer_email: noreply@github\.com$/m);
  });
});

describe('the backport profile rejects what would run a pull request\'s code with the write token', () => {
  const faults: [string, string, RegExp][] = [
    ['a checkout of the pull request head', edit(CHECKOUT, `${CHECKOUT}          ref: \${{ github.event.pull_request.head.sha }}\n`),
      /untrusted event data in an expression \(github\.event\.pull_request\.head\.sha\)|the pull request's head is named/],
    ['a checkout of the head by its ref name', edit(CHECKOUT, `${CHECKOUT}          ref: refs/pull/1/head\n`), /the pull request's head is named/],
    ['a checkout of another repository', edit(CHECKOUT, `${CHECKOUT}          repository: someone/fork\n`), /checkout input repository/],
    ['a checkout path', edit(CHECKOUT, `${CHECKOUT}          path: pr\n`), /checkout input path/],
    ['a checkout without the token', edit(`          token: ${TOKEN}\n`, ''), /checkout token must be/],
    ['the pull request title in an expression', edit('          CREATED:', '          TITLE: ${{ github.event.pull_request.title }}\n          CREATED:'),
      /untrusted event data in an expression \(github\.event\.pull_request\.title\)/],
    ['the pull request body in an expression', edit('          CREATED:', '          BODY: ${{ github.event.pull_request.body }}\n          CREATED:'),
      /github\.event\.pull_request\.body/],
    ['the head branch name', edit('          CREATED:', '          BRANCH: ${{ github.head_ref }}\n          CREATED:'), /head_ref/],
    ['the event read with brackets', edit('          CREATED:', "          X: ${{ github.event['pull_request']['title'] }}\n          CREATED:"),
      /other than github\.event\.<path>/],
    ['the whole github context', edit('          CREATED:', '          X: ${{ toJSON(github) }}\n          CREATED:'), /read whole or by a computed index/],
    ['another secret', edit('          CREATED:', '          X: ${{ secrets.DEPLOY_KEY }}\n          CREATED:'), /secret other than BACKPORT_APP_ID and BACKPORT_APP_PRIVATE_KEY/],
    ['the whole secrets context', edit('          CREATED:', '          X: ${{ toJSON(secrets) }}\n          CREATED:'), /secret other than/],
    ['a secret handed to the backport action', edit(`          github_token: ${TOKEN}`, '          github_token: ${{ secrets.BACKPORT_APP_PRIVATE_KEY }}'),
      /secret handed to a step other than actions\/create-github-app-token|secret read outside the expected form/],
    ['the app secrets handed on to a called workflow', edit('permissions:\n  contents: read\n', 'permissions:\n  contents: read\nsecrets: inherit\n'), /secrets passed on/],
    ['the run\'s token in the script step by another form', edit('          GH_TOKEN: ${{ github.token }}', "          GH_TOKEN: ${{ github['token'] }}"), /explicit token/],
    ['the run\'s token as a script environment variable name', edit('          CREATED:', '          GITHUB_TOKEN: ${{ github.token }}\n          CREATED:'), /explicit token outside the expected form/],
    ['a workflow_dispatch trigger', edit('    branches: [main]\n', '    branches: [main]\n  workflow_dispatch:\n'), /triggers are pull_request_target, workflow_dispatch/],
    ['an issue_comment trigger', edit('    branches: [main]\n', '    branches: [main]\n  issue_comment:\n'), /triggers are pull_request_target, issue_comment/],
    ['a pull_request trigger beside it', edit('  pull_request_target:\n', '  pull_request:\n  pull_request_target:\n'), /expected pull_request_target only/],
    ['the synchronize type', edit('types: [closed, labeled]', 'types: [closed, labeled, synchronize]'), /exactly the types \[closed, labeled\]/],
    ['any base branch', edit('    branches: [main]\n', '    branches: [main, "release/**"]\n'), /limited to branches: \[main\]/],
    ['a top-level write token', edit('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'), /top-level permissions must be exactly contents: read/],
    ['an extra write scope in the job', edit('      pull-requests: write\n', '      pull-requests: write\n      actions: write\n'), /permissions must be exactly contents: write, pull-requests: write/],
    ['write-all in the job', edit('      contents: write\n      pull-requests: write\n', '      write-all\n'), /permission/],
    ['a second job', `${text}  other:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n`, /single job backport/],
    ['the backport action by tag', edit(ACTION, 'korthout/backport-action@v5'), /not pinned by full commit SHA/],
    ['the app token action by tag', edit('actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510', 'actions/create-github-app-token@v3'), /not pinned by full commit SHA/],
    ['another action', edit(`      - name: Tell the maintainers`, `      - uses: actions/setup-node@${'a'.repeat(40)}\n      - name: Tell the maintainers`), /steps must be/],
    ['a step that builds the repository', edit('      - name: Tell the maintainers to start the CI\n', '      - run: npm ci\n      - name: Tell the maintainers to start the CI\n'), /steps must be/],
    ['a script that runs a file of the checkout', edit('          for number in $CREATED; do', '          bash scripts/test-local.sh\n          for number in $CREATED; do'), /runs something of the checkout/],
    ['a script that runs node', edit('          for number in $CREATED; do', '          node tools/x.ts\n          for number in $CREATED; do'), /runs something of the checkout/],
    ['a gate that no longer needs a merge', edit('      github.event.pull_request.merged == true &&\n', ''), /if: must be exactly/],
    ['a gate that no longer needs the label', edit("      contains(github.event.pull_request.labels.*.name, 'semver: patch') &&\n", ''), /if: must be exactly/],
    ['a gate that accepts any label added later', edit("github.event.label.name == 'semver: patch'", "github.event.label.name != ''"), /if: must be exactly/],
    ['no gate', edit(/ {4}if: >-\n(?: {6}.*\n)+/.exec(text)?.[0] ?? '', ''), /no job-level if/],
    ['a backport to main', edit('target_branches: release/0.1', 'target_branches: main'), /backport input target_branches/],
    ['a backport to another repository', edit('          git_committer_name: GitHub\n', '          git_committer_name: GitHub\n          experimental: \'{"downstream_repo": "x"}\'\n'), /backport input experimental is not allowed/],
    ['a backport of another pull request', edit('          git_committer_name: GitHub\n', '          git_committer_name: GitHub\n          source_pr_number: 1\n'), /source_pr_number is not allowed/],
    ['another committer', edit('git_committer_email: noreply@github.com', 'git_committer_email: bot@example.com'), /git_committer_email/],
    ['a backport label other than semver: patch', edit('add_labels: "semver: patch"', 'add_labels: "semver: minor"'), /add_labels/],
    ['a description without the reference', edit('Backport of #${pull_number}', 'Backported'), /pull_description must say/],
    ['the app token for any repository', edit('          private-key: ${{ secrets.BACKPORT_APP_PRIVATE_KEY }}\n', '          private-key: ${{ secrets.BACKPORT_APP_PRIVATE_KEY }}\n          owner: Session-Mesh\n'), /takes app-id and private-key only/],
    ['an unguarded app token step', edit("        if: env.HAS_APP_TOKEN == 'true'\n", ''), /guarded by if: env\.HAS_APP_TOKEN/],
    ['the app token without its guard variable', edit("HAS_APP_TOKEN: ${{ secrets.BACKPORT_APP_ID != '' && secrets.BACKPORT_APP_PRIVATE_KEY != '' }}", "HAS_APP_TOKEN: ${{ secrets.BACKPORT_APP_ID != '' }}"), /env HAS_APP_TOKEN must be/],
    ['a self-hosted runner', edit('runs-on: ubuntu-24.04', 'runs-on: self-hosted'), /self-hosted runner/],
    ['an ignored failure', edit('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    continue-on-error: true\n'), /continue-on-error/],
  ];
  for (const [label, workflow, pattern] of faults) {
    test(`rejects ${label}`, () => {
      const found = problems(workflow);
      assert.ok(pattern.test(found), `not reported (${pattern}):\n${found || '(no problem)'}`);
    });
  }
});
