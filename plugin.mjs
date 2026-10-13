/**
 * DSH 插件工厂 —— guard 系列共用
 *
 * 每个插件的 lib/index.js 只需要：
 *   import { createPlugin } from '@deepwhale-cn/dsh-guard-core/plugin';
 *   export const { name, inject, apply } = createPlugin({
 *     name: 'license-guard',
 *     skillFile: 'skill/license-guard.md',
 *     binFile: 'bin/cli.mjs',
 *     description: '...',
 *     whenToUse: '...',
 *   });
 *
 * 依赖 ctx.skills（由 @deepseek-ai/dsh-skill 提供）。
 * 缺失时静默跳过 —— 可选能力，不应阻断 profile 启动。
 */

import { readFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * @param {object} o
 * @param {string} o.name        skill 标识（kebab-case）
 * @param {string} o.pkgRoot     插件根目录（绝对路径）
 * @param {string} o.skillFile   技能正文（相对 pkgRoot）
 * @param {string} o.binFile     CLI 入口（相对 pkgRoot）
 * @param {string} o.description skill 描述
 * @param {string} o.whenToUse   何时使用
 */
export function createPlugin(o) {
  const pkgRoot = o.pkgRoot;
  const skillPath = join(pkgRoot, o.skillFile);
  const binPath = join(pkgRoot, o.binFile);
  const PH = '<cli 路径>';

  function skillBody() {
    return readFileSync(skillPath, 'utf-8').split(PH).join(binPath);
  }

  function apply(ctx) {
    if (!ctx.skills || typeof ctx.skills.register !== 'function') {
      ctx.logger?.warn?.(`[${o.name}] 未找到 skills 服务，跳过技能注册`);
      return;
    }
    let content;
    try {
      content = skillBody();
    } catch (e) {
      ctx.logger?.error?.(`[${o.name}] 读取技能正文失败: ${e}`);
      return;
    }
    ctx.skills.register({
      name: o.name,
      source: 'bundled',
      description: o.description,
      whenToUse: o.whenToUse,
      content,
    });
    ctx.logger?.info?.(`[${o.name}] 已注册技能 ${o.name}`);
    // 脚本随包分发，发布/安装可能丢掉可执行位；缺失时补上
    if (existsSync(binPath)) {
      try {
        const m = statSync(binPath).mode;
        if (!(m & 0o111)) chmodSync(binPath, m | 0o755);
      } catch { /* 只读文件系统或权限不足：忽略 */ }
    }
  }

  return { name: o.name, inject: ['skills'], apply };
}

/** 便捷：从 lib/index.js 推导插件根目录 */
export function pkgRootFrom(importMetaUrl) {
  return join(dirname(new URL(importMetaUrl).pathname), '..');
}
