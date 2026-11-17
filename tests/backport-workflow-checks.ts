// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The checks of the `backport` profile (.github/workflows/backport.yml), applied by checkWorkflow of
// tests/public-ci-workflow-checks.ts on top of the rules every profile shares (pinned actions, GitHub's
// runner, no private leak rules, bounded jobs). That workflow is the one that runs on
// `pull_request_target` and holds a write token, so these checks keep it from ever running code of
// a pull request: the trigger is exactly `pull_request_target` [closed, labeled] on main; the
// token is read-write in one job only, in exactly the two scopes a backport needs; the checkout is
// the base branch (no ref, no other repository); only three actions run, with the inputs this file
// names; the only script comments with `gh` and runs nothing of the checkout; the secrets are
// the two of the GitHub App and appear nowhere else; the event is read for a few booleans, numbers
// and label names, never for text a contributor writes.
import {blockOf, continuation, expressions, githubProperties, jobBlocks, type Line, permissionValues, stepOf, usesOf}
  from './public-ci-workflow-lib.ts';

export const BACKPORT_JOB = 'backport';
export const BACKPORT_TARGET = 'release/0.1';
export const BACKPORT_LABEL = 'semver: patch';
export const BACKPORT_WRITE_SCOPES = ['contents', 'pull-requests'];
export const BACKPORT_SECRETS = ['BACKPORT_APP_ID', 'BACKPORT_APP_PRIVATE_KEY'];
// The gate of the job: merged, labelled, and either the merge itself or the label added afterwards.
export const BACKPORT_CONDITION = "github.event.pull_request.merged == true && " +
  `contains(github.event.pull_request.labels.*.name, '${BACKPORT_LABEL}') && ` +
  `(github.event.action == 'closed' || github.event.label.name == '${BACKPORT_LABEL}')`;
// What the workflow may read of the event: no title, description, branch name or user.
export const BACKPORT_EVENT_PATHS = ['pull_request.merged', 'pull_request.labels.*.name', 'pull_request.number', 'action', 'label.name'];
export const BACKPORT_TOKEN = '${{ steps.app-token.outputs.token || github.token }}';
const HAS_APP_TOKEN = "${{ secrets.BACKPORT_APP_ID != '' && secrets.BACKPORT_APP_PRIVATE_KEY != '' }}";
const APP_TOKEN_ACTION = 'actions/create-github-app-token';
const CHECKOUT_ACTION = 'actions/checkout';
const BACKPORT_ACTION = 'korthout/backport-action';
const SCRIPT_TOKEN_LINE = /^\s+GH_TOKEN: \$\{\{ github\.token \}\}\s*$/;
const TOKEN_INPUT_LINE = /^\s+(?:token|github_token): \$\{\{ steps\.app-token\.outputs\.token \|\| github\.token \}\}\s*$/;
const SECRET_LINES = new Map<RegExp, string>([
  [/^\s+HAS_APP_TOKEN: \$\{\{ secrets\.BACKPORT_APP_ID != '' && secrets\.BACKPORT_APP_PRIVATE_KEY != '' \}\}\s*$/, 'the job env'],
  [/^\s+app-id: \$\{\{ secrets\.BACKPORT_APP_ID \}\}\s*$/, APP_TOKEN_ACTION],
  [/^\s+private-key: \$\{\{ secrets\.BACKPORT_APP_PRIVATE_KEY \}\}\s*$/, APP_TOKEN_ACTION],
]);

const isComment = (line: Line): boolean => /^\s*#/.test(line.raw);
const jobLines = (lines: Line[]): Line[] => jobBlocks(lines).find((job) => job.name === BACKPORT_JOB)?.block ?? [];
// The action a step uses, without its version.
const actionOf = (step: Line[]): string | undefined => step.flatMap(usesOf)[0]?.split('@')[0];

function steps(lines: Line[]): Line[][] {
  return jobLines(lines).filter((line) => /^\s*-\s/.test(line.text) && line.indent === 6).map((line) => stepOf(lines, lines.indexOf(line)));
}

// The direct inputs of a step's `with:` block.
function inputs(lines: Line[], step: Line[]): Map<string, Line> {
  const withLine = step.find((line) => line.key === 'with');
  if (!withLine) return new Map();
  const block = blockOf(lines, lines.indexOf(withLine));
  const column = Math.min(...block.map((line) => line.column));
  return new Map(block.filter((line) => line.column === column && line.key).map((line) => [line.key as string, line]));
}

// Only the two secrets of the GitHub App, on the three lines that read them, and the run's token
// only where it is handed to a step: as `token`/`github_token` of the checkout and of the backport
// action, as `GH_TOKEN` of the script step.
export function checkBackportSecrets(lines: Line[]): string[] {
  const problems: string[] = [];
  const job = steps(lines);
  for (const line of lines.filter((item) => !isComment(item))) {
    if (line.key === 'secrets') problems.push(`line ${line.number}: secrets passed on`);
    if (/\$\{\{[^}]*\bsecrets\b/i.test(line.raw)) {
      const matched = [...SECRET_LINES.entries()].find(([pattern]) => pattern.test(line.raw));
      const step = job.find((item) => item.includes(line));
      if (!matched) problems.push(`line ${line.number}: secret read outside the expected form`);
      else if (matched[1] === APP_TOKEN_ACTION && (!step || actionOf(step) !== APP_TOKEN_ACTION)) {
        problems.push(`line ${line.number}: secret handed to a step other than ${APP_TOKEN_ACTION}`);
      }
    }
    if (/\bgithub\.token\b|\bGITHUB_TOKEN\b/i.test(line.raw)) {
      const step = job.find((item) => item.includes(line));
      const handed = TOKEN_INPUT_LINE.test(line.raw) && step !== undefined && [CHECKOUT_ACTION, BACKPORT_ACTION].includes(actionOf(step) ?? '');
      const forScript = SCRIPT_TOKEN_LINE.test(line.raw) && step !== undefined && actionOf(step) === undefined && step.some((item) => item.key === 'run');
      if (!handed && !forScript) problems.push(`line ${line.number}: explicit token outside the expected form`);
    }
  }
  for (const {number, body} of expressions(lines)) {
    if (/\bsecrets\b(?!\.(?:BACKPORT_APP_ID|BACKPORT_APP_PRIVATE_KEY)\b)/i.test(body)) {
      problems.push(`line ${number}: secret other than ${BACKPORT_SECRETS.join(' and ')}`);
    }
    if (githubProperties(body).includes('token') && !/\bgithub\.token\b/.test(body)) problems.push(`line ${number}: explicit token`);
  }
  return problems;
}

// The event is read for the paths of BACKPORT_EVENT_PATHS only, by dots: a title, a description, a
// branch name or a user name never enters an expression. No part of the pull request's head is
// named anywhere, comments aside.
export function checkBackportEvent(lines: Line[]): string[] {
  const problems: string[] = [];
  for (const {number, body} of expressions(lines)) {
    const properties = githubProperties(body);
    if (properties.includes(null)) problems.push(`line ${number}: github context read whole or by a computed index`);
    if (properties.includes('head_ref')) problems.push(`line ${number}: untrusted event data in an expression (head_ref)`);
    const reads = [...body.matchAll(/(?<![\w.-])github\.event\.([\w.*-]+)/g)].map((match) => match[1]);
    if (reads.length !== properties.filter((name) => name === 'event').length) {
      problems.push(`line ${number}: github.event read in a form other than github.event.<path>`);
    }
    for (const path of reads.filter((item) => !BACKPORT_EVENT_PATHS.includes(item))) {
      problems.push(`line ${number}: untrusted event data in an expression (github.event.${path})`);
    }
  }
  for (const line of lines.filter((item) => !isComment(item))) {
    if (/refs\/pull\/|\bhead\.(?:sha|ref|repo)\b|\bhead_ref\b|\bpull_request\.head\b/.test(line.raw)) {
      problems.push(`line ${line.number}: the pull request's head is named`);
    }
  }
  return problems;
}

// `pull_request_target` on main for `closed` and `labeled`, and nothing else.
export function checkBackportTriggers(lines: Line[]): string[] {
  const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
  if (onIndex < 0) return ['no on: block'];
  const triggers = blockOf(lines, onIndex).filter((line) => line.indent === 2);
  const problems: string[] = [];
  const names = triggers.map((line) => line.key).join(', ');
  if (names !== 'pull_request_target') problems.push(`triggers are ${names || '(none)'}, expected pull_request_target only`);
  const trigger = triggers.find((line) => line.key === 'pull_request_target');
  const keys = trigger ? blockOf(lines, lines.indexOf(trigger)).filter((line) => line.indent === 4) : [];
  const value = (key: string): string | undefined => keys.find((line) => line.key === key)?.value;
  if (keys.length !== 2 || value('types') !== '[closed, labeled]') problems.push('pull_request_target must have exactly the types [closed, labeled] and a branches filter');
  if (value('branches') !== '[main]') problems.push('pull_request_target must be limited to branches: [main]');
  return problems;
}

// One job; the token is read-only above it and, in the job, write for the two scopes only.
export function checkBackportPermissions(lines: Line[]): string[] {
  const problems: string[] = [];
  const jobs = jobBlocks(lines);
  if (jobs.length !== 1 || jobs[0].name !== BACKPORT_JOB) problems.push(`the workflow must have the single job ${BACKPORT_JOB}`);
  const inJob = new Set(jobLines(lines));
  const top = lines.findIndex((line) => line.indent === 0 && line.key === 'permissions');
  const topValues = top < 0 ? [] : permissionValues(lines, top);
  if (topValues.length !== 1 || topValues[0].scope !== 'contents' || topValues[0].value !== 'read') problems.push('the top-level permissions must be exactly contents: read');
  const own = lines.filter((line) => line.key === 'permissions' && inJob.has(line));
  if (own.length !== 1) return [...problems, `job ${BACKPORT_JOB}: exactly one permissions block expected`];
  const granted = permissionValues(lines, lines.indexOf(own[0])).map(({scope, value}) => `${scope}: ${value}`).sort();
  const expected = BACKPORT_WRITE_SCOPES.map((scope) => `${scope}: write`).sort();
  if (granted.join(', ') !== expected.join(', ')) problems.push(`job ${BACKPORT_JOB}: permissions must be exactly ${expected.join(', ')}`);
  return problems;
}

function checkBackportGate(lines: Line[]): string[] {
  const index = lines.findIndex((line) => line.key === 'if' && line.indent === 4 && jobLines(lines).includes(line));
  if (index < 0) return [`job ${BACKPORT_JOB}: no job-level if:`];
  const condition = [lines[index].value, ...continuation(lines, index).map((item) => item.raw.trim())].join(' ').replace(/^[>|][-+]?\s*/, '').trim();
  return condition === BACKPORT_CONDITION ? [] : [`job ${BACKPORT_JOB}: if: must be exactly ${BACKPORT_CONDITION}`];
}

function checkCheckout(lines: Line[], step: Line[]): string[] {
  const given = inputs(lines, step);
  const problems = [...given.keys()].filter((key) => key !== 'token').map((key) => `line ${given.get(key)?.number}: checkout input ${key}: only the base branch, with the token, may be checked out`);
  if (!given.get('token') || !TOKEN_INPUT_LINE.test(given.get('token')?.raw ?? '')) problems.push(`line ${step[0].number}: checkout token must be ${BACKPORT_TOKEN}`);
  return problems;
}

function checkAppToken(lines: Line[], step: Line[]): string[] {
  const given = [...inputs(lines, step).keys()].sort().join(', ');
  const guarded = step.some((line) => line.key === 'if' && line.value === "env.HAS_APP_TOKEN == 'true'");
  return [...(given === 'app-id, private-key' ? [] : [`line ${step[0].number}: ${APP_TOKEN_ACTION} takes app-id and private-key only (the token stays scoped to this repository), got ${given || 'none'}`]),
    ...(guarded ? [] : [`line ${step[0].number}: the app token step must be guarded by if: env.HAS_APP_TOKEN == 'true'`])];
}

// The inputs that make a backport do something else than the pull request to release/0.1.
const FORBIDDEN_BACKPORT_INPUTS = ['experimental', 'source_pr_number', 'target_branches_by_label', 'label_pattern'];

function checkBackportAction(lines: Line[], step: Line[]): string[] {
  const given = inputs(lines, step);
  const problems = FORBIDDEN_BACKPORT_INPUTS.filter((key) => given.has(key)).map((key) => `line ${given.get(key)?.number}: backport input ${key} is not allowed`);
  const expected: [string, (value: string) => boolean][] = [
    ['target_branches', (value) => value === BACKPORT_TARGET], ['add_labels', (value) => value === BACKPORT_LABEL],
    ['pull_title', (value) => value.startsWith('[0.1] ')], ['git_committer_name', (value) => value === 'GitHub'],
    ['git_committer_email', (value) => value === 'noreply@github.com']];
  for (const [key, valid] of expected) {
    if (!given.has(key) || !valid(given.get(key)?.value ?? '')) problems.push(`line ${step[0].number}: backport input ${key} missing or not as expected`);
  }
  if (!TOKEN_INPUT_LINE.test(given.get('github_token')?.raw ?? '')) problems.push(`line ${step[0].number}: github_token must be ${BACKPORT_TOKEN}`);
  const description = given.get('pull_description');
  const text = description ? [description, ...continuation(lines, lines.indexOf(description))].map((line) => line.raw).join('\n') : '';
  if (!text.includes('Backport of #${pull_number}')) problems.push(`line ${step[0].number}: pull_description must say "Backport of #\${pull_number}" (the release branch guard reads it)`);
  return problems;
}

// The steps: the app token, the checkout, the backport, then the comment script; nothing else.
// The one `run` script runs no file of the checkout.
function checkBackportSteps(lines: Line[]): string[] {
  const problems: string[] = [];
  const job = steps(lines);
  const order = job.map((step) => actionOf(step) ?? 'run');
  const expected = [APP_TOKEN_ACTION, CHECKOUT_ACTION, BACKPORT_ACTION, 'run'];
  if (order.join(', ') !== expected.join(', ')) problems.push(`job ${BACKPORT_JOB}: steps must be ${expected.join(', ')}, got ${order.join(', ') || 'none'}`);
  for (const step of job) {
    const action = actionOf(step);
    if (action === APP_TOKEN_ACTION) problems.push(...checkAppToken(lines, step));
    if (action === CHECKOUT_ACTION) problems.push(...checkCheckout(lines, step));
    if (action === BACKPORT_ACTION) problems.push(...checkBackportAction(lines, step));
    if (action !== undefined) continue;
    const script = step.filter((line) => line.inBlock).map((line) => line.raw.trim());
    for (const line of script.filter((item) => /(?:^|[\s;&|(])(?:\.\/|bash\b|sh\b|node\b|npm\b|npx\b|python\d*\b|source\b|eval\b|make\b|git\b)|\.\.?\//.test(item))) {
      problems.push(`job ${BACKPORT_JOB}: the script runs something of the checkout or a shell: ${line.slice(0, 60)}`);
    }
  }
  if (!jobLines(lines).some((line) => /^\s+HAS_APP_TOKEN: /.test(line.raw) && line.raw.trim() === `HAS_APP_TOKEN: ${HAS_APP_TOKEN}`)) {
    problems.push(`job ${BACKPORT_JOB}: env HAS_APP_TOKEN must be ${HAS_APP_TOKEN}`);
  }
  return problems;
}

export const BACKPORT_CHECKS: ((lines: Line[]) => string[])[] = [checkBackportGate, checkBackportSteps];
