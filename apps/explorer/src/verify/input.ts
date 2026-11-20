/**
 * Turns a verification request (the fields Etherscan's API takes, which Foundry and Hardhat send)
 * into the standard JSON input the compiler is given. Only what is listed here reaches the
 * compiler: sources with their text inline, the settings that shape bytecode, and an output
 * selection of the explorer's own.
 */
import { findCompiler, type CompilerBuild } from "./compilers.ts";

export interface VerifyRequest {
  address: string;
  build: CompilerBuild;
  /** The contract's name, and the source file that defines it when the request named one. */
  name: string;
  file: string | null;
  /** language, sources and settings as they are stored once verified (no output selection). */
  input: StandardInput;
}

export interface StandardInput {
  language: "Solidity";
  sources: Record<string, { content: string }>;
  settings: Record<string, unknown>;
}

export const EVM_VERSIONS = ["homestead", "tangerineWhistle", "spuriousDragon", "byzantium", "constantinople", "petersburg", "istanbul", "berlin", "london", "paris", "shanghai", "cancun", "prague", "osaka"];
/** Settings that change the bytecode or its metadata. Anything else in a request is left out. */
const SETTINGS = ["optimizer", "evmVersion", "viaIR", "metadata", "remappings", "libraries", "debug", "eofVersion"];
const OUTPUTS = ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"];

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const MAX_SOURCES = 2000;
const MAX_PATH = 512;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Control characters have no place in a file's name, and a page would show them as nothing.
const pathOk = (p: string) => p.length > 0 && p.length <= MAX_PATH && !/[\u0000-\u001f\u007f]/.test(p);

export type Parsed = { ok: true; value: VerifyRequest } | { ok: false; error: string };
const no = (error: string): Parsed => ({ ok: false, error });

/** `field` reads one named field of the request, whether it came in the query or in the body. */
export function parseRequest(field: (name: string) => string | undefined): Parsed {
  const address = (field("contractaddress") ?? field("address") ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return no("Invalid address format");

  const build = findCompiler(field("compilerversion") ?? "");
  if (!build) return no("Unsupported compiler version. Give a Solidity release from 0.5.0 on, as v0.8.28+commit.7893614a");

  const format = field("codeformat") || "solidity-single-file";
  const source = field("sourceCode") ?? "";
  if (!source.trim()) return no("Missing sourceCode");

  // "path/File.sol:Name" names the file as well; a bare name is looked for in every file.
  const named = (field("contractname") ?? "").trim();
  const colon = named.lastIndexOf(":");
  const name = colon === -1 ? named : named.slice(colon + 1);
  const file = colon === -1 ? null : named.slice(0, colon);
  if (!NAME.test(name)) return no("Missing or invalid contractname");
  if (file !== null && !pathOk(file)) return no("Invalid contractname");

  if (format === "solidity-standard-json-input") {
    let json: unknown;
    try {
      json = JSON.parse(source);
    } catch {
      return no("sourceCode is not valid JSON");
    }
    if (!isObject(json) || json.language !== "Solidity") return no('Only standard JSON input with "language": "Solidity" is supported');
    if (!isObject(json.sources)) return no("The standard JSON input has no sources");
    const entries = Object.entries(json.sources);
    if (entries.length === 0 || entries.length > MAX_SOURCES) return no(`The standard JSON input must have between 1 and ${MAX_SOURCES} sources`);
    const sources: [string, { content: string }][] = [];
    for (const [path, value] of entries) {
      if (!pathOk(path)) return no("A source has an invalid file name");
      // Nothing is fetched on a request's behalf: a source given as an address is refused.
      if (!isObject(value) || typeof value.content !== "string") return no(`Source ${path.slice(0, 80)} has no content. Every source must be in the input`);
      sources.push([path, { content: value.content }]);
    }
    if (file !== null && !sources.some(([path]) => path === file)) return no(`The input has no source named ${file.slice(0, 80)}`);
    const given = isObject(json.settings) ? json.settings : {};
    const settings = Object.fromEntries(SETTINGS.filter((k) => Object.hasOwn(given, k)).map((k) => [k, given[k]]));
    return { ok: true, value: { address: address.toLowerCase(), build, name, file, input: { language: "Solidity", sources: Object.fromEntries(sources), settings } } };
  }

  if (format !== "solidity-single-file") return no("Unsupported codeformat. Use solidity-standard-json-input or solidity-single-file");
  const runs = field("runs") ?? "200";
  if (!/^\d{1,10}$/.test(runs) || Number(runs) > 4_294_967_295) return no("Invalid runs");
  const evm = (field("evmversion") ?? "").trim();
  if (evm && evm !== "default" && !EVM_VERSIONS.includes(evm)) return no("Unsupported evmversion");
  const on = (v: string | undefined) => v === "1" || v === "true" || v === "on";
  const settings: Record<string, unknown> = { optimizer: { enabled: on(field("optimizationUsed")), runs: Number(runs) } };
  if (evm && evm !== "default") settings.evmVersion = evm;
  if (on(field("viaIR"))) settings.viaIR = true;
  const path = file ?? `${name}.sol`;
  return { ok: true, value: { address: address.toLowerCase(), build, name, file: path, input: { language: "Solidity", sources: Object.fromEntries([[path, { content: source }]]), settings } } };
}

/** What the compiler is given: the stored input, asked for the one contract's ABI and bytecode. */
export function compilerInput(request: Pick<VerifyRequest, "name" | "file" | "input">): string {
  const outputSelection = Object.fromEntries([[request.file ?? "*", Object.fromEntries([[request.name, OUTPUTS]])]]);
  return JSON.stringify({ ...request.input, settings: { ...request.input.settings, outputSelection } });
}
