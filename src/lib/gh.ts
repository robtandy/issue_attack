// GitHub CLI wrappers. All gh calls resolve the repository from the git remote
// of the working directory unless an explicit repo is passed.

import { must, exec, ExecOptions } from "./exec.js";

interface RepoInfo {
  nameWithOwner: string;
  defaultBranch: string;
}

interface RepoViewOutput {
  nameWithOwner: string;
  defaultBranchRef?: {
    name: string;
  };
}

let cachedRepo: RepoInfo | null = null;

/** Resolve {nameWithOwner, defaultBranch} for the repo at root (cached). */
export async function repoInfo(root: string, explicitRepo?: string): Promise<RepoInfo> {
  if (explicitRepo) {
    const out = await must("gh", [
      "repo",
      "view",
      explicitRepo,
      "--json",
      "nameWithOwner,defaultBranchRef",
    ]);
    const j = JSON.parse(out) as RepoViewOutput;
    return {
      nameWithOwner: j.nameWithOwner,
      defaultBranch: j.defaultBranchRef?.name ?? "main",
    };
  }
  if (cachedRepo) return cachedRepo;
  const out = await must("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], {
    cwd: root,
  });
  const j = JSON.parse(out) as RepoViewOutput;
  cachedRepo = {
    nameWithOwner: j.nameWithOwner,
    defaultBranch: j.defaultBranchRef?.name ?? "main",
  };
  return cachedRepo;
}

/** Current gh user login (cached per process). Under a pinned account this
 * resolves through GH_TOKEN set in the process environment. */
let cachedUser: string | null = null;
export async function currentUser(): Promise<string> {
  if (cachedUser) return cachedUser;
  const out = await must("gh", ["api", "user", "--jq", ".login"]);
  cachedUser = out.trim();
  return cachedUser;
}

interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

interface IssueRecord {
  number: number;
  title: string;
  body: string;
  state: string;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  comments?: Array<{ id: number; body: string }>;
  author?: { login: string };
  updatedAt?: string;
  url: string;
  html_url: string;
  id: number;
}

/** Create an issue; returns the REST issue object (number, html_url, …). */
export async function createIssue(
  root: string,
  repo: string,
  { title, body, labels }: CreateIssueInput
): Promise<IssueRecord> {
  const out = await must(
    "gh",
    ["api", `repos/${repo}/issues`, "--input", "-"],
    { cwd: root, input: JSON.stringify({ title, body: body ?? "", labels: labels ?? [] }) }
  );
  return JSON.parse(out) as IssueRecord;
}

/** Full issue record incl. comments. */
export async function viewIssue(root: string, repo: string, number: number): Promise<IssueRecord> {
  const out = await must("gh", [
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,state,labels,assignees,comments,author,updatedAt,url",
  ]);
  return JSON.parse(out) as IssueRecord;
}

/** PRs and issues share a numbering space; `run` must refuse PR numbers. */
export async function isPullRequest(root: string, repo: string, number: number): Promise<boolean> {
  const { code } = await exec("gh", ["pr", "view", String(number), "-R", repo], {
    cwd: root,
    timeoutMs: 30_000,
  });
  return code === 0;
}

interface ListIssueRecord {
  number: number;
  title: string;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  updatedAt?: string;
}

/** Open issues with a label, newest-updated last (oldest work first). */
export async function listIssues(
  root: string,
  repo: string,
  label?: string,
  limit = 100
): Promise<ListIssueRecord[]> {
  const args = [
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--json",
    "number,title,labels,assignees,updatedAt",
    "--limit",
    String(limit),
  ];
  if (label) args.push("--label", label);
  const out = await must("gh", args, { cwd: root });
  const issues = JSON.parse(out) as ListIssueRecord[];
  issues.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  return issues;
}

/** Idempotently create a repo label. */
export async function ensureLabel(
  root: string,
  repo: string,
  name: string,
  color: string,
  description: string
): Promise<void> {
  const { code, stderr } = await exec(
    "gh",
    ["label", "create", name, "-R", repo, "--color", color, "--description", description],
    { cwd: root }
  );
  if (code !== 0 && !/already exists/i.test(stderr)) {
    throw new Error(`gh label create ${name}: ${stderr.trim()}`);
  }
}

interface EditIssueInput {
  issue?: IssueRecord;
  addLabels?: string[];
  removeLabels?: string[];
  addAssignee?: string;
  removeAssignee?: string;
}

/**
 * Edit issue labels/assignees. When an issue record is provided, removals are
 * filtered to labels/assignees that are actually present (gh errors otherwise).
 */
export async function editIssue(
  root: string,
  repo: string,
  number: number,
  { issue, addLabels, removeLabels, addAssignee, removeAssignee }: EditIssueInput
): Promise<void> {
  let removeL = removeLabels ?? [];
  let removeA = removeAssignee;
  if (issue) {
    const presentLabels = new Set((issue.labels ?? []).map((l) => l.name));
    removeL = removeL.filter((l) => presentLabels.has(l));
    const presentAssignees = new Set((issue.assignees ?? []).map((a) => a.login));
    if (removeA && !presentAssignees.has(removeA)) removeA = undefined;
  }
  const args = ["issue", "edit", String(number), "-R", repo];
  if (addLabels?.length) args.push("--add-label", addLabels.join(","));
  if (removeL.length) args.push("--remove-label", removeL.join(","));
  if (addAssignee) args.push("--add-assignee", addAssignee);
  if (removeA) args.push("--remove-assignee", removeA);
  await must("gh", args, { cwd: root, timeoutMs: 30_000 });
}

/** Create an issue comment with an arbitrary-size body. Returns comment id. */
export async function createComment(
  root: string,
  repo: string,
  number: number,
  body: string
): Promise<number> {
  const out = await must(
    "gh",
    ["api", `repos/${repo}/issues/${number}/comments`, "--input", "-"],
    { cwd: root, input: JSON.stringify({ body }) }
  );
  return JSON.parse(out).id as number;
}

/** Edit an existing comment. */
export async function editComment(
  root: string,
  repo: string,
  commentId: number,
  body: string
): Promise<void> {
  await must(
    "gh",
    ["api", `repos/${repo}/issues/comments/${commentId}`, "-X", "PATCH", "--input", "-"],
    { cwd: root, input: JSON.stringify({ body }) }
  );
}

/** Delete a comment (used to remove the ephemeral status comment when a run ends). */
export async function deleteComment(root: string, repo: string, commentId: number): Promise<void> {
  await must("gh", ["api", `-X`, "DELETE", `repos/${repo}/issues/comments/${commentId}`], {
    cwd: root,
  });
}

interface CommentRecord {
  body?: string;
  id: number;
}

/** Find the agent status comment (marked via hidden HTML) from an issue record. */
export function findStatusComment(issueRecord: IssueRecord): CommentRecord | null {
  const marker = "<!-- issue_attack:status -->";
  const matches = (issueRecord.comments ?? []).filter((cm) => (cm.body ?? "").startsWith(marker));
  return matches.length ? matches[matches.length - 1] : null;
}

interface PullRequest {
  number: number;
  url: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
}

/** PRs whose head is branch. */
export async function prsForBranch(root: string, repo: string, branch: string): Promise<PullRequest[]> {
  const out = await must(
    "gh",
    [
      "pr",
      "list",
      "-R",
      repo,
      "--head",
      branch,
      "--json",
      "number,url,state,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus",
    ],
    { cwd: root }
  );
  return JSON.parse(out) as PullRequest[];
}

interface PrViewRecord {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
}

/** View one PR by number (title, body, state). */
export async function viewPr(root: string, repo: string, number: number): Promise<PrViewRecord> {
  const out = await must(
    "gh",
    ["pr", "view", String(number), "-R", repo, "--json", "number,title,body,state,url"],
    { cwd: root }
  );
  return JSON.parse(out) as PrViewRecord;
}

interface EditPrInput {
  title?: string;
  body?: string;
}

/** Edit a PR's title and/or body. */
export async function editPr(
  root: string,
  repo: string,
  number: number,
  { title, body }: EditPrInput
): Promise<void> {
  const args = ["pr", "edit", String(number), "-R", repo];
  if (title !== undefined) args.push("--title", title);
  if (body !== undefined) args.push("--body", body);
  await must("gh", args, { cwd: root, timeoutMs: 60_000 });
}

export async function addPrLabel(root: string, repo: string, prNumber: number, label: string): Promise<boolean> {
  const { code, stderr } = await exec(
    "gh",
    ["pr", "edit", String(prNumber), "-R", repo, "--add-label", label],
    { cwd: root }
  );
  if (code !== 0 && /label/i.test(stderr)) return false;
  if (code !== 0) throw new Error(stderr.trim());
  return true;
}

export async function ghAuthOk(root: string): Promise<boolean> {
  const { code } = await exec("gh", ["auth", "status"], { cwd: root, timeoutMs: 15_000 });
  return code === 0;
}
