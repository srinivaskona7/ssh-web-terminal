/**
 * Container image references, parsed the way Docker resolves them: a missing
 * registry means docker.io, a single-component name lives under library/, and
 * a colon is a tag only when it comes after the last slash (otherwise it is a
 * registry port).
 */

export interface ImageRef {
  raw: string;
  registry: string;
  /** True when the reference names no registry and Docker falls back to docker.io. */
  registryImplicit: boolean;
  repository: string;
  tag: string | null;
  digest: string | null;
  /** Fully qualified form; two spellings of one image share it. */
  canonical: string;
}

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$/;
const REFERENCE_CHARS = /^[A-Za-z0-9._\-/:@]+$/;

export function parseImageRef(input: string): ImageRef | null {
  const raw = input.trim();
  if (!raw || !REFERENCE_CHARS.test(raw)) return null;

  let name = raw;
  let digest: string | null = null;
  const at = raw.indexOf('@');
  if (at >= 0) {
    digest = raw.slice(at + 1);
    name = raw.slice(0, at);
    if (!DIGEST.test(digest)) return null;
  }

  let tag: string | null = null;
  const lastColon = name.lastIndexOf(':');
  if (lastColon > name.lastIndexOf('/')) {
    tag = name.slice(lastColon + 1);
    name = name.slice(0, lastColon);
    if (!tag) return null;
  }
  if (!name || name.startsWith('/') || name.endsWith('/')) return null;

  const slash = name.indexOf('/');
  const first = slash >= 0 ? name.slice(0, slash) : '';
  const hasRegistry = slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
  let registry = hasRegistry ? first : 'docker.io';
  let repository = hasRegistry ? name.slice(slash + 1) : name;
  if (DOCKER_HUB_ALIASES.has(registry)) {
    registry = 'docker.io';
    if (!repository.includes('/')) repository = `library/${repository}`;
  }

  const canonical = `${registry}/${repository}${tag ? `:${tag}` : ''}${digest ? `@${digest}` : ''}`;
  return { raw, registry, registryImplicit: !hasRegistry, repository, tag, digest, canonical };
}

/** `latest` and untagged references move under you; a digest pins them. */
export function tagProblem(ref: ImageRef): 'latest' | 'untagged' | null {
  if (ref.digest) return null;
  if (ref.tag === null) return 'untagged';
  return ref.tag === 'latest' ? 'latest' : null;
}

/** A bare image ID (what `docker ps` shows once the tag points elsewhere). */
export function isImageId(value: string): boolean {
  return /^(?:sha256:)?(?:[0-9a-f]{12}|[0-9a-f]{64})$/.test(value.trim());
}
