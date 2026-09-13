---
adr_number: 7
title: The source repository is public so releases carry provenance
status: accepted
date: 2026-09-11
deciders: ["Vaclav Vondruska"]
domains:
  - release
  - packaging
  - security
  - tooling
---

# ADR-007: The source repository is public so releases carry provenance

This ADR records that this repository becomes public, and states the rule a later package should read rather than re-derive: a package published to the public registry from this scope is published with provenance, and a provenance attestation requires a publicly resolvable source repository. The decision is accepted and not yet implemented - the repository is `internal` at the time of writing, and the flip is a prerequisite of the first release rather than a step inside it.

## Context

This package has never been published. The release workflow T011 adds authenticates to the registry through npm trusted publishing over OIDC, which mints a short-lived token from the GitHub Actions identity and stores no secret in the repository. That mechanism is indifferent to visibility: it works from a public, internal or private repository, needing only npm 11.5.1 or newer and `id-token: write` on the publishing job.

Provenance is not indifferent. `npm publish --provenance` produces a signed attestation binding the published tarball to the workflow run, the commit and the repository that built it, and the registry rejects the attestation unless that repository is publicly resolvable.

Where that requirement is written down matters, because it is not where you would look. npm's own page on the subject, [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements), read 2026-09-13, lists the prerequisite only as "Ensure your `package.json` is configured with a public `repository`" and describes the result as "a verifiable link to the package's source code and build instructions". It does not state a visibility requirement in those words, and it does not enumerate what the attestation records. The requirement is enforced by the CLI and the registry rather than documented there, which is why this ADR records the measurement below instead of citing a sentence.

The asymmetry, measured against this repository on 2026-09-13:

```
$ curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/re-cinq/HALEngine
404

$ GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/re-cinq/HALEngine.git HEAD
fatal: could not read Username for 'https://github.com': terminal prompts disabled

$ git ls-remote origin HEAD          # authenticated, over ssh
59f1a337...    HEAD
```

One trap in taking that measurement, found while taking it. A `url.git@github.com:.insteadof https://github.com` entry in a developer's git config rewrites the HTTPS URL to SSH before it leaves the machine, so `git ls-remote https://…` succeeds on an unreadable repository and appears to prove the opposite of the truth. The unauthenticated API call has no such rewrite and is the check to trust. So the two are separable: tokenless publishing is available now, and provenance is available only at the cost of visibility. The release workflow therefore either carries the flag or it does not, and cannot be finished until that is settled.

The repository is currently `internal`, not private. Both are equivalent for this decision - neither is publicly resolvable, so neither can carry provenance - but the distinction matters to the size of the change: the code is already readable across the enterprise, and going public widens the audience rather than opening a closed repository for the first time.

## Decision

This repository becomes public. The release workflow carries `--provenance` alongside `--access public`.

Stated generally, for the next package rather than this one:

- A package published to the public registry from this scope is published with provenance, and therefore from a public source repository.
- A package whose source genuinely cannot be public is still published tokenlessly over OIDC, without `--provenance`, and its README says so rather than leaving a consumer to notice the missing attestation.
- Visibility is decided before the first publish, never after. The first published version fixes what a consumer can verify about every version that follows.

## Rationale

The honest framing is not "public versus closed", because the built package is public either way. `npm publish --access public` puts `dist/` - compiled JavaScript and its declaration files - on a registry anyone can install from, and `package.json` already carries `publishConfig.access: public`. Nothing about visibility changes what the consumer runs.

What visibility decides is everything the tarball does not carry. `files` is `["dist"]`, so the tests, `example/`, `specs/`, `adrs/`, `docs/` and the entire commit history stay out of the package and become readable only if the repository does. It also decides the issue and pull-request record, which is where a consumer looks when the published behaviour and the documented behaviour disagree.

And the exposure is retroactive and permanent in a way a published version is not. A published version exposes a build; a public repository exposes every commit that ever reached it, and cannot be meaningfully undone - a repository returned to `internal` does not recall what was cloned or forked while it was public. That is the real cost, and it is why the history was audited before this was accepted rather than after.

That audit found the history clean. The check is a reproducible command rather than a tool nobody here has installed - `gitleaks` and `trufflehog` are both absent from this machine, and an ADR that names a tool the next reader cannot run has recorded nothing. Re-run on 2026-09-13 across all 82 commits on all branches, matching the credential shapes that carry a recognisable prefix:

```
$ git rev-list --all | while read -r c; do
    git grep -I -nE 'AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|npm_[A-Za-z0-9]{36}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$c" -- . ':!package-lock.json'
  done | sort -u | wc -l
0
```

What that does and does not establish: it finds AWS, GitHub, npm, Google and Slack credentials and PEM private keys, because each carries a fixed prefix. It cannot find a high-entropy secret with no recognisable shape - a bare password, a hex-encoded key - and no scanner reliably can. The remaining findings below came from reading rather than matching: no credentials of any recognised shape in any commit on any branch, no email addresses beyond one `example.test` fixture, every URL host either vendor documentation or `localhost`, no internal hostnames, account identifiers or infrastructure references, and no build artefacts ever committed. One commit carries a maintainer's personal address, which is a matter for that maintainer rather than for this decision.

Against that cost, provenance buys a consumer something they cannot otherwise get: a verifiable claim that a given version was built from a named commit by a named workflow, rather than uploaded by whoever held a token. For a package that executes user input against third-party model APIs, that is worth more than the privacy of a history which the audit shows contains nothing private.

## Consequences

- T011 carries `--provenance`; T031's first publish is attested, and the attestation is visible on the registry listing. This ADR is what unblocks both.
- A consumer verifies the result with `npm audit signatures`, which reports how many installed packages carry a verified registry signature and how many carry a verified attestation. That command is the whole consumer-facing benefit of this decision: without a public repository there is no attestation for it to verify, and it reports the package as unattested.
- Secret scanning and push protection become available and are enabled by default, which is the backstop against the next accidental credential reaching a repository anyone can read. They are unavailable while the repository is `internal`.
- A pull request from a fork receives no repository secrets and a read-only token whatever a workflow's `permissions` block requests. The workflows already account for this; a contributor-facing note is T033's.
- Push access to `main` becomes, transitively, the ability to publish under this scope, because OIDC leaves no stored credential to revoke. Branch protection is the lock and T032 is the alarm behind it; both are dependencies of T031 rather than improvements on it.
- The issue record, the specs and the ADRs - this one included - become public. They are written to be read.
- The repository becomes forkable, and reversal does not recall a fork. Anything that must not be public has to be kept out of a commit rather than removed from one.

## Alternatives considered

**Stay internal and publish tokenlessly without provenance.** Rejected, but it is the strongest alternative and would have been correct if the audit had gone differently. It costs nothing: trusted publishing needs no visibility, the package is identical, and the only loss is the attestation. It was rejected because the history holds nothing worth protecting, so the privacy being bought is nominal while the verifiability being given up is not.

**Go private rather than internal.** Rejected. For this decision it is identical to internal - neither can carry provenance - while narrowing who can read the source for no gain.

**Go public but publish without provenance.** Rejected as the worst of both: the exposure is paid in full and the benefit that justifies it is declined.

**Publish from a scrubbed public mirror while development stays internal.** Rejected. A provenance attestation names the repository the build ran in, so a mirror's attestation would point at a repository where the code is not developed, reviewed or discussed - which inverts the property provenance exists to provide. Two histories also drift, and the mirror's would have to be regenerated per release.

## References

- [package.json](../package.json) - `publishConfig.access`, `repository.url` and `files`
- [specs/hal-engine-npm-release/spec.md](../specs/hal-engine-npm-release/spec.md) - the release this decision blocks
- [specs/hal-engine-npm-release/tasks.md](../specs/hal-engine-npm-release/tasks.md) - T011 (the workflow), T031 (the first publish), T032 (the push alarm), T033 (the contributor note)
- [LICENSE](../LICENSE) - Apache-2.0, the terms the source is readable under
