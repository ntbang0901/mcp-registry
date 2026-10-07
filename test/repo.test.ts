import { describe, expect, it } from 'vitest';
import { normalizeRepoId } from '../src/repo.js';

describe('normalizeRepoId', () => {
  it.each([
    ['git@github.com:Acme/App.git', 'github.com/acme/app'],
    ['https://github.com/acme/app', 'github.com/acme/app'],
    ['https://github.com/acme/app.git/', 'github.com/acme/app'],
    ['https://user:pw@github.com/acme/app.git', 'github.com/acme/app'],
    ['ssh://git@github.com:22/acme/app.git', 'github.com/acme/app'],
    ['gitlab.example.com/group/sub/app', 'gitlab.example.com/group/sub/app'],
    ['github.com/acme/app', 'github.com/acme/app'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRepoId(input)).toBe(expected);
  });

  it('requires a host', () => {
    expect(() => normalizeRepoId('acme/app')).toThrow(/must include the host/);
  });
});
