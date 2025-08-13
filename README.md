# Geth MCP Proxy

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green)](https://nodejs.org/) [![Express.js](https://img.shields.io/badge/Express.js-v4-blue)](https://expressjs.com/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Introduction

This project is a Node.js-based proxy server that bridges Ethereum JSON-RPC queries from a Geth (Go Ethereum) node to the Model Context Protocol (MCP) ecosystem. It exposes a wide range of Ethereum RPC methods as MCP-compatible "tools," allowing seamless integration with MCP-enabled applications, such as AI models or decentralized systems that require controlled access to blockchain data.

The proxy acts as an intermediary, handling requests to a Geth endpoint specified via environment variables. It registers tools for common Ethereum operations (e.g., querying block numbers, balances, transactions) as well as advanced admin and debug functions. Responses are formatted with both hexadecimal and decimal values where applicable for easier consumption. A generic passthrough tool (`ethCallRaw`) allows calling any unsupported RPC method.

<img width="569" height="981" alt="screenshot_vscode_3" src="https://github.com/user-attachments/assets/57a6f36e-7b15-4c2c-aa32-d064e45600fc" />


Key features include:
- Zod schema validation for tool inputs.
- Optional enabling of transaction broadcasting.
- Support for MCP streaming and direct tool calls via HTTP.
- A simple REST endpoint for quick block number queries.
- 


This setup ensures secure, rate-limited, and schema-validated access to Ethereum data, making it ideal for applications that need to interact with the blockchain without direct exposure to the Geth RPC.

## Features

- **MCP Integration**: Registers Ethereum RPC methods as MCP tools with defined schemas and handlers.
- **Ethereum RPC Coverage**: Supports core methods (e.g., `eth_blockNumber`, `eth_getBalance`), aliases, admin tools (e.g., chain export/import, peer management), and debug tools (e.g., tracing, profiling).
- **Data Formatting**: Automatically converts hex values to decimal for readability (e.g., block numbers, balances, gas prices).
- **Security Controls**: Transaction sending is disabled by default; enable via `ALLOW_SEND_RAW_TX=1`.
- **Health and Discovery Endpoints**: MCP-compatible `/mcp` routes for initialization, tool listing, and health checks.
- **Fallback Passthrough**: Use `ethCallRaw` for any JSON-RPC method not explicitly registered.
- **Environment-Driven**: Configured via `.env` file for Geth URL and port.



## Installation

1. Clone the repository:
   ```
   git clone https://github.com/John0n1/Geth-MCP-Proxy.git
   cd Geth-MCP-Proxy
   ```

2. Install dependencies:
   ```
   npm install
   ```

   Required packages:
   - `dotenv`: For environment variable management.
   - `express`: Web server framework.
   - `@modelcontextprotocol/sdk`: MCP SDK for tool registration and transport.
   - `zod`: Input validation schemas.
   - `fs`: Built-in file system utilities.

## Configuration

Create a `.env` file in the root directory with the following variables:

```
GETH_URL=http://localhost:8545  # URL to your Geth node's JSON-RPC endpoint
PORT=3000                       # Optional: Server port (default: 3000)
ALLOW_SEND_RAW_TX=0             # Optional: Set to 1 to enable transaction broadcasting (disabled by default for security)
```

- **GETH_URL**: Mandatory. Points to your Ethereum node's RPC (e.g., local Geth or Infura).
- Ensure your Geth node is running and accessible. For admin/debug methods, Geth must be started with `--rpc.allow-unprotected-txs` or equivalent flags if needed.

## Usage

1. Start the server:
   ```
   node mcpServer.js
   ```

   The server will listen on `http://localhost:3000` (or your specified port) and log:
   ```
   🚀 MCP server listening at http://localhost:3000/mcp/
   ```

2. **MCP Endpoints**:
   - **Health Check**: `GET /mcp` or `GET /mcp/` – Returns server status and registered tools.
   - **Initialize**: `POST /mcp` with JSON-RPC payload `{ "method": "initialize" }`.
   - **List Tools**: `POST /mcp` with `{ "method": "tools/list" }` – Returns a list of available tools with descriptions and schemas.
   - **Call Tool**: `POST /mcp` with `{ "method": "tools/call", "params": { "name": "toolName", "arguments": {} } }`.
   - Supports streaming for multi-message sessions via MCP transport.
   - 
<img width="571" height="1287" alt="screenshot_vscode_4" src="https://github.com/user-attachments/assets/0ba7b12b-df3a-421a-b8f9-269491c1427a" />

3. **Simple REST Endpoint**:
   - `GET /blockNumber`: Returns the current block number in hex and decimal.

4. **Shutdown**: Gracefully handles SIGINT/SIGTERM for clean shutdown.

5. **Remember** to add the `mcp.json` params to your .vscode/ settings.json or mcp.json

## Available Tools

The proxy registers the following MCP tools, grouped by category. Each tool includes a description, input schema (Zod-based), and handler that queries Geth.

### Core Ethereum Tools
| Tool Name | Description | Input Schema |
|-----------|-------------|--------------|
| `getBlockNumber` / `eth_getBlockNumber` | Retrieve the current block number (hex + decimal). | `{}` |
| `getBalance` / `eth_getBalance` | Get balance of an address (hex + decimal). | `{ address: string, block?: string }` |
| `eth_chainId` / `chainId` | Get current chain ID (hex + decimal). | `{}` |
| `eth_gasPrice` / `gasPrice` | Get current gas price (hex + wei decimal). | `{}` |
| `eth_isSyncing` / `isSyncing` | Check if the node is syncing. | `{}` |
| `eth_getBlockByNumber` / `getBlockByNumber` | Fetch block by number/tag. | `{ block: string, full?: boolean }` |
| `eth_getTransactionByHash` / `getTransactionByHash` | Fetch a transaction by hash. | `{ hash: string }` |
| `eth_call` / `call` | Execute a call without a transaction. | `{ to: string, data: string, block?: string }` |
| `eth_estimateGas` / `estimateGas` | Estimate gas for a transaction. | `{ to?: string, from?: string, data?: string, value?: string }` |
| `eth_sendRawTransaction` / `sendRawTransaction` | Broadcast a signed raw transaction (requires `ALLOW_SEND_RAW_TX=1`). | `{ rawTx: string }` |
| `ethCallRaw` | Call any Ethereum JSON-RPC method with params array. | `{ method: string, params?: any[] }` |
| `eth_simulateV1` | Simulate multiple blocks and transactions. | `{ payload: any, block: any }` |
| `eth_createAccessList` | Create an EIP2930 access list based on a transaction. | `{ transaction: any, blockNumberOrTag?: any }` |
| `eth_getHeaderByNumber` | Returns a block header by number. | `{ blockNumber: any }` |
| `eth_getHeaderByHash` | Returns a block header by hash. | `{ blockHash: string }` |

### Admin Tools
| Tool Name | Description | Input Schema |
|-----------|-------------|--------------|
| `admin_exportChain` | Exports the blockchain to a file (optional range). | `{ file: string, first?: number, last?: number }` |
| `admin_importChain` | Imports blocks from a file. | `{ file: string }` |
| `admin_nodeInfo` | Retrieves node information. | `{}` |
| `admin_peers` | Retrieves connected peers information. | `{}` |
| `admin_removePeer` | Disconnects from a remote node. | `{ url: string }` |
| `admin_removeTrustedPeer` | Removes a remote node from trusted peers. | `{ url: string }` |
| `admin_startHTTP` | Starts an HTTP JSON-RPC server. | `{ host?: string, port?: number, cors?: string, apis?: string }` |
| `admin_startWS` | Starts a WebSocket JSON-RPC server. | `{ host?: string, port?: number, cors?: string, apis?: string }` |
| `admin_stopHTTP` | Stops the HTTP RPC endpoint. | `{}` |
| `admin_stopWS` | Stops the WebSocket RPC endpoint. | `{}` |

### Debug Tools
| Tool Name | Description | Input Schema |
|-----------|-------------|--------------|
| `debug_accountRange` | Retrieves account range at a given block. | `{ blockNrOrHash: any, start: string, maxResults: number, nocode: boolean, nostorage: boolean, incompletes: boolean }` |
| `debug_backtraceAt` | Sets logging backtrace location. | `{ location: string }` |
| `debug_blockProfile` | Turns on block profiling. | `{ file: string, seconds: number }` |
| `debug_chaindbCompact` | Flattens the key-value database. | `{}` |
| `debug_chaindbProperty` | Returns leveldb properties. | `{ property: string }` |
| `debug_cpuProfile` | Turns on CPU profiling. | `{ file: string, seconds: number }` |
| `debug_dbAncient` | Retrieves ancient binary blob. | `{ kind: string, number: number }` |
| `debug_dbAncients` | Returns number of ancient items. | `{}` |
| `debug_dbGet` | Returns raw value of a key. | `{ key: string }` |
| `debug_dumpBlock` | Retrieves state for a block. | `{ number: number }` |
| `debug_freeOSMemory` | Forces garbage collection. | `{}` |
| `debug_freezeClient` | Forces a temporary client freeze. | `{ node: string }` |
| `debug_gcStats` | Returns GC statistics. | `{}` |
| `debug_getAccessibleState` | Returns first accessible state. | `{ from: any, to: any }` |
| `debug_getBadBlocks` | Returns last bad blocks. | `{}` |
| `debug_getRawBlock` | Retrieves RLP-encoded block. | `{ blockNrOrHash: any }` |
| `debug_getRawHeader` | Returns RLP-encoded header. | `{ blockNrOrHash: any }` |
| `debug_getRawTransaction` | Returns transaction bytes. | `{ hash: string }` |
| `debug_getModifiedAccountsByHash` | Returns modified accounts by hash. | `{ startHash: string, endHash?: string }` |
| `debug_getModifiedAccountsByNumber` | Returns modified accounts by number. | `{ startNum: number, endNum?: number }` |
| `debug_getRawReceipts` | Returns consensus-encoded receipts. | `{ blockNrOrHash: any }` |
| `debug_goTrace` | Turns on Go runtime tracing. | `{ file: string, seconds: number }` |
| `debug_intermediateRoots` | Executes block and returns intermediate roots. | `{ blockHash: string, options?: any }` |
| `debug_memStats` | Returns memory statistics. | `{}` |
| `debug_mutexProfile` | Turns on mutex profiling. | `{ file: string, nsec: number }` |
| `debug_preimage` | Returns preimage for sha3 hash. | `{ hash: string }` |
| `debug_printBlock` | Prints a block. | `{ number: number }` |
| `debug_setBlockProfileRate` | Sets block profile rate. | `{ rate: number }` |
| `debug_setGCPercent` | Sets GC target percentage. | `{ v: number }` |
| `debug_setHead` | Sets chain head by number. | `{ number: number }` |
| `debug_setMutexProfileFraction` | Sets mutex profile rate. | `{ rate: number }` |
| `debug_setTrieFlushInterval` | Sets trie flush interval. | `{ interval: string }` |
| `debug_stacks` | Returns goroutine stacks. | `{ filter?: string }` |
| `debug_standardTraceBlockToFile` | Traces block to file (standard JSON). | `{ blockHash: string, config?: any }` |
| `debug_standardTraceBadBlockToFile` | Traces bad block to file. | `{ blockHash: string, config?: any }` |
| `debug_startCPUProfile` | Starts CPU profiling. | `{ file: string }` |
| `debug_startGoTrace` | Starts Go trace. | `{ file: string }` |
| `debug_stopCPUProfile` | Stops CPU profiling. | `{}` |
| `debug_stopGoTrace` | Stops Go trace. | `{}` |
| `debug_storageRangeAt` | Returns storage at block height and tx index. | `{ blockHash: string, txIdx: number, contractAddress: string, keyStart: string, maxResult: number }` |
| `debug_traceBadBlock` | Traces bad block execution. | `{ blockHash: string, options?: any }` |
| `debug_traceBlock` | Traces block by RLP. | `{ blockRlp: string, options?: any }` |
| `debug_traceBlockByNumber` | Traces block by number. | `{ number: any, options?: any }` |
| `debug_traceBlockByHash` | Traces block by hash. | `{ hash: string, options?: any }` |
| `debug_traceBlockFromFile` | Traces block from file. | `{ fileName: string, options?: any }` |
| `debug_traceCall` | Traces an eth_call. | `{ args: any, blockNrOrHash: any, config?: any }` |
| `debug_traceTransaction` | Traces a transaction. | `{ txHash: string, options?: any }` |
| `debug_verbosity` | Sets logging verbosity. | `{ level: number }` |
| `debug_vmodule` | Sets logging verbosity pattern. | `{ pattern: string }` |
| `debug_writeBlockProfile` | Writes block profile. | `{ file: string }` |
| `debug_writeMemProfile` | Writes allocation profile. | `{ file: string }` |
| `debug_writeMutexProfile` | Writes mutex profile. | `{ file: string }` |

### Txpool Tools
| Tool Name | Description | Input Schema |
|-----------|-------------|--------------|
| `txpool_content` | Retrieves all transactions in txpool. | `{}` |
| `txpool_contentFrom` | Retrieves transactions for an address. | `{ address: string }` |
| `txpool_inspect` | Lists textual summary of txpool. | `{}` |
| `txpool_status` | Returns txpool transaction counts. | `{}` |

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for bug fixes, new tools, or improvements.

## License
*MIT*

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
