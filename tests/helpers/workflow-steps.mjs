// 從 GitHub Actions workflow 的原文取出 job、步驟、步驟的 shell 與條件，讓測試能「真的執行」YAML 裡的 shell，
// 或對條件做語意檢查。沒有 YAML 套件可用（這個 repo 的測試只靠 node 內建模組），所以只認專案現有的排版：
//   job 在 2 格縮排、步驟 `- name:`／`- id:`／`- uses:` 在 6 格、步驟欄位在 8 格、`run: |` 的內容在 10 格。
import { readFile } from 'node:fs/promises';

export async function readWorkflow(name) {
    return (await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
}

/** 取出 `  <jobName>:` 這個 job（到下一個 2 格縮排的 job 或檔尾）。 */
export function jobBlock(workflow, jobName) {
    const start = workflow.search(new RegExp(`^  ${jobName}:\\n`, 'm'));
    if (start < 0) throw new Error(`找不到 job：${jobName}`);
    const rest = workflow.slice(start + 1);
    const next = rest.search(/\n {2}[A-Za-z][\w-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 一個 job 裡所有步驟的原文（依出現順序）。 */
export function stepBlocks(job) {
    const starts = [...job.matchAll(/^ {6}- /gm)].map(match => match.index);
    return starts.map((start, index) => job.slice(start, index + 1 < starts.length ? starts[index + 1] : job.length));
}

/** 依步驟名稱（`name:` 的值，完全相符）找步驟原文。 */
export function stepBlock(job, name) {
    const first = new RegExp(`^ {6}- name: ${escapeRegex(name)}$`, 'm');
    const field = new RegExp(`^ {8}name: ${escapeRegex(name)}$`, 'm');
    const found = stepBlocks(job).find(step => first.test(step) || field.test(step));
    if (!found) throw new Error(`找不到步驟：${name}`);
    return found;
}

export function stepId(step) {
    return /^ {8}id: (\S+)$/m.exec(step)?.[1] ?? /^ {6}- id: (\S+)$/m.exec(step)?.[1] ?? null;
}

/** `if: ${{ ... }}` 裡的運算式；沒有 if 就回 null。 */
export function stepIf(step) {
    const match = /^ {8}if: \$\{\{ (.*) \}\}$/m.exec(step);
    return match ? match[1] : null;
}

/** `run: |` 區塊的內容（去掉 10 格縮排）。單行的 `run: 指令` 也支援。 */
export function stepRun(step) {
    const block = /^ {8}run: \|\n((?: {10}.*\n|\n)*)/m.exec(step);
    if (block) return block[1].split('\n').map(line => line.startsWith(' '.repeat(10)) ? line.slice(10) : line).join('\n');
    const single = /^ {8}run: (.+)$/m.exec(step);
    if (single) return single[1];
    throw new Error('這個步驟沒有 run');
}

/** 步驟 header（`run:` 之前）的原文，用來檢查 id、if、continue-on-error、env 等欄位。 */
export function stepHeader(step) {
    const index = step.search(/^ {8}run:/m);
    return index < 0 ? step : step.slice(0, index);
}

export function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取出 backup-bundle.py 的 PROTECTED 清單，讓測試的假備份跟正式的覆蓋範圍一致。 */
export async function protectedTables() {
    const source = await readFile(new URL('../../scripts/backup-bundle.py', import.meta.url), 'utf8');
    const block = /PROTECTED = \(([\s\S]*?)\)/.exec(source)[1];
    return [...block.matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1]);
}
