/**
 * Contract verification. Someone sends an address, a compiler version and source; the explorer
 * compiles the source itself (compile.ts) and publishes it only if the bytecode that comes out is
 * the code at the address (match.ts), and, when it has the transaction that created the contract,
 * the creation code in that transaction too. Nothing a request claims is taken on trust.
 *
 * One compilation runs at a time and a few wait behind it; past that, requests are refused. What
 * is kept of verified sources in a day has a limit too, so the database cannot be filled by them.
 */
import { randomBytes } from "node:crypto";
import { keccak256 } from "viem";
import type { Queryable } from "../db.ts";
import * as Q from "../queries.ts";
import type { Hex, RawTx, Rpc } from "../rpc.ts";
import { CompileError, type Compile } from "./compile.ts";
import type { CompilerBuild } from "./compilers.ts";
import { compilerInput, parseRequest, type VerifyRequest } from "./input.ts";
import { matchCreation, matchRuntime, type MatchKind, type Range } from "./match.ts";

export interface Job {
  guid: string;
  address: string;
  state: "pending" | "pass" | "fail";
  /** Why it failed, in a sentence for the person who sent it. */
  reason: string | null;
  at: number;
}

export interface VerifierDeps {
  db: Queryable;
  rpc: Rpc;
  /** The pinned build's bytes (compilers.ts). */
  loadCompiler: (build: CompilerBuild) => Promise<Buffer>;
  compile: Compile;
  /** Bytes of verified source the database takes in 24 hours. */
  dailyBytes: number;
  log?: (message: string) => void;
}

/** Requests waiting for the compiler, the running one not counted. */
export const QUEUE_LENGTH = 8;
/** How long a finished request's answer can still be asked for. */
const KEEP_MS = 60 * 60 * 1000;
const MAX_JOBS = 2000;
/** No contract that fits in a block has an ABI near this size; one that claims to is not kept. */
const MAX_ABI_BYTES = 2 * 1024 * 1024;

/** Etherscan's own words, which Foundry and Hardhat look for. */
export const ALREADY_VERIFIED = "Contract source code already verified";
export const noCode = (address: string) => `Unable to locate ContractCode at ${address}`;

const FULL = "The explorer has stored as much verified source as it takes in a day. Try again tomorrow";

export type Submitted = { ok: true; guid: string } | { ok: false; error: string };

interface CompiledContract {
  abi?: unknown;
  evm?: {
    bytecode?: { object?: unknown };
    deployedBytecode?: { object?: unknown; immutableReferences?: unknown };
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hexOf = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

/** The compiler's map of immutables, as byte ranges. */
function immutableRanges(refs: unknown): Range[] | null {
  if (refs === undefined) return [];
  if (!isObject(refs)) return null;
  const out: Range[] = [];
  for (const list of Object.values(refs)) {
    if (!Array.isArray(list)) return null;
    for (const r of list) {
      if (!isObject(r) || typeof r.start !== "number" || typeof r.length !== "number") return null;
      out.push({ start: r.start, length: r.length });
    }
  }
  return out;
}

class Failed extends Error {}

export class Verifier {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: { job: Job; request: VerifyRequest }[] = [];
  private running = false;
  private closed = false;

  constructor(private readonly deps: VerifierDeps) {}

  status(guid: string): Job | null {
    return this.jobs.get(guid) ?? null;
  }

  /** Checks what can be checked at once and puts the rest in the queue. */
  async submit(field: (name: string) => string | undefined): Promise<Submitted> {
    const parsed = parseRequest(field);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const code = await this.code(request.address);
    if (code === "0x") return { ok: false, error: noCode(request.address) };
    const existing = await Q.verified(this.deps.db, request.address);
    if (existing && existing.match_kind === "full" && existing.code_hash === keccak256(code)) return { ok: false, error: ALREADY_VERIFIED };
    for (const waiting of this.jobs.values()) {
      if (waiting.state === "pending" && waiting.address === request.address) return { ok: false, error: "A verification of this contract is already in the queue" };
    }
    if (this.closed || this.queue.length >= QUEUE_LENGTH) return { ok: false, error: "The verification queue is full. Try again in a minute" };
    if (!(await this.room(JSON.stringify(request.input).length))) return { ok: false, error: FULL };

    this.forget();
    const job: Job = { guid: randomBytes(16).toString("hex"), address: request.address, state: "pending", reason: null, at: Date.now() };
    this.jobs.set(job.guid, job);
    this.queue.push({ job, request });
    void this.drain();
    return { ok: true, guid: job.guid };
  }

  private async code(address: string): Promise<Hex> {
    return ((await this.deps.rpc.call<Hex>("eth_getCode", [address, "latest"])) ?? "0x").toLowerCase() as Hex;
  }

  /** Stops taking requests and answers the waiting ones. The compilation that is running is stopped by whoever started the compiler. */
  close() {
    this.closed = true;
    for (const { job } of this.queue.splice(0)) {
      job.state = "fail";
      job.reason = "The explorer restarted. Send the verification again";
    }
  }

  /** Whether what was stored in the last 24 hours leaves room for this many bytes more. */
  private async room(bytes: number): Promise<boolean> {
    const since = BigInt(Math.floor(Date.now() / 1000) - 86_400);
    return Number(await Q.verifiedBytesSince(this.deps.db, since)) + bytes <= this.deps.dailyBytes;
  }

  private forget() {
    const now = Date.now();
    for (const [guid, job] of this.jobs) {
      if (job.state !== "pending" && (now - job.at > KEEP_MS || this.jobs.size > MAX_JOBS)) this.jobs.delete(guid);
    }
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const { job, request } = next;
        try {
          await this.verify(request);
          job.state = "pass";
        } catch (e) {
          job.state = "fail";
          if (e instanceof Failed || e instanceof CompileError) job.reason = e.message;
          else {
            job.reason = "The explorer could not finish the verification. Try again";
            this.deps.log?.(`verification of ${request.address} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        job.at = Date.now();
      }
    } finally {
      this.running = false;
    }
  }

  private async verify(request: VerifyRequest): Promise<void> {
    const { db, rpc } = this.deps;
    const compiler = await this.deps.loadCompiler(request.build).catch((e) => {
      this.deps.log?.(`compiler ${request.build.long} could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
      throw new Failed(`Compiler ${request.build.version} could not be loaded. Try again`);
    });
    let output: unknown;
    try {
      output = JSON.parse(await this.deps.compile(compiler, compilerInput(request)));
    } catch (e) {
      if (e instanceof CompileError) throw e;
      throw new Failed("The compiler's answer could not be read");
    }
    if (!isObject(output)) throw new Failed("The compiler's answer could not be read");
    const errors = (Array.isArray(output.errors) ? output.errors : []).filter((e): e is Record<string, unknown> => isObject(e) && e.severity === "error");
    if (errors.length) {
      const first = String(errors[0]!.formattedMessage ?? errors[0]!.message ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      throw new Failed(`Compilation failed. ${first}`);
    }

    const contracts = isObject(output.contracts) ? output.contracts : {};
    const found: [string, CompiledContract][] = [];
    for (const [file, inFile] of Object.entries(contracts)) {
      if (request.file !== null && file !== request.file) continue;
      if (isObject(inFile) && Object.hasOwn(inFile, request.name) && isObject(inFile[request.name])) found.push([file, inFile[request.name] as CompiledContract]);
    }
    if (found.length === 0) throw new Failed(`The sources have no contract named ${request.name}`);
    if (found.length > 1) throw new Failed(`More than one source defines ${request.name}. Give the name as path/File.sol:${request.name}`);
    const [file, contract] = found[0]!;
    const runtime = hexOf(contract.evm?.deployedBytecode?.object);
    const creation = hexOf(contract.evm?.bytecode?.object);
    const immutables = immutableRanges(contract.evm?.deployedBytecode?.immutableReferences);
    if (!runtime || !creation || immutables === null || !Array.isArray(contract.abi)) throw new Failed(`${request.name} has no bytecode. An interface or an abstract contract cannot be verified`);
    if (/__/.test(runtime) || /__/.test(creation)) throw new Failed("The contract uses libraries. Give their addresses in the settings (libraries) of the standard JSON input");

    const code = await this.code(request.address);
    if (code === "0x") throw new Failed(noCode(request.address));
    // With the compiler told not to append its metadata, the end of the code is the contract's own and none of it is set aside.
    const settings = request.input.settings;
    const partial = !(isObject(settings.metadata) && settings.metadata.appendCBOR === false);
    let kind: MatchKind | null = matchRuntime(code.slice(2), runtime, immutables, { address: request.address.slice(2), partial });
    if (!kind) throw new Failed("The compiled bytecode is not the code at the address. Check the compiler version, the optimizer runs, the EVM version and via-IR");

    // A contract made by a transaction of its own has its constructor's code and arguments in that
    // transaction, and they must be this source's too. One made by another contract has no such
    // record here: its deployed code is all that is compared.
    let args: string | null = null;
    const made = await Q.creation(db, request.address);
    if (made) {
      const tx = await rpc.call<RawTx | null>("eth_getTransactionByHash", [made.hash]);
      if (!tx) throw new Error(`creation transaction ${made.hash} is not on the node`);
      if (tx.to === null) {
        const matched = matchCreation(tx.input.slice(2).toLowerCase(), creation, runtime, { partial });
        if (!matched) throw new Failed("The compiled creation code is not the code in the transaction that created the contract");
        if (matched.kind === "partial") kind = "partial";
        args = matched.args;
      }
    }

    const abi = JSON.stringify(contract.abi);
    const input = JSON.stringify(request.input);
    if (abi.length > MAX_ABI_BYTES) throw new Failed("The contract's ABI is too large to keep");
    if (!(await this.room(input.length + abi.length))) throw new Failed(FULL);
    const optimizer = isObject(settings.optimizer) ? settings.optimizer : {};
    const written = await Q.saveVerified(db, {
      address: request.address,
      name: request.name,
      file,
      compiler: request.build.long,
      optimizer: optimizer.enabled === true,
      runs: typeof optimizer.runs === "number" && Number.isSafeInteger(optimizer.runs) && optimizer.runs >= 0 ? BigInt(optimizer.runs) : null,
      evm_version: typeof settings.evmVersion === "string" ? settings.evmVersion.slice(0, 32) : null,
      match_kind: kind,
      creation_checked: args !== null,
      constructor_args: args,
      abi,
      input,
      code_hash: keccak256(code),
      verified_at: BigInt(Math.floor(Date.now() / 1000)),
    });
    if (!written) throw new Failed(kind === "full" ? ALREADY_VERIFIED : "This contract is already verified. Only a full match, from its exact source files, replaces a partial one");
  }
}
