import type {
  ChangedFile,
  GitClient,
  GitHost,
  IssueComment,
  NewInlineComment,
  PullRequest,
  PullRequestFile,
  RemoteInstallation,
  RemoteRepo,
  ReviewComment,
} from "@/lib/git/types";

interface FakePr {
  pr: PullRequest;
  files: PullRequestFile[];
  /** File contents at the PR head, keyed by path. */
  head: Record<string, string>;
}

/** In-memory git host that records every write, for tests. */
export class FakeGitHost implements GitHost {
  readonly provider = "github";
  installations = new Map<number, RemoteInstallation & { repos: RemoteRepo[] }>();
  cloneUrls = new Map<string, string>();
  prs = new Map<string, FakePr>();
  compares = new Map<string, ChangedFile[]>();
  issueComments = new Map<string, IssueComment[]>();
  reviewComments = new Map<string, ReviewComment[]>();
  reviews: { repo: string; number: number; commitId: string; body: string; comments: NewInlineComment[] }[] = [];
  /** Optional source of file contents at any ref (e.g. backed by a fixture git repo). */
  contentAt?: (repo: string, path: string, ref: string) => string | null;
  private nextId = 1000;

  addInstallation(id: number, accountLogin: string, repos: RemoteRepo[]) {
    this.installations.set(id, { id, accountLogin, repos });
  }

  addPr(repo: string, pr: FakePr) {
    this.prs.set(`${repo}#${pr.pr.number}`, pr);
  }

  async getInstallation(id: number) {
    const i = this.installations.get(id);
    if (!i) throw new Error(`no installation ${id}`);
    return { id: i.id, accountLogin: i.accountLogin };
  }

  async listInstallationRepos(id: number) {
    return this.installations.get(id)?.repos ?? [];
  }

  client(): GitClient {
    const id = () => this.nextId++;
    const key = (repo: string, n: number) => `${repo}#${n}`;
    const pr = (repo: string, n: number) => {
      const p = this.prs.get(key(repo, n));
      if (!p) throw new Error(`no PR ${key(repo, n)}`);
      return p;
    };
    return {
      cloneUrl: async (repo) => {
        const url = this.cloneUrls.get(repo);
        if (!url) throw new Error(`no clone url for ${repo}`);
        return url;
      },
      getPullRequest: async (repo, n) => pr(repo, n).pr,
      listPullRequestFiles: async (repo, n) => pr(repo, n).files,
      getFileContent: async (repo, path, ref) => {
        for (const p of this.prs.values()) if (p.pr.headSha === ref && path in p.head) return p.head[path]!;
        return this.contentAt?.(repo, path, ref) ?? null;
      },
      compareCommits: async (repo, base, head) => this.compares.get(`${repo}@${base}...${head}`) ?? [],
      listIssueComments: async (repo, n) => this.issueComments.get(key(repo, n)) ?? [],
      createIssueComment: async (repo, n, body) => {
        const c = { id: id(), body, author: "tracewise[bot]" };
        this.issueComments.set(key(repo, n), [...(this.issueComments.get(key(repo, n)) ?? []), c]);
        return c;
      },
      updateIssueComment: async (repo, commentId, body) => {
        for (const list of this.issueComments.values()) {
          const c = list.find((x) => x.id === commentId);
          if (c) {
            c.body = body;
            return c;
          }
        }
        throw new Error(`no comment ${commentId}`);
      },
      listReviewComments: async (repo, n) => this.reviewComments.get(key(repo, n)) ?? [],
      createReview: async (repo, n, review) => {
        this.reviews.push({ repo, number: n, ...review });
        const posted = review.comments.map((c) => ({ id: id(), path: c.path, line: c.line, body: c.body, author: "tracewise[bot]" }));
        this.reviewComments.set(key(repo, n), [...(this.reviewComments.get(key(repo, n)) ?? []), ...posted]);
        return { id: id(), comments: posted };
      },
    };
  }
}
