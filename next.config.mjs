import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  agentRules: false,
  // Loaded by Node directly on the server (headless scheduling engine); never bundled there.
  serverExternalPackages: ['@bryntum/schedulerpro', 'happy-dom', '@happy-dom/global-registrator'],
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
};
export default nextConfig;
