import { describe, expect, it } from 'vitest';
import { isImageId, parseImageRef, tagProblem } from './image-ref.js';

describe('parseImageRef', () => {
  it('fills in the implicit docker.io registry and library/ namespace', () => {
    expect(parseImageRef('nginx')).toEqual({
      raw: 'nginx',
      registry: 'docker.io',
      registryImplicit: true,
      repository: 'library/nginx',
      tag: null,
      digest: null,
      canonical: 'docker.io/library/nginx'
    });
    expect(parseImageRef('bitnami/redis:7.2')).toMatchObject({
      registry: 'docker.io',
      registryImplicit: true,
      repository: 'bitnami/redis',
      tag: '7.2'
    });
  });

  it('gives the explicit and implicit spellings of one image the same canonical form', () => {
    const short = parseImageRef('nginx:1.25');
    const long = parseImageRef('docker.io/library/nginx:1.25');
    const legacy = parseImageRef('index.docker.io/nginx:1.25');
    expect(short?.canonical).toBe('docker.io/library/nginx:1.25');
    expect(long?.canonical).toBe(short?.canonical);
    expect(legacy?.canonical).toBe(short?.canonical);
    expect(long?.registryImplicit).toBe(false);
  });

  it('does not mistake a registry port for a tag', () => {
    expect(parseImageRef('localhost:5000/team/api')).toMatchObject({
      registry: 'localhost:5000',
      repository: 'team/api',
      tag: null
    });
    expect(parseImageRef('registry.internal:5000/api:2.1.0')).toMatchObject({
      registry: 'registry.internal:5000',
      repository: 'api',
      tag: '2.1.0'
    });
  });

  it('separates the digest from the tag', () => {
    const digest = 'sha256:' + 'a'.repeat(64);
    expect(parseImageRef(`ghcr.io/acme/app:1.0@${digest}`)).toMatchObject({
      registry: 'ghcr.io',
      registryImplicit: false,
      repository: 'acme/app',
      tag: '1.0',
      digest
    });
    expect(parseImageRef(`nginx@${digest}`)).toMatchObject({ tag: null, digest });
  });

  it('returns null for text that is not an image reference', () => {
    expect(parseImageRef('')).toBeNull();
    expect(parseImageRef('   ')).toBeNull();
    expect(parseImageRef('nginx latest')).toBeNull();
    expect(parseImageRef('nginx@notadigest')).toBeNull();
  });
});

describe('tagProblem', () => {
  it('flags :latest and untagged references, but not digest-pinned ones', () => {
    expect(tagProblem(parseImageRef('nginx')!)).toBe('untagged');
    expect(tagProblem(parseImageRef('nginx:latest')!)).toBe('latest');
    expect(tagProblem(parseImageRef('nginx:1.25-alpine')!)).toBeNull();
    expect(tagProblem(parseImageRef(`nginx:latest@sha256:${'b'.repeat(64)}`)!)).toBeNull();
    expect(tagProblem(parseImageRef(`nginx@sha256:${'b'.repeat(64)}`)!)).toBeNull();
  });
});

describe('isImageId', () => {
  it('recognises the bare image IDs docker ps shows when a tag moved away', () => {
    expect(isImageId('3f57d9401f8d')).toBe(true);
    expect(isImageId(`sha256:${'c'.repeat(64)}`)).toBe(true);
    expect(isImageId('nginx')).toBe(false);
    expect(isImageId('deadbeef')).toBe(false);
  });
});
