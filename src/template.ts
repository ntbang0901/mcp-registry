import { LoadoutError } from './errors.js';
import type { ParamValue, RepoContext, Value } from './types.js';

export const REPO_VARS = ['id', 'root', 'host', 'slug', 'owner', 'name'] as const;

export type ResolvedParam = { kind: 'value'; value: ParamValue } | { kind: 'secret'; env: string } | { kind: 'unset' };

export interface TemplateRef {
  scope: string;
  name: string;
}

const EXPR = /\{\{\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\}\}/g;

/** List `{{ scope.name }}` references; throws on malformed expressions. */
export function templateRefs(tpl: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  const rest = tpl.replace(EXPR, (_m, scope: string, name: string) => {
    refs.push({ scope, name });
    return '';
  });
  if (rest.includes('{{') || rest.includes('}}')) {
    throw new LoadoutError(`Invalid template "${tpl}": only {{ params.<name> }} and {{ repo.<var> }} are supported`);
  }
  for (const r of refs) {
    if (r.scope === 'repo' && !(REPO_VARS as readonly string[]).includes(r.name)) {
      throw new LoadoutError(`Unknown variable {{ repo.${r.name} }} (available: ${REPO_VARS.join(', ')})`);
    }
    if (r.scope !== 'repo' && r.scope !== 'params') {
      throw new LoadoutError(`Unknown template scope "${r.scope}" in "${tpl}"`);
    }
  }
  return refs;
}

/**
 * Render a template into a Value. Returns undefined when it references an optional
 * param that has no value, so the caller can drop the whole entry (arg, env var, header).
 */
export function renderTemplate(tpl: string, repo: RepoContext, params: Map<string, ResolvedParam>): Value | undefined {
  templateRefs(tpl);
  const parts: Value = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') last.value += text;
    else parts.push({ kind: 'text', value: text });
  };
  let cursor = 0;
  let omitted = false;
  for (const m of tpl.matchAll(EXPR)) {
    pushText(tpl.slice(cursor, m.index));
    cursor = m.index! + m[0].length;
    const [, scope, name] = m;
    if (scope === 'repo') {
      pushText(repo[name as (typeof REPO_VARS)[number]]);
      continue;
    }
    const p = params.get(name);
    if (!p) throw new LoadoutError(`Template "${tpl}" references undeclared param "${name}"`);
    if (p.kind === 'unset') omitted = true;
    else if (p.kind === 'secret') parts.push({ kind: 'env', name: p.env });
    else pushText(String(p.value));
  }
  pushText(tpl.slice(cursor));
  return omitted ? undefined : parts;
}

/** Render a template that may only use repo variables (used for param defaults). */
export function renderRepoOnly(tpl: string, repo: RepoContext): string {
  for (const r of templateRefs(tpl)) {
    if (r.scope !== 'repo') throw new LoadoutError(`Param defaults may only use {{ repo.* }} variables: "${tpl}"`);
  }
  const value = renderTemplate(tpl, repo, new Map())!;
  return value.map((p) => (p.kind === 'text' ? p.value : '')).join('');
}
