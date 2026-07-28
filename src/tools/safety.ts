/**
 * Deterministic guards for the read-only service request tools.
 *
 * Unlike the legacy deployment (raw request tools + regex mutation allowlist +
 * external review broker), mutations here are dedicated typed tools — the
 * allowlist IS the tool surface. What remains for raw requests:
 *  - GET-only, service-relative paths, no credentials/URLs,
 *  - SABnzbd restricted to queue/history reads,
 *  - the Seerr issue lifecycle (comments, open/resolved) is host-owned.
 */

export function assertServicePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new Error("path must be service-relative and start with /");
  }
  if (
    path.startsWith("//") ||
    /[\r\n#]/.test(path) ||
    /^https?:\/\//i.test(path) ||
    /apikey|api_key|token/i.test(path)
  ) {
    throw new Error("path must not contain full URLs or credentials");
  }
}

export function assertSabReadAllowed(path: string): void {
  const parsed = new URL(path, "http://127.0.0.1");
  const permitted = new Set(["mode", "limit"]);
  for (const [key] of parsed.searchParams) {
    if (!permitted.has(key.toLowerCase())) {
      throw new Error("SABnzbd is read-only; only mode and limit query parameters are allowed");
    }
  }
  const modes = parsed.searchParams.getAll("mode");
  if (modes.length !== 1) {
    throw new Error("SABnzbd is read-only; exactly one mode query parameter is required");
  }
  const mode = modes[0]!.toLowerCase();
  if (parsed.pathname !== "/api" || (mode !== "queue" && mode !== "history")) {
    throw new Error(
      "SABnzbd is read-only; only GET /api?mode=queue and GET /api?mode=history are allowed",
    );
  }
}

export function assertSeerrLifecycleOwned(path: string): void {
  if (/\/comment\b/i.test(path) || /\/(resolved|open)\b/i.test(path)) {
    throw new Error(
      "Seerr comments and issue status changes are owned by blitzcrank; use your final-response directives instead",
    );
  }
}
