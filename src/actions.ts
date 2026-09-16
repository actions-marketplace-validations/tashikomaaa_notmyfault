import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";

/** Tiny replacement for @actions/core, driven by an injectable environment. */
export class ActionIO {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + EOL),
  ) {}

  input(name: string, fallback = ""): string {
    const value = this.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
    return value === undefined || value.trim() === "" ? fallback : value.trim();
  }

  booleanInput(name: string, fallback: boolean): boolean {
    const value = this.input(name).toLowerCase();
    if (value === "") return fallback;
    if (["true", "yes", "on", "1"].includes(value)) return true;
    if (["false", "no", "off", "0"].includes(value)) return false;
    throw new Error(`Input "${name}" must be a boolean, got "${value}"`);
  }

  integerInput(name: string, fallback: number, min: number): number {
    const value = this.input(name);
    if (value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new Error(`Input "${name}" must be an integer >= ${min}, got "${value}"`);
    }
    return parsed;
  }

  setOutput(name: string, value: string | number | boolean): void {
    const file = this.env.GITHUB_OUTPUT;
    if (!file) return;
    const delimiter = `notmyfault_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
  }

  appendSummary(markdown: string): void {
    const file = this.env.GITHUB_STEP_SUMMARY;
    if (file) appendFileSync(file, markdown + EOL);
  }

  mask(secret: string): void {
    if (secret) this.command("add-mask", secret);
  }

  info(message: string): void {
    this.write(message);
  }

  warning(message: string): void {
    this.command("warning", message);
  }

  error(message: string): void {
    this.command("error", message);
  }

  /** A workflow annotation on a file, shown in the run summary and next to the code of pull requests. */
  annotation(level: "error" | "warning" | "notice", message: string, properties: Record<string, string | number | undefined>): void {
    const escapeProperty = (value: string) =>
      value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
    const list = Object.entries(properties)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${escapeProperty(String(value))}`)
      .join(",");
    this.command(`${level} ${list}`, message);
  }

  group(title: string): void {
    this.command("group", title);
  }

  endGroup(): void {
    this.write("::endgroup::");
  }

  private command(name: string, message: string): void {
    const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    this.write(`::${name}::${escaped}`);
  }
}
