#!/usr/bin/env node
/**
 * SY-GSP 构建脚本:
 *   src/(ESM, 可读源码) --esbuild--> index.js(单文件 CJS 插件产物)
 * 产物可直接放入 data/plugins/SY-GSP/ 使用;输入不需要任何注入或修改。
 */

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "index.js");

async function main() {
  const result = await build({
    entryPoints: [path.join(__dirname, "src/plugin/index.js")],
    outfile: OUT,
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2019",
    charset: "utf8",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    external: ["siyuan"],
    logLevel: "warning",
    metafile: true,
  });

  // 与旧版宿主装载方式一致: module.exports 指向插件类本身
  const js = fs.readFileSync(OUT, "utf8");
  if (!js.endsWith("\n")) fs.appendFileSync(OUT, "\n");
  fs.appendFileSync(OUT, "\nmodule.exports = module.exports.default || module.exports;\n");

  // CJS 语法校验
  const check = spawnSync(process.execPath, ["--check", OUT], { encoding: "utf8" });
  if (check.status !== 0) {
    console.error("语法校验失败:\n" + check.stderr);
    process.exit(1);
  }

  const files = Object.keys(result.metafile.inputs);
  const size = fs.statSync(OUT).size;
  console.log("构建完成: index.js (" + Math.round(size / 1024) + " KB, " + files.length + " 个源文件)");
}

main().catch((err) => {
  console.error("构建失败:", err.message || err);
  process.exit(1);
});
