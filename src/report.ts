// status / buckets / repl. Pure summarizers are exported for tests; the async
// functions only fetch and hand off to them.

import type { Target } from "./config";
import { BUCKET_RE, credentials } from "./config";
import { curl, json, signed, tags, xml } from "./s3";

export function table(rows: string[][]): string {
  if (rows.length <= 1) return "(none)";
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}

export const bytes = (n: number) => {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};
export const dur = (ns: number) => {
  const s = ns / 1e9;
  return s < 1 ? `${Math.round(s * 1000)} ms` : s < 120 ? `${s.toFixed(1)} s` : s < 7200 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`;
};

// ---------------------------------------------------------------- status
export async function statusOne(t: Target) {
  const health = await curl(`${t.endpoint}/health`, { timeout: 5 });
  const con = t.console ? await curl(t.console, { timeout: 5 }) : null;
  let info: any = null, infoErr = "";
  if (health.code === 200 && (await credentials(t).catch(() => null))) {
    try { info = (await json(t, "/rustfs/admin/v3/info")).info; } catch (e: any) { infoErr = e.message; }
  }
  return { t, health, con, info, infoErr };
}

export async function status(targets: Target[], asJson: boolean): Promise<string> {
  const rs = await Promise.all(targets.map(statusOne));
  if (asJson) return JSON.stringify(rs.map((r) => ({ name: r.t.name, endpoint: r.t.endpoint, health: r.health.code, ms: r.health.ms,
    console: r.con?.code ?? null, info: r.info ? { mode: r.info.mode, buckets: r.info.buckets?.count, objects: r.info.objects?.count, bytes: r.info.usage?.size } : null })), null, 2);
  const rows = [["TARGET", "ENDPOINT", "S3", "CONSOLE", "MODE", "BUCKETS", "OBJECTS", "USED"],
    ...rs.map((r) => [r.t.name, r.t.endpoint,
      r.health.code ? `${r.health.code} ${r.health.ms}ms` : "DOWN",
      r.con ? (r.con.code ? String(r.con.code) : "DOWN") : "-",
      r.info?.mode ?? (r.infoErr ? "no-auth" : "-"),
      String(r.info?.buckets?.count ?? "-"), String(r.info?.objects?.count ?? "-"),
      r.info?.usage?.size !== undefined ? bytes(r.info.usage.size) : "-"])];
  const down = rs.filter((r) => r.health.code !== 200).map((r) => r.t.name);
  return `${table(rows)}\n\n${rs.length} targets, ${down.length ? `DOWN: ${down.join(", ")}` : "all up"}`;
}

// ---------------------------------------------------------------- buckets
export async function bucketNames(t: Target): Promise<string[]> {
  return tags(await xml(t, "/"), "Name");
}

// ---------------------------------------------------------------- replication
export type Rule = { id: string; enabled: boolean; prefix: string; deletes: boolean; deleteMarkers: boolean; existing: boolean; arn: string };

export function parseRules(body: string): Rule[] {
  return tags(body, "Rule").map((r) => {
    const on = (tag: string) => /Enabled/.test(tags(r, tag)[0] ?? "");
    return {
      id: tags(r, "ID")[0] ?? "",
      enabled: (tags(r, "Status").at(-1) ?? "") === "Enabled",
      prefix: tags(r, "Prefix")[0] ?? "",
      deletes: on("DeleteReplication"),
      deleteMarkers: on("DeleteMarkerReplication"),
      existing: on("ExistingObjectReplication"),
      arn: tags(tags(r, "Destination")[0] ?? "", "Bucket")[0] ?? "",
    };
  });
}

export type TargetState = {
  arn: string; endpoint: string; bucket: string; online: boolean; offlineCount: number;
  downtimeNs: number; lastOnline: string | null; latencyNs: number; sync: boolean;
};

export function parseRemoteTargets(list: any[]): TargetState[] {
  return (list ?? []).map((x) => ({
    arn: x.arn, endpoint: `${x.secure ? "https" : "http"}://${x.endpoint}`, bucket: x.targetbucket,
    online: !!x.isOnline, offlineCount: x.offlineCount ?? 0, downtimeNs: x.totalDowntime ?? 0,
    lastOnline: x.lastOnline ?? null, latencyNs: x.latency?.curr ?? 0, sync: !!x.replicationSync,
  }));
}

export type Metrics = { queuedNow: number; queuedBytes: number; failedMin: number; failedHour: number; failedTotal: number; replicated: number; replicatedBytes: number };

export function parseMetrics(m: any): Metrics {
  return {
    queuedNow: m?.queued?.curr?.count ?? 0, queuedBytes: m?.queued?.curr?.bytes ?? 0,
    failedMin: m?.failed?.lastMinute?.count ?? 0, failedHour: m?.failed?.lastHour?.count ?? 0,
    failedTotal: m?.failed?.totals?.count ?? 0,
    replicated: m?.replicationCount ?? 0, replicatedBytes: m?.completedReplicationSize ?? 0,
  };
}

// One line a human can act on. The totals counter is CUMULATIVE — it keeps
// counting objects that failed once and were later replicated after a retry —
// so only "queued now" and "failed in the last minute" say something is wrong NOW.
export function verdict(ts: TargetState[], m: Metrics, rules: Rule[] = []): string {
  if (rules.length && !rules.some((r) => r.enabled)) return "NOT REPLICATING: every rule is disabled.";
  if (rules.length && !ts.length) return "NOT REPLICATING: rules exist but no remote target is registered.";
  const down = ts.filter((x) => !x.online);
  if (down.length)
    return `TARGET DOWN (${down.map((d) => d.endpoint).join(", ")}, last online ${down[0].lastOnline ?? "never"}). ` +
      `Writes here still succeed; new objects are marked FAILED and retried when the target returns.`;
  if (m.queuedNow > 0) return `catching up: ${m.queuedNow} objects (${bytes(m.queuedBytes)}) queued now.`;
  if (m.failedMin > 0) return `failing: ${m.failedMin} failures in the last minute with the target online — check keys, versioning, disk on the target.`;
  return m.failedTotal > 0
    ? `in sync now. ${m.failedTotal} historic failures (cumulative counter; ${m.failedHour} in the last hour) — they were retried.`
    : "in sync.";
}

export async function replOne(t: Target, bucket: string) {
  const cfg = await signed(t, `/${bucket}?replication`);
  if (cfg.code === 404) return { bucket, rules: [] as Rule[], targets: [] as TargetState[], metrics: null as Metrics | null };
  if (cfg.code !== 200) throw Error(`${t.name} GET /${bucket}?replication -> ${cfg.code || "no answer"}`);
  const [rt, mx] = await Promise.all([
    json(t, `/rustfs/admin/v3/list-remote-targets?bucket=${bucket}`),
    json(t, `/rustfs/admin/v3/replicationmetrics?bucket=${bucket}`),
  ]);
  return { bucket, rules: parseRules(cfg.body), targets: parseRemoteTargets(rt), metrics: parseMetrics(mx) };
}

export async function repl(t: Target, bucket: string | undefined, asJson: boolean): Promise<string> {
  if (bucket && !BUCKET_RE.test(bucket)) throw Error(`not a bucket name: ${bucket}`);
  const names = bucket ? [bucket] : await bucketNames(t);
  const rs = await Promise.all(names.map((b) => replOne(t, b)));
  if (asJson) return JSON.stringify(rs, null, 2);
  const withRules = rs.filter((r) => r.rules.length);
  const blocks = withRules.map((r) => {
    const rules = table([["RULE", "ON", "PREFIX", "DELETES", "MARKERS", "EXISTING"],
      ...r.rules.map((x) => [x.id, x.enabled ? "yes" : "NO", x.prefix || "*", yn(x.deletes), yn(x.deleteMarkers), yn(x.existing)])]);
    const tgt = table([["TARGET", "BUCKET", "ONLINE", "OFFLINE×", "DOWNTIME", "LAST ONLINE", "LATENCY"],
      ...r.targets.map((x) => [x.endpoint, x.bucket, x.online ? "yes" : "NO", String(x.offlineCount), dur(x.downtimeNs), x.lastOnline ?? "-", dur(x.latencyNs)])]);
    const m = r.metrics!;
    const q = `queued now ${m.queuedNow} · failed last min ${m.failedMin} / hour ${m.failedHour} / total ${m.failedTotal} · replicated ${m.replicated} (${bytes(m.replicatedBytes)})`;
    return `== ${t.name}/${r.bucket}\n${rules}\n\n${tgt}\n\n${q}  (counters reset when the server restarts)\n→ ${verdict(r.targets, m, r.rules)}`;
  });
  const none = rs.filter((r) => !r.rules.length).map((r) => r.bucket);
  return [...blocks, none.length ? `no replication: ${none.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

const yn = (b: boolean) => (b ? "yes" : "no");
