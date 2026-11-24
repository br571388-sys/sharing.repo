// Root entry point for Cloudflare Workers. The bot code lives in src/; this file only re-exports it.
export { default, handleRequest, runScheduled } from './src/index.js';
