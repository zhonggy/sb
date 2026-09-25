// Ensure this runs only inside the target iframe
if (window.top !== window.self && window.location.href.includes('challenges.cloudflare.com')) {
    // 1. Listen for messages from injected.js (MAIN world)
    window.addEventListener('message', (event) => {
        if (event.source === window && event.data && event.data.type === 'CHECKBOX_POSITION_RATIO') {  
            const { xRatio, yRatio } = event.data.payload;
            chrome.runtime.sendMessage({
                action: "detectAndClickTurnstile",
                // Include the position ratio data in the payload
                payload: {
                    xRatio: xRatio,
                    yRatio: yRatio
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('CONTENT SCRIPT (ISOLATED): Error sending message:', chrome.runtime.lastError.message);
                } 
            });
        }
    }, false);
}