// Fixtures are real responses from RustFS 1.0.1-preview.11 (2026-09-28), trimmed.
import { describe, expect, test } from "bun:test";
import { parseTargets } from "../src/config";
import { parseMetrics, parseRemoteTargets, parseRules, verdict } from "../src/report";
import { parsePlain } from "../src/who";

const RULES = `<?xml version="1.0" encoding="UTF-8"?><ReplicationConfiguration><Role>arn:minio:replication:us-east-1:052d:photos</Role><Rule><DeleteMarkerReplication><Status>Enabled</Status></DeleteMarkerReplication><DeleteReplication><Status>Enabled</Status></DeleteReplication><Destination><Bucket>arn:minio:replication:us-east-1:052d:photos</Bucket><StorageClass>STANDARD</StorageClass></Destination><ExistingObjectReplication><Status>Enabled</Status></ExistingObjectReplication><ID>rule-1:photos</ID><Priority>1</Priority><Status>Enabled</Status></Rule></ReplicationConfiguration>`;

const TARGETS = [{ sourcebucket: "photos", endpoint: "127.0.0.1:29700", targetbucket: "photos", secure: false,
  arn: "arn:minio:replication:us-east-1:052d:photos", offlineCount: 1, replicationSync: false,
  totalDowntime: 5805625250, lastOnline: "2026-09-28T01:42:35.433639Z", isOnline: true, latency: { curr: 560839 } }];

const METRICS = { replicationCount: 22, completedReplicationSize: 6000005,
  failed: { lastMinute: { count: 0, bytes: 0 }, lastHour: { count: 20, bytes: 6000000 }, totals: { count: 20, bytes: 6000000 } },
  queued: { curr: { count: 0, bytes: 0 } } };

describe("replication parsing", () => {
  test("rule flags", () => {
    expect(parseRules(RULES)).toEqual([{ id: "rule-1:photos", enabled: true, prefix: "", deletes: true, deleteMarkers: true, existing: true,
      arn: "arn:minio:replication:us-east-1:052d:photos" }]);
  });
  test("remote target state", () => {
    const [t] = parseRemoteTargets(TARGETS);
    expect(t.endpoint).toBe("http://127.0.0.1:29700");
    expect(t.online).toBe(true);
    expect(t.offlineCount).toBe(1);
  });
  test("historic failures after catch-up are not reported as a present problem", () => {
    const v = verdict(parseRemoteTargets(TARGETS), parseMetrics(METRICS));
    expect(v).toStartWith("in sync now. 20 historic failures");
  });
  test("target down wins over everything", () => {
    const down = parseRemoteTargets([{ ...TARGETS[0], isOnline: false }]);
    expect(verdict(down, parseMetrics(METRICS))).toStartWith("TARGET DOWN (http://127.0.0.1:29700");
  });
  test("queue and fresh failures", () => {
    const ts = parseRemoteTargets(TARGETS);
    expect(verdict(ts, parseMetrics({ ...METRICS, queued: { curr: { count: 3, bytes: 900 } } }))).toStartWith("catching up: 3 objects");
    expect(verdict(ts, parseMetrics({ ...METRICS, failed: { ...METRICS.failed, lastMinute: { count: 2 } } }))).toStartWith("failing: 2");
  });
  test("disabled rule or missing target is not 'in sync'", () => {
    const [rule] = parseRules(RULES);
    expect(verdict(parseRemoteTargets(TARGETS), parseMetrics({}), [{ ...rule, enabled: false }])).toStartWith("NOT REPLICATING: every rule is disabled");
    expect(verdict([], parseMetrics({}), [rule])).toStartWith("NOT REPLICATING: rules exist but no remote target");
  });
  test("empty metrics", () => {
    expect(verdict([], parseMetrics({}))).toBe("in sync.");
  });
});

describe("targets.json", () => {
  test("accepts pass and env references", () => {
    const t = parseTargets({ m5: { endpoint: "http://127.0.0.1:19000", accessKey: { pass: "m5/rustfs-access-key" }, secretKey: { env: "SK" } } });
    expect(t[0]).toMatchObject({ name: "m5", endpoint: "http://127.0.0.1:19000", region: "us-east-1" });
  });
  test("refuses a literal key", () => {
    expect(() => parseTargets({ m5: { endpoint: "http://h:9000", accessKey: "AKIA123" } })).toThrow(/never a literal key/);
  });
  test("refuses an endpoint with a path", () => {
    expect(() => parseTargets({ m5: { endpoint: "http://h:9000/bucket" } })).toThrow(/no path/);
  });
});

describe("who", () => {
  test("relic --plain lines", () => {
    const hits = parsePlain("/a/b.jsonl\t2851\tprojects/x\t[tool_use Bash] brew install\ttab\n/c.md\t0\tvaults/y\tnote\n");
    expect(hits).toEqual([{ file: "/a/b.jsonl", seq: 2851, text: "[tool_use Bash] brew install\ttab" }, { file: "/c.md", seq: 0, text: "note" }]);
  });
});
