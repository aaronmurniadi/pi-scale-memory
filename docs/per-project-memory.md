# Memory tiers: core, shared, project

Status: implemented. This is the decision record for splitting the brain's single flat memory into three tiers by write authority. The user-facing description is in [the README](../README.md#memory-tiers); this file records why the shape is what it is, and what the implementation actually does.

## Why

The brain had one flat namespace per tailnet. Every project, machine and agent wrote into the same `MEMORY.md`, `SCRATCHPAD.md` and `daily/`, so recall mixed unrelated work, the files grew without bound, and there was no separation between what you asked to be remembered and what an agent decided on its own.

The growth did not just add noise. It deleted memory from the prompt:

| Problem | Where it was |
|---|---|
| One flat namespace; no route or tool took a scope | `brain/server.mjs` route table |
| `MEMORY.md` clipped from the **start** into the prompt, so past ~8 000 chars the newest entries were dropped first | `brain/memory.mjs` `buildContext` |
| Today's log clipped from the end, so its oldest entries vanished silently | `brain/memory.mjs` `buildContext` |
| Human-directed writes and automatic session summaries sharing one file and one write path | `index.ts` `capture`, `memory_write` |
| Search ranking one mixed corpus: BM25 over every paragraph, one qmd collection over the whole directory | `brain/memory.mjs`, `brain/qmd.mjs` |
| Scratchpad and forget doing unserialized read-modify-write, so concurrent agents lost updates | `brain/server.mjs` |
| The mirror being all-or-nothing: one cache dir, one `meta.json`, every project downloaded | `src/cache.ts` |
| `agentId` being only the hostname, so two agents on one machine were indistinguishable | `index.ts` |

## The three tiers

| Tier | Scope | Written by | Injected |
|---|---|---|---|
| **Core** | every session, every project, every machine | `/core-memory` only | always, even when no project resolves |
| **Shared** | every session, every project | agents: `memory_write scope shared`, pruned with `memory_forget scope shared` | always |
| **Project** | one git repository | agents, freely: `MEMORY.md`, scratchpad, daily log | when a project namespace resolves |

The split is by **authority**, not only by topic. The reason core exists separately from shared is that shared is agent-managed: agents may add to it, restate in it and prune it, and a tier that agents can rewrite is not a place for the one instruction you never want an agent to touch.

### Core is enforced, not requested

| Path | Can reach core? |
|---|---|
| `/core-memory` command → `POST /v1/core` | **yes, the only writer** |
| `memory_write` → `POST /v1/write` | no: the handler rejects `target: "core"` / `ns: "core"` |
| automatic capture → `POST /v1/write` with `target: "daily"` | no: it writes the project's daily log |
| `scratchpad` → `POST /v1/scratchpad` | no: project namespaces only |
| `memory_forget` → `POST /v1/forget` | no: core is not an accepted target |
| `/core-memory --remove` → `POST /v1/core` | yes, the only deletion path, with a recovery copy |
| editing `core/MEMORY.md` on the brain machine by hand | out of band; the extension neither does nor prevents this |

No tool is bound to `POST /v1/core`, so a model that decides to write core has no route to it. This is why the restriction is enforced at the endpoint rather than stated in the prompt.

Core writes are also never queued (`writeNow`, not `writeOrQueue`): if the brain is unreachable the command reports the failure instead of leaving a rule that the user believes was stored in an outbox.

### Shared is agent-managed and one file

Shared holds `MEMORY.md` only: no daily log (logs are per-project work history) and no scratchpad (a checklist needs to be ticked off, which a curated cross-project file should not support). Agents add, restate and prune it freely, and `memory_forget` works on it without a special mode.

Automatic capture does not write shared. Every 15-turn, pre-compaction and exit summary goes to the project's daily log, which is what keeps shared curated rather than a stream.

## Project identity

Identity is the canonical git repository, not the directory:

1. an explicit pin (`PI_SCALE_MEMORY_NAMESPACE`, or `namespace` in the config);
2. the canonical remote of the preferred remote (`scopeRemote`, default `origin`) — `github.com/acme/api`;
3. a repository with no usable remote → this machine's copy of it, keyed on the main worktree root;
4. not a repository → this machine and that directory;
5. anything unresolved → `legacy`.

Rungs 3 and 4 include the hostname on purpose: they cannot be shared across machines, and pretending otherwise would silently merge two directories that happen to share a path.

Normalization: scheme, userinfo, port, trailing slash and `.git` are stripped, scp-style `host:owner/repo` is handled, host/owner/repo are lowercased. **Userinfo is dropped before the key is hashed or recorded**, because remote URLs can carry credentials. The namespace id is a slug plus `sha8(canonical key)`, so it is filesystem-safe (`api-9f3c1a2b`) and collision-free.

Two failure modes are designed for rather than discovered:

- **Fork vs upstream.** `origin` of a fork is not the upstream project. `scopeRemote` picks a different remote, and `/brain merge` plus the registry's recorded key handle the case where they were already treated as separate.
- **Remote renamed or moved.** The key changes and the memory looks lost. `/brain merge <from> <into>` folds the namespaces together, and the brain's registry keeps the canonical key each agent reported.

Worktrees share a namespace: `rev-parse --git-common-dir` resolves to `<root>/.git`, so `repo/.worktrees/x` maps onto `repo` instead of getting its own memory.

## Storage

```
BRAIN_DIR/
  registry.json                # ns -> {key, label, agents, aliases, firstSeen, lastSeen}
  core/MEMORY.md               # human-authored
  core/recovery/*.json
  shared/MEMORY.md             # agent-managed cross-project
  shared/recovery/*.json
  ns/<id>/MEMORY.md
  ns/<id>/SCRATCHPAD.md
  ns/<id>/daily/YYYY-MM-DD.md
  ns/<id>/recovery/*.json
```

`ns` is validated as a directory name (`^[a-z0-9][a-z0-9._-]{0,63}$`, `core` reserved) rather than escaped, so `ns=../..` is a 400 rather than a path traversal. A request that names no namespace resolves to `legacy`, which is where the old flat memory was moved and where a pre-tier agent's writes continue to land.

## Prompt assembly

`buildContext(root, ns)` assembles core, shared, then the project's `MEMORY.md`, scratchpad, today and yesterday — each clipped to its own budget (2 000 / 3 000 / 8 000 / 4 000 / 6 000 / 4 000) under a 12 000-char ceiling for the block. `MEMORY.md` is clipped from the **end** so the newest entries survive.

When the block does not fit, the least valuable section is given whatever room is left before it is dropped, and is only dropped when that room could not hold a useful fragment (400 chars). Dropping sections whole while half the budget sat idle was the first version's mistake: with core and shared at their budgets, it evicted the repository being worked in to keep cross-project conventions, and left 6 700 chars of the 12 000 unused. The order — core, shared, project memory, scratchpad, today, yesterday — means core and shared are never dropped or shrunk, the project's own memory outranks its logs, and deliberate memory (the checklist) outranks automatic logs (today, then yesterday). Every section header carries its size in chars and an approximate token count, so the cost of memory is visible in the prompt itself.

## Hygiene

The point of the tiers is that the prompt holds useful memory rather than accumulated noise, so three mechanisms work against dilution:

- **Write-time dedup.** An entry that restates an existing paragraph (token-set Jaccard ≥ 0.8 against `MEMORY.md` paragraphs, stamps ignored) replaces it in place and reports `deduped`. Appending the same fact twice costs nothing and adds nothing. Daily logs opt out: repetition there is history.
- **Compaction.** `/brain compact [ns]` folds a `MEMORY.md` with the session model. The brain has no model of its own, so it runs on the agent and writes back an overwrite; it refuses files below the threshold and refuses a result that is not shorter than the original, so a bad fold cannot make memory worse than leaving it alone.
- **Visibility and pruning.** `/brain namespaces` reports each namespace's size and daily-log count, and `/brain status` reports the standing cost of core + shared + project in tokens per session. Shared and project memory are prunable with `memory_forget` (recovery copies kept), and core with `/core-memory --remove`.

## API

| Route | Notes |
|---|---|
| `GET /v1/context?ns=` | the budgeted block, plus per-tier sizes; core and shared always, the project when `ns` resolves |
| `GET /v1/snapshot?ns=` | `{core, shared, project}` file maps for the mirror |
| `GET /v1/read?target=&ns=&date=` | `long_term`, `scratchpad`, `daily`, `list`; `ns=core` for `long_term` only |
| `GET /v1/core`, `POST /v1/core` | the core file: read, append, remove. The only core writer |
| `GET /v1/search?q=&ns=&scope=` | `scope` is `all` (default), `project`, `shared`, `core`, `legacy` |
| `GET /v1/namespaces?ns=` | the listing above, plus a namespace's recorded key |
| `POST /v1/ns/merge` | fold one namespace into another |
| `POST /v1/write`, `/v1/scratchpad`, `/v1/forget` | reject core; shared accepts `long_term` only |
| `GET /v1/health` | adds `scopes: ["core","shared","project"]` and `defaultNs`, so an agent can detect a pre-tier brain |

Writes to one file are serialized with an in-process promise chain, which removes the lost-update races in the scratchpad, the forget handler and the dedup path.

## Search

One qmd collection per tier, named `psm-core`, `psm-shared`, `psm-<namespace>`, created lazily when a tier first has content. A scoped search passes every collection in scope to a single `qmd` invocation, because `-c` is repeatable — but only the collections that actually exist, because qmd fails the whole query if any named collection is missing. A namespace with no memory yet has no directory and therefore no collection, and naming it would otherwise cost the agent its core and shared results on the first search in a new repository.

This was decided by a spike rather than assumed: `qmd search --help` shows filtering by **collection** (`-c`, one or more) and no path filter, and a query naming two collections returned a hit from the one that contained it. So a collection per tier is what makes scoping exact — other projects are never searched, rather than being filtered out of a shared result after the fact, which would also under-return when other projects dominated the top-k.

`qmd update` reindexes every collection on the machine, so update time grows with the number of namespaces; the cost is contained by creating collections lazily, embedding only the tier that changed, and reporting collections left over from the flat v0.1 layout at startup (they can be removed with `qmd collection remove <name>`). The BM25 fallback runs per tier with the same scope, so isolation holds when qmd is missing, cold, or behind a recent write.

## Client and mirror

The mirror keeps the brain's layout (`core/`, `shared/`, `ns/<id>/`) under `~/.pi/agent/pi-scale-memory/cache/`, so offline reads use the same context builder and BM25 ranker as online ones. An agent refreshes the two cross-project tiers plus the project it is in, and each tier records when it was last refreshed, so a project another session mirrored is never passed off as freshly taken. Projects are not evicted: several sessions on one machine share this cache directory, and evicting a project another session is working in would leave that session reading an empty project tier while offline.

The namespace is resolved once at session start (two or three local git calls behind a timeout, cached because a working directory does not change) and attached to every request by `BrainClient.call`. Queued writes keep their namespace in the outbox entry, which is what stops a write made in one project from landing in another when the brain returns.

## Migration

On the first start after the upgrade, `migrateFlat` moves the v0.1 layout:

- `MEMORY.md` and any **open** scratchpad items become the shared tier. Both are cross-project notes that agents wrote, and core takes no agent writes. Finished items are dropped.
- `daily/` moves to the `legacy` namespace, which nothing injects, and the original flat files are archived there too.
- The move is idempotent: the flat files are gone afterwards, and the shared write is deduplicated, so an interrupted run cannot duplicate content.

The one caveat worth stating: the old `MEMORY.md` contains agent-written entries, because the old write path could not tell them apart from yours. Core therefore starts empty rather than seeded from it. Whatever of that content belongs in core is yours to add with `/core-memory`, and the rest stays readable in shared.

## Compatibility

- **Old agent, new brain:** no `ns` in the request, so it reads and writes `legacy` — where its own old logs were moved. Nothing breaks and nothing lands in core.
- **New agent, pre-tier brain:** `/v1/health` has no `scopes`, so the agent warns that writes are going into the flat store and core is unavailable, rather than behaving as if it were isolated.

## Tests

The suite spawns a real brain over loopback with a throwaway `BRAIN_DIR`, so the tiers are tested end to end rather than mocked:

- namespace resolution over URL forms, worktrees, submodules, no-remote, no-git and pin precedence, with the git runner injected so no repository is needed;
- core's single writer, including rejection at `/v1/write` and `/v1/forget`, and the recovery copy on removal;
- shared's write rules (no daily, no scratchpad) and that a project write never leaks into it;
- project isolation in both reads and searches, and that a search never crosses into another project;
- traversal rejection and the `legacy` default for a caller that names no namespace;
- namespace listing with sizes and recorded keys, and merging two namespaces;
- migration idempotency, and the flat layout moving into shared plus `legacy`;
- write-time dedup, and the prompt budget including which sections are dropped.

Per-tier qmd collections are exercised only when qmd is installed, through throwaway collections that the suite removes, so it does not disturb an existing index.

## Risks and open items

| Item | State |
|---|---|
| qmd update time grows with namespaces | Lazy collections, per-tier embed, leftover collections reported at startup |
| Container/monorepo sub-scoping | Not implemented. A monorepo is one namespace; splitting it by path stays opt-in work if it is ever wanted |
| Mirror disk usage | One directory per project worked on, never evicted. Deliberate: sessions share one cache dir, so eviction would delete a live session's offline memory. Bounded by how many projects a machine works in, and revisitable with mtime-based pruning if that ever matters |
| A write racing a namespace merge | The merge locks each destination file it copies, but a write to the source namespace between the last copy and the `rm` can recreate the source directory holding one file, with no registry entry. Narrow, and the namespace still works; a follow-up merge would fold it in |
| Compaction is manual | `/brain compact` exists but nothing schedules it. Core has no compaction at all, by design |
| Daily logs are unbounded on disk | Only today and yesterday are injected, so growth costs disk and index time, not prompt tokens. No auto-deletion, deliberately |
| Leftover v0.1 qmd collection | Reported at startup; removing it is a manual `qmd collection remove` |
| `npm test` needs `tsx` | The `test` script calls `tsx`, which is not in `devDependencies`, so a fresh clone needs `npx tsx test/unit.ts` or an added dependency |

## Decisions

- Three tiers by write authority: core (human-only), shared (agent-managed, cross-project), project (agent-managed, per repository).
- Core is written only by `/core-memory`, enforced at the brain: no tool and no other route can reach it, and core writes are never queued.
- Core holds one file: no scratchpad, no daily log, no compaction.
- Shared holds `MEMORY.md` only, and automatic capture never writes it.
- Project identity is the canonical git remote, with machine-local fallbacks for repositories without one and for non-repositories.
- Migration sends the old flat `MEMORY.md` and open scratchpad items to shared, and the old daily logs to a non-injected `legacy` namespace; a request naming no namespace resolves to `legacy`.
- Search is per-tier qmd collections with repeatable `-c`, the design the spike supported; the default search scope is core + shared + the session's project.
- Prompt assembly is budgeted per tier with a total ceiling, and drops the least valuable sections first.
- Repeated facts replace rather than accumulate, at write time.

Changes from the original plan, for the record: the tier count went from two (core + project) to three after shared was reintroduced as the agent-managed cross-project tier; the migration target moved with it, from core to shared; and the search design was settled by the spike rather than left open, since qmd turned out to have no path filter.
