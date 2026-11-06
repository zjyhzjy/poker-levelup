// Cloudflare 版没有文件系统可读：部署前把 public/avatars/ 里的图片清单生成成模块，
// 供 worker/index.js 的 /api/avatars 返回（与 server.js 的筛选规则一致）。
import fs from "node:fs";

const dir = new URL("../public/avatars/", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f)).sort();
fs.writeFileSync(new URL("../worker/avatars.gen.js", import.meta.url), `export const avatars = ${JSON.stringify(files)};\n`);
console.log(`avatars: ${files.length}`);
