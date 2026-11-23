/**
 * Reads the server-issued CSRF cookie (double-submit pattern). The companion
 * session cookie is HttpOnly, so this public half is what same-origin
 * JavaScript echoes back in the mutation header.
 */
export function getCsrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith('op_csrf='));
  return match ? decodeURIComponent(match.slice('op_csrf='.length)) : '';
}

export function mutationHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  const token = getCsrfToken();
  return token ? { 'x-csrf-token': token, ...extra } : { ...extra };
}
