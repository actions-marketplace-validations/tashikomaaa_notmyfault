/**
 * Pins the GitLab template to the version being built: the tag of this release
 * and the checksum of the bundle jobs download. Run by `npm run build`, so the
 * template committed with a release always matches the bundle of that release.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const template = join(root, "templates", "notmyfault.gitlab-ci.yml");

export function pinTemplate(): { ref: string; checksum: string } {
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const checksum = createHash("sha256").update(readFileSync(join(root, "dist", "notmyfault.mjs"))).digest("hex");
  const ref = `v${version}`;
  const pinned = readFileSync(template, "utf8")
    .replace(/^(\s*NOTMYFAULT_REF: ).*$/m, `$1${ref}`)
    .replace(/^(\s*NOTMYFAULT_SHA256: ).*$/m, `$1${checksum}`);
  writeFileSync(template, pinned);
  return { ref, checksum };
}

if (process.argv[1] && dirname(process.argv[1]) === join(root, "scripts")) {
  const { ref, checksum } = pinTemplate();
  console.log(`templates/notmyfault.gitlab-ci.yml pinned to ${ref}, ${checksum.slice(0, 12)}…`);
}
