// Targets live OUTSIDE the repo: ~/.config/maw-rustfs/targets.json (or $MAW_RUSTFS_TARGETS).
// Keys are references — { "pass": "entry" } or { "env": "VAR" } — never literal values,
// so the file can be shown, diffed and backed up without leaking anything.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export type Secret = { pass: string } | { env: string };
export type Target = {
  name: string;
  endpoint: string;
  console?: string;
  accessKey?: Secret;
  secretKey?: Secret;
  region?: string;
};

export const URL_RE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
export const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// S3 bucket naming rules, the subset that matters for a path segment.
export const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PASS_RE = /^[A-Za-z0-9_.\/-]{1,128}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function configPath(): string {
  return process.env.MAW_RUSTFS_TARGETS ?? join(homedir(), ".config", "maw-rustfs", "targets.json");
}

export function parseTargets(raw: unknown): Target[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("targets.json must be an object: { \"name\": { \"endpoint\": ... } }");
  const out: Target[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, any>)) {
    if (!NAME_RE.test(name)) throw Error(`target name ${JSON.stringify(name)} must match ${NAME_RE}`);
    if (!v || typeof v.endpoint !== "string" || !URL_RE.test(v.endpoint))
      throw Error(`${name}.endpoint must be http(s)://host[:port] with no path`);
    if (v.console !== undefined && (typeof v.console !== "string" || !/^https?:\/\/[^\s]+$/.test(v.console)))
      throw Error(`${name}.console must be an http(s) URL`);
    for (const k of ["accessKey", "secretKey"] as const) {
      const s = v[k];
      if (s === undefined) continue;
      const ok = !!s && typeof s === "object" &&
        ("pass" in s ? PASS_RE.test(s.pass) : "env" in s ? ENV_RE.test(s.env) : false);
      if (!ok)
        throw Error(`${name}.${k} must be { "pass": "entry" } or { "env": "VAR" } — never a literal key`);
    }
    out.push({ name, endpoint: v.endpoint, console: v.console, accessKey: v.accessKey, secretKey: v.secretKey, region: v.region ?? "us-east-1" });
  }
  return out;
}

export function loadTargets(): Target[] {
  const p = configPath();
  if (!existsSync(p)) throw Error(`no targets file at ${p} — copy targets.example.json there and edit it`);
  return parseTargets(JSON.parse(readFileSync(p, "utf8")));
}

export function pick(targets: Target[], name: string | undefined): Target {
  if (!name) throw Error(`name a target: ${targets.map((t) => t.name).join(", ")}`);
  const t = targets.find((x) => x.name === name);
  if (!t) throw Error(`no target ${name} — have: ${targets.map((x) => x.name).join(", ")}`);
  return t;
}

async function resolve(s: Secret): Promise<string> {
  if ("env" in s) {
    const v = process.env[s.env];
    if (!v) throw Error(`env ${s.env} is empty`);
    return v;
  }
  const p = Bun.spawn(["pass", "show", s.pass], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = [await new Response(p.stdout).text(), await p.exited];
  const line = out.split("\n")[0]?.trim();
  if (code !== 0 || !line) throw Error(`pass show ${s.pass} failed (exit ${code})`);
  return line;
}

export async function credentials(t: Target): Promise<{ ak: string; sk: string } | null> {
  if (!t.accessKey || !t.secretKey) return null;
  return { ak: await resolve(t.accessKey), sk: await resolve(t.secretKey) };
}
