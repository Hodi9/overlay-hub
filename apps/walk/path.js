// Where the walk overlay is mounted: the value of WALK_PATH. It can be a short, readable name such as "marcelwalk"
// or a long secret one. It has to be plain letters, digits, "-" or "_", and it may not be the name of another page,
// or it would hide that page. Anything else gives null, and then the overlay is not mounted at all.
export function walkMountPath(value, taken = []) {
  const path = "/" + String(value || "").trim().replace(/^\/+|\/+$/g, "");
  return /^\/[A-Za-z0-9_-]{3,}$/.test(path) && !taken.includes(path) ? path : null;
}
