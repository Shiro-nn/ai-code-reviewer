import OpenAI from "npm:openai@4.97.0";
import { Octokit } from "npm:@octokit/rest@19.0.7";

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
const openai = new OpenAI({apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL});

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
        owner: pr.owner, repo: pr.repo, base: before, head: after,
        headers: { accept: "application/vnd.github.v3.diff" },
    });
    diffStr = splitByGitDiff(comp.data as unknown as string);
} else if (eventData.action === "created") {
    diffStr = await getDiff(pr.owner, pr.repo, pr.pull_number);
} else {
    throw new Error(`Unsupported event: ${Deno.env.get("GITHUB_EVENT_NAME")}`);
}
console.log('---1---');
console.log(await octokit.pulls.listFiles({...pr}));
console.log('---2---');
console.log(diffStr);
console.log('---3---');

console.log('---4---');
console.log(pr);
console.log('---5---');

const comments = await analyzeCode(diffStr, pr);
console.log('---6---');
console.info(comments);

if (comments.length) {
    await octokit.pulls.createReview({
        owner: pr.owner, repo: pr.repo, pull_number: pr.pull_number,
        comments, event: "COMMENT",
    });
}



async function getPRDetails(): Promise<PRDetails> {
    const { repository, number, issue } = eventData;
    console.debug({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: issue?.number ?? number,
    })
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

async function getDiff(owner: string, repo: string, pull_number: number): Promise<string[]> {
    const res = await octokit.pulls.get({
        owner, repo, pull_number,
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
Your primary function is to act as an automated code reviewer for Pull Requests (PRs). Your sole output MUST be a valid JSON object. No other text, explanations, or conversational elements are permitted before or after the JSON structure. Adherence to this strict JSON-only output is critical as it will be programmatically parsed.

**Output Format Specification:**

The JSON object MUST conform to the following structure:
\`{"reviews":[{"lineNumber": <number>, "reviewComment": "<string>"}]}\`

**Field Definitions:**

* \`lineNumber\`: (Integer) The exact line number in the provided code snippet/diff where the issue is identified. For comments that apply to the entire file or the PR in a global sense (e.g., architectural concerns not tied to a specific line), use \`1\`.
* \`reviewComment\`: (String) A clear, concise, and actionable description of the identified issue.
    * This field MUST exclusively contain constructive criticism, bug reports, suggestions for improvement, or violations of best practices.
    * NO compliments, praise, or positive affirmations are allowed.
    * You MAY use Markdown within this string for formatting purposes (e.g., to denote code snippets using backticks \` \`\`\` \`, bold \`**text**\`, italics \`*text*\`).

**Scope of Review - Types of Issues to Identify:**

Focus on, but do not limit yourself to, the following categories of issues:

1.  **Bugs and Logical Errors:** Code that will not work as intended, produces incorrect results, or could lead to runtime errors.
2.  **Security Vulnerabilities:** Potential weaknesses that could be exploited (e.g., XSS, SQL injection, insecure handling of data).
3.  **Performance Issues:** Inefficient code, unnecessary computations, memory leaks, or potential bottlenecks.
4.  **Code Clarity and Maintainability:** Code that is hard to understand, overly complex, lacks necessary comments (where ambiguity exists), or does not follow common readability standards.
5.  **Best Practice Violations:** Deviations from established coding principles, design patterns, or language-specific idioms.
6.  **Error Handling:** Missing, inadequate, or incorrect error/exception handling.
7.  **Concurrency Issues:** Potential race conditions, deadlocks, or other problems related to multi-threaded execution.
8.  **Resource Management:** Improper handling of resources like file streams, network connections, or memory allocation.
9.  **Test Coverage Gaps (if applicable/inferable):** Obvious scenarios not covered by tests, or code that would be difficult to test.
10. **Redundancy/Duplication:** Unnecessary repetition of code that could be refactored.

**Handling "No Issues":**

If, after thorough review, no issues are identified in the provided code, you MUST output the following JSON object:
\`{"reviews":[]}\`

**Final Reminder:** Your entire response must be *only* the JSON object. Any deviation will cause parsing errors.

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
                { role: "user", content: prompt }
            ],
        });
        const text = stripThinkBlocks(response.choices[0].message?.content?.trim() || "{}");
        console.log(text);
        try {
            return JSON.parse(text).reviews;
        } catch {
            try {
                return JSON.parse( `${text}}`).reviews;
            } catch {
                return JSON.parse( text.substring(0, text.length-2)).reviews;
            }
        }
    } catch(err) {
        console.error(err);
        return null;
    }
}

async function analyzeCode(files: string[], pr: PRDetails) {
    const comments: Array<{ body: string; path: string; line: number }> = [];
    for (const file of files) {
        console.log(file);
        const prompt = createPrompt(file, pr);
        const reviews = await getAIResponse(prompt);
        console.log(reviews);
        if (reviews) {
            for (const r of reviews) {
                comments.push({ body: r.reviewComment, path: file.split('\n')[2].substring(6), line: Number(r.lineNumber) });
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
        .map(b => b.trim())
        .filter(b => b.length > 0);
}
