# Contributing to session-mesh

Thank you for considering a contribution. session-mesh is an alpha project developed in public by
two maintainers, Mathias Bourgoin and Julien Tesson. This page says what a pull request needs to be
merged: the technical rules, and the contributor license agreement (CLA) that every contributor
accepts once, by adding a line to [CLA-SIGNATORIES.md](CLA-SIGNATORIES.md) in a commit of their own.

For a vulnerability, do not open an issue or a pull request: follow [SECURITY.md](SECURITY.md).

## Before you start

For anything larger than a small fix, open an issue first and describe the problem and the change
you have in mind. The project has strong opinions about its trust boundaries
([SECURITY.md](SECURITY.md#threat-model)), and a short discussion avoids work that cannot be merged.

## Technical rules

### No new Python

The project is moving away from Python. **Do not add Python files, modules or scripts.** New code and
new tests are written in **OCaml** (under `ocaml/`, built with dune) or **TypeScript** (run by Node's
type stripping, for example the tests in `tests/*.test.ts`). A small fix inside an existing Python
file is acceptable when it is needed; write its test in OCaml or TypeScript when that is practical.

### Tests

- Add or update tests with every behaviour change. Node tests are found by name
  (`tests/**/*.test.{ts,mjs,cjs}`), so a new test file needs no registration.
- Before opening a pull request, run the complete local suite:

  ```sh
  scripts/test-local.sh --preflight-only   # prerequisites: Node 22.13+ or 24+, npm, git, opam, Python 3, bubblewrap
  scripts/test-local.sh
  ```

  [docs/development.md](docs/development.md) explains how it finds Python, Chromium and the opam
  switch.
- The public CI (`.github/workflows/public-ci.yml`) runs the same suite on every pull request, plus a
  leak check of the tree and the [CLA check](#the-cla-check-blocks-the-merge). It must pass before a
  merge.
- Interface text goes through the catalogs in `static/i18n/`, never as a literal in the interface
  files. Tests check that every key used by the interface exists and that `en.json` and `fr.json`
  have the same keys: add each new key to both (ask in the pull request if you need help with the
  French text).

### Which PTY host the tests run

The tests that start the native PTY host (pytest, the Node tests, `scripts/preprod.sh`,
`scripts/test-ptyhost-t41.sh`) read one variable: `MESH_PTYHOST_CMD`, **the absolute path of the
`mesh-ptyhost` executable, and nothing else**. No arguments, no quotes, no shell: the value is used
as one path, so a directory name with spaces works. When it is unset they run `mesh-ptyhost` from
`PATH`; when neither exists they fail with a message naming the variable, they do not skip. To run
tests by hand against a build:

```sh
export MESH_PTYHOST_CMD="$PWD/ocaml/_build/default/bin/mesh_ptyhost_main.exe"
```

CI writes the plain path of the host its `native` job built.

The lifecycle replay test of the native host (`test_generated_itf_replay_is_explicit_and_fail_closed`
in `tests/test_ptyhost_t42.py`) also needs the OCaml executable
`ocaml/_build/default/mesh_wire/test/ptyhost_lifecycle_itf.exe`, which `scripts/bootstrap.sh` builds.
Without it the test is skipped, unless `MESH_REQUIRE_ITF_ADAPTER=1` is set, in which case it fails.
`scripts/test-ptyhost-t41.sh` sets it, so the `ocaml` job of the public CI cannot skip the test.

### Commits and identity

- Your commit author name and e-mail address become public, permanently, in the repository history.
  Use an identity you are happy to publish; GitHub's `users.noreply.github.com` address is a good
  choice, and the CLA check expects the same address in [CLA-SIGNATORIES.md](CLA-SIGNATORIES.md).
  Do not put other e-mail addresses, machine names, personal paths, tokens or Tailscale host names
  in commits or files.
- The repository has a leak check you can run before pushing, with its public rules:

  ```sh
  node --experimental-strip-types tools/leak-guard/cli.ts worktree
  ```

  This is the check the public CI runs on the files of your pull request.
  `tools/leak-guard/cli.ts hooks install` also installs Git hooks (Git 2.54 or later,
  [tools/leak-guard/README.md](tools/leak-guard/README.md#hooks)) that check each commit message
  and identity. **The hooks are optional for contributors:** they refuse a commit that leaks
  something (the same content rules as above, agent session ids included) or whose author or
  committer address is not a GitHub noreply address. Neither is required of your pull request;
  the CI does not read commit messages.
- The description of your pull request is checked too, with the same content rules (no personal
  e-mail address, home path, tailnet address or name, token), and the CI warns on a finding: it
  shows warnings on the check and in its summary, and does not block the merge. The comment at the
  top of the pull request template says what to leave out. To check a description before you post
  it, save it to a file and run:

  ```sh
  node --experimental-strip-types tools/leak-guard/cli.ts pr-body description.md
  ```
- A `Signed-off-by` line (Developer Certificate of Origin) is **not required**: the CLA below already
  covers the origin of your contribution, and a sign-off would publish one more e-mail address.
- Write commit messages in English, describing what changed and why.
- You may use AI tools to prepare a contribution. By accepting the CLA you state that you have the
  right to submit everything in it, including what such a tool produced, and you answer for it as for
  any other contribution. AI attribution lines (for example "Generated with ...") are welcome in commit messages and pull
  request descriptions.

### Branches and versions

Every pull request targets `main`, whatever it changes. Releases of a series that is already
published (0.1.x while `main` prepares 0.2) are cut from a maintenance branch, `release/0.1`,
which was created from the tag `v0.1.0`. A contributor never opens a pull request against it by
hand for a normal fix: it is filled by backports.

- **One label per pull request.** A pull request to `main` carries exactly one of
  `semver: patch` (a fix that the maintenance branch should also get) and `semver: minor`
  (everything else: features, changes, documentation and CI that belong to the next minor
  version). The check `semver label` fails without exactly one, and runs again when a label
  changes. A maintainer sets the label if you cannot.
- **Backport.** When a pull request labelled `semver: patch` is merged to `main` (or receives the
  label after it was merged), a workflow cherry-picks its commits onto a branch from `release/0.1`
  and opens the pull request `[0.1] <original title>`, labelled `semver: patch`, whose description
  says `Backport of #<number>`. It is reviewed and merged like any other pull request, with
  "Rebase and merge". When a cherry-pick conflicts, the workflow comments on the original pull
  request with the commands to do it by hand: open that pull request to `release/0.1` yourself,
  keep the label and the line `Backport of #<number>`.
- **The guard.** A pull request whose base is `release/**` must carry `semver: patch` and
  reference, with `Backport of #<number>`, a pull request merged to `main` that carries
  `semver: patch` too; the check `release branch guard` fails otherwise. A fix that only concerns
  the maintenance branch is first made on `main` when the code exists there.
- **Tags.** A tag `v0.1.x` is pushed on a commit of `release/0.1`; the release workflow accepts a
  tag on `main` or on the release branch of its series, and publishes a version older than the
  current latest release without marking it "latest".
- **Site and changelog.** The showcase site is deployed from `main` only: a release of a
  maintenance branch is added to `site/releases.json` by a pull request to `main` (label
  `semver: minor`, since the site is not backported), with its `CHANGELOG.md` heading.

The public CI runs on every push to `release/**` as it does on `main`, and CodeRabbit reviews
pull requests to `release/**`. The maintainers' setup of the backport workflow is in
[docs/development.md](docs/development.md#backports-to-the-maintenance-branch).

### How a pull request is merged

Pull requests are merged with **"Rebase and merge" only**: GitHub replays the commits of the pull
request, one by one (it drops the commits that are empty), on top of `main`. The branch rule of `main` also requires the branch to be **up
to date with `main`** before it is merged. So a pull request is a straight line of ordinary commits
on top of the tip of `main`:

- **No merge commits.** A rebase drops them, so what they change would not be what lands; the
  [CLA check](#the-cla-check-blocks-the-merge) refuses a pull request that contains one.
- **Update your branch by rebasing it**, never by merging `main` into it. On GitHub, use the
  **"Update with rebase"** choice of the "Update branch" button, not the plain "Update branch",
  which creates a merge commit. Locally:

  ```sh
  git fetch origin
  git rebase origin/main
  git push --force-with-lease
  ```

- **The merge rewrites your commits**: on `main` they have new ids, the maintainer who integrates
  the pull request is the committer (with the commit address of their account), and the new commits
  are not signed. Your author name and address stay. The "Verified" mark of a signed commit is
  therefore shown on the commits of the pull request, not on the ones that land on `main`. (The
  committer `GitHub <noreply@github.com>` comes from a squash merge or from an edit in the web
  interface, not from "Rebase and merge".)

## Contributor license agreement

Every contribution is accepted under the agreement in [CLA.md](CLA.md). You keep the copyright on
your work: the agreement grants licenses, it is not a transfer of ownership. The maintainers do not
sign it; its section 12 binds them among themselves.

What it does, in short (the text in [CLA.md](CLA.md) is what counts):

- You license your contribution to everyone who receives it under the project's license,
  AGPL-3.0-or-later, as with any contribution to an AGPL project.
- You also grant Atacama, and only Atacama, a broad copyright license with the right to
  sublicense, including under licenses other than the AGPL. This lets the project change its license
  later without finding and asking every past contributor. Distributing contributions under another
  license than the project's needs the agreement of every maintainer in office. In return, Atacama and the
  maintainers undertake that every distribution of your contribution is also made under the
  project's license in force when you contributed it.
- You grant a patent license to Atacama and to everyone who receives the project, under its
  license or under a license Atacama chose as the agreement allows.
- Your acceptance covers all your contributions to the project, including those you made before
  adding your line.

**The agreement was not reviewed by a lawyer**, and it does not choose a governing law. If you or
your employer need a reviewed agreement before contributing, say so in an issue.

### How to accept it

Add your line to the table in [CLA-SIGNATORIES.md](CLA-SIGNATORIES.md), **in a commit whose author
address is the one the line gives**:

```text
| Your public name | ID+login@users.noreply.github.com | 1.0 | 2026-11-20 |
```

The four fields are your public name, the e-mail address of your commits, the version of the
agreement you accept and the date. The line can go in the same commit as your contribution, or in
another commit of the same pull request, for example after the check has failed. The line and the
commit that added it, kept in the repository history, are the record of your acceptance; no external
service is involved.

- **Use your GitHub noreply address** (`ID+login@users.noreply.github.com`, shown in your GitHub
  e-mail settings) for both the commits and the line, so that no personal address is published. Set
  it with `git config user.email` in your clone before your first commit.
- **Sign your commits** (GPG or SSH, shown as "Verified" by GitHub on the pull request):
  recommended, not required. See the limit below.
- **Keep the table in alphabetical order** of public name: insert your line in its place rather than
  at the end. In a local rebase, `.gitattributes` merges this file by keeping both sides' lines, so
  a branch that adds a line does not conflict with another line added on `main`. GitHub is not
  guaranteed to do the same: if it reports a conflict on this file, rebase your branch locally as
  shown [above](#how-a-pull-request-is-merged), check that the other lines are as they are on
  `main`, and push again.
- **One line covers all your contributions** under the same version, from every pull request. Add
  one line for each address you commit with.
- **A new version of the agreement** gets a new number and a new dated section in [CLA.md](CLA.md);
  version 1.0 is never edited. Contributions made after a new version ask you to add a line naming
  it, the same way.
- **Contributions reach the project through pull requests.** If you propose code or text in an
  issue, open a pull request with it, with your line.

### The CLA check blocks the merge

The public CI runs the check `cla` on every pull request, and the branch rule of `main` requires it:
**a pull request that fails it cannot be merged.** The check judges what the pull request would
leave on `main`, and verifies three things. Its exact rules are in
[tools/cla-check/SPEC.md](tools/cla-check/SPEC.md).

1. **A straight line on `main`.** The pull request has no merge commit and no commit without a
   parent, and its branch contains the tip of `main`. Otherwise the check asks you to rebase your
   branch on `main` ([how](#how-a-pull-request-is-merged)). Only then is what the check judges what
   "Rebase and merge" lands.
2. **Identities.** For each commit of the pull request, the author address, and the committer
   address, must be a maintainer's or have a line in `CLA-SIGNATORIES.md` as the pull request would
   leave it.
3. **Integrity of the register.** A line the pull request adds to `main` must be added by one of its
   commits whose author address is the line's: each contributor adds their own line, and a line
   added for you by someone else is refused. A line it removes or changes must be removed by a
   commit of its holder or of a maintainer; a maintainer's correction keeps the line's address. If
   a rebase on `main` brought back or dropped another line, leave the other lines as they are on
   `main`.

- A line counts only as a table row outside code blocks and HTML comments, with your address (in
  printable ASCII), a published version of the agreement and a real date.
- Removing your own line does not revoke the licenses you granted: section 2 of the agreement makes
  them irrevocable for what you already contributed. It only makes the check refuse your later
  pull requests until you add a line again.
- The maintainers' commit addresses are in [tools/cla-check/MAINTAINERS](tools/cla-check/MAINTAINERS),
  and nowhere else; the check reads the copy on `main`. That file, the "Maintainers" list of
  [CONTRIBUTORS.md](CONTRIBUTORS.md) and [.github/CODEOWNERS](.github/CODEOWNERS) change together,
  in the same commit; a test compares them.

- The committer address counts too. If you rebase or amend with another address, sign it as well or
  rewrite the commits with your signed address.
- Commits made in GitHub's web interface have `GitHub <noreply@github.com>` as committer, which is
  accepted; their author is your account's address, which must be signed. With "Keep my email
  addresses private" on, that is your noreply address.
- When the check fails, it prints only the refused addresses and the commits at fault. Add the
  missing line, or fix the commit identities, and push again.

### What the check cannot see

- **`Co-authored-by` lines are not read.** The check judges the author and committer addresses of
  each commit only; an address named in a `Co-authored-by` trailer is neither checked nor required
  to have signed.
- **Git does not verify author addresses.** Anyone can write a commit with someone else's address,
  and the check only reads addresses. Before merging, a maintainer checks that the GitHub account
  that opened the pull request is the one behind each address its commits use (a noreply address
  names its account); a commit signature shown as "Verified" makes this check immediate. This
  matters most for a maintainer's address: the check accepts it without a line, and lets it remove
  or correct any line, so a commit that carries one must come from that maintainer's account.
- **The check runs the copy of `tools/cla-check/cla-check.ts` on `main`**, with the list of
  maintainers on `main`, never the ones in the pull request, so editing them in a pull request
  changes nothing until it is merged. A pull request can still edit the workflow file that calls
  the checker, and once merged a change to the checker applies. No rule of `main` blocks either:
  the branch rule requires the check `cla` and the CI, not a review by the code owners.
  [.github/CODEOWNERS](.github/CODEOWNERS) only makes GitHub ask the maintainers for a review
  when a pull request touches `.github/`, `tools/cla-check/`, `CLA.md`, `CLA-SIGNATORIES.md`,
  `CONTRIBUTORS.md` or `.gitattributes`. What covers these changes is the maintainers reading
  the pull request before they merge it.
- **The check judges the pull request as it was when the check ran.** If `main` changes
  afterwards, the branch is no longer up to date and cannot be merged until it is rebased, which
  runs the check again. Changing the base branch of a pull request also runs it again; until that
  run starts, the result shown is the one against the former base.

## Contributors

Contributors are listed in [CONTRIBUTORS.md](CONTRIBUTORS.md). After your first merged contribution,
a maintainer adds your name there, unless you ask not to be listed.
