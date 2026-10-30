import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const redirects = require('follow-redirects') as {
    http: { request: (options: RequestOptions & { sensitiveHeaders?: string[] }, callback: (response: IncomingMessage) => void) => {
        on: (event: string, listener: (error: Error) => void) => void;
        setTimeout: (ms: number, callback: () => void) => void;
        destroy: (error: Error) => void;
        end: () => void;
    } };
};

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    return address.port;
}

async function redirectFixture(headers: RequestOptions['headers'], sensitiveHeaders: string[]) {
    let originalHeaders: IncomingHttpHeaders | undefined;
    let targetRequests = 0;
    const target = createServer((request, response) => {
        targetRequests += 1;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.headers));
    });
    const origin = createServer((request, response) => {
        originalHeaders = request.headers;
        response.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/fixture` });
        response.end();
    });
    let targetPort = 0;
    try {
        targetPort = await listen(target);
        const originPort = await listen(origin);
        const received = await new Promise<IncomingHttpHeaders>((resolve, reject) => {
            const requestHeaders = Array.isArray(headers) ? ['Host', `127.0.0.1:${originPort}`, ...headers] : headers;
            const request = redirects.http.request({ hostname: '127.0.0.1', port: originPort, path: '/',
                headers: requestHeaders, sensitiveHeaders }, response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.on('error', reject);
                response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
            });
            request.on('error', reject);
            request.setTimeout(2000, () => request.destroy(new Error('Local redirect fixture timed out')));
            request.end();
        });
        return { received, originalHeaders, targetRequests };
    } finally {
        await Promise.all([origin, target].map(server => new Promise<void>(resolve => {
            server.closeAllConnections();
            if (server.listening) server.close(() => resolve());
            else resolve();
        })));
    }
}

test('patched redirects strip credential headers from array-form cross-origin requests', async () => {
    const result = await redirectFixture([
        'Authorization', 'Bearer fixture-only', 'Cookie', 'fixture=only',
        'Proxy-Authorization', 'Basic fixture-only', 'X-Local-Control', 'kept',
    ], []);
    assert.equal(result.originalHeaders?.authorization, 'Bearer fixture-only');
    assert.equal(result.targetRequests, 1);
    assert.equal(result.received.authorization, undefined);
    assert.equal(result.received.cookie, undefined);
    assert.equal(result.received['proxy-authorization'], undefined);
    assert.equal(result.received['x-local-control'], 'kept');
});

test('patched redirects strip declared sensitive headers containing regex characters', async () => {
    const result = await redirectFixture({
        'X-Api^Key': 'fixture-only', 'X-Token|Secret': 'fixture-only',
        'X-Control-Key': 'fixture-only', 'X-Local-Control': 'kept',
    }, ['X-Api^Key', 'X-Token|Secret', 'X-Control-Key']);
    assert.equal(result.originalHeaders?.['x-api^key'], 'fixture-only');
    assert.equal(result.originalHeaders?.['x-token|secret'], 'fixture-only');
    assert.equal(result.targetRequests, 1);
    for (const key of ['x-api^key', 'x-token|secret', 'x-control-key']) assert.equal(result.received[key], undefined);
    assert.equal(result.received['x-local-control'], 'kept');
});

test('patched IPv6 validation rejects adversarial zone identifiers without stalling the process', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import assert from 'node:assert/strict'; import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const {Address6}=require('ip-address'); assert.equal(Address6.isValid('%'.repeat(100000)+'\\n'),false); assert.equal(Address6.isValid('::1'),true);"],
    { cwd: process.cwd(), timeout: 2000, encoding: 'utf8', windowsHide: true });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
});
