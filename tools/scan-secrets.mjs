#!/usr/bin/env node
/**
 * 密钥扫描器：扫工作树 + Git 全历史。
 *
 * 为什么自己写而不是直接用 gitleaks：
 * gitleaks 需要 Docker daemon 或安装二进制，而这里的构建机不一定有；
 * 这个实现零依赖、跨平台、可进 CI，规则用高置信度正则 + 占位符/熵过滤，
 * 目标是"少漏报、少误报"，不是替代专业工具。
 *
 * 用法：
 *   node tools/scan-secrets.mjs                      # 扫当前仓库（工作树 + 历史）
 *   node tools/scan-secrets.mjs --repo <path>        # 扫别的仓库
 *   node tools/scan-secrets.mjs --no-history          # 只扫工作树
 *   node tools/scan-secrets.mjs --json               # 机器可读输出
 *
 * 退出码：有发现 = 1，没有 = 0。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** 目录/文件名黑名单：扫工作树时跳过。 */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "coverage", ".next", ".cache",
  ".venv", "venv", "__pycache__", ".turbo", ".idea", ".vscode",
]);

/**
 * 高置信度规则。
 *
 * capture：取第几个捕获组作为"疑似密钥"（0 = 整个匹配）。
 * filter：额外的误报过滤器，返回 true 才算发现。
 */
const RULES = [
  { id: "agent-commerce-key", re: /\bac_(?:trial|live|prod)_([A-Za-z0-9_-]{16,})\b/g, capture: 1 },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, capture: 0 },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{24,}\b/g, capture: 0 },
  { id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, capture: 0 },
  { id: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, capture: 0 },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, capture: 0 },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, capture: 0 },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, capture: 0 },
  { id: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, capture: 0 },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g, capture: 0 },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}\b/g, capture: 0 },
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, capture: 0 },
  {
    id: "db-url-with-password",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^:\s\/@]+:([^\s\/@"'`]{6,})@/g,
    capture: 1,
  },
  { id: "bearer-literal", re: /\bBearer\s+([A-Za-z0-9._~+/-]{24,})/g, capture: 1 },
  {
    id: "secret-assignment",
    re: /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|apikey|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)\s*[=:]\s*["']([^"'\s]{16,})["']/gi,
    capture: 2,
    entropy: 3.2,
    notAValue: true,
  },
];

/**
 * 显式自曝"我不是真密钥"的标记。
 *
 * 测试夹具常写成 ac_trial_this-key-does-not-exist-000000 这种，
 * 它含随机片段、熵也不低，但一眼就是假的。这类必须放行，
 * 否则误报会把扫描器变成噪声源——没人看红字，红字就等于没有。
 */
const FAKE_MARKER =
  /(?:not[-_]?a[-_]?real|does[-_]?not[-_]?exist|definitely[-_]?not|^(?:fake|mock|test|testing|dummy|sample|example|placeholder)[-_]|[-_](?:fake|mock|test|testing|dummy|sample|example|placeholder)(?:[-_]|$))/i;

/**
 * 值其实是"环境变量名"或"请求头名"，不是密钥本身。
 *
 * 只对 secret-assignment 这条规则生效——全大写不能全局用：
 * AWS 那种真密钥同样是全大写字母数字。全局用会把真密钥放过去。
 */
const NOT_A_VALUE = /^(?:[A-Z][A-Z0-9_]{3,}|x-[a-z][a-z0-9-]*)$/;

/** 占位符：长得像密钥、但明显不是真密钥。 */
const PLACEHOLDER = /^(?:x{3,}|\*+|\?+|placeholder|example|sample|dummy|fake|changeme|change[_-]?me|your[_-]?\w*|my[_-]?\w*|todo|tbd|n\/?a|none|null|undefined|true|false|test|foo|bar|baz|abc123|123456|secret|token|password|key|value|default|local|localhost|admin|user|pass|\$\{[^}]+\}|<[^>]+>|\{\{[^}]+\}\})/i;

function isPlaceholder(value) {
  if (!value) return true;
  if (PLACEHOLDER.test(value)) return true;
  if (FAKE_MARKER.test(value)) return true;
  // 常见占位后缀：xxx / yyy / zzz / ... / ****
  if (/(?:xxx|yyy|zzz|aaa|\.{3,})$/i.test(value)) return true;
  // 同一字符重复（aaaaaa）几乎不可能是随机密钥
  if (/^(.)\1+$/.test(value)) return true;
  return false;
}

/** 香农熵（每字符比特数）。熵太低 = 人写的词，不是随机密钥。 */
function shannonEntropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redact(value) {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 3) + "*".repeat(Math.min(16, value.length - 5)) + value.slice(-2);
}

function scanText(text, location, findings) {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(text)) !== null) {
      const value = match[rule.capture] ?? match[0];
      if (isPlaceholder(value)) continue;
      if (rule.notAValue && NOT_A_VALUE.test(value)) continue;
      if (rule.entropy !== undefined && shannonEntropy(value) < rule.entropy) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({
        rule: rule.id,
        location,
        line,
        preview: redact(value),
        entropy: Number(shannonEntropy(value).toFixed(2)),
      });
    }
  }
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
  });
}

function listWorktreeFiles(repo) {
  // git 仓库里只扫"git 允许提交的文件"：
  // 已跟踪的 + 未跟踪但没被忽略的。.env、node_modules、备份目录本来
  // 就进不了版本库，把它们算成"发现"是噪声，不是风险。
  try {
    const listed = git(repo, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (listed.length > 0) return listed.map((rel) => join(repo, rel));
  } catch {
    // 不是 git 仓库（或 git 不可用）：退回目录遍历
  }

  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(repo);
  return files;
}

function scanWorktree(repo, findings) {
  let scanned = 0;
  for (const file of listWorktreeFiles(repo)) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (buf.length > 8 * 1024 * 1024) continue;
    if (buf.includes(0)) continue; // 二进制
    const text = buf.toString("utf8");
    scanText(text, relative(repo, file).replace(/\\/g, "/"), findings);
    scanned += 1;
  }
  return scanned;
}

function scanHistory(repo, findings) {
  let scanned = 0;
  const objects = git(repo, ["rev-list", "--objects", "--all"]);
  const pathBySha = new Map();
  for (const line of objects.split("\n")) {
    const [sha, ...rest] = line.trim().split(" ");
    if (!sha || rest.length === 0) continue;
    const path = rest.join(" ");
    if (!pathBySha.has(sha)) pathBySha.set(sha, path);
  }
  const shas = [...pathBySha.keys()];
  if (shas.length === 0) return;

  // 分批喂给 cat-file --batch，避免一次性超长输入
  const CHUNK = 200;
  for (let i = 0; i < shas.length; i += CHUNK) {
    const chunk = shas.slice(i, i + CHUNK);
    const out = execFileSync("git", ["-C", repo, "cat-file", "--batch"], {
      input: chunk.join("\n") + "\n",
      maxBuffer: 1024 * 1024 * 1024,
    });
    const text = out.toString("binary");
    let pos = 0;
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos);
      if (nl < 0) break;
      const header = text.slice(pos, nl).split(" ");
      const sha = header[0];
      const type = header[1];
      const size = Number(header[2]);
      const start = nl + 1;
      const body = text.slice(start, start + size);
      pos = start + size + 1;
      if (type !== "blob") continue;
      if (body.includes("\u0000")) continue;
      const path = pathBySha.get(sha) ?? sha;
      scanText(body, `history:${path}@${sha.slice(0, 8)}`, findings);
      scanned += 1;
    }
  }
  return scanned;
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.rule}|${f.location}|${f.preview}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function main() {
  const argv = process.argv.slice(2);
  let repo = process.cwd();
  let history = true;
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) repo = resolve(argv[++i]);
    else if (argv[i] === "--no-history") history = false;
    else if (argv[i] === "--json") asJson = true;
  }

  const findings = [];
  const problems = [];
  const worktreeFiles = scanWorktree(repo, findings);
  let historyBlobs = 0;
  let historyFailed = false;
  if (history) {
    try {
      historyBlobs = scanHistory(repo, findings);
    } catch (error) {
      historyFailed = true;
      // fail-closed：历史没扫完，就不能算"干净"。
      // 把没完成的扫描当成"通过"，等于把没检查过的部分当成了安全——
      // 这比报个假警危险得多。
      problems.push(
        "历史扫描失败：" + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  const unique = dedupe(findings);

  if (asJson) {
    console.log(JSON.stringify({ repo, findings: unique, problems }, null, 2));
  } else {
    console.log(`扫描目标：${repo}`);
    console.log(
      `覆盖：工作树 ${worktreeFiles} 个文件` +
        (history
          ? historyFailed
            ? ` + Git 历史（扫描失败）`
            : ` + Git 历史 ${historyBlobs} 个 blob`
          : `（未扫历史）`),
    );
    console.log(`发现 ${unique.length} 处疑似密钥`);
    for (const f of unique) {
      console.log(`  [${f.rule}] ${f.location}:${f.line}  熵=${f.entropy}  ${f.preview}`);
    }
    for (const problem of problems) {
      console.log(`  ! ${problem}`);
    }
    if (unique.length === 0 && problems.length === 0) console.log("  没有发现。");
  }

  process.exitCode = unique.length > 0 || problems.length > 0 ? 1 : 0;
}

main();
