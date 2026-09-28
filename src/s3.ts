// Signed requests through curl --aws-sigv4. curl runs from argv (no shell); the
// access/secret key go in on STDIN as a curl config file (`-K -`), so they never
// appear in argv, `ps`, or shell history. Only GET/HEAD are issued — this tool
// never changes a server.

import type { Target } from "./config";
import { credentials } from "./config";

export type Res = { code: number; ms: number; body: string };

export async function curl(url: string, opts: { user?: { ak: string; sk: string }; region?: string; head?: boolean; timeout?: number } = {}): Promise<Res> {
  const args = ["curl", "-s", "-m", String(opts.timeout ?? 8), "-o", "-", "-w", "\n%{http_code} %{time_total}"];
  if (opts.head) args.push("-I");
  let stdin: string | undefined;
  if (opts.user) {
    args.push("--aws-sigv4", `aws:amz:${opts.region ?? "us-east-1"}:s3`, "-K", "-");
    const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    stdin = `user = "${q(opts.user.ak)}:${q(opts.user.sk)}"\n`;
  }
  args.push(url);
  const p = Bun.spawn(args, { stdin: stdin ? new TextEncoder().encode(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const i = out.lastIndexOf("\n");
  const [code, t] = out.slice(i + 1).split(" ");
  return { code: Number(code) || 0, ms: Math.round(Number(t) * 1000), body: out.slice(0, i) };
}

export async function signed(t: Target, path: string, head = false): Promise<Res> {
  const user = await credentials(t);
  if (!user) throw Error(`${t.name} has no accessKey/secretKey configured`);
  return curl(`${t.endpoint}${path}`, { user, region: t.region, head });
}

export async function json(t: Target, path: string): Promise<any> {
  const r = await signed(t, path);
  if (r.code !== 200) throw Error(`${t.name} GET ${path} -> ${r.code || "no answer"}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}

export async function xml(t: Target, path: string): Promise<string> {
  const r = await signed(t, path);
  if (r.code !== 200) throw Error(`${t.name} GET ${path} -> ${r.code || "no answer"}: ${r.body.slice(0, 200)}`);
  return r.body;
}

// Enough XML for ListBuckets and ReplicationConfiguration — flat tags, no attributes we need.
export function tags(body: string, tag: string): string[] {
  return [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}
