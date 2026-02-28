const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.use(cors());

// --- ROUTE 1: API KIỂM TRA BĂNG THÔNG ---
app.get('/api/test-bandwidth', async (req, res) => {
    try {
        const m3u8Url = req.query.url;
        const concurrency = parseInt(req.query.concurrency) || 20;

        if (!m3u8Url) {
            return res.status(400).json({ error: 'Thiếu tham số url (m3u8Url)' });
        }

        console.log(`\n🌐 [ĐANG XỬ LÝ REQUEST TEST BĂNG THÔNG] Link: ${m3u8Url}`);

        let currentUrl = m3u8Url;
        let baseUrl = new URL('.', currentUrl).href;

        const pingStart = Date.now();
        let response = await fetch(currentUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': baseUrl
            }
        });
        if (!response.ok) throw new Error(`Lỗi kết nối: ${response.status}`);
        const initialPing = Date.now() - pingStart;

        let m3u8Text = await response.text();

        if (m3u8Text.includes('#EXT-X-STREAM-INF')) {
            const lines = m3u8Text.split('\n');
            let subPlaylistUrl = '';
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF') && i + 1 < lines.length) {
                    const nextLine = lines[i + 1].trim();
                    if (nextLine && !nextLine.startsWith('#')) {
                        subPlaylistUrl = new URL(nextLine, baseUrl).href;
                        break;
                    }
                }
            }
            if (subPlaylistUrl) {
                currentUrl = subPlaylistUrl;
                baseUrl = new URL('.', currentUrl).href;
                response = await fetch(currentUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', 'Referer': baseUrl }
                });
                m3u8Text = await response.text();
            }
        }

        const lines = m3u8Text.split('\n');
        const segmentUrls = [];

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            segmentUrls.push(new URL(line, baseUrl).href);
        }

        const startTime = Date.now();
        let totalBytes = 0;
        let downloadedSegments = 0;
        let failedSegments = 0;
        let totalLatencyMs = 0;

        const segmentsToTest = segmentUrls.slice(0, 100);

        for (let i = 0; i < segmentsToTest.length; i += concurrency) {
            const chunk = segmentsToTest.slice(i, i + concurrency);
            const promises = chunk.map(async (url) => {
                const reqStart = Date.now();
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);
                    const res = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeoutId);

                    if (!res.ok) { failedSegments++; return; }

                    totalLatencyMs += (Date.now() - reqStart);
                    const buffer = await res.arrayBuffer();
                    totalBytes += buffer.byteLength;
                    downloadedSegments++;
                } catch (err) {
                    failedSegments++;
                }
            });
            await Promise.all(promises);
        }

        const totalElapsed = (Date.now() - startTime) / 1000;
        const avgSpeedMBps = (totalBytes / (1024 * 1024)) / Math.max(totalElapsed, 0.001);
        const finalAvgPing = downloadedSegments > 0 ? Math.round(totalLatencyMs / downloadedSegments) : 0;

        return res.json({
            status: 'success',
            testCount: segmentsToTest.length,
            totalSegments: segmentUrls.length,
            timeElapsedSec: parseFloat(totalElapsed.toFixed(2)),
            downloadedMB: parseFloat((totalBytes / (1024 * 1024)).toFixed(2)),
            speedMBps: parseFloat(avgSpeedMBps.toFixed(2)),
            speedMbps: parseFloat((avgSpeedMBps * 8).toFixed(2)),
            pingBanDau: initialPing,
            pingTrungBinh: finalAvgPing,
            failedSegments,
            networkStatus: finalAvgPing > 300 || failedSegments > 0 ? 'Kém (Nghẽn/Rớt gói)' : (finalAvgPing > 100 ? 'Trung bình' : 'Tốt')
        });

    } catch (error) {
        console.error('Lỗi API Test:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- ROUTE 2: ĐÓNG VAI TRÒ NHƯ 1 STREAMING PROXY (BYPASS CORS / IP MÁY CHỦ) ---
app.get('/api/stream', async (req, res) => {
    try {
        const m3u8Url = req.query.url || "https://vip.opstream90.com/20260228/26067_e1d55a1c/index.m3u8";
        if (!m3u8Url) return res.status(400).send('Thiếu tham số url');

        let currentUrl = m3u8Url;
        let baseUrl = new URL('.', currentUrl).href;

        let response = await fetch(currentUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': baseUrl
            }
        });

        if (response.ok === false) return res.status(response.status).send('Lỗi từ máy chủ nguồn (Bị chặn hoặc URL hỏng)');
        let m3u8Text = await response.text();

        // Xử lý Master Playlist nếu có (Tự follow sub-playlist)
        if (m3u8Text.includes('#EXT-X-STREAM-INF')) {
            const lines = m3u8Text.split('\n');
            let subPlaylistUrl = '';
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF') && i + 1 < lines.length) {
                    const nextLine = lines[i + 1].trim();
                    if (nextLine && nextLine.startsWith('#') === false) {
                        subPlaylistUrl = new URL(nextLine, baseUrl).href;
                        break;
                    }
                }
            }
            if (subPlaylistUrl) {
                currentUrl = subPlaylistUrl;
                baseUrl = new URL('.', currentUrl).href;
                response = await fetch(currentUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', 'Referer': baseUrl }
                });
                m3u8Text = await response.text();
            }
        }

        // Tạo thư mục tạm cache_hls
        const cacheDir = __dirname + '/cache_hls';
        await fs.mkdir(cacheDir, { recursive: true });

        const lines = m3u8Text.split('\n');
        const rewrittenLines = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) {
                rewrittenLines.push('');
                continue;
            }

            if (line.startsWith('#EXT-X-KEY')) {
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch && uriMatch[1].startsWith('http') === false) {
                    const keyUrl = new URL(uriMatch[1], baseUrl).href;
                    const proxyKeyUrl = `/api/proxy-ts?url=${encodeURIComponent(keyUrl)}`;
                    rewrittenLines.push(line.replace(`URI="${uriMatch[1]}"`, `URI="${proxyKeyUrl}"`));
                    continue;
                }
            }

            if (line.startsWith('#') || !line) {
                rewrittenLines.push(line);
            } else {
                const absoluteSegmentUrl = line.startsWith('http') ? line : new URL(line, baseUrl).href;
                if (absoluteSegmentUrl.includes('.m3u8')) {
                    rewrittenLines.push(`/api/stream?url=${encodeURIComponent(absoluteSegmentUrl)}`);
                } else {
                    rewrittenLines.push(`/api/proxy-ts?url=${encodeURIComponent(absoluteSegmentUrl)}`);
                }
            }
        }

        const finalM3u8Content = rewrittenLines.join('\n');

        // 💾 GHI FILE XUỐNG CỨNG TRÊN VPS (Tránh lỗi Memory/Client đứt kết nối sớm)
        const fileHash = Math.abs(currentUrl.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0));
        const localM3u8Path = path.join(cacheDir, `${fileHash}-index.m3u8`);
        await fs.writeFile(localM3u8Path, finalM3u8Content, 'utf-8');

        // Phục vụ ngược lại File đó cho trình duyệt yêu cầu
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.sendFile(localM3u8Path);

    } catch (error) {
        console.error('Lỗi API Stream:', error);
        res.status(500).send('Proxy Server Error');
    }
});

// ROUTE 3: Trả byte Array buffer cho file TS (Nhập luồng Video)
app.get('/api/proxy-ts', async (req, res) => {
    try {
        const tsUrl = req.query.url;
        if (!tsUrl) return res.status(400).send('No segment url provided');

        const response = await fetch(tsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': tsUrl
            }
        });
        if (!response.ok) return res.status(response.status).send('Downstream server error');

        // Báo cho client kiểu nội dung là Segment Transport Stream
        res.setHeader('Content-Type', 'video/mp2t');

        if (response.body.pipe) {
            response.body.pipe(res);
        } else {
            // Fallback:
            const arrayBuf = await response.arrayBuffer();
            res.end(Buffer.from(arrayBuf));
        }

    } catch (err) {
        res.status(500).end();
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 [EXPRESS M3U8 STREAM & PROXY]`);
    console.log(`✅ Server đang chạy tại: http://localhost:${PORT}`);
    console.log(`----------------------------------------`);
    console.log(`[ROUTE 1 - TEST MẠNG] (Chạy max 100 phân đoạn mẫu)`);
    console.log(`=> GET /api/test-bandwidth?url=<M3U8_URL>&concurrency=20`);
    console.log(`[ROUTE 2 - STREAM PROXY]`);
    console.log(`=> GET /api/stream?url=<M3U8_URL>`);
    console.log(`========================================`);
});
