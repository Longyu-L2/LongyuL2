/** One line of the watchtower's health report. */
export type Status = "ok" | "warning" | "critical";

export interface Check {
  name: string;
  status: Status;
  detail: string;
}

export interface Log {
  (event: string, fields?: Record<string, unknown>): void;
}

export const worst = (checks: readonly Check[]): Status =>
  checks.some((c) => c.status === "critical") ? "critical" : checks.some((c) => c.status === "warning") ? "warning" : "ok";
