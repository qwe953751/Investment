// 封鎖外部寫入；只允許本機 C# 計算與使用者要求的固定金流估值帳本。
const previewNativeFetch = window.fetch.bind(window);
window.fetch = (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = String(options.method ?? input?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)
        && !(url.origin === location.origin && ['/preview/calculate','/preview/value-flows'].includes(url.pathname) && method === 'POST')) {
        return Promise.reject(new Error('本機唯讀樣版：已阻止寫入'));
    }
    return previewNativeFetch(input, options);
};
