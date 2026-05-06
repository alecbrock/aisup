export function slugifyProjectName(name: string, maxLen = 50): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return slug || 'project';
}

export function buildChannelName(projectSlug: string, aisupSessionId: string): string {
  const shortId = aisupSessionId.replace(/-/g, '').slice(0, 8);
  const prefix = 'aisup-';
  const suffix = `-${shortId}`;
  const maxProjectLen = 80 - prefix.length - suffix.length;
  const truncatedSlug = projectSlug.slice(0, maxProjectLen);
  return `${prefix}${truncatedSlug}${suffix}`;
}

export function isChannelNameTaken(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { data?: { error?: string } }).data?.error === 'name_taken';
}
