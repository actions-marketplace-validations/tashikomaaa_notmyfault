import { ApiError, type Forge, type Issue } from "../platform";

interface Note {
  id: number;
  body?: string;
  system?: boolean;
}

interface IssueItem {
  iid: number;
  state: "opened" | "closed";
  description?: string | null;
}

/** Minimal client for the GitLab REST API: merge request notes, issues and labels. */
export class GitLabClient implements Forge {
  constructor(
    private readonly token: string,
    private readonly apiUrl: string,
    /** Project id, or URL-encoded path. */
    private readonly project: string,
    /** CI_JOB_TOKEN goes in another header, and can do much less. */
    private readonly jobToken = false,
  ) {}

  async upsertComment(mergeRequest: number, marker: string, body: string, create: boolean): Promise<"created" | "updated" | "skipped"> {
    const notes = `/projects/${this.project}/merge_requests/${mergeRequest}/notes`;
    const existing = (await this.list<Note>(`${notes}?per_page=100&sort=asc&order_by=created_at`)).find(
      (note) => !note.system && note.body?.startsWith(marker),
    );
    if (existing) {
      await this.request("PUT", `${notes}/${existing.id}`, { body });
      return "updated";
    }
    if (!create) return "skipped";
    await this.request("POST", notes, { body });
    return "created";
  }

  async addComment(issue: number, body: string): Promise<void> {
    await this.request("POST", `/projects/${this.project}/issues/${issue}/notes`, { body });
  }

  async listIssues(label: string): Promise<Issue[]> {
    const items = await this.list<IssueItem>(`/projects/${this.project}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100`);
    return items.map((item) => ({
      number: item.iid,
      state: item.state === "opened" ? "open" : "closed",
      body: item.description ?? "",
    }));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    const response = await this.request("POST", `/projects/${this.project}/issues`, {
      title,
      description: body,
      labels: labels.join(","),
    });
    return ((await response.json()) as IssueItem).iid;
  }

  async updateIssue(issue: number, changes: { title?: string; body?: string; state?: "open" | "closed" }): Promise<void> {
    await this.request("PUT", `/projects/${this.project}/issues/${issue}`, {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.body !== undefined ? { description: changes.body } : {}),
      ...(changes.state ? { state_event: changes.state === "open" ? "reopen" : "close" } : {}),
    });
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.request("GET", `/projects/${this.project}/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      await this.request("POST", `/projects/${this.project}/labels`, { name, color: `#${color}`, description });
    }
  }

  async changeOf(sha: string): Promise<{ number: number; url: string } | undefined> {
    const response = await this.request("GET", `/projects/${this.project}/repository/commits/${sha}/merge_requests`);
    const requests = (await response.json()) as { iid: number; web_url: string; state: string; merge_commit_sha: string | null; squash_commit_sha: string | null }[];
    const merged = requests.filter((request) => request.state === "merged");
    const request = merged.find((candidate) => candidate.merge_commit_sha === sha || candidate.squash_commit_sha === sha) ?? merged[0];
    return request && { number: request.iid, url: request.web_url };
  }

  private async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const response = await this.request("GET", next);
      items.push(...((await response.json()) as T[]));
      const link = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      next = link?.startsWith(this.apiUrl) ? link.slice(this.apiUrl.length) : undefined;
    }
    return items;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        [this.jobToken ? "JOB-TOKEN" : "PRIVATE-TOKEN"]: this.token,
        "User-Agent": "notmyfault",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ApiError(response.status, path, await response.text(), "GitLab");
    return response;
  }
}
