import express from "express";
import { generateUUID } from "./utils.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { getServer } from "./server.js";
import { config } from "./config.js";
import { authorizationHeaderName } from "./const.js";

export function startStreamableHTTP() {
    const app = express();
    app.use(express.json());

    // Map to store transports by session ID
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    // Handle POST requests for client-to-server communication

    app.post('/mcp', async (req, res) => {
        // Inspector adds "Bearer" to the authorization header, so we need to strip it 
        const authHeaderValue = (req.headers[authorizationHeaderName] as string ?? "")
            .replace(/Bearer\s+/i, '');
        if (config.authorizationHeader === "" ||
            config.authorizationHeader === authHeaderValue
        ) {
            // Check for existing session ID
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transports[sessionId]) {
                // Reuse existing transport
                transport = transports[sessionId];
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // New initialization request
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => generateUUID(),
                    onsessioninitialized: (sessionId) => {
                        // Store the transport by session ID
                        transports[sessionId] = transport;
                    }
                });

                // Clean up transport when closed
                transport.onclose = () => {
                    if (transport.sessionId) {
                        delete transports[transport.sessionId];
                    }
                };
                const server = await getServer(config);

                await server.connect(transport);
            } else {
                // Invalid request
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided',
                    },
                    id: null,
                });
                return;
            }

            // Handle the request
            await transport.handleRequest(req, res, req.body);
        } else {
            res.status(401).send('Unauthorized');
        }
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
        const authHeaderValue = (req.headers[authorizationHeaderName] as string ?? "")
            .replace(/Bearer\s+/i, '');

        if (config.authorizationHeader === "" ||
            config.authorizationHeader === authHeaderValue) {



            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            if (!sessionId || !transports[sessionId]) {
                res.status(400).send('Invalid or missing session ID');
                return;
            }

            const transport = transports[sessionId];
            await transport.handleRequest(req, res);
        } else {
            res.status(401).send('Unauthorized');
        }
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', handleSessionRequest);

    // Handle DELETE requests for session termination
    app.delete('/mcp', handleSessionRequest);

    // JSON 404 fallback for unknown routes. Some MCP clients (e.g. Claude Code)
    // probe OAuth discovery endpoints such as /.well-known/oauth-protected-resource,
    // /.well-known/oauth-authorization-server and /register. If these return
    // Express's default HTML 404, the client's OAuth code crashes trying to parse
    // HTML as JSON ("Unrecognized token '<'"). Returning JSON 404 lets the client
    // gracefully conclude the server is unauthenticated.
    app.use((_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    app.listen(3001);
}