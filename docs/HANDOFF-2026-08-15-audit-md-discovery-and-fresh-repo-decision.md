# Handoff — AUDIT.md discovery and the fresh-repo decision

Continuation of `docs/HANDOFF-2026-08-15-sample-data-and-history-purge.md`. Read that
first — this covers only what changed after it: the item-3 spot-check ("if you have
time") stopped being optional.

## What happened

The item-3 spot-check was run properly: a fresh `git clone --mirror` of origin (the
exact state GitHub serves today — 36 branches, 4 tags, 511 PR refs), a dump of every
blob reachable from the 36 branches + 4 tags the recent rewrite targeted, and a
fresh-eyes grep rather than a re-run of the #563–565 keyword list.

It found `AUDIT.md` and `config.json`, added by commit `659038bb` ("v2: SQLite-indexed,
MCP-native, LLM-augmented private todo system", author `Liam Broza
<liam@liambroza.com>`) — a status report from an early personal-todo-app prototype
(this app's own ancestor, before the "Companion Planning" rebrand) auditing the real
developer's `~/Documents/Owner_Plan`. Contents: real business entity names (Companion
Intelligence, HyperConstruct, Lifescope, Laguna Labs) with tax-filing specifics,
personal finance/tax folder structure, family-planning notes, health-insurance
references, fundraising notes, and local filesystem paths tied to a real username.

This is structurally different from everything #562–566 fixed. That wave scrubbed
*fixture/sample-data* content (invented company names standing in for real ones in
test data, docs, ops scripts). This is a real, unrelated status report that got
committed once, early, and later deleted from HEAD's tree — but never from history.

**Scope:** it's an ancestor of `main` itself (added by `659038bb`, deleted from HEAD's
tree by `2c831a44 docs: remove stale legacy-app docs` around the PR #53–56 timeframe,
still fully readable via `git log`/`git show 659038bb:AUDIT.md` on main today) and
present on **39 of the 40** refs the recent rewrite targeted (all 36 branches, 3 of 4
tags — only `legacy-main-pre-v4` predates it). Not a stray side-branch leak; it's
baked into the history nearly everything descends from.

## Why the prior scrub didn't catch it

#562–566's redaction dictionary was built from four iterative dump-and-grep passes,
but every pass was still anchored to *known* fixture-content keywords (company names,
personal emails in ops scripts) — the method was fresh-eyes, but the search terms
were still scoped to "things that look like sample data." `AUDIT.md` doesn't look like
sample data; it looks like (and is) a real personal status report. Nobody had a reason
to search for it by name until this pass's grep partially matched on "Hyperconstruct"
and "LITA" as substrings.

## Decision made (owner confirmed, 2026-08-15)

Given the leaking commit is an ancestor of nearly everything, a proper purge would
mean rewriting close to the entire mainline history — a much bigger, riskier
`filter-repo` operation than the fixture-content rewrite already shipped in
`51ee7028`. Given that:

- **Publish to CI-Hub via a fresh, squashed, PII-free repo**, not by purging this one.
  This repo (`companionintelligence/Companion-Planning` on GitHub — note the remote is
  still under the old pre-rename name) **stays private forever** as working history.
  This was already one of the two options on the table in the original handoff's item
  2; it's now the confirmed plan, not a fallback.
- **The GitHub Support ticket** (purge cached `refs/pull/N/head`) is still considered
  **required before any publishing action**, even with the fresh-repo path chosen. A
  draft ticket is below.

  ⚠️ **Open tension, not yet reconciled:** the original handoff's own text says the
  ticket "only matters once the repo goes public... no ticket needed for a truly
  private repo." If this repo truly never goes public, why does the ticket still
  matter? The owner confirmed "required before publishing" without an explicit
  reconciliation of this point. Possibilities: (a) this repo is expected to go public
  too, separately from the CI-Hub listing, at some point; (b) "publishing" was read
  more broadly than just the CI-Hub listing; (c) it just wasn't reconciled live and
  is worth a quick check-in before actually filing the ticket. Don't assume which one
  — ask if it becomes actionable.
- **Screenshot re-capture** (`docs/screenshots/`, `docs/ui/`) is **on hold**. It'll be
  built fresh against the new repo instead of fixed on this one — the original
  handoff's own item 1 already noted this becomes moot under the fresh-repo path.

## Draft GitHub Support ticket

```
Subject: Purge cached refs/pull/N/head views for a repo after a history rewrite

Repo: companionintelligence/Companion-Planning (private)

We ran a history rewrite (git filter-repo, force-pushed) across all branches and tags
in this private repository to remove personal data that had been committed in error.
The rewrite is complete and verified on all branches/tags.

However, we understand GitHub retains refs/pull/N/head server-side for every pull
request ever opened against the repo (roughly 509 in our case), independent of what
gets force-pushed to branches, and that these are not affected by a client-side
history rewrite. Anyone with read access to the repo can still fetch pre-rewrite blobs
via `git fetch origin refs/pull/N/head` for any PR that touched the affected files.

Could you purge/expire the cached refs/pull/N/head views (and any associated cached
diffs/blobs) for this repository so that the pre-rewrite content is no longer
retrievable through those refs? Happy to provide the specific PR numbers and commit
SHAs involved if useful.
```

Not filed yet — needs the owner to submit it (support tickets require the account
that administers the repo). Also unaddressed: whether to mention the `AUDIT.md`
finding to GitHub Support explicitly, since it's now the more sensitive of the two
exposures riding on those cached PR refs.

## Not started

- Building the fresh public repo (deciding what to squash, verifying the squashed
  tree is clean, choosing what history/attribution survives, creating the actual new
  GitHub repo and pushing). This is a substantial, visible, hard-to-reverse action —
  scope it as its own piece of work rather than folding it into a quick pass.
- Filing the GitHub Support ticket (draft above, not submitted).
- Reconciling the open tension above about whether the ticket is actually needed if
  this repo never goes public.

## Method note, for whoever does the next dump-and-grep pass on anything

The fresh-mirror-clone + full-blob-dump + fresh-eyes-read method (not reusing a prior
keyword list) is what found this. A `git clone --mirror` of origin, not the local
working repo, matters too — this local worktree/repo had stale local-only branches
and stash entries (pre-rewrite artifacts, never pushed, `git ls-remote origin
refs/heads/<name>` returns empty for them) that would have produced false alarms about
content actually reachable from origin. Always verify findings against a fresh mirror
of the actual remote, not local ref state.
