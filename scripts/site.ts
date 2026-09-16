/**
 * Builds the showcase site published at https://notyourfault.aldwin.fr.
 *
 * Usage: node scripts/site.ts <out-dir>
 *
 * The output is site/ plus the images it shares with the documentation, so
 * they are not duplicated in the repository.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SHARED = [
  ["docs/assets", "assets"],
  ["brand/logo.png", "assets/logo.png"],
  ["brand/social-preview.jpg", "assets/social-preview.jpg"],
] as const;

export function buildSite(root: string, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  cpSync(join(root, "site"), outDir, { recursive: true });
  mkdirSync(join(outDir, "assets"), { recursive: true });
  for (const [from, to] of SHARED) cpSync(join(root, from), join(outDir, to), { recursive: true });
}

function main(argv: string[]): void {
  const [outDir] = argv;
  if (!outDir) {
    console.error("Usage: node scripts/site.ts <out-dir>");
    process.exit(2);
  }
  buildSite(join(import.meta.dirname, ".."), outDir);
  console.log(`Built the site in ${outDir}.`);
}

if (import.meta.filename === process.argv[1]) main(process.argv.slice(2));
