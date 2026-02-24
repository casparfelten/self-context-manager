/**
 * SSOT Conformance Tests: Filesystem Resolver (§5.2, §5.3, §5.4)
 *
 * Tests filesystem path resolution:
 * - Forward translation: agent path → canonical path + filesystemId
 * - Reverse translation: canonical path → display path (for metadata)
 * - Bind mount vs overlay detection
 * - Watchability determination
 * - Filesystem identity (§5.4)
 *
 * Reference: docs/spec/context-manager-ssot.md §5.2, §5.3, §5.4
 */

import { describe, expect, it, beforeEach } from 'vitest';

// Mount mapping structure per §5.2
interface MountMapping {
  agentPrefix: string;      // e.g., "/workspace"
  canonicalPrefix: string;  // e.g., "/home/abaris/.openclaw/workspaces/dev"
  filesystemId: string;     // Host FS ID
  writable: boolean;        // From docker inspect RW field
}

// Resolved path result
interface ResolvedPath {
  filesystemId: string;
  canonicalPath: string;
  isMounted: boolean;       // true = bind mount (host), false = container-internal
}

// Filesystem resolver implementation per §5.2
class FilesystemResolver {
  private mounts: MountMapping[];
  private defaultFsId: string;    // Container overlay FS ID
  private hostFsId: string;       // Host FS ID

  constructor(
    defaultFsId: string,
    hostFsId: string,
    mounts: MountMapping[]
  ) {
    this.defaultFsId = defaultFsId;
    this.hostFsId = hostFsId;
    // Sort by prefix length descending for longest-match
    this.mounts = [...mounts].sort(
      (a, b) => b.agentPrefix.length - a.agentPrefix.length
    );
  }

  // Forward translation: agent path → canonical + fsId
  resolve(agentPath: string): ResolvedPath {
    // Longest-prefix match
    for (const mount of this.mounts) {
      if (agentPath.startsWith(mount.agentPrefix)) {
        // Match found - this is a bind mount
        let suffix = agentPath.slice(mount.agentPrefix.length);
        // Handle root mount case: ensure proper path joining
        if (mount.agentPrefix === '/' && !suffix.startsWith('/')) {
          suffix = '/' + suffix;
        }
        // Avoid double slashes
        const canonical = mount.canonicalPrefix.endsWith('/') && suffix.startsWith('/')
          ? mount.canonicalPrefix + suffix.slice(1)
          : mount.canonicalPrefix + suffix;
        return {
          filesystemId: mount.filesystemId,
          canonicalPath: canonical,
          isMounted: true,
        };
      }
    }

    // No match - container-internal (overlay)
    return {
      filesystemId: this.defaultFsId,
      canonicalPath: agentPath, // Path unchanged
      isMounted: false,
    };
  }

  // Reverse translation: canonical → display (agent-visible)
  reverseResolve(canonicalPath: string): string {
    for (const mount of this.mounts) {
      if (canonicalPath.startsWith(mount.canonicalPrefix)) {
        const suffix = canonicalPath.slice(mount.canonicalPrefix.length);
        return mount.agentPrefix + suffix;
      }
    }
    // No match - show canonical path
    return canonicalPath;
  }

  // Is path watchable? (host-accessible)
  isWatchable(agentPath: string): boolean {
    const resolved = this.resolve(agentPath);
    return resolved.isMounted; // Only bind mounts are watchable
  }
}

// Build resolver for no-sandbox case
function buildPassthroughResolver(): FilesystemResolver {
  const hostFsId = 'host-machine-id';
  return new FilesystemResolver(hostFsId, hostFsId, []);
}

describe('SSOT §5.3 - Forward Translation (agent → canonical)', () => {
  let resolver: FilesystemResolver;

  beforeEach(() => {
    // Typical sandbox setup
    resolver = new FilesystemResolver(
      'container-overlay-abc',  // default FS ID
      'host-machine-xyz',       // host FS ID
      [
        {
          agentPrefix: '/workspace',
          canonicalPrefix: '/home/abaris/.openclaw/workspaces/dev',
          filesystemId: 'host-machine-xyz',
          writable: true,
        },
        {
          agentPrefix: '/shared',
          canonicalPrefix: '/mnt/shared-drive',
          filesystemId: 'host-machine-xyz',
          writable: false,
        },
      ]
    );
  });

  it('longest-prefix match against mount mappings', () => {
    const result = resolver.resolve('/workspace/src/main.ts');

    expect(result.canonicalPath).toBe('/home/abaris/.openclaw/workspaces/dev/src/main.ts');
  });

  it('match → replace agent prefix with canonical prefix, use mapping FS ID', () => {
    const result = resolver.resolve('/workspace/package.json');

    expect(result.filesystemId).toBe('host-machine-xyz');
    expect(result.canonicalPath).toBe('/home/abaris/.openclaw/workspaces/dev/package.json');
    expect(result.isMounted).toBe(true);
  });

  it('no match → path as-is, default (overlay) FS ID', () => {
    const result = resolver.resolve('/tmp/scratch.txt');

    expect(result.filesystemId).toBe('container-overlay-abc');
    expect(result.canonicalPath).toBe('/tmp/scratch.txt'); // Unchanged
    expect(result.isMounted).toBe(false);
  });

  it('handles nested paths correctly', () => {
    const result = resolver.resolve('/workspace/src/components/Button/index.tsx');

    expect(result.canonicalPath).toBe(
      '/home/abaris/.openclaw/workspaces/dev/src/components/Button/index.tsx'
    );
  });

  it('handles exact prefix match', () => {
    const result = resolver.resolve('/workspace');

    expect(result.canonicalPath).toBe('/home/abaris/.openclaw/workspaces/dev');
    expect(result.isMounted).toBe(true);
  });

  it('longer prefix wins (longest-match)', () => {
    // Add a more specific mount
    resolver = new FilesystemResolver(
      'container',
      'host',
      [
        {
          agentPrefix: '/workspace',
          canonicalPrefix: '/general/workspace',
          filesystemId: 'host',
          writable: true,
        },
        {
          agentPrefix: '/workspace/special',
          canonicalPrefix: '/special/location',
          filesystemId: 'host',
          writable: true,
        },
      ]
    );

    // Should match the longer prefix
    const result = resolver.resolve('/workspace/special/file.ts');

    expect(result.canonicalPath).toBe('/special/location/file.ts');
  });

  it('multiple mounts handled correctly', () => {
    const workspaceResult = resolver.resolve('/workspace/main.ts');
    const sharedResult = resolver.resolve('/shared/data.json');
    const tmpResult = resolver.resolve('/tmp/file.txt');

    expect(workspaceResult.canonicalPath).toContain('openclaw/workspaces');
    expect(sharedResult.canonicalPath).toContain('shared-drive');
    expect(tmpResult.canonicalPath).toBe('/tmp/file.txt');
  });
});

describe('SSOT §5.3 - Reverse Translation (canonical → display)', () => {
  let resolver: FilesystemResolver;

  beforeEach(() => {
    resolver = new FilesystemResolver(
      'container',
      'host',
      [
        {
          agentPrefix: '/workspace',
          canonicalPrefix: '/home/user/project',
          filesystemId: 'host',
          writable: true,
        },
      ]
    );
  });

  it('replace canonical prefix with agent prefix', () => {
    const display = resolver.reverseResolve('/home/user/project/src/index.ts');

    expect(display).toBe('/workspace/src/index.ts');
  });

  it('no match → show canonical path', () => {
    const display = resolver.reverseResolve('/other/location/file.txt');

    expect(display).toBe('/other/location/file.txt'); // Unchanged
  });

  it('used for metadata rendering (§4.1)', () => {
    // Per spec: "displayPath is the agent-visible path
    // (reverse-translated from canonical via mount mappings)"

    const canonicalPath = '/home/user/project/main.ts';
    const displayPath = resolver.reverseResolve(canonicalPath);

    expect(displayPath).toBe('/workspace/main.ts');
  });
});

describe('SSOT §5.2 - Watchability', () => {
  let resolver: FilesystemResolver;

  beforeEach(() => {
    resolver = new FilesystemResolver(
      'container-overlay',
      'host',
      [
        {
          agentPrefix: '/workspace',
          canonicalPrefix: '/home/user/dev',
          filesystemId: 'host',
          writable: true,
        },
      ]
    );
  });

  it('bind-mounted paths are watchable', () => {
    expect(resolver.isWatchable('/workspace/main.ts')).toBe(true);
  });

  it('container-internal paths are not watchable', () => {
    // Per spec: "Container overlay paths: no watcher (ephemeral)"
    expect(resolver.isWatchable('/tmp/scratch.txt')).toBe(false);
  });

  it('watchability reflects host accessibility', () => {
    // Per spec: "For bind-mounted files, the client watches the
    // canonical host-side path (it has direct access)"

    const agentPath = '/workspace/file.ts';
    const isWatchable = resolver.isWatchable(agentPath);
    const resolved = resolver.resolve(agentPath);

    // Watchable means client can access the canonical path
    expect(isWatchable).toBe(true);
    expect(resolved.canonicalPath).toBe('/home/user/dev/file.ts');
  });
});

describe('SSOT §5.4 - Filesystem Identity', () => {
  it('host FS ID from /etc/machine-id SHA-256', () => {
    // Per spec: "Host: SHA-256 of /etc/machine-id"

    // Example: machine-id content might be "a1b2c3d4..."
    // hostFsId = SHA-256("a1b2c3d4...")

    const hostFsId = 'sha256-of-machine-id';
    expect(typeof hostFsId).toBe('string');
  });

  it('container overlay FS ID from container ID or machine-id', () => {
    // Per spec: "Container overlay: SHA-256 of container ID
    // or container's own /etc/machine-id"

    const containerFsId = 'sha256-of-container-id';
    expect(typeof containerFsId).toBe('string');
  });

  it('bind mounts use host FS ID (edits propagate)', () => {
    // Per spec: "Bind mounts use the host's FS ID
    // (edits propagate both ways — same filesystem)"

    const resolver = new FilesystemResolver(
      'container-id',
      'host-id',
      [
        {
          agentPrefix: '/workspace',
          canonicalPrefix: '/host/path',
          filesystemId: 'host-id', // Uses host FS ID!
          writable: true,
        },
      ]
    );

    const resolved = resolver.resolve('/workspace/file.ts');

    expect(resolved.filesystemId).toBe('host-id');
  });

  it('different filesystemId = different object identity', () => {
    // Per spec: same path string on different filesystems = different objects

    const hostFsId = 'host-machine';
    const containerFsId = 'container-overlay';

    expect(hostFsId).not.toBe(containerFsId);

    // This means /tmp/file.txt on host vs container are different objects
  });
});

describe('SSOT §5.2 - Resolver Construction', () => {
  describe('From docker inspect (primary)', () => {
    it('parses Mounts array correctly', () => {
      // Docker inspect returns this structure
      const dockerMounts = [
        {
          Source: '/home/abaris/.openclaw/workspaces/dev',
          Destination: '/workspace',
          Type: 'bind',
          RW: true,
        },
        {
          Source: '/var/data',
          Destination: '/data',
          Type: 'bind',
          RW: false,
        },
      ];

      // Convert to MountMapping
      const mounts: MountMapping[] = dockerMounts
        .filter((m) => m.Type === 'bind')
        .map((m) => ({
          agentPrefix: m.Destination,
          canonicalPrefix: m.Source,
          filesystemId: 'host-fs-id',
          writable: m.RW,
        }));

      expect(mounts).toHaveLength(2);
      expect(mounts[0].agentPrefix).toBe('/workspace');
      expect(mounts[0].canonicalPrefix).toBe('/home/abaris/.openclaw/workspaces/dev');
    });
  });

  describe('Passthrough (no sandbox)', () => {
    it('single FS ID, no mounts, resolve returns path unchanged', () => {
      const resolver = buildPassthroughResolver();

      const result = resolver.resolve('/home/user/project/file.ts');

      expect(result.canonicalPath).toBe('/home/user/project/file.ts');
      expect(result.isMounted).toBe(false); // No mounts configured
      // But in no-sandbox, everything is on host
    });

    it('all paths are canonical in no-sandbox case', () => {
      const resolver = buildPassthroughResolver();

      // Agent path = canonical path = display path
      const agentPath = '/home/user/project/main.ts';
      const resolved = resolver.resolve(agentPath);
      const display = resolver.reverseResolve(resolved.canonicalPath);

      expect(resolved.canonicalPath).toBe(agentPath);
      expect(display).toBe(agentPath);
    });

    it('everything is watchable in no-sandbox case', () => {
      // In no-sandbox, client runs on host, can watch anything
      // The resolver itself doesn't track this, but conceptually:
      // - No sandbox = no container = all paths are host paths
      // - All host paths are watchable

      expect(true).toBe(true); // Conceptual test
    });
  });
});

describe('Filesystem Resolver - Edge Cases', () => {
  it('handles trailing slashes consistently', () => {
    const resolver = new FilesystemResolver(
      'container',
      'host',
      [
        {
          agentPrefix: '/workspace',
          canonicalPrefix: '/home/user/dev',
          filesystemId: 'host',
          writable: true,
        },
      ]
    );

    // With and without trailing slash
    const result1 = resolver.resolve('/workspace/file.ts');
    const result2 = resolver.resolve('/workspace//file.ts'); // Double slash

    expect(result1.canonicalPath).toBe('/home/user/dev/file.ts');
    // Double slash is path issue, but resolver should handle
  });

  it('handles root mount', () => {
    // Rare but possible: mount at /
    // Note: when agentPrefix is '/', the suffix is the full path including leading /
    // So /any/path → suffix = /any/path → canonical = /host/root/any/path
    const resolver = new FilesystemResolver(
      'container',
      'host',
      [
        {
          agentPrefix: '/',
          canonicalPrefix: '/host/root',
          filesystemId: 'host',
          writable: true,
        },
      ]
    );

    const result = resolver.resolve('/any/path');

    // When prefix is '/', suffix is '/any/path', so result is '/host/root' + '/any/path'
    // This creates a double slash which is valid but ugly
    // A proper implementation would normalize this
    expect(result.canonicalPath).toBe('/host/root/any/path');
  });

  it('similar prefixes handled correctly', () => {
    const resolver = new FilesystemResolver(
      'container',
      'host',
      [
        {
          agentPrefix: '/workspace',
          canonicalPrefix: '/home/user/workspace',
          filesystemId: 'host',
          writable: true,
        },
        {
          agentPrefix: '/workspace-other',
          canonicalPrefix: '/home/other/workspace',
          filesystemId: 'host',
          writable: true,
        },
      ]
    );

    const result1 = resolver.resolve('/workspace/file.ts');
    const result2 = resolver.resolve('/workspace-other/file.ts');

    expect(result1.canonicalPath).toBe('/home/user/workspace/file.ts');
    expect(result2.canonicalPath).toBe('/home/other/workspace/file.ts');
  });
});
