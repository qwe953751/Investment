// 說明泡泡：任何帶 data-hint 的元素，滑鼠停住就顯示說明，手機點一下也顯示。
//
// 原本用瀏覽器內建的 title，但它要滑鼠靜止約一秒才浮出來，稍微移動就不出現，
// 手機更是完全沒有辦法叫出來——等於在手機上看不到任何說明。
//
// 泡泡用 position: fixed 並自己算座標。表格標題在可橫向捲動的容器裡，
// 若用容器內的絕對定位，泡泡會被容器裁掉或跟著捲走。
//
// 這支檔案同時給 Blazor 頁面與靜態網站使用（見 Invest.Web.csproj 的 EmbeddedResource）。
(() => {
    const SELECTOR = '[data-hint]';
    const MARGIN = 8;
    const viewerAccess = (() => {
        const query = new URLSearchParams(window.location.search).get('access');
        const path = window.location.pathname.split('/').filter(Boolean).at(-1);

        return window.location.hostname.toLowerCase() === 'view.frank-investment.com'
            || query === 'viewer'
            || path === 'viewer';
    })();

    // 有滑鼠的裝置走 hover，沒有的走點擊。兩種同時開的話，
    // 手機上點一下排序標題會同時觸發排序與泡泡，顯得很吵。
    const canHover = window.matchMedia('(hover: hover)').matches;

    let bubble = null;
    let current = null;
    let timer = 0;

    function show(target) {
        const text = target.getAttribute('data-hint');

        if (!text) {
            return;
        }

        if (!bubble) {
            bubble = document.createElement('div');
            bubble.className = 'hint-bubble';
            document.body.appendChild(bubble);
        }

        current = target;
        bubble.textContent = text;
        bubble.classList.add('visible');

        const anchor = target.getBoundingClientRect();
        const size = bubble.getBoundingClientRect();

        const left = Math.max(
            MARGIN,
            Math.min(anchor.left, window.innerWidth - size.width - MARGIN));

        // 下方放不下就翻到上方，例如視窗底部的表格標題。
        const below = anchor.bottom + 6;
        const top = below + size.height > window.innerHeight - MARGIN
            ? anchor.top - size.height - 6
            : below;

        bubble.style.left = `${left}px`;
        bubble.style.top = `${top}px`;
    }

    function hide() {
        clearTimeout(timer);
        current = null;
        bubble?.classList.remove('visible');
    }

    function targetOf(event) {
        if (!(event.target instanceof Element)) {
            return null;
        }

        // 檢視權限只讓表格／列表表頭顯示說明；資料列、按鈕與篩選控制項
        // 即使留著 data-hint，也不在訪客連結顯示，避免把操作提示當成公開文件。
        if (viewerAccess) {
            const header = event.target.closest('th');
            return header?.matches(SELECTOR) ? header : null;
        }

        return event.target.closest(SELECTOR);
    }

    if (canHover) {
        document.addEventListener('pointerover', event => {
            const target = targetOf(event);

            if (target === current) {
                return;
            }

            hide();

            if (target) {
                // 稍微延遲，滑鼠只是掃過去時不要一路彈出泡泡。
                timer = setTimeout(() => show(target), 120);
            }
        });

        document.addEventListener('pointerout', event => {
            if (targetOf(event)) {
                hide();
            }
        });
    } else {
        document.addEventListener('click', event => {
            const target = targetOf(event);

            if (!target || target === current) {
                hide();
                return;
            }

            hide();
            show(target);
        });
    }

    // 頁面一捲動，泡泡的座標就過期了。
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
})();
