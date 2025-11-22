

(function() {
  'use strict';

  const defaultConfig = {
    files: [],
    basePath: '',
    debug: false,
    autoDetect: false
  };

  const config = Object.assign({}, defaultConfig, window.fileMergerConfig || {});
  window.mergedFiles = window.mergedFiles || {};
  const mergeStatus = {};

  function log(...args) {
    if (config.debug) {
      console.log('[FileMerger]', ...args);
    }
  }

  function error(...args) {
    console.error('[FileMerger]', ...args);
  }

  function normalizeUrl(url) {
    try {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const decoded = decodeURIComponent(urlStr.split('?')[0]);
      return decoded;
    } catch (e) {
      return url;
    }
  }

  function urlsMatch(url1, url2) {
    const norm1 = normalizeUrl(url1);
    const norm2 = normalizeUrl(url2);
    
    if (norm1 === norm2) return true;
    
    if (norm1.endsWith(norm2) || norm2.endsWith(norm1)) return true;

    const base1 = norm1.split('/').pop();
    const base2 = norm2.split('/').pop();
    return base1 === base2;
  }

  async function mergeSplitFiles(filePath, numParts) {
    try {
      const parts = [];
      for (let i = 1; i <= numParts; i++) {
        parts.push(`${filePath}.part${i}`);
      }

      log(`Merging ${filePath} from ${numParts} parts...`);
      
      const responses = await Promise.all(
        parts.map(part => window.originalFetch(part))
      );
      
      for (let i = 0; i < responses.length; i++) {
        if (!responses[i].ok) {
          throw new Error(`Failed to load ${parts[i]}: ${responses[i].status}`);
        }
      }

      const buffers = await Promise.all(responses.map(r => r.arrayBuffer()));
      const totalSize = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
      const mergedArray = new Uint8Array(totalSize);
      
      let offset = 0;
      for (const buffer of buffers) {
        mergedArray.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
      }

      log(`✅ ${filePath} merged successfully: ${totalSize} bytes`);
      return mergedArray.buffer;
    } catch (err) {
      error(`Failed to merge ${filePath}:`, err);
      throw err;
    }
  }

  function shouldInterceptFile(url) {
    const urlStr = normalizeUrl(url);
    
    if (urlStr.includes('.part')) {
      return null;
    }

    for (const file of config.files) {
      const fileName = file.name;
      const fullPath = config.basePath ? `${config.basePath}${fileName}` : fileName;
      
      if (urlsMatch(urlStr, fileName) || urlsMatch(urlStr, fullPath)) {
        if (mergeStatus[fileName] === 'ready') {
          return fileName;
        }
      }
    }

    return null;
  }

  function getMergedFile(filename) {
    if (window.mergedFiles[filename]) {
      return window.mergedFiles[filename];
    }

    for (const [key, value] of Object.entries(window.mergedFiles)) {
      if (urlsMatch(key, filename)) {
        return value;
      }
    }

    return null;
  }

  if (!window.originalFetch) {
    window.originalFetch = window.fetch;
  }

  window.fetch = function(url, ...args) {
    const filename = shouldInterceptFile(url);
    
    if (filename) {
      log('Intercepting fetch for:', filename, 'from URL:', url);
      
      return new Promise((resolve, reject) => {
        const maxWait = 30000;
        const startTime = Date.now();
        
        const checkData = setInterval(() => {
          const buffer = getMergedFile(filename);
          
          if (buffer) {
            clearInterval(checkData);
            log('✅ Serving merged file via fetch:', filename, 'size:', buffer.byteLength);
            
            const contentType = filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
            
            resolve(new Response(buffer, {
              status: 200,
              statusText: 'OK',
              headers: {
                'Content-Type': contentType,
                'Content-Length': buffer.byteLength.toString()
              }
            }));
          } else if (Date.now() - startTime > maxWait) {
            clearInterval(checkData);
            reject(new Error(`Timeout waiting for merged file: ${filename}`));
          }
        }, 50);
      });
    }
    
    return window.originalFetch.call(this, url, ...args);
  };

  if (!window.OriginalXMLHttpRequest) {
    window.OriginalXMLHttpRequest = window.XMLHttpRequest;
  }

  window.XMLHttpRequest = function(options) {
    const xhr = new window.OriginalXMLHttpRequest(options);
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    let requestUrl = '';

    xhr.open = function(method, url, ...args) {
      requestUrl = url;
      return originalOpen.call(this, method, url, ...args);
    };

    xhr.send = function(...args) {
      const filename = shouldInterceptFile(requestUrl);
      
      if (filename) {
        log('Intercepting XMLHttpRequest for:', filename, 'from URL:', requestUrl);
        
        const waitForMerge = () => {
          const buffer = getMergedFile(filename);
          
          if (buffer) {
            log('✅ Serving merged file via XHR:', filename, 'size:', buffer.byteLength);
            
            const uint8Array = new Uint8Array(buffer);
            
            try {
              Object.defineProperty(xhr, 'response', { 
                get: function() { return uint8Array.buffer; },
                configurable: true
              });
              Object.defineProperty(xhr, 'responseType', {
                get: function() { return 'arraybuffer'; },
                configurable: true
              });
              Object.defineProperty(xhr, 'status', { 
                get: function() { return 200; },
                configurable: true
              });
              Object.defineProperty(xhr, 'statusText', {
                get: function() { return 'OK'; },
                configurable: true
              });
              Object.defineProperty(xhr, 'readyState', { 
                get: function() { return 4; },
                configurable: true
              });
            } catch (e) {
              error('Error setting XHR properties:', e);
            }
            
            setTimeout(() => {
              if (xhr.onprogress) {
                xhr.onprogress({ 
                  type: 'progress',
                  lengthComputable: true,
                  loaded: buffer.byteLength, 
                  total: buffer.byteLength
                });
              }
              
              if (xhr.onload) {
                const event = { 
                  type: 'load',
                  lengthComputable: true,
                  loaded: buffer.byteLength, 
                  total: buffer.byteLength,
                  target: xhr,
                  currentTarget: xhr
                };
                xhr.onload(event);
              }
              
              if (xhr.onreadystatechange) {
                xhr.onreadystatechange();
              }
            }, 10);
          } else {
            setTimeout(waitForMerge, 50);
          }
        };
        
        waitForMerge();
        return;
      }

      return originalSend.call(this, ...args);
    };

    return xhr;
  };

  Object.setPrototypeOf(window.XMLHttpRequest, window.OriginalXMLHttpRequest);
  Object.setPrototypeOf(window.XMLHttpRequest.prototype, window.OriginalXMLHttpRequest.prototype);

  async function autoMergeFiles() {
    if (config.files.length === 0) {
      log('No files configured for merging.');
      return;
    }

    try {
      log('Starting file merge for', config.files.length, 'file(s)...');
      
      const mergePromises = config.files.map(file => {
        const fullPath = config.basePath ? `${config.basePath}${file.name}` : file.name;
        mergeStatus[file.name] = 'merging';
        
        return mergeSplitFiles(fullPath, file.parts).then(buffer => {
          window.mergedFiles[file.name] = buffer;
          window.mergedFiles[fullPath] = buffer;
          
          const basename = file.name.split('/').pop();
          window.mergedFiles[basename] = buffer;

          window.mergedFiles[encodeURIComponent(file.name)] = buffer;
          window.mergedFiles[encodeURIComponent(fullPath)] = buffer;
          
          mergeStatus[file.name] = 'ready';
          return { name: file.name, size: buffer.byteLength };
        }).catch(err => {
          mergeStatus[file.name] = 'failed';
          error(`Failed to merge ${file.name}`);
          throw err;
        });
      });

      const results = await Promise.all(mergePromises);
      
      log('🎉 All files merged successfully!');
      results.forEach(result => {
        log(`📦 ${result.name}: ${result.size} bytes`);
      });

      window.dispatchEvent(new CustomEvent('filesMerged', { detail: results }));
      
    } catch (err) {
      error('❌ Some files failed to merge:', err);
    }
  }

  autoMergeFiles();

  window.fileMerger = {
    merge: mergeSplitFiles,
    config: config,
    getFile: getMergedFile,
    status: mergeStatus
  };

})();
