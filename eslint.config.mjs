import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FlatCompat } = require('@eslint/eslintrc');
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });
const config = [...compat.extends('next/core-web-vitals', 'next/typescript'), { ignores: ['.next/**', 'node_modules/**', 'convex/_generated/**', 'next-env.d.ts', 'output/**', 'forge/bitbucket/static/build/**'] }];

export default config;
