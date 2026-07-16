const TCO_ONLY_RE = /^\s*https?:\/\/t\.co\/\S+\s*$/i;

export function isTcoOnly(content: string | null | undefined): boolean {
  return typeof content === "string" && TCO_ONLY_RE.test(content);
}
