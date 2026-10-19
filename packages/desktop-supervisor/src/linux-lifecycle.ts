import fs from "node:fs";
/** Additional OS containment evidence for the managed Linux R5 profile.
 * An old metadata file never grants entry into this invocation's cgroup. */
export function managedLifecycleOwnsPid(pid: number): boolean {
  const expected = process.env["YUVI_LINUX_LIFECYCLE_CGROUP"];
  if (!expected) return true; // Existing non-managed platform contracts.
  if (process.platform !== "linux" || !expected.startsWith("/")) return false;
  const group = (id: number | "self") => fs.readFileSync(`/proc/${id}/cgroup`, "utf8")
    .trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
  try { return group("self") === expected && group(pid) === expected; }
  catch { return false; }
}
