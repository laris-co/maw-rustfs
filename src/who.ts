// maw rustfs who [PORT] — which agent session set up a RustFS running on THIS machine,
// from which repo, and when. Live anchors first (lsof → pid → launchd label → data dir),
// then relic finds every Claude Code / Codex session that mentioned those anchors, and
// the transcripts themselves give the timestamps. Earliest session = the one that set it up.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const PORT_RE = /^[0-9]{1,5}$/;
const GENERIC = new Set(["data", "rustfs", "storage", "volume", "volumes", "disk", "disk1"]);

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  if (!Bun.which(cmd[0])) return { code: 127, out: "" };
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } catch {
    return { code: 127, out: "" };
  }
}

export type Proc = { pid: number; binds: string[]; etime: string; command: string; label: string | null; dataDir: string | null };

export async function findProcs(port?: string): Promise<Proc[]> {
  if (port && !PORT_RE.test(port)) throw Error(`not a port: ${port}`);
  const q = port ? ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"] : ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-c", "rustfs"];
  const { out } = await run(q);
  const binds = new Map<number, string[]>();
  for (const l of out.split("\n").slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 9) continue;
    if (!port && f[0] !== "rustfs") continue;
    const pid = Number(f[1]);
    binds.set(pid, [...(binds.get(pid) ?? []), f[8]]);
  }
  const launchd = (await run(["launchctl", "list"])).out.split("\n").map((l) => l.split("\t"));
  const procs: Proc[] = [];
  for (const [pid, b] of binds) {
    const ps = (await run(["ps", "-o", "etime=,command=", "-p", String(pid)])).out.trim();
    const m = ps.match(/^(\S+)\s+(.*)$/);
    const command = m?.[2] ?? "";
    const args = command.split(/\s+/);
    const dataDir = args.slice(1).filter((a, i, all) => !a.startsWith("-") && !(all[i - 1] ?? "").startsWith("--") && a !== "server").at(-1) ?? null;
    const label = launchd.find((r) => r[0] === String(pid))?.[2] ?? null;
    procs.push({ pid, binds: [...new Set(b)], etime: m?.[1] ?? "?", command, label, dataDir });
  }
  return procs;
}

export type Hit = { file: string; seq: number; text: string };
export type Session = { id: string; file: string; cwd: string; first: string; last: string; hits: number; anchors: string[]; sample: string };

export function parsePlain(out: string): Hit[] {
  return out.split("\n").filter(Boolean).map((l) => {
    const [file, seq, , ...rest] = l.split("\t");
    return { file, seq: Number(seq), text: rest.join("\t") };
  }).filter((h) => h.file && Number.isFinite(h.seq));
}

// Timestamp + cwd for specific line numbers of one JSONL transcript.
export function stamp(file: string, seqs: number[]): Map<number, { ts: string; cwd: string }> {
  const want = new Set(seqs), out = new Map<number, { ts: string; cwd: string }>();
  if (!file.endsWith(".jsonl") || !existsSync(file)) return out;
  const lines = readFileSync(file, "utf8").split("\n");
  for (const s of want) {
    try {
      const d = JSON.parse(lines[s] ?? "");
      out.set(s, { ts: d.timestamp ?? d.payload?.timestamp ?? "", cwd: d.cwd ?? d.payload?.cwd ?? "" });
    } catch { /* not a JSON line */ }
  }
  return out;
}

export function sessions(byAnchor: Map<string, Hit[]>): Session[] {
  const acc = new Map<string, Session>();
  for (const [anchor, hits] of byAnchor) {
    const byFile = new Map<string, Hit[]>();
    for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
    for (const [file, hs] of byFile) {
      const st = stamp(file, hs.map((h) => h.seq));
      const times = hs.map((h) => ({ h, ...(st.get(h.seq) ?? { ts: "", cwd: "" }) })).filter((x) => x.ts).sort((a, b) => a.ts.localeCompare(b.ts));
      if (!times.length) continue;
      const s = acc.get(file) ?? { id: basename(file).replace(/\.jsonl$/, "").replace(/^rollout-[0-9T-]+-/, ""), file, cwd: times[0].cwd,
        first: times[0].ts, last: times.at(-1)!.ts, hits: 0, anchors: [], sample: times[0].h.text.slice(0, 140) };
      if (times[0].ts < s.first) { s.first = times[0].ts; s.sample = times[0].h.text.slice(0, 140); }
      if (times.at(-1)!.ts > s.last) s.last = times.at(-1)!.ts;
      s.hits += hs.length;
      if (!s.anchors.includes(anchor)) s.anchors.push(anchor);
      acc.set(file, s);
    }
  }
  return [...acc.values()].sort((a, b) => a.first.localeCompare(b.first));
}

const local = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
};

export async function who(port: string | undefined, asJson: boolean): Promise<string> {
  const procs = await findProcs(port);
  if (!procs.length) throw Error(port ? `nothing listening on TCP ${port}` : "no rustfs process listening on this machine");
  const blocks: string[] = [];
  const all: any[] = [];
  for (const p of procs) {
    const home = homedir();
    // Distinctive literals only. A full path is a bad query: relic's FTS splits it into
    // common terms ("Users", "data") and a path-shaped query crashed relic here
    // (RangeError: Maximum call stack size exceeded). The data dir's own name is enough.
    const dirName = p.dataDir ? basename(p.dataDir) : null;
    const anchors = [p.label, dirName && !GENERIC.has(dirName) ? dirName : null, "brew install rustfs"]
      .filter((a): a is string => !!a && a.length >= 6);
    const byAnchor = new Map<string, Hit[]>();
    for (const a of [...new Set(anchors)]) {
      const r = await run(["relic", "search", a, "--all-tiers", "--limit", "2000", "--plain"]);
      if (r.code === 127) throw Error("relic is not on PATH — `who` needs it (github.com/Soul-Brews-Studio/agent-relic-v2.1)");
      if (r.code !== 0 && !r.out) throw Error(`relic search ${JSON.stringify(a)} failed (exit ${r.code})`);
      // BM25 matches ANY term; keep only lines that contain the literal anchor.
      byAnchor.set(a, parsePlain(r.out).filter((h) => h.text.includes(a)));
    }
    const ss = sessions(byAnchor);
    all.push({ proc: p, anchors, sessions: ss });
    const head = [`pid ${p.pid} · up ${p.etime} · ${p.binds.join(", ")}`, `  ${p.command}`,
      `  launchd: ${p.label ?? "(not a launchd job)"} · data: ${p.dataDir ?? "?"}`, `  anchors searched: ${anchors.join(" | ")}`];
    const rows = [["FIRST (local)", "LAST", "SESSION", "CWD", "HITS", "FIRST HIT"],
      ...ss.map((s) => [local(s.first), local(s.last), s.id.slice(0, 8), s.cwd.replace(home, "~").replace(/^.*\/github\.com\//, ""), String(s.hits), s.sample.replace(/\s+/g, " ")])];
    // The creator touched THIS server's own anchors (its launchd label or data dir).
    // "brew install rustfs" alone also matches research that never installed anything.
    const own = new Set([p.label, dirName].filter(Boolean) as string[]);
    const creator = ss.find((s) => s.anchors.some((a) => own.has(a))) ?? ss[0];
    blocks.push([...head, "", ss.length ? rowsOut(rows) : "  no session mentions these anchors (relic index stale? run `relic pending`)",
      creator ? `\n→ set up by session ${creator.id} in ${creator.cwd.replace(home, "~")}, first seen ${local(creator.first)} (${creator.first} UTC).` +
        `\n  what it did: relic recap ${creator.id.slice(0, 8)}    full timeline: /relic-provenance` : ""].join("\n"));
  }
  return asJson ? JSON.stringify(all, null, 2) : blocks.join("\n\n");
}

function rowsOut(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}
