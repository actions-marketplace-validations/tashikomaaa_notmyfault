/**
 * What notmyfault needs from the CI system it runs in. The analysis, the
 * history and the reports are the same everywhere; how inputs are read, how
 * results are shown and which API comments go through depend on the platform.
 */

/** Where a run happens. */
export interface RunContext {
  /** `owner/repo` on GitHub, `group/project` on GitLab. */
  repository: string;
  /** How the API names the repository: `owner/repo` on GitHub, the project id on GitLab. */
  apiProject: string;
  serverUrl: string;
  apiUrl: string;
  sha: string;
  /** The branch the run is on, unless it runs for a pull or merge request. */
  branch: string | undefined;
  /** Identifies the run in history commits, e.g. "run 42, attempt 2". */
  runDescription: string;
  runUrl: string | undefined;
  workspace: string;
  tempDir: string | undefined;
  defaultBranch: string | undefined;
  /** Key of the history when none is set. */
  defaultKey: string;
  /** The pull or merge request the run is for. */
  pullRequest: { number: number; fromFork: boolean } | undefined;
  /** A token the platform gives every job, used when none is set. */
  defaultToken: string | undefined;
}

export type AnnotationLevel = "error" | "warning" | "notice";

/** Inputs, outputs and messages of a run. */
export interface Io {
  input(name: string, fallback?: string): string;
  booleanInput(name: string, fallback: boolean): boolean;
  integerInput(name: string, fallback: number, min: number): number;
  /** How messages name an input: `"junit"` or `NOTMYFAULT_JUNIT`. */
  inputName(name: string): string;
  /** `Input "junit"` or `Variable NOTMYFAULT_JUNIT`. */
  describeInput(name: string): string;
  /** `Inputs "junit" and "key"` or `Variables NOTMYFAULT_JUNIT and NOTMYFAULT_KEY`. */
  describeInputs(names: string[]): string;
  setOutput(name: string, value: string | number | boolean): void;
  appendSummary(markdown: string): void;
  mask(secret: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  group(title: string): void;
  endGroup(): void;
  annotation(level: AnnotationLevel, message: string, properties: Record<string, string | number | undefined>): void;
  /** Writes what was collected during the run, once it is over. */
  finish(): void;
}

export interface Issue {
  number: number;
  state: "open" | "closed";
  body: string;
}

/** Comments and issues, through the API of the platform. */
export interface Forge {
  /** Updates the comment of a pull or merge request carrying `marker`, or creates one when `create` is true. */
  upsertComment(pullRequest: number, marker: string, body: string, create: boolean): Promise<"created" | "updated" | "skipped">;
  /** Comments on an issue. */
  addComment(issue: number, body: string): Promise<void>;
  /** Issues, open or closed, carrying `label`. */
  listIssues(label: string): Promise<Issue[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  updateIssue(issue: number, changes: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void>;
  /** Creates the label unless it exists. `color` is a hexadecimal color without `#`. */
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  /** The merged pull or merge request a commit of a tracked branch came from, if any. */
  changeOf(sha: string): Promise<{ number: number; url: string } | undefined>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
    platform: string,
  ) {
    super(`${platform} API ${status} on ${path}: ${body.slice(0, 200)}`);
  }

  /** The token is missing a permission, a scope or a role. */
  get denied(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** The wording that differs from one platform to the other. */
export interface PlatformText {
  /** "pull request" or "merge request". */
  pullRequest: string;
  /** How references to a pull or merge request start: "#" or "!". */
  changePrefix: string;
  /** Label of the link to the run, at the bottom of reports: "Workflow run". */
  runLink: string;
  /** The run in a sentence: "workflow run". */
  runName: string;
  tokenMissing: string;
  recordDenied: string;
  commentDenied: string;
  commentFromFork: string;
  issuesDenied: string;
}

export interface Platform {
  name: "github" | "gitlab";
  context: RunContext;
  io: Io;
  forge(token: string): Forge;
  /** User name sent with the token to push the history over HTTPS. */
  gitUser(token: string): string;
  /** Author of history commits. */
  gitAuthor: { name: string; email: string };
  /** Link to a commit of the repository. */
  commitUrl(sha: string): string;
  /** Options sent with history pushes. */
  pushOptions: string[];
  text: PlatformText;
  /** Whether a companion workflow can read a notice to re-run flaky failures. */
  rerunNotice: boolean;
}
