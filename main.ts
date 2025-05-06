import OpenAI from "npm:openai";
import { Octokit } from "npm:@octokit/rest";
import parseDiff from "npm:parse-diff";
import {minimatch} from "npm:minimatch";

// Читаем и парсим JSON события
const eventPath = Deno.env.get("GITHUB_EVENT_PATH")!;
const eventData = JSON.parse(Deno.readTextFileSync(eventPath));

console.debug(`Event path: ${eventPath}`);
console.debug('Event data: ', eventData);

// Получаем входные переменные
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const OPENAI_API_MODEL = Deno.env.get("OPENAI_API_MODEL")!;

// Инициализация клиентов
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI();

interface PRDetails {
    owner: string;
    repo: string;
    pull_number: number;
    title: string;
    description: string;
}


// main
const pr = await getPRDetails();
let diffStr: string;
if (eventData.action === "opened") {
    diffStr = await getDiff(pr.owner, pr.repo, pr.pull_number);
} else if (eventData.action === "synchronize") {
    const { before, after } = eventData;
    const comp = await octokit.repos.compareCommits({
        owner: pr.owner, repo: pr.repo, base: before, head: after,
        headers: { accept: "application/vnd.github.v3.diff" },
    });
    diffStr = String(comp.data);
} else if (eventData.action === "created") {
    diffStr = await getDiff(pr.owner, pr.repo, pr.pull_number);
} else {
    throw new Error(`Unsupported event: ${Deno.env.get("GITHUB_EVENT_NAME")}`);
}

const parsed = parseDiff(diffStr);
console.info(parsed);
const patterns = (Deno.env.get("exclude") || "").split(",").map(s => s.trim());
console.info(patterns);
const filtered = parsed.filter(f => !patterns.some(p => minimatch(f.to || "", p)));
console.info(filtered);

const comments = await analyzeCode(filtered, pr);
if (comments.length) {
    await octokit.pulls.createReview({
        owner: pr.owner, repo: pr.repo, pull_number: pr.pull_number,
        comments, event: "COMMENT",
    });
}

console.info(comments);


async function getPRDetails(): Promise<PRDetails> {
    const { repository, number } = eventData;
    const pr = await octokit.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
    });
    return {
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
        title: pr.data.title || "",
        description: pr.data.body || "",
    };
}

async function getDiff(owner: string, repo: string, pull_number: number): Promise<string> {
    const res = await octokit.pulls.get({
        owner, repo, pull_number,
        mediaType: { format: "diff" },
    });
    console.log(JSON.stringify(res.data))
    return res.data as unknown as string;
}

function stripThinkBlocks(input: string): string {
    // Для удаления <think>…</think>, если понадобится
    return input.replace(/<think>[\s\S]*?<\/think>/gs, "").trimStart();
}

function createPrompt(filePath: string, chunk: any, pr: PRDetails): string {
    return `Your task is to review PR code. Output JSON:
{"reviews":[{"lineNumber":<number>,"reviewComment":"<text>"}]}
No compliments. Only issues. File: ${filePath}
Title: ${pr.title}
Desc:
---
${pr.description}
---
\`\`\`diff
${chunk.content}
${chunk.changes.map((c: any) => `${c.ln ?? c.ln2} ${c.content}`).join("\n")}
\`\`\``;
}

async function getAIResponse(prompt: string) {
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_API_MODEL,
            temperature: 0.2,
            max_tokens: 700,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
            messages: [{ role: "system", content: prompt }],
        });
        const text = response.choices[0].message?.content?.trim() || "{}";
        return JSON.parse(stripThinkBlocks(text)).reviews;
    } catch {
        return null;
    }
}

async function analyzeCode(files: ReturnType<typeof parseDiff>, pr: PRDetails) {
    const comments: Array<{ body: string; path: string; line: number }> = [];
    for (const f of files) {
        if (f.to === "/dev/null" || !f.to) continue;
        for (const chunk of f.chunks) {
            const prompt = createPrompt(f.to, chunk, pr);
            const reviews = await getAIResponse(prompt);
            if (reviews) {
                for (const r of reviews) {
                    comments.push({ body: r.reviewComment, path: f.to, line: Number(r.lineNumber) });
                }
            }
        }
    }
    return comments;
}
