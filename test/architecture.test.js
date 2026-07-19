import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('project architecture constraints', () => {
  it('does not declare or import Express', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const sourceFiles = [
      'src/a2a/server.js',
      'src/cluster.js',
      'src/index.js',
    ];
    const source = (
      await Promise.all(sourceFiles.map((path) => readFile(path, 'utf8')))
    ).join('\n');

    expect(packageJson.dependencies.express).toBeUndefined();
    expect(source).not.toMatch(/from ['"]express['"]/);
  });
});
