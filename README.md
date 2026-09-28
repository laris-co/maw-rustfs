# maw-rustfs

[ภาษาไทย → README.th.md](README.th.md)

A read-only [maw](https://github.com/Soul-Brews-Studio/maw-js) plugin for people who run
more than one [RustFS](https://github.com/rustfs/rustfs) server and replicate between them.
It answers three questions from the terminal:

- **Is every server up?** — `maw rustfs status`
- **Is replication actually working right now?** — `maw rustfs repl NAME [BUCKET]`
- **Who set up the RustFS on this machine, from where, and when?** — `maw rustfs who [PORT]`

> **Rule 6.** Written by Nexus (an AI agent, Claude) for Nat Weerawan / laris-co. Every
> behaviour claim in the "What replication does" section was measured by running the
> commands listed there, on one Mac, on 2026-09-28. Nothing is taken from RustFS marketing.

## Install

```bash
git clone https://github.com/laris-co/maw-rustfs
ln -s "$PWD/maw-rustfs" ~/.maw/plugins/rustfs      # maw picks up plugin.json
mkdir -p ~/.config/maw-rustfs
cp maw-rustfs/targets.example.json ~/.config/maw-rustfs/targets.json   # then edit
maw rustfs status
```

Needs `bun` and `curl`. `who` also needs [`relic`](https://github.com/Soul-Brews-Studio/agent-relic-v2.1);
keys can come from [`pass`](https://www.passwordstore.org/).

Without maw: `bun src/index.ts status`.

## Targets

`~/.config/maw-rustfs/targets.json` (or `$MAW_RUSTFS_TARGETS`) — outside any repo:

```json
{
  "m5":    { "endpoint": "http://127.0.0.1:19000",
             "console":  "http://127.0.0.1:19001/rustfs/console/",
             "accessKey": { "pass": "m5/rustfs-access-key" },
             "secretKey": { "pass": "m5/rustfs-secret-key" } },
  "black": { "endpoint": "http://black.local:9000",
             "accessKey": { "env": "BLACK_AK" }, "secretKey": { "env": "BLACK_SK" } }
}
```

Keys are **references** (`pass` entry or env var). A literal key in the file is refused.
Keys reach `curl` on stdin (`-K -`), so they never appear in argv or `ps`.

## Commands

```
maw rustfs targets                 configured targets (never keys)
maw rustfs status [NAME]           S3 health + latency, console, mode, buckets, objects, used
maw rustfs buckets NAME            bucket names
maw rustfs repl NAME [BUCKET]      rules · target ONLINE/offline · downtime · queue · failures · verdict
maw rustfs who [PORT]              which agent session set up the RustFS listening here
--json                             machine-readable output
```

Only `GET`/`HEAD` are sent. The plugin cannot change a server.

### `repl` output

```
== m5/photos
RULE           ON   PREFIX  DELETES  MARKERS  EXISTING
rule-1:photos  yes  *       yes      yes      yes

TARGET                  BUCKET  ONLINE  OFFLINE×  DOWNTIME  LAST ONLINE                  LATENCY
http://127.0.0.1:29700  photos  NO      1         4.1 s     2026-09-28T01:47:07.178065Z  813 ms

queued now 0 · failed last min 3 / hour 3 / total 3 · replicated 1 (8 B)  (counters reset when the server restarts)
→ TARGET DOWN (http://127.0.0.1:29700, last online 2026-09-28T01:47:07.178065Z). Writes here still succeed; new objects are marked FAILED and retried when the target returns.
```

The verdict is the line to read. Its order: every rule disabled → no remote target
registered → target down → objects queued now → failures in the last minute → in sync.
**The `failed total` counter is cumulative**: it still says 20 after all 20 were
retried successfully, so the verdict ignores it. Counters live in memory and reset when
the server restarts.

Data sources: `GET /BUCKET?replication`, `GET /rustfs/admin/v3/list-remote-targets?bucket=`,
`GET /rustfs/admin/v3/replicationmetrics?bucket=`, `GET /rustfs/admin/v3/info`, `GET /health`.

### `who` output

```
pid 2200 · up 19:13 · 127.0.0.1:19000
  /opt/homebrew/bin/rustfs server --address 127.0.0.1:19000 ... /Users/beta/rustfs-data
  launchd: com.rustfs.server · data: /Users/beta/rustfs-data
  anchors searched: com.rustfs.server | rustfs-data | brew install rustfs

FIRST (local)     LAST              SESSION   CWD               HITS  FIRST HIT
2026-09-26 07:33  2026-09-26 07:38  8f6d2f40  laris-co/homelab  15    [tool_use Bash] brew install rustfs/homebrew-tap/rustfs ...
...
→ set up by session 8f6d2f40-… in /opt/Code/github.com/laris-co/homelab, first seen 2026-09-26 07:33
```

How: `lsof` finds the listener → `ps` gives the command line and data dir → `launchctl list`
gives the launchd label → `relic search` finds every Claude Code / Codex session that
mentioned the label or the data dir's name → the transcripts give the timestamps. The
creator is the earliest session that touched the server's **own** anchors. A session that
only researched "brew install rustfs" is not counted as the creator.

Full paths are deliberately not searched. relic's full-text index splits them into
common words, and one path-shaped query crashed relic (`RangeError: Maximum call stack
size exceeded`).

## What replication does — measured

Setup: two single-node RustFS `1.0.1-preview.11` servers (Homebrew, macOS arm64) on one
Mac. "m5" (source) on `127.0.0.1:29600` and "black" (replica) on `127.0.0.1:29700`. The
bucket is versioned on both sides. The rule was created with `rc bucket replication add
--replicate delete,delete-marker,existing-objects --healthcheck-seconds 5`.

| Scenario | What happened |
|---|---|
| Normal write | reached the replica in < 3 s, source object `COMPLETED` |
| **Replica killed (`kill -9`)**, 20 × 300 KB PUTs to source | all 20 PUTs **succeeded** (~0.2 s each); objects marked `FAILED`; reads from the source fine |
| Delete on source while replica down | accepted on the source |
| **Replica restarted** | 0/20 at 15 s, **20/20 by 30 s**, with no operator action; the delete marker arrived too; 20/20 byte-identical |
| New object written **only on the replica** (one-way rule) | not copied to the source, not listed there. But `GET` on the source **returned it (200)**, proxied from the replica. With the replica down, the same GET returned **404**. |
| Replica edits a replicated object | source unaffected; the replica diverges until the source writes that key again |
| Source overwrites that key | the replica now serves the source's version; the replica's own edit remains as an **older version** |
| Delete on the replica only | the source still has the object; the replica shows a delete marker |
| **Two-way** (a second rule replica → source) | new objects on either side appeared on both within 5 s; each side marks the other's copy `REPLICA`; no replication loop (1 version) |
| **Conflict**: both sides write the same key while disconnected (source first, replica 5 s later) | after reconnect, both served the **later write**. Both versions kept on both sides; the earlier one is non-latest |

### Accidental delete on the source — does the replica survive?

Two fresh buckets with 5 × 100 KB files each, replicated one-way. `vault-del` has the rule
`--replicate delete,delete-marker,existing-objects`. `vault-keep` has `--replicate existing-objects`.

| Accident on the source | Rule replicates deletes (`vault-del`) | Rule does not (`vault-keep`) |
|---|---|---|
| Normal delete (creates a delete marker) | replica hides it too (404); the data is still there. Removing the marker on the replica brought it back byte-identical | replica still serves it (200) |
| **Permanent delete** (`DELETE ?versionId=`) | **gone from the replica too**: 0 versions left on either side | replica still has it |
| **Bucket force-delete** (`rc bucket remove --force`) | **replica emptied too**: 0 versions, 0 markers on both sides. The command itself ended with `Concurrent writes left objects…` and the bucket stayed, but its contents were already purged on both sides | source bucket gone; **replica kept all 5 versions** |
| Source disk lost (data dir wiped, server restarted empty) | – | replica untouched; `rc mirror black/vault-keep m5/vault-keep` restored it in 0.99 s, 5/5 byte-identical, including 2 files deleted on the source earlier |

**Replication with delete replication is a mirror, not a backup.** An accident on the source
reaches the replica within seconds. A normal delete can be undone through versioning; a
permanent delete or a bucket force-delete cannot. For a backup target, leave `delete` and
`delete-marker` off. `rc mirror` restores only the latest version of each object.

Setup gotchas found on the way:
- A loopback target (`127.0.0.1`) is refused with `outbound URL host '127.0.0.1' is not allowed: loopback address`
  unless the source runs with `RUSTFS_REPLICATION_ALLOW_LOOPBACK_TARGET=true`. RustFS's docs say private/LAN addresses are
  allowed by default. `RUSTFS_OUTBOUND_ALLOW_ORIGINS` does **not** apply to replication targets.
- Versioning must be enabled on both buckets.

Not measured yet: outages of hours with many objects; restarting the source while the
replica is down (RustFS's code says failed items persist in its "MRF" queue, and its
scanner also repairs replication); clock skew between machines. Last-writer-wins uses each
server's own clock, so keep NTP on.

## Tests

```bash
bun test
```

The fixtures are real RustFS responses.

## License

MIT
