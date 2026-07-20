import {
  createHash,
  createHmac,
} from 'node:crypto';

const EMPTY_BODY = Buffer.alloc(0);

function encodeRfc3986Component(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalizeQuery(url) {
  return [...url.searchParams.entries()]
    .map(([key, value], index) => ({ key, value, index }))
    .sort((left, right) => {
      if (left.key !== right.key) return left.key < right.key ? -1 : 1;
      if (left.value !== right.value) return left.value < right.value ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ key, value }) => (
      `${encodeRfc3986Component(key)}=${encodeRfc3986Component(value)}`
    ))
    .join('&');
}

export function buildCanonicalRequest({
  timestamp,
  method,
  url,
  body = EMPTY_BODY,
}) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return [
    timestamp,
    method.toUpperCase(),
    url.pathname,
    canonicalizeQuery(url),
    bodyHash,
  ].join('\n');
}

export function signRequest({
  secret,
  ...request
}) {
  return createHmac('sha256', secret)
    .update(buildCanonicalRequest(request))
    .digest('hex');
}

export function signedHeaders({
  secret,
  method = 'GET',
  url,
  body = EMPTY_BODY,
  timestamp = String(Math.floor(Date.now() / 1000)),
}) {
  return {
    'X-CC-Timestamp': timestamp,
    'X-CC-Signature': signRequest({
      secret,
      timestamp,
      method,
      url,
      body,
    }),
  };
}
