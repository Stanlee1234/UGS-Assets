const originalFetch = window.fetch;

function mergeFiles(fileParts) {
    return new Promise((resolve, reject) => {
        let buffers = [];

        function fetchOne(urls, iUrl = 0) {
            if (iUrl >= urls.length) return Promise.reject(new Error("Missing part: " + urls[0]));
            return originalFetch(urls[iUrl]).then((response) => {
                if (!response.ok) return fetchOne(urls, iUrl + 1);
                return response.arrayBuffer();
            });
        }

        function fetchPart(index) {
            if (index >= fileParts.length) {
                let mergedBlob = new Blob(buffers);
                let mergedFileUrl = URL.createObjectURL(mergedBlob);
                resolve(mergedFileUrl);
                return;
            }
            const part = fileParts[index];
            const urls = Array.isArray(part) ? part : [part];
            fetchOne(urls).then((data) => {
                buffers.push(data);
                fetchPart(index + 1);
            }).catch(reject);
        }
        fetchPart(0);
    });
}

function getParts(file, start, end) {
    let parts = [];
    for (let i = start; i <= end; i++) {
        const plain = file + ".part" + i;
        const padded = file + ".part" + String(i).padStart(2, "0");
        parts.push(plain === padded ? plain : [plain, padded]);
    }
    return parts;
}
Promise.all([
    mergeFiles(getParts("index.side.wasm", 1, 3))
]).then(([wasmUrl]) => {
    window.fetch = async function (url, ...args) {
        if (url.endsWith("index.side.wasm")) {
            return originalFetch(wasmUrl, ...args);
        } else {
            return originalFetch(url, ...args);
        }
    };
    window.godotRunStart();
});