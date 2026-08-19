import { probeCodexExecutable, resolveCodexExecutable } from "../src/codex-bin.mjs";

try {
  const resolution = await resolveCodexExecutable();
  const probe = await probeCodexExecutable(resolution.path);
  process.stdout.write(`${JSON.stringify({ ok: probe.ok, path: resolution.path, source: resolution.source, version: probe.versionText, error: probe.error })}\n`);
  process.exitCode = probe.ok ? 0 : 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
