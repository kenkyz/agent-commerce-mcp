#!/usr/bin/env node
/**
 * 公开仓库自检：文档与示例不能和契约脱节。
 *
 * 两件事：
 *
 * 1. **工具名一致**：docs/tools.md 里列的工具，必须和 docs/contract.md 里
 *    定义的工具完全一样（不多、不少、不改名）。契约变了而速查表没跟上，
 *    开发者照着速查表调一个已经不存在的工具——这正是要防的事。
 * 2. **示例只用契约里的工具**：examples/ 里出现的工具名，必须在契约里存在。
 * 3. **文档链接不断**：docs/ 与 examples/ 里的相对链接必须能解析到真实文件。
 *
 * 退出码：有���题 = 1。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

/** 契约里的工具：### 5.1 `search_products` */
function contractTools() {
  const text = readFileSync(join(ROOT, "docs", "contract.md"), "utf8");
  const names = new Set();
  const pattern = /^###\s+\d+\.\d+\s+\`([a-z_]+)\`/gm;
  let match;

  while ((match = pattern.exec(text)) !== null) names.add(match[1]);

  return names;
}

/** 速查表里的工具：## `search_products` */
function referenceTools() {
  const text = readFileSync(join(ROOT, "docs", "tools.md"), "utf8");
  const names = new Set();
  const pattern = /^##\s+\`([a-z_]+)\`/gm;
  let match;

  while ((match = pattern.exec(text)) !== null) names.add(match[1]);

  return names;
}

/** 示例源码里用到的工具名。 */
function toolsUsedInExamples() {
  const used = new Set();
  const dir = join(ROOT, "examples");

  const files = [];

  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };

  walk(dir);

  for (const file of files) {
    const text = readFileSync(file, "utf8");

    // name: "x" / name === "x" / name !== "x"
    const calls = /name\s*(?::|===|!==|==)\s*["'`]([a-z_]+)["'`]/g;
    // LOCAL_PARAM_HINTS 里的对象键："x": {
    const keys = /["'`]([a-z_]+)["'`]\s*:\s*\{/g;

    let match;

    while ((match = calls.exec(text)) !== null) used.add(match[1]);
    while ((match = keys.exec(text)) !== null) used.add(match[1]);
  }

  return { used, files: files.map((file) => relative(ROOT, file).replace(/\\/g, "/")) };
}

/** 文档里的相对链接必须解析得到。 */
function verifyLinks() {
  const roots = [join(ROOT, "docs"), join(ROOT, "examples")];
  const files = [];

  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };

  for (const root of roots) walk(root);
  files.push(join(ROOT, "README.md"), join(ROOT, "README.zh-CN.md"));

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const pattern = /\]\(([^)\s]+)\)/g;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const target = match[1];

      if (/^(https?:|mailto:|#)/.test(target)) continue;

      const resolved = resolve(dirname(file), target.split("#")[0]);
      const candidate = resolved.endsWith("/") ? join(resolved, "README.md") : resolved;

      if (!existsSync(candidate)) {
        problems.push(
          relative(ROOT, file).replace(/\\/g, "/") + ": 断链 → " + target,
        );
      }
    }
  }
}

function main() {
  const contract = contractTools();
  const reference = referenceTools();

  if (contract.size === 0) {
    problems.push("docs/contract.md: 没解析出任何工具名——契约格式变了？");
  }

  for (const name of contract) {
    if (!reference.has(name)) {
      problems.push("docs/tools.md: 少了工具 → " + name);
    }
  }

  for (const name of reference) {
    if (!contract.has(name)) {
      problems.push("docs/tools.md: 多出契约里没有的工具 → " + name);
    }
  }

  const { used, files } = toolsUsedInExamples();

  for (const name of used) {
    if (!contract.has(name)) {
      problems.push("examples: 用到了契约里没有的工具 → " + name);
    }
  }

  verifyLinks();

  console.log("契约工具（" + contract.size + "）：" + [...contract].join(", "));
  console.log("速查表工具（" + reference.size + "）");
  console.log("示例用到（" + used.size + "）：" + [...used].join(", "));
  console.log("示例文件：" + files.join(", "));

  if (problems.length > 0) {
    console.error("\n发现问题：");

    for (const problem of problems) console.error("  - " + problem);

    process.exitCode = 1;
    return;
  }

  console.log("\n通过：工具清单、示例引用与文档链接都一致。");
}

main();
