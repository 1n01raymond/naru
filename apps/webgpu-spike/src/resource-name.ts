/**
 * The file name a package resource URI refers to.
 *
 * A compiled package declares its resources as relative URIs, which a local
 * scene has to match against the files the user selected. It lives on its own
 * so the geometry Worker can match a relocated hierarchy sidecar without
 * importing the property machinery.
 */
export function resourceFileName(uri: string): string {
  return decodeURIComponent(new URL(uri, "https://naru.local/").pathname.split("/").pop() ?? "");
}
