// GitHub Actions `if:` 運算式的最小求值器，只實作這個 repo 的 workflow 實際用到的語法：
//   字面值（'字串'、true、false、null、數字）、context 取值（steps.x.outcome、inputs.publish-only …）、
//   ! == != && || 括號，以及 success() / failure() / cancelled() / always()。
// 目的是讓測試能「在各種步驟結果的組合下，這個步驟到底會不會執行」，而不只是檢查字串裡有沒有某段文字：
// 一長串 && 與 || 的括號分組錯了，字串檢查看不出來，求值一次就現形。
//
// 語意照 GitHub 文件：== 與 != 對字串不分大小寫；型別不同時先轉成數字（null→0、true→1、false→0、字串→數字）；
// && 與 || 短路並回傳運算元本身；沒有狀態函式的 if 會被隱含地加上 success() &&。

const TOKEN = /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=|!|\(|\)|,)|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*))/y;

function tokenize(text) {
    const tokens = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < text.length) {
        if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
        const match = TOKEN.exec(text);
        if (!match) throw new SyntaxError(`無法解析運算式：${text.slice(TOKEN.lastIndex)}`);
        if (match[1] !== undefined) tokens.push({ type: 'string', value: match[1].slice(1, -1).replaceAll("''", "'") });
        else if (match[2] !== undefined) tokens.push({ type: 'op', value: match[2] });
        else if (match[3] !== undefined) tokens.push({ type: 'number', value: Number(match[3]) });
        else tokens.push({ type: 'name', value: match[4] });
    }
    return tokens;
}

function toNumber(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value);
    return NaN;
}

function looselyEqual(left, right) {
    const bothNull = (left === null || left === undefined) && (right === null || right === undefined);
    if (bothNull) return true;
    if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase();
    if (typeof left === typeof right && left !== null && right !== null) return left === right;
    return toNumber(left) === toNumber(right);
}

export const truthy = value => !(value === null || value === undefined || value === false || value === 0 || value === '' || Number.isNaN(value));

/**
 * @param expression `${{ }}` 裡面的運算式
 * @param context    { steps, inputs, github, needs, job, ... } 加上 status：{ cancelled: boolean, failed: boolean }
 *                   failed＝前面是否有步驟失敗（success() 為 false）
 */
export function evaluate(expression, context) {
    const tokens = tokenize(expression);
    let position = 0;
    const peek = () => tokens[position];
    const take = () => tokens[position++];
    const status = context.status ?? { cancelled: false, failed: false };

    const functions = {
        always: () => true,
        cancelled: () => status.cancelled,
        success: () => !status.cancelled && !status.failed,
        failure: () => !status.cancelled && status.failed
    };

    const lookup = path => {
        let value = context;
        for (const part of path.split('.')) {
            if (value === null || value === undefined) return null;
            value = Object.hasOwn(Object(value), part) ? value[part] : null;
        }
        return value ?? null;
    };

    function parseOr() {
        let left = parseAnd();
        while (peek()?.value === '||' && peek().type === 'op') {
            take();
            const right = parseAnd();
            left = truthy(left) ? left : right;
        }
        return left;
    }

    function parseAnd() {
        let left = parseEquality();
        while (peek()?.value === '&&' && peek().type === 'op') {
            take();
            const right = parseEquality();
            left = truthy(left) ? right : left;
        }
        return left;
    }

    function parseEquality() {
        let left = parseUnary();
        while (peek()?.type === 'op' && (peek().value === '==' || peek().value === '!=')) {
            const operator = take().value;
            const right = parseUnary();
            left = operator === '==' ? looselyEqual(left, right) : !looselyEqual(left, right);
        }
        return left;
    }

    function parseUnary() {
        if (peek()?.type === 'op' && peek().value === '!') {
            take();
            return !truthy(parseUnary());
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const token = take();
        if (!token) throw new SyntaxError('運算式提早結束');
        if (token.type === 'string' || token.type === 'number') return token.value;
        if (token.type === 'op' && token.value === '(') {
            const value = parseOr();
            if (take()?.value !== ')') throw new SyntaxError('少了右括號');
            return value;
        }
        if (token.type === 'name') {
            if (peek()?.type === 'op' && peek().value === '(') {
                take();
                if (take()?.value !== ')') throw new SyntaxError(`${token.value}() 不接受參數`);
                if (!Object.hasOwn(functions, token.value)) throw new SyntaxError(`未實作的函式：${token.value}()`);
                return functions[token.value]();
            }
            if (token.value === 'true') return true;
            if (token.value === 'false') return false;
            if (token.value === 'null') return null;
            return lookup(token.value);
        }
        throw new SyntaxError(`多餘的符號：${token.value}`);
    }

    const result = parseOr();
    if (position !== tokens.length) throw new SyntaxError(`運算式後面還有多的內容：${tokens[position].value}`);
    return result;
}

const STATUS_FUNCTION = /\b(?:success|failure|cancelled|always)\s*\(/;

/** 這個步驟在此情境下會不會執行。沒有狀態函式的 if 會被隱含加上 success() &&。 */
export function stepRuns(condition, context) {
    const expression = condition === null ? 'success()'
        : STATUS_FUNCTION.test(condition) ? condition : `success() && (${condition})`;
    return truthy(evaluate(expression, context));
}
