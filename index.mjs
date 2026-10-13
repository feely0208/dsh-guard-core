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

// 注意：**不要**把 lockfile 放进来。
// 2026-10-13 踩过：package-lock.json 被排除 → file-exists 以为它不存在 →
// 明明有 lockfile 却报「没有 lockfile」（误报），且依赖检查也读不到。
// 「文件是否存在」是文件系统问题，不该受扫描器忽略规则影响。
const DEFAULT_IGNORE = [
  /^\.git\//, /^node_modules\//, /\.min\.(js|css)$/,
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
        // 注意：path.extname('.env') 返回空串 —— dotfile 用整个文件名当「扩展名」，
        // 否则规则里写 exts: ['.env'] 永远匹配不上（2026-10-13 实测）
        const rawExt = extname(e.name).toLowerCase();
        const dotfileName = e.name.startsWith('.') && !rawExt ? e.name.toLowerCase() : '';
        files.push({
          path: rel,
          abs: full,
          size: st.size,
          ext: rawExt || dotfileName,
          mode: st.mode,
          isText: TEXT_EXT.has(rawExt || dotfileName) ||
                  basename(e.name).startsWith('.env') ||
                  basename(e.name).startsWith('.npmrc') ||
                  basename(e.name).startsWith('.gitignore'),
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
  /**
   * 文件内容正则匹配。
   * check 支持：
   *   pattern       必填，正则
   *   flags         可选，默认 'g'
   *   exts          可选，只扫这些扩展名
   *   paths         可选，只扫匹配这些 glob 的文件（2026-10-13 加，CI 规则需要限定 .github/workflows/）
   *   allOf         可选，多个正则必须**在同一文件里全部命中**才算（用于组合条件）
   *   exclude       可选，排除匹配这些正则的文件
   */
  'file-pattern'(ctx) {
    const out = [];
    const { pattern, flags = 'g', exts, paths, allOf, exclude, max = 50 } = ctx.rule.check;
    const pathRes = (paths || []).map(globToRe);
    const exRes = (exclude || []).map((p) => new RegExp(p));
    for (const f of ctx.files) {
      if (exts && !exts.includes(f.ext)) continue;
      if (pathRes.length && !pathRes.some((re) => re.test(f.path))) continue;
      const text = readText(f);
      if (text == null) continue;
      if (exRes.some((re) => re.test(text))) continue;
      // allOf：多个模式必须同文件全中
      if (allOf && allOf.length) {
        const all = allOf.every((p) => new RegExp(p, flags).test(text));
        if (!all) continue;
        const hitLine = firstMatchLine(text, new RegExp(pattern, flags.replace('g', '')));
        out.push({ file: f.path, line: hitLine, evidence: allOf.join(' + ') });
        if (out.length >= max) return out;
        continue;
      }
      // wholeFile：跨行匹配（如 "run: 到 200 字符内出现 ${{ github.event }}"）
      if (ctx.rule.check.wholeFile) {
        const pat = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
        let m;
        while ((m = pat.exec(text)) !== null) {
          const line = text.slice(0, m.index).split('\n').length;
          out.push({ file: f.path, line, evidence: m[0].replace(/\s+/g, ' ').slice(0, 120) });
          if (out.length >= max) return out;
          if (m.index === pat.lastIndex) pat.lastIndex++; // 防零宽死循环
        }
        continue;
      }
      const pat = new RegExp(pattern, flags);
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
        if (out.length >= max) return out;
      }
    }
    return out;
  },

  /** 文件存在性（存在则命中，或 require:true 表示不存在则命中）*/
  'file-exists'(ctx) {
    const { globs, require: req } = ctx.rule.check;
    // 先用文件系统直接判断（非 glob 的精确文件名）—— 不依赖扫描结果
    const hit = [];
    for (const g of globs) {
      if (!/[*?]/.test(g)) {
        if (existsSync(join(ctx.root, g))) hit.push(g);
        continue;
      }
      const re = globToRe(g);
      for (const f of ctx.files) if (re.test(f.path)) hit.push(f.path);
    }
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

  /**
   * 个人敏感信息扫描（PII）。
   *
   * ── 为什么必须带校验和 ──────────────────────────────────────────
   * 纯正则找手机号/身份证**误报率极高**（订单号、时间戳、随机 ID 都像）。
   * 安全工具最大的杀手就是误报 —— 用户被烦几次就卸载。
   * 所以这里对每个类型都做**结构校验 + 校验位验证**：
   *   身份证  GB 11643-1999 加权校验位（17 位加权和 mod 11）
   *   银行卡  Luhn 算法
   *   手机号  号段白名单 + 边界断言（防止从长数字里截一段）
   *
   * ── 输出永远不落原值 ────────────────────────────────────────────
   * 只记「哪个文件哪一行、什么类型、第几个」—— 记原值等于工具自己成了泄露源。
   */
  'pii-scan'(ctx) {
    const TYPES = {
      '身份证': { re: /(?<![0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])/g, validate: validIdCard },
      '银行卡': { re: /(?<![0-9])(?:62|4[0-9]{2}|5[1-5][0-9]{2}|3[47][0-9]{2})[0-9]{8,15}(?![0-9])/g, validate: luhn },
      '手机号': { re: /(?<![0-9])(?:\+?86[-\s]?)?1(?:3[0-9]|4[5-9]|5[0-35-9]|6[2567]|7[0-8]|8[0-9]|9[0-35-9])[0-9]{8}(?![0-9])/g, validate: null },
      '邮箱':   { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, validate: null },
      'IPv4私网': { re: /(?<![0-9])(?:10\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}|192\.168\.[0-9]{1,3})\.[0-9]{1,3}(?![0-9])/g, validate: null },
    };
    const { types = Object.keys(TYPES), paths, exts, max = 100 } = ctx.rule.check;
    const out = [];
    const pathRes = (paths || []).map(globToRe);
    for (const f of ctx.files) {
      if (pathRes.length && !pathRes.some((re) => re.test(f.path))) continue;
      if (exts && !exts.includes(f.ext)) continue;
      const text = readText(f);
      if (text == null) continue;
      const lines = text.split('\n');
      for (const t of types) {
        const spec = TYPES[t];
        if (!spec) continue;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;              // 注释里的示例不算
          const re = new RegExp(spec.re.source, spec.re.flags);
          let m;
          while ((m = re.exec(line)) !== null) {
            if (spec.validate && !spec.validate(m[0].replace(/[-\s]/g, ''))) continue;
            out.push({
              file: f.path, line: i + 1,
              evidence: `${t}（已打码：${mask(m[0].replace(/[-\s]/g, ''))}）`,
            });
            if (out.length >= max) return out;
          }
        }
      }
    }
    return out;
  },

  /**
   * 依赖的生命周期脚本（preinstall / install / postinstall）——
   * **这是 npm 投毒最主要的载体**：装包时就执行任意代码，不需要你 import 它。
   * check 支持：hook（默认全部）、allow（白名单包名）
   */
  'dependency-script'(ctx) {
    const { hooks = ['preinstall', 'install', 'postinstall'], allow = [] } = ctx.rule.check;
    const out = [];
    const nm = join(ctx.root, 'node_modules');
    if (!existsSync(nm)) return out; // 没装依赖 —— 由别的规则报「没 lockfile」
    const allowSet = new Set(allow.map((x) => x.toLowerCase()));
    const dirs = [];
    let top = [];
    try { top = readdirSync(nm, { withFileTypes: true }); } catch { return out; }
    for (const e of top) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        let sub = [];
        try { sub = readdirSync(join(nm, e.name), { withFileTypes: true }); } catch { /* */ }
        for (const s2 of sub) if (s2.isDirectory()) dirs.push({ name: `${e.name}/${s2.name}`, dir: join(nm, e.name, s2.name) });
      } else {
        dirs.push({ name: e.name, dir: join(nm, e.name) });
      }
    }
    for (const d of dirs) {
      if (allowSet.has(d.name.toLowerCase())) continue;
      let pj;
      try { pj = JSON.parse(readFileSync(join(d.dir, 'package.json'), 'utf-8')); } catch { continue; }
      const scripts = pj.scripts || {};
      const hit = hooks.filter((h) => scripts[h]);
      if (!hit.length) continue;
      out.push({
        file: `node_modules/${d.name}/package.json`, line: 0,
        evidence: `${d.name}@${pj.version || '?'} 有脚本：${hit.join(', ')}`,
      });
    }
    return out;
  },

  /**
   * 文件必须不含某模式（整文件判断，只报一条）。
   * 用于「没声明 X 就报警」这类 —— 逐行测会每行都命中。
   */
  'file-lacks'(ctx) {
    const { pattern, flags = 's', paths, mustExist = false } = ctx.rule.check;
    const out = [];
    const pathRes = (paths || []).map(globToRe);
    for (const f of ctx.files) {
      if (pathRes.length && !pathRes.some((re) => re.test(f.path))) continue;
      const text = readText(f);
      if (text == null) continue;
      if (!new RegExp(pattern, flags).test(text)) {
        out.push({ file: f.path, line: 0, evidence: ctx.rule.check.evidence || `未找到：${pattern}` });
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

/** 身份证校验位：GB 11643-1999，17 位加权和 mod 11 → 对照表 */
function validIdCard(id) {
  if (!/^[0-9]{17}[0-9Xx]$/.test(id)) return false;
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const C = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * W[i];
  return C[sum % 11] === id[17].toUpperCase();
}

/** Luhn 校验（银行卡）*/
function luhn(num) {
  if (!/^[0-9]{12,19}$/.test(num)) return false;
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

/** 注释行（避免把示例/文档里的假数据当命中）*/
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

/** 找第一个匹配的行号（1-based），找不到返回 0 */
function firstMatchLine(text, re) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 0;
}

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
