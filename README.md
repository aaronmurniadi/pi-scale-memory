# pi-scale-memory

A pi extension that gives many pi agents one shared memory (a "brain") over a private tailnet.

Each role runs its own private userspace `tailscaled`: no `sudo`, no TUN device, no route or DNS changes, and the host's own Tailscale — a work tailnet, say — is never touched. The brain publishes its memory API with `tailscale serve --tcp`, which proxies tailnet traffic to `127.0.0.1`; agents reach it through their node's SOCKS5 proxy. Every session on a machine shares that one node, so a machine joins once and keeps the same device. Agents also mirror what they read, so a sleeping brain machine does not cost them their memory.

Two things are worth knowing before you set it up:

- **Agents find the brain by asking, not by tag.** An agent reads the peer list it already has, asks every peer on the memory port, and accepts the one whose `/v1/health` says `service: pi-scale-memory`, `role: brain`. Nothing to declare: no tags, no `tagOwners`, no port scanning outside your tailnet.
- **A brain that is not answering is retried three times, then left to you** (5s, 10s, 20s). By then the cause is usually yours to fix — no brain running, the wrong port, a machine asleep — so the status line says `run /psm-memory connect` instead of retrying in silence. Reads keep coming from the local mirror meanwhile.

Memory itself follows [pi-memory](https://github.com/jayzeng/pi-memory): `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, the tools `memory_write`, `memory_read`, `scratchpad`, `memory_search`, `memory_forget`, and a snapshot injected into the system prompt. The differences: storage is remote and shared, memory is split into three tiers by who may write it, the search index lives on the brain, and agents cache the memory for offline use.

## Requirements

- **Tailscale** on every machine (`tailscale` and `tailscaled` on `PATH`). No root access is needed.
- A pre-auth key per machine, from the Tailscale admin console (Settings -> Keys). A key registers a node once, so a single-use key is enough and no tags are involved.
- Node >= 22.
- Optional, on the **brain**: [qmd](https://github.com/tobi/qmd) for semantic and deep search, installable from inside pi with `/psm-install-qmd`. Agents never need qmd.

Nothing is published to the internet: the API is reachable only from the tailnet, and the ACL decides who gets there.

## Roles

`/psm-role` sets what this pi agent is, and the join commands set it too:

| Role | What it does | Memory path |
|---|---|---|
| `brain` | Runs the memory server plus a detached userspace node, and publishes the API with `tailscale serve` | local server on `127.0.0.1`, proxied to the tailnet |
| `agent` | Runs a detached userspace node (shared by every session on the machine), then asks its peers which one is the brain | the tailnet, plus a local mirror for offline reads |

## Memory tiers

Memory is split by **who may write it**, because the awkward failure is an agent quietly editing what you asked it to remember.

| Tier | Scope | Written by | In the prompt |
|---|---|---|---|
| **Core** | every session, every project, every machine | you, with `/psm-core-memory`; or `memory_write` scope `core` when you ask for it | always |
| **Shared** | every session, every project | agents: `memory_write` scope `shared`, pruned with `memory_forget` | always |
| **Project** | one git repository | agents, freely: `MEMORY.md`, the scratchpad, the daily log | when a project namespace resolves |

The project tier is resolved from git rather than from the directory: `git remote get-url origin` normalised to `github.com/acme/api`, so two clones on two machines share one project's memory and a worktree shares its parent's. A repository with no remote, or a directory that is not a repository, gets a namespace naming this machine and that path, because those genuinely cannot be shared. `PI_SCALE_MEMORY_NAMESPACE` (or `namespace` in the config) pins one explicitly.

Core is enforced at the brain rather than requested in a prompt: `/v1/write`, `/v1/forget` and `/v1/scratchpad` all reject it, so `POST /v1/core` is the only route in — `/psm-core-memory` for you, `memory_write` scope `core` for an agent you told to remember something there. A core write is never queued: if the brain is unreachable it says so rather than leaving a rule you believe was saved sitting in an outbox.

Keeping the tiers worth their tokens:

- Each tier is injected under a budget — core 2 000 chars, shared 3 000, project `MEMORY.md` 8 000, scratchpad 4 000, today 6 000, yesterday 4 000 — under a 12 000-char ceiling for the block. The order is core, shared, project, scratchpad, today, yesterday. When the block does not fit, the least valuable section gives up its room first and is dropped only when what is left could not hold a useful fragment of it; `MEMORY.md` is trimmed from the front so the newest entries survive, and core and shared are never what gives way.
- A write that restates an existing entry **replaces** it rather than appending a near-copy, and tells the writer it did (`deduped`). `/psm-core-memory` reporting "already said that" is that working, not a silent no-op.
- `/psm-memory compact [ns]` folds a `MEMORY.md` down with the session model and refuses to write a result that is not shorter than the original. `/psm-memory ns` prints this machine's namespace and lists every namespace with its size and daily-log count. `/psm-memory merge <from> <into>` folds one namespace into another, for when a renamed remote changes the key.

Upgrading from the flat v0.1 layout moves `MEMORY.md` and any open scratchpad items into **shared** — they were cross-project notes written by agents, and core takes no agent writes — and archives the old daily logs under a `legacy` namespace that nothing injects. A caller that names no namespace, such as an older agent, lands in `legacy` too: read it with `/psm-memory pin legacy`, and `/psm-memory pin --clear` to resolve from git again.

## Commands

| Command | Applies to | What it does |
|---|---|---|
| `/psm-join brain` | brain | Starts this machine's own userspace Tailscale node, joins it with a pre-auth key, publishes the memory port to the tailnet, and sets the role to `brain` |
| `/psm-join agent` | agent | Joins with a pre-auth key on a private userspace tailscaled, then asks the tailnet which peer is the brain |
| `/psm-role [brain\|agent]` | both | Sets the role on its own, without joining |
| `/psm-install-qmd` | brain | Installs qmd for semantic search, into a prefix that is on your `PATH`, then restarts the brain so it indexes with it |
| `/psm-reset` | both | Stops the daemons this extension started, logs its tailscale nodes out, and deletes all of its state so you can start over |
| `/psm-core-memory <memory>` | both | Writes **core memory** (`memory_write` scope `core` writes it too, on your explicit request). No arguments shows core; `--remove <match>` deletes matching entries, keeping a recovery copy |
| `/psm-memory status\|ns\|pin\|merge\|compact\|sync\|search\|connect` | both | Shows role, brain, health, search engine, namespace and tier sizes, queue and cache age; prints this machine's namespace and lists the brain's namespaces; pins the namespace for this machine (`--clear` unpins); merges two namespaces; folds a `MEMORY.md` down with the session model, to that tier's own budget; refreshes the offline mirror; reports the brain's search engine and collections; reconnects |
| `/psm-update` | both | Updates the extension (git pull, or `pi update`) and reloads it |

### Quick start

Create a pre-auth key for each machine: one for the brain, one for each agent. Leave Reusable off if you like — a node registers once and keeps its identity, so a key is spent only by that machine's first join. Then, on the machine that will hold the memory:

```
/psm-join brain  # paste the brain's key
```

On every other machine:

```
/psm-join agent  # paste an agent key
```

That is the whole setup. Nothing has to be declared beforehand, because agents identify the brain by asking it, and make the key reusable only if one key should serve several machines. Two devices appear in your tailnet: `pi-brain-<host>` for the brain and `pi-agent-<host>` per agent machine. A machine keeps its device across sessions and restarts rather than registering a new one, so the list does not grow; the host machines' own Tailscale devices are untouched and can be in a different tailnet entirely.

### Making it reachable

Two things must hold, and the extension reports when either is missing:

- the ACL must let each agent reach the brain's node on the memory port (default 8787);
- the brain's node must be joined and serving, which `/psm-join brain` ensures. On later sessions the brain restarts that node itself from its saved state, so it is only needed once.

Since discovery uses no tags, the ACL only has to allow your devices to reach that port:

```jsonc
"grants": [
  { "src": ["autogroup:member"], "dst": ["autogroup:member"], "ip": ["8787"] }
]
```

Narrow `dst` to the brain's device or a group if you want tighter control. To skip discovery entirely, point an agent at a fixed address:

```bash
PI_SCALE_MEMORY_BRAIN_HOST=100.64.0.5 pi
```

An agent that joins but finds no brain reports how many peers it asked and on which port, and tells you to run `/psm-join brain` on the brain, rather than pretending it connected. If more than one peer answers as a brain it says so and names them, because that ambiguity would otherwise pick one silently.

The brain's node is detached and survives pi exiting, so agents keep reaching the memory while no session is open on the brain machine. `/psm-reset` stops it.

## Search

Search runs on the brain, so one index serves every agent. Install qmd with `/psm-install-qmd`; the brain mentions it once at startup when it is missing, and without it everything still works through BM25. The install picks a prefix whose `bin` directory is actually on `PATH` and verifies it, because a plain `npm install -g` under a node version manager often reports success while `qmd` stays unfindable. If no such prefix exists it stops and prints the exact commands to run yourself.

| `memory_search` mode | qmd command | What it does | Typical latency |
|---|---|---|---|
| `keyword` | `qmd search` | BM25 full-text, no model | instant |
| `semantic` (default) | `qmd vsearch` | vector similarity, finds paraphrases | ~3s warm |
| `deep` | `qmd query` | hybrid plus LLM reranking | ~5s warm, up to ~75s on the first call while models load |

Search is scoped to the tiers you ask for and never another project: `memory_search` takes `scope: all | project | shared | core` — the default `all` is core plus shared plus the session's project — `memory_read` takes `project | shared | core`, and every result is labelled with the tier it came from. One collection per tier (`<prefix>-<tier>`, default prefix `psm`) is what makes that exact: qmd filters by collection (`-c`, repeatable) and has no path filter, so another project is not searched at all rather than filtered out afterwards.

On startup the brain creates the missing collections with path contexts and indexes in the background. After every write it schedules a debounced `qmd update` plus an `embed` of the tier that changed, and a search arriving while the index catches up waits briefly (default 5s, `QMD_INDEX_WAIT_MS`) so an agent can find what it just wrote. It degrades rather than breaks, and always says which engine answered: qmd missing, behind a fresh write, or erroring all fall back to BM25 with a note, and an offline agent searches its mirror with BM25 and says so. Collections left over from the flat v0.1 layout are reported at startup. `QMD_UPDATE=off` on the brain keeps the extension out of the indexer entirely.

## Offline caching

Agents mirror the brain so a dead network or a sleeping brain machine does not cost them their memory. The brain stays authoritative: the mirror is only consulted when a request to it fails.

- **What is mirrored:** core, shared, and the project the session is in, under `~/.pi/agent/pi-scale-memory/cache/` in the brain's own layout (`core/`, `shared/`, `ns/<id>/`), so offline reads are built and ranked by the same code as online ones. Each tier keeps its own timestamp, because every session on a machine shares this directory; deletions propagate.
- **When it syncs:** on connect and every 60s while connected (`PI_SCALE_MEMORY_CACHE_SYNC_MS`). `/psm-memory sync` forces one; `/psm-memory status` shows file count and age.
- **Offline reads** fall back to the mirror, labelled `(brain unreachable — showing the cached copy taken …; it may be stale)`. **Offline writes** are queued in memory and sent when the brain returns; a write still queued when pi exits is lost.
- **Disable it** with `PI_SCALE_MEMORY_CACHE=0`. The brain role never caches.

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
| `PI_SCALE_MEMORY_EXIT_TIMEOUT_MS` | how long the exit summary may hold up `/quit` (default 3000, capped at 60000) |
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

This extension targets Tailscale. It has not been tested against Headscale; `PI_SCALE_MEMORY_LOGIN_SERVER` is honoured if you want to point the agent-side client at another control server, but nothing in the setup flow installs or configures one.

## Running the brain by hand

```bash
BRAIN_DIR=~/.pi-scale-brain BRAIN_PORT=8787 node brain/server.mjs
```

It binds `127.0.0.1`: reachability comes from the brain's own tailscale node and `tailscale serve`, not from listening on a public interface. `BRAIN_TOKEN` adds a shared secret on top of the ACL (agents then need `PI_SCALE_MEMORY_TOKEN` or `brainToken` in their config), and `BRAIN_HOST` moves the listen address. To publish a server you started yourself:

```bash
tailscale --socket=~/.pi/agent/pi-scale-memory/brain-tailnet/tailscaled.sock \
  serve --bg --tcp=8787 tcp://127.0.0.1:8787
```

## Reset and update

`/psm-reset` stops the brain server and the brain's tailscale node, logs this session's agent node out, and deletes the extension's whole state directory — saved role, pre-auth keys, brain token, cached memory, the brain's tailscale state, logs and pid files — plus socket directories older than an hour, so a concurrently running pi is left alone. Everything it will stop and delete is listed in the confirmation prompt, and declining changes nothing.

It cannot delete the machines this extension registered in your tailnet; those are listed there as `pi-brain-<host>` and `pi-agent-<host>`, and need the admin console or the Tailscale API. A reset logs the agent node out before its socket is removed, so the device does not linger holding an expired key. After one, set up again with `/psm-join brain` or `/psm-join agent`, which registers a fresh device.

`/psm-update` detects how the extension was installed: a **git checkout** gets `git pull --ff-only`, refusing a dirty tree or a detached HEAD; a **pi package** listed in `~/.pi/agent/settings.json` gets `pi update <source>`; anything else prints what to run instead. It then restarts the brain server (when this machine is the brain) and reloads the extension, so the new code is live without restarting pi.

## Behavior

- The memory block is fetched at session start — core, shared, and the session's project — and injected on every turn; when the brain is unreachable the cached copy is injected instead.
- The project namespace is resolved once per session from git (`git remote`, then the repository path, then the working directory) and cached. An unresolvable workspace still gets core and shared memory.
- Appends go out immediately; if the brain is unreachable they are queued, carrying their namespace, and flushed every 30s. `/psm-core-memory` never queues.
- An LLM summary of the new conversation is stored in the project's daily log every 15 turns, before compaction, and on exit. Nothing writes to core or shared on its own.
- The exit summary runs against `PI_SCALE_MEMORY_EXIT_TIMEOUT_MS`: pi waits for `session_shutdown` handlers before it exits, so the summary is time-boxed rather than allowed to hold `/quit` open, and one that does not fit in the budget is dropped.

## Development

```bash
npm install
npm test         # unit tests + live brain-server and cache round-trips over loopback
npm run build    # tsc --noEmit
```

`test/unit.ts` covers node naming, paths, status and serve helpers, peer parsing and the discovery probe, the retry ladder, a refused pre-auth key, the SOCKS handshake, the qmd install planning and plumbing, self-update detection, namespace resolution (remote URL forms, worktrees, submodules, non-repositories), dedup and the prompt budget, migration, the brain server lifecycle including token enforcement, the three tiers over loopback, the per-tier offline cache, and command registration. It also starts a real userspace `tailscaled` and asserts it stays a separate, unjoined node while the host's daemon keeps its state and peers. Not covered without a live tailnet and a pre-auth key: a real join, serve proxying, cross-peer discovery, and the retry loop driven end to end (the delay ladder and three-try cap are covered).

## Security

The ACL is the gate: an agent can only reach the brain if the policy allows that port. Keep pre-auth keys out of the repository — they live in `config.json` (0600) on each machine — and set `BRAIN_TOKEN` with a matching `PI_SCALE_MEMORY_TOKEN` if you want a second layer.

Write authority is the narrower gate inside that: core memory is the human's tier, reached only through `POST /v1/core`, and no automatic capture writes it. A canonical remote key never contains credentials, because the userinfo part of a remote URL is stripped before the key is derived, hashed or recorded.

Isolation is deliberately one-directional: the extension's nodes are completely separate from the host's, but its state files (config, cache, the brain's tailscaled state, logs, pid files) live under `~/.pi/agent/pi-scale-memory/` with 0600 for anything containing a key.
