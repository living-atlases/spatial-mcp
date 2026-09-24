/**
 * spatial-service task status (Task.groovy): 0 = in_queue, 1 = running, 2 = cancelled, 3 = error, 4 = finished.
 * /tasks/status/<id> returns {id, name, status, message, history: {<millis>: "line"}, output?}.
 */
export type Verdict = "queued" | "running" | "cancelled" | "failed" | "success" | "unknown";

export interface TaskStatus {
  id?: number | string;
  name?: string;
  status?: number;
  message?: string;
  history?: Record<string, string>;
  output?: unknown[];
}

export interface TaskSummary {
  id?: number | string;
  name?: string;
  verdict: Verdict;
  done: boolean;
  message?: string;
  /** Last lines of the task history, oldest first, with ISO timestamps. */
  log: string[];
  output?: unknown[];
}

const VERDICTS: Record<number, Verdict> = { 0: "queued", 1: "running", 2: "cancelled", 3: "failed", 4: "success" };

export function summarizeTask(t: TaskStatus, tail = 15): TaskSummary {
  const verdict = t.status !== undefined ? (VERDICTS[t.status] ?? "unknown") : "unknown";
  const log = Object.entries(t.history ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .slice(-tail)
    .map(([ts, line]) => `${Number.isFinite(Number(ts)) ? new Date(Number(ts)).toISOString() : ts} ${line}`);
  const s: TaskSummary = { id: t.id, name: t.name, verdict, done: ["cancelled", "failed", "success"].includes(verdict), message: t.message, log };
  if (t.output?.length) s.output = t.output;
  return s;
}
