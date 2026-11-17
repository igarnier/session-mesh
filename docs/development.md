# Development and tests

This page is for contributors: how to run the test suite locally and what it needs on a fresh
machine. The rules for contributions (languages, commits, the CLA) are in
[CONTRIBUTING.md](../CONTRIBUTING.md); a development install from a clone is in
[install.md](install.md#other-ways-to-install).

## Running the suite

`scripts/test-local.sh` runs the complete local suite: frontend checks, the OCaml build and its
tests (which installs the native PTY host that the other tests start), Node tests, `ruff`, the
Python suite including browser tests, then the gate of the native PTY host. The tests that start
the host take it from `MESH_PTYHOST_CMD` (the absolute path of the executable, nothing else), else
`mesh-ptyhost` on `PATH`, and fail with a message naming both when neither exists; to run `pytest`
or the Node tests by hand, point it at a build:
`MESH_PTYHOST_CMD="$PWD/ocaml/_build/default/bin/mesh_ptyhost_main.exe"`
([CONTRIBUTING.md](../CONTRIBUTING.md#which-pty-host-the-tests-run) has the rules).

```sh
scripts/test-local.sh --preflight-only   # checks prerequisites only
scripts/test-local.sh                    # everything
scripts/test-local.sh -k menu            # extra arguments go to pytest
```

It needs Node 22.13+ or 24+, npm, git, opam, Python 3 and bubblewrap. It uses `MESH_PYTHON`,
otherwise a `.venv/` it creates from `requirements-dev.txt` and `requirements-browser.txt`. Browser
tests use `MESH_CHROMIUM`, otherwise the newest Playwright Chromium in `~/.cache/ms-playwright`,
installed if missing. OCaml uses `MESH_OPAM_SWITCH`, otherwise the current switch, which must use
OCaml 5.3. `scripts/bootstrap.sh` takes its dependencies from the default opam repository, except
`mcp-kit`, pinned to a public source revision until a release has the API it needs.

The public CI (`.github/workflows/public-ci.yml`) runs the same suite in parallel jobs, plus a leak
check of the tree and, on pull requests, the contributor license agreement check `cla`
([CONTRIBUTING.md](../CONTRIBUTING.md#the-cla-check-blocks-the-merge)).

The suite runs with any recent git. The optional local leak-check hooks
([tools/leak-guard/README.md](../tools/leak-guard/README.md#hooks)) need **Git 2.54 or later**: with
an older git, such as the 2.43 of Ubuntu 24.04, `hooks install` refuses and says so, and the tests
that need git to run those hooks are reported as skipped with that reason. The hooks are optional
for contributors. The CI leak check scans the files of your pull request, not its commit messages
or identities.

## Test tools on a fresh machine

| Distribution | Command |
|---|---|
| Debian, Ubuntu | `sudo apt update && sudo apt install git curl python3 python3-venv bubblewrap opam build-essential libgmp-dev pkg-config` |
| Fedora | `sudo dnf install git curl python3 nodejs npm bubblewrap opam gcc make gmp-devel pkgconf-pkg-config` |
| Arch | `sudo pacman -S git curl python nodejs npm bubblewrap opam base-devel gmp pkgconf` |

- **Node.** Ubuntu 24.04 and Debian 12 package Node 18, too old: install Node 24 from
  [nodejs.org](https://nodejs.org/en/download) (prebuilt binary, nvm or the NodeSource packages),
  which includes npm. Check that `node --version` prints 22.13 or later.
- **OCaml.** `scripts/bootstrap.sh` needs the GMP headers and `pkg-config` from the system for one
  OCaml dependency, `zarith` (opam packages `conf-gmp` and `conf-pkg-config`): without them, opam
  stops there. After installing opam, run `opam init`, then create the 5.3 switch shown in
  [Native PTY host](install.md#native-pty-host).
- **Chromium for the browser tests.** Playwright downloads its own Chromium, but the system
  libraries it needs come from your distribution. On Debian and Ubuntu, after a first run has
  created `.venv/`, install them with `sudo .venv/bin/python -m playwright install-deps chromium`.
  Elsewhere, see [the Playwright system requirements](https://playwright.dev/python/docs/browsers#install-system-dependencies).

## bubblewrap and Ubuntu 24.04

The demo compiler test runs `scripts/compile-demo-tsx.sh`, which compiles a TSX source inside a
bubblewrap sandbox with its own user and network namespaces
([demo-compiler/README.md](../demo-compiler/README.md)). Only the tests use it: the installed
service never calls the demo compiler. The launcher runs `node` from your `PATH`, or the absolute
path in `MESH_NODE`.

Ubuntu 24.04 forbids unprivileged user namespaces to programs without an AppArmor profile that
allows them (`kernel.apparmor_restrict_unprivileged_userns=1`), and bubblewrap then fails with
`loopback: Failed RTM_NEWADDR: Operation not permitted`. `scripts/test-local.sh --preflight-only`
detects it. Two ways out, narrowest first:

1. **An AppArmor profile for bubblewrap only.** Ubuntu ships one as an extra profile: it lets
   `/usr/bin/bwrap` create the namespaces and runs the sandboxed program without any capability.

   ```sh
   sudo apt install apparmor-profiles
   sudo cp /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/
   sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
   ```

   Every local program can still use bubblewrap to obtain a namespace, but without capabilities
   inside it. On Ubuntu 24.04.5 this was enough for the preflight and the complete suite; if the
   preflight still fails, use the second way.
2. **Lift the restriction for the whole machine**, until the next boot:
   `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`. Every program regains
   unprivileged user namespaces, which is the kernel attack surface Ubuntu closed. Prefer a
   development machine or VM, and do not make it permanent on a machine you share.

opam's own build sandbox also uses bubblewrap, so the same restriction can stop `opam switch create`;
the same two ways apply.

## Backports to the maintenance branch

For maintainers. The rules for contributors (target `main`, the `semver:` labels, `release/0.1`)
are in [CONTRIBUTING.md](../CONTRIBUTING.md#branches-and-versions). Three workflows implement
them: `branch-policy.yml` (the checks `semver label` and `release branch guard`, from
`tools/branch-policy/branch-policy.ts`), `backport.yml` (the cherry-pick and the pull request to
`release/0.1`) and `release.yml` (a tag on `release/0.1` is accepted). `tests/backport-workflow.test.ts`
and `tests/branch-policy.test.ts` keep their safety rules.

**One-time setup of the backport workflow.**

1. Register a GitHub App owned by the organisation, without webhook, with the repository
   permissions Contents and Pull requests set to read and write, and Workflows too if backports may
   change `.github/workflows`; install it on this repository only.
2. Store its numeric App ID as the repository secret `BACKPORT_APP_ID` and a generated private key
   as `BACKPORT_APP_PRIVATE_KEY`. With them, the backport pull request is opened by the App and
   its CI starts. Without them the workflow uses the run's own token: the pull request is opened,
   GitHub starts no workflow for it, and a comment on it asks a maintainer to close and reopen it
   to start the CI.
3. The workflow runs on `pull_request_target`, which GitHub blocks on public repositories from
   2026-12-02 unless an Actions policy allows it: add a policy for `.github/workflows/backport.yml`
   that allows `pull_request_target`.
4. Add the checks `semver label` and `release branch guard` to the required checks of `main`, and
   the same two, `cla` and the CI jobs to those of `release/**`.

**Safety of `pull_request_target`.** The job checks out the base branch, never the pull request,
runs none of its code, reads only booleans, the number and label names of the event, and gives a
write token to a third-party action pinned by commit SHA (`korthout/backport-action`).
The cherry-picked commits keep their authors; their committer is `GitHub <noreply@github.com>`,
which the `cla` job accepts. The `release branch guard` only checks that the description points
to a merged `semver: patch` pull request: the review of the backport pull request is what checks
that the changes are the same.

**Cutting 0.1.x.** Merge the backports, update the changelog on `release/0.1`, tag the release
branch tip `v0.1.x`: `release.yml` publishes it, and as a version older than the latest release
it is not marked latest once 0.2.0 exists. Then add the release to `site/releases.json` and the
changelog heading to `main` by a pull request labelled `semver: minor`: the site is deployed from
`main` only.

## Languages

The web server is written in Python, but no new Python is accepted: the project is converging on
OCaml on the server side, where the native PTY host and the MCP servers already are, and on
TypeScript in the browser and the tests. New code is written in those two languages, and the Python
modules are replaced over time ([CONTRIBUTING.md](../CONTRIBUTING.md#no-new-python)).
