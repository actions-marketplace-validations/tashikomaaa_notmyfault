import { appendFileSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AnnotationLevel, Io } from "./platform";

export const ESC = "\u001b";
/** Shorter values are too common to replace safely: "1" or "ok" would blank out the report. */
const MIN_MASKED_LENGTH = 8;

/**
 * Inputs and outputs of CI systems without step inputs nor outputs: inputs are
 * NOTMYFAULT_* variables, outputs go to a dotenv file and the summary to a
 * Markdown file, both kept as artifacts.
 */
export abstract class VariablesIO implements Io {
  private readonly outputs = new Map<string, string>();
  private readonly secrets: string[] = [];
  private summaryStarted = false;

  constructor(
    protected readonly env: NodeJS.ProcessEnv = process.env,
    protected readonly write: (line: string) => void = (line) => process.stdout.write(line + EOL),
    /** Where relative paths of files are resolved from. */
    protected readonly directory: string = process.cwd(),
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
    const text = this.redact(markdown) + EOL;
    if (this.summaryStarted) appendFileSync(file, text);
    else writeFileSync(file, text);
    this.summaryStarted = true;
  }

  /**
   * CI systems without a command to mask a value at runtime: notmyfault replaces the secret itself in everything it
   * writes, so a token cannot reach the log, the summary or the outputs even if something else puts it there.
   */
  mask(secret: string): void {
    if (secret.trim().length >= MIN_MASKED_LENGTH) this.secrets.push(secret);
  }

  /** Replaces every masked secret with ***. */
  protected redact(text: string): string {
    return this.secrets.reduce((redacted, secret) => redacted.split(secret).join("***"), text);
  }

  info(message: string): void {
    this.write(this.redact(message));
  }

  warning(message: string): void {
    this.write(`${ESC}[33mWarning: ${this.redact(message)}${ESC}[0m`);
  }

  error(message: string): void {
    this.write(`${ESC}[31mError: ${this.redact(message)}${ESC}[0m`);
  }

  abstract group(title: string): void;
  abstract endGroup(): void;
  abstract annotation(level: AnnotationLevel, message: string, properties: Record<string, string | number | undefined>): void;

  finish(): void {
    if (this.outputs.size === 0) return;
    const lines = [...this.outputs].map(([name, value]) => `${name}=${this.redact(value)}`);
    writeFileSync(this.path("NOTMYFAULT_OUTPUT_FILE", "notmyfault.env"), `${lines.join("\n")}\n`);
  }

  /** The file named by variable `name`, or `fallback`, relative to the directory of the run. */
  protected path(name: string, fallback: string): string {
    const file = this.env[name]?.trim() || fallback;
    return isAbsolute(file) ? file : join(this.directory, file);
  }
}

/** The variable holding an input: "history-branch" is read from NOTMYFAULT_HISTORY_BRANCH. */
export function variable(name: string): string {
  return `NOTMYFAULT_${name.toUpperCase().replace(/-/g, "_")}`;
}
