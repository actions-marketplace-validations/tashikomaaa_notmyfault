import { ApiError, type CheckReport, type Forge, type Issue } from "../platform";

interface IssueComment {
  id: number;
  body?: string;
}

interface IssueItem {
  number: number;
  state: "open" | "closed";
  body?: string | null;
  pull_request?: unknown;
}

/** Minimal REST client for the few endpoints the action needs. */
export class GitHubClient implements Forge {
  constructor(
    private readonly token: string,
    private readonly apiUrl: string,
    private readonly repository: string,
  ) {}

  /**
   * Updates the comment carrying `marker`, or creates one when `create` is true.
   * Resolves to what happened.
   */
  async upsertComment(
    issue: number,
    marker: string,
    body: string,
    create: boolean,
  ): Promise<"created" | "updated" | "skipped"> {
    const existing = await this.findComment(issue, marker);
    if (existing) {
      await this.request("PATCH", `/repos/${this.repository}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    if (!create) return "skipped";
    await this.addComment(issue, body);
    return "created";
  }

  async addComment(issue: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${this.repository}/issues/${issue}/comments`, { body });
  }

  /** Issues, open or closed, carrying `label`. Pull requests are left out. */
  async listIssues(label: string): Promise<Issue[]> {
    const issues: Issue[] = [];
    let path: string | undefined = `/repos/${this.repository}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`;
    while (path) {
      const response = await this.request("GET", path);
      for (const item of (await response.json()) as IssueItem[]) {
        if (!item.pull_request) issues.push({ number: item.number, state: item.state, body: item.body ?? "" });
      }
      path = nextPage(response.headers.get("link"), this.apiUrl);
    }
    return issues;
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const response = await this.request("POST", `/repos/${this.repository}/issues`, { title, body, labels });
    return ((await response.json()) as { number: number }).number;
  }

  async updateIssue(issue: number, changes: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void> {
    await this.request("PATCH", `/repos/${this.repository}/issues/${issue}`, changes);
  }

  /** Creates the label unless it exists. */
  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.request("GET", `/repos/${this.repository}/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      await this.request("POST", `/repos/${this.repository}/labels`, { name, color, description });
    }
  }

  async changeOf(sha: string): Promise<{ number: number; url: string } | undefined> {
    const response = await this.request("GET", `/repos/${this.repository}/commits/${sha}/pulls?per_page=100`);
    const pulls = (await response.json()) as { number: number; html_url: string; merged_at: string | null; merge_commit_sha: string | null }[];
    const merged = pulls.filter((pull) => pull.merged_at !== null);
    const pull = merged.find((candidate) => candidate.merge_commit_sha === sha) ?? merged[0];
    return pull && { number: pull.number, url: pull.html_url };
  }

  async deletedFiles(pull: number): Promise<string[]> {
    const deleted: string[] = [];
    let path: string | undefined = `/repos/${this.repository}/pulls/${pull}/files?per_page=100`;
    while (path) {
      const response = await this.request("GET", path);
      for (const file of (await response.json()) as { filename: string; status: string }[]) {
        if (file.status === "removed") deleted.push(file.filename);
      }
      path = nextPage(response.headers.get("link"), this.apiUrl);
    }
    return deleted;
  }

  async createCheck(check: CheckReport): Promise<string> {
    const response = await this.request("POST", `/repos/${this.repository}/check-runs`, {
      name: check.name,
      head_sha: check.sha,
      status: "completed",
      conclusion: check.success ? "success" : "failure",
      completed_at: new Date().toISOString(),
      ...(check.detailsUrl ? { details_url: check.detailsUrl } : {}),
      output: { title: check.title, summary: check.summary },
    });
    return ((await response.json()) as { html_url: string }).html_url;
  }

  private async findComment(issue: number, marker: string): Promise<IssueComment | undefined> {
    let path: string | undefined = `/repos/${this.repository}/issues/${issue}/comments?per_page=100`;
    while (path) {
      const response = await this.request("GET", path);
      const comments = (await response.json()) as IssueComment[];
      const match = comments.find((comment) => comment.body?.startsWith(marker));
      if (match) return match;
      path = nextPage(response.headers.get("link"), this.apiUrl);
    }
    return undefined;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "notmyfault",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ApiError(response.status, path, await response.text(), "GitHub");
    return response;
  }
}

function nextPage(link: string | null, apiUrl: string): string | undefined {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match?.[1]) return undefined;
  return match[1].startsWith(apiUrl) ? match[1].slice(apiUrl.length) : undefined;
}
