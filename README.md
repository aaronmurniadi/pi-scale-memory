# pi-scale-memory

A pi extension that gives many pi agents one shared, remote memory (a "brain") over a private tailnet.

Each agent runs its **own userspace `tailscaled`** (`--tun=userspace-networking`): no network interface, no route changes, only a local SOCKS5 proxy that this extension uses. It joins your tailnet as `tag:agent`, finds the machine tagged `tag:brain`, and reads/writes memory there.

Memory model and tools follow [pi-memory](https://github.com/jayzeng/pi-memory): `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, tools `memory_write`, `memory_read`, `scratchpad`, `memory_search`, `memory_forget`, plus a memory snapshot injected into the system prompt. Differences: storage is remote and shared, and search is built-in BM25 (no qmd).

## Requirements

- Tailscale installed on every agent machine (`tailscale` and `tailscaled` in `PATH`).
- A tailnet: Tailscale, or self-hosted Headscale.
- Node >= 22.

## 1. Tailnet setup

- Tag owners/ACL: allow `tag:agent` to reach `tag:brain` on TCP 8787.
- Create a **reusable** pre-auth key tagged `tag:agent` for agents (ephemeral recommended; agent nodes are ephemeral in-memory nodes, one per pi process).
- Join the brain machine with tag `tag:brain` (`tailscale up --advertise-tags=tag:brain`, or a pre-auth key tagged `tag:brain`).

### Sample Headscale ACL

Headscale policy file (HuJSON), e.g. `/etc/headscale/acl.hujson` referenced by `policy.path` in the Headscale config. Replace `aaron@` with your Headscale user (recent versions use the `name@` form):

```jsonc
{
  // Who may apply the tags (pre-auth keys and --advertise-tags)
  "tagOwners": {
    "tag:agent": ["aaron@"],
    "tag:brain": ["aaron@"]
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

Create the keys and reload the policy:

```bash
# reusable + ephemeral key for agents
headscale preauthkeys create --user <user-id> --reusable --ephemeral --expiration 90d --tags tag:agent

# key for the brain machine (one-off, not ephemeral)
headscale preauthkeys create --user <user-id> --expiration 1h --tags tag:brain
tailscale up --login-server https://headscale.example.com --auth-key <brain key>

headscale policy reload   # or restart headscale, depending on version
```

Give agents the first key when the extension asks for it.

## 2. Run the brain (on the `tag:brain` machine)

```bash
BRAIN_DIR=~/.pi-scale-brain BRAIN_PORT=8787 node brain/server.mjs
# optional shared secret: BRAIN_TOKEN=... (agents need PI_SCALE_MEMORY_TOKEN or brainToken in config)
```

If the brain itself runs tailscale in userspace mode, expose the port with
`tailscale serve --tcp 8787 tcp://localhost:8787`.

## 3. Install the extension on agents

```bash
pi install /path/to/pi-scale-memory   # or: pi --extension ./index.ts
```

On first start it asks:

1. Tailscale or self-hosted (and the login server URL for Headscale).
2. The tagged pre-auth key.

Answers are saved to `~/.pi/agent/pi-scale-memory/config.json` (mode 0600). Env overrides: `PI_SCALE_MEMORY_LOGIN_SERVER`, `PI_SCALE_MEMORY_AUTHKEY`, `PI_SCALE_MEMORY_PORT`, `PI_SCALE_MEMORY_TOKEN`.

## Behavior

- Memory snapshot is fetched from the brain at session start and injected each turn.
- Appends are sent immediately; if the brain is unreachable they are queued and flushed every 30s.
- An LLM summary of new conversation is stored in the daily log every 15 turns (`PI_SCALE_MEMORY_SUMMARY_EVERY_TURNS`, 0 disables), before compaction, and on exit.
- `/brain` shows status; `/brain reconnect` rejoins; `/brain reset` deletes saved config.

## Security

Anyone on the tailnet allowed by ACL can reach the brain API. Use ACLs and/or `BRAIN_TOKEN`. The auth key is stored in plain text in the config file.
