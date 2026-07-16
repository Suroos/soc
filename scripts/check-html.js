/* HTML 내장 <script> 구문 검사 — node scripts/check-html.js <파일...> */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const os = require("node:os");

let bad = 0;
for (const file of process.argv.slice(2)) {
  const html = fs.readFileSync(file, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m, i) => {
    const tmp = path.join(os.tmpdir(), `chk-${path.basename(file)}-${i}.js`);
    fs.writeFileSync(tmp, m[1], "utf8");
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
      console.log(`  ✅ ${file} <script #${i}> OK`);
    } catch (e) {
      bad++;
      console.log(`  ❌ ${file} <script #${i}> 구문 오류:\n${e.stderr}`);
    }
    fs.unlinkSync(tmp);
  });
}
process.exit(bad ? 1 : 0);
