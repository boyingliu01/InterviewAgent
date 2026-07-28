import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAssetRoots } from '../src/utils/path-resolver.js';

describe('resolveAssetRoots', () => {
  const tmpRoot = join(tmpdir(), `path-resolver-test-${Date.now()}`);
  const testDirs: string[] = [];

  afterEach(() => {
    for (const dir of testDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    testDirs.length = 0;
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  function mkd(name: string): string {
    const p = join(tmpRoot, name);
    mkdirSync(p, { recursive: true });
    testDirs.push(p);
    return p;
  }

  it('should resolve paths for development layout (tsx, __dirname=src/)', () => {
    const root = mkd('dev');
    mkdirSync(join(root, 'src', 'views'), { recursive: true });
    mkdirSync(join(root, 'public'), { recursive: true });

    const result = resolveAssetRoots(join(root, 'src'));
    expect(result.viewsDir).toBe(resolve(root, 'src', 'views'));
    expect(result.staticRoot).toBe(resolve(root, 'public'));
  });

  it('should resolve paths for CLI install layout (__dirname=dist/src/)', () => {
    const root = mkd('cli-install');
    mkdirSync(join(root, 'dist', 'src'), { recursive: true });
    mkdirSync(join(root, 'src', 'views'), { recursive: true });
    mkdirSync(join(root, 'public'), { recursive: true });

    const result = resolveAssetRoots(join(root, 'dist', 'src'));
    expect(result.viewsDir).toBe(resolve(root, 'src', 'views'));
    expect(result.staticRoot).toBe(resolve(root, 'public'));
  });

  it('should resolve paths for npm install layout (__dirname=dist/src/, views at ../../src/views/)', () => {
    const root = mkd('npm-install');
    mkdirSync(join(root, 'node_modules', 'dialog-survey', 'dist', 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dialog-survey', 'src', 'views'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dialog-survey', 'public'), { recursive: true });

    const serverDir = join(root, 'node_modules', 'dialog-survey', 'dist', 'src');
    const result = resolveAssetRoots(serverDir);
    expect(result.viewsDir).toBe(
      resolve(root, 'node_modules', 'dialog-survey', 'src', 'views')
    );
    expect(result.staticRoot).toBe(resolve(root, 'node_modules', 'dialog-survey', 'public'));
  });

  it('should throw when no views directory exists', () => {
    const root = mkd('empty');
    mkdirSync(join(root, 'dist', 'src'), { recursive: true });

    expect(() => resolveAssetRoots(join(root, 'dist', 'src'))).toThrow(/views/i);
  });

  it('should throw when no public directory exists', () => {
    const root = mkd('no-public');
    mkdirSync(join(root, 'src', 'views'), { recursive: true });
    mkdirSync(join(root, 'dist', 'src'), { recursive: true });

    expect(() => resolveAssetRoots(join(root, 'dist', 'src'))).toThrow(/public/i);
  });

  it('should pick existing path regardless of which candidate matches', () => {
    const root = mkd('cli-both');
    mkdirSync(join(root, 'dist', 'src'), { recursive: true });
    mkdirSync(join(root, 'src', 'views'), { recursive: true });
    mkdirSync(join(root, 'public'), { recursive: true });

    const result = resolveAssetRoots(join(root, 'dist', 'src'));
    expect(result.viewsDir).toContain('src/views');
    expect(existsSync(result.viewsDir)).toBe(true);
  });
});
