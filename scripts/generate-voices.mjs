import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
const OUT_DIR = resolve("public", "voice");
const MODEL = process.env.VOICE_MODEL || "gpt-4o-mini-tts";
const FORMAT = "wav";

const styleBase = [
  "中文棋牌手游风，夸张一点，短促有气势。",
  "像热闹牌桌上的游戏播报，不拖泥带水。",
  "不要模仿任何具体商业游戏角色或真人声音。",
  "普通话，吐字清楚，尾音干净，有一点兴奋和压迫感。"
].join(" ");

const lines = [
  { file: "tractor1", text: "拖拉机", voice: "nova", note: "女声，略微拉长，兴奋上扬。" },
  { file: "tractor2", text: "拖拉机", voice: "onyx", note: "男声，短促有力，像打出大牌。" },
  { file: "tractor3", text: "拖拉机", voice: "shimmer", note: "女声，俏皮但有气势。" },
  { file: "tractor4", text: "拖拉机来啦", voice: "echo", note: "男声，轻微夸张，节奏快。" },

  { file: "lead-trump1", text: "吊主", voice: "nova", note: "女声，利落，带一点挑衅。" },
  { file: "lead-trump2", text: "吊主", voice: "shimmer", note: "女声，短促，牌桌播报感。" },

  { file: "kill1", text: "毙了", voice: "onyx", note: "男声，重音在第一个字，干脆。" },
  { file: "kill2", text: "毙了", voice: "nova", note: "女声，清亮，带胜利感。" },
  { file: "kill3", text: "毙了", voice: "echo", note: "男声，短促低沉。" },

  { file: "overtake-dani1", text: "大你", voice: "nova", note: "女声，挑衅，尾音上扬。" },
  { file: "overtake-dani2", text: "大你", voice: "onyx", note: "男声，自信，短促。" },
  { file: "overtake-guanshang1", text: "管上", voice: "shimmer", note: "女声，干净有力。" },
  { file: "overtake-guanshang2", text: "管上", voice: "echo", note: "男声，果断，略低沉。" },

  { file: "throw1", text: "甩牌", voice: "nova", note: "女声，兴奋，牌局事件播报。" },
  { file: "throw2", text: "甩牌", voice: "onyx", note: "男声，有气势，速度快。" }
];

if (!API_KEY) {
  console.error("Missing OPENAI_API_KEY. Example: OPENAI_API_KEY=sk-... npm run voices");
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });

for (const line of lines) {
  const output = resolve(OUT_DIR, `${line.file}.${FORMAT}`);
  const body = {
    model: MODEL,
    voice: line.voice,
    input: line.text,
    instructions: `${styleBase} ${line.note}`,
    response_format: FORMAT
  };
  process.stdout.write(`Generating ${line.file}.${FORMAT} ... `);
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${message}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(output, buffer);
  console.log("done");
}

console.log(`Voice pack written to ${OUT_DIR}`);
