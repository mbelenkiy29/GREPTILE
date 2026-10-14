import {test} from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ReviewMarkdown} from "../app/dashboard/markdown";

test("review Markdown renders evidence structure without executing HTML or fetching embedded images",()=>{
 const html=renderToStaticMarkup(createElement(ReviewMarkdown,null,"### Test execution\nRecorded `node --test` **passed**.\n\n- [Source](https://github.com/example/repo/blob/abc/a.ts#L3)\n\n| Revision | Result |\n| --- | --- |\n| abc | passed |\n\n```ts\nconst x = '<script>';\n```\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert%281%29)\n\n![Tracker](https://tracker.example/pixel)"));
 assert.ok(html.includes("<h3>Test execution</h3>"));assert.ok(html.includes("<code>node --test</code>"));assert.ok(html.includes("<strong>passed</strong>"));assert.ok(html.includes("<ul>"));assert.ok(html.includes("<table>"));assert.ok(html.includes("<pre><code"));
 assert.ok(html.includes('href="https://github.com/example/repo/blob/abc/a.ts#L3"'));assert.ok(html.includes('rel="noopener noreferrer"'));
 assert.ok(!html.includes("<script>"));assert.ok(!html.includes("javascript:"));assert.ok(!html.includes("<img"));assert.ok(!html.includes("tracker.example"));
});
