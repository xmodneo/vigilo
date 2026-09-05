import { constants, openSync, closeSync, fstatSync, readSync, mkdirSync, lstatSync,
  writeFileSync, readFileSync, mkdtempSync, linkSync, rmSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCandidate } from "./candidate.js";
import { createEvidenceReport, EvidenceError } from "./evidence.js";
import { VERIFICATION_CONTROL } from "./verify-candidate.js";

function directory(path: string, create = false) {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new EvidenceError(); }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EvidenceError();
}

function readBounded(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new EvidenceError();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new EvidenceError();
    return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

// Offline only: no sandbox methods, credential loading, patching, or execution.
// projectRoot is the host-selected workspace, not a path from an execution record.
export function generateEvidenceFile(projectRoot: string) {
  const runtime = join(projectRoot, ".vigilo");
  directory(runtime);
  directory(join(runtime, "candidates"));
  const evidence = join(runtime, "evidence");
  directory(evidence);
  directory(join(evidence, "records"));
  const input: unknown = JSON.parse(readBounded(join(evidence, "records/workflow.json"), 262_144));
  const candidate = loadCandidate(join(runtime, `candidates/${VERIFICATION_CONTROL.candidateHash}.json`));
  const report = createEvidenceReport(input, JSON.stringify(candidate));
  const bytes = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > 65_536) throw new EvidenceError();
  const reports = join(evidence, "reports");
  directory(reports, true);
  const path = join(reports, `${report.reportId}.json`);
  const staging = mkdtempSync(join(reports, ".stage-"));
  try {
    const temporary = join(staging, "report.json");
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readBounded(path, 65_536) !== bytes) throw new EvidenceError();
    }
    return { path, report };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const { path, report } = generateEvidenceFile(fileURLToPath(new URL("../../", import.meta.url)));
    console.log(JSON.stringify({ reportId: report.reportId, path: `.vigilo/evidence/reports/${report.reportId}.json`,
      classification: report.classification, reportBytes: Buffer.byteLength(readFileSync(path)) }, null, 2));
    process.exitCode = report.classification.overallOutcome === "verified" ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ error: "evidence_generation_failed", reportWritten: false }));
    process.exitCode = 1;
  }
}
