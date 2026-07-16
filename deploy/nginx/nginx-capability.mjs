const MINIMUM_UPSTREAM_RESOLVE_VERSION = Object.freeze({
  major: 1,
  minor: 27,
  patch: 3,
});

/**
 * Parse captured `nginx -v` output without reading the host or running a command.
 */
export function parseNginxVersion(versionOutput) {
  if (typeof versionOutput !== 'string') {
    throw new TypeError('nginx version output must be a string containing nginx/x.y.z');
  }

  const match = versionOutput.match(/\bnginx\/(\d+)\.(\d+)\.(\d+)\b/i);
  if (!match) {
    throw new TypeError('nginx version output must contain nginx/x.y.z');
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch, version: `${major}.${minor}.${patch}` };
}

function compareVersion(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

/**
 * Assess only the open-source dynamic-upstream capability relevant to this
 * operation packet. The `resolve` parameter on an upstream `server` became
 * available in open-source nginx 1.27.3; earlier versions must use the normal
 * resolver with a variable proxy_pass target and cannot claim upstream-group
 * keepalive for a DNS-changing origin.
 */
export function assessNginxCapabilities(versionOutput) {
  const detected = parseNginxVersion(versionOutput);
  const safeDynamicUpstreamKeepalive =
    compareVersion(detected, MINIMUM_UPSTREAM_RESOLVE_VERSION) >= 0;

  return {
    detectedVersion: detected.version,
    minimumUpstreamResolveVersion: '1.27.3',
    safeDynamicUpstreamKeepalive,
    recommendedProxyStrategy: safeDynamicUpstreamKeepalive
      ? 'upstream-resolve+keepalive'
      : 'resolver+variable-proxy_pass',
  };
}
