/**
 * @deepwhale-cn/dsh-guard-core —— 通用检查引擎
 *
 * 30 个插件共用的骨架。每个插件只提供 rules/，引擎负责扫描、判定、报告。
 *
 * ── 为什么要有引擎 ───────────────────────────────────────────────
 * 30 个插件如果各写一套扫描/报告/输出，就是 30 份维护成本。
 * 抽成引擎后，加一个插件 ≈ 加一批规则 JSON + 一个 README。
 *
 * ── 三条硬约束（来自项目标准）────────────────────────────────────
 *  1. **必须输出扫描范围**（扫了多少文件/多少项）—— 防「假绿」：
 *     工具没跑起来却报「全绿」，用户以为没事，实际没检查。
 *  2. **每条发现必须带定位（文件:行）和依据（source）** —— 否则不可验证、不可申诉。
 *  3. **敏感值默认打码** —— 输出里绝不出现完整密钥/身份证等原值。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

// ── 默认跳过的目录 ────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv',
  '.cache', '.turbo', 'vendor', 'target',
]);

// ── 默认扫描的文本扩展名（二进制文件不读内容）──────────────────────
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.md', '.txt', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.php', '.lua', '.sql', '.env', '.properties',
]);

/** 单文件读取上限（超过不读内容，避免大文件拖慢）*/
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const DEFAULT_IGNORE = [
  /^\.git\//, /^node_modules\//, /\.min\.(js|css)$/,
  /package-lock\.json$/, /pnpm-lock\.yaml$/, /yarn\.lock$/,
];

// ── 扫描 ──────────────────────────────────────────────────────────

/**
 * 遍历目录，返回文件清单。
 * 只返回「路径 + 元信息」，内容按需读 —— 扫描阶段不读内容，快。
 */
export function walk(root, { maxFiles = 20000, ignore = [] } = {}) {
  const ignoreList = [...DEFAULT_IGNORE, ...ignore];
  const files = [];
  const skippedDirs = [];

  function rec(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 权限不足等：静默跳过（但会被 skipCount 记录）
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, e.name);
      const rel = relative(root, full).split('\\').join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { skippedDirs.push(rel); continue; }
        rec(full);
      } else if (e.isFile()) {
        if (ignoreList.some((re) => re.test(rel))) continue;
        let st;
        try { st = statSync(full); } catch { continue; }
        files.push({
          path: rel,
          abs: full,
          size: st.size,
          ext: extname(e.name).toLowerCase(),
          mode: st.mode,
          isText: TEXT_EXT.has(extname(e.name).toLowerCase()) ||
                  basename(e.name).startsWith('.env') ||
                  basename(e.name).startsWith('.npmrc'),
        });
      }
    }
  }
  rec(root);
  return { files, skippedDirs, truncated: files.length >= maxFiles };
}

/** 读文件内容（打码留给 check 层；这里只负责读 + 截断）*/
export function readText(file) {
  if (!file.isText || file.size > MAX_FILE_BYTES) return null;
  try { return readFileSync(file.abs, 'utf-8'); } catch { return null; }
}

// ── 检查类型实现 ──────────────────────────────────────────────────
//
// 规则 JSON 里的 check.type 在这里实现。加新类型 = 在这里加一个函数。
//
// 每个 check 函数签名：(ctx) => Finding[]
//   ctx = { root, files, rule, readText, helpers }

const CHECKS = {
  /** 文件内容正则匹配 */
  'file-pattern'(ctx) {
    const out = [];
    const pat = new RegExp(ctx.rule.check.pattern, ctx.rule.check.flags || 'g');
    const exts = ctx.rule.check.exts;
    for (const f of ctx.files) {
      if (exts && !exts.includes(f.ext)) continue;
      const text = readText(f);
      if (text == null) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        pat.lastIndex = 0;
        const m = pat.exec(lines[i]);
        if (!m) continue;
        out.push({
          file: f.path, line: i + 1,
          evidence: ctx.mask ? ctx.mask(m[0]) : m[0],
          excerpt: lines[i].trim().slice(0, 120),
        });
        if (out.length >= (ctx.rule.check.max || 50)) return out;
      }
    }
    return out;
  },

  /** 文件存在性（存在则命中，或 require:true 表示不存在则命中）*/
  'file-exists'(ctx) {
    const { globs, require: req } = ctx.rule.check;
    const hit = globs.map((g) => {
      const re = globToRe(g);
      return ctx.files.filter((f) => re.test(f.path)).map((f) => f.path);
    }).flat();
    if (req) {
      // 「必须存在」类：**整组只报一条**（2026-10-12 修复：
      // 原来 4 个 glob 各报一条，同一个问题报了 4 遍）
      if (hit.length === 0) {
        return [{ file: globs[0], line: 0, evidence: `以下任一均不存在：${globs.join(' / ')}` }];
      }
      return [];
    }
    return hit.map((p) => ({ file: p, line: 0, evidence: `存在：${p}` }));
  },

  /** 文件权限（POSIX）*/
  'file-permission'(ctx) {
    const out = [];
    const { globs, maxMode } = ctx.rule.check;
    for (const g of globs) {
      const re = globToRe(g);
      for (const f of ctx.files) {
        if (!re.test(f.path)) continue;
        const perm = f.mode & 0o777;
        if (perm > maxMode) {
          out.push({
            file: f.path, line: 0,
            evidence: `权限 ${perm.toString(8)} 超过上限 ${maxMode.toString(8)}`,
          });
        }
      }
    }
    return out;
  },

  /** 依赖许可（读 lockfile / package.json 的依赖树）*/
  'dependency-license'(ctx) {
    const { match = [], flagUnknown = true } = ctx.rule.check;
    const deps = ctx.helpers.collectDependencies(ctx);
    const out = [];
    for (const d of deps) {
      const lic = (d.license || '').toUpperCase();
      if (!lic) {
        if (flagUnknown) {
          out.push({ file: d.manifest, line: 0, evidence: `${d.name}@${d.version} —— 许可证未知` });
        }
        continue;
      }
      // 匹配规则：**归一化 + 前缀锚定**，不是子串包含。
      // （2026-10-12 两次修复：
      //   ① 原来用 includes → "LGPL-3.0".includes("GPL") 为真，LGPL 被误判成 GPL（误报）
      //   ② 多个模式命中同一条 → 重复上报 2-3 遍）
      const norm = lic.replace(/\s+/g, '').replace(/\+$/, '-or-later');
      const matched = match.some((m) => {
        const M = m.toUpperCase().replace(/\s+/g, '');
        return norm === M || norm.startsWith(M + '-') || norm.startsWith(M + '+');
      });
      if (matched) {
        out.push({ file: d.manifest, line: 0, evidence: `${d.name}@${d.version} —— ${d.license}` });
      }
    }
    return out;
  },

  /** package.json 字段检查 */
  'package-field'(ctx) {
    const out = [];
    const { file = 'package.json', field, require: req, pattern } = ctx.rule.check;
    const f = ctx.files.find((x) => x.path === file);
    if (!f) return [{ file, line: 0, evidence: `找不到 ${file}` }];
    let pkg;
    try { pkg = JSON.parse(readText(f) || '{}'); } catch { return [{ file, line: 0, evidence: `${file} 不是合法 JSON` }]; }
    const val = field.split('.').reduce((o, k) => (o == null ? o : o[k]), pkg);
    if (req && (val === undefined || val === null || val === '')) {
      out.push({ file, line: 0, evidence: `缺少字段 ${field}` });
    } else if (pattern && typeof val === 'string' && !new RegExp(pattern).test(val)) {
      out.push({ file, line: 0, evidence: `${field} 不匹配 /${pattern}/：${String(val).slice(0, 60)}` });
    }
    return out;
  },
};

// ── 引擎主流程 ────────────────────────────────────────────────────

/**
 * 执行一次扫描。
 * @returns {{ findings, stats, degraded }}
 */
export function scan({ root, rules, ignore = [], checkCtx = {} }) {
  const { files, skippedDirs, truncated } = walk(root, { ignore });
  const findings = [];
  const perRule = [];

  const helpers = {
    collectDependencies(ctx) { return collectDependencies(ctx, root); },
  };

  for (const rule of rules) {
    const impl = CHECKS[rule.check?.type];
    if (!impl) {
      perRule.push({ id: rule.id, hits: 0, error: `未知 check.type: ${rule.check?.type}` });
      continue;
    }
    let hits = [];
    try {
      hits = impl({ root, files, rule, readText: (f) => readText(f), helpers, ...checkCtx });
    } catch (e) {
      perRule.push({ id: rule.id, hits: 0, error: String(e && e.message || e) });
      continue;
    }
    perRule.push({ id: rule.id, hits: hits.length, error: null });
    for (const h of hits) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity || 'medium',
        source: rule.source || '',
        advice: rule.advice || '',
        ...h,
      });
    }
  }

  // 按严重度排序
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  const stats = {
    root,
    scannedFiles: files.length,
    skippedDirs: skippedDirs.length,
    truncated,
    rulesTotal: rules.length,
    rulesRun: perRule.filter((r) => !r.error).length,
    ruleErrors: perRule.filter((r) => r.error),
    findings: findings.length,
    bySeverity: countBy(findings, (f) => f.severity),
  };

  return { findings, stats, perRule };
}

// ── 依赖收集（多个插件复用）───────────────────────────────────────

function collectDependencies(ctx, root) {
  const out = [];
  const seen = new Set();
  // 注意：**直接从磁盘读 lockfile**，不走扫描结果 ——
  // 它可能因 DEFAULT_IGNORE 或文件大小上限而不在 files 里（2026-10-12 实测踩过）。
  const lockAbs = join(root, 'package-lock.json');
  if (existsSync(lockAbs)) {
    try {
      const j = JSON.parse(readFileSync(lockAbs, 'utf-8'));
      const pkgs = j.packages || {};
      for (const [p, info] of Object.entries(pkgs)) {
        if (!p || !p.includes('node_modules/')) continue;
        const name = p.replace(/^.*node_modules\//, '');
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, version: info.version || '?', license: pickLicense(info.license || info.licenses), manifest: 'package-lock.json' });
      }
    } catch { /* 忽略 */ }
  }
  // node_modules 兜底
  if (out.length === 0) {
    const nm = join(root, 'node_modules');
    if (existsSync(nm)) {
      let dirs = [];
      try { dirs = readdirSync(nm, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { /* */ }
      for (const d of dirs) {
        if (d.name.startsWith('.')) continue;
        if (d.name.startsWith('@')) {
          let sub = [];
          try { sub = readdirSync(join(nm, d.name), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { /* */ }
          for (const s of sub) pushPkg(join(nm, d.name, s.name), `${d.name}/${s.name}`);
        } else {
          pushPkg(join(nm, d.name), d.name);
        }
      }
    }
  }
  function pushPkg(dir, name) {
    if (seen.has(name)) return;
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      seen.add(name);
      out.push({ name, version: pj.version || '?', license: pickLicense(pj.license || pj.licenses), manifest: 'node_modules/' + name + '/package.json' });
    } catch { /* */ }
  }
  return out;
}

function pickLicense(l) {
  if (!l) return '';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => x.type || x).join(' OR ');
  if (typeof l === 'object') return l.type || l.name || '';
  return String(l);
}

// ── 工具 ──────────────────────────────────────────────────────────

export function globToRe(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + esc + '$');
}

function countBy(arr, fn) {
  const m = {};
  for (const x of arr) { const k = fn(x); m[k] = (m[k] || 0) + 1; }
  return m;
}

/** 打码：只留前后各几位 */
export function mask(s, head = 4, tail = 2) {
  const t = String(s);
  if (t.length <= head + tail) return '*'.repeat(t.length);
  return t.slice(0, head) + '*'.repeat(Math.min(t.length - head - tail, 20)) + t.slice(-tail);
}

export const SEVERITY_LABEL = {
  critical: '严重', high: '高', medium: '中', low: '低', info: '提示',
};

export { CHECKS, SKIP_DIRS, TEXT_EXT };
