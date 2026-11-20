/**
 * Runs the Solidity compiler on a stranger's source, apart from the explorer: a process of its own
 * with an empty environment (no database address, no secrets), Node's permission model (it may read
 * the worker script and nothing else, and may not start processes or threads), a time limit, a
 * memory limit and an output limit. Whatever goes wrong in there ends with that process.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./solc-worker.cjs", import.meta.url));
// Node 22.13 and later name the flag --permission; before that it was --experimental-permission.
const PERMISSION = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";

export interface CompileLimits {
  timeoutMs: number;
  /** Resident memory of the compiler's process (checked where /proc exists, which is where it runs in production). */
  maxMemoryBytes: number;
  maxOutputBytes: number;
}

export const LIMITS: CompileLimits = { timeoutMs: 120_000, maxMemoryBytes: 2 * 1024 ** 3, maxOutputBytes: 16 * 1024 * 1024 };

export class CompileError extends Error {}

/** Takes the compiler's bytes and a standard JSON input, gives the compiler's JSON answer. */
export type Compile = (compiler: Buffer, input: string) => Promise<string>;

const PAGE = 4096;
async function residentBytes(pid: number): Promise<number | null> {
  const statm = await readFile(`/proc/${pid}/statm`, "utf8").catch(() => null);
  const pages = statm ? Number(statm.split(" ")[1]) : NaN;
  return Number.isFinite(pages) ? pages * PAGE : null;
}

/** How the worker is started: what it may do, and the little it is told about this machine. */
export function sandbox(script: string): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: [PERMISSION, `--allow-fs-read=${script}`, "--disable-warning=ExperimentalWarning", "--max-old-space-size=1024", script],
    // Windows needs SystemRoot to start a process at all; nothing else is handed over.
    env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
  };
}

export function isolatedCompiler(limits: CompileLimits = LIMITS, onStart: (kill: () => void) => () => void = () => () => undefined): Compile {
  return (compiler, input) =>
    new Promise<string>((resolve, reject) => {
      const { args, env } = sandbox(WORKER);
      const child = spawn(process.execPath, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const out: Buffer[] = [];
      let size = 0;
      let errors = "";
      let failure: string | null = null;
      const stop = (why: string) => {
        failure ??= why;
        child.kill("SIGKILL");
      };
      const done = onStart(() => stop("The explorer is shutting down"));
      const timer = setTimeout(() => stop(`Compilation took longer than ${limits.timeoutMs / 1000} seconds`), limits.timeoutMs);
      const watch = setInterval(async () => {
        const used = child.pid ? await residentBytes(child.pid) : null;
        if (used !== null && used > limits.maxMemoryBytes) stop("Compilation used too much memory");
      }, 500);

      child.stdout.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limits.maxOutputBytes) stop("The compiler's output is too large");
        else out.push(c);
      });
      child.stderr.on("data", (c: Buffer) => {
        if (errors.length < 2000) errors += c.toString("utf8");
      });
      child.on("error", (e) => stop(`The compiler could not start: ${e.message}`));
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(watch);
        done();
        if (failure) return reject(new CompileError(failure));
        if (code !== 0) return reject(new CompileError(`The compiler stopped with an error${errors ? `: ${errors.trim().split("\n").pop()!.slice(0, 200)}` : ""}`));
        resolve(Buffer.concat(out).toString("utf8"));
      });
      // The child may be killed before it has read everything.
      child.stdin.on("error", () => undefined);
      child.stdin.write(`${compiler.length}\n`);
      child.stdin.write(compiler);
      child.stdin.end(input);
    });
}
