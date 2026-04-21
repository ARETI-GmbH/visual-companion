import { request } from 'undici';
export class DaemonClient {
    port;
    constructor(port) {
        this.port = port;
    }
    async call(endpoint, body) {
        const resp = await request(`http://localhost:${this.port}${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });
        if (resp.statusCode >= 400) {
            const text = await resp.body.text();
            throw new Error(`Daemon error ${resp.statusCode}: ${text}`);
        }
        return await resp.body.json();
    }
    async ping() {
        try {
            const resp = await request(`http://localhost:${this.port}/_companion/health`, { method: 'GET' });
            return resp.statusCode === 200;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=mcp-tools.js.map