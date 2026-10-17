# pi-scale-memory

A pi extension that gives many pi agents one shared memory (a "brain") over a private tailnet.

The brain joins the tailnet with the machine's own Tailscale as `tag:brain`, so its memory API is reachable at its tailnet address. Agents join with a pre-auth key as `tag:agent`, each running its own **userspace** `tailscaled` (no TUN device, no route changes, SOCKS5 proxy only) so joining a tailnet never touches the machine's system Tailscale. Agents also keep a local mirror of the memory, so they can still read while the brain is unreachable.

Memory model and tools follow [pi-memory](https://github.com/jayzeng/pi-memory): `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, tools `memory_write`, `memory_read`, `scratchpad`, `memory_search`, `memory_forget`, plus a memory snapshot injected into the system prompt. Differences: storage is remote and shared, the search index lives on the brain (qmd, with BM25 fallback), and agents cache the memory for offline use.

## Requirements

- **Tailscale** on every machine (`tailscale` and `tailscaled` on `PATH`).
- Tagged pre-auth keys: one for the brain (`tag:brain`), reusable ones for agents (`tag:agent`).
- Node >= 22.
- Optional, on the **brain**: [qmd](https://github.com/tobi/qmd) (`npm install -g @tobilu/qmd`) for semantic and deep search. Agents never need qmd.

Nothing is published to the internet: the memory API is reachable only from the tailnet, and the ACL is what decides who can reach it.

## Roles

`/self-tag` sets what this pi agent is, and the join commands set it too:

| Role | What it does | Memory path |
|---|---|---|
| `brain` | Runs the memory server, tagged `tag:brain` on the machine's own Tailscale | local server on `127.0.0.1`, reachable by agents at its tailnet address |
| `agent` | Runs a private userspace tailscaled tagged `tag:agent`, discovers the brain by tag | the tailnet, plus a local mirror for offline reads |

## Commands

| Command | Applies to | What it does |
|---|---|---|
| `/join-tailnet-brain` | brain | Joins this machine with a `tag:brain` pre-auth key, verifies the tag stuck, sets the role to `brain`, and starts the memory server |
| `/join-tailnet-agent` | agent | Joins with a `tag:agent` pre-auth key on a private userspace tailscaled, then finds the brain by tag |
| `/generate-preauth` | brain only | Mints a `tag:agent` auth key through the Tailscale API (needs an API token with the `auth_keys` scope) |
| `/self-tag [brain\|agent]` | both | Sets the role on its own, without joining |
| `/brain status\|sync\|reindex\|reconnect\|reset` | both | Shows role, brain, health, search engine, queue and cache age; refreshes the offline mirror; reports the brain's index; rejoins; deletes the saved config |
| `/update-pi-scale-memory` | both | Updates the extension (git pull, or `pi update`) and reloads it |

### Quick start

On the machine that will hold the memory:

```
/join-tailnet-brain  # paste a tag:brain pre-auth key
/generate-preauth    # prints a tag:agent key for the other machines
```

On every other machine:

```
/join-tailnet-agent  # paste the tag:agent key
```

That is the whole setup. The brain prints its node name when it joins, and agents report both the node name they registered as and the brain they found.

### Making it reachable

Two things must hold, and the extension reports when either is missing:

- the ACL must let `tag:agent` reach `tag:brain` on the brain's port (default 8787);
- the brain machine must have its own Tailscale up, which `/join-tailnet-brain` ensures.

An agent that joins successfully but finds nothing tagged `tag:brain` says exactly that and tells you to run `/join-tailnet-brain` on the brain, rather than pretending it connected.

### Sample Tailscale ACL

In the tailnet policy file (admin console → Access controls):

```jsonc
{
  // tag owners may be a user email, a group, an autogroup, or another tag
  "tagOwners": {
    "tag:agent": ["autogroup:member"],
    "tag:brain": ["autogroup:member"]
  },

  "acls": [
    // agents may only reach the brain's memory API, nothing else
    { "action": "accept", "src": ["tag:agent"], "dst": ["tag:brain:8787"] }
  ]
}
```

## Troubleshooting

**`tailscale up` refuses with "requires mentioning all non-default flags".**
Tailscale prints this when the device already has settings that the new command
would silently revert. `/join-tailnet-brain` handles it: it parses the suggested
command out of the error, re-runs it with your key and tag added and every
existing setting kept, and tells you which settings it preserved. If the
suggestion is unusable it asks before doing anything drastic:

```
Retry with --reset? That clears this device's other Tailscale settings
(exit node, routes, SSH, hostname) and rejoins with tag:brain only.
```

To do it by hand, either name your current settings yourself (see
`tailscale debug prefs`) or accept the reset:

```bash
tailscale up --auth-key=<key> --advertise-tags=tag:brain --reset
```

**An agent joined but found no brain.** The brain must be online with
`tag:brain`; run `/join-tailnet-brain` there and `/brain reconnect` on the agent.
Check the ACL lets `tag:agent` reach `tag:brain:8787`.

**`memory_search` says the engine is bm25.** qmd is not installed on the brain,
or its index is still catching up. See [Search](#search).

## Search

Search runs on the brain, so one index serves every agent. With qmd installed there, the brain indexes the memory directory as a collection (default `pi-scale-memory`) and answers three modes:

| `memory_search` mode | qmd command | What it does | Typical latency |
|---|---|---|---|
| `keyword` | `qmd search` | BM25 full-text, no model | instant |
| `semantic` (default) | `qmd vsearch` | vector similarity, finds paraphrases | ~3s warm |
| `deep` | `qmd query` | hybrid plus LLM reranking | ~5s warm, up to ~75s on the first call while models load |

On startup the brain creates the collection with path contexts and indexes in the background. After every write it schedules a debounced `qmd update` plus a scoped `qmd embed`, and a search arriving while the index catches up waits briefly (default 5s, `QMD_INDEX_WAIT_MS`) so an agent can find what it just wrote.

It degrades rather than breaks, and always reports which engine answered:

- qmd missing, or the collection not ready → built-in BM25, with a note.
- qmd returns nothing while the index is behind a fresh write → BM25 for that query, note `qmd index is catching up`.
- qmd errors (for example embeddings were never built) → BM25, with the qmd error attached.
- An offline agent searches its cached mirror with BM25 and says so.

Set `QMD_UPDATE=off` on the brain to keep the extension out of the indexer entirely.

## Offline caching

Agents mirror the brain so a dead network or a sleeping brain machine does not cost them their memory. The brain stays authoritative: the mirror is only consulted when a request to it fails.

- **What is mirrored:** `MEMORY.md`, `SCRATCHPAD.md` and all of `daily/`, under `~/.pi/agent/pi-scale-memory/cache/`. Deletions propagate.
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

It binds `0.0.0.0:8787` by default, so any tailnet peer the ACL allows can reach it at its tailnet address. Set `BRAIN_HOST=127.0.0.1` to keep it local, and `BRAIN_TOKEN` if you want a shared secret on top of the ACL (agents then need `PI_SCALE_MEMORY_TOKEN` or `brainToken` in their config).

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
| `PI_SCALE_MEMORY_TAILSCALE_API_TOKEN` | Tailscale API token used by `/generate-preauth` |
| `PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS` | turns between automatic daily-log summaries (0 disables) |

Brain-side environment (where `brain/server.mjs` runs):

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_DIR` | `~/.pi-scale-brain` | memory directory |
| `BRAIN_HOST` | `0.0.0.0` | listen address |
| `BRAIN_TOKEN` | unset | require `Authorization: Bearer <token>` |
| `QMD_COLLECTION` | `pi-scale-memory` | qmd collection name |
| `QMD_UPDATE` | `background` | `background` re-indexes after writes; `manual`/`off` leave the index to you |
| `QMD_SEARCH_MODE` | `semantic` | mode used when a request does not name one |
| `QMD_SEARCH_TIMEOUT_MS` | per mode (30s/120s/240s) | qmd query timeout override |
| `QMD_INDEX_WAIT_MS` | `5000` | how long a search waits for a pending re-index |
| `QMD_EMBED_TIMEOUT_MS` | `600000` | cap on a `qmd embed` run |

### Control plane

This extension targets Tailscale. It has not been tested against Headscale; `PI_SCALE_MEMORY_LOGIN_SERVER` is honoured if you want to point the agent-side client at another control server, but nothing in the setup flow installs or configures one.

## Updating

`/update-pi-scale-memory` detects how the extension was installed:

- a **git checkout** (cloned locally, or installed from a local path): refuses to touch a dirty tree or a detached HEAD, then `git pull --ff-only` and reports the commit change;
- a **pi package** listed in `~/.pi/agent/settings.json`: runs `pi update <source>`;
- anything else: prints what to run instead.

After updating it restarts the brain server (when this machine is the brain) and reloads the extension runtime, so the new code is live without restarting pi.

## Behavior

- The memory snapshot is fetched from the brain at session start and injected on every turn; when the brain is unreachable the cached copy is injected instead.
- Appends go out immediately; if the brain is unreachable they are queued and flushed every 30s.
- An LLM summary of the new conversation is stored in the daily log every 15 turns, before compaction, and on exit.
- Agents refresh their offline mirror on connect and every 60s thereafter.
- Search is served by the brain's qmd index when available, otherwise by BM25; `memory_search` reports which engine answered.

## Development

```bash
npm install
npm test         # unit tests + live brain-server and cache round-trips over loopback
npm run build    # tsc --noEmit
```

`test/unit.ts` covers the Tailscale status and tag helpers, the Tailscale API key request shape, duration parsing, self-update detection, the qmd plumbing, the brain server lifecycle (including token enforcement and conflict detection), the offline cache, and command registration. When qmd is installed it also runs a real semantic search through the brain using a throwaway collection that it removes afterwards, so it does not disturb any qmd index you already have.

**Not covered by tests:** anything requiring a real tailnet — `tailscaled` startup, `tailscale up`, tag assignment, tag discovery, and the Tailscale API calls. Those need a live tailnet.

## Security

The ACL is the gate: an agent can only reach the brain if the policy allows `tag:agent` → `tag:brain:8787`. Keep the pre-auth keys and the Tailscale API token out of the repository; they live in `config.json` (0600) on each machine. If you want a second layer, set `BRAIN_TOKEN` on the brain and the matching `PI_SCALE_MEMORY_TOKEN` on the agents.
