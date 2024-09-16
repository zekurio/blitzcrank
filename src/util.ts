export function formatAsUUID(id: string): string {
  if (!id || id.length !== 32) {
    return id; // Return original id if it's not in the expected format
  }
  return `${id.substr(0, 8)}-${id.substr(8, 4)}-${id.substr(12, 4)}-${id.substr(
    16,
    4
  )}-${id.substr(20)}`;
}
