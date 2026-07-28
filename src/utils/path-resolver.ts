import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function tryResolve(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the views and static asset directories relative to the server module's __dirname.
 *
 * Supports three deployment layouts:
 * - Development (tsx): __dirname = <root>/src → assets at ../public, ./views
 * - CLI install (~/.dialog-survey): __dirname = <root>/dist/src → assets at ../../public, ../../src/views
 * - npm install (node_modules/dialog-survey): __dirname = <root>/dist/src → assets at ../../public, ../../src/views
 */
export function resolveAssetRoots(serverDirname: string): {
  viewsDir: string;
  staticRoot: string;
} {
  const viewsCandidates = [
    resolve(serverDirname, '..', 'src', 'views'),
    resolve(serverDirname, '..', '..', 'src', 'views'),
  ];

  const viewsDir = tryResolve(viewsCandidates);
  if (!viewsDir) {
    throw new Error(
      `Could not resolve views directory. Tried:\n  - ${viewsCandidates.join('\n  - ')}\nEnsure src/views/ exists relative to the server directory or package root.`
    );
  }

  const staticCandidates = [
    resolve(serverDirname, '..', 'public'),
    resolve(serverDirname, '..', '..', 'public'),
  ];

  const staticRoot = tryResolve(staticCandidates);
  if (!staticRoot) {
    throw new Error(
      `Could not resolve static files directory. Tried:\n  - ${staticCandidates.join('\n  - ')}\nEnsure public/ exists relative to the server directory or package root.`
    );
  }

  return { viewsDir, staticRoot };
}
