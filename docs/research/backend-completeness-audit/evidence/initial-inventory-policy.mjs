import path from 'node:path';
export const POLICY_VERSION = 'git-universe-v1';
export function classify(file, prefix = '') {
  const p = file, base = path.posix.basename(p), ext = path.posix.extname(p).toLowerCase();
  let category, production, role, reason;
  // Priority is declared before any finding: no judgement about utility or ease of review.
  if (/(^|\/)(vendor|third_party|third-party)\//.test(p))
    [category, production, role, reason] = ['VENDOR', false, 'THIRD_PARTY_SOURCE_OR_ASSET', 'Third-party path; listed, build inclusion separately recorded, excluded from first-party semantic review'];
  else if (p.startsWith('docs/') || /\.(md|csv|log|jsonl)$/.test(p) || /(^|\/)(licenses)\//.test(p))
    [category, production, role, reason] = ['DOCUMENTATION_OR_RESEARCH', false, 'DOCUMENT_OR_RESEARCH_ARTIFACT', 'Documentation/research/legal artifact, not a runtime source by path; production imports trigger discrepancy'];
  else if (/(^|\/)(tests?|__tests__|fixtures)\//.test(p) || /(^|\/)(test_[^/]*|[^/]*\.(test|spec|integration)\.[^.]+|[^/]*test[-.]fixture\.[^.]+|tests\.rs)$/.test(p))
    [category, production, role, reason] = ['TEST_OR_TEST_SUPPORT', false, 'TEST_OR_FIXTURE', 'Test naming/directory convention; retained and checked for production imports'];
  else if (/(^|\/)(dist|generated|target|coverage)\//.test(p))
    [category, production, role, reason] = ['TRACKED_GENERATED', false, 'GENERATED_OUTPUT', 'Tracked output directory, retained; source generation and consumer are separate boundaries'];
  else if (ext === '.sql')
    [category, production, role, reason] = ['MIGRATION', true, 'DATABASE_MIGRATION', 'All tracked SQL retained; no historical migration excluded merely by age'];
  else if (/\.(png|icns|ico|woff2?|ttf|otf|frag|vert|css|html|xml)$/.test(p) || p.startsWith('assets/'))
    [category, production, role, reason] = ['PRODUCT_ASSET', true, 'ASSET_OR_PRESENTATION_SOURCE', 'Build/runtime resource; metadata, references and platform conditions require inspection'];
  else if (/\.(ts|tsx|mts|js|jsx|mjs|cjs|py|rs|sh|ps1|cmd|bat)$/.test(p) || /#!/.test(prefix) || base === 'Dockerfile')
    [category, production, role, reason] = ['FIRST_PARTY_SOURCE', true, p.startsWith('scripts/') ? 'BUILD_RUN_OR_TOOL_ENTRY_CANDIDATE' : 'SOURCE_UNIT', 'First-party executable source, including apparently unused and unconfirmed files'];
  else if (/\.(json|ya?ml|toml|lock|spec|example)$/.test(p) || /^(requirements.*\.txt|\.env\.example|\.gitignore|\.prettierignore)$/.test(base) || p.startsWith('.github/'))
    [category, production, role, reason] = ['CONFIGURATION', true, 'CONFIG_BUILD_DEPENDENCY_OR_POLICY', 'Tracked configuration or build/dependency input; no assumption that every selectable capability works'];
  else
    [category, production, role, reason] = ['UNKNOWN', true, 'UNKNOWN', 'Unrecognized tracked file retained in production candidate denominator; requires classification'];
  const language = ({'.ts':'TypeScript','.tsx':'TSX','.mts':'TypeScript','.mjs':'JavaScript','.cjs':'JavaScript','.js':'JavaScript','.jsx':'JSX','.py':'Python','.rs':'Rust','.sql':'SQL','.json':'JSON','.yml':'YAML','.yaml':'YAML','.toml':'TOML','.sh':'Shell','.ps1':'PowerShell','.cmd':'Batch','.bat':'Batch','.css':'CSS','.html':'HTML','.frag':'GLSL','.vert':'GLSL','.xml':'XML','.spec':'Python-build-spec','.example':'Env-template','.md':'Markdown','.txt':'Text','.lock':'Dependency-lock'})[ext]
    ?? (base === 'Dockerfile' ? 'Dockerfile' : prefix.startsWith('#!') ? 'Shell' : /\.(png|ico|icns)$/.test(p) ? 'Binary-asset' : 'UNKNOWN');
  return { category, production, role, language, classificationReason: reason };
}
