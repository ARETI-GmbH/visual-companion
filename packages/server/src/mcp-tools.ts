import { request } from 'undici';

export class DaemonClient {
  constructor(private readonly port: number) {}

  async call(endpoint: string, body: any): Promise<any> {
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

  async ping(): Promise<boolean> {
    try {
      const resp = await request(`http://localhost:${this.port}/_companion/health`, { method: 'GET' });
      return resp.statusCode === 200;
    } catch {
      return false;
    }
  }
}
