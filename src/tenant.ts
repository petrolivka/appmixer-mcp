/**
 * What the tenant is: its appmixer-core version and public URLs, read from
 * the unauthenticated root endpoint `GET /`.
 *
 * Compatibility policy (docs/status.md, "Core compatibility"): the minimum
 * supported core is 6.5. There is no hand-kept compatibility matrix; the
 * server reads the version at runtime and detects missing endpoints and
 * modules as it goes (a 404 on a route that should exist means the tenant
 * does not have it).
 */

export const MIN_CORE_VERSION = '6.5.0';

export interface TenantInfo {
    name?: string;
    version?: string;
    tenantId?: string;
    studioUrl?: string;
    integrationsUrl?: string;
}

type Triple = [number, number, number];

/** Parse "6.5.15" or "6.6.0-rc.1" into [major, minor, patch]; undefined if not a version. */
export function parseVersion(version: string | undefined): Triple | undefined {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version?.trim() ?? '');
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Negative when a < b, 0 when equal, positive when a > b (pre-release tags are ignored). */
export function compareVersions(a: Triple, b: Triple): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * Whether the tenant's core is at least `min`. Unknown when the tenant did not
 * report a parseable version (old builds, proxies): callers should then try
 * the call and let the API answer.
 */
export function supportsCore(version: string | undefined, min = MIN_CORE_VERSION): boolean | undefined {
    const actual = parseVersion(version);
    const required = parseVersion(min);
    if (!actual || !required) return undefined;
    return compareVersions(actual, required) >= 0;
}

/** A one-line warning when the tenant runs a core older than supported, otherwise undefined. */
export function compatibilityWarning(info: TenantInfo): string | undefined {
    if (supportsCore(info.version) === false) {
        return `The tenant runs appmixer-core ${info.version}; appmixer-mcp supports ${MIN_CORE_VERSION} ` +
            'and newer. Tools may fail on endpoints this version does not have.';
    }
    return undefined;
}
