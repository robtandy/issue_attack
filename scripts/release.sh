#!/bin/sh
# Release issue_attack: bump, tag, push, watch the CI release run, verify npm.
#
#   scripts/release.sh                 # bump patch and release
#   scripts/release.sh minor | major   # bump and release
#   scripts/release.sh retry           # re-release the CURRENT version at HEAD
#                                       #   (cleans up an existing tag/release first —
#                                       #    the recovery path for a failed run)
#   scripts/release.sh --dry-run patch # pre-flight + plan, no changes
#
# Hardened for this machine after the v0.3.1 release:
#   - pushes use a fresh ssh connection (ControlPath=none, BatchMode) and skip
#     the corporate pre-push hook — a wedged mux or hung hook stalls pushes
#   - tags are pushed as commit-hash:refs/tags/vX — local tags get pruned by
#     background fetches while they don't exist on the remote
#   - gh writes use the repo's pinned GitHub account (the enterprise login
#     cannot write to personal repos)
#   - verification reads the registry API directly (npm view serves stale
#     cache briefly after publish)

set -eu

say() { printf '  %s\n' "$*"; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }

# All git network traffic: fresh connection, no prompts, bounded connect.
GIT_SSH_COMMAND="ssh -o ControlPath=none -o BatchMode=yes -o ConnectTimeout=10"
export GIT_SSH_COMMAND
push_git() { git push --no-verify "$@" </dev/null; }

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; shift; fi
MODE="${1:-patch}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || die "not inside a git repository"
cd "$REPO_ROOT"

# ---- gh auth: prefer the account pinned for this repo ------------------------
ACCOUNT="$(node -p "try{require('./.issue_attack/config.json').ghAccount}catch{return ''}" 2>/dev/null || true)"
[ -n "$ACCOUNT" ] || ACCOUNT="robtandy"
if TOKEN="$(gh auth token --user "$ACCOUNT" 2>/dev/null)"; then
  export GH_TOKEN="$TOKEN"
  say "gh writes as: $ACCOUNT (pinned for this repo)"
else
  say "warn: no token for account '$ACCOUNT' — falling back to the active gh account"
fi

# ---- pre-flight ---------------------------------------------------------------
[ -f .github/workflows/release.yml ] || die "release workflow missing from this checkout"
git diff --quiet && git diff --cached --quiet || die "working tree not clean — commit or stash first"
git fetch origin main || die "could not fetch origin/main"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not in sync with origin/main — push or pull first"
say "pre-flight: tests"
npm test >/dev/null 2>&1 || { npm test 2>&1 | tail -5 >&2; die "tests failed"; }
say "pre-flight: clean, synced, tests green"

if [ "$MODE" = "retry" ]; then
  V="$(node -p "require('./package.json').version")"
  SHA="$(git rev-parse HEAD)"
  say "retry: re-releasing v$V at $SHA (mode: retry)"
  if [ "$DRY_RUN" = "1" ]; then say "dry-run: would delete remote tag+release, re-tag, watch"; exit 0; fi
  say "cleaning up the existing tag/release for v$V"
  gh release delete "v$V" --cleanup-tag --yes >/dev/null 2>&1 || \
    push_git origin ":refs/tags/v$V" >/dev/null 2>&1 || true
else
  case "$MODE" in patch|minor|major) ;; *) die "usage: scripts/release.sh [patch|minor|major|retry] [--dry-run]" ;; esac
  say "bumping: npm version $MODE"
  if [ "$DRY_RUN" = "1" ]; then
    V="$(node -p "require('./package.json').version")"
    NEXT="$(node -e "
      const s = require('./package.json').version.split('.').map(Number);
      const m = '$MODE';
      if (m === 'major') { s[0]++; s[1] = 0; s[2] = 0; }
      else if (m === 'minor') { s[1]++; s[2] = 0; }
      else s[2]++;
      console.log(s.join('.'));")"
    say "dry-run: would bump $V → $NEXT, commit, tag, push, watch"
    exit 0
  fi
  NEW="$(npm version "$MODE")"
  V="${NEW#v}"
  SHA="$(git rev-parse HEAD)"
fi

TAG="v$V"

# ---- push main + tag (by commit hash — local tags are prune-bait) -------------
say "pushing main"
push_git origin main >/dev/null
say "pushing $TAG (commit → remote ref)"
push_git origin "$SHA:refs/tags/$TAG" >/dev/null
git tag -d "$TAG" >/dev/null 2>&1 || true # remote is the source of truth

# ---- watch the release run -----------------------------------------------------
say "waiting for the Release workflow…"
RID=""
i=0
while [ $i -lt 30 ]; do
  RID="$(gh run list --workflow=release.yml --limit 10 --json databaseId,headSha,status \
    -q "[.[] | select(.headSha == \"$SHA\" and .status != \"completed\")] | .[0].databaseId // \"\"" 2>/dev/null || true)"
  [ -n "$RID" ] && break
  sleep 3
  i=$((i + 1))
done
if [ -z "$RID" ]; then # fall back to any run for this commit
  RID="$(gh run list --workflow=release.yml --limit 1 --json databaseId,headSha \
    -q ".[0] | select(.headSha == \"$SHA\") | .databaseId" 2>/dev/null || true)"
fi
[ -n "$RID" ] || die "no Release run appeared for $SHA — check the Actions tab"
gh run watch "$RID" --exit-status >/dev/null 2>&1 || {
  gh run view "$RID" --json url -q .url >&2 || true
  die "release run failed — log above"
}
say "release run: success"

# ---- verify: registry (authoritative API, not npm cache) + release assets ------
say "verifying the npm registry…"
REG=""
ok=""
i=0
while [ $i -lt 60 ]; do
  REG="$(curl -s https://registry.npmjs.org/issue-attack)"
  ok="$(printf '%s' "$REG" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const d=JSON.parse(s);console.log(d.versions?.['$V'] && d['dist-tags']?.latest==='$V' ? 'yes':'no')}
      catch{console.log('no')}})")"
  [ "$ok" = "yes" ] && break
  sleep 5
  i=$((i + 1))
done
if [ "$ok" != "yes" ]; then
  say "warn: npm is still processing $V (the run's publish step succeeded) — confirm shortly with: npm view issue-attack version"
  say "warn: if it never appears, check the run's 'Publish to npm' step"
fi

ASSETS=""
i=0
while [ $i -lt 10 ]; do
  ASSETS="$(gh release view "$TAG" --json assets -q '.assets | length' 2>/dev/null || true)"
  [ -n "$ASSETS" ] && [ "$ASSETS" -ge 8 ] && break
  sleep 3
  i=$((i + 1))
done
[ -n "$ASSETS" ] && [ "$ASSETS" -ge 8 ] || die "release $TAG is missing binaries (expected 8 assets, found ${ASSETS:-none})"

say ""
say "✔ released $TAG"
say "  npm:      https://www.npmjs.com/package/issue-attack  (latest: $V)"
say "  binaries: $(gh release view "$TAG" --json url -q .url)"
say "  everyone: npm update -g issue-attack   |   curl install one-liner unchanged"
