/*
 * Grasp — agent detection (heuristic, zero-config). Treat results as a lower bound.
 */

export const AGENT_BRANCH = /^(copilot|claude|cursor|devin|codex|gemini|codegen|agent|pr-agent|aider|windsurf|jules|sweep)[\/\-_]/i;
export const AGENT_BODY = /(co-authored-by:[^\n]*(claude|copilot|cursor|devin|codex|gemini|openai|anthropic|assistant))|(generated (with|using|by))|(pair(ed)? with (an? )?(ai|agent|claude|copilot))/i;

const AGENT_NAMES = /(claude|copilot|cursor|devin|codex|gemini|codegen|aider|windsurf|jules|sweep|openai|anthropic)/i;

/* Bots that bump dependencies or tidy files: machine-written, but not "an agent wrote the logic". */
export const DEPENDENCY_BOTS = /^(dependabot|renovate|github-actions|greenkeeper|snyk-bot|pre-commit-ci|mergify|allcontributors|imgbot|depfu)(\[bot\])?$/i;

export function isBotLogin(login, type) {
  return type === 'Bot' || /\[bot\]$/i.test(login || '');
}

function nameFrom(text, fallback) {
  const m = AGENT_NAMES.exec(text || '');
  return m ? m[1].toLowerCase() : fallback;
}

/*
 * pr: { user: {login, type}, head: {ref}, body } (GitHub shape) or the cached record
 * shape { author, authorType, headRef, body, commitMessages }.
 * extra: user-configured regex strings, tested against branch, body and commit messages.
 * Returns { markers: string[], name: string|null }.
 */
export function detectAgent(pr, extra = []) {
  const login = pr.author ?? (pr.user && pr.user.login) ?? '';
  const type = pr.authorType ?? (pr.user && pr.user.type);
  const ref = pr.headRef ?? (pr.head && pr.head.ref) ?? '';
  const body = pr.body || '';
  const commits = (pr.commitMessages || []).join('\n');

  const markers = [];
  let name = null;
  if (isBotLogin(login, type) && !DEPENDENCY_BOTS.test(login)) {
    markers.push('bot-account');
    name = nameFrom(login, login.replace(/\[bot\]$/i, ''));
  }
  if (AGENT_BRANCH.test(ref)) {
    const prefix = ref.split(/[\/\-_]/)[0].toLowerCase();
    markers.push('branch:' + prefix);
    name = name || nameFrom(prefix, prefix);
  }
  const bodyHit = AGENT_BODY.exec(body);
  if (bodyHit) { markers.push('trailer-in-body'); name = name || nameFrom(bodyHit[0], 'agent'); }
  const commitHit = AGENT_BODY.exec(commits);
  if (commitHit) { markers.push('trailer-in-commits'); name = name || nameFrom(commitHit[0], 'agent'); }

  for (const src of extra) {
    let re;
    try { re = new RegExp(src, 'i'); } catch { continue; }
    if (re.test(ref) || re.test(body) || re.test(commits)) {
      markers.push('custom:' + src);
      name = name || 'agent';
    }
  }
  return { markers, name };
}
