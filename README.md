# pi-scale-memory

A pi extension that gives many pi agents one shared memory (a "brain") over a private tailnet.

**Every node here is a private userspace `tailscaled`.** Nothing in this extension ever calls the machine's own Tailscale: no `sudo`, no TUN device, no route or DNS changes, and no reading or writing of the host's Tailscale state. On a machine already signed in to another tailnet (a work one, say), pi joins its own separate node and leaves the host alone.

The brain runs a detached userspace node and publishes its memory API to the tailnet with `tailscale serve --tcp`, which proxies tailnet traffic to `127.0.0.1`. Agents run a detached node too, one per machine, and reach the brain through its SOCKS5 proxy. Every session on a machine shares that one node, so a machine joins once and keeps the same device from then on. Agents also keep a local mirror of the memory, so they can still read while the brain is unreachable.

**A brain that is not answering yet is retried three times, then left to you.** A node that has just joined needs a moment to find paths to its peers, and a reset brain comes back under a new address, so the agent warms those paths through the Tailscale layer and retries on a growing delay (5s, 10s, 20s) instead of giving up on the first attempt. After that it stops and says so in the status line, because by then the cause is usually something only you can change — no brain running yet, the wrong port, a machine that is asleep — and a loop that retries in silence would hide it. Run `/brain connect` to try again; reads keep coming from the local mirror in the meantime.

**Agents find the brain by asking, not by tag.** Each agent reads the peer list it already has from its own netmap and asks every peer on the memory port whether it is the brain. A peer answers by identifying itself in its `/v1/health` response (`service: pi-scale-memory`, `role: brain`), so no tag policy, no `tagOwners`, and no port scanning of anything outside your tailnet are involved. **This extension uses no tags at all** — there is no tag to declare, and nothing to configure in `tagOwners`, for either role.

Memory model and tools follow [pi-memory](https://github.com/jayzeng/pi-memory): `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, tools `memory_write`, `memory_read`, `scratchpad`, `memory_search`, `memory_forget`, plus a memory snapshot injected into the system prompt. Differences: storage is remote and shared, memory is split into three tiers by who may write it (see [Memory tiers](#memory-tiers)), the search index lives on the brain (qmd, with BM25 fallback), and agents cache the memory for offline use.

## Requirements

- **Tailscale** on every machine (`tailscale` and `tailscaled` on `PATH`). No root access is needed.
- Pre-auth keys, created in the Tailscale admin console: one per machine, for whichever role that machine has. No tags are involved. A key is only used to register a node once, so a single-use key is enough for a machine — it is not needed again on later sessions.
- Node >= 22.
- Optional, on the **brain**: [qmd](https://github.com/tobi/qmd) for semantic and deep search, installable from inside pi with `/install-qmd`. Agents never need qmd.

Nothing is published to the internet: the memory API is reachable only from the tailnet, and the ACL is what decides who can reach it.

## Roles

`/self-tag` sets what this pi agent is, and the join commands set it too:

| Role | What it does | Memory path |
|---|---|---|
| `brain` | Runs the memory server plus a detached userspace node, and publishes the API with `tailscale serve` | local server on `127.0.0.1`, proxied to the tailnet |
| `agent` | Runs a detached userspace node (shared by every session on the machine), then asks its peers which one is the brain | the tailnet, plus a local mirror for offline reads |

## Memory tiers

Memory is split by **who may write it**, not only by topic, because the awkward failure is an agent quietly editing what you asked it to remember.

| Tier | Scope | Written by | In the prompt |
|---|---|---|---|
| **Core** | every session, every project, every machine | you, with `/core-memory`. Nothing else | always, even when no project resolves |
| **Shared** | every session, every project | agents: `memory_write` with `scope: shared`, pruned with `memory_forget` | always |
| **Project** | one git repository | agents, freely: `MEMORY.md`, the scratchpad, and the daily log | whenever a project namespace resolves |

The project tier is resolved from git rather than from the directory: `git remote get-url origin` normalised to `github.com/acme/api`, so two clones on two machines share one project's memory and a worktree shares its parent's. A repository with no remote, or a directory that is not a repository, gets a namespace naming this machine and that path, because those genuinely cannot be shared. `PI_SCALE_MEMORY_NAMESPACE` (or `namespace` in the config) pins one explicitly.

Core memory is enforced at the brain rather than requested in a prompt: `/v1/write`, `/v1/forget` and `/v1/scratchpad` all reject it, so the only code that can reach `core/MEMORY.md` is the `/core-memory` command. A core write is also never queued for later: if the brain is unreachable the command says so rather than leaving a rule you believe was saved sitting in an outbox.

Keeping the tiers worth their tokens:

- Each tier is injected under a budget — core 2 000 chars, shared 3 000, project `MEMORY.md` 8 000, scratchpad 4 000, today 6 000, yesterday 4 000 — under a 12 000-char ceiling for the whole block. When the block does not fit, the least valuable part is given the room that is left before anything is dropped, so a section is only discarded when what remains could not hold a useful fragment of it. `MEMORY.md` is trimmed from the front so the newest entries survive. The order is deliberate memory before automatic logs: core, shared, project memory, scratchpad, today, yesterday. Core and shared are never the part that gives way.
- A write that restates an existing entry **replaces** it rather than appending a near-copy, and tells the writer it did (`deduped`). `/core-memory` reporting "already said that" is that working, not a silent no-op.
- `/brain compact [ns]` folds a `MEMORY.md` down with the session model and refuses to write a result that is not shorter than the original.
- `/brain namespaces` lists every namespace with its size and daily-log count, so what a session is paying for is visible rather than guessed.
- A remote that is renamed or moved changes the namespace key. `/brain merge <from> <into>` folds the old namespace into the new one, and the canonical key each agent reports is kept in the brain's registry for exactly this case.

Upgrading from the flat v0.1 layout moves `MEMORY.md` and any open scratchpad items into **shared** — they were cross-project notes written by agents, and core takes no agent writes — and archives the old daily logs under a `legacy` namespace that nothing injects. A caller that names no namespace, such as an older agent, lands in `legacy` too. Read it with `/brain ns legacy`, and `/brain ns --clear` to resolve from git again.

## Commands

| Command | Applies to | What it does |
|---|---|---|
| `/join-tailnet-brain` | brain | Starts this machine's own userspace Tailscale node, joins it with a pre-auth key, publishes the memory port to the tailnet, and sets the role to `brain` |
| `/join-tailnet-agent` | agent | Joins with a pre-auth key on a private userspace tailscaled, then asks the tailnet which peer is the brain |
| `/self-tag [brain\|agent]` | both | Sets the role on its own, without joining |
| `/install-qmd` | brain | Installs qmd for semantic search, into a prefix that is on your `PATH`, then restarts the brain so it indexes with it |
| `/reset-pi-scale-settings` | both | Stops the daemons this extension started, logs its tailscale nodes out, and deletes all of its state so you can start over |
| `/core-memory <memory>` | both | Writes **core memory**, and is the only writer to it. No arguments shows core; `--remove <match>` deletes matching entries, keeping a recovery copy |
| `/brain status\|namespaces\|ns\|merge\|compact\|sync\|reindex\|connect\|reset` | both | Shows role, brain, health, search engine, namespace and tier sizes, queue and cache age; lists namespaces; pins the namespace for this machine (`--clear` unpins); merges two namespaces; folds a `MEMORY.md` down with the session model, to that tier's own budget; refreshes the offline mirror; reports the brain's index; reconnects (`connect`, or its older spelling `reconnect`); `reset` is the same as `/reset-pi-scale-settings` |
| `/update-pi-scale-memory` | both | Updates the extension (git pull, or `pi update`) and reloads it |

### Quick start

Create a pre-auth key in the Tailscale admin console (Settings -> Keys) for each
machine: one for the brain, one for each agent. Leave Reusable off if you like —
a node registers once and keeps its identity, so a key is spent only by that
machine's first join. Then, on the machine that will hold the memory:

```
/join-tailnet-brain  # paste the brain's key
```

On every other machine:

```
/join-tailnet-agent  # paste an agent key
```

That is the whole setup. The brain prints the node name and tailnet address it joined as, and agents report the node name they registered as plus the brain they found. Nothing has to be declared beforehand: agents identify the brain by asking it. One key covers one machine's first join; make it reusable only if you want the same key to serve several machines.

Two nodes appear in your tailnet: `pi-brain-<host>` for the brain and `pi-agent-<host>` for each agent machine. A machine keeps its device across sessions and restarts rather than registering a new one, so the list does not grow as you use it. The host machines' own Tailscale devices are untouched and can be in a different tailnet entirely.

### Making it reachable

Two things must hold, and the extension reports when either is missing:

- the ACL must let each agent reach the brain's node on the memory port (default 8787);
- the brain's node must be joined and serving, which `/join-tailnet-brain` ensures. On later sessions the brain restarts that node itself from its saved state, so it is only needed once.

Since discovery uses no tags, the ACL simply has to allow your devices to reach
that port:

```jsonc
"grants": [
  { "src": ["autogroup:member"], "dst": ["autogroup:member"], "ip": ["8787"] }
]
```

Narrow `dst` to the brain's device or a group if you want tighter control. Tags
can still be used in your ACL if you use them elsewhere in your tailnet, but this
extension neither needs nor sets any.

An agent that joins successfully but finds no brain reports how many peers it asked and on which port, and tells you to run `/join-tailnet-brain` on the brain, rather than pretending it connected. If more than one peer answers as a brain, it says so and names them, because that ambiguity would otherwise pick one silently.

A single brain can also be pinned, which skips discovery entirely — useful on a
tailnet with many peers:

```bash
PI_SCALE_MEMORY_BRAIN_HOST=100.64.0.5 pi
```

The brain's node is detached and survives pi exiting, so agents keep reaching the memory while no session is open on the brain machine. `/brain reset` stops it.

## Search

Search runs on the brain, so one index serves every agent. qmd is installed with
`/install-qmd`; the brain mentions it once at startup when it is missing, and
without it everything still works through BM25.

Search is scoped to the tiers you ask for, and the default scope is core plus
shared plus the project the session is in — never another project. `memory_search`
takes `scope: all | project | shared | core`, `memory_read` takes
`project | shared | core`, and every result is labelled with the tier it came from.

`/install-qmd` is careful about one thing that makes this worth automating: a
plain `npm install -g` writes into npm's global prefix, which on a machine using a
node version manager is often **not on `PATH`** — the install reports success and
`qmd` is still not findable. So it picks a prefix whose `bin` directory is actually
on `PATH` and writable, installs with an explicit `--prefix`, and then verifies by
running `qmd --version`. If no such prefix exists it stops and prints the exact
commands to run yourself rather than pretending to have installed anything. With qmd installed there, the brain indexes each tier as its own collection (named `<prefix>-<tier>`, default prefix `psm`) and answers three modes:

| `memory_search` mode | qmd command | What it does | Typical latency |
|---|---|---|---|
| `keyword` | `qmd search` | BM25 full-text, no model | instant |
| `semantic` (default) | `qmd vsearch` | vector similarity, finds paraphrases | ~3s warm |
| `deep` | `qmd query` | hybrid plus LLM reranking | ~5s warm, up to ~75s on the first call while models load |

Separate collections are what make a scoped search exact: qmd filters by collection
(`-c`, repeatable) and has no path filter, so one collection per tier means the
other projects are not searched at all rather than being filtered out afterwards.

On startup the brain creates the missing collections with path contexts and indexes in the background. After every write it schedules a debounced `qmd update` plus an `embed` of the tier that changed, and a search arriving while the index catches up waits briefly (default 5s, `QMD_INDEX_WAIT_MS`) so an agent can find what it just wrote. Collections left over from the flat v0.1 layout are reported at startup, since `qmd update` reindexes every collection on the machine whether or not anything reads it.

It degrades rather than breaks, and always reports which engine answered:

- qmd missing, or the collection not ready → built-in BM25, with a note.
- qmd returns nothing while the index is behind a fresh write → BM25 for that query, note `qmd index is catching up`.
- qmd errors (for example embeddings were never built) → BM25, with the qmd error attached.
- An offline agent searches its cached mirror with BM25 and says so.

Set `QMD_UPDATE=off` on the brain to keep the extension out of the indexer entirely.

## Offline caching

Agents mirror the brain so a dead network or a sleeping brain machine does not cost them their memory. The brain stays authoritative: the mirror is only consulted when a request to it fails.

- **What is mirrored:** core, shared, and the project the session is in. A project another session mirrored stays as it was last seen, and each tier keeps its own timestamp, because every session on a machine shares this cache directory. The mirror keeps the brain's own layout (`core/`, `shared/`, `ns/<id>/`) under `~/.pi/agent/pi-scale-memory/cache/`, so offline reads are built and ranked by the same code as online ones. Deletions propagate.
- **When it syncs:** on connect and every 60s while connected (`PI_SCALE_MEMORY_CACHE_SYNC_MS`). `/brain sync` forces one; `/brain status` shows file count and age.
- **Offline reads:** `memory_read`, `memory_search` and the session-start memory block fall back to the mirror, labelled `(brain unreachable — showing the cached copy taken …; it may be stale)`.
- **Offline writes:** queued in memory and sent when the brain returns. A write still queued when pi exits is lost.
- **Same ranking offline:** the mirror reuses the brain's own context builder and BM25 search (`brain/memory.mjs`), so offline results are ranked and trimmed exactly like online ones.
- **Disable it:** `PI_SCALE_MEMORY_CACHE=0`. The brain role never caches.

Nothing outside the memory layout is ever written into the cache: a snapshot entry that is not `MEMORY.md`, `SCRATCHPAD.md`, or `daily/YYYY-MM-DD.md` is ignored.

## Manual setup

Run the brain server yourself if you prefer not to let the brain role manage it:

```bash
BRAIN_DIR=~/.pi-scale-brain BRAIN_PORT=8787 node brain/server.mjs
```

It binds `127.0.0.1` by default: reachability comes from the brain's own
tailscale node and `tailscale serve`, not from listening on a public interface.
Set `BRAIN_TOKEN` if you want a shared secret on top of the ACL (agents then need
`PI_SCALE_MEMORY_TOKEN` or `brainToken` in their config), and `BRAIN_HOST` only
if you deliberately want it on another interface.

To publish a server you started yourself, point serve at it through the
extension's socket:

```bash
tailscale --socket=~/.pi/agent/pi-scale-memory/brain-tailnet/tailscaled.sock \
  serve --bg --tcp=8787 tcp://127.0.0.1:8787
```

## Configuration

Saved per machine at `~/.pi/agent/pi-scale-memory/config.json` (mode 0600): role, the pre-auth key, the brain port, and an optional brain token. Environment overrides:

| Variable | Meaning |
|---|---|
| `PI_SCALE_MEMORY_AUTHKEY` | tailnet pre-auth key |
| `PI_SCALE_MEMORY_TOKEN` | brain token, must match `BRAIN_TOKEN` on the brain server |
| `PI_SCALE_MEMORY_LOGIN_SERVER` | control server override (unset = Tailscale) |
| `PI_SCALE_MEMORY_PORT` | brain API port (default 8787) |
| `PI_SCALE_MEMORY_CONFIG_DIR` | where config, cache, brain log and pid file live |
| `PI_SCALE_MEMORY_CACHE` | `0` disables the agent-side offline mirror |
| `PI_SCALE_MEMORY_CACHE_SYNC_MS` | mirror refresh interval while connected (default 60000) |
| `PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS` | turns between automatic daily-log summaries (0 disables) |
| `PI_SCALE_MEMORY_NAMESPACE` | pins the project namespace instead of deriving it from git |
| `PI_SCALE_MEMORY_SCOPE_REMOTE` | which remote is canonical when a repository has several (default `origin`) |
| `PI_SCALE_MEMORY_SCOPE_FALLBACK` | `path` (default) or `legacy` for a workspace that is not a git repository |

Brain-side environment (where `brain/server.mjs` runs):

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_DIR` | `~/.pi-scale-brain` | memory directory |
| `BRAIN_HOST` | `127.0.0.1` | listen address |
| `BRAIN_TOKEN` | unset | require `Authorization: Bearer <token>` |
| `QMD_COLLECTION_PREFIX` | `psm` | one collection per tier is named `<prefix>-<tier>`, since qmd filters by collection and not by path |
| `QMD_COLLECTION` | `pi-scale-memory` | the flat v0.1 collection name; the brain reports it at startup when nothing searches it any more, because `qmd update` reindexes every collection on the machine |
| `QMD_UPDATE` | `background` | `background` re-indexes after writes; `manual`/`off` leave the index to you |
| `QMD_SEARCH_MODE` | `semantic` | mode used when a request does not name one |
| `QMD_SEARCH_TIMEOUT_MS` | per mode (30s/120s/240s) | qmd query timeout override |
| `QMD_INDEX_WAIT_MS` | `5000` | how long a search waits for a pending re-index |
| `QMD_EMBED_TIMEOUT_MS` | `600000` | cap on a `qmd embed` run |

### Control plane

This extension targets Tailscale. It has not been tested against Headscale; `PI_SCALE_MEMORY_LOGIN_SERVER` is honoured if you want to point the agent-side client at another control server, but nothing in the setup flow installs or configures one.

## Starting over

`/reset-pi-scale-settings` (or `/brain reset`) stops the brain server and the brain's tailscale node, logs this session's agent node out, and deletes the extension's whole state directory — saved role, pre-auth keys, brain token, cached memory, the brain's tailscale state, logs and pid files:

```
~/.pi/agent/pi-scale-memory/
```

It also clears socket directories left behind by sessions that crashed, but only those older than an hour, so a concurrently running pi is left alone. Everything it will stop and delete is listed in the confirmation prompt before anything happens; declining changes nothing.

It cannot delete the machines this extension registered in your tailnet — that needs the admin console or the Tailscale API. They are listed there as devices named `pi-brain-<host>` and `pi-agent-<host>`. A reset logs the agent node out too, before its socket is removed, so the device does not linger holding an expired key. After a reset, set up again with `/join-tailnet-brain` or `/join-tailnet-agent`, which registers a fresh device.

## Updating

`/update-pi-scale-memory` detects how the extension was installed:

- a **git checkout** (cloned locally, or installed from a local path): refuses to touch a dirty tree or a detached HEAD, then `git pull --ff-only` and reports the commit change;
- a **pi package** listed in `~/.pi/agent/settings.json`: runs `pi update <source>`;
- anything else: prints what to run instead.

After updating it restarts the brain server (when this machine is the brain) and reloads the extension runtime, so the new code is live without restarting pi.

## Behavior

- The memory block is fetched from the brain at session start — core, shared, and the session's project — and injected on every turn; when the brain is unreachable the cached copy is injected instead.
- The project namespace is resolved once per session from git (`git remote`, then the repository path, then the working directory), with the result cached; an unresolvable workspace still gets core and shared memory.
- Appends go out immediately; if the brain is unreachable they are queued, carrying their namespace, and flushed every 30s. `/core-memory` never queues.
- A `MEMORY.md` append that restates an existing entry replaces it instead of adding a near-copy.
- An LLM summary of the new conversation is stored in the project's daily log every 15 turns, before compaction, and on exit. Nothing writes to core or shared on its own.
- Agents refresh their offline mirror on connect and every 60s thereafter.
- Search is served by the brain's qmd index when available, otherwise by BM25; `memory_search` reports which engine answered.

## Development

```bash
npm install
npm test         # unit tests + live brain-server and cache round-trips over loopback
npm run build    # tsc --noEmit
```

`test/unit.ts` covers both nodes' naming, paths, status and serve helpers, peer parsing, the discovery probe (ranking, ambiguity, a pinned host, an unresponsive peer, the deadline it hands the probe), the retry backoff, a refused pre-auth key, the SOCKS handshake timeout and probe budget, the qmd install planning, self-update detection, the qmd plumbing (including multi-collection arguments), namespace resolution over a table of remote URL forms, worktrees, submodules and non-repositories (with the git runner injected, so no repository is needed), write-time deduplication, the prompt budget and its drop order, migration idempotency, the brain server lifecycle (including token enforcement and conflict detection), the three tiers over loopback (core's single writer, shared's write rules, project isolation, namespace listing, merging, traversal rejection, the legacy default), the offline cache per tier, and command registration. When qmd is installed it also runs a real semantic search through the brain using throwaway per-tier collections that it removes afterwards, so it does not disturb any qmd index you already have.

The suite also starts a real userspace `tailscaled` and asserts it is a separate, unjoined node while the host's own daemon keeps its state, node id and peers. What is **not** covered: an actual successful join, serve proxying, and discovery across real peers — those need a live tailnet and a pre-auth key. In particular, that a second session *reuses* an already-joined node is verified against a live daemon (one process, one pid) but not against a real tailnet, and the retry loop is not driven end to end by a test — the delay ladder and the three-try cap are covered, but driving the loop needs pi's session lifecycle and a real tailnet.

## Security

The ACL is the gate: an agent can only reach the brain if the policy allows it to reach that port. Keep the pre-auth keys out of the repository; they live in `config.json` (0600) on each machine. If you want a second layer, set `BRAIN_TOKEN` on the brain and the matching `PI_SCALE_MEMORY_TOKEN` on the agents.

Write authority is the second, narrower gate inside that: core memory is human-authored, and no tool, no automatic capture and no other endpoint can write it. A canonical remote key never contains credentials, because the userinfo part of a remote URL is stripped before the key is derived, hashed or recorded.

Isolation is deliberately one-directional: the extension's nodes are completely separate from the host's, but the extension's state files (config, cache, the brain's tailscaled state, logs, pid files) live under `~/.pi/agent/pi-scale-memory/` with 0600 for anything containing a key.
