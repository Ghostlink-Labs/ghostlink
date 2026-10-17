import { POCKET, decodeEventData, decodeLogs } from "@ghostlink/service-kit";

/** An incomplete observation must never become an acknowledged empty transaction. */
export function completeEvents(logs: unknown): ReturnType<typeof decodeLogs> {
  if (!Array.isArray(logs) || logs.some(line => typeof line !== "string" || /log truncated/i.test(line))) throw new Error("watcher logs unavailable or truncated");
  if (logs.length > 2048 || logs.reduce((n, line: string) => n + Buffer.byteLength(line), 0) > 64 * 1024) throw new Error("watcher logs exceed work envelope");
  const stack: string[] = [];
  for (const line of logs as string[]) {
    const start = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (start) {
      if (Number(start[2]) !== stack.length + 1) throw new Error("watcher logs have inconsistent invocation depth");
      stack.push(start[1]!); continue;
    }
    if (stack.length === 1 && stack[0] === POCKET.toBase58() && line.startsWith("Program data: ")) {
      const encoded = line.slice("Program data: ".length), bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || !decodeEventData(bytes)) throw new Error("watcher logs have malformed protocol event");
    }
    const end = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/.exec(line);
    if (end && stack.pop() !== end[1]) throw new Error("watcher logs have inconsistent invocation boundaries");
  }
  if (stack.length) throw new Error("watcher logs end before invocation completion");
  const events = decodeLogs(logs);
  if (events.length > 256) throw new Error("watcher events exceed work envelope");
  return events;
}
