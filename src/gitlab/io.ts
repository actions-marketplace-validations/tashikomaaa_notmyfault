import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AnnotationLevel } from "../platform";
import { ESC, VariablesIO } from "../variables-io";

export { variable } from "../variables-io";

interface CodeQualityIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: "info" | "minor" | "major";
  location: { path: string; lines: { begin: number } };
}

const SEVERITY: Record<AnnotationLevel, CodeQualityIssue["severity"]> = { error: "major", warning: "minor", notice: "info" };

/**
 * Inputs and outputs in GitLab CI/CD: NOTMYFAULT_* variables, a dotenv file and
 * a Markdown summary, plus annotations as a Code Quality report, which merge
 * requests show, and collapsible sections in the job log.
 */
export class GitLabIO extends VariablesIO {
  private readonly issues: CodeQualityIssue[] = [];
  private sections = 0;
  private readonly openSections: string[] = [];

  constructor(env: NodeJS.ProcessEnv = process.env, write?: (line: string) => void) {
    super(env, write, env.CI_PROJECT_DIR ?? process.cwd());
  }

  /** A collapsed section of the job log. */
  group(title: string): void {
    const id = `notmyfault_${++this.sections}`;
    this.openSections.push(id);
    this.write(`${ESC}[0Ksection_start:${seconds()}:${id}[collapsed=true]\r${ESC}[0K${title}`);
  }

  endGroup(): void {
    const id = this.openSections.pop();
    if (id) this.write(`${ESC}[0Ksection_end:${seconds()}:${id}\r${ESC}[0K`);
  }

  /** Annotations on a file become Code Quality issues. The others have nowhere to go in a merge request. */
  annotation(level: AnnotationLevel, message: string, properties: Record<string, string | number | undefined>): void {
    const path = properties.file;
    if (path === undefined) return;
    const title = properties.title ? `${properties.title}: ` : "";
    this.issues.push({
      description: `${title}${message.replace(/\s*\n\s*/g, " — ")}`,
      check_name: "notmyfault",
      fingerprint: createHash("sha256").update(`${path}:${properties.title ?? ""}`).digest("hex").slice(0, 32),
      severity: SEVERITY[level],
      location: { path: String(path), lines: { begin: Number(properties.line) || 1 } },
    });
  }

  override finish(): void {
    writeFileSync(this.path("NOTMYFAULT_CODE_QUALITY_FILE", "gl-code-quality-report.json"), `${JSON.stringify(this.issues, null, 1)}\n`);
    super.finish();
  }
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}
