import OpenAI from "npm:openai@4.97.0";
import { Octokit } from "npm:@octokit/rest@19.0.7";
import yaml2json from "npm:yaml-to-json@0.3.0";

console.log(yaml2json)

// Читаем и парсим JSON события
const eventPath = Deno.env.get("GITHUB_EVENT_PATH")!;
const eventData = JSON.parse(Deno.readTextFileSync(eventPath));

console.debug(`Event path: ${eventPath}`);

// Получаем входные переменные
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENAI_BASE_URL = Deno.env.get("OPENAI_API_ENDPOINT")!;
const OPENAI_API_MODEL = Deno.env.get("OPENAI_API_MODEL")!;

// Инициализация клиентов
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL });

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

// main
const pr = await getPRDetails();
let diffStr: string[];
if (eventData.action === "opened") {
  diffStr = await getDiff(pr.owner, pr.repo, pr.pull_number);
} else if (eventData.action === "synchronize") {
  const { before, after } = eventData;
  const comp = await octokit.repos.compareCommits({
    owner: pr.owner,
    repo: pr.repo,
    base: before,
    head: after,
    headers: { accept: "application/vnd.github.v3.diff" },
  });
  diffStr = splitByGitDiff(comp.data as unknown as string);
} else if (eventData.action === "created") {
  diffStr = await getDiff(pr.owner, pr.repo, pr.pull_number);
} else {
  throw new Error(`Unsupported event: ${Deno.env.get("GITHUB_EVENT_NAME")}`);
}
console.log("---1---");
console.log(await octokit.pulls.listFiles({ ...pr }));
console.log("---2---");
console.log(diffStr);
console.log("---3---");

console.log("---4---");
console.log(pr);
console.log("---5---");

const comments = await analyzeCode(diffStr, pr);
console.log("---6---");
console.info(comments);

if (comments.length) {
  await octokit.pulls.createReview({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pull_number,
    comments,
    event: "COMMENT",
  });
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number, issue } = eventData;
  console.debug({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: issue?.number ?? number,
  });
  const pr = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: issue?.number ?? number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: issue?.number ?? number,
    title: pr.data.title || "",
    description: pr.data.body || "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number,
): Promise<string[]> {
  const res = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return splitByGitDiff(res.data as unknown as string);
}

function stripThinkBlocks(input: string): string {
  // Для удаления <think>…</think>, если понадобится
  return input.replace(/<think>[\s\S]*?<\/think>/gs, "").trim();
}

function createPrompt(diffs: string, pr: PRDetails): string {
  return `Title: ${pr.title}
Desc:
---
${pr.description}
---
\`\`\`diff
${diffs}
\`\`\``;
}

function getSystemPrompt(): string {
  return `
You are a code review assistant. Analyze the given PR and output **only** a YAML object in this exact schema:

lineNumber: <number>
reviewComment: "<markdown-formatted issue description>"

Rules:
1. **No** compliments or extraneous text—only list issues.
2. Answer **only** with the YAML; do not wrap it in prose.
3. You may use Markdown inside each “reviewComment”.
4. If you want to add multiple comments, you can do so by creating multiple yaml responses (example: {yaml}\\n---------\\n{yaml}\\n).
5. To leave a file-wide or “global” note, set “lineNumber” to the first line of the diff (from @@ -31,11 +31,10). DONT use first line of file, git broken due this.
6. Don't create two comments on one line, make one comment through \\n\\n separation.
`;
}

async function getAIResponse(prompt: string) {
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_API_MODEL,
      temperature: 0.2,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      messages: [
        { role: "system", content: getSystemPrompt() },
        { role: "user", content: prompt },
      ],
    });
    const text = stripThinkBlocks(
      response.choices[0].message?.content?.trim() || "{}",
    );
    console.log(text);
    const reply = yaml2json(text);
    console.log(reply);
    return reply;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function analyzeCode(files: string[], pr: PRDetails) {
  const comments: Array<{ body: string; path: string; line: number }> = [];
  for (const file of files) {
    console.log("--- ai ---");
    console.log(file);
    const prompt = createPrompt(file, pr);
    const reviews = await getAIResponse(prompt);
    console.log(reviews);
    console.log("--- ai ---");
    if (reviews) {
      for (const r of reviews) {
        comments.push({
          body: r.reviewComment,
          path: file.split("\n")[2].substring(6),
          line: Number(r.lineNumber),
        });
      }
    }
  }
  return comments;
}

function splitByGitDiff(fullDiff: string) {
  return fullDiff
    // разделяем по целой строке с маркером, включая её перенос
    .split(/^diff --git[^\n]*\n/gm)
    // каждый блок — уже без маркера, но может быть пустым
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}
