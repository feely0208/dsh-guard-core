# @deepwhale-cn/dsh-guard-core

深鲸守护系列的**通用检查引擎**。扫描目录、执行规则、生成报告。

## 用法

```js
import { scan } from '@deepwhale-cn/dsh-guard-core';
import { textReport, htmlReport, exitCode } from '@deepwhale-cn/dsh-guard-core/report';

const { findings, stats } = scan({ root: process.cwd(), rules });
console.log(textReport({ findings, stats, meta }));
process.exit(exitCode(findings));
```

## 三个刻意的设计

1. **必须输出扫描范围** —— 防「假绿」：工具没跑起来却报「全绿」。
2. **每条发现带定位（文件:行）+ 依据（source）** —— 否则不可验证、不可申诉。
3. **敏感值默认打码** —— 输出里不出现完整密钥原值。

MIT © 深鲸 DeepWhale
