#!/usr/bin/env node
/**
 * 通用 CLI —— guard 系列插件共用
 *
 * 每个插件的 bin/cli.mjs 只需要：
 *   import { runCli } from '@deepwhale-cn/dsh-guard-core/cli';
 *   runCli({ pkgRoot: <插件根目录> });
 *
 * 插件差异只在 rules/ 和 README/skill 文案 —— 代码 100% 共用。
 *
 * 用法（用户视角）：
 *   <命令>                  扫当前目录
 *   <命令> --root <dir>     指定目录
 *   <命令> --demo           用内置样本看检出效果
 *   <命令> --html out.html  输出 HTML 报告
 *   <命令> --json           JSON（给 CI）
 *   <命令> --list-rules     列出规则及依据
 *
 * 退出码：有 high/critical 命中 → 1
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from './index.mjs';
import { textReport, htmlReport, jsonReport, exitCode } from './report.mjs';

export function runCli({ pkgRoot, meta = {} }) {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
  const META = {
    name: meta.name || pkg.name,
    version: pkg.version,
    desc: meta.desc || pkg.description,
    rulesVersion: meta.rulesVersion || readRulesVersion(pkgRoot),
    footer: meta.footer || '',
  };

  const argv = process.argv.slice(2);
  const opt = { root: process.cwd(), demo: false, html: null, json: false, quiet: false, listRules: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opt.root = argv[++i];
    else if (a === '--demo') opt.demo = true;
    else if (a === '--html') opt.html = argv[++i];
    else if (a === '--json') opt.json = true;
    else if (a === '--quiet') opt.quiet = true;
    else if (a === '--list-rules') opt.listRules = true;
    else if (a === '-h' || a === '--help') { help(pkg, META); process.exit(0); }
  }

  const rules = loadRules(pkgRoot);

  if (opt.listRules) {
    console.log(`\n  ${META.name} —— ${rules.length} 条规则\n`);
    for (const r of rules) {
      console.log(`  [${r.severity}] ${r.id}`);
      console.log(`        ${r.title}`);
      if (r.source) console.log(`        依据：${r.source}`);
      console.log('');
    }
    process.exit(0);
  }

  const root = opt.demo ? demoRoot(pkgRoot) : opt.root;
  // 演示模式显示友好标签 —— 否则会把我们本机的绝对路径暴露在截图里
  const rootLabel = opt.demo ? '内置演示样本 · 故意有问题的项目' : null;
  const { findings, stats } = scan({ root, rootLabel, rules });

  if (opt.json) {
    console.log(jsonReport({ findings, stats, meta: META }));
  } else if (opt.quiet) {
    console.log(`${stats.findings} 条命中 · 扫描 ${stats.scannedFiles} 文件 · ${stats.rulesRun} 规则`);
  } else {
    if (opt.demo) console.log('\n  【演示模式】使用内置样本，不是你的真实项目。\n');
    console.log(textReport({ findings, stats, meta: META }));
  }

  if (opt.html) {
    writeFileSync(opt.html, htmlReport({ findings, stats, meta: META }), 'utf-8');
    if (!opt.quiet && !opt.json) console.log(`  HTML 报告已写入：${opt.html}\n`);
  }

  process.exit(exitCode(findings));
}

function loadRules(pkgRoot) {
  const dir = join(pkgRoot, 'rules');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

/** 规则库版本：优先 rules/_version.json，其次根目录 RULES_VERSION */
function readRulesVersion(pkgRoot) {
  try {
    const dir = join(pkgRoot, 'rules');
    const vf = join(dir, '_version.json');
    if (existsSync(vf)) return JSON.parse(readFileSync(vf, 'utf-8')).version;
    const pv = join(pkgRoot, 'RULES_VERSION');
    if (existsSync(pv)) return readFileSync(pv, 'utf-8').trim();
    return '—';
  } catch { return '—'; }
}

/** demo 样本：tests/fixtures/fail/demo-project */
function demoRoot(pkgRoot) {
  const p = join(pkgRoot, 'tests', 'fixtures', 'fail', 'demo-project');
  if (!existsSync(p)) {
    console.error(`\n  ❌ 演示样本缺失：${p}\n     请在 tests/fixtures/fail/demo-project/ 放一个故意有问题的样本项目。\n`);
    process.exit(2);
  }
  return p;
}

function help(pkg, META) {
  console.log(`
  ${META.name} v${pkg.version}

  ${META.desc}

  用法：
    ${pkg.name.split('/').pop()} [选项]

  选项：
    --root <dir>     扫描目录（默认当前目录）
    --demo           用内置样本跑一遍，看检出效果
    --html <file>    额外输出 HTML 报告
    --json           输出 JSON（给 CI 二次处理）
    --quiet          只输出结论行
    --list-rules     列出规则及依据
    -h, --help       显示帮助

  退出码：
    0  没有 high/critical 命中
    1  有 high/critical 命中（可挂 CI 卡口）
`);
}
