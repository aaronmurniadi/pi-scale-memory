# pi-scale-memory

A pi extension that gives many pi agents one shared memory (a "brain"). The brain publishes its API through **Tailscale Funnel** and hands you the URL; agents each run their own **userspace** `tailscaled`, so joining a tailnet never touches the machine's system Tailscale, and they keep a local mirror of the memory so they can still read while the brain is unreachable.

Memory model and tools follow [pi-memory](https://github.com/jayzeng/pi-memory): `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, tools `memory_write`, `memory_read`, `scratchpad`, `memory_search`, `memory_forget`, plus a memory snapshot injected into the system prompt. Differences: storage is remote and shared, the search index lives on the brain (qmd, with BM25 fallback), and agents cache the memory for offline use.

## Why Tailscale and not Headscale

Funnel is a hard requirement here: it is what gives the brain a stable public HTTPS URL without port forwarding or DNS work. Headscale cannot provide it. From the Headscale maintainer, on [issue #1040](https://github.com/juanfont/headscale/issues/1040):

> We cannot really implement Tailscale's Funnel per se as it is not a public infrastructure like DERP. The way it works is roughly by setting up a connection between your node and the Tailscale Funnel ingress *via* your tailnet. This means that the tailnet must be hosted on tailscale.com.

Headscale also cannot serve `tailscale serve` yet ([#1921](https://github.com/juanfont/headscale/issues/1921)), which is the other way to expose a service on a node. So this extension targets the Tailscale control plane. Agents still never need your system Tailscale: they run their own userspace instance.

## Requirements

- **Tailscale** on every machine (`tailscale` and `tailscaled` on `PATH`), v1.38.3 or later.
- A tailnet whose MagicDNS domain is the standard `<tailnet>.ts.net` — Funnel cannot serve custom domains.
- HTTPS and the `funnel` node attribute enabled for the tailnet. `tailscale funnel` walks you through approving this the first time.
- Node >= 22.
- Optional, on the **brain**: [qmd](https://github.com/tobi/qmd) (`npm install -g @tobilu/qmd`) for semantic and deep search. Agents never need qmd.

## Roles

`/self-tag` sets what this pi agent is:

| Role | What it does | Memory path |
|---|---|---|
| `brain` | Runs the memory server, is tagged `tag:brain`, and publishes it with Funnel | local server on `127.0.0.1`, public through Funnel |
| `agent` | Runs a private userspace tailscaled tagged `tag:agent`, or talks to the public URL | Funnel URL or the tailnet, plus a local mirror |

## Commands

| Command | Applies to | What it does |
|---|---|---|
| `/self-tag [brain\|agent]` | both | Sets this agent's role, saves it, and reconnects |
| `/setup-funnel` | brain only | Starts the brain server with a token, joins Tailscale as `tag:brain`, publishes the memory API through Funnel, verifies the public URL, and prints it with the token |
| `/generate-preauth` | brain only | Mints a `tag:agent` auth key through the Tailscale API (needs an API token with the `auth_keys` scope) |
| `/join-tailnet-agent` | agent | Joins the tailnet with a `tag:agent` key and discovers the brain by tag, or points at a public brain URL with its token |
| `/join-tailnet-brain` | brain | Joins this machine with a `tag:brain` key, verifies the tag stuck, and switches the role to `brain` |
| `/brain status\|sync\|reindex\|reconnect\|reset` | both | Shows role, brain, health, search engine, queue and cache age; refreshes the offline mirror; reports the brain's index; rejoins; deletes the saved config |
| `/update-pi-scale-memory` | both | Updates the extension (git pull, or `pi update`) and reloads it |

### Quick start

On the machine that will hold the memory:

```
/join-tailnet-brain  # join with a tag:brain key (sets the role to brain)
/setup-funnel        # prints the public URL and the brain token
/generate-preauth    # prints a tag:agent key for the other machines
```

On every other machine:

```
/join-tailnet-agent          # "Join the tailnet as tag:agent" + the key
/join-tailnet-agent          # or "Use a public brain URL" + URL + token (no tailnet needed)
```

`/setup-funnel` and `/generate-preauth` refuse to run unless the role is `brain`; `/join-tailnet-brain` sets it for you, or use `/self-tag brain`. Joining the tailnet as `tag:brain` does not publish anything on its own — that is what `/setup-funnel` does.

## What `/setup-funnel` does

1. Generates a brain token if none exists. A publicly reachable memory API must never be anonymous, so this is not optional.
2. (Re)starts the local brain server with that token, and warns if something else is already listening on the port with a different token rather than silently adopting it.
3. Ensures Tailscale is up. If the machine is not running, it asks for a `tag:brain` pre-auth key and joins. It warns when the tailnet's MagicDNS domain is not `*.ts.net`, since Funnel cannot serve those.
4. Asks which public port to use (443, 8443 or 10000 — Funnel's only options) and runs `tailscale funnel --bg --https=<port> <brainPort>`. `--bg` keeps the funnel running across reboots.
5. Computes `https://<machine>.<tailnet>.ts.net` and **verifies it from the outside** by calling `/v1/health` through the public URL with the token before reporting success.
6. Saves the URL and token and prints both.

The first Funnel use triggers an approval step in Tailscale: the CLI prints a URL to approve Funnel for the tailnet (which enables HTTPS certificates and adds the `funnel` node attribute). Until that is approved, the funnel command fails and the error is shown verbatim.

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

Run the brain server yourself if you prefer not to let `/setup-funnel` manage it:

```bash
BRAIN_DIR=~/.pi-scale-brain BRAIN_PORT=8787 BRAIN_TOKEN=$(openssl rand -hex 32) node brain/server.mjs
tailscale funnel --bg --https=443 8787      # publishes https://<machine>.<tailnet>.ts.net
tailscale funnel status                     # shows what is published
```

Then on each agent set the URL and token (or use `/join-tailnet-agent`).

### Tailscale ACL

Optional. Needed only when agents reach the brain **over the tailnet** (tag discovery) rather than through the public URL, and it is what makes `tag:agent` and `tag:brain` assignable:

```jsonc
{
  // tag owners may be a user email, a group, an autogroup, or another tag
  "tagOwners": {
    "tag:agent": ["autogroup:member"],
    "tag:brain": ["autogroup:member"]
  },

  "acls": [
    // agents may only reach the brain's memory API
    { "action": "accept", "src": ["tag:agent"], "dst": ["tag:brain:8787"] }
  ],

  // lets a device tagged tag:brain publish a Funnel (the CLI adds this for you)
  "nodeAttrs": [
    { "target": ["tag:brain"], "attr": ["funnel"] }
  ]
}
```

Note that `autogroup:member` is exactly what Headscale rejects in `tagOwners` — Tailscale accepts it, Headscale does not.

## Configuration

Saved per machine at `~/.pi/agent/pi-scale-memory/config.json` (mode 0600): role, the pre-auth key, the brain port, the brain token, the public brain URL, and the last Funnel URL. Environment overrides:

| Variable | Meaning |
|---|---|
| `PI_SCALE_MEMORY_BRAIN_URL` | public brain URL; also forces the agent role |
| `PI_SCALE_MEMORY_TOKEN` | brain token, must match `BRAIN_TOKEN` on the brain server |
| `PI_SCALE_MEMORY_AUTHKEY` | tailnet pre-auth key |
| `PI_SCALE_MEMORY_LOGIN_SERVER` | Tailscale login server override |
| `PI_SCALE_MEMORY_PORT` | brain API port (default 8787) |
| `PI_SCALE_MEMORY_CONFIG_DIR` | where config, cache, brain log and pid file live |
| `PI_SCALE_MEMORY_CACHE` | `0` disables the agent-side offline mirror |
| `PI_SCALE_MEMORY_CACHE_SYNC_MS` | mirror refresh interval while connected (default 60000) |
| `PI_SCALE_MEMORY_TAILSCALE_API_TOKEN` | Tailscale API token used by `/generate-preauth` |
| `PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS` | turns between automatic daily-log summaries (0 disables) |

Brain-side environment (where `brain/server.mjs` runs):

| Variable | Default | Meaning |
|---|---|---|
| `QMD_COLLECTION` | `pi-scale-memory` | qmd collection name |
| `QMD_UPDATE` | `background` | `background` re-indexes after writes; `manual`/`off` leave the index to you |
| `QMD_SEARCH_MODE` | `semantic` | mode used when a request does not name one |
| `QMD_SEARCH_TIMEOUT_MS` | per mode (30s/120s/240s) | qmd query timeout override |
| `QMD_INDEX_WAIT_MS` | `5000` | how long a search waits for a pending re-index |
| `QMD_EMBED_TIMEOUT_MS` | `600000` | cap on a `qmd embed` run |

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

`test/unit.ts` covers the Tailscale status/funnel-URL helpers, the Tailscale API key request shape, duration parsing, self-update detection, the qmd plumbing, the brain server lifecycle (including token enforcement and conflict detection), the offline cache, and command registration. When qmd is installed it also runs a real semantic search through the brain using a throwaway collection that it removes afterwards, so it does not disturb any qmd index you already have.

**Not covered by tests:** anything requiring a real tailnet — `tailscaled` startup, `tailscale up`, tag discovery, Funnel publishing, and the Tailscale API calls. Those need a live tailnet.

## Security

A funneled brain is reachable by anyone who has the URL, so the token is what protects it — treat it like a password, and prefer agents on the tailnet with an ACL over a public URL when you can. Keep the brain token, the pre-auth key and the Tailscale API token out of the repository; they live only in `config.json` (0600) on each machine.
