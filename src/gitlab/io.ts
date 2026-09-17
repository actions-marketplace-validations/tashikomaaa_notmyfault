import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AnnotationLevel, Io } from "../platform";

interface CodeQualityIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: "info" | "minor" | "major";
  location: { path: string; lines: { begin: number } };
}

const SEVERITY: Record<AnnotationLevel, CodeQualityIssue["severity"]> = { error: "major", warning: "minor", notice: "info" };
const ESC = "\u001b";

/**
 * Inputs and outputs in GitLab CI/CD, where jobs have neither step inputs nor
 * outputs: inputs are NOTMYFAULT_* variables, outputs go to a dotenv file,
 * the summary to a Markdown file and annotations to a Code Quality report,
 * which merge requests show.
 */
export class GitLabIO implements Io {
  private readonly outputs = new Map<string, string>();
  private readonly issues: CodeQualityIssue[] = [];
  private summaryStarted = false;
  private sections = 0;
  private readonly openSections: string[] = [];

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + EOL),
  ) {}

  input(name: string, fallback = ""): string {
    const value = this.env[variable(name)];
    return value === undefined || value.trim() === "" ? fallback : value.trim();
  }

  booleanInput(name: string, fallback: boolean): boolean {
    const value = this.input(name).toLowerCase();
    if (value === "") return fallback;
    if (["true", "yes", "on", "1"].includes(value)) return true;
    if (["false", "no", "off", "0"].includes(value)) return false;
    throw new Error(`${this.describeInput(name)} must be a boolean, got "${value}"`);
  }

  integerInput(name: string, fallback: number, min: number): number {
    const value = this.input(name);
    if (value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new Error(`${this.describeInput(name)} must be an integer >= ${min}, got "${value}"`);
    }
    return parsed;
  }

  inputName(name: string): string {
    return variable(name);
  }

  describeInput(name: string): string {
    return `Variable ${variable(name)}`;
  }

  describeInputs(names: string[]): string {
    return `Variables ${names.map(variable).join(" and ")}`;
  }

  setOutput(name: string, value: string | number | boolean): void {
    this.outputs.set(variable(name), String(value));
  }

  appendSummary(markdown: string): void {
    const file = this.path("NOTMYFAULT_SUMMARY_FILE", "notmyfault-summary.md");
    if (this.summaryStarted) appendFileSync(file, markdown + EOL);
    else writeFileSync(file, markdown + EOL);
    this.summaryStarted = true;
  }

  /** GitLab hides variables marked as masked, and has no command to mask a value at runtime. */
  mask(): void {}

  info(message: string): void {
    this.write(message);
  }

  warning(message: string): void {
    this.write(`${ESC}[33mWarning: ${message}${ESC}[0m`);
  }

  error(message: string): void {
    this.write(`${ESC}[31mError: ${message}${ESC}[0m`);
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

  finish(): void {
    writeFileSync(this.path("NOTMYFAULT_CODE_QUALITY_FILE", "gl-code-quality-report.json"), `${JSON.stringify(this.issues, null, 1)}\n`);
    if (this.outputs.size === 0) return;
    const lines = [...this.outputs].map(([name, value]) => `${name}=${value}`);
    writeFileSync(this.path("NOTMYFAULT_OUTPUT_FILE", "notmyfault.env"), `${lines.join("\n")}\n`);
  }

  private path(name: string, fallback: string): string {
    const file = this.env[name]?.trim() || fallback;
    return isAbsolute(file) ? file : join(this.env.CI_PROJECT_DIR ?? process.cwd(), file);
  }
}

/** The variable holding an input: "history-branch" is read from NOTMYFAULT_HISTORY_BRANCH. */
export function variable(name: string): string {
  return `NOTMYFAULT_${name.toUpperCase().replace(/-/g, "_")}`;
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}
