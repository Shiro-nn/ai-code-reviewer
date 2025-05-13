import OpenAI from "npm:openai@4.97.0";
import { Octokit } from "npm:@octokit/rest@19.0.7";
import yaml from "npm:js-yaml@4.1.0";

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

const excludePatterns = (Deno.env.get("exclude") ?? "")
    .split(",")
    .map((s) => s.trim());

diffStr = diffStr.filter((str) => {
  try { return !excludePatterns.some(p => str.split("\n")[2].endsWith(p)); }
  catch { return true; }
});

console.log(diffStr);
console.log("---4---");
console.log(pr);
console.log("---5---");

const comments = await analyzeCode(diffStr, pr);
console.log("---6---");
console.info(comments);

if (comments.length) {
  try {
    await octokit.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pull_number,
      comments: comments.map(({ body, path, line }) => ({
        body,
        path,
        line: line + 3,
      })),
      event: "COMMENT",
    });
  } catch {
    try {
      await octokit.pulls.createReview({
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.pull_number,
        comments,
        event: "COMMENT",
      });
    } catch {
      for (const comment of comments) {
        try {
          await octokit.pulls.createReview({
            owner: pr.owner,
            repo: pr.repo,
            pull_number: pr.pull_number,
            comments: [{
              ...comment,
              line: comment.line + 3,
            }],
            event: "COMMENT",
          });
        } catch {
          try {
            await octokit.pulls.createReview({
              owner: pr.owner,
              repo: pr.repo,
              pull_number: pr.pull_number,
              comments: [comment],
              event: "COMMENT",
            });
          } catch (err) {
            console.warn(err);
          }
        }
      }
    }
  }
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

- lineNumber: <number>
  reviewComment: "<markdown-formatted issue description>"
- lineNumber: <number>
  reviewComment: "<markdown-formatted issue description>"

Rules:
1. **No** compliments or extraneous text—only list issues.
2. Answer **only** with the YAML; do not wrap it in prose.
3. You may use Markdown inside each “reviewComment”.
4. To leave a file-wide or “global” note, set “lineNumber” to the first line of the diff (from @@ -31,11 +31,10). DONT use first line of file, git broken due this.
5. Don't create two comments on one line, make one comment through \\n\\n separation.
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
    const reply = yaml.loadAll(text.split('\n').filter(x => !x.startsWith('```')).join('\n'));
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
    const fileName = file.split("\n")[2].substring(6);
    console.log("--- ai ---");
    console.log(file);
    const prompt = createPrompt(file, pr);
    const reviews = await getAIResponse(prompt);
    console.log(reviews);
    console.log("--- ai ---");
    if (reviews) {
      for (const r of reviews) {
        if (r.constructor === [].constructor) {
          for (const rr of r) {
            comments.push({
              body: rr.reviewComment,
              path: fileName,
              line: Number(rr.lineNumber),
            });
          }
        } else {
          comments.push({
            body: r.reviewComment,
            path: fileName,
            line: Number(r.lineNumber),
          });
        }
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
