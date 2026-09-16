export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`GitHub API ${status} on ${path}: ${body.slice(0, 200)}`);
  }
}

interface IssueComment {
  id: number;
  body?: string;
}

/** Minimal REST client for the few endpoints the action needs. */
export class GitHubClient {
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
    await this.request("POST", `/repos/${this.repository}/issues/${issue}/comments`, { body });
    return "created";
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
    if (!response.ok) throw new GitHubApiError(response.status, path, await response.text());
    return response;
  }
}

function nextPage(link: string | null, apiUrl: string): string | undefined {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match?.[1]) return undefined;
  return match[1].startsWith(apiUrl) ? match[1].slice(apiUrl.length) : undefined;
}
