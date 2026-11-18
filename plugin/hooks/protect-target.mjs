#!/usr/bin/env node
// PreToolUse hook: deny any Write/Edit/MultiEdit/NotebookEdit whose path is inside a target's source directory.
// The app under analysis is read only; recon output belongs in targets/<name>/output/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot, listTargets, loadTarget, isInside, readStdin } from '../lib/target.mjs';

export function decide(input, root) {
  const file = input?.tool_input?.file_path || input?.tool_input?.notebook_path;
  if (!file) return null;
  const abs = path.resolve(root, file);
  for (const name of listTargets(root)) {
    let target;
    try {
      target = loadTarget(root, name);
    } catch {
      continue; // a target without a resolvable source has nothing to protect
    }
    if (isInside(abs, target.sourceDir)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `reverse-qa: ${file} is inside the source of target "${name}" (${target.sourceDir}). ` +
            `The app under analysis is read only. Write recon output to targets/${name}/output/ instead.`,
        },
      };
    }
  }
  return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    process.exit(0);
  }
  const root = projectRoot(input.cwd && !process.env.CLAUDE_PROJECT_DIR ? input.cwd : undefined);
  const decision = decide(input, root);
  if (decision) process.stdout.write(JSON.stringify(decision));
}
