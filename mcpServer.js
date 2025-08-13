require('dotenv').config();
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const fs = require('fs');
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
// Check for .env file and required variables
if (!fs.existsSync('.env')) {
  console.error('Error: .env file not found. Please create it with GETH_URL set.');
  process.exit(1);
}
if (!process.env.GETH_URL) {
  console.error('Error: GETH_URL not set in .env. Please fix and restart.');
  process.exit(1);
}
// Shared McpServer instance (tools registered once)
const mcpServer = new McpServer({
  name: 'geth-mcp-proxy',
  version: '1.1.0',
  description: 'Proxy for Ethereum JSON-RPC queries via Geth endpoint'
});
// Maintain our own registry of tool names + schemas + handlers (SDK doesn't expose a stable public map)
const registeredToolNames = [];
const registeredToolSchemas = {};
const registeredToolHandlers = {};
function normalizeToolName(name) {
  return String(name || '')
}
function registerTool(name, schema, handler, jsonSchema) {
  const safeName = normalizeToolName(name);
  if (safeName !== name) {
    console.warn(`[mcpServer] Normalizing tool name "${name}" -> "${safeName}" to satisfy [a-z0-9_-]`);
  }
  registeredToolNames.push(safeName);
  if (jsonSchema) registeredToolSchemas[safeName] = { inputSchema: jsonSchema, description: schema.description };
  registeredToolHandlers[safeName] = { handler, schema };
  mcpServer.registerTool(safeName, schema, handler); // Keep SDK registration for future streaming use
}
/**
 * Perform JSON-RPC query to Geth endpoint.
 * @param {string} method - The RPC method name.
 * @param {Array} params - The parameters for the RPC call.
 * @returns {Promise<any>} The result from the RPC call.
 */
async function queryGeth(method, params) {
  const { GETH_URL } = process.env;
  if (!GETH_URL) {
    throw new Error('Missing GETH_URL in environment');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  // Normalize URL to avoid accidental double slashes
  let normalized = GETH_URL;
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  const url = normalized;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
    signal: controller.signal
  }).catch(e => {
    if (e.name === 'AbortError') throw new Error('Upstream request timed out');
    throw e;
  });
  clearTimeout(timeout);
  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Geth error: ${data.error.message}`);
  }
  return data.result;
}
/**
 * Convert hex string to decimal string if valid, otherwise return null.
 * @param {string} hex - The hex string to convert.
 * @returns {string|null} The decimal string or null.
 */
function hexToDecimalMaybe(hex) {
  if (typeof hex === 'string' && /^0x[0-9a-fA-F]+$/.test(hex)) {
    try {
      return BigInt(hex).toString();
    } catch {
      return null;
    }
  }
  return null;
}
/**
 * Tool: Retrieve the current block number in hex and decimal formats.
 */
registerTool(
  'getBlockNumber',
  { description: 'Retrieve the current block number (hex + decimal).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_blockNumber', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ blockNumberHex: hex, blockNumberDecimal: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Alias for getBlockNumber.
 */
registerTool(
  'eth_getBlockNumber',
  { description: 'Alias of getBlockNumber.', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_blockNumber', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ blockNumberHex: hex, blockNumberDecimal: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Get the balance of an address in hex and decimal formats.
 */
registerTool(
  'getBalance',
  { description: 'Get balance of an address (hex + decimal).', inputSchema: z.object({ address: z.string(), block: z.string().optional() }) },
  async ({ address, block = 'latest' }) => {
    const hex = await queryGeth('eth_getBalance', [address, block]); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ address, balanceHex: hex, balanceWei: dec }) }] };
  },
  { type: 'object', properties: { address: { type: 'string' }, block: { type: 'string' } }, required: ['address'], additionalProperties: false }
);
/**
 * Tool: Alias for getBalance.
 */
registerTool(
  'eth_getBalance',
  { description: 'Alias of getBalance.', inputSchema: z.object({ address: z.string(), block: z.string().optional() }) },
  async ({ address, block = 'latest' }) => {
    const hex = await queryGeth('eth_getBalance', [address, block]); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ address, balanceHex: hex, balanceWei: dec }) }] };
  },
  { type: 'object', properties: { address: { type: 'string' }, block: { type: 'string' } }, required: ['address'], additionalProperties: false }
);
/**
 * Tool: Generic passthrough for any Ethereum JSON-RPC method.
 */
registerTool(
  'ethCallRaw',
  { description: 'Call any Ethereum JSON-RPC method with params array.', inputSchema: z.object({ method: z.string(), params: z.array(z.any()).default([]) }) },
  async ({ method, params }) => {
    const result = await queryGeth(method, params);
    return { content: [{ type: 'text', text: JSON.stringify({ method, params, result }) }] };
  },
  { type: 'object', properties: { method: { type: 'string' }, params: { type: 'array' } }, required: ['method'], additionalProperties: false }
);
/**
 * Tool: Check if the node is syncing.
 */
registerTool(
  'eth_isSyncing',
  { description: 'Check if the node is syncing.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('eth_syncing', []);
    return { content: [{ type: 'text', text: JSON.stringify({ syncing: result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Get the current chain ID in hex and decimal formats.
 */
registerTool(
  'eth_chainId',
  { description: 'Get current chain ID (hex + decimal).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_chainId', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ chainIdHex: hex, chainIdDecimal: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Get the current gas price in hex and wei decimal formats.
 */
registerTool(
  'eth_gasPrice',
  { description: 'Get current gas price (hex + wei decimal).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_gasPrice', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ gasPriceHex: hex, gasPriceWei: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Fetch a block by number or tag.
 */
registerTool(
  'eth_getBlockByNumber',
  { description: 'Fetch block by number/tag.', inputSchema: z.object({ block: z.string(), full: z.boolean().optional() }) },
  async ({ block, full = false }) => {
    const result = await queryGeth('eth_getBlockByNumber', [block, full]);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
  { type: 'object', properties: { block: { type: 'string' }, full: { type: 'boolean' } }, required: ['block'], additionalProperties: false }
);
/**
 * Tool: Alias for eth_getBlockByNumber.
 */
registerTool(
  'getBlockByNumber',
  { description: 'Fetch block by number/tag (alias of eth_getBlockByNumber).', inputSchema: z.object({ block: z.string(), full: z.boolean().optional() }) },
  async ({ block, full = false }) => {
    const result = await queryGeth('eth_getBlockByNumber', [block, full]);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
  { type: 'object', properties: { block: { type: 'string' }, full: { type: 'boolean' } }, required: ['block'], additionalProperties: false }
);
/**
 * Tool: Fetch a transaction by hash.
 */
registerTool(
  'eth_getTransactionByHash',
  { description: 'Fetch a transaction by hash.', inputSchema: z.object({ hash: z.string() }) },
  async ({ hash }) => {
    const result = await queryGeth('eth_getTransactionByHash', [hash]);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'], additionalProperties: false }
);
/**
 * Tool: Alias for eth_getTransactionByHash.
 */
registerTool(
  'getTransactionByHash',
  { description: 'Fetch a transaction by hash (alias of eth_getTransactionByHash).', inputSchema: z.object({ hash: z.string() }) },
  async ({ hash }) => {
    const result = await queryGeth('eth_getTransactionByHash', [hash]);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'], additionalProperties: false }
);
/**
 * Tool: Execute a call without creating a transaction.
 */
registerTool(
  'eth_call',
  { description: 'Execute a call without a transaction.', inputSchema: z.object({ to: z.string(), data: z.string(), block: z.string().optional() }) },
  async ({ to, data, block = 'latest' }) => {
    const result = await queryGeth('eth_call', [{ to, data }, block]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { to: { type: 'string' }, data: { type: 'string' }, block: { type: 'string' } }, required: ['to','data'], additionalProperties: false }
);
/**
 * Tool: Alias for eth_call.
 */
registerTool(
  'call',
  { description: 'Execute a call without a transaction (alias of eth_call).', inputSchema: z.object({ to: z.string(), data: z.string(), block: z.string().optional() }) },
  async ({ to, data, block = 'latest' }) => {
    const result = await queryGeth('eth_call', [{ to, data }, block]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { to: { type: 'string' }, data: { type: 'string' }, block: { type: 'string' } }, required: ['to','data'], additionalProperties: false }
);
/**
 * Tool: Estimate gas for a transaction.
 */
registerTool(
  'eth_estimateGas',
  { description: 'Estimate gas for a transaction.', inputSchema: z.object({ to: z.string().optional(), from: z.string().optional(), data: z.string().optional(), value: z.string().optional() }) },
  async (tx) => {
    const result = await queryGeth('eth_estimateGas', [tx]); const dec = hexToDecimalMaybe(result);
    return { content: [{ type: 'text', text: JSON.stringify({ gasHex: result, gasDecimal: dec }) }] };
  },
  { type: 'object', properties: { to: { type: 'string' }, from: { type: 'string' }, data: { type: 'string' }, value: { type: 'string' } }, additionalProperties: false }
);
/**
 * Tool: Alias for eth_estimateGas.
 */
registerTool(
  'estimateGas',
  { description: 'Estimate gas for a transaction (alias of eth_estimateGas).', inputSchema: z.object({ to: z.string().optional(), from: z.string().optional(), data: z.string().optional(), value: z.string().optional() }) },
  async (tx) => {
    const result = await queryGeth('eth_estimateGas', [tx]); const dec = hexToDecimalMaybe(result);
    return { content: [{ type: 'text', text: JSON.stringify({ gasHex: result, gasDecimal: dec }) }] };
  },
  { type: 'object', properties: { to: { type: 'string' }, from: { type: 'string' }, data: { type: 'string' }, value: { type: 'string' } }, additionalProperties: false }
);
/**
 * Tool: Broadcast a signed raw transaction. Requires ALLOW_SEND_RAW_TX=1.
 */
registerTool(
  'eth_sendRawTransaction',
  { description: 'Broadcast a signed raw transaction (hex). WARNING: ensure the tx is trusted.', inputSchema: z.object({ rawTx: z.string() }) },
  async ({ rawTx }) => {
    if (!process.env.ALLOW_SEND_RAW_TX) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Disabled. Set ALLOW_SEND_RAW_TX=1 to enable.' }) }] };
    }
    const hash = await queryGeth('eth_sendRawTransaction', [rawTx]);
    return { content: [{ type: 'text', text: JSON.stringify({ txHash: hash }) }] };
  },
  { type: 'object', properties: { rawTx: { type: 'string' } }, required: ['rawTx'], additionalProperties: false }
);
/**
 * Tool: Alias for eth_sendRawTransaction.
 */
registerTool(
  'sendRawTransaction',
  { description: 'Broadcast a signed raw transaction (alias of eth_sendRawTransaction).', inputSchema: z.object({ rawTx: z.string() }) },
  async ({ rawTx }) => {
    if (!process.env.ALLOW_SEND_RAW_TX) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Disabled. Set ALLOW_SEND_RAW_TX=1 to enable.' }) }] };
    }
    const hash = await queryGeth('eth_sendRawTransaction', [rawTx]);
    return { content: [{ type: 'text', text: JSON.stringify({ txHash: hash }) }] };
  },
  { type: 'object', properties: { rawTx: { type: 'string' } }, required: ['rawTx'], additionalProperties: false }
);
/**
 * Tool: Alias for eth_chainId.
 */
registerTool(
  'chainId',
  { description: 'Get current chain ID (alias of eth_chainId).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_chainId', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ chainIdHex: hex, chainIdDecimal: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Alias for eth_gasPrice.
 */
registerTool(
  'gasPrice',
  { description: 'Get current gas price (alias of eth_gasPrice).', inputSchema: z.object({}) },
  async () => {
    const hex = await queryGeth('eth_gasPrice', []); const dec = hexToDecimalMaybe(hex);
    return { content: [{ type: 'text', text: JSON.stringify({ gasPriceHex: hex, gasPriceWei: dec }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Alias for eth_isSyncing.
 */
registerTool(
  'isSyncing',
  { description: 'Check if the node is syncing (alias of eth_isSyncing).', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('eth_syncing', []);
    return { content: [{ type: 'text', text: JSON.stringify({ syncing: result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Exports the current blockchain into a local file. Optionally takes first and last block number.
 */
registerTool(
  'admin_exportChain',
  { description: 'Exports the current blockchain into a local file. It optionally takes a first and last block number, in which case it exports only that range of blocks. It returns a boolean indicating whether the operation succeeded.', inputSchema: z.object({ file: z.string(), first: z.number().optional(), last: z.number().optional() }) },
  async ({ file, first, last }) => {
    const params = [file];
    if (first !== undefined) params.push(first);
    if (last !== undefined) params.push(last);
    const result = await queryGeth('admin_exportChain', params);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' }, first: { type: 'number' }, last: { type: 'number' } }, required: ['file'], additionalProperties: false }
);
/**
 * Tool: Imports an exported list of blocks from a local file.
 */
registerTool(
  'admin_importChain',
  { description: 'Imports an exported list of blocks from a local file. Importing involves processing the blocks and inserting them into the canonical chain. The state from the parent block of this range is required. It returns a boolean indicating whether the operation succeeded.', inputSchema: z.object({ file: z.string() }) },
  async ({ file }) => {
    const result = await queryGeth('admin_importChain', [file]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }
);
/**
 * Tool: Retrieves node information.
 */
registerTool(
  'admin_nodeInfo',
  { description: 'The nodeInfo administrative property can be queried for all the information known about the running Geth node at the networking granularity. These include general information about the node itself as a participant of the ÐΞVp2p P2P overlay protocol, as well as specialized information added by each of the running application protocols (e.g. eth, les, shh, bzz).', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('admin_nodeInfo', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Retrieves connected peers information.
 */
registerTool(
  'admin_peers',
  { description: 'The peers administrative property can be queried for all the information known about the connected remote nodes at the networking granularity. These include general information about the nodes themselves as participants of the ÐΞVp2p P2P overlay protocol, as well as specialized information added by each of the running application protocols (e.g. eth, les, shh, bzz).', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('admin_peers', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Disconnects from a remote node if the connection exists.
 */
registerTool(
  'admin_removePeer',
  { description: 'Disconnects from a remote node if the connection exists. It returns a boolean indicating validations succeeded. Note a true value doesn\'t necessarily mean that there was a connection which was disconnected.', inputSchema: z.object({ url: z.string() }) },
  async ({ url }) => {
    const result = await queryGeth('admin_removePeer', [url]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }
);
/**
 * Tool: Removes a remote node from the trusted peer set.
 */
registerTool(
  'admin_removeTrustedPeer',
  { description: 'Removes a remote node from the trusted peer set, but it does not disconnect it automatically. It returns a boolean indicating validations succeeded.', inputSchema: z.object({ url: z.string() }) },
  async ({ url }) => {
    const result = await queryGeth('admin_removeTrustedPeer', [url]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }
);
/**
 * Tool: Starts an HTTP based JSON-RPC API webserver.
 */
registerTool(
  'admin_startHTTP',
  { description: 'The startHTTP administrative method starts an HTTP based JSON-RPC API webserver to handle client requests. All the parameters are optional: host (defaults to "localhost"), port (defaults to 8545), cors (defaults to ""), apis (defaults to "eth,net,web3"). The method returns a boolean flag specifying whether the HTTP RPC listener was opened or not.', inputSchema: z.object({ host: z.string().optional(), port: z.number().optional(), cors: z.string().optional(), apis: z.string().optional() }) },
  async ({ host = null, port = null, cors = null, apis = null }) => {
    const result = await queryGeth('admin_startHTTP', [host, port, cors, apis]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { host: { type: 'string' }, port: { type: 'number' }, cors: { type: 'string' }, apis: { type: 'string' } }, additionalProperties: false }
);
/**
 * Tool: Starts a WebSocket based JSON-RPC API webserver.
 */
registerTool(
  'admin_startWS',
  { description: 'The startWS administrative method starts an WebSocket based JSON RPC API webserver to handle client requests. All the parameters are optional: host (defaults to "localhost"), port (defaults to 8546), cors (defaults to ""), apis (defaults to "eth,net,web3"). The method returns a boolean flag specifying whether the WebSocket RPC listener was opened or not.', inputSchema: z.object({ host: z.string().optional(), port: z.number().optional(), cors: z.string().optional(), apis: z.string().optional() }) },
  async ({ host = null, port = null, cors = null, apis = null }) => {
    const result = await queryGeth('admin_startWS', [host, port, cors, apis]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { host: { type: 'string' }, port: { type: 'number' }, cors: { type: 'string' }, apis: { type: 'string' } }, additionalProperties: false }
);
/**
 * Tool: Closes the currently open HTTP RPC endpoint.
 */
registerTool(
  'admin_stopHTTP',
  { description: 'The stopHTTP administrative method closes the currently open HTTP RPC endpoint. As the node can only have a single HTTP endpoint running, this method takes no parameters, returning a boolean whether the endpoint was closed or not.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('admin_stopHTTP', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Closes the currently open WebSocket RPC endpoint.
 */
registerTool(
  'admin_stopWS',
  { description: 'The stopWS administrative method closes the currently open WebSocket RPC endpoint. As the node can only have a single WebSocket endpoint running, this method takes no parameters, returning a boolean whether the endpoint was closed or not.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('admin_stopWS', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Retrieves account range at a given block.
 */
registerTool(
  'debug_accountRange',
  { description: 'Retrieves account range at a given block.', inputSchema: z.object({ blockNrOrHash: z.any(), start: z.string(), maxResults: z.number(), nocode: z.boolean(), nostorage: z.boolean(), incompletes: z.boolean() }) },
  async ({ blockNrOrHash, start, maxResults, nocode, nostorage, incompletes }) => {
    const result = await queryGeth('debug_accountRange', [blockNrOrHash, start, maxResults, nocode, nostorage, incompletes]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockNrOrHash: { type: 'any' }, start: { type: 'string' }, maxResults: { type: 'number' }, nocode: { type: 'boolean' }, nostorage: { type: 'boolean' }, incompletes: { type: 'boolean' } }, required: ['blockNrOrHash', 'start', 'maxResults', 'nocode', 'nostorage', 'incompletes'], additionalProperties: false }
);
/**
 * Tool: Sets the logging backtrace location.
 */
registerTool(
  'debug_backtraceAt',
  { description: 'Sets the logging backtrace location. When a backtrace location is set and a log message is emitted at that location, the stack of the goroutine executing the log statement will be printed to stderr. The location is specified as <filename>:<line>.', inputSchema: z.object({ location: z.string() }) },
  async ({ location }) => {
    const result = await queryGeth('debug_backtraceAt', [location]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { location: { type: 'string' } }, required: ['location'], additionalProperties: false }
);
/**
 * Tool: Turns on block profiling for the given duration and writes profile data to disk.
 */
registerTool(
  'debug_blockProfile',
  { description: 'Turns on block profiling for the given duration and writes profile data to disk. It uses a profile rate of 1 for most accurate information. If a different rate is desired, set the rate and write the profile manually using debug_writeBlockProfile.', inputSchema: z.object({ file: z.string(), seconds: z.number() }) },
  async ({ file, seconds }) => {
    const result = await queryGeth('debug_blockProfile', [file, seconds]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' }, seconds: { type: 'number' } }, required: ['file', 'seconds'], additionalProperties: false }
);
/**
 * Tool: Flattens the entire key-value database into a single level.
 */
registerTool(
  'debug_chaindbCompact',
  { description: 'Flattens the entire key-value database into a single level, removing all unused slots and merging all keys.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_chaindbCompact', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Returns leveldb properties of the key-value database.
 */
registerTool(
  'debug_chaindbProperty',
  { description: 'Returns leveldb properties of the key-value database.', inputSchema: z.object({ property: z.string() }) },
  async ({ property }) => {
    const result = await queryGeth('debug_chaindbProperty', [property]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { property: { type: 'string' } }, required: ['property'], additionalProperties: false }
);
/**
 * Tool: Turns on CPU profiling for the given duration and writes profile data to disk.
 */
registerTool(
  'debug_cpuProfile',
  { description: 'Turns on CPU profiling for the given duration and writes profile data to disk.', inputSchema: z.object({ file: z.string(), seconds: z.number() }) },
  async ({ file, seconds }) => {
    const result = await queryGeth('debug_cpuProfile', [file, seconds]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' }, seconds: { type: 'number' } }, required: ['file', 'seconds'], additionalProperties: false }
);
/**
 * Tool: Retrieves an ancient binary blob from the freezer.
 */
registerTool(
  'debug_dbAncient',
  { description: 'Retrieves an ancient binary blob from the freezer. The freezer is a collection of append-only immutable files. The first argument kind specifies which table to look up data from.', inputSchema: z.object({ kind: z.string(), number: z.number() }) },
  async ({ kind, number }) => {
    const result = await queryGeth('debug_dbAncient', [kind, number]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { kind: { type: 'string' }, number: { type: 'number' } }, required: ['kind', 'number'], additionalProperties: false }
);
/**
 * Tool: Returns the number of ancient items in the ancient store.
 */
registerTool(
  'debug_dbAncients',
  { description: 'Returns the number of ancient items in the ancient store.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_dbAncients', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Returns the raw value of a key stored in the database.
 */
registerTool(
  'debug_dbGet',
  { description: 'Returns the raw value of a key stored in the database.', inputSchema: z.object({ key: z.string() }) },
  async ({ key }) => {
    const result = await queryGeth('debug_dbGet', [key]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }
);
/**
 * Tool: Retrieves the state that corresponds to the block number.
 */
registerTool(
  'debug_dumpBlock',
  { description: 'Retrieves the state that corresponds to the block number and returns a list of accounts (including storage and code).', inputSchema: z.object({ number: z.number() }) },
  async ({ number }) => {
    const result = await queryGeth('debug_dumpBlock', [number]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { number: { type: 'number' } }, required: ['number'], additionalProperties: false }
);
/**
 * Tool: Forces garbage collection.
 */
registerTool(
  'debug_freeOSMemory',
  { description: 'Forces garbage collection.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_freeOSMemory', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Forces a temporary client freeze.
 */
registerTool(
  'debug_freezeClient',
  { description: 'Forces a temporary client freeze, normally when the server is overloaded. Available as part of LES light server.', inputSchema: z.object({ node: z.string() }) },
  async ({ node }) => {
    const result = await queryGeth('debug_freezeClient', [node]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { node: { type: 'string' } }, required: ['node'], additionalProperties: false }
);
/**
 * Tool: Returns garbage collection statistics.
 */
registerTool(
  'debug_gcStats',
  { description: 'Returns garbage collection statistics.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_gcStats', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Returns the first number where the node has accessible state on disk.
 */
registerTool(
  'debug_getAccessibleState',
  { description: 'Returns the first number where the node has accessible state on disk. This is the post-state of that block and the pre-state of the next block. The (from, to) parameters are the sequence of blocks to search, which can go either forwards or backwards.', inputSchema: z.object({ from: z.any(), to: z.any() }) },
  async ({ from, to }) => {
    const result = await queryGeth('debug_getAccessibleState', [from, to]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { from: { type: 'any' }, to: { type: 'any' } }, required: ['from', 'to'], additionalProperties: false }
);
/**
 * Tool: Returns a list of the last bad blocks seen on the network.
 */
registerTool(
  'debug_getBadBlocks',
  { description: 'Returns a list of the last \'bad blocks\' that the client has seen on the network and returns them as a JSON list of block-hashes.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_getBadBlocks', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Retrieves and returns the RLP encoded block by number or hash.
 */
registerTool(
  'debug_getRawBlock',
  { description: 'Retrieves and returns the RLP encoded block by number.', inputSchema: z.object({ blockNrOrHash: z.any() }) },
  async ({ blockNrOrHash }) => {
    const result = await queryGeth('debug_getRawBlock', [blockNrOrHash]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockNrOrHash: { type: 'any' } }, required: ['blockNrOrHash'], additionalProperties: false }
);
/**
 * Tool: Returns an RLP-encoded header.
 */
registerTool(
  'debug_getRawHeader',
  { description: 'Returns an RLP-encoded header.', inputSchema: z.object({ blockNrOrHash: z.any() }) },
  async ({ blockNrOrHash }) => {
    const result = await queryGeth('debug_getRawHeader', [blockNrOrHash]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockNrOrHash: { type: 'any' } }, required: ['blockNrOrHash'], additionalProperties: false }
);
/**
 * Tool: Returns the bytes of the transaction.
 */
registerTool(
  'debug_getRawTransaction',
  { description: 'Returns the bytes of the transaction.', inputSchema: z.object({ hash: z.string() }) },
  async ({ hash }) => {
    const result = await queryGeth('debug_getRawTransaction', [hash]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'], additionalProperties: false }
);
/**
 * Tool: Returns all accounts that have changed between two blocks by hash.
 */
registerTool(
  'debug_getModifiedAccountsByHash',
  { description: 'Returns all accounts that have changed between the two blocks specified. A change is defined as a difference in nonce, balance, code hash, or storage hash. With one parameter, returns the list of accounts modified in the specified block.', inputSchema: z.object({ startHash: z.string(), endHash: z.string().optional() }) },
  async ({ startHash, endHash }) => {
    const params = [startHash];
    if (endHash) params.push(endHash);
    const result = await queryGeth('debug_getModifiedAccountsByHash', params);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { startHash: { type: 'string' }, endHash: { type: 'string' } }, required: ['startHash'], additionalProperties: false }
);
/**
 * Tool: Returns all accounts that have changed between two blocks by number.
 */
registerTool(
  'debug_getModifiedAccountsByNumber',
  { description: 'Returns all accounts that have changed between the two blocks specified. A change is defined as a difference in nonce, balance, code hash or storage hash.', inputSchema: z.object({ startNum: z.number(), endNum: z.number().optional() }) },
  async ({ startNum, endNum }) => {
    const params = [startNum];
    if (endNum !== undefined) params.push(endNum);
    const result = await queryGeth('debug_getModifiedAccountsByNumber', params);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { startNum: { type: 'number' }, endNum: { type: 'number' } }, required: ['startNum'], additionalProperties: false }
);
/**
 * Tool: Returns the consensus-encoding of all receipts in a single block.
 */
registerTool(
  'debug_getRawReceipts',
  { description: 'Returns the consensus-encoding of all receipts in a single block.', inputSchema: z.object({ blockNrOrHash: z.any() }) },
  async ({ blockNrOrHash }) => {
    const result = await queryGeth('debug_getRawReceipts', [blockNrOrHash]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockNrOrHash: { type: 'any' } }, required: ['blockNrOrHash'], additionalProperties: false }
);
/**
 * Tool: Turns on Go runtime tracing for the given duration and writes trace data to disk.
 */
registerTool(
  'debug_goTrace',
  { description: 'Turns on Go runtime tracing for the given duration and writes trace data to disk.', inputSchema: z.object({ file: z.string(), seconds: z.number() }) },
  async ({ file, seconds }) => {
    const result = await queryGeth('debug_goTrace', [file, seconds]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' }, seconds: { type: 'number' } }, required: ['file', 'seconds'], additionalProperties: false }
);
/**
 * Tool: Executes a block and returns a list of intermediate roots.
 */
registerTool(
  'debug_intermediateRoots',
  { description: 'Executes a block (bad- or canon- or side-), and returns a list of intermediate roots: the stateroot after each transaction.', inputSchema: z.object({ blockHash: z.string(), options: z.any().optional() }) },
  async ({ blockHash, options }) => {
    const result = await queryGeth('debug_intermediateRoots', [blockHash, options || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockHash: { type: 'string' }, options: { type: 'any' } }, required: ['blockHash'], additionalProperties: false }
);
/**
 * Tool: Returns detailed runtime memory statistics.
 */
registerTool(
  'debug_memStats',
  { description: 'Returns detailed runtime memory statistics.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_memStats', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Turns on mutex profiling for nsec seconds and writes profile data to file.
 */
registerTool(
  'debug_mutexProfile',
  { description: 'Turns on mutex profiling for nsec seconds and writes profile data to file. It uses a profile rate of 1 for most accurate information. If a different rate is desired, set the rate and write the profile manually.', inputSchema: z.object({ file: z.string(), nsec: z.number() }) },
  async ({ file, nsec }) => {
    const result = await queryGeth('debug_mutexProfile', [file, nsec]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' }, nsec: { type: 'number' } }, required: ['file', 'nsec'], additionalProperties: false }
);
/**
 * Tool: Returns the preimage for a sha3 hash, if known.
 */
registerTool(
  'debug_preimage',
  { description: 'Returns the preimage for a sha3 hash, if known.', inputSchema: z.object({ hash: z.string() }) },
  async ({ hash }) => {
    const result = await queryGeth('debug_preimage', [hash]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'], additionalProperties: false }
);
/**
 * Tool: Retrieves a block and returns its pretty printed form.
 */
registerTool(
  'debug_printBlock',
  { description: 'Retrieves a block and returns its pretty printed form.', inputSchema: z.object({ number: z.number() }) },
  async ({ number }) => {
    const result = await queryGeth('debug_printBlock', [number]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { number: { type: 'number' } }, required: ['number'], additionalProperties: false }
);
/**
 * Tool: Sets the rate of goroutine block profile data collection.
 */
registerTool(
  'debug_setBlockProfileRate',
  { description: 'Sets the rate (in samples/sec) of goroutine block profile data collection. A non-zero rate enables block profiling, setting it to zero stops the profile. Collected profile data can be written using debug_writeBlockProfile.', inputSchema: z.object({ rate: z.number() }) },
  async ({ rate }) => {
    const result = await queryGeth('debug_setBlockProfileRate', [rate]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { rate: { type: 'number' } }, required: ['rate'], additionalProperties: false }
);
/**
 * Tool: Sets the garbage collection target percentage.
 */
registerTool(
  'debug_setGCPercent',
  { description: 'Sets the garbage collection target percentage. A negative value disables garbage collection.', inputSchema: z.object({ v: z.number() }) },
  async ({ v }) => {
    const result = await queryGeth('debug_setGCPercent', [v]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { v: { type: 'number' } }, required: ['v'], additionalProperties: false }
);
/**
 * Tool: Sets the current head of the local chain by block number.
 */
registerTool(
  'debug_setHead',
  { description: 'Sets the current head of the local chain by block number. Note, this is a destructive action and may severely damage your chain. Use with extreme caution.', inputSchema: z.object({ number: z.number() }) },
  async ({ number }) => {
    const result = await queryGeth('debug_setHead', [number]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { number: { type: 'number' } }, required: ['number'], additionalProperties: false }
);
/**
 * Tool: Sets the rate of mutex profiling.
 */
registerTool(
  'debug_setMutexProfileFraction',
  { description: 'Sets the rate of mutex profiling.', inputSchema: z.object({ rate: z.number() }) },
  async ({ rate }) => {
    const result = await queryGeth('debug_setMutexProfileFraction', [rate]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { rate: { type: 'number' } }, required: ['rate'], additionalProperties: false }
);
/**
 * Tool: Configures how often in-memory state tries are persisted to disk.
 */
registerTool(
  'debug_setTrieFlushInterval',
  { description: 'Configures how often in-memory state tries are persisted to disk. The interval needs to be in a format parsable by a time.Duration.', inputSchema: z.object({ interval: z.string() }) },
  async ({ interval }) => {
    const result = await queryGeth('debug_setTrieFlushInterval', [interval]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { interval: { type: 'string' } }, required: ['interval'], additionalProperties: false }
);
/**
 * Tool: Returns a printed representation of the stacks of all goroutines.
 */
registerTool(
  'debug_stacks',
  { description: 'Returns a printed representation of the stacks of all goroutines. Note that the web3 wrapper for this method takes care of the printing and does not return the string.', inputSchema: z.object({ filter: z.string().optional() }) },
  async ({ filter = null }) => {
    const result = await queryGeth('debug_stacks', [filter]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { filter: { type: 'string' } }, additionalProperties: false }
);
/**
 * Tool: Traces a block to file using standard JSON.
 */
registerTool(
  'debug_standardTraceBlockToFile',
  { description: 'Streams output to disk during the execution, to not blow up the memory usage on the node. It uses jsonl as output format (to allow streaming). Uses a cross-client standardized output.', inputSchema: z.object({ blockHash: z.string(), config: z.any().optional() }) },
  async ({ blockHash, config }) => {
    const result = await queryGeth('debug_standardTraceBlockToFile', [blockHash, config || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockHash: { type: 'string' }, config: { type: 'any' } }, required: ['blockHash'], additionalProperties: false }
);
/**
 * Tool: Traces a bad block to file using standard JSON.
 */
registerTool(
  'debug_standardTraceBadBlockToFile',
  { description: 'This method is similar to debug_standardTraceBlockToFile, but can be used to obtain info about a block which has been rejected as invalid (for some reason).', inputSchema: z.object({ blockHash: z.string(), config: z.any().optional() }) },
  async ({ blockHash, config }) => {
    const result = await queryGeth('debug_standardTraceBadBlockToFile', [blockHash, config || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockHash: { type: 'string' }, config: { type: 'any' } }, required: ['blockHash'], additionalProperties: false }
);
/**
 * Tool: Turns on CPU profiling indefinitely, writing to the given file.
 */
registerTool(
  'debug_startCPUProfile',
  { description: 'Turns on CPU profiling indefinitely, writing to the given file.', inputSchema: z.object({ file: z.string() }) },
  async ({ file }) => {
    const result = await queryGeth('debug_startCPUProfile', [file]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }
);
/**
 * Tool: Starts writing a Go runtime trace to the given file.
 */
registerTool(
  'debug_startGoTrace',
  { description: 'Starts writing a Go runtime trace to the given file.', inputSchema: z.object({ file: z.string() }) },
  async ({ file }) => {
    const result = await queryGeth('debug_startGoTrace', [file]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }
);
/**
 * Tool: Stops an ongoing CPU profile.
 */
registerTool(
  'debug_stopCPUProfile',
  { description: 'Stops an ongoing CPU profile.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_stopCPUProfile', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Stops writing the Go runtime trace.
 */
registerTool(
  'debug_stopGoTrace',
  { description: 'Stops writing the Go runtime trace.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('debug_stopGoTrace', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Returns the storage at the given block height and transaction index.
 */
registerTool(
  'debug_storageRangeAt',
  { description: 'Returns the storage at the given block height and transaction index. The result can be paged by providing a maxResult to cap the number of storage slots returned as well as specifying the offset via keyStart (hash of storage key).', inputSchema: z.object({ blockHash: z.string(), txIdx: z.number(), contractAddress: z.string(), keyStart: z.string(), maxResult: z.number() }) },
  async ({ blockHash, txIdx, contractAddress, keyStart, maxResult }) => {
    const result = await queryGeth('debug_storageRangeAt', [blockHash, txIdx, contractAddress, keyStart, maxResult]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockHash: { type: 'string' }, txIdx: { type: 'number' }, contractAddress: { type: 'string' }, keyStart: { type: 'string' }, maxResult: { type: 'number' } }, required: ['blockHash', 'txIdx', 'contractAddress', 'keyStart', 'maxResult'], additionalProperties: false }
);
/**
 * Tool: Returns the structured logs created during the execution of EVM against a bad block.
 */
registerTool(
  'debug_traceBadBlock',
  { description: 'Returns the structured logs created during the execution of EVM against a block pulled from the pool of bad ones and returns them as a JSON object.', inputSchema: z.object({ blockHash: z.string(), options: z.any().optional() }) },
  async ({ blockHash, options }) => {
    const result = await queryGeth('debug_traceBadBlock', [blockHash, options || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockHash: { type: 'string' }, options: { type: 'any' } }, required: ['blockHash'], additionalProperties: false }
);
/**
 * Tool: Traces a block and returns full stack trace.
 */
registerTool(
  'debug_traceBlock',
  { description: 'The traceBlock method will return a full stack trace of all invoked opcodes of all transaction that were included in this block. Note, the parent of this block must be present or it will fail.', inputSchema: z.object({ blockRlp: z.string(), options: z.any().optional() }) },
  async ({ blockRlp, options }) => {
    const result = await queryGeth('debug_traceBlock', [blockRlp, options || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockRlp: { type: 'string' }, options: { type: 'any' } }, required: ['blockRlp'], additionalProperties: false }
);
/**
 * Tool: Traces a block by number.
 */
registerTool(
  'debug_traceBlockByNumber',
  { description: 'Similar to debug_traceBlock, traceBlockByNumber accepts a block number and will replay the block that is already present in the database.', inputSchema: z.object({ number: z.any(), options: z.any().optional() }) },
  async ({ number, options }) => {
    const result = await queryGeth('debug_traceBlockByNumber', [number, options || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { number: { type: 'any' }, options: { type: 'any' } }, required: ['number'], additionalProperties: false }
);
/**
 * Tool: Traces a block by hash.
 */
registerTool(
  'debug_traceBlockByHash',
  { description: 'Similar to debug_traceBlock, traceBlockByHash accepts a block hash and will replay the block that is already present in the database.', inputSchema: z.object({ hash: z.string(), options: z.any().optional() }) },
  async ({ hash, options }) => {
    const result = await queryGeth('debug_traceBlockByHash', [hash, options || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { hash: { type: 'string' }, options: { type: 'any' } }, required: ['hash'], additionalProperties: false }
);
/**
 * Tool: Traces a block from a file containing the RLP of the block.
 */
registerTool(
  'debug_traceBlockFromFile',
  { description: 'Similar to debug_traceBlock, traceBlockFromFile accepts a file containing the RLP of the block.', inputSchema: z.object({ fileName: z.string(), options: z.any().optional() }) },
  async ({ fileName, options }) => {
    const result = await queryGeth('debug_traceBlockFromFile', [fileName, options || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { fileName: { type: 'string' }, options: { type: 'any' } }, required: ['fileName'], additionalProperties: false }
);
/**
 * Tool: Runs an eth_call within the context of the given block execution.
 */
registerTool(
  'debug_traceCall',
  { description: 'The debug_traceCall method lets you run an eth_call within the context of the given block execution using the final state of parent block as the base. The first argument is a transaction object. The block can be specified either by hash or by number as the second argument. The trace can be configured similar to debug_traceTransaction.', inputSchema: z.object({ args: z.any(), blockNrOrHash: z.any(), config: z.any().optional() }) },
  async ({ args, blockNrOrHash, config }) => {
    const result = await queryGeth('debug_traceCall', [args, blockNrOrHash, config || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { args: { type: 'any' }, blockNrOrHash: { type: 'any' }, config: { type: 'any' } }, required: ['args', 'blockNrOrHash'], additionalProperties: false }
);
/**
 * Tool: Traces a transaction.
 */
registerTool(
  'debug_traceTransaction',
  { description: 'The traceTransaction debugging method will attempt to run the transaction in the exact same manner as it was executed on the network. It will replay any transaction that may have been executed prior to this one before it will finally attempt to execute the transaction that corresponds to the given hash.', inputSchema: z.object({ txHash: z.string(), options: z.any().optional() }) },
  async ({ txHash, options }) => {
    const result = await queryGeth('debug_traceTransaction', [txHash, options || {}]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { txHash: { type: 'string' }, options: { type: 'any' } }, required: ['txHash'], additionalProperties: false }
);
/**
 * Tool: Sets the logging verbosity ceiling.
 */
registerTool(
  'debug_verbosity',
  { description: 'Sets the logging verbosity ceiling. Log messages with level up to and including the given level will be printed.', inputSchema: z.object({ level: z.number() }) },
  async ({ level }) => {
    const result = await queryGeth('debug_verbosity', [level]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { level: { type: 'number' } }, required: ['level'], additionalProperties: false }
);
/**
 * Tool: Sets the logging verbosity pattern.
 */
registerTool(
  'debug_vmodule',
  { description: 'Sets the logging verbosity pattern.', inputSchema: z.object({ pattern: z.string() }) },
  async ({ pattern }) => {
    const result = await queryGeth('debug_vmodule', [pattern]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false }
);
/**
 * Tool: Writes a goroutine blocking profile to the given file.
 */
registerTool(
  'debug_writeBlockProfile',
  { description: 'Writes a goroutine blocking profile to the given file.', inputSchema: z.object({ file: z.string() }) },
  async ({ file }) => {
    const result = await queryGeth('debug_writeBlockProfile', [file]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }
);
/**
 * Tool: Writes an allocation profile to the given file.
 */
registerTool(
  'debug_writeMemProfile',
  { description: 'Writes an allocation profile to the given file. Note that the profiling rate cannot be set through the API, it must be set on the command line using the --pprof.memprofilerate flag.', inputSchema: z.object({ file: z.string() }) },
  async ({ file }) => {
    const result = await queryGeth('debug_writeMemProfile', [file]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }
);
/**
 * Tool: Writes a goroutine blocking profile to the given file.
 */
registerTool(
  'debug_writeMutexProfile',
  { description: 'Writes a goroutine blocking profile to the given file.', inputSchema: z.object({ file: z.string() }) },
  async ({ file }) => {
    const result = await queryGeth('debug_writeMutexProfile', [file]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }
);
/**
 * Tool: Simulates multiple blocks and transactions without creating them on the blockchain.
 */
registerTool(
  'eth_simulateV1',
  { description: 'The eth_simulateV1 method allows the simulation of multiple blocks and transactions without creating transactions or creating blocks on the blockchain. It functions similarly to eth_call, but offers more control.', inputSchema: z.object({ payload: z.any(), block: z.any() }) },
  async ({ payload, block }) => {
    const result = await queryGeth('eth_simulateV1', [payload, block]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { payload: { type: 'any' }, block: { type: 'any' } }, required: ['payload', 'block'], additionalProperties: false }
);
/**
 * Tool: Creates an EIP2930 type accessList based on a given transaction.
 */
registerTool(
  'eth_createAccessList',
  { description: 'This method creates an EIP2930 type accessList based on a given Transaction. The accessList contains all storage slots and addresses read and written by the transaction, except for the sender account and the precompiles.', inputSchema: z.object({ transaction: z.any(), blockNumberOrTag: z.any().optional() }) },
  async ({ transaction, blockNumberOrTag }) => {
    const params = [transaction];
    if (blockNumberOrTag) params.push(blockNumberOrTag);
    const result = await queryGeth('eth_createAccessList', params);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { transaction: { type: 'any' }, blockNumberOrTag: { type: 'any' } }, required: ['transaction'], additionalProperties: false }
);
/**
 * Tool: Returns a block header by number.
 */
registerTool(
  'eth_getHeaderByNumber',
  { description: 'Returns a block header.', inputSchema: z.object({ blockNumber: z.any() }) },
  async ({ blockNumber }) => {
    const result = await queryGeth('eth_getHeaderByNumber', [blockNumber]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockNumber: { type: 'any' } }, required: ['blockNumber'], additionalProperties: false }
);
/**
 * Tool: Returns a block header by hash.
 */
registerTool(
  'eth_getHeaderByHash',
  { description: 'Returns a block header.', inputSchema: z.object({ blockHash: z.string() }) },
  async ({ blockHash }) => {
    const result = await queryGeth('eth_getHeaderByHash', [blockHash]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { blockHash: { type: 'string' } }, required: ['blockHash'], additionalProperties: false }
);
/**
 * Tool: Retrieves the transactions contained within the txpool.
 */
registerTool(
  'txpool_content',
  { description: 'Retrieves the transactions contained within the txpool, returning pending as well as queued transactions.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('txpool_content', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Retrieves the transactions contained within the txpool for a specific address.
 */
registerTool(
  'txpool_contentFrom',
  { description: 'Retrieves the transactions contained within the txpool, returning pending as well as queued transactions of this address, grouped by nonce.', inputSchema: z.object({ address: z.string() }) },
  async ({ address }) => {
    const result = await queryGeth('txpool_contentFrom', [address]);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: { address: { type: 'string' } }, required: ['address'], additionalProperties: false }
);
/**
 * Tool: Lists a textual summary of all transactions in the txpool.
 */
registerTool(
  'txpool_inspect',
  { description: 'The inspect inspection property can be queried to list a textual summary of all the transactions currently pending for inclusion in the next block(s), as well as the ones that are being scheduled for future execution only.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('txpool_inspect', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
/**
 * Tool: Returns the number of transactions in the txpool.
 */
registerTool(
  'txpool_status',
  { description: 'The status inspection property can be queried for the number of transactions currently pending for inclusion in the next block(s), as well as the ones that are being scheduled for future execution only.', inputSchema: z.object({}) },
  async () => {
    const result = await queryGeth('txpool_status', []);
    return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
  },
  { type: 'object', properties: {}, additionalProperties: false }
);
// Middleware: apply JSON parsing only for non-MCP routes (avoid consuming body stream needed by MCP transport)
app.use((req, res, next) => {
  if (req.path.startsWith('/mcp')) return next();
  return express.json({ verify: (r, _res, buf) => { r.rawBody = buf.toString(); } })(req, res, next);
});
// Health check (supports /mcp and /mcp/ + HEAD)
function healthHandler(_req, res) {
  res.json({ status: 'ok', name: 'geth-mcp-proxy', port, tools: registeredToolNames });
}
app.get(['/mcp','/mcp/'], healthHandler);
app.head(['/mcp','/mcp/'], (req, res) => { res.status(200).end(); });
// MCP endpoint (both /mcp and /mcp/)
async function mcpHandler(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    if (!body) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty request body' }, id: null });
    let payload;
    try { payload = JSON.parse(body); } catch {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    const { id, method, params } = payload;
    // 1. initialize (pure JSON-RPC, stateless)
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'geth-mcp-proxy', version: '1.1.0' },
          capabilities: { tools: registeredToolSchemas, roots: { listChanged: false } }
        }
      });
    }
    // 2. tools/list (MCP convenience)
    if (method === 'tools/list') {
      console.log('[mcpServer] tools/list requested');
      const tools = registeredToolNames.map(name => ({ name, description: registeredToolSchemas[name]?.description, inputSchema: registeredToolSchemas[name]?.inputSchema }));
      console.log('[mcpServer] tools/list responding with', tools.length, 'tools');
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }
    // 3. tools/call (direct invoke) - bypass streaming transport for single-call HTTP use
    if (method === 'tools/call') {
      console.log('[mcpServer] tools/call requested', params?.name);
      if (!params || typeof params !== 'object') {
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing params' }, id });
      }
      const { name, arguments: args = {} } = params;
      const safeName = normalizeToolName(name);
      if (!safeName || !registeredToolHandlers[safeName]) {
        console.warn('[mcpServer] Unknown tool requested', name, '->', safeName);
        return res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${name}` }, id });
      }
      try {
        // Zod validation if available
        const zodSchema = registeredToolHandlers[safeName].schema.inputSchema;
        const parsed = zodSchema ? zodSchema.parse(args) : args;
        const toolResult = await registeredToolHandlers[safeName].handler(parsed);
        console.log('[mcpServer] tools/call success', safeName);
        return res.json({ jsonrpc: '2.0', id, result: toolResult });
      } catch (err) {
        const message = err?.message || 'Tool execution error';
        console.error('[mcpServer] tools/call error', safeName, message);
        return res.status(500).json({ jsonrpc: '2.0', id, error: { code: -32000, message } });
      }
    }
    // 4. Fallback to streaming transport (future multi-message sessions)
    const { Readable } = require('stream');
    const mockReq = new Readable({ read() { this.push(body); this.push(null); } });
    mockReq.headers = req.headers; mockReq.method = req.method; mockReq.url = req.url;
    const transport = new StreamableHTTPServerTransport(mockReq, res);
    try { await mcpServer.connect(transport); }
    catch (err) {
      console.error('[mcpServer] MCP connection error (fallback transport)', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP transport error', data: err.message }, id: id ?? null });
    } finally { req.on('close', () => transport.close()); }
  });
}
app.post(['/mcp','/mcp/'], mcpHandler);
// Simple REST fallback to fetch latest block (bypasses MCP entirely)
app.get('/blockNumber', async (_req, res) => {
  try {
    const hex = await queryGeth('eth_blockNumber', []);
    res.json({ blockNumberHex: hex, blockNumberDecimal: hexToDecimalMaybe(hex) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Graceful shutdown
function shutdown() {
  console.log('Shutting down MCP HTTP server...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Start
const server = app.listen(port, () => {
  console.log(`🚀 MCP server listening at http://localhost:${port}/mcp/`);
});
