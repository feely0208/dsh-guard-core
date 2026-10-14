/**
 * 报告生成 —— 文本 / HTML / JSON
 *
 * ── 为什么报告这么重要 ───────────────────────────────────────────
 * 用户原话：「网安插件并不是深鲸画布之类的，有 GUI 可以直观地看到哪里出问题，
 * 这类的**至少我是看不到直观的问题的**」。
 *
 * 解法：**报告就是它的 GUI**。
 *  - 红黄绿总览（一眼看结论）
 *  - 定位到 文件:行（能跳过去改）
 *  - 依据（哪条法规/标准）—— 可验证、可申诉
 *  - **必须显示扫描范围** —— 防「假绿」：没扫到东西却报全绿
 *
 * 报告可以截图 → 放进 README → 这就是我们的「看得见的输出」。
 */

import { SEVERITY_LABEL } from './index.mjs';

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_COLOR = {
  critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#0891b2', info: '#64748b',
};

/** 文本报告（CLI 输出）*/
export function textReport({ findings, stats, meta = {} }) {
  const L = [];
  const line = '─'.repeat(66);
  L.push('');
  L.push(`  ${meta.name || '检查'} v${meta.version || '0.0.0'}`);
  L.push(`  ${line}`);
  L.push(`  扫描范围   ${stats.root}`);
  L.push(`             ${stats.scannedFiles} 个文件 · ${stats.skippedDirs} 个目录已跳过${stats.truncated ? ' · ⚠️ 已达上限截断' : ''}`);
  // 假绿防治：把「扫了多少、跳了多少、为什么跳」摆在报告最上面。
  // 只显示「0 命中」而不显示扫描范围，就是假绿的温床。
  if (stats.skippedCount) {
    const byReason = {};
    for (const x of (stats.skippedFiles || [])) byReason[x.reason] = (byReason[x.reason] || 0) + 1;
    const detail = Object.entries(byReason).map(([k, v]) => `${k}:${v}`).join(' ');
    L.push(`  跳过文件   ${stats.skippedCount} 个（${detail}）${stats.skippedDirs?.length ? ` · 跳过目录 ${stats.skippedDirs.length} 个` : ''}`);
  }
  L.push(`  检查规则   ${stats.rulesRun}/${stats.rulesTotal} 条${
    stats.rulesSkipped ? ` （${stats.rulesSkipped} 条因不适用本项目未运行：${(stats.notApplicable || []).join(', ')}）` : ''
  }${stats.ruleErrors.length ? ` （${stats.ruleErrors.length} 条出错）` : ''}`);
  L.push(`  命中       ${stats.findings} 条`);
  L.push('');

  if (stats.findings === 0) {
    L.push('  ✅ 未发现问题');
    // 防假绿：把「扫了什么」再说一遍，让「全绿」是可验证的
    L.push(`     （已扫描 ${stats.scannedFiles} 个文件、执行 ${stats.rulesRun} 条规则）`);
    if (stats.scannedFiles < 5) {
      L.push('  ⚠️  扫描到的文件很少，请确认目录是否正确 —— 不要因「全绿」就放心');
    }
  } else {
    for (const sev of SEV_ORDER) {
      const group = findings.filter((f) => f.severity === sev);
      if (!group.length) continue;
      L.push(`  【${SEVERITY_LABEL[sev]}】${group.length} 条`);
      for (const f of group) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        L.push(`    · ${f.title}`);
        L.push(`      位置  ${loc}`);
        L.push(`      证据  ${f.evidence}`);
        if (f.source) L.push(`      依据  ${f.source}`);
        if (f.advice) L.push(`      建议  ${f.advice}`);
      }
      L.push('');
    }
  }

  if (stats.ruleErrors.length) {
    L.push('  ⚠️ 以下规则执行出错（结果不完整）：');
    for (const e of stats.ruleErrors) L.push(`    · ${e.id}: ${e.error}`);
    L.push('');
  }

  L.push(`  ${line}`);
  L.push(`  ${meta.footer || ''}`);
  L.push('');
  return L.join('\n');
}

/** HTML 报告（可截图、可存档）*/
export function htmlReport({ findings, stats, meta = {} }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 规则文案里允许用 **加粗** 和 `代码` —— 先转义再从安全子集转回来，
  // 否则截图里会出现一堆字面 **（2026-10-13 实测发现）
  const md = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const sev = stats.bySeverity || {};
  const chips = SEV_ORDER.filter((s) => sev[s]).map((s) =>
    `<span class="chip" style="--c:${SEV_COLOR[s]}">${SEVERITY_LABEL[s]} <b>${sev[s]}</b></span>`).join('');

  const rows = findings.map((f) => `
      <tr class="sev-${f.severity}">
        <td><span class="dot" style="--c:${SEV_COLOR[f.severity]}"></span>${SEVERITY_LABEL[f.severity]}</td>
        <td><div class="t">${md(f.title)}</div><div class="src">${md(f.source)}</div></td>
        <td><code>${esc(f.line ? f.file + ':' + f.line : f.file)}</code><div class="ev">${md(f.evidence)}</div></td>
        <td class="adv">${md(f.advice)}</td>
      </tr>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(meta.name)} · 检查报告</title>
<style>
  :root{--bg:#0b1018;--fg:#e6edf6;--muted:#8b9bb4;--line:#1e2a3a;--card:#121a26}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:32px}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .card .k{color:var(--muted);font-size:12px;margin-bottom:6px}
  .card .v{font-size:20px;font-weight:700}
  .chip{display:inline-block;padding:3px 10px;border-radius:999px;margin:0 6px 6px 0;font-size:13px;
        border:1px solid var(--c);color:var(--c)}
  .chip b{font-size:15px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
  th{color:var(--muted);font-weight:500;background:#0e1622}
  tr:last-child td{border-bottom:0}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--c);margin-right:6px}
  .t{font-weight:600;margin-bottom:2px}
  .src{color:var(--muted);font-size:12px}
  code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#7dd3fc}
  .ev{color:var(--muted);font-size:12px;margin-top:2px;word-break:break-all}
  .adv{color:var(--muted);font-size:12px;max-width:260px}
  .ok{background:#0d2b1a;border:1px solid #1d7a4a;color:#4ade80;padding:16px;border-radius:12px;margin-bottom:20px}
  .warn{background:#2b1f0d;border:1px solid #a16207;color:#fbbf24;padding:12px 16px;border-radius:12px;margin-bottom:20px;font-size:13px}
  footer{color:var(--muted);font-size:12px;margin-top:22px;padding-top:14px;border-top:1px solid var(--line)}
  footer p{margin:3px 0}
</style></head><body><div class="wrap">
  <h1>${esc(meta.name)}</h1>
  <div class="sub">${esc(meta.desc || '')}</div>

  <div class="cards">
    <div class="card"><div class="k">扫描文件</div><div class="v">${stats.scannedFiles}</div></div>
    <div class="card"><div class="k">检查规则</div><div class="v">${stats.rulesRun}<span style="font-size:13px;color:var(--muted)">/${stats.rulesTotal}</span></div></div>
    <div class="card"><div class="k">命中</div><div class="v" style="color:${stats.findings ? '#ea580c' : '#4ade80'}">${stats.findings}</div></div>
    <div class="card"><div class="k">已跳过目录</div><div class="v">${stats.skippedDirs}</div></div>
  </div>

  ${stats.truncated ? '<div class="warn">⚠️ 文件数已达上限并截断 —— 结果不完整，请缩小扫描范围或调高上限。</div>' : ''}
  ${stats.scannedFiles < 5 ? '<div class="warn">⚠️ 扫描到的文件很少，请确认扫描目录是否正确 —— <b>不要因「全绿」就放心</b>。</div>' : ''}
  ${stats.ruleErrors.length ? `<div class="warn">⚠️ ${stats.ruleErrors.length} 条规则执行出错，结果不完整。详见 CLI 输出。</div>` : ''}

  ${stats.findings === 0 ? `<div class="ok">✅ 未发现问题 —— 已扫描 ${stats.scannedFiles} 个文件、执行 ${stats.rulesRun} 条规则。</div>`
    : `<div style="margin-bottom:16px">${chips}</div>
       <table><thead><tr><th>级别</th><th>问题</th><th>位置 / 证据</th><th>建议</th></tr></thead>
       <tbody>${rows}</tbody></table>`}

  <footer>
    <p>扫描范围：<code>${esc(stats.root)}</code> · ${stats.scannedFiles} 个文件</p>
    <p>规则库：${esc(meta.rulesVersion || '—')} · 生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}</p>
    <p>${esc(meta.footer || '')}</p>
  </footer>
</div></body></html>`;
}

/** JSON 报告（给 CI / 二次处理）*/
export function jsonReport({ findings, stats, meta = {} }) {
  return JSON.stringify({
    name: meta.name, version: meta.version, rulesVersion: meta.rulesVersion,
    generatedAt: new Date().toISOString(),
    stats, findings,
  }, null, 2);
}

/** 退出码：有 critical/high 命中 → 1（可挂 CI）*/
export function exitCode(findings) {
  return findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 1 : 0;
}
