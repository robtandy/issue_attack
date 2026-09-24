// GitHub CLI wrappers. All gh calls resolve the repository from the git remote
// of the working directory unless an explicit repo is passed.

import { must, exec } from "./exec.js";

let cachedRepo = null;

/** List all available GitHub accounts (from gh auth status). */
export async function listAccounts(hostname = "github.com") {
  const { code, stdout } = await exec("gh", ["auth", "status", "--hostname", hostname]);
  if (code !== 0) return [];
  
  // Parse accounts from lines like "✓ Logged in to github.com account robtandy (GH_TOKEN)"
  const accounts = [];
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    if (!line.includes("✓ Logged in")) continue;
    const match = line.match(/account ([^ ]+)/);
    if (match && !seen.has(match[1])) {
      accounts.push(match[1]);
      seen.add(match[1]);
    }
  }
  return accounts;
}

/** Resolve {nameWithOwner, defaultBranch} for the repo at root (cached).
 * When the default account fails and tryAccounts is true, tries other logged-in accounts.
 * If an account works, its token is set in process.env.GH_TOKEN for the rest of this process. */
export async function repoInfo(root, explicitRepo, tryAccounts = false) {
  if (explicitRepo) {
    const out = await must("gh", [
      "repo",
      "view",
      explicitRepo,
      "--json",
      "nameWithOwner,defaultBranchRef",
    ]);
    const j = JSON.parse(out);
    return {
      nameWithOwner: j.nameWithOwner,
      defaultBranch: j.defaultBranchRef?.name ?? "main",
    };
  }
  if (cachedRepo) return cachedRepo;
  
  // Try with the current account first
  let result = await tryRepoInfo(root);
  if (result || !tryAccounts) return result;
  
  // Current account failed and tryAccounts is true; try other accounts
  const accounts = await listAccounts();
  for (const account of accounts) {
    const tokenResult = await exec("gh", ["auth", "token", "--user", account]);
    if (tokenResult.code !== 0) continue;
    
    // Found a logged-in account; set its token and try
    const originalToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = tokenResult.stdout.trim();
    
    result = await tryRepoInfo(root);
    if (result) {
      // Success! Keep this token set for the rest of this process.
      return result;
    }
    
    // Restore original token and try next account
    if (originalToken) {
      process.env.GH_TOKEN = originalToken;
    } else {
      delete process.env.GH_TOKEN;
    }
  }
  
  // All accounts failed; throw an error
  throw new Error(`could not access repository with any available GitHub account`);
}

/** Try to get repo info without multi-account fallback. */
async function tryRepoInfo(root) {
  try {
    const out = await must("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], {
      cwd: root,
    });
    const j = JSON.parse(out);
    cachedRepo = {
      nameWithOwner: j.nameWithOwner,
      defaultBranch: j.defaultBranchRef?.name ?? "main",
    };
    return cachedRepo;
  } catch {
    return null;
  }
}

/** Current gh user login (cached per process). Under a pinned account this
 * resolves through GH_TOKEN set in the process environment. */
let cachedUser = null;
export async function currentUser() {
  if (cachedUser) return cachedUser;
  const out = await must("gh", ["api", "user", "--jq", ".login"]);
  cachedUser = out.trim();
  return cachedUser;
}

/** Clear cached repo info and user (e.g., after pinning a new account). */
export function clearRepoCache() {
  cachedRepo = null;
  cachedUser = null;
}

/** Create an issue; returns the REST issue object (number, html_url, …). */
export async function createIssue(root, repo, { title, body, labels }) {
  const out = await must(
    "gh",
    ["api", `repos/${repo}/issues`, "--input", "-"],
    { cwd: root, input: JSON.stringify({ title, body: body ?? "", labels: labels ?? [] }) }
  );
  return JSON.parse(out);
}

/** Full issue record incl. comments. */
export async function viewIssue(root, repo, number) {
  const out = await must("gh", [
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,state,labels,assignees,comments,author,updatedAt,url",
  ]);
  return JSON.parse(out);
}

/** PRs and issues share a numbering space; `run` must refuse PR numbers. */
export async function isPullRequest(root, repo, number) {
  const { code } = await exec("gh", ["pr", "view", String(number), "-R", repo], {
    cwd: root,
    timeoutMs: 30_000,
  });
  return code === 0;
}

/** Open issues with a label, newest-updated last (oldest work first). */
export async function listIssues(root, repo, label, limit = 100) {
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
  const issues = JSON.parse(out);
  issues.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  return issues;
}

/** Idempotently create a repo label. */
export async function ensureLabel(root, repo, name, color, description) {
  const { code, stderr } = await exec(
    "gh",
    ["label", "create", name, "-R", repo, "--color", color, "--description", description],
    { cwd: root }
  );
  if (code !== 0 && !/already exists/i.test(stderr)) {
    throw new Error(`gh label create ${name}: ${stderr.trim()}`);
  }
}

/**
 * Edit issue labels/assignees. When an issue record is provided, removals are
 * filtered to labels/assignees that are actually present (gh errors otherwise).
 */
export async function editIssue(root, repo, number, { issue, addLabels, removeLabels, addAssignee, removeAssignee }) {
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

/** Create an issue comment with an arbitrary-size body.
 *  Returns the comment's GraphQL node id — the id type every comment source
 *  in this module uses (`gh --json comments` emits node ids). */
export async function createComment(root, repo, number, body) {
  const out = await must(
    "gh",
    ["api", `repos/${repo}/issues/${number}/comments`, "--input", "-"],
    { cwd: root, input: JSON.stringify({ body }) }
  );
  return JSON.parse(out).node_id;
}

// Comment mutations go through the GraphQL API: comment ids in this codebase
// are GraphQL node ids (what `gh --json comments` returns), while the REST
// comment endpoints require the numeric database id — mixing the two is the
// "gh: Not Found (HTTP 404)" from issue #46.

const UPDATE_COMMENT_MUTATION =
  "mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}";
const DELETE_COMMENT_MUTATION =
  "mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}";
const ADD_REACTION_MUTATION =
  "mutation($subject:ID!,$content:ReactionContent!){addReaction(input:{subjectId:$subject,content:$content}){reaction{content}}}";

/** gh argv to edit a comment (node id) via GraphQL. */
export function editCommentArgs(commentId, body) {
  return ["api", "graphql", "-f", `query=${UPDATE_COMMENT_MUTATION}`, "-f", `id=${commentId}`, "-f", `body=${body}`];
}

/** gh argv to delete a comment (node id) via GraphQL. */
export function deleteCommentArgs(commentId) {
  return ["api", "graphql", "-f", `query=${DELETE_COMMENT_MUTATION}`, "-f", `id=${commentId}`];
}

/** gh argv to add a reaction to a comment (node id) via GraphQL. */
export function reactionArgs(commentId, emoji) {
  return [
    "api",
    "graphql",
    "-f",
    `query=${ADD_REACTION_MUTATION}`,
    "-f",
    `subject=${commentId}`,
    "-f",
    `content=${String(emoji).toUpperCase()}`,
  ];
}

/** Edit an existing comment. commentId is a GraphQL node id. */
export async function editComment(root, commentId, body) {
  await must("gh", editCommentArgs(commentId, body), { cwd: root, timeoutMs: 30_000 });
}

/** Delete a comment (used to remove the ephemeral status comment when a run ends). */
export async function deleteComment(root, commentId) {
  await must("gh", deleteCommentArgs(commentId), { cwd: root });
}

/** Find the agent status comment (marked via hidden HTML) from an issue record. */
export function findStatusComment(issueRecord) {
  const marker = "<!-- issue_attack:status -->";
  const matches = (issueRecord.comments ?? []).filter((cm) =>
    (cm.body ?? "").startsWith(marker)
  );
  return matches.length ? matches[matches.length - 1] : null;
}

/** PRs whose head is branch. */
export async function prsForBranch(root, repo, branch) {
  const out = await must("gh", [
    "pr",
    "list",
    "-R",
    repo,
    "--head",
    branch,
    "--json",
    "number,url,state,baseRefName,headRefName,isDraft,mergeable,mergeStateStatus",
  ], { cwd: root });
  return JSON.parse(out);
}

/** View one PR by number (title, body, state, comments). */
export async function viewPr(root, repo, number) {
  const out = await must("gh", ["pr", "view", String(number), "-R", repo, "--json", "number,title,body,state,url,comments"], {
    cwd: root,
  });
  return JSON.parse(out);
}

/** Edit a PR's title and/or body. */
export async function editPr(root, repo, number, { title, body }) {
  const args = ["pr", "edit", String(number), "-R", repo];
  if (title !== undefined) args.push("--title", title);
  if (body !== undefined) args.push("--body", body);
  await must("gh", args, { cwd: root, timeoutMs: 60_000 });
}

export async function addPrLabel(root, repo, prNumber, label) {
  const { code, stderr } = await exec(
    "gh",
    ["pr", "edit", String(prNumber), "-R", repo, "--add-label", label],
    { cwd: root }
  );
  if (code !== 0 && /label/i.test(stderr)) return false;
  if (code !== 0) throw new Error(stderr.trim());
  return true;
}

/** Add an emoji reaction to a comment (e.g. "eyes" → 👀). commentId is a
 *  GraphQL node id; the mutation is idempotent when the reaction exists. */
export async function addReactionToComment(root, commentId, emoji) {
  await must("gh", reactionArgs(commentId, emoji), { cwd: root, timeoutMs: 15_000 });
}

export async function ghAuthOk(root) {
  const { code } = await exec("gh", ["auth", "status"], { cwd: root, timeoutMs: 15_000 });
  return code === 0;
}
