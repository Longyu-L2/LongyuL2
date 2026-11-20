// One Solidity compilation, then exit. Started by compile.ts in a process of its own that has no
// environment and, under Node's permission model, may read this file and nothing else: the source
// it compiles comes from a stranger.
//
// Standard input: the compiler's size in bytes and a line feed, the compiler (already checked
// against its pinned hash by the parent), then the standard JSON input. Standard output: the
// compiler's JSON answer. No import callback is given, so every source must be in the input.
"use strict";

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const all = Buffer.concat(chunks);
  const line = all.indexOf(10);
  const size = Number(all.subarray(0, line).toString("latin1"));
  if (line < 1 || !Number.isSafeInteger(size) || size <= 0 || line + 1 + size > all.length) {
    process.stderr.write("bad input framing\n");
    process.exit(2);
  }
  const compilerSource = all.subarray(line + 1, line + 1 + size).toString("utf8");
  const input = all.subarray(line + 1 + size).toString("utf8");

  const holder = { exports: {} };
  new Function("module", "exports", "require", "__dirname", "__filename", compilerSource)(holder, holder.exports, require, __dirname, __filename);
  const soljson = holder.exports;

  const run = () => {
    const compile = soljson.cwrap("solidity_compile", "string", ["string", "number", "number"]);
    const output = compile(input, 0, 0);
    process.stdout.write(output, () => process.exit(0));
  };
  if (typeof soljson._solidity_compile === "function") run();
  else soljson.onRuntimeInitialized = run;
});
