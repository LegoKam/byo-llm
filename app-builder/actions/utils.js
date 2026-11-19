/* Helpers for App Builder web actions. No dependencies. */

/** A web action response with a JSON body. */
export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body,
  };
}

/**
 * @param {number} statusCode
 * @param {string} code A machine-readable reason, the same vocabulary the plugin uses for LLM errors.
 * @param {string} message Shown to the author. Must not contain secrets.
 */
export function errorResponse(statusCode, code, message) {
  return jsonResponse(statusCode, { error: message, code });
}

/** Reads the bearer token from the Authorization header of a web action request. */
export function getBearerToken(params) {
  const header = params?.__ow_headers?.authorization;
  if (typeof header !== 'string') return undefined;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : undefined;
}

/** "org-a, org-b/site-1" becomes ['org-a', 'org-b/site-1']. */
export function parseAllowList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

/** An entry allows a whole organisation ("org") or one site ("org/site"). There is no wildcard. */
export function isAllowed(allowList, org, site) {
  const orgKey = org.toLowerCase();
  const siteKey = `${orgKey}/${site.toLowerCase()}`;
  return allowList.includes(orgKey) || allowList.includes(siteKey);
}
