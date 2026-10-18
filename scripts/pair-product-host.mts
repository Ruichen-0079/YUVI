/** Explicit local product ceremony. Reads only the endpoint path supplied by the
 * user/native shell; never discovers an installed Alice or accepts operator tokens. */
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
function argument(name: string) {
  const value = args[args.indexOf(name) + 1];
  if (!args.includes(name) || !value || value.startsWith("--")) throw Error(`Required ${name}`);
  return value;
}
const endpoint = JSON.parse(await readFile(argument("--endpoint-file"), "utf8"));
const base = new URL(endpoint.baseUrl);
if (
  base.protocol !== "http:" ||
  base.username !== "" ||
  base.password !== "" ||
  base.pathname !== "/" ||
  base.search !== "" ||
  base.hash !== "" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
  typeof endpoint.controlToken !== "string"
)
  throw Error("Invalid local Supervisor endpoint");
const response = await fetch(new URL("/v1/product-host/pairings", base), {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuvi-control-token": endpoint.controlToken },
  body: JSON.stringify({ personId: argument("--person"), origin: argument("--web-origin") }),
  signal: AbortSignal.timeout(10000),
  redirect: "error"
});
if (!response.ok)
  throw Error("Product pairing unavailable; verify the owned Runtime and Person binding");
const result = await response.json();
if (!/^yup_[A-Za-z0-9_-]{43}$/u.test(result.code)) throw Error("Invalid product pairing response");
console.log(`One-use pairing code (5 minutes): ${result.code}`);
