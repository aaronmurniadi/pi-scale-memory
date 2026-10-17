# pi-scale-memory

A pi extension that gives many pi agents one shared, remote memory (a "brain") over a private tailnet. Agents keep a local mirror of that memory, so they can still read and search it while the brain is unreachable.

Each agent runs its **own userspace `tailscaled`** (`--tun=userspace-networking`): no network interface, no route changes, only a local SOCKS5 proxy that this extension uses. It joins your tailnet as `tag:agent`, finds the machine tagged `tag:brain`, and reads/writes memory there.

Memory model and tools follow [pi-memory](https://github.com/jayzeng/pi-memory): `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, tools `memory_write`, `memory_read`, `scratchpad`, `memory_search`, `memory_forget`, plus a memory snapshot injected into the system prompt. Differences: storage is remote and shared, and search is built-in BM25 (no qmd).

## Requirements

- Tailscale installed on every **agent** machine (`tailscale` and `tailscaled` in `PATH`).
- A tailnet: Tailscale, or self-hosted Headscale (which `/setup-headscale` can install for you).
- Node >= 22.

## Roles

`/self-tag` sets what this pi agent is:

| Role | What it does | Memory path |
|---|---|---|
| `agent` | Starts a userspace tailscaled, joins as `tag:agent`, discovers the brain by tag, and mirrors the memory locally | live over the tailnet SOCKS5 proxy, cached copy when offline |
| `brain` | Hosts the memory and can host Headscale | local brain server on `127.0.0.1` |

The brain role assumes the machine is joined to the tailnet as `tag:brain` with the **system** tailscale; its own pi process talks to a brain server on loopback, so it never needs a second tailscaled.

## Commands

| Command | Applies to | What it does |
|---|---|---|
| `/self-tag [brain\|agent]` | both | Sets this agent's role, saves it, and reconnects |
| `/join-tailnet` | agent | Asks Tailscale or self-hosted, asks for the Headscale URL when self-hosted, then asks for the tagged pre-auth key, saves both, and joins |
| `/setup-headscale` | brain only | Installs Headscale, writes its config, starts it, creates the user, writes the ACL, mints a `tag:brain` key, and offers to join this machine |
| `/generate-preauth` | brain only | Rewrites the ACL from the live user list and mints a reusable, ephemeral `tag:agent` key for other machines |
| `/brain status\|sync\|reconnect\|reset` | both | Shows role, brain, health, queue and cache age; refreshes the offline mirror on demand; rejoins; or deletes the saved config |

### Quick start

On the machine that will hold the memory:

```
/self-tag brain
/setup-headscale      # installs and configures Headscale, joins as tag:brain
/generate-preauth     # copy the key it prints
```

On every other machine:

```
/join-tailnet         # self-hosted → the Headscale URL from step 2, then the key
```

`/setup-headscale` and `/generate-preauth` refuse to run unless `/self-tag brain` was set first. Both need the terminal UI.

## What `/setup-headscale` does

1. Detects Headscale. If it is missing, it installs it from the official GitHub release: the `.deb` via `apt` on Debian/Ubuntu, otherwise the release binary (`/usr/local/bin` with sudo, else `~/.local/bin`). Every generated command is shown and confirmed before it runs, and downloads are checked against the published `checksums.txt`. There is no Homebrew formula for headscale, so macOS uses the release binary too.
2. Picks a layout: `/etc/headscale` (Debian package, needs passwordless sudo) or `~/.config/headscale`.
3. Asks for the URL agents will use, generating and validating the server key, and writing `config.yaml`. An existing config is backed up to `config.yaml.bak-<timestamp>` first.
4. Validates the config with `headscale configtest`, then starts the service (`systemctl enable --now headscale`, or a background `headscale serve` with a log in the config dir).
5. Creates the Headscale user that will own the agent keys.
6. Writes the ACL (`acl.hujson`) from the live user list and applies it.
7. Mints a one-off `tag:brain` key and offers to run `tailscale up --login-server <url> --auth-key <key>`.

`/generate-preauth` re-runs step 6, so a user added later becomes an allowed agent owner as soon as a new key is generated.

**Caveats.** The generated config uses the newer keys (`prefixes.v4/v6`, `policy.mode`), so Headscale older than 0.26 is rejected instead of being misconfigured. On a non-Debian host the service is a background process started by this extension; it does not survive a reboot unless you install a unit for it. Plain `http://` on a non-private address is flagged, because pre-auth keys cross the network in cleartext.

## Offline caching

Agents mirror the brain so a dead network, a sleeping brain machine, or a laptop on a plane does not cost them their memory. The brain stays authoritative: the mirror is only consulted when a request to it fails.

- **What is mirrored:** every memory file — `MEMORY.md`, `SCRATCHPAD.md`, and all of `daily/` — under `~/.pi/agent/pi-scale-memory/cache/`. Deletions propagate: if a note is forgotten on the brain, the next sync removes it locally too.
- **When it syncs:** right after connecting, then every 60s while connected (`PI_SCALE_MEMORY_CACHE_SYNC_MS`). `/brain sync` forces one; `/brain status` shows how many files were mirrored and when.
- **Offline reads:** `memory_read`, `memory_search`, and the session-start memory block all fall back to the mirror. Results say so, e.g. `(brain unreachable — showing the cached copy taken 2026-10-18 09:12; it may be stale)`.
- **Offline writes:** queued in memory and sent when the brain returns; they appear in the mirror after the next successful sync. A write that is still queued when pi exits is lost.
- **Same ranking offline:** the mirror reuses the brain's own context builder and BM25 search (`brain/memory.mjs`), so an offline answer is ranked and trimmed exactly like an online one.
- **Disable it:** `/self-tag brain` never caches, and `PI_SCALE_MEMORY_CACHE=0` (or `"cache": false` in `config.json`) turns it off for agents.

Nothing outside the memory layout is ever written into the cache: a snapshot entry that is not `MEMORY.md`, `SCRATCHPAD.md`, or `daily/YYYY-MM-DD.md` is ignored.

## Manual tailnet setup

Use this when you already run Tailscale or Headscale and only need the ACL and keys.

- ACL: allow `tag:agent` to reach `tag:brain` on TCP 8787.
- Agents need a **reusable** pre-auth key tagged `tag:agent` (ephemeral recommended; agent nodes are in-memory nodes, one per pi process).
- The brain machine joins as `tag:brain`.

### Run the brain server by hand

```bash
BRAIN_DIR=~/.pi-scale-brain BRAIN_PORT=8787 node brain/server.mjs
# optional shared secret: BRAIN_TOKEN=... (agents then need PI_SCALE_MEMORY_TOKEN or brainToken in the config)
```

### Sample Headscale ACL

Headscale policy file (huJSON), e.g. `/etc/headscale/acl.hujson`. `/setup-headscale` writes exactly this shape:

```jsonc
{
  // Every Headscale user allowed to run agents. Add or remove names here and
  // the ACL below keeps working — nothing is tied to a single user.
  // Current Headscale versions want the trailing "@" on usernames.
  "groups": {
    "group:agents": ["alice@", "bob@"]
  },

  // Who may apply the tags (pre-auth keys and --advertise-tags).
  "tagOwners": {
    "tag:agent": ["group:agents"],
    "tag:brain": ["group:agents"]
  },

  "acls": [
    // Agents may only reach the brain's memory API, nothing else.
    {
      "action": "accept",
      "src": ["tag:agent"],
      "dst": ["tag:brain:8787"]
    }
    // Agents cannot reach each other or other nodes. Replies to the
    // connections above are allowed automatically (stateful).
  ]
}
```

Two limits worth knowing when you edit this:

- `tagOwners` accepts only users (`name@`), groups (`group:x`), and tags (`tag:x`). There is no wildcard and no autogroup there: `"*"` and `"autogroup:member"` are rejected as invalid owners. A group is the way to say "any of my users".
- `*` and autogroups *are* valid in ACL `src`/`dst`. To let every device reach the brain instead of only `tag:agent`, use `"src": ["*"]` or `"src": ["autogroup:member"]` (the latter means untagged personal devices only).

### Apply the policy

Headscale has no `policy reload`. What to run depends on `policy.mode` in `config.yaml`:

```bash
# mode: file — write the file, then reload the service
sudo systemctl reload headscale      # or: sudo pkill -HUP -x headscale

# mode: database — push the file into the database
headscale policy set --file /etc/headscale/acl.hujson

# either way, validate first
headscale policy check --file /etc/headscale/acl.hujson
```

The extension picks the right one automatically.

## Configuration

Saved per machine at `~/.pi/agent/pi-scale-memory/config.json` (mode 0600): role, login server, pre-auth key, brain port, optional brain token, and the recorded Headscale layout. Environment overrides:

| Variable | Meaning |
|---|---|
| `PI_SCALE_MEMORY_LOGIN_SERVER` | Headscale/Tailscale login server URL |
| `PI_SCALE_MEMORY_AUTHKEY` | pre-auth key |
| `PI_SCALE_MEMORY_PORT` | brain API port (default 8787) |
| `PI_SCALE_MEMORY_TOKEN` | bearer token, must match `BRAIN_TOKEN` |
| `PI_SCALE_MEMORY_HEADSCALE_DIR` | force a user-layout Headscale config dir |
| `PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS` | turns between automatic daily-log summaries (0 disables) |
| `PI_SCALE_MEMORY_CACHE` | set to `0` to disable the agent-side offline mirror |
| `PI_SCALE_MEMORY_CACHE_SYNC_MS` | mirror refresh interval while connected (default 60000) |

## Behavior

- The memory snapshot is fetched from the brain at session start and injected into the system prompt on every turn. When the brain is unreachable, the cached copy is injected instead.
- Appends go out immediately; if the brain is unreachable they are queued in memory and flushed every 30s. Queued writes are lost if pi exits first.
- An LLM summary of the new conversation is stored in the daily log every 15 turns, before compaction, and on exit.
- Agents refresh their offline mirror on connect and every 60s thereafter.

## Development

```bash
npm install
npm test         # unit tests + a live brain-server round-trip over loopback
npm run build    # tsc --noEmit
```

`test/unit.ts` covers the generated Headscale config and ACL, the CLI output parsers, the client/server round-trip, the offline cache (mirroring, fallback reads and search, deletion propagation, and path sanitizing), and command registration. The tailnet paths — `tailscaled` startup, `tailscale up`, tag discovery, and the Headscale install flow — are not covered by tests; they need a real tailnet.

## Security

Anyone on the tailnet that the ACL allows can reach the brain API. Use ACLs and/or `BRAIN_TOKEN`. The pre-auth key is stored in plain text in the config file.
