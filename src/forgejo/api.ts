import { samePage } from "../github/api";
import { ApiError, type Forge, type Issue } from "../platform";

interface IssueItem {
  number: number;
  state: "open" | "closed";
  body?: string | null;
}

/**
 * Minimal client for the API of Forgejo and Gitea, which follows the GitHub
 * one for comments, but names labels by id and has no checks.
 */
export class ForgejoClient implements Forge {
  constructor(
    private readonly token: string,
    private readonly apiUrl: string,
    private readonly repository: string,
  ) {}

  async upsertComment(issue: number, marker: string, body: string, create: boolean): Promise<"created" | "updated" | "skipped"> {
    const comments = await this.list<{ id: number; body?: string }>(`/repos/${this.repository}/issues/${issue}/comments?limit=50`);
    const existing = comments.find((comment) => comment.body?.startsWith(marker));
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

  async listIssues(label: string): Promise<Issue[]> {
    const items = await this.list<IssueItem>(`/repos/${this.repository}/issues?labels=${encodeURIComponent(label)}&state=all&type=issues&limit=50`);
    return items.map((item) => ({ number: item.number, state: item.state, body: item.body ?? "" }));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const known = await this.labels();
    const ids = labels.map((name) => known.find((label) => label.name === name)?.id).filter((id) => id !== undefined);
    const response = await this.request("POST", `/repos/${this.repository}/issues`, { title, body, labels: ids });
    return ((await response.json()) as IssueItem).number;
  }

  async updateIssue(issue: number, changes: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void> {
    await this.request("PATCH", `/repos/${this.repository}/issues/${issue}`, changes);
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    if ((await this.labels()).some((label) => label.name === name)) return;
    await this.request("POST", `/repos/${this.repository}/labels`, { name, color: `#${color}`, description });
  }

  async assign(issue: number, users: string[]): Promise<void> {
    await this.request("PATCH", `/repos/${this.repository}/issues/${issue}`, { assignees: users });
  }

  async deletedFiles(pull: number): Promise<string[]> {
    const files = await this.list<{ filename: string; status: string }>(`/repos/${this.repository}/pulls/${pull}/files?limit=50`);
    return files.filter((file) => file.status === "deleted" || file.status === "removed").map((file) => file.filename);
  }

  async changeOf(sha: string): Promise<{ number: number; url: string } | undefined> {
    try {
      const response = await this.request("GET", `/repos/${this.repository}/commits/${sha}/pull`);
      const pull = (await response.json()) as { number: number; html_url: string; merged: boolean };
      return pull.merged ? { number: pull.number, url: pull.html_url } : undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async labels(): Promise<{ id: number; name: string }[]> {
    return this.list(`/repos/${this.repository}/labels?limit=50`);
  }

  private async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const response = await this.request("GET", next);
      items.push(...((await response.json()) as T[]));
      const link = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      next = link ? samePage(link, this.apiUrl) : undefined;
    }
    return items;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `token ${this.token}`,
        "User-Agent": "notmyfault",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ApiError(response.status, path, await response.text(), "Forgejo");
    return response;
  }
}
