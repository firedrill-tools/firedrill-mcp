/** Explicit build command shipped with the standalone MCP source package. */
import ts from "typescript";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src"), destination = join(root, "dist");
function checkTree(path) {
  if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) throw new Error("Build input/output must not contain symlinks");
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) checkTree(join(path, entry.name));
    else if (!entry.isFile()) throw new Error("Build input/output must contain regular files only");
  }
}
checkTree(source);
try { checkTree(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
const program = ts.createProgram([join(source, "mcp/main.ts")], {
  target: ts.ScriptTarget.ES2022, lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, esModuleInterop: true, skipLibCheck: true, noEmitOnError: true,
  declaration: false, sourceMap: false, rootDir: source, outDir: destination,
});
for (const file of program.getSourceFiles().filter(file => !file.isDeclarationFile)) {
  const path = relative(source, file.fileName);
  if (path.startsWith("..") || isAbsolute(path)) throw new Error("Build escaped client source");
}
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else {
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error("MCP build did not emit cleanly");
  console.log("Built Firedrill's stdio operator client. No server was started or published.");
}
