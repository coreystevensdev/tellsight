const MATCHER = '@bearertoken path ';

export function parseBearerTokenPrefixes(workflow: string): string[] {
  const line = workflow.split('\n').find((candidate) => candidate.includes(MATCHER));
  if (!line) throw new Error('no @bearertoken matcher in deployment source');

  return line
    .slice(line.indexOf(MATCHER) + MATCHER.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((prefix) => prefix.replace(/\*$/, ''));
}

export function findUncoveredSecretRoutes(routes: string[], prefixes: string[]): string[] {
  return routes.filter((route) => !prefixes.some((prefix) => `${route}/`.startsWith(prefix)));
}
