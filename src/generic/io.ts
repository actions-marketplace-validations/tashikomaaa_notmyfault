import type { AnnotationLevel } from "../platform";
import { VariablesIO } from "../variables-io";

/** Inputs and outputs in any CI system: NOTMYFAULT_* variables, a dotenv file and a Markdown summary. */
export class GenericIO extends VariablesIO {
  constructor(env: NodeJS.ProcessEnv = process.env, write?: (line: string) => void) {
    super(env, write, env.NOTMYFAULT_WORKSPACE ?? process.cwd());
  }

  group(title: string): void {
    this.write(title);
  }

  endGroup(): void {}

  /** The verdict of each failure is already in the log. */
  annotation(_level: AnnotationLevel, _message: string, _properties: Record<string, string | number | undefined>): void {}
}
