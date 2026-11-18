// Find and run Docker. On Windows, Docker Desktop does not always put docker.exe on the PATH of child shells, so the
// default install location is tried as well. DOCKER_BIN overrides both.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WINDOWS_DEFAULT = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
let cached;

export function dockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  if (cached !== undefined) return cached;
  if (spawnSync('docker', ['--version'], { encoding: 'utf8' }).status === 0) cached = 'docker';
  else if (process.platform === 'win32' && fs.existsSync(WINDOWS_DEFAULT)) cached = WINDOWS_DEFAULT;
  else cached = null;
  return cached;
}

/** True when the docker CLI exists and the engine answers. */
export function dockerAvailable() {
  const bin = dockerBin();
  return Boolean(bin) && spawnSync(bin, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;
}

/** Run docker synchronously. Returns { status, stdout, stderr }. Throws only when the CLI is missing. */
export function docker(args, { input, cwd, env, timeout } = {}) {
  const bin = dockerBin();
  if (!bin) throw new Error('docker CLI not found: install Docker Desktop or set DOCKER_BIN');
  const r = spawnSync(bin, args, {
    input,
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Arguments for `docker compose` against a target's compose file, run from the target folder (its .env applies). */
export function composeArgs(target, args, { profiles = [] } = {}) {
  const file = path.join(target.dir, target.def.runtime?.compose_file ?? 'docker-compose.yml');
  return ['compose', '-f', file, ...profiles.flatMap((p) => ['--profile', p]), ...args];
}

export function compose(target, args, { profiles, input, env, timeout } = {}) {
  return docker(composeArgs(target, args, { profiles }), { input, cwd: target.dir, env, timeout });
}

/** Throw with docker's own message when a command failed. */
export function ok(result, what) {
  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
  return result;
}

/** Docker wants forward slashes in host paths on Windows. */
export function mountPath(p) {
  return path.resolve(p).split(path.sep).join('/');
}

/**
 * Run a one-off container with host folders copied in, instead of bind-mounted. Docker Desktop bind mounts from some
 * Windows folders (OneDrive, %TEMP%) hang on this kind of setup, while `docker cp` goes through the Docker API and
 * works everywhere. copies: [{ from: hostDir, to: containerDir }]. Returns { status, stdout, stderr }.
 */
export function runWithFiles(image, command, copies, { createArgs = [], timeout = 600_000, copyOut = [] } = {}) {
  const env = { MSYS_NO_PATHCONV: '1' };
  const created = ok(docker(['create', ...createArgs, image, ...command], { env }), `docker create ${image}`);
  const id = created.stdout.trim();
  try {
    for (const c of copies) ok(docker(['cp', mountPath(c.from), `${id}:${c.to}`], { env }), `docker cp ${c.from}`);
    const result = docker(['start', '-a', id], { env, timeout });
    // copyOut: [{ from: containerPath, to: hostPath }], fetched after the run (a missing file is simply not copied)
    for (const c of copyOut) docker(['cp', `${id}:${c.from}`, mountPath(c.to)], { env });
    return result;
  } finally {
    docker(['rm', '-f', id], { env });
  }
}
