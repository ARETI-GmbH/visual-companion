export declare class DaemonClient {
    private readonly port;
    constructor(port: number);
    call(endpoint: string, body: any): Promise<any>;
    ping(): Promise<boolean>;
}
