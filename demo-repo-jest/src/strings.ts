export function capitalize(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
