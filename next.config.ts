import type { NextConfig } from 'next';
const config: NextConfig = { output: 'standalone', outputFileTracingRoot: process.cwd(), poweredByHeader: false };
export default config;
