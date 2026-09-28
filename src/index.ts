// maw rustfs — read-only view of every RustFS server you run.
//   targets                 configured targets (names and endpoints, never keys)
//   status [NAME]           S3 health + latency, console, mode, buckets, objects, used — all targets at once
//   buckets NAME            bucket names on one target
//   repl NAME [BUCKET]      replication per bucket: rules, target online/offline, downtime, queue, failures
//   who [PORT]              which agent session set up a RustFS on THIS machine, from where, when (needs relic)
//   --json                  machine-readable output
//
// Nothing here writes to a server: only GET/HEAD, and keys reach curl on stdin.

import { configPath, loadTargets, pick } from "./config";
import { bucketNames, repl, status, table } from "./report";
import { who } from "./who";

type InvokeContext = { source: "cli" | string; args: string[] };
type PluginResult = { ok: boolean; output?: string; error?: string };

const HELP = `maw rustfs — read-only RustFS fleet view

  targets                  configured targets (names and endpoints, never keys)
  status [NAME]            S3 health + latency, console, mode, buckets, objects, used
  buckets NAME             bucket names on one target
  repl NAME [BUCKET]       replication: rules · target ONLINE/offline · downtime · queue · failures
  who [PORT]               which agent session set up the RustFS on this machine, from where, when
  --json                   machine-readable output

Replication, as measured on RustFS 1.0.1-preview.11: while a target is down, writes to the
source still succeed and objects are marked FAILED; they are retried automatically when the
target returns. The "failed total" counter is cumulative — use "queued now" and
"failed last min" to judge the present.

targets: ${configPath()}  (see targets.example.json; keys are { "pass": ... } or { "env": ... })`;

export async function handler(ctx: InvokeContext): Promise<PluginResult> {
  const args = ctx.source === "cli" ? (ctx.args ?? []) : [];
  const asJson = args.includes("--json");
  const [sub = "status", a1, a2] = args.filter((a) => a !== "--json");
  try {
    switch (sub) {
      case "help": case "-h": case "--help": return { ok: true, output: HELP };
      case "who": return { ok: true, output: await who(a1, asJson) };
    }
    const targets = loadTargets();
    switch (sub) {
      case "targets":
        return { ok: true, output: asJson ? JSON.stringify(targets.map(({ name, endpoint, console }) => ({ name, endpoint, console })), null, 2)
          : table([["TARGET", "ENDPOINT", "CONSOLE", "KEYS"], ...targets.map((t) => [t.name, t.endpoint, t.console ?? "-", t.accessKey ? "configured" : "none"])]) };
      case "status": return { ok: true, output: await status(a1 ? [pick(targets, a1)] : targets, asJson) };
      case "buckets": {
        const names = await bucketNames(pick(targets, a1));
        return { ok: true, output: asJson ? JSON.stringify(names) : names.join("\n") || "(no buckets)" };
      }
      case "repl": return { ok: true, output: await repl(pick(targets, a1), a2, asJson) };
      default: throw Error(`unknown subcommand ${sub} — run maw rustfs help`);
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export default handler;

if (import.meta.main) {
  const result = await handler({ source: "cli", args: process.argv.slice(2) });
  if (result.output) console.log(result.output);
  if (result.error) console.error(result.error);
  process.exit(result.ok ? 0 : 1);
}
