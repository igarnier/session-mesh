// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Line-by-line reader of the public CI workflow, shared by tests/public-ci-workflow.test.ts and
// tests/public-ci-workflow-cla.test.ts. No YAML parser is available without a new dependency: the
// invariant checker refuses every construct this reader does not resolve.

// `text` has its comment stripped (structure only); `raw` is the line as written. Content checks
// (secrets, tokens, injection) read `raw`: inside a `run: |` block scalar a `#` is not a YAML
// comment, and GitHub substitutes `${{ }}` before the shell ever sees it. `column` is where the
// key starts (after a `- `); `inBlock` marks `|`/`>` block scalar content, taken literally.
export type Line = {number: number; indent: number; column: number; key: string | null; value: string; text: string; raw: string;
  inBlock: boolean};

// Drops a comment that starts the line or follows a space; the workflow quotes no `#`.
export function stripComment(raw: string): string {
  return raw.replace(/(^|\s)#.*$/, '').trimEnd();
}

export const BLOCK_SCALAR = /(?:^|[:-])\s+[|>][-+0-9]*$/;

export function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  let blockColumn = -1; // block scalar content is indented deeper than this column
  text.split('\n').forEach((raw, index) => {
    const rawIndent = raw.length - raw.trimStart().length;
    if (blockColumn >= 0 && (raw.trim() === '' || rawIndent > blockColumn)) {
      lines.push({number: index + 1, indent: rawIndent, column: rawIndent, key: null, value: '', text: raw.trimEnd(), raw,
        inBlock: true});
      return;
    }
    const content = stripComment(raw);
    const indent = content.length - content.trimStart().length;
    const match = /^(\s*(?:-\s+)?)([\w.-]+):(?:\s+(.*))?$/.exec(content);
    const column = match ? match[1].length : indent;
    blockColumn = BLOCK_SCALAR.test(content) ? column : -1;
    lines.push({number: index + 1, indent, column, key: match ? match[2] : null, value: unquote(match?.[3] ?? ''),
      text: content, raw, inBlock: false});
  });
  return lines;
}

// Lines continuing the value of the line at `start` (blank, or deeper than its key).
export function continuation(lines: Line[], start: number): Line[] {
  const owner = lines[start];
  const result: Line[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.text.trim() !== '' && line.indent <= owner.column) break;
    result.push(line);
  }
  return result;
}

export function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

// Lines nested under the line at `start` (deeper indentation), blank lines skipped.
export function blockOf(lines: Line[], start: number): Line[] {
  const owner = lines[start];
  const ownerIndent = /^\s*-\s/.test(owner.text) ? owner.indent + 1 : owner.indent;
  const block: Line[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.text.trim() === '') continue;
    if (line.indent <= ownerIndent) break;
    block.push(line);
  }
  return block;
}

// Every `uses:` of a line, block form (`- uses: x`) or flow mapping (`- {uses: x, ...}`).
export function usesOf(line: Line): string[] {
  return [...line.text.matchAll(/(?:^|[\s{,])uses\s*:\s*(['"]?)([^\s,}'"]+)\1/g)].map((match) => match[2]);
}

// The step mapping holding the line at `index`: its `- ` line and the lines nested under it.
export function stepOf(lines: Line[], index: number): Line[] {
  const column = lines[index].column;
  for (let start = index; start >= 0; start--) {
    const line = lines[start];
    if (line.inBlock || line.text.trim() === '') continue;
    if (/^\s*-\s/.test(line.text) && line.column === column) return [line, ...blockOf(lines, start)];
    if (line.indent < column) break;
  }
  return [lines[index]];
}

export function jobBlocks(lines: Line[]): {name: string; block: Line[]}[] {
  const jobsIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'jobs');
  if (jobsIndex < 0) return [];
  const jobs = blockOf(lines, jobsIndex);
  const jobIndent = jobs[0]?.indent;
  return jobs.filter((line) => line.indent === jobIndent && line.key)
    .map((line) => ({name: line.key as string, block: blockOf(lines, lines.indexOf(line))}));
}

// The highest timeout-minutes of a public workflow job: a safety net that ends a hung job, not a
// duration budget (public-ci targets 10 minutes per job). The release build jobs have their own cap.
export const MAX_TIMEOUT_MINUTES = 45;

// The scopes and values of the `permissions:` key at `index` (flow map, single value or block).
export function permissionValues(lines: Line[], index: number): {scope: string; value: string; number: number}[] {
  const line = lines[index];
  if (line.value.startsWith('{')) {
    return line.value.slice(1, -1).split(',').filter((pair) => pair.trim() !== '').map((pair) => {
      const [scope, value = ''] = pair.split(':').map((part) => part.trim());
      return {scope, value: unquote(value), number: line.number};
    });
  }
  if (line.value !== '') return [{scope: '*', value: line.value, number: line.number}];
  return blockOf(lines, index).map((item) => ({scope: item.key ?? item.text.trim(), value: item.value, number: item.number}));
}

// Every job has a timeout-minutes within 1..capOf(job).
export function timeoutProblems(lines: Line[], capOf: (job: string) => number): string[] {
  const problems: string[] = [];
  for (const {name, block} of jobBlocks(lines)) {
    const timeout = block.find((line) => line.key === 'timeout-minutes');
    const minutes = Number(timeout?.value);
    const cap = capOf(name);
    if (!timeout) problems.push(`job ${name}: no timeout-minutes`);
    else if (!Number.isInteger(minutes) || minutes <= 0 || minutes > cap) {
      problems.push(`job ${name}: timeout-minutes ${timeout.value} outside 1..${cap}`);
    }
  }
  return problems;
}

// The `run: |` script holding the line at `index`: the raw text of its block scalar.
export function scriptOf(lines: Line[], index: number): string {
  let start = index;
  let end = index;
  while (start > 0 && lines[start - 1].inBlock) start--;
  while (end + 1 < lines.length && lines[end + 1].inBlock) end++;
  return lines.slice(start, end + 1).map((line) => line.raw).join('\n');
}

// The shell command starting at `index`, with its backslash continuation lines.
export function commandAt(lines: Line[], index: number): string {
  const parts = [lines[index].raw];
  for (let next = index; lines[next].raw.trimEnd().endsWith('\\') && next + 1 < lines.length; next++) parts.push(lines[next + 1].raw);
  return parts.join('\n');
}

// Every `${{ ... }}` of the raw text (comments included, possibly spanning lines), and every
// `if:` value with its continuation lines (folded `>-` included), which GitHub evaluates as an
// expression even without `${{ }}`.
export function expressions(lines: Line[]): {number: number; body: string}[] {
  const text = lines.map((line) => line.raw).join('\n');
  const found: {number: number; body: string}[] = [];
  for (const match of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    found.push({number: text.slice(0, match.index).split('\n').length, body: match[1]});
  }
  lines.forEach((line, index) => {
    if (line.key !== 'if') return;
    found.push({number: line.number, body: [line.value, ...continuation(lines, index).map((item) => item.raw)].join('\n')});
  });
  return found;
}

// Property names read from the `github` context in an expression (case-insensitive, as GitHub
// reads them); null when the context is used whole (`toJSON(github)`) or by a computed index.
export function githubProperties(body: string): (string | null)[] {
  return [...body.matchAll(/(?<![\w.-])github\b/gi)].map((match) => {
    const rest = body.slice((match.index ?? 0) + match[0].length);
    const property = /^\s*(?:\.\s*([\w-]+)|\[\s*(['"])(.*?)\2\s*\])/.exec(rest);
    return property ? (property[1] ?? property[3]).toLowerCase() : null;
  });
}
