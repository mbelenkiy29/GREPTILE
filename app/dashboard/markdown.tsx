import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {ScrollTable} from "./scroll-table";

export function ReviewMarkdown({children}:{children:string}) {
 return <div className="review-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} components={{
  h1:({children})=><h3>{children}</h3>,
  h2:({children})=><h3>{children}</h3>,
  a:({href,children})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  table:({children})=><ScrollTable label="Review summary table"><table>{children}</table></ScrollTable>,
 }}>{children}</Markdown></div>;
}
