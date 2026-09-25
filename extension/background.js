// background.js - CDP-based Turnstile detection and clicking
const DEBUGGER_VERSION = "1.3";

async function attachDebuggerWithRetry(tabId, maxRetries = 3, retryDelay = 500) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // We wrap the callback-based attach function in a Promise
            // to use it with async/await.
            await new Promise((resolve, reject) => {
                chrome.debugger.attach({ tabId: tabId }, DEBUGGER_VERSION, () => {
                    if (chrome.runtime.lastError) {
                        // On failure, reject the promise to trigger the catch block.
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        // On success, resolve the promise to continue execution.
                        resolve();
                    }
                });
            });
            
            return; // Exit successfully

        } catch (error) {
            console.warn(`[CDP] Attempt ${attempt}/${maxRetries} to attach debugger failed: ${error.message}`);
            if (attempt < maxRetries) {
                // Wait before trying again
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
                // If all retries fail, throw the final error to be caught by the caller.
                throw new Error(`Failed to attach debugger after ${maxRetries} attempts.`);
            }
        }
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Ensure this is our action and it contains the required data
    if (request.action === "detectAndClickTurnstile" && request.payload) {
        const tabId = sender.tab.id;
        (async () => {
            try {
                // 1. Attempt to attach the debugger with retries
                await attachDebuggerWithRetry(tabId);
                const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);

                await send("Page.enable");    // Suggested: obtain navigation/load events
                await send("Runtime.enable"); // Suggested: Runtime.* may be used later
                await send("DOM.enable");     // Critical: enable the DOM domain
                // 2. If attachment is successful, run your main logic
                const clickResult = await findIframeAndClickAtRatio(tabId, request.payload);
                sendResponse(clickResult);

            } catch (error) {
                // This will catch errors from both attachment and your main logic
                console.error('[CDP] A critical error occurred:', error);
                sendResponse({ success: false, error: error.message });
            } finally {
                // 3. IMPORTANT: Always detach the debugger when done
                chrome.debugger.detach({ tabId: tabId }, () => {});
            }
        })();

        return true; // Keep the message channel open for asynchronous response
    }
});

async function findIframeAndClickAtRatio(tabId, payload) {
    const { xRatio, yRatio } = payload;
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let i = 0; i < maxRetries; i++) {
        try {
            function getAttr(attrs, name) {
                if (!attrs) return undefined;
                for (let i = 0; i < attrs.length; i += 2) {
                    if (attrs[i] === name) return attrs[i + 1];
                }
            }
            // Step 1: Get document root
            const { nodes } = await chrome.debugger.sendCommand({ tabId }, "DOM.getFlattenedDocument", {
                depth: -1,
                pierce: true
            });

            // Find the Cloudflare/Turnstile iframe (match by src; you may also use title, etc.)
            const iframeNode = nodes.find(n => {
                if (n.nodeName !== 'IFRAME') return false;
                const src = getAttr(n.attributes, 'src') || '';
                return src.includes('challenges.cloudflare.com');
            });
            if (!iframeNode) throw new Error('Turnstile iframe not found in flattened document');

            const { model: iframeBox } = await chrome.debugger.sendCommand({ tabId }, "DOM.getBoxModel", {
                nodeId: iframeNode.nodeId
            });

            // Step 3: Compute exact absolute coordinates using the provided ratios
            const [x_start, y_start, , , x_end, y_end] = iframeBox.content;
            const iframeWidth = x_end - x_start;
            const iframeHeight = y_end - y_start;
            const clickX = x_start + (iframeWidth * xRatio);
            const clickY = y_start + (iframeHeight * yRatio);
            
            // Step 4: Perform the click at the exact coordinates
            // 先等一会：复选框刚渲染完毕时 CF 还在采集环境遥测，立刻点击会被打低分
            await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 1500));
            await clickAtCoordinates(tabId, clickX, clickY);
            return { success: true };

        } catch (error) {
            console.warn(`[CDP] Attempt ${i + 1} error:`, error.message || error);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    return { success: false, error: 'Failed to find and click iframe after all retries' };
}


/**
 * Creates a temporary red dot at the specified coordinates for debugging.
 */
async function showClickIndicator(tabId, x, y) {
    const expression = `
        (function() {
            const indicator = document.createElement('div');
            indicator.id = 'cdp-click-indicator';
            Object.assign(indicator.style, {
                position: 'absolute',
                left: '${x - 5}px',
                top: '${y - 5}px',
                width: '10px',
                height: '10px',
                backgroundColor: 'red',
                borderRadius: '50%',
                zIndex: '2147483647',
                pointerEvents: 'none'
            });
            document.body.appendChild(indicator);
            console.log('[CDP Debug] Click indicator shown at (${x}, ${y})');
            setTimeout(() => {
                indicator.remove();
                console.log('[CDP Debug] Click indicator removed.');
            }, 2000); // Keep visible for 2 seconds
        })();
    `;
    await chrome.debugger.sendCommand(
        { tabId: tabId },
        "Runtime.evaluate",
        { expression: expression }
    );
}

/**
 * Click at coordinates using CDP Input.dispatchMouseEvent
 *
 * 人类化改造（关键）：裸的「坐标瞬移点击」会被 Cloudflare Turnstile 的行为模型
 * 判定为机器人（用户实测：点击后立刻 Verification failed）。现在改为：
 *   1. 从左上方随机起点出发，沿带微弧线的路径移动（18-30 步 mouseMoved）
 *   2. 每步带亚像素级抖动 + 8-30ms 随机步进节奏
 *   3. 到达目标后人类停顿 200-700ms
 *   4. 按下→保持 40-130ms→松开
 *   5. 落点加 ±2px 随机偏移（人类点不准中心）
 */
async function clickAtCoordinates(tabId, x, y) {
    // Show a visual indicator for the click
    // await showClickIndicator(tabId, x, y);

    const send = (params) => chrome.debugger.sendCommand({ tabId: tabId }, "Input.dispatchMouseEvent", params);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // 落点加微小随机偏移
    const tx = x + (Math.random() * 4 - 2);
    const ty = y + (Math.random() * 4 - 2);

    // 起点：左上方随机位置（模拟鼠标从页面别处移来，杜绝「瞬移」）
    const sx = Math.max(0, tx - 150 - Math.random() * 250);
    const sy = Math.max(0, ty - 80 - Math.random() * 180);

    // 分段移动（弧线 + 抖动 + 随机节奏）
    const steps = 18 + Math.floor(Math.random() * 12);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const jx = (Math.random() - 0.5) * 1.6;
        const jy = (Math.random() - 0.5) * 1.6;
        const arc = Math.sin(t * Math.PI) * (Math.random() * 24 - 12); // 轻微弧线
        const cx = sx + (tx - sx) * t + jx;
        const cy = sy + (ty - sy) * t + jy + arc;
        await send({ type: "mouseMoved", x: cx, y: cy, button: "none", buttons: 0 });
        await sleep(8 + Math.random() * 22);
    }

    // 到达后的人类停顿（让 CF 采集「悬停」遥测）
    await sleep(200 + Math.random() * 500);

    // 人类节奏的按下/松开
    await send({ type: "mousePressed", x: tx, y: ty, button: "left", buttons: 1, clickCount: 1 });
    await sleep(40 + Math.random() * 90);
    await send({ type: "mouseReleased", x: tx, y: ty, button: "left", buttons: 0, clickCount: 1 });
}